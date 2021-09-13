// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
import { Disposable, DocumentSelector } from 'vscode';
import { LanguageClient, Middleware } from 'vscode-languageclient/node';

import { IVSCodeNotebook } from './common/types';
import { ConsumingMiddlewareAddon } from './consumingMiddlewareAddon';
import { NotebookMiddlewareAddon } from './notebookMiddlewareAddon';

export type MiddlewareAddon = Middleware & Disposable;

// Factory method for creating the middleware addon
export function createMiddlewareAddon(
    notebookApi: IVSCodeNotebook,
    getClient: () => LanguageClient | undefined,
    traceInfo: (...args: any[]) => void,
    cellSelector: string | DocumentSelector,
    notebookFileRegex: RegExp,
    pythonPath?: string,
    trace?: (message: string) => void
): MiddlewareAddon {
    // We have two types of middleware addons.
    // - Python based addon that python extension creates. It consumes
    // all events for python selector
    // - Notebook based addon taht jupyter extension creates. It processes
    // events for a jupyter (python) notebook
    if (cellSelector === 'python') {
        return new ConsumingMiddlewareAddon();
    } else {
        return new NotebookMiddlewareAddon(
            notebookApi,
            getClient,
            traceInfo,
            cellSelector,
            notebookFileRegex,
            pythonPath,
            trace
        );
    }
}
