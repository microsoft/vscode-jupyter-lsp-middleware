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

type NotebookSpan = {
    uri: vscode.Uri;
    fragment: number;
    inRealCell: boolean;
    startOffset: number;
    endOffset: number;
    text: string;
};

const TypeIgnoreAddition = ' # type : ignore\n';

const TypeIgnoreTransforms = [{ regex: /(^\s*%.*)/g }, { regex: /(^\s*!.*)/g }, { regex: /(^\s*await\s+.*)/g }];

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
    private _spans: NotebookSpan[] = [];

    public handleChange(e: protocol.TextDocumentEdit): protocol.DidChangeTextDocumentParams | undefined {
        this._version++;
        const changes: protocol.TextDocumentContentChangeEvent[] = [];
        const index = this._spans.findIndex((c) => c.uri.toString() === e.textDocument.uri);
        if (index >= 0) {
            e.edits.forEach((edit) => {
                // Find the start offset for the first matching real line in this cell
                const span = this._spans.find((s) => s.uri.toString() === e.textDocument.uri && s.inRealCell);

                // From that find the line that matches
                const realStartLine = this._lines.find((l) => l.offset == span?.startOffset) || this._lines[0];

                // Use that start line to figure out the true range for our edit
                const startLine = this._lines.find(
                    (l) => edit.range.start.line + realStartLine.lineNumber || 0 == l.notebookLineNumber
                );
                const startOffset = (startLine?.offset || 0) + edit.range.start.character;

                // End offset is the same
                const endLine = this._lines.find(
                    (l) => edit.range.end.line + realStartLine.lineNumber == l.notebookLineNumber
                );
                const endOffset = (endLine?.offset || 0) + edit.range.end.character;

                // Find the range of spans we need to recreate
                const affectedSpans = this._spans.filter((s) => startOffset >= s.startOffset);
                const oldT;

                // Translate the edit into one that matches our 'concat doc'
                const newRange = new vscode.Range(
                    this.translateToConcat(edit.range.start),
                    this.translateToConcat(edit.range.end)
                );

                const normalized = edit.newText.replace(/\r/g, '');
                const position = this.positionAt(cell.startOffset);
                const from = new vscode.Position(position.line + edit.range.start.line, edit.range.start.character);
                const to = new vscode.Position(position.line + edit.range.end.line, edit.range.end.character);
                changes.push(...this.changeRange(normalized, from, to, cellIndex));
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
        if (this._spans.find((c) => c.uri?.toString() == e.uri)) {
            // Can't open twice
            return undefined;
        }

        this._version = Math.max(e.version, this._version + 1);
        this._closed = false;

        // Setup uri and such if first open
        this.initialize(cellUri);

        // Make sure to put a newline between this code and the next code
        const newCode = `${e.text.replace(/\r/g, '')}\n`;

        // Compute 'fragment' portion of URI. It's the tentative cell index
        const fragment =
            cellUri.scheme === InteractiveInputScheme ? -1 : parseInt(cellUri.fragment.substring(2) || '0');

        // That fragment determines order in the list (if we're not forcing append)
        const insertIndex = forceAppend ? this._spans.length : this.computeInsertionIndex(fragment);

        // Compute where we start from.
        const fromOffset =
            insertIndex < this._spans.length && insertIndex >= 0
                ? this._spans[insertIndex].startOffset
                : this._spans[this._spans.length - 1].endOffset;
        const fromPosition =
            insertIndex < this._spans.length && insertIndex >= 0
                ? this._lines.find((l) => l.offset == fromOffset)!.range.start
                : new vscode.Position(this._lines.length, 0);

        // Create spans for the new code
        const newSpans = this.createSpans(cellUri, newCode, fromOffset);
        const newSpansLength = newSpans[newSpans.length - 1].endOffset - fromOffset;

        // Move all the other spans down
        for (let i = insertIndex; i <= this._spans.length - 1; i += 1) {
            this._spans[i].startOffset += newSpansLength;
            this._spans[i].endOffset += newSpansLength;
        }

        // Insert the spans into the list
        this._spans.splice(insertIndex, 0, ...newSpans);

        // Update our lines
        this._lines = this.createLines();

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

    public handleClose(e: protocol.TextDocumentIdentifier): protocol.DidChangeTextDocumentParams | undefined {
        const index = this._spans.findIndex((c) => c.uri.toString() === e.uri);
        const lastIndex = findLastIndex(this._spans, (c) => c.uri.toString() === e.uri);

        // Setup uri and such if a reopen.
        this.initialize(vscode.Uri.parse(e.uri));

        // Ignore unless in notebook mode. For interactive, cells are still there.
        if (index >= 0 && lastIndex >= 0 && !this._interactiveWindow) {
            this._version += 1;

            // Figure out from to to
            const startOffset = this._spans[index].startOffset;
            const endOffset = this._spans[lastIndex].endOffset;
            const fromPosition = this._lines.find((l) => l.offset == startOffset)!.range.start;
            const toPosition = this._lines.find((l) => l.endOffset == endOffset)!.range.end;

            // Figure out removal diff
            const offsetDiff = endOffset - startOffset;

            // Remove all spans related to this uri
            this._spans = this._spans.filter((c) => c.uri.toString() !== e.uri);

            // For every span after, update their offsets
            for (let i = index; i < this._spans.length; i++) {
                this._spans[i].startOffset -= offsetDiff;
                this._spans[i].endOffset -= offsetDiff;
            }

            // Recreate the lines
            this._lines = this.createLines();

            const changes: protocol.TextDocumentContentChangeEvent[] = [
                {
                    range: this.createSerializableRange(fromPosition, toPosition),
                    rangeOffset: startOffset,
                    rangeLength: offsetDiff,
                    text: ''
                } as any
            ];

            // If we closed the last cell, mark as closed
            if (this._spans.length == 0) {
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
            const to = this.positionAt(this.getEndOffset());
            const oldLength = this.getEndOffset();
            const oldContents = this.getContents();
            const normalizedCellText = e.cells.map((c) => c.textDocument.text.replace(/\r/g, ''));
            const newContents = `${normalizedCellText.join('\n')}\n`;
            if (newContents != oldContents) {
                this._version++;
                this._spans = [];
                this._lines = [];

                // Just act like we opened all cells again
                e.cells.forEach((c) => {
                    this.handleOpen(c.textDocument, true);
                });

                // Create one big change
                const changes: protocol.TextDocumentContentChangeEvent[] = [
                    {
                        range: this.createSerializableRange(from, to),
                        rangeOffset: 0,
                        rangeLength: oldLength,
                        text: this.getContents()
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
        return this._spans.find((c) => c.uri.toString() === cellUri.toString()) !== undefined;
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
        const span = this._spans.find((c) => c.uri.toString() === locationAt.uri.toString());
        if (span) {
            return offset - span.startOffset;
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
        const index = this._spans.findIndex((c) => c.uri.toString() === cellUri.toString());
        const lastIndex = findLastIndex(this._spans, (c) => c.uri.toString() === cellUri.toString());
        const startOffset = index >= 0 ? this._spans[index].startOffset : 0;
        const endOffset = lastIndex >= 0 ? this._spans[lastIndex].endOffset : this.getEndOffset();

        const startPosition = this.positionAt(startOffset);
        const endPosition = this.positionAt(endOffset);
        return new vscode.Range(startPosition, endPosition);
    }
    public getText(range?: vscode.Range | undefined): string {
        const contents = this.getContents();
        if (!range) {
            return contents;
        } else {
            const startOffset = this.convertToOffset(range.start);
            const endOffset = this.convertToOffset(range.end);
            return contents.substring(startOffset, endOffset - startOffset);
        }
    }
    public getCells(): vscode.Uri[] {
        return [...new Set(this._spans.map((c) => c.uri))];
    }
    public locationAt(positionOrRange: vscode.Range | vscode.Position): vscode.Location {
        if (positionOrRange instanceof vscode.Position) {
            positionOrRange = new vscode.Range(positionOrRange, positionOrRange);
        }
        const startOffset = this.convertToOffset(positionOrRange.start);
        const endOffset = this.convertToOffset(positionOrRange.end);

        // Find the start and end lines that contain the start and end offset
        const startLine = this._lines.find((l) => startOffset >= l.offset && startOffset < l.endOffset);
        const endLine = this._lines.find((l) => endOffset >= l.offset && endOffset < l.endOffset);

        // Using the start line, find the first line that matches
        const firstCellLine = this._lines.find((l) => l.cellUri.toString() === startLine?.cellUri.toString());

        // Range is range within this location
        const range =
            startLine && endLine && firstCellLine
                ? new vscode.Range(
                      new vscode.Position(
                          startLine.lineNumber - firstCellLine.lineNumber,
                          startOffset - startLine.offset
                      ),
                      new vscode.Position(endLine.lineNumber - firstCellLine.lineNumber, endOffset - endLine.offset)
                  )
                : new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 0));

        return {
            uri: startLine?.cellUri || this._spans[0].uri,
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

    private getContents(): string {
        return this._spans.map((s) => s.text).join('');
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

    private createSpan(cellUri: vscode.Uri, text: string, offset: number): NotebookSpan {
        // Compute fragment based on cell uri
        const fragment =
            cellUri.scheme === InteractiveInputScheme ? -1 : parseInt(cellUri.fragment.substring(2) || '0');
        return {
            fragment,
            uri: cellUri,
            inRealCell: true,
            startOffset: offset,
            endOffset: offset + text.length,
            text
        };
    }

    private createTypeIgnoreSpan(cellUri: vscode.Uri, offset: number): NotebookSpan {
        // Compute fragment based on cell uri
        const fragment =
            cellUri.scheme === InteractiveInputScheme ? -1 : parseInt(cellUri.fragment.substring(2) || '0');
        return {
            fragment,
            uri: cellUri,
            inRealCell: false,
            startOffset: offset,
            endOffset: offset + TypeIgnoreAddition.length,
            text: TypeIgnoreAddition
        };
    }

    private createSpans(cellUri: vscode.Uri, text: string, offset: number): NotebookSpan[] {
        // Go through each line, gathering up spans
        const lines = splitLines(text, { trim: false, removeEmptyEntries: false });
        const spans: NotebookSpan[] = [];
        let currentText = '';
        lines.forEach((l) => {
            currentText = `${currentText}${l}`;

            if (TypeIgnoreTransforms.find((transform) => transform.regex.test(l))) {
                // This means up to the current text needs to be turned into a span
                spans.push(this.createSpan(cellUri, currentText, offset));

                // Then push after that a TypeIgnoreSpan
                spans.push(this.createTypeIgnoreSpan(cellUri, offset + currentText.length));

                // Current text is reset as we just output a span
                currentText = '';

                // Offset moves to end of the last span
                offset = spans[spans.length - 1].endOffset;
            } else {
                // Otherwise update current text to have the line ending and loop around
                // Offset stays the same (it's the beginning of the next span)
                currentText = `${currentText}\n`;
            }
        });

        // Add final span if any text
        if (currentText.length > 0) {
            spans.push(this.createSpan(cellUri, currentText, offset));
        }

        return spans;
    }

    private createLines(): NotebookConcatLine[] {
        // Create lines from the spans
        let cell = '';
        let prevUri: vscode.Uri | undefined;
        let prevLine: NotebookConcatLine | undefined;
        const results: NotebookConcatLine[] = [];
        this._spans.forEach((span, index) => {
            // Concat the spans for this cell together
            cell = `${cell}${span.text}`;

            // If a new uri (or last span), then create the lines for the code in this cell
            if (prevUri?.toString() != span.uri.toString() || index == this._spans.length - 1) {
                const lineUri = index == this._spans.length - 1 ? span.uri : prevUri;
                const split = splitLines(cell, { trim: false, removeEmptyEntries: false });
                results.push(
                    ...split.map((s) => {
                        const nextLine = this.createTextLine(lineUri!, s, prevLine);
                        prevLine = nextLine;
                        return nextLine;
                    })
                );

                // Start concat over again
                cell = '';
                prevUri = span.uri;
            }
        });

        return results;
    }

    private createTextLine(
        cellUri: vscode.Uri,
        contents: string,
        prevLine: NotebookConcatLine | undefined
    ): NotebookConcatLine {
        return new NotebookConcatLine(
            cellUri,
            contents,
            prevLine ? prevLine.lineNumber + 1 : 0,
            prevLine ? prevLine.offset + prevLine.rangeIncludingLineBreak.end.character : 0
        );
    }

    private getEndOffset(): number {
        return this._spans.length > 0 ? this._spans[this._spans.length - 1].endOffset : 0;
    }

    private convertToOffset(posOrLocation: vscode.Position | vscode.Location): number {
        if (posOrLocation instanceof vscode.Location) {
            const span = this._spans.find((c) => c.uri.toString() == (<vscode.Location>posOrLocation).uri.toString());
            posOrLocation = span
                ? new vscode.Position(
                      this.convertToPosition(span.startOffset).line + posOrLocation.range.start.line,
                      posOrLocation.range.start.character
                  )
                : posOrLocation.range.start;
        }

        if (posOrLocation.line < this._lines.length) {
            return this._lines[posOrLocation.line].offset + posOrLocation.character;
        }
        return this.getEndOffset();
    }

    private convertToPosition(offset: number): vscode.Position {
        let lineIndex = this._lines.findIndex((l) => l.offset > offset) - 1;
        if (lineIndex < 0 && offset <= this.getEndOffset()) {
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
        const inputBoxPresent = this._spans[this._spans.length - 1]?.uri?.scheme === InteractiveInputScheme;
        const totalLength = inputBoxPresent ? this._spans.length - 1 : this._spans.length;

        // Find index based on fragment
        const index = fragment == -1 ? this._spans.length : this._spans.findIndex((c) => c.fragment > fragment);
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
