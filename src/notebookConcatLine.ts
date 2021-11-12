// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
'use strict';

import * as vscode from 'vscode';
import { InteractiveInputScheme } from './common/utils';

export class NotebookConcatLine implements vscode.TextLine {
    private _firstNonWhitespaceIndex: number | undefined;
    private _isEmpty: boolean | undefined;
    private _fragment: number;

    constructor(public uri: vscode.Uri, public offset: number, public lineNumber: number, private _contents: string) {
        this._fragment = uri.scheme === InteractiveInputScheme ? -1 : parseInt(uri.fragment.substring(2) || '0');
    }
    public get fragment(): number {
        return this._fragment;
    }
    public get endOffset(): number {
        return this.offset + this._contents.length + 1;
    }
    public get text(): string {
        return this._contents;
    }
    public get range(): vscode.Range {
        return new vscode.Range(
            new vscode.Position(this.lineNumber, 0),
            new vscode.Position(this.lineNumber, this._contents.length)
        );
    }
    public get rangeIncludingLineBreak(): vscode.Range {
        return new vscode.Range(
            new vscode.Position(this.lineNumber, 0),
            new vscode.Position(this.lineNumber, this._contents.length + 1)
        );
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
