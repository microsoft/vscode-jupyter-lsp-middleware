// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

'use strict';
import * as vscode from 'vscode';
import * as protocol from 'vscode-languageclient/node';
import { score } from './common/utils';
import { NotebookConcatDocument } from './notebookConcatDocument';

/**
 * Wrapper around a notebook document that can provide a concatDocument for the notebook.
 */
export class NotebookWrapper implements vscode.Disposable {
    public get isOpen() {
        return !this.concatDocument.isClosed;
    }
    public get concatUri() {
        return this.concatDocument.concatUri;
    }
    public get notebookUri() {
        return this.concatDocument.notebookUri;
    }
    private concatDocument: NotebookConcatDocument = new NotebookConcatDocument();
    constructor(private readonly selector: vscode.DocumentSelector, public readonly key: string) {}
    public dispose() {
        this.concatDocument.dispose();
    }
    public getCells(): vscode.Uri[] {
        return this.concatDocument.getCells();
    }
    public handleOpen(cell: vscode.TextDocument): protocol.DidChangeTextDocumentParams | undefined {
        if (score(cell, this.selector)) {
            return this.concatDocument.handleOpen({
                uri: cell.uri.toString(),
                languageId: cell.languageId,
                text: cell.getText(),
                version: cell.version
            });
        }
    }
    public handleChange(event: vscode.TextDocumentChangeEvent): protocol.DidChangeTextDocumentParams | undefined {
        if (score(event.document, this.selector)) {
            return this.concatDocument.handleChange({
                textDocument: {
                    version: event.document.version,
                    uri: event.document.uri.toString()
                },
                edits: event.contentChanges.map((c) => {
                    return {
                        range: c.range,
                        rangeLength: c.rangeLength,
                        rangeOffset: c.rangeOffset,
                        newText: c.text
                    };
                })
            });
        }
    }
    public handleClose(cell: vscode.TextDocument): protocol.DidChangeTextDocumentParams | undefined {
        if (score(cell, this.selector)) {
            const result = this.concatDocument.handleClose({ uri: cell.uri.toString() });
            return result;
        }
    }
    public handleRefresh(notebook: vscode.NotebookDocument): protocol.DidChangeTextDocumentParams | undefined {
        if (this.getCells().find((uri) => uri.fsPath == notebook.uri.fsPath)) {
            // Convert the notebook into something the concat document can understand (protocol types)
            return this.concatDocument.handleRefresh({
                cells: notebook
                    .getCells()
                    .filter((c) => score(c.document, this.selector))
                    .map((c) => {
                        return {
                            textDocument: {
                                uri: c.document.uri.toString(),
                                version: c.document.version,
                                languageId: c.document.languageId,
                                text: c.document.getText()
                            }
                        };
                    })
            });
        }
    }
    public getText(range?: vscode.Range) {
        return this.concatDocument.getText(range);
    }
    public locationAt(positionOrRange: vscode.Range | vscode.Position) {
        return this.concatDocument.locationAt(positionOrRange);
    }
    public positionAt(offsetOrPosition: number | vscode.Position | vscode.Location) {
        return this.concatDocument.positionAt(offsetOrPosition);
    }
    public offsetAt(position: vscode.Position | vscode.Location) {
        return this.concatDocument.offsetAt(position);
    }
    public getConcatDocument(): vscode.TextDocument {
        return this.concatDocument;
    }
    public contains(cellUri: vscode.Uri) {
        return this.concatDocument.contains(cellUri);
    }
    public rangeOf(cellUri: vscode.Uri) {
        return this.concatDocument.rangeOf(cellUri);
    }
    public cellOffsetAt(offset: number) {
        return this.concatDocument.cellOffsetAt(offset);
    }
}
