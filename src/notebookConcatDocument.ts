// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

'use strict';
import * as vscode from 'vscode';
import * as protocol from 'vscode-languageclient/node';
import * as path from 'path';
import * as shajs from 'sha.js';
import {
    findLastIndex,
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

const LineTransforms = [
    { regex: /(^\s*%.*\n)/g, replace: '(\\1) # type: ignore\n ' },
    { regex: /(^\s*!.*\n)/g, replace: '(\\1) # type: ignore\n ' },
    { regex: /(^\s*await\s+.*\n)/g, replace: '(\\1) # type: ignore\n ' }
];

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
        return this._concatlines.length;
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
    private _concatlines: NotebookConcatLine[] = [];
    private _notebookLines: NotebookConcatLine[] = [];
    private _contents: string = '';

    public handleChange(e: protocol.TextDocumentEdit): protocol.DidChangeTextDocumentParams | undefined {
        this._version++;
        const changes: protocol.TextDocumentContentChangeEvent[] = [];
        const notebookLines = this._notebookLines.filter((c) => c.uri.toString() === e.textDocument.uri);
        const concatLines = this._concatlines.filter((c) => c.uri.toString() === e.textDocument.uri);
        if (notebookLines.length > 0 && concatLines.length > 0) {
            e.edits.forEach((edit) => {
                // Figure out just the matching lines
                const matchingNotebookLines = notebookLines.filter(l => l.lineNumber >= edit.range.start.line && l.lineNumber < edit.range.end.line);
                const matchingConcatLines = concatLines.filter(l => l.lineNumber >= edit.range.start.line && l.lineNumber < edit.range.end.line);

                // Compute offsets for the range
                const notebookStartOffset = matchingNotebookLines[0].offset + edit.range.start.character;
                const concatStartOffset = matchingConcatLines[0].offset + edit.range.start.character;
                const notebookEndOffset = matchingNotebookLines[matchingNotebookLines.length - 1].offset + edit.range.end.character;

                // Get the text from the matching lines
                const matchingNotebookText = matchingNotebookLines.join('\n');
                const matchingConcatText = matchingConcatLines.join('\n');

                // Convert text to remove \r
                const normalized = edit.newText.replace(/\r/g, '');

                // Apply the edit to our lines
                const newNotebookText = `${matchingNotebookText.substring(0, notebookStartOffset)}${normalized}${matchingNotebookText.substring(notebookEndOffset)}`
                
                // Reapply transformations for these lines
                const newConcatText = this.applyLineTransforms(newNotebookText);

                // Now split lines and replace our original lines with new ones
                const newNotebookLines = this.createCellLines(matchingNotebookLines[0].uri, newNotebookText, notebookStartOffset, matchingNotebookLines[0].lineNumber);
                const newConcatLines = this.createCellLines(matchingNotebookLines[0].uri, newConcatText, concatStartOffset, matchingConcatLines[0].lineNumber);

                // Compute end concat offset based on the last char in 
                // await print() # type : ignore
                // await purple()

                this._notebookLines.splice(matchingNotebookLines[0].lineNumber, matchingNotebookLines.length, ...newNotebookLines);
                this._concatlines.splice(matchingConcatLines[0].lineNumber, matchingConcatLines.length, ...newConcatLines);

                // Update the lines after this with new offsets and line numbers
                const notebookOffsetDiff = notebookStartOffset + newNotebookText.length - notebookEndOffset;
                const notebookLineDiff = newNotebookLines.length - matchingNotebookLines.length;
                const concatOffsetDiff = concatStartOffset + newConcatText.length - 



                // Pull out the lines that matter. 
                const position = this.positionAt(cell.startOffset);
                const from = new vscode.Position(position.line + edit.range.start.line, edit.range.start.character);
                const to = new vscode.Position(position.line + edit.range.end.line, edit.range.end.character);
                changes.push(...this.changeRange(normalized, from, to, cellIndex));
            });
            return this.toDidChangeTextDocumentParams(changes);
        }
    }

    public handleOpen(e: protocol.TextDocumentItem): protocol.DidChangeTextDocumentParams | undefined {
        const cellUri = vscode.Uri.parse(e.uri);

        // Make sure we don't already have this cell open
        if (this._concatlines.find((c) => c.uri.toString() == e.uri)) {
            // Can't open twice
            return undefined;
        }

        this._version = Math.max(e.version, this._version + 1);
        this._closed = false;

        // Setup uri and such if first open
        this.initialize(cellUri);

        // Make sure to put a newline between this code and the next code
        const newCode = `${e.text.replace(/\r/g, '')}\n`;

        // Generate the concat code from this newCode
        const concatCode = this.applyLineTransforms(newCode);

        // Compute 'fragment' portion of URI. It's the tentative line index
        const fragment =
            cellUri.scheme === InteractiveInputScheme ? -1 : parseInt(cellUri.fragment.substring(2) || '0');

        // That fragment determines order in the list.
        const notebookIndex = this.computeInsertionIndex(fragment);

        // Use that index to find the same index in the concat list
        const concatIndex =
            notebookIndex >= 0 && notebookIndex < this._notebookLines.length
                ? this._concatlines.findIndex(
                      (c) => c.uri.toString() == this._notebookLines[notebookIndex].uri.toString()
                  )
                : this._concatlines.length;

        // Use indexes to compute start offset
        const notebookOffset = notebookIndex > 0 ? this._notebookLines[notebookIndex - 1].endOffset : 0;
        const concatOffset = concatIndex > 0 ? this._concatlines[concatIndex - 1].endOffset : 0;

        // Use indexes to compute start line
        const notebookLineNumber = notebookIndex > 0 ? this._notebookLines[notebookIndex - 1].lineNumber + 1 : 0;
        const concatLineNumber = concatIndex > 0 ? this._concatlines[concatIndex - 1].lineNumber + 1 : 0;

        // Use index to compute from position
        const fromPosition =
            concatIndex > 0 ? this._concatlines[concatIndex - 1].range.start : new vscode.Position(concatLineNumber, 0);

        // Generate new lines for the new text.
        const notebookLines = this.createCellLines(cellUri, newCode, notebookOffset, notebookLineNumber);
        const concatLines = this.createCellLines(cellUri, concatCode, concatOffset, concatLineNumber);

        // Move all the other lines down
        for (let i = notebookIndex; i < this._notebookLines.length; i += 1) {
            this._notebookLines[i].offset += newCode.length;
            this._notebookLines[i].lineNumber += notebookLines.length;
        }
        for (let i = concatIndex; i < this._concatlines.length; i += 1) {
            this._concatlines[i].offset += concatCode.length;
            this._concatlines[i].lineNumber += concatLines.length;
        }

        // Insert the new lines
        this._notebookLines.splice(notebookIndex, 0, ...notebookLines);
        this._notebookLines.splice(concatIndex, 0, ...concatLines);

        const changes: protocol.TextDocumentContentChangeEvent[] = [
            {
                range: this.createSerializableRange(fromPosition, fromPosition),
                rangeOffset: concatOffset,
                rangeLength: 0, // Opens are always zero
                text: concatCode
            } as any
        ];
        return this.toDidChangeTextDocumentParams(changes);
    }

    public handleClose(e: protocol.TextDocumentIdentifier): protocol.DidChangeTextDocumentParams | undefined {
        const notebookIndex = this._notebookLines.findIndex((c) => c.uri.toString() === e.uri);
        const notebookLastIndex = findLastIndex(this._notebookLines, (c) => c.uri.toString() === e.uri);
        const concatIndex = this._concatlines.findIndex((c) => c.uri.toString() === e.uri);
        const concatLastIndex = findLastIndex(this._concatlines, (c) => c.uri.toString() === e.uri);

        // Setup uri and such if a reopen.
        this.initialize(vscode.Uri.parse(e.uri));

        // Ignore unless in notebook mode. For interactive, cells are still there.
        if (notebookIndex >= 0 && !this._interactiveWindow) {
            this._version += 1;

            // Remove lines from both that all have the same URI
            const fromPosition = this._concatlines[concatIndex].range.start;
            const toPosition = this._concatlines[concatLastIndex].rangeIncludingLineBreak.end;
            const fromOffset = this._concatlines[concatIndex].offset;
            const notebookDiffOffset =
                this._notebookLines[notebookLastIndex].endOffset - this._notebookLines[notebookIndex].offset;
            const concatDiffOffset =
                this._concatlines[concatLastIndex].endOffset - this._concatlines[concatIndex].offset;

            this._notebookLines = this._notebookLines.filter((n) => n.uri.toString() !== e.uri);
            this._concatlines = this._concatlines.filter((n) => n.uri.toString() !== e.uri);

            // Index should be all the ones we need to update
            for (let i = notebookIndex; i < this._notebookLines.length; i++) {
                this._notebookLines[i].offset -= notebookDiffOffset;
                this._notebookLines[i].lineNumber -= notebookLastIndex - notebookIndex;
            }
            for (let i = concatIndex; i < this._concatlines.length; i++) {
                this._concatlines[i].offset -= concatDiffOffset;
                this._concatlines[i].lineNumber -= concatLastIndex - concatIndex;
            }

            const changes: protocol.TextDocumentContentChangeEvent[] = [
                {
                    range: this.createSerializableRange(fromPosition, toPosition),
                    rangeOffset: fromOffset,
                    rangeLength: concatDiffOffset,
                    text: ''
                } as any
            ];

            // If we closed the last cell, mark as closed
            if (this._notebookLines.length == 0) {
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
            const to = this.positionAt(this._contents.length);
            const oldLength = this._contents.length;
            const oldContents = this._contents;
            const normalizedCellText = e.cells.map((c) => c.textDocument.text.replace(/\r/g, ''));
            const newContents = `${normalizedCellText.join('\n')}\n`;
            if (newContents != oldContents) {
                this._version++;
                this._cellRanges = [];
                this._contents = newContents;
                this._lines = this.createCellLines();
                let startOffset = 0;
                e.cells.forEach((c, i) => {
                    const cellText = normalizedCellText[i];
                    const cellUri = vscode.Uri.parse(c.textDocument.uri);
                    this._cellRanges.push({
                        uri: cellUri,
                        startOffset,
                        startLine: this._lines.find((l) => l.offset === startOffset)?.lineNumber || 0,
                        fragment:
                            cellUri.scheme === InteractiveInputScheme
                                ? -1
                                : parseInt(cellUri.fragment.substring(2) || '0'),
                        endOffset: startOffset + cellText.length + 1 // Account for \n between cells
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
    public cellOffsetAt(offset: number): number {
        const positionAt = this.positionAt(offset);
        const locationAt = this.locationAt(positionAt);
        const cell = this._cellRanges.find((c) => c.uri.toString() === locationAt.uri.toString());
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
        while (line + 1 < this._lines.length && this._lines[line + 1].offset <= offsetOrPosition) {
            line += 1;
        }
        if (line < this._lines.length) {
            ch = offsetOrPosition - this._lines[line].offset;
        }
        return new vscode.Position(line, ch);
    }
    public rangeOf(cellUri: vscode.Uri) {
        const range = this._cellRanges.find((c) => c.uri.toString() === cellUri.toString());
        if (range) {
            const startPosition = this.positionAt(range.startOffset);
            const endPosition = this.positionAt(range.endOffset);
            return new vscode.Range(startPosition, endPosition);
        }
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
    public getCells(): vscode.Uri[] {
        return this._cellRanges.map((c) => c.uri);
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
        this._lines = this.createCellLines();

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

    private createCellLines(
        cellUri: vscode.Uri,
        cellContent: string,
        offset: number,
        lineNumber: number
    ): NotebookConcatLine[] {
        const split = splitLines(cellContent, { trim: false, removeEmptyEntries: false });
        return split.map((s, i) => {
            const nextLine = new NotebookConcatLine(cellUri, offset, s, lineNumber + i);
            offset += s.length;
            return nextLine;
        });
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
        // Remember if last cell is already the input box
        const inputBoxPresent =
            this._notebookLines[this._notebookLines.length - 1]?.uri.scheme === InteractiveInputScheme;
        const totalLength = inputBoxPresent ? this._notebookLines.length - 1 : this._notebookLines.length;

        // Find index based on fragment
        const index =
            fragment == -1 ? this._notebookLines.length : this._notebookLines.findIndex((c) => c.fragment > fragment);
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
