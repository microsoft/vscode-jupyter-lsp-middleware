// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

'use strict';

import * as vscode from 'vscode';
import { ITextLine } from '../protocol-only/types';

export class TextLineWrapper implements vscode.TextLine {
    constructor(private readonly impl: ITextLine) {}
    get lineNumber(): number {
        return this.impl.lineNumber;
    }
    get text(): string {
        return this.impl.text;
    }
    get range(): vscode.Range {
        return new vscode.Range(
            new vscode.Position(this.impl.range.start.line, this.impl.range.start.character),
            new vscode.Position(this.impl.range.end.line, this.impl.range.end.character)
        );
    }
    get rangeIncludingLineBreak(): vscode.Range {
        return new vscode.Range(
            new vscode.Position(
                this.impl.rangeIncludingLineBreak.start.line,
                this.impl.rangeIncludingLineBreak.start.character
            ),
            new vscode.Position(
                this.impl.rangeIncludingLineBreak.end.line,
                this.impl.rangeIncludingLineBreak.end.character
            )
        );
    }
    get firstNonWhitespaceCharacterIndex(): number {
        return this.impl.firstNonWhitespaceCharacterIndex;
    }
    get isEmptyOrWhitespace(): boolean {
        return this.impl.isEmptyOrWhitespace;
    }
}
