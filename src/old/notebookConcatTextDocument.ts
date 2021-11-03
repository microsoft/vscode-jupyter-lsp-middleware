// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
'use strict';

import * as vscode from 'vscode';
import * as path from 'path';
import * as uuid from 'uuid/v4';
import { PrefixSumComputer } from './common/prefixSumComputer';

const NotebookConcatPrefix = '_NotebookConcat_';

export class NotebookConcatTextDocument
    implements vscode.TextDocument, vscode.NotebookConcatTextDocument, vscode.Disposable
{
    private _version = 1;

    public get uri(): vscode.Uri {
        return this.dummyUri;
    }

    public get fileName(): string {
        return this.dummyFilePath;
    }

    public get isUntitled(): boolean {
        return this._notebook.isUntitled;
    }

    public get version(): number {
        return this._version;
    }

    public get isDirty(): boolean {
        return this._notebook.isDirty;
    }

    // eslint-disable-next-line class-methods-use-this
    public get eol(): vscode.EndOfLine {
        return vscode.EndOfLine.LF;
    }

    private dummyFilePath: string;

    private dummyUri: vscode.Uri;

    private _id = uuid();

    private _isClosed = false;

    private _cells!: vscode.NotebookCell[];
    private _cellUris!: Map<string, number>;
    private _cellLengths!: PrefixSumComputer;
    private _cellLines!: PrefixSumComputer;

    constructor(
        private readonly _notebook: vscode.NotebookDocument,
        private readonly _selector: vscode.DocumentSelector | undefined
    ) {
        const dir = path.dirname(_notebook.uri.fsPath);
        // Note: Has to be different than the prefix for old notebook editor (HiddenFileFormat) so
        // that the caller doesn't remove diagnostics for this document.
        this.dummyFilePath = path.join(dir, `${NotebookConcatPrefix}${uuid().replace(/-/g, '')}.py`);
        this.dummyUri = Uri.file(this.dummyFilePath);

        this._init();

        const documentChange = (document: vscode.NotebookDocument) => {
            if (document === this._notebook) {
                this._init();
                this._versionId += 1;
                this._onDidChange.fire(undefined);
            }
        };

        this._disposables.add(extHostNotebooks.onDidChangeNotebookCells((e) => documentChange(e.document)));
    }

    private _init() {
        this._cells = [];
        this._cellUris = new Map<string, number>();
        const cellLengths: number[] = [];
        const cellLineCounts: number[] = [];
        for (const cell of this._notebook.getCells()) {
            if (
                cell.kind === vscode.NotebookCellKind.Code &&
                (!this._selector || vscode.languages.match(this._selector, cell.document))
            ) {
                this._cellUris.set(cell.document.uri.toString(), this._cells.length);
                this._cells.push(cell);
                cellLengths.push(cell.document.getText().length + 1);
                cellLineCounts.push(cell.document.lineCount);
            }
        }
        this._cellLengths = new PrefixSumComputer(new Uint32Array(cellLengths));
        this._cellLines = new PrefixSumComputer(new Uint32Array(cellLineCounts));
    }

    public handleDidChange(e: vscode.TextDocumentChangeEvent) {
        const cellIdx = this._cellUris.get(e.document.uri.toString());
        if (cellIdx !== undefined) {
            this._cellLengths.changeValue(cellIdx, this._cells[cellIdx].document.getText().length + 1);
            this._cellLines.changeValue(cellIdx, this._cells[cellIdx].document.lineCount);
            this._version += 1;

            // Translate the change event into a concat event

            this.onCellsChangedEmitter.fire({
                document: this,
                contentChanges: changes,
                reason: undefined
            });
        }
    }

    public getText(range?: vscode.Range): string {
        if (!range) {
            let result = '';
            for (const cell of this._cells) {
                result += cell.document.getText() + '\n';
            }
            return result;
        }

        if (range.isEmpty) {
            return '';
        }

        // get start and end locations and create substrings
        const start = this.locationAt(range.start);
        const end = this.locationAt(range.end);

        const startIdx = this._cellUris.get(start.uri);
        const endIdx = this._cellUris.get(end.uri);

        if (startIdx === undefined || endIdx === undefined) {
            return '';
        }

        if (startIdx === endIdx) {
            return this._cells[startIdx].document.getText(new vscode.Range(start.range.start, end.range.end));
        }

        const parts = [
            this._cells[startIdx].document.getText(
                new vscode.Range(start.range.start, new vscode.Position(this._cells[startIdx].document.lineCount, 0))
            )
        ];
        for (let i = startIdx + 1; i < endIdx; i++) {
            parts.push(this._cells[i].document.getText());
        }
        parts.push(this._cells[endIdx].document.getText(new vscode.Range(new vscode.Position(0, 0), end.range.end)));
        return parts.join('\n');
    }

    public offsetAt(position: vscode.Position): number {
        const idx = this._cellLines.getIndexOf(position.line);
        const offset1 = this._cellLengths.getPrefixSum(idx.index - 1);
        const offset2 = this._cells[idx.index].document.offsetAt(position.with(idx.remainder));
        return offset1 + offset2;
    }

    public positionAt(locationOrOffset: vscode.Location | number): vscode.Position {
        if (typeof locationOrOffset === 'number') {
            const idx = this._cellLengths.getIndexOf(locationOrOffset);
            const lineCount = this._cellLines.getPrefixSum(idx.index - 1);
            return this._cells[idx.index].document.positionAt(idx.remainder).translate(lineCount);
        }

        const idx = this._cellUris.get(locationOrOffset.uri);
        if (idx !== undefined) {
            const line = this._cellLines.getPrefixSum(idx - 1);
            return new types.Position(line + locationOrOffset.range.start.line, locationOrOffset.range.start.character);
        }
        // do better?
        // return undefined;
        return new types.Position(0, 0);
    }

    public locationAt(positionOrRange: vscode.Range | vscode.Position): types.Location {
        if (!types.Range.isRange(positionOrRange)) {
            positionOrRange = new types.Range(<types.Position>positionOrRange, <types.Position>positionOrRange);
        }

        const startIdx = this._cellLines.getIndexOf(positionOrRange.start.line);
        let endIdx = startIdx;
        if (!positionOrRange.isEmpty) {
            endIdx = this._cellLines.getIndexOf(positionOrRange.end.line);
        }

        const startPos = new types.Position(startIdx.remainder, positionOrRange.start.character);
        const endPos = new types.Position(endIdx.remainder, positionOrRange.end.character);
        const range = new types.Range(startPos, endPos);

        const startCell = this._cells[startIdx.index];
        return new types.Location(startCell.document.uri, <types.Range>startCell.document.validateRange(range));
    }

    contains(uri: vscode.Uri): boolean {
        return this._cellUris.has(uri);
    }

    public validateRange(range: vscode.Range): vscode.Range {
        const start = this.validatePosition(range.start);
        const end = this.validatePosition(range.end);
        return range.with(start, end);
    }

    public validatePosition(position: vscode.Position): vscode.Position {
        const startIdx = this._cellLines.getIndexOf(position.line);

        const cellPosition = new types.Position(startIdx.remainder, position.character);
        const validCellPosition = this._cells[startIdx.index].document.validatePosition(cellPosition);

        const line = this._cellLines.getPrefixSum(startIdx.index - 1);
        return new types.Position(line + validCellPosition.line, validCellPosition.character);
    }

    public get notebook(): vscode.NotebookDocument {
        return this._notebook;
    }

    public dispose(): void {
        this.onDidChangeSubscription.dispose();
        this.onCellsChangedEmitter.dispose();
    }

    public get id() {
        return this._id;
    }

    public isCellOfDocument(uri: vscode.Uri): boolean {
        return this.contains(uri);
    }

    // eslint-disable-next-line class-methods-use-this
    public save(): Thenable<boolean> {
        // Not used
        throw new Error('Not implemented');
    }

    public getTextDocumentAtPosition(position: vscode.Position): vscode.TextDocument | undefined {
        const location = this.locationAt(position);
        return this.getComposeDocuments().find((c) => c.uri === location.uri);
    }

    private get filteredCells(): vscode.NotebookCell[] {
        return this._notebook && this._selector
            ? this._notebook.getCells().filter((c) => vscode.languages.match(this._selector!, c.document) > 0)
            : [];
    }

    private get filteredCellCount(): number {
        return this.filteredCells.length;
    }

    private filteredCellAt(index: number): vscode.NotebookCell {
        return this.filteredCells[index];
    }

    private updateCellTracking() {
        this.cellTracking = [];
        this.concatDocument.getComposeDocuments().forEach((document) => {
            // Compute end position from number of lines in a cell
            const cellText = document.getText();
            const lines = splitLines(cellText, { trim: false });

            this.cellTracking.push({
                uri: document.uri,
                length: cellText.length + 1, // \n is included concat length
                lineCount: lines.length
            });
        });
    }

    private onDidChange() {
        this._version += 1;
        const newUris = this.concatDocument.getComposeDocuments().map((document) => document.uri.toString());
        const oldUris = this.cellTracking.map((c) => c.uri.toString());

        // See if number of cells or cell positions changed
        if (this.cellTracking.length < this.filteredCellCount) {
            this.raiseCellInsertions(oldUris);
        } else if (this.cellTracking.length > this.filteredCellCount) {
            this.raiseCellDeletions(newUris, oldUris);
        } else if (!isEqual(oldUris, newUris)) {
            this.raiseCellMovement();
        }
        this.updateCellTracking();
    }

    private getPositionOfCell(cellUri: Uri): Position {
        return this.concatDocument.positionAt(new Location(cellUri, new Position(0, 0)));
    }

    public getEndPosition(): Position {
        if (this.filteredCellCount > 0) {
            const finalCell = this.filteredCellAt(this.filteredCellCount - 1);
            const start = this.getPositionOfCell(finalCell.document.uri);
            const lines = splitLines(finalCell.document.getText(), { trim: false });
            return new Position(start.line + lines.length, 0);
        }
        return new Position(0, 0);
    }

    private raiseCellInsertions(oldUris: string[]) {
        // One or more cells were added. Add a change event for each
        const insertions = this.concatDocument
            .getComposeDocuments()
            .filter((document) => !oldUris.includes(document.uri.toString()));

        const changes = insertions.map((insertion) => {
            // Figure out the position of the item. This is where we're inserting the cell
            // Note: The first insertion will line up with the old cell at this position
            // The second or other insertions will line up with their new positions.
            const position = this.getPositionOfCell(insertion.uri);

            // Text should be the contents of the new cell plus the '\n'
            const text = `${insertion.getText()}\n`;

            return {
                text,
                range: new Range(position, position),
                rangeLength: 0,
                rangeOffset: 0
            };
        });

        // Send all of the changes
        this.onCellsChangedEmitter.fire({
            document: this,
            contentChanges: changes,
            reason: undefined
        });
    }

    private raiseCellDeletions(newUris: string[], oldUris: string[]) {
        // cells were deleted. Figure out which ones
        const oldIndexes: number[] = [];
        oldUris.forEach((o, i) => {
            if (!newUris.includes(o)) {
                oldIndexes.push(i);
            }
        });
        const changes = oldIndexes.map((index) => {
            // Figure out the position of the item in the new list
            const position =
                index < newUris.length && this.filteredCellAt(index)
                    ? this.getPositionOfCell(this.filteredCellAt(index).document.uri)
                    : this.getEndPosition();

            // Length should be old length
            const { length } = this.cellTracking[index];

            // Range should go from new position to end of old position
            const endPosition = new Position(position.line + this.cellTracking[index].lineCount, 0);

            // Turn this cell into a change event.
            return {
                text: '',
                range: new Range(position, endPosition),
                rangeLength: length,
                rangeOffset: 0
            };
        });

        // Send the event
        this.onCellsChangedEmitter.fire({
            document: this,
            contentChanges: changes,
            reason: undefined
        });
    }

    private raiseCellMovement() {
        // When moving, just replace everything. Simpler this way. Might this
        // cause unknown side effects? Don't think so.
        this.onCellsChangedEmitter.fire({
            document: this,
            contentChanges: [
                {
                    text: this.concatDocument.getText(),
                    range: new Range(
                        new Position(0, 0),
                        new Position(
                            this.cellTracking.reduce((p, c) => p + c.lineCount, 0),
                            0
                        )
                    ),
                    rangeLength: this.cellTracking.reduce((p, c) => p + c.length, 0),
                    rangeOffset: 0
                }
            ],
            reason: undefined
        });
    }
}
