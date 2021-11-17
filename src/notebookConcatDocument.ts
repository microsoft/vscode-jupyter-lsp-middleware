// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

'use strict';
import * as vscode from 'vscode';
import * as protocol from 'vscode-languageclient/node';
import * as path from 'path';
import * as shajs from 'sha.js';
import * as fastDiff from 'fast-diff';
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
    realOffset: number;
    realEndOffset: number;
    text: string;
    realText: string;
};

const TypeIgnoreAddition = ' # type: ignore';

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
    private _spans: NotebookSpan[] = [];
    private _lines: NotebookConcatLine[] = [];
    private _realLines: NotebookConcatLine[] = [];

    public handleChange(e: protocol.TextDocumentEdit): protocol.DidChangeTextDocumentParams | undefined {
        this._version++;
        const changes: protocol.TextDocumentContentChangeEvent[] = [];
        const index = this._spans.findIndex((c) => c.uri.toString() === e.textDocument.uri);
        if (index >= 0) {
            e.edits.forEach((edit) => {
                // Get all the real spans for this cell (after each edit as they'll change)
                const oldSpans = this._spans.filter((s) => s.uri.toString() === e.textDocument.uri);
                const oldText = oldSpans.map((s) => s.text).join('');

                // Apply the edit to the real spans
                const realText = this.getRealText(oldSpans[0].uri);
                const realCellLines = this._realLines.filter((r) => r.cellUri.toString() === e.textDocument.uri);
                const firstLineOffset = realCellLines[0].offset;
                const startOffset =
                    realCellLines[edit.range.start.line].offset + edit.range.start.character - firstLineOffset;
                const endOffset =
                    realCellLines[edit.range.end.line].offset + edit.range.end.character - firstLineOffset;
                const editedText = `${realText.slice(0, startOffset)}${edit.newText.replace(/\r/g, '')}${realText.slice(
                    endOffset
                )}`;

                // Create new spans from the edited text
                const newSpans = this.createSpans(
                    oldSpans[0].uri,
                    editedText,
                    oldSpans[0].startOffset,
                    oldSpans[0].realOffset
                );
                const newText = newSpans.map((s) => s.text).join('');

                // Diff the two pieces of text
                const diff = fastDiff(oldText, newText);

                // Compare the new spans with the old spans to see where things start to diff
                const oldStartOffset = this.mapRealToConcatOffset(startOffset + firstLineOffset);
                const oldEndOffset = this.mapRealToConcatOffset(endOffset + firstLineOffset);
                let changeStartOffset = oldStartOffset;
                let changeEndOffset = oldEndOffset;
                for (let n = 0, o = 0; n < newSpans.length && o < oldSpans.length; ) {
                    // Get both spans
                    const oldSpan = oldSpans[o];
                    const newSpan = newSpans[n];

                    // Compare them to see what moved around
                    if (newSpan.inRealCell != oldSpan.inRealCell && oldSpan.text !== newSpan.text) {
                        // An injected cell may be before our new code
                        changeStartOffset = Math.min(changeStartOffset, oldSpan.startOffset);

                        // An injected cell may be after our new code
                        changeEndOffset = Math.max(changeEndOffset, oldSpan.endOffset);

                        // Move up for anybody not real
                        n += newSpan.inRealCell ? 0 : 1;
                        o += newSpan.inRealCell ? 0 : 1;
                    } else {
                        o++;
                        n++;
                    }
                }

                // Use those concat offsets to compute line and numbers
                const fromPosition = this.concatPositionOf(changeStartOffset);
                const toPosition = this.concatPositionOf(changeEndOffset);

                // New text should be the first add if there is one
                const diffText = diff.find((d) => d[0] == fastDiff.INSERT)?.[1] || '';

                changes.push({
                    text: diffText,
                    range: this.createSerializableRange(fromPosition, toPosition)
                });

                // Finally update our spans for this cell.
                const concatDiffLength =
                    newSpans[newSpans.length - 1].endOffset - oldSpans[oldSpans.length - 1].endOffset;
                const realDiffLength =
                    newSpans[newSpans.length - 1].realEndOffset - oldSpans[oldSpans.length - 1].realEndOffset;
                this._spans.splice(index, oldSpans.length, ...newSpans);
                for (let i = index + newSpans.length; i < this._spans.length; i++) {
                    this._spans[i].startOffset += concatDiffLength;
                    this._spans[i].endOffset += concatDiffLength;
                    this._spans[i].realOffset += realDiffLength;
                    this._spans[i].realEndOffset += realDiffLength;
                }

                // Recreate our lines
                this.computeLines();
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
        const fromRealOffset =
            insertIndex < this._spans.length && insertIndex >= 0
                ? this._spans[insertIndex].realOffset
                : this._spans[this._spans.length - 1].realEndOffset;
        const fromPosition =
            insertIndex < this._spans.length && insertIndex >= 0
                ? this._lines.find((l) => l.offset == fromOffset)!.range.start
                : new vscode.Position(this._lines.length, 0);

        // Create spans for the new code
        const newSpans = this.createSpans(cellUri, newCode, fromOffset, fromRealOffset);
        const newSpansLength = newSpans[newSpans.length - 1].endOffset - fromOffset;
        const newSpansRealLength = newSpans[newSpans.length - 1].realEndOffset - fromRealOffset;

        // Move all the other spans down
        for (let i = insertIndex; i <= this._spans.length - 1; i += 1) {
            this._spans[i].startOffset += newSpansLength;
            this._spans[i].endOffset += newSpansLength;
            this._spans[i].realOffset += newSpansRealLength;
            this._spans[i].realEndOffset += newSpansRealLength;
        }

        // Insert the spans into the list
        this._spans.splice(insertIndex, 0, ...newSpans);

        // Update our lines
        this.computeLines();

        const changes: protocol.TextDocumentContentChangeEvent[] = [
            {
                range: this.createSerializableRange(fromPosition, fromPosition),
                rangeOffset: fromOffset,
                rangeLength: 0, // Opens are always zero
                text: newSpans.map((s) => s.text).join('')
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
            this.computeLines();

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
            const to = this._lines.length > 0 ? this._lines[this._lines.length - 1].rangeIncludingLineBreak.end : from;
            const oldLength = this.getEndOffset();
            const oldContents = this.getContents();
            const normalizedCellText = e.cells.map((c) => c.textDocument.text.replace(/\r/g, ''));
            const newContents = `${normalizedCellText.join('\n')}\n`;
            if (newContents != oldContents) {
                this._version++;
                this._closed = false;
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
        // Position should be in the concat coordinates
        if (typeof position === 'number') {
            return this._lines[position as number];
        } else {
            return this._lines[position.line];
        }
    }

    public offsetAt(_position: vscode.Position | vscode.Location): number {
        throw new Error('offsetAt should not be used on concat document. Use a more specific offset computation');
    }

    public positionAt(_offsetOrPosition: number | vscode.Position | vscode.Location): vscode.Position {
        throw new Error('positionAt should not be used on concat document. Use a more specific position computation');
    }
    public getText(range?: vscode.Range | undefined): string {
        // Range should be from the concat document
        const contents = this.getContents();
        if (!range) {
            return contents;
        } else {
            const startOffset = this._lines[range.start.line].offset + range.start.character;
            const endOffset = this._lines[range.end.line].offset + range.end.character;
            return contents.substring(startOffset, endOffset - startOffset);
        }
    }

    public concatPositionAt(location: vscode.Location): vscode.Position {
        // Find first real line of the cell (start line needs to be added to this)
        const firstRealLine = this._realLines.find((r) => r.cellUri.toString() === location.uri.toString());

        if (firstRealLine) {
            // Line number is inside a real line
            const realLine = this._realLines[location.range.start.line + firstRealLine.lineNumber];

            // Convert real line offset to outgoing offset
            const outgoingOffset = this.mapRealToConcatOffset(realLine.offset + location.range.start.character);

            // Find the concat line that has this offset
            const concatLine = this._lines.find((l) => outgoingOffset >= l.offset && outgoingOffset < l.endOffset);
            if (concatLine) {
                return new vscode.Position(concatLine.lineNumber, outgoingOffset - concatLine.offset);
            }
        }
        return new vscode.Position(0, 0);
    }

    public concatOffsetAt(location: vscode.Location): number {
        // Location is inside of a cell
        const firstRealLine = this._realLines.find((r) => r.cellUri.toString() === location.uri.toString());
        if (firstRealLine) {
            // Line number is inside a real line
            const realLine = this._realLines[location.range.start.line + firstRealLine.lineNumber];

            // Use its offset (real offset) to find our outgoing offset
            return this.mapRealToConcatOffset(realLine.offset + location.range.start.character);
        }
        return 0;
    }

    public concatRangeOf(cellUri: vscode.Uri) {
        const cellLines = this._lines.filter((l) => l.cellUri.toString() === cellUri.toString());
        const firstLine = cellLines[0];
        const lastLine = cellLines[cellLines.length - 1];
        if (firstLine && lastLine) {
            return new vscode.Range(firstLine.range.start, lastLine.rangeIncludingLineBreak.end);
        }
        return new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 0));
    }
    public getCells(): vscode.Uri[] {
        return [...new Set(this._spans.map((c) => c.uri))];
    }

    public notebookLocationAt(positionOrRange: vscode.Range | vscode.Position): vscode.Location {
        // positionOrRange should be in concat ranges
        if (positionOrRange instanceof vscode.Position) {
            positionOrRange = new vscode.Range(positionOrRange, positionOrRange);
        }

        // Concat range is easy, it's the actual line numbers.
        const startLine = this._lines[positionOrRange.start.line];
        return {
            uri: startLine.cellUri,
            range: new vscode.Range(
                this.notebookPositionAt(positionOrRange.start),
                this.notebookPositionAt(positionOrRange.end)
            )
        };
    }

    public notebookPositionAt(outgoingPosition: vscode.Position) {
        // Map the concat line to the real line
        const lineOffset = this._lines[outgoingPosition.line].offset;
        const realOffset = this.mapConcatToClosestRealOffset(lineOffset);
        const realLine = this._realLines.find((r) => realOffset >= r.offset && realOffset < r.endOffset);

        // Find the first line of the same uri
        const firstRealLine = this._realLines.find((r) => r.cellUri.toString() === realLine?.cellUri.toString());

        // firstRealLine is the first real line of the cell. It has the relative line number
        const startLine = firstRealLine && realLine ? realLine.lineNumber - firstRealLine.lineNumber : 0;

        // Character offset has to be mapped too
        const charOffset = this.mapConcatToClosestRealOffset(lineOffset + outgoingPosition.character);
        const startChar = charOffset - (realLine?.offset || 0);

        return new vscode.Position(startLine, startChar);
    }

    public notebookOffsetAt(cellUri: vscode.Uri, concatOffset: number) {
        // Convert the offset to the real offset
        const realOffset = this.mapConcatToClosestRealOffset(concatOffset);

        // Find the span with this cell URI
        const span = this._spans.find((s) => s.uri.toString() === cellUri.toString());

        // The relative cell offset is from the beginning of the first span in the cell
        return span ? realOffset - span.realOffset : realOffset;
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

    private mapRealToConcatOffset(realOffset: number): number {
        // Find the real span that has this offset
        const realSpan = this._spans.find((r) => realOffset >= r.realOffset && realOffset < r.realEndOffset);
        if (realSpan) {
            // If we found a match, add the diff. Note if we have a real span
            // that means any 'real' offset it in it is not part of a split
            return realOffset - realSpan.realOffset + realSpan.startOffset;
        }
        return realOffset;
    }

    private mapConcatToClosestRealOffset(concatOffset: number): number {
        // Find the concat span that has this offset
        const concatSpan = this._spans.find((r) => concatOffset >= r.startOffset && concatOffset < r.endOffset);
        if (concatSpan) {
            // Diff is into the concat span
            const diff = concatOffset - concatSpan.startOffset;

            // If real cell, then just add real offset
            if (concatSpan.inRealCell) {
                return diff + concatSpan.realOffset;
            }

            // If not a real cell, just use the plain real offset.
            return concatSpan.realOffset;
        }
        return concatOffset;
    }

    private concatPositionOf(offset: number): vscode.Position {
        // Find line that has this offset (including the end offset)
        const line = this._lines.find((l) => offset >= l.offset && offset <= l.endOffset);
        return line ? new vscode.Position(line.lineNumber, offset - line.offset) : new vscode.Position(0, 0);
    }

    private createIPythonSpan(cellUri: vscode.Uri, offset: number, realOffset: number): NotebookSpan {
        const text = 'import IPython\n';
        return {
            fragment: -1,
            uri: cellUri,
            inRealCell: false,
            startOffset: offset,
            endOffset: offset + text.length,
            realOffset,
            realEndOffset: realOffset,
            text,
            realText: ''
        };
    }

    private createSpan(
        cellUri: vscode.Uri,
        text: string,
        realText: string,
        offset: number,
        realOffset: number
    ): NotebookSpan {
        // Compute fragment based on cell uri
        const fragment =
            cellUri.scheme === InteractiveInputScheme ? -1 : parseInt(cellUri.fragment.substring(2) || '0');
        return {
            fragment,
            uri: cellUri,
            inRealCell: true,
            startOffset: offset,
            endOffset: offset + text.length,
            realOffset,
            realEndOffset: realOffset + realText.length,
            text,
            realText
        };
    }

    private createTypeIgnoreSpan(cellUri: vscode.Uri, offset: number, realOffset: number): NotebookSpan {
        // Compute fragment based on cell uri
        const fragment =
            cellUri.scheme === InteractiveInputScheme ? -1 : parseInt(cellUri.fragment.substring(2) || '0');
        return {
            fragment,
            uri: cellUri,
            inRealCell: false,
            startOffset: offset,
            endOffset: offset + TypeIgnoreAddition.length,
            realOffset,
            realEndOffset: realOffset,
            text: TypeIgnoreAddition,
            realText: ''
        };
    }

    private createSpans(cellUri: vscode.Uri, text: string, offset: number, realOffset: number): NotebookSpan[] {
        // Go through each line, gathering up spans
        const lines = splitLines(text);
        const spans: NotebookSpan[] = [];
        let textOffset = 0;
        lines.forEach((l) => {
            if (TypeIgnoreTransforms.find((transform) => transform.regex.test(l))) {
                // This means up to the current text needs to be turned into a span
                spans.push(
                    this.createSpan(
                        cellUri,
                        text.substring(0, textOffset + l.length),
                        text.substring(0, textOffset + l.length),
                        offset,
                        realOffset
                    )
                );

                // Offset moves by the line length
                offset += l.length;
                realOffset += l.length;
                textOffset += l.length;

                // Then push after that a TypeIgnoreSpan
                spans.push(this.createTypeIgnoreSpan(cellUri, offset, realOffset));

                // Update offset using last span (length of type ignore)
                offset = spans[spans.length - 1].endOffset;

                // Real offset doesn't move because Type ignore span is
                // not in the real code

                // Then add the \n after the line (it's in the real code)
                spans.push(this.createSpan(cellUri, '\n', '\n', offset, realOffset));
                offset += 1;
                realOffset += 1;
                textOffset += 1;
            }
        });

        // Add final span if any text leftover
        if (textOffset < text.length) {
            spans.push(
                this.createSpan(cellUri, text.substring(textOffset), text.substring(textOffset), offset, realOffset)
            );
        }

        return spans;
    }

    private getRealText(cellUri?: vscode.Uri): string {
        if (cellUri) {
            return this._spans
                .filter((s) => s.inRealCell && s.uri.toString() === cellUri.toString())
                .map((s) => s.realText)
                .join('');
        }
        return this._spans
            .filter((s) => s.inRealCell)
            .map((s) => s.realText)
            .join('');
    }

    private createTextLines(uri: vscode.Uri, cell: string, prev: NotebookConcatLine | undefined) {
        const split = splitLines(cell);
        return split.map((s) => {
            const nextLine = this.createTextLine(uri, s, prev);
            prev = nextLine;
            return nextLine;
        });
    }

    private computeLinesUsingFunc(uris: vscode.Uri[], func: (span: NotebookSpan) => string): NotebookConcatLine[] {
        const results: NotebookConcatLine[] = [];
        let prevLine: NotebookConcatLine | undefined;
        uris.forEach((uri) => {
            const cell = this._spans
                .filter((s) => s.uri.toString() == uri.toString())
                .map(func)
                .join('');
            results.push(...this.createTextLines(uri, cell, prevLine));
            prevLine = results[results.length - 1];
        });
        return results;
    }

    private computeLines() {
        // Turn the spans into their cell counterparts
        const uris = this.getCells();
        this._lines = this.computeLinesUsingFunc(uris, (s) => s.text);
        this._realLines = this.computeLinesUsingFunc(uris, (s) => s.realText);
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

            // Inject an import for IPython as every notebook has this implicitly
            this._spans.splice(0, 0, this.createIPythonSpan(cellUri, 0, 0));
            this.computeLines();
        }
    }
}
