// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

'use strict';
import * as vscode from 'vscode';
import * as protocol from 'vscode-languageclient/node';
import * as path from 'path';
import * as uuid from 'uuid/v4';
import { InteractiveInputScheme, NotebookCellScheme, PYTHON_LANGUAGE, splitLines } from './common/utils';
import {
    DefaultWordPattern,
    ensureValidWordDefinition,
    getWordAtText,
    regExpLeadsToEndlessLoop
} from './common/wordHelper';
import { NotebookConcatLine } from './notebookConcatLine';
import { RefreshNotebookEvent } from './common/types';

interface ICellRange {
    uri: vscode.Uri;
    fragment: number;
    startOffset: number;
    endOffset: number;
    startLine: number;
}

const NotebookConcatPrefix = '_NotebookConcat_';

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
        return this._lines.length;
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
    private _lines: NotebookConcatLine[] = [];
    private _contents: string = '';
    private _cellRanges: ICellRange[] = [];

    public handleChange(e: protocol.TextDocumentEdit): protocol.DidChangeTextDocumentParams {
        this._version++;
        const changes: protocol.TextDocumentContentChangeEvent[] = [];
        const cellIndex = this._cellRanges.findIndex((c) => c.uri.toString() === e.textDocument.uri);
        const cell = cellIndex >= 0 ? this._cellRanges[cellIndex] : undefined;
        if (cell) {
            e.edits.forEach((edit) => {
                const normalized = edit.newText.replace(/\r/g, '');
                const position = this.positionAt(cell.startOffset);
                const from = new vscode.Position(position.line + edit.range.start.line, edit.range.start.character);
                const to = new vscode.Position(position.line + edit.range.end.line, edit.range.end.character);
                changes.push(...this.changeRange(normalized, from, to, cellIndex));
            });
        }
        return this.toDidChangeTextDocumentParams(changes);
    }

    public handleOpen(e: protocol.TextDocumentItem): protocol.DidChangeTextDocumentParams {
        this._version = Math.max(e.version, this._version + 1);
        this._closed = false;
        const cellUri = vscode.Uri.parse(e.uri);

        // Setup uri and such if first open
        if (this._cellRanges.length == 0) {
            this._interactiveWindow = cellUri.scheme !== NotebookCellScheme;
            const dir = path.dirname(cellUri.fsPath);
            const concatFilePath = path.join(dir, `${NotebookConcatPrefix}${uuid().replace(/-/g, '')}.py`);
            this._concatUri = vscode.Uri.file(concatFilePath);
            this._notebookUri = vscode.Uri.parse(`vscode-notebook://${cellUri.fsPath}`);
        }

        // Make sure to put a newline between this code and the next code
        const newCode = `${e.text.replace(/\r/g, '')}\n`;

        // Compute 'fragment' portion of URI. It's the tentative cell index
        const fragment =
            cellUri.scheme === InteractiveInputScheme ? -1 : parseInt(cellUri.fragment.substring(2) || '0');

        // That fragment determines order in the list.
        const insertIndex = this.computeInsertionIndex(fragment);

        // Compute where we start from.
        const fromOffset =
            insertIndex < this._cellRanges.length && insertIndex >= 0
                ? this._cellRanges[insertIndex].startOffset
                : this._contents.length;

        // Split our text between the text and the cells above
        const before = this._contents.substring(0, fromOffset);
        const after = this._contents.substring(fromOffset);
        const fromPosition = this.positionAt(fromOffset);

        // Update our entire contents and recompute our lines
        this._contents = `${before}${newCode}${after}`;
        this._lines = this.createLines();

        // Move all the other cell ranges down
        for (let i = insertIndex; i <= this._cellRanges.length - 1; i += 1) {
            this._cellRanges[i].startOffset += newCode.length;
            this._cellRanges[i].endOffset += newCode.length;
        }
        const startOffset = fromOffset;
        const endOffset = fromOffset + newCode.length;
        this._cellRanges.splice(insertIndex, 0, {
            uri: cellUri,
            fragment,
            startOffset,
            endOffset,
            startLine: this._lines.find((l) => l.offset === startOffset)?.lineNumber || 0
        });

        const changes: protocol.TextDocumentContentChangeEvent[] = [
            {
                range: this.createSerializableRange(fromPosition, fromPosition),
                rangeOffset: fromOffset,
                rangeLength: 0, // Opens are always zero
                text: newCode
            } as any
        ];
        return this.toDidChangeTextDocumentParams(changes);
    }

    public handleClose(e: protocol.TextDocumentIdentifier): protocol.DidChangeTextDocumentParams {
        let changes: protocol.TextDocumentContentChangeEvent[] = [];
        const index = this._cellRanges.findIndex((c) => c.uri.toString() === e.uri);

        // Ignore unless in notebook mode. For interactive, cells are still there.
        if (index >= 0 && !this._interactiveWindow) {
            this._version += 1;

            const found = this._cellRanges[index];
            const foundLength = found.endOffset - found.startOffset;
            const from = new vscode.Position(this.getLineFromOffset(found.startOffset), 0);
            const to = this.positionAt(found.endOffset);

            // Remove from the cell ranges.
            for (let i = index + 1; i <= this._cellRanges.length - 1; i += 1) {
                this._cellRanges[i].startOffset -= foundLength;
                this._cellRanges[i].endOffset -= foundLength;
            }
            this._cellRanges.splice(index, 1);

            // Recreate the contents
            const before = this._contents.substring(0, found.startOffset);
            const after = this._contents.substring(found.endOffset);
            this._contents = `${before}${after}`;
            this._lines = this.createLines();

            changes = [
                {
                    range: this.createSerializableRange(from, to),
                    rangeOffset: found.startOffset,
                    rangeLength: foundLength,
                    text: ''
                } as any
            ];

            // If we closed the last cell, mark as closed
            if (this._cellRanges.length == 0) {
                this._closed = true;
            }
        }

        return this.toDidChangeTextDocumentParams(changes);
    }

    public handleRefresh(e: RefreshNotebookEvent): protocol.DidChangeTextDocumentParams | undefined {
        // Delete all cells and start over. This should only happen for non interactive (you can't move interactive cells at the moment)
        if (!this._interactiveWindow) {
            // Track our old full range
            const from = new vscode.Position(0, 0);
            const to = this.positionAt(this._contents.length);
            const oldLength = this._contents.length;
            const oldContents = this._contents;
            const newContents = `${e.cells.map((c) => c.textDocument.text).join('\n')}\n`;
            if (newContents != oldContents) {
                this._version++;
                this._cellRanges = [];
                this._contents = newContents;
                this._lines = this.createLines();
                let startOffset = 0;
                e.cells.forEach((c) => {
                    const cellUri = vscode.Uri.parse(c.textDocument.uri);
                    this._cellRanges.push({
                        uri: cellUri,
                        startOffset,
                        startLine: this._lines.find((l) => l.offset === startOffset)?.lineNumber || 0,
                        fragment:
                            cellUri.scheme === InteractiveInputScheme
                                ? -1
                                : parseInt(cellUri.fragment.substring(2) || '0'),
                        endOffset: startOffset + c.textDocument.text.length + 1 // Account for \n between cells
                    });
                    startOffset = this._cellRanges[this._cellRanges.length - 1].endOffset;
                });

                // Create one big change
                const changes: protocol.TextDocumentContentChangeEvent[] = [
                    {
                        range: this.createSerializableRange(from, to),
                        rangeOffset: 0,
                        rangeLength: oldLength,
                        text: this._contents
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
        return this._cellRanges.find((c) => c.uri.toString() === cellUri.toString()) !== undefined;
    }

    public save(): Promise<boolean> {
        return Promise.resolve(false);
    }

    public lineAt(position: vscode.Position | number): vscode.TextLine {
        if (typeof position === 'number') {
            return this._lines[position as number];
        } else {
            return this._lines[position.line];
        }
    }
    public offsetAt(position: vscode.Position | vscode.Location): number {
        return this.convertToOffset(position);
    }
    public positionAt(offsetOrPosition: number | vscode.Position | vscode.Location): vscode.Position {
        if (typeof offsetOrPosition !== 'number') {
            offsetOrPosition = this.offsetAt(offsetOrPosition);
        }
        let line = 0;
        let ch = 0;
        while (line + 1 < this._lines.length && this._lines[line + 1].offset <= offsetOrPosition) {
            line += 1;
        }
        if (line < this._lines.length) {
            ch = offsetOrPosition - this._lines[line].offset;
        }
        return new vscode.Position(line, ch);
    }
    public getText(range?: vscode.Range | undefined): string {
        if (!range) {
            return this._contents;
        } else {
            const startOffset = this.convertToOffset(range.start);
            const endOffset = this.convertToOffset(range.end);
            return this._contents.substring(startOffset, endOffset - startOffset);
        }
    }
    public locationAt(positionOrRange: vscode.Range | vscode.Position): vscode.Location {
        if (positionOrRange instanceof vscode.Position) {
            positionOrRange = new vscode.Range(positionOrRange, positionOrRange);
        }
        const startOffset = this.convertToOffset(positionOrRange.start);
        const endOffset = this.convertToOffset(positionOrRange.end);

        // Find cell with that contains the range
        const cell = this._cellRanges.find((c) => startOffset >= c.startOffset && endOffset < c.endOffset);

        // Find the start and end lines that contain the start and end offset
        const startLine = this._lines.find((l) => startOffset >= l.offset && startOffset < l.endOffset);
        const endLine = this._lines.find((l) => endOffset >= l.offset && endOffset < l.endOffset);

        // Range is range within this location
        const range =
            startLine && endLine && cell
                ? new vscode.Range(
                      new vscode.Position(startLine.lineNumber - cell.startLine, startOffset - startLine.offset),
                      new vscode.Position(endLine.lineNumber - cell.startLine, endOffset - endLine.offset)
                  )
                : new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 0));

        return {
            uri: cell?.uri || this._cellRanges[0].uri,
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
            this._lines[position.line].text,
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

    // TODO: How to handle moving of cells.
    public swap(_first: string, _second: string): protocol.TextDocumentContentChangeEvent[] {
        let change: protocol.TextDocumentContentChangeEvent[] = [];

        // const firstIndex = this._cellRanges.findIndex((c) => c.id === first);
        // const secondIndex = this._cellRanges.findIndex((c) => c.id === second);
        // if (firstIndex >= 0 && secondIndex >= 0 && firstIndex !== secondIndex && this.inEditMode) {
        //     this._version += 1;

        //     const topIndex = firstIndex < secondIndex ? firstIndex : secondIndex;
        //     const bottomIndex = firstIndex > secondIndex ? firstIndex : secondIndex;
        //     const top = { ...this._cellRanges[topIndex] };
        //     const bottom = { ...this._cellRanges[bottomIndex] };

        //     const from = new Position(this.getLineFromOffset(top.start), 0);
        //     const to = this.positionAt(bottom.currentEnd);

        //     // Swap everything
        //     this._cellRanges[topIndex].id = bottom.id;
        //     this._cellRanges[topIndex].fullEnd = top.start + (bottom.fullEnd - bottom.start);
        //     this._cellRanges[topIndex].currentEnd = top.start + (bottom.currentEnd - bottom.start);
        //     this._cellRanges[bottomIndex].id = top.id;
        //     this._cellRanges[bottomIndex].start = this._cellRanges[topIndex].fullEnd;
        //     this._cellRanges[bottomIndex].fullEnd = this._cellRanges[topIndex].fullEnd + (top.fullEnd - top.start);
        //     this._cellRanges[bottomIndex].currentEnd =
        //         this._cellRanges[topIndex].fullEnd + (top.currentEnd - top.start);

        //     const fromOffset = this.convertToOffset(from);
        //     const toOffset = this.convertToOffset(to);

        //     // Recreate our contents, and then recompute all of our lines
        //     const before = this._contents.substring(0, fromOffset);
        //     const topText = this._contents.substring(top.start, top.fullEnd - top.start);
        //     const bottomText = this._contents.substring(bottom.start, bottom.fullEnd - bottom.start);
        //     const after = this._contents.substring(toOffset);
        //     const replacement = `${bottomText}${topText}`;
        //     this._contents = `${before}${replacement}${after}`;
        //     this._lines = this.createLines();

        //     // Change is a full replacement
        //     change = [
        //         {
        //             range: this.createSerializableRange(from, to),
        //             rangeLength: toOffset - fromOffset,
        //             text: replacement
        //         }
        //     ];
        // }

        return change;
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

    private getLineFromOffset(offset: number) {
        let lineCounter = 0;

        for (let i = 0; i < offset; i += 1) {
            if (this._contents[i] === '\n') {
                lineCounter += 1;
            }
        }

        return lineCounter;
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

    private createLines(): NotebookConcatLine[] {
        const split = splitLines(this._contents, { trim: false, removeEmptyEntries: false });
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
            const cell = this._cellRanges.find(
                (c) => c.uri.toString() == (<vscode.Location>posOrLocation).uri.toString()
            );
            posOrLocation = cell
                ? new vscode.Position(
                      this.convertToPosition(cell.startOffset).line + posOrLocation.range.start.line,
                      posOrLocation.range.start.character
                  )
                : posOrLocation.range.start;
        }

        if (posOrLocation.line < this._lines.length) {
            return this._lines[posOrLocation.line].offset + posOrLocation.character;
        }
        return this._contents.length;
    }

    private convertToPosition(offset: number): vscode.Position {
        let lineIndex = this._lines.findIndex((l) => l.offset > offset) - 1;
        if (lineIndex < 0 && offset <= this._contents.length) {
            lineIndex = this._lines.length - 1;
        }
        if (lineIndex >= 0) {
            const offsetInLine = offset - this._lines[lineIndex].offset;
            const lineRange = this._lines[lineIndex].rangeIncludingLineBreak;
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
        // Otherwise find the cell range that has a higher fragment
        const index =
            fragment == -1 ? this._cellRanges.length : this._cellRanges.findIndex((c) => c.fragment > fragment);
        return index < 0 ? this._cellRanges.length : index;
    }
}
