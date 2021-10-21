// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
import { Disposable, DocumentSelector, NotebookDocument, Uri } from 'vscode';
import { LanguageClient, Middleware } from 'vscode-languageclient/node';

import { IVSCodeNotebook } from './common/types';
import { HidingMiddlewareAddon } from './hidingMiddlewareAddon';
import { NotebookMiddlewareAddon } from './notebookMiddlewareAddon';

export type NotebookMiddleware = Middleware & Disposable & {
    stopWatching(notebook: NotebookDocument): void;
    startWatching(notebook: NotebookDocument): void;
}

export function createHidingMiddleware(): Middleware & Disposable {
    return new HidingMiddlewareAddon();
}

// Factory method for creating the middleware
export function createNotebookMiddleware(
    notebookApi: IVSCodeNotebook,
    getClient: () => LanguageClient | undefined,
    traceInfo: (...args: any[]) => void,
    cellSelector: DocumentSelector,
    notebookFileRegex: RegExp,
    pythonPath: string,
    isDocumentAllowed: (uri: Uri) => boolean
): NotebookMiddleware {
    // Current idea:
    // LanguageClients are created per interpreter (as they start) with a selector for all notebooks
    // Middleware swallows all requests for notebooks that don't match itself (isDocumentAllowed returns false)
    // Python extension is modified to no longer do intellisense for notebooks or interactive window
    return new NotebookMiddlewareAddon(
        notebookApi,
        getClient,
        traceInfo,
        cellSelector,
        notebookFileRegex,
        pythonPath,
        isDocumentAllowed
    );
}
