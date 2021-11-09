// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import { Disposable } from 'vscode';
import * as protocol from 'vscode-languageclient';

export interface IDisposable {
    dispose(): void | undefined;
}

export type TemporaryFile = { filePath: string } & Disposable;

// Type for refresh notebook to pass through LSP
export type RefreshNotebookEvent = {
    cells: protocol.DidOpenTextDocumentParams[];
};
