/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { workspace, TextLine, DocumentSelector, Event, NotebookCell, NotebookCellKind, NotebookCellOutput, NotebookConcatTextDocument, NotebookDocument, notebooks, Position, Range, TextDocument, Uri } from 'vscode';
import { IVSCodeNotebook } from '../../common/types';

export interface Ctor<T> {
	new(): T;
}

export function mock<T>(): Ctor<T> {
	return function () { } as any;
}

export function mockTextDocument(uri: Uri, languageId: string, source: string[]) {
    return new class extends mock<TextDocument>() {
        override get uri() { return uri; }
        override get languageId() { return languageId; }
        override get lineCount() { return source.length; }
        override get fileName() { return uri.fsPath; }
        override getText() { return source.join('\n'); }
        override validatePosition(p: Position) { return p; }
        override validateRange(r: Range) { return r; }
        override lineAt(line: number | Position) {
            if (typeof line === 'number') {
                return {
                    lineNumber: line + 1,
                    text: source[line],
                    range: new Range(line + 1, 1, line + 1, source[line].length + 1)
                } as TextLine;
            } else {
                return {
                    lineNumber: line.line + 1,
                    text: source[line.line],
                    range: new Range(line.line + 1, 1, line.line + 1, source[line.line].length + 1)
                } as TextLine;
            }
        }
        override offsetAt(pos: Position) {
            const line = pos.line;
            let offset = 0;
            for (let i = 0; i < line; i++) {
                offset += source[i].length + 1;
            }

            return offset + pos.character;
        }
     };
}

const notebookApi: IVSCodeNotebook = new class implements IVSCodeNotebook {
    public get onDidOpenNotebookDocument(): Event<NotebookDocument>  { return workspace.onDidOpenNotebookDocument }
    public get onDidCloseNotebookDocument(): Event<NotebookDocument> { return workspace.onDidCloseNotebookDocument; }
    public get notebookDocuments(): ReadonlyArray<NotebookDocument> { return workspace.notebookDocuments; }
    public createConcatTextDocument(doc: NotebookDocument, selector?: DocumentSelector): NotebookConcatTextDocument {
        return notebooks.createConcatTextDocument(doc, selector) as any;
    }
};

export function withTestNotebook(uri: Uri, cells: [source: string[], lang: string, kind: NotebookCellKind, output?: NotebookCellOutput[], metadata?: any][], callback: (notebookDocument: NotebookDocument, notebookApi: IVSCodeNotebook) => void) {
    let notebookDocument: NotebookDocument;
    const notebookCells = cells.map((cell, index) => {
        const cellUri = uri.with({ fragment: `ch${index.toString().padStart(7, '0')}`});

        return new class extends mock<NotebookCell>() {
            override get index() { return index; }
            override get notebook() { return notebookDocument; }
            override get kind() { return cell[2]; }
            override get document() {
                return mockTextDocument(cellUri, cell[1], cell[0]);
            }
        }
    });
    
    notebookDocument = new class extends mock<NotebookDocument>() {
        override get uri() { return uri; }
        override get isDirty() { return false; }
        override get isUntitled() { return false; }
        override get metadata() { return {}; }
        override get cellCount() { return cells.length; }
        override getCells() { return notebookCells; }
        override cellAt(index: number) { return notebookCells[index]; }

    }

    callback(notebookDocument, notebookApi);
}