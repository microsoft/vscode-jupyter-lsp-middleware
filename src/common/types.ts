// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import { DocumentSelector, NotebookDocument, Event, NotebookConcatTextDocument, FileStat, FileType, Disposable } from 'vscode';
import * as fsextra from 'fs-extra';
import * as fs from 'fs';

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

export const IFileSystem = Symbol('IFileSystem');
export interface IFileSystem {
    // path-related
    directorySeparatorChar: string;
    arePathsSame(path1: string, path2: string): boolean;
    getDisplayName(path: string): string;

    // "raw" operations
    stat(filePath: string): Promise<FileStat>;
    createDirectory(path: string): Promise<void>;
    deleteDirectory(path: string): Promise<void>;
    listdir(dirname: string): Promise<[string, FileType][]>;
    readFile(filePath: string): Promise<string>;
    readData(filePath: string): Promise<Buffer>;
    writeFile(filePath: string, text: string | Buffer, options?: string | fsextra.WriteFileOptions): Promise<void>;
    appendFile(filename: string, text: string | Buffer): Promise<void>;
    copyFile(src: string, dest: string): Promise<void>;
    deleteFile(filename: string): Promise<void>;
    chmod(path: string, mode: string | number): Promise<void>;
    move(src: string, tgt: string): Promise<void>;
    // sync
    readFileSync(filename: string): string;
    createReadStream(path: string): fs.ReadStream;
    createWriteStream(path: string): fs.WriteStream;

    // utils
    pathExists(path: string): Promise<boolean>;
    fileExists(path: string): Promise<boolean>;
    fileExistsSync(path: string): boolean;
    directoryExists(path: string): Promise<boolean>;
    getSubDirectories(rootDir: string): Promise<string[]>;
    getFiles(rootDir: string): Promise<string[]>;
    getFileHash(filePath: string): Promise<string>;
    search(globPattern: string, cwd?: string, dot?: boolean): Promise<string[]>;
    createTemporaryFile(extension: string, mode?: number): Promise<TemporaryFile>;
    isDirReadonly(dirname: string): Promise<boolean>;
}
