// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import {
    DocumentSelector,
    NotebookDocument,
    Event,
    NotebookConcatTextDocument,
    Disposable,
    Position,
    TextDocument,
    TextLine,
    Uri
} from 'vscode';

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

export interface IConcatTextDocument {
    onDidChange: Event<void>;
    isClosed: boolean;
    lineCount: number;
    languageId: string;
    isComposeDocumentsAllClosed: boolean;
    getText(range?: Range): string;
    contains(uri: Uri): boolean;
    offsetAt(position: Position): number;
    positionAt(locationOrOffset: Location | number): Position;
    validateRange(range: Range): Range;
    validatePosition(position: Position): Position;
    locationAt(positionOrRange: Position | Range): Location;
    lineAt(posOrNumber: Position | number): TextLine;
    getWordRangeAtPosition(position: Position, regexp?: RegExp | undefined): Range | undefined;
    getComposeDocuments(): TextDocument[];
}
