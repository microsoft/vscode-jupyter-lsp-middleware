// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

'use strict';
import * as vscode from 'vscode';
import * as protocol from 'vscode-languageclient/node';
import * as path from 'path';
import * as shajs from 'sha.js';
import {
    InteractiveInputScheme,
    InteractiveScheme,
    isInteractiveCell,
    PYTHON_LANGUAGE,
    splitLines
} from './common/utils';
import {
    DefaultWordPattern,
    ensureValidWordDefinition,
    getWordAtText,
    regExpLeadsToEndlessLoop
} from './common/wordHelper';
import { NotebookConcatLine } from './notebookConcatLine';
import { RefreshNotebookEvent } from './common/types';

interface INotebookCellRange {
    uri: vscode.Uri;
    startOffset: number;
    endOffset: number;
    fragment: number;
    text: string;
    concatCell: IConcatCellRange;
}

interface IConcatCellRange {
    uri: vscode.Uri;
    startOffset: number;
    endOffset: number;
    text: string;
    startLine: number;
    notebookCell?: INotebookCellRange;
}

const NotebookConcatPrefix = '_NotebookConcat_';

const LineTransforms = [
    { regex: /(^\s*%.*\n)/g, replace: '(\\1) # type: ignore\n ' },
    { regex: /(^\s*!.*\n)/g, replace: '(\\1) # type: ignore\n ' },
    { regex: /(^\s*await\s+.*\n)/g, replace: '(\\1) # type: ignore\n ' }
];

export class NotebookConcatDocument implements vscode.TextDocument, vscode.Disposable {
    public get uri(): vscode.Uri {
        return this.concatUri;
    }
    public get fileName(): string {
        return this.uri.fsPath;
    }
    public get isUntitled(): boolean {
        return true;
    }
    public get languageId(): string {
        return PYTHON_LANGUAGE;
    }
    public get version(): number {
        return this._version;
    }
    public get isDirty(): boolean {
        return true;
    }
    public get isClosed(): boolean {
        return this._closed;
    }
    public get eol(): vscode.EndOfLine {
        return vscode.EndOfLine.LF;
    }
    public get lineCount(): number {
        return this._concatLines.length;
    }
    public get notebook(): vscode.NotebookDocument | undefined {
        // This represents a python file, so notebook should be undefined
        return undefined;
    }
    public get concatUri(): vscode.Uri {
        return this._concatUri || vscode.Uri.parse('');
    }
    public get notebookUri(): vscode.Uri {
        return this._notebookUri || vscode.Uri.parse('');
    }

    private _interactiveWindow = false;
    private _concatUri: vscode.Uri | undefined;
    private _notebookUri: vscode.Uri | undefined;
    private _version = 1;
    private _closed = true;
    private _concatContents: string = '';
    private _concatLines: NotebookConcatLine[] = [];
    private _notebookCells: INotebookCellRange[] = [];
    private _concatCells: IConcatCellRange[] = [];

    public handleChange(e: protocol.TextDocumentEdit): protocol.DidChangeTextDocumentParams | undefined {
        this._version++;
        const changes: protocol.TextDocumentContentChangeEvent[] = [];
        const notebookIndex = this._notebookCells.findIndex((c) => c.uri.toString() === e.textDocument.uri);
        const notebookCell = notebookIndex >= 0 ? this._notebookCells[notebookIndex] : undefined;
        if (notebookCell) {
            e.edits.forEach((edit) => {
                // Apply the edit to the notebook cell first (not the concat document)
                const normalized = edit.newText.replace(/\r/g, '');
                const lineLengths = notebookCell.text.split('\n').map((l) => l.length);
                const startOffset =
                    lineLengths.slice(0, edit.range.start.line).reduce((p, c) => p + c) + edit.range.start.character;
                const endOffset =
                    lineLengths.slice(0, edit.range.end.line).reduce((p, c) => p + c) + edit.range.end.character;
                const newCellText = `${notebookCell.text.substring(
                    0,
                    startOffset
                )}${normalized}${notebookCell.text.substring(endOffset)}`;
                notebookCell.text = newCellText;
                const diff = notebookCell.startOffset + newCellText.length - notebookCell.endOffset;
                notebookCell.endOffset += diff;

                // Move everything else down by the difference.
                for (let i = notebookIndex + 1; i < this._notebookCells.length; i++) {
                    this._notebookCells[notebookIndex].startOffset += diff;
                    this._notebookCells[notebookIndex].endOffset += diff;
                }

                // Now apply this same change to the concat cell that the notebook cell is pointing to
                const concatCell = notebookCell.concatCell;
                const concatCellText = this.applyLineTransforms(newCellText);

                // Concat cell should have the same number of lines as the original cell (we only replace or add to lines)
                // So the only thing that should be different is the end character on the change
                const oldConcatLines = concatCell.text.split('\n');
                const newConcatLines = concatCellText.split('\n');
            });
            return this.toDidChangeTextDocumentParams(changes);
        }
    }

    public handleOpen(
        e: protocol.TextDocumentItem,
        forceAppend?: boolean
    ): protocol.DidChangeTextDocumentParams | undefined {
        const cellUri = vscode.Uri.parse(e.uri);

        // Make sure we don't already have this cell open
        if (this._notebookCells.find((c) => c.uri.toString() == e.uri)) {
            // Can't open twice
            return undefined;
        }

        this._version = Math.max(e.version, this._version + 1);
        this._closed = false;

        // Setup uri and such if first open
        this.initialize(cellUri);

        // Compute 'fragment' portion of URI. It's the tentative cell index
        const fragment =
            cellUri.scheme === InteractiveInputScheme || forceAppend
                ? -1
                : parseInt(cellUri.fragment.substring(2) || '0');

        // That fragment determines order in the list.
        const insertIndex = this.computeInsertionIndex(fragment);

        // Compute where we start from.
        const fromOffset =
            insertIndex < this._notebookCells.length && insertIndex >= 0
                ? this._notebookCells[insertIndex].startOffset
                : this._notebookCells[this._notebookCells.length - 1].endOffset;

        const concatFromOffset =
            insertIndex < this._notebookCells.length && insertIndex >= 0
                ? this._notebookCells[insertIndex].concatCell.startOffset
                : this._notebookCells[this._notebookCells.length - 1].concatCell.endOffset;

        const concatFromLine =
            insertIndex < this._notebookCells.length && insertIndex >= 0
                ? this._notebookCells[insertIndex].concatCell.startLine
                : this._concatLines.length;

        const concatInsertIndex =
            insertIndex < this._notebookCells.length && insertIndex >= 0
                ? this._concatCells.indexOf(this._notebookCells[insertIndex].concatCell)
                : this._concatCells.length;

        // Real text should have no \r in it and ends with a \n
        const notebookCellText = `${e.text.replace(/\r/g, '')}\n`;

        // Concat text may be transformed
        const concatCellText = this.applyLineTransforms(notebookCellText);
        const concatLineCount = concatCellText.split('\n').length;

        // Create the new concat cell.
        const concatCell: IConcatCellRange = {
            startOffset: concatFromOffset,
            endOffset: concatFromOffset + concatCellText.length,
            uri: cellUri,
            startLine: concatFromLine,
            text: concatCellText
        };

        // Create the new cell
        const notebookCell: INotebookCellRange = {
            fragment,
            startOffset: fromOffset,
            endOffset: fromOffset + notebookCellText.length,
            uri: cellUri,
            text: notebookCellText,
            concatCell: concatCell
        };

        // Update concat to point to notebook
        concatCell.notebookCell = notebookCell;

        // Move all the other cell ranges down
        for (let i = insertIndex; i <= this._notebookCells.length - 1; i += 1) {
            this._notebookCells[i].startOffset += notebookCell.text.length;
        }
        for (let i = concatInsertIndex; i <= this._concatCells.length - 1; i += 1) {
            this._concatCells[i].startOffset += concatCell.text.length;
            this._concatCells[i].startLine += concatLineCount;
        }

        // Stick the cell into the two ranges
        this._notebookCells.splice(insertIndex, 0, notebookCell);
        this._concatCells.splice(concatInsertIndex, 0, concatCell);

        // Update our total contents
        this._concatContents = this._concatCells.map((c) => c.text).join('');

        // Update our set of lines
        this._concatLines = this.createLines(this._concatContents);

        // Get our from position from the offset in the concat document
        const fromPosition = this.positionAt(concatFromOffset);

        // Changes should reflect changes in the concat doc
        const changes: protocol.TextDocumentContentChangeEvent[] = [
            {
                range: this.createSerializableRange(fromPosition, fromPosition),
                rangeOffset: concatFromOffset,
                rangeLength: 0, // Opens are always zero
                text: concatCellText
            } as any
        ];
        return this.toDidChangeTextDocumentParams(changes);
    }

    public handleClose(e: protocol.TextDocumentIdentifier): protocol.DidChangeTextDocumentParams | undefined {
        const index = this._notebookCells.findIndex((c) => c.uri.toString() === e.uri);

        // Setup uri and such if a reopen.
        this.initialize(vscode.Uri.parse(e.uri));

        // Ignore unless in notebook mode. For interactive, cells are still there.
        if (index >= 0 && !this._interactiveWindow) {
            this._version += 1;

            const notebookCell = this._notebookCells[index];
            const concatCell = notebookCell.concatCell;
            const concatIndex = this._concatCells.indexOf(concatCell);
            const notebookLength = notebookCell.endOffset - notebookCell.startOffset;
            const concatLength = concatCell.endOffset - concatCell.startOffset;
            const from = new vscode.Position(this.getLineFromOffset(concatCell.startOffset), 0);
            const to = this.positionAt(concatCell.endOffset);

            // Remove from the cell ranges.
            for (let i = index + 1; i <= this._notebookCells.length - 1; i += 1) {
                this._notebookCells[i].startOffset -= notebookLength;
                this._notebookCells[i].endOffset -= notebookLength;
            }
            for (let i = concatIndex + 1; i <= this._concatCells.length - 1; i += 1) {
                this._concatCells[i].startOffset -= concatLength;
                this._concatCells[i].endOffset -= concatLength;
            }
            this._notebookCells.splice(index, 1);
            this._concatCells.splice(concatIndex, 1);

            // Recreate the lines
            this._concatContents = this._concatCells.map((c) => c.text).join('');
            this._concatLines = this.createLines(this._concatContents);

            const changes: protocol.TextDocumentContentChangeEvent[] = [
                {
                    range: this.createSerializableRange(from, to),
                    rangeOffset: concatCell.startOffset,
                    rangeLength: concatLength,
                    text: ''
                } as any
            ];

            // If we closed the last cell, mark as closed
            if (this._notebookCells.length == 0) {
                this._closed = true;
            }
            return this.toDidChangeTextDocumentParams(changes);
        }
    }

    public handleRefresh(e: RefreshNotebookEvent): protocol.DidChangeTextDocumentParams | undefined {
        // Delete all cells and start over. This should only happen for non interactive (you can't move interactive cells at the moment)
        if (!this._interactiveWindow) {
            // Track our old full range
            const from = new vscode.Position(0, 0);
            const to = this.positionAt(this._concatContents.length);
            const oldLength = this._concatContents.length;
            const oldContents = this._concatContents;
            const normalizedCellText = e.cells.map((c) => c.textDocument.text.replace(/\r/g, ''));
            const newContents = `${normalizedCellText.join('\n')}\n`;
            if (newContents != oldContents) {
                // Refresh everything
                this._concatCells = [];
                this._notebookCells = [];
                this._concatContents = '';

                // Just act like we opened each one anew, but forcing each
                // cell to be appended
                e.cells.forEach((c) => {
                    this.handleOpen(c.textDocument, true);
                });

                // Create one big change
                const changes: protocol.TextDocumentContentChangeEvent[] = [
                    {
                        range: this.createSerializableRange(from, to),
                        rangeOffset: 0,
                        rangeLength: oldLength,
                        text: this._concatContents
                    } as any
                ];

                return this.toDidChangeTextDocumentParams(changes);
            }
        }
        return undefined;
    }

    public dispose() {
        // Do nothing for now.
    }

    public contains(cellUri: vscode.Uri) {
        return this._notebookCells.find((c) => c.uri.toString() === cellUri.toString()) !== undefined;
    }

    public save(): Promise<boolean> {
        return Promise.resolve(false);
    }

    public lineAt(position: vscode.Position | number): vscode.TextLine {
        if (typeof position === 'number') {
            return this._concatLines[position as number];
        } else {
            return this._concatLines[position.line];
        }
    }
    public offsetAt(position: vscode.Position | vscode.Location): number {
        return this.convertToOffset(position);
    }
    public cellOffsetAt(offset: number): number {
        const positionAt = this.positionAt(offset);
        const locationAt = this.locationAt(positionAt);
        const cell = this._concatCells.find((c) => c.uri.toString() === locationAt.uri.toString());
        if (cell) {
            return offset - cell.startOffset;
        }
        return offset;
    }
    public positionAt(offsetOrPosition: number | vscode.Position | vscode.Location): vscode.Position {
        if (typeof offsetOrPosition !== 'number') {
            offsetOrPosition = this.offsetAt(offsetOrPosition);
        }
        let line = 0;
        let ch = 0;
        while (line + 1 < this._concatLines.length && this._concatLines[line + 1].offset <= offsetOrPosition) {
            line += 1;
        }
        if (line < this._concatLines.length) {
            ch = offsetOrPosition - this._concatLines[line].offset;
        }
        return new vscode.Position(line, ch);
    }
    public rangeOf(cellUri: vscode.Uri) {
        const range = this._concatCells.find((c) => c.uri.toString() === cellUri.toString());
        if (range) {
            const startPosition = this.positionAt(range.startOffset);
            const endPosition = this.positionAt(range.endOffset);
            return new vscode.Range(startPosition, endPosition);
        }
    }
    public getText(range?: vscode.Range | undefined): string {
        if (!range) {
            return this._concatContents;
        } else {
            const startOffset = this.convertToOffset(range.start);
            const endOffset = this.convertToOffset(range.end);
            return this._concatContents.substring(startOffset, endOffset - startOffset);
        }
    }
    public getCells(): vscode.Uri[] {
        return this._notebookCells.map((c) => c.uri);
    }
    public locationAt(positionOrRange: vscode.Range | vscode.Position): vscode.Location {
        if (positionOrRange instanceof vscode.Position) {
            positionOrRange = new vscode.Range(positionOrRange, positionOrRange);
        }
        const startOffset = this.convertToOffset(positionOrRange.start);
        const endOffset = this.convertToOffset(positionOrRange.end);

        // Find cell with that contains the range
        const cell = this._concatCells.find((c) => startOffset >= c.startOffset && endOffset < c.endOffset);

        // Find the start and end lines that contain the start and end offset
        const startLine = this._concatLines.find((l) => startOffset >= l.offset && startOffset < l.endOffset);
        const endLine = this._concatLines.find((l) => endOffset >= l.offset && endOffset < l.endOffset);

        // Range is range within this location
        const range =
            startLine && endLine && cell
                ? new vscode.Range(
                      new vscode.Position(startLine.lineNumber - cell.startLine, startOffset - startLine.offset),
                      new vscode.Position(endLine.lineNumber - cell.startLine, endOffset - endLine.offset)
                  )
                : new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 0));

        return {
            uri: cell?.uri || this._notebookCells[0].uri,
            range
        };
    }

    public getWordRangeAtPosition(position: vscode.Position, regexp?: RegExp | undefined): vscode.Range | undefined {
        if (!regexp) {
            // use default when custom-regexp isn't provided
            regexp = DefaultWordPattern;
        } else if (regExpLeadsToEndlessLoop(regexp)) {
            // use default when custom-regexp is bad
            console.warn(
                `[getWordRangeAtPosition]: ignoring custom regexp '${regexp.source}' because it matches the empty string.`
            );
            regexp = DefaultWordPattern;
        }

        const wordAtText = getWordAtText(
            position.character + 1,
            ensureValidWordDefinition(regexp),
            this._concatLines[position.line].text,
            0
        );

        if (wordAtText) {
            return new vscode.Range(position.line, wordAtText.startColumn - 1, position.line, wordAtText.endColumn - 1);
        }
        return undefined;
    }
    public validateRange(range: vscode.Range): vscode.Range {
        return range;
    }
    public validatePosition(position: vscode.Position): vscode.Position {
        return position;
    }

    public get textDocumentItem(): protocol.TextDocumentItem {
        return {
            uri: this.concatUri.toString(),
            languageId: this.languageId,
            version: this.version,
            text: this.getText()
        };
    }

    public get textDocumentId(): protocol.VersionedTextDocumentIdentifier {
        return {
            uri: this.concatUri.toString(),
            version: this.version
        };
    }

    private toDidChangeTextDocumentParams(
        changes: protocol.TextDocumentContentChangeEvent[]
    ): protocol.DidChangeTextDocumentParams {
        return {
            textDocument: {
                version: this.version,
                uri: this.concatUri.toString()
            },
            contentChanges: changes
        };
    }

    private applyLineTransform(line: string): string {
        for (let i = 0; i < LineTransforms.length; i++) {
            if (LineTransforms[i].regex.test(line)) {
                return line.replace(LineTransforms[i].regex, LineTransforms[i].replace);
            }
        }
        return line;
    }

    private applyLineTransforms(content: string): string {
        const lines = content.split('\n');
        return lines.map((l) => this.applyLineTransform(l)).join('\n');
    }

    private getLineFromOffset(offset: number) {
        const cell = this._concatCells.find((c) => offset >= c.startOffset && offset < c.endOffset);
        if (cell) {
            const inCellOffset = offset - cell.startOffset;
            let lineCounter = cell.startLine;

            for (let i = 0; i < inCellOffset; i += 1) {
                if (cell.text[i] === '\n') {
                    lineCounter += 1;
                }
            }

            return lineCounter;
        }

        return 0;
    }

    private changeRange(
        newText: string,
        from: vscode.Position,
        to: vscode.Position,
        cellIndex: number
    ): protocol.TextDocumentContentChangeEvent[] {
        const fromOffset = this.convertToOffset(from);
        const toOffset = this.convertToOffset(to);

        // Recreate our contents, and then recompute all of our lines
        const before = this._contents.substring(0, fromOffset);
        const after = this._contents.substring(toOffset);
        this._contents = `${before}${newText}${after}`;
        this._lines = this.createLines();

        // Update ranges after this. All should move by the diff in length, although the current one
        // should stay at the same start point.
        const lengthDiff = newText.length - (toOffset - fromOffset);
        for (let i = cellIndex; i < this._cellRanges.length; i += 1) {
            if (i !== cellIndex) {
                this._cellRanges[i].startOffset += lengthDiff;
            }
            this._cellRanges[i].endOffset += lengthDiff;
        }

        return [
            {
                range: this.createSerializableRange(from, to),
                rangeOffset: fromOffset,
                rangeLength: toOffset - fromOffset,
                text: newText
            } as any
        ];
    }

    private createLines(contents: string): NotebookConcatLine[] {
        const split = splitLines(contents, { trim: false, removeEmptyEntries: false });
        let prevLine: NotebookConcatLine | undefined;
        return split.map((s, i) => {
            const nextLine = this.createTextLine(s, i, prevLine);
            prevLine = nextLine;
            return nextLine;
        });
    }

    private createTextLine(
        contents: string,
        lineNumber: number,
        prevLine: NotebookConcatLine | undefined
    ): NotebookConcatLine {
        return new NotebookConcatLine(
            contents,
            lineNumber,
            prevLine ? prevLine.offset + prevLine.rangeIncludingLineBreak.end.character : 0
        );
    }

    private convertToOffset(posOrLocation: vscode.Position | vscode.Location): number {
        if (posOrLocation instanceof vscode.Location) {
            const cell = this._concatCells.find(
                (c) => c.uri.toString() == (<vscode.Location>posOrLocation).uri.toString()
            );
            posOrLocation = cell
                ? new vscode.Position(
                      this.convertToPosition(cell.startOffset).line + posOrLocation.range.start.line,
                      posOrLocation.range.start.character
                  )
                : posOrLocation.range.start;
        }

        if (posOrLocation.line < this._concatLines.length) {
            return this._concatLines[posOrLocation.line].offset + posOrLocation.character;
        }
        return this._concatContents.length;
    }

    private convertToPosition(offset: number): vscode.Position {
        let lineIndex = this._concatLines.findIndex((l) => l.offset > offset) - 1;
        if (lineIndex < 0 && offset <= this._concatContents.length) {
            lineIndex = this._concatLines.length - 1;
        }
        if (lineIndex >= 0) {
            const offsetInLine = offset - this._concatLines[lineIndex].offset;
            const lineRange = this._concatLines[lineIndex].rangeIncludingLineBreak;
            return new vscode.Position(lineRange.start.line, offsetInLine);
        }

        return new vscode.Position(0, 0);
    }

    private createSerializableRange(start: vscode.Position, end: vscode.Position): vscode.Range {
        // This funciton is necessary so that the Range can be passed back
        // over a remote connection without including all of the extra fields that
        // VS code puts into a Range object.
        const result = {
            start: {
                line: start.line,
                character: start.character
            },
            end: {
                line: end.line,
                character: end.character
            }
        };
        return result as vscode.Range;
    }

    private computeInsertionIndex(fragment: number): number {
        // Remember if last cell is already the input box
        const inputBoxPresent =
            this._notebookCells[this._notebookCells.length - 1]?.uri.scheme === InteractiveInputScheme;
        const totalLength = inputBoxPresent ? this._notebookCells.length - 1 : this._notebookCells.length;

        // Find index based on fragment
        const index =
            fragment == -1 ? this._notebookCells.length : this._notebookCells.findIndex((c) => c.fragment > fragment);
        return index < 0 ? totalLength : index;
    }

    private initialize(cellUri: vscode.Uri) {
        if (!this._concatUri?.fsPath) {
            this._interactiveWindow = isInteractiveCell(cellUri);
            const dir = path.dirname(cellUri.fsPath);

            // Path has to match no matter how many times we open it.
            const concatFilePath = path.join(
                dir,
                `${NotebookConcatPrefix}${shajs('sha1').update(cellUri.fsPath).digest('hex').substring(0, 12)}.py`
            );
            this._concatUri = vscode.Uri.file(concatFilePath);
            this._notebookUri = this._interactiveWindow
                ? cellUri.with({ scheme: InteractiveScheme, path: cellUri.fsPath, fragment: undefined })
                : vscode.Uri.file(cellUri.fsPath);
        }
    }
}

// Thoughts:
// Replace contents with using edit ranges
// Each range indicates cell uri, start and end offset.
// Lines just come from full contents.
