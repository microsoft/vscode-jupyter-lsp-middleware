// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import { DocumentSelector, NotebookDocument, Event, NotebookConcatTextDocument, Disposable } from 'vscode';

export const IVSCodeNotebook = Symbol('IVSCodeNotebook');
export interface IVSCodeNotebook {
    readonly notebookDocuments: ReadonlyArray<NotebookDocument>;
    readonly onDidOpenNotebookDocument: Event<NotebookDocument>;
    readonly onDidCloseNotebookDocument: Event<NotebookDocument>;
    createConcatTextDocument(notebook: NotebookDocument, selector?: DocumentSelector): NotebookConcatTextDocument;
}

export interface IDisposable {
    dispose(): void | undefined;
}

export type TemporaryFile = { filePath: string } & Disposable;
