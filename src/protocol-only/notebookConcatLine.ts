// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
'use strict';

import * as vscodeUri from 'vscode-uri';
import * as protocol from 'vscode-languageserver-protocol';
import { ITextLine } from './types';
import { createPosition, createRange } from './helper';

export class NotebookConcatLine implements ITextLine {
    private _range: protocol.Range;
    private _rangeWithLineBreak: protocol.Range;
    private _firstNonWhitespaceIndex: number | undefined;
    private _isEmpty: boolean | undefined;

    constructor(
        public cellUri: vscodeUri.URI,
        private _contents: string,
        private _line: number,
        private _offset: number
    ) {
        this._range = createRange(createPosition(_line, 0), createPosition(_line, _contents.length));
        this._rangeWithLineBreak = createRange(this.range.start, createPosition(_line, _contents.length + 1));
    }
    public get offset(): number {
        return this._offset;
    }
    public get endOffset(): number {
        return this._offset + this._contents.length + 1;
    }
    public get lineNumber(): number {
        return this._line;
    }
    public get text(): string {
        return this._contents;
    }
    public get range(): protocol.Range {
        return this._range;
    }
    public get rangeIncludingLineBreak(): protocol.Range {
        return this._rangeWithLineBreak;
    }
    public get firstNonWhitespaceCharacterIndex(): number {
        if (this._firstNonWhitespaceIndex === undefined) {
            this._firstNonWhitespaceIndex = this._contents.trimLeft().length - this._contents.length;
        }
        return this._firstNonWhitespaceIndex;
    }
    public get isEmptyOrWhitespace(): boolean {
        if (this._isEmpty === undefined) {
            this._isEmpty = this._contents.length === 0 || this._contents.trim().length === 0;
        }
        return this._isEmpty;
    }
}
