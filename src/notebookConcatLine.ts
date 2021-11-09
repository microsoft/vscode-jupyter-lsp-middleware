// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
'use strict';

import * as vscode from 'vscode';

export class NotebookConcatLine implements vscode.TextLine {
    private _range: vscode.Range;
    private _rangeWithLineBreak: vscode.Range;
    private _firstNonWhitespaceIndex: number | undefined;
    private _isEmpty: boolean | undefined;

    constructor(private _contents: string, private _line: number, private _offset: number) {
        this._range = new vscode.Range(new vscode.Position(_line, 0), new vscode.Position(_line, _contents.length));
        this._rangeWithLineBreak = new vscode.Range(this.range.start, new vscode.Position(_line, _contents.length + 1));
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
    public get range(): vscode.Range {
        return this._range;
    }
    public get rangeIncludingLineBreak(): vscode.Range {
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
