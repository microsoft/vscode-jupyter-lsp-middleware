// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
import { Disposable, DocumentSelector, NotebookDocument, Uri } from 'vscode';
import { LanguageClient, Middleware } from 'vscode-languageclient/node';

import { HidingMiddlewareAddon } from './hidingMiddlewareAddon';
import { NotebookMiddlewareAddon } from './notebookMiddlewareAddon';
import { PylanceMiddlewareAddon } from './pylanceMiddlewareAddon';

export type NotebookMiddleware = Middleware &
    Disposable & {
        stopWatching(notebook: NotebookDocument): void;
        startWatching(notebook: NotebookDocument): void;
        refresh(notebook: NotebookDocument): void;
    };

export function createHidingMiddleware(): Middleware & Disposable {
    return new HidingMiddlewareAddon();
}

// Factory method for creating the middleware
export function createNotebookMiddleware(
    getClient: () => LanguageClient | undefined,
    traceInfo: (...args: any[]) => void,
    cellSelector: DocumentSelector,
    pythonPath: string,
    isDocumentAllowed: (uri: Uri) => boolean,
    getNotebookHeader: (uri: Uri) => string
): NotebookMiddleware {
    // LanguageClients are created per interpreter (as they start) with a selector for all notebooks
    // Middleware swallows all requests for notebooks that don't match itself (isDocumentAllowed returns false)
    return new NotebookMiddlewareAddon(
        getClient,
        traceInfo,
        cellSelector,
        pythonPath,
        isDocumentAllowed,
        getNotebookHeader
    );
}

export function createPylanceMiddleware(
    getClient: () => LanguageClient | undefined,
    cellSelector: DocumentSelector,
    pythonPath: string,
    isDocumentAllowed: (uri: Uri) => boolean,
    getNotebookHeader: (uri: Uri) => string
): NotebookMiddleware {
    // LanguageClients are created per interpreter (as they start) with a selector for all notebooks
    // Middleware swallows all requests for notebooks that don't match itself (isDocumentAllowed returns false)
    return new PylanceMiddlewareAddon(getClient, cellSelector, pythonPath, isDocumentAllowed, getNotebookHeader);
}
