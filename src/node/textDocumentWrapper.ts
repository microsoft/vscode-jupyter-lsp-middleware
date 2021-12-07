// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

'use strict';

import * as vscode from 'vscode';
import { ITextDocument } from '../protocol-only/types';
import { TextLineWrapper } from './textLineWrapper';

export class TextDocumentWrapper implements vscode.TextDocument {
    constructor(private readonly impl: ITextDocument) {}
    get uri(): vscode.Uri {
        return this.impl.uri;
    }
    get fileName(): string {
        return this.impl.fileName;
    }
    get isUntitled(): boolean {
        return this.impl.isUntitled;
    }
    get languageId(): string {
        return this.impl.languageId;
    }
    get version(): number {
        return this.impl.version;
    }
    get isDirty(): boolean {
        return this.impl.isDirty;
    }
    get isClosed(): boolean {
        return this.impl.isClosed;
    }
    save(): Thenable<boolean> {
        return this.impl.save();
    }
    get eol(): vscode.EndOfLine {
        return this.impl.eol;
    }
    get lineCount(): number {
        return this.impl.lineCount;
    }
    lineAt(line: number): vscode.TextLine;
    lineAt(position: vscode.Position): vscode.TextLine;
    lineAt(position: any): vscode.TextLine {
        const implLine = this.impl.lineAt(position);
        return new TextLineWrapper(implLine);
    }
    offsetAt(position: vscode.Position): number {
        return this.impl.offsetAt(position);
    }
    positionAt(offset: number): vscode.Position {
        const implPos = this.impl.positionAt(offset);
        return new vscode.Position(implPos.line, implPos.character);
    }
    getText(range?: vscode.Range): string {
        return this.impl.getText(range);
    }
    getWordRangeAtPosition(position: vscode.Position, regex?: RegExp): vscode.Range | undefined {
        const implRange = this.impl.getWordRangeAtPosition(position, regex);
        if (implRange) {
            return new vscode.Range(
                new vscode.Position(implRange.start.line, implRange.start.character),
                new vscode.Position(implRange.end.line, implRange.end.character)
            );
        }
    }
    validateRange(range: vscode.Range): vscode.Range {
        const implRange = this.impl.validateRange(range);
        return new vscode.Range(
            new vscode.Position(implRange.start.line, implRange.start.character),
            new vscode.Position(implRange.end.line, implRange.end.character)
        );
    }
    validatePosition(position: vscode.Position): vscode.Position {
        const implPos = this.impl.validatePosition(position);
        return new vscode.Position(implPos.line, implPos.character);
    }
    get notebook(): vscode.NotebookDocument | undefined {
        return undefined;
    }
}
