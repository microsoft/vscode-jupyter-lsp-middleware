// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
import { Disposable, DocumentSelector, Uri } from 'vscode';
import { LanguageClient, Middleware } from 'vscode-languageclient/node';

import { IVSCodeNotebook } from './common/types';
import { ConsumingMiddlewareAddon } from './consumingMiddlewareAddon';
import { NotebookMiddlewareAddon } from './notebookMiddlewareAddon';

// Factory method for creating the middleware
export function createNotebookMiddleware(
    notebookApi: IVSCodeNotebook,
    getClient: () => LanguageClient | undefined,
    traceInfo: (...args: any[]) => void,
    cellSelector: DocumentSelector,
    pythonPath: string,
    shouldProvideIntellisense: (uri: Uri) => boolean
): Middleware & Disposable {
    // Current idea:
    // LanguageClients are created per interpreter (as they start) with a selector for all notebooks
    // Middleware swallows all requests for notebooks that don't match itself (shouldProvideIntellisense returns false)
    // Python extension is modified to no longer do intellisense for notebooks or interactive window
}
