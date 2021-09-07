// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
import { Disposable } from 'vscode';
import { LanguageClient, Middleware } from 'vscode-languageclient/node';

import { IVSCodeNotebook } from './common/types';
import { IFileSystem } from './common/types';
import { NotebookMiddlewareAddon } from './notebookMiddlewareAddon';

export type MiddlewareAddon = Middleware & Disposable;

// Factory method for creating the middleware addon
export function createMiddlewareAddon(
    notebookApi: IVSCodeNotebook,
    getClient: () => LanguageClient | undefined,
    traceInfo: (...args: any[]) => void,
    fs: IFileSystem,
    cellSelector: string,
    notebookFileRegex: RegExp
): MiddlewareAddon {
    return new NotebookMiddlewareAddon(notebookApi, getClient, traceInfo, fs, cellSelector, notebookFileRegex);
}
