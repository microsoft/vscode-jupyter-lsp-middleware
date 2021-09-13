/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { assert } from 'chai';
import * as fs from 'fs-extra';
import * as path from 'path';
import * as tmp from 'tmp';
import * as vscode from 'vscode';
import { IDisposable, IVSCodeNotebook } from '../../common/types';
import * as vslc from 'vscode-languageclient/node';
import {
    ClientCapabilities,
    DynamicFeature,
    ExecuteCommandRegistrationOptions,
    ExecuteCommandRequest,
    RegistrationData,
    RegistrationType,
    RevealOutputChannelOn,
    ServerCapabilities,
    StaticFeature
} from 'vscode-languageclient/node';
import { createMiddlewareAddon } from '../..';
import { FileBasedCancellationStrategy } from '../../fileBasedCancellationStrategy';
import * as uuid from 'uuid/v4';

export interface Ctor<T> {
    new (): T;
}

export function mock<T>(): Ctor<T> {
    return function () {} as any;
}

export function mockTextDocument(uri: vscode.Uri, languageId: string, source: string[]) {
    return new (class extends mock<vscode.TextDocument>() {
        override get uri() {
            return uri;
        }
        override get languageId() {
            return languageId;
        }
        override get lineCount() {
            return source.length;
        }
        override get fileName() {
            return uri.fsPath;
        }
        override getText() {
            return source.join('\n');
        }
        override validatePosition(p: vscode.Position) {
            return p;
        }
        override validateRange(r: vscode.Range) {
            return r;
        }
        override lineAt(line: number | vscode.Position) {
            if (typeof line === 'number') {
                return {
                    lineNumber: line + 1,
                    text: source[line],
                    range: new vscode.Range(line + 1, 1, line + 1, source[line].length + 1)
                } as vscode.TextLine;
            } else {
                return {
                    lineNumber: line.line + 1,
                    text: source[line.line],
                    range: new vscode.Range(line.line + 1, 1, line.line + 1, source[line.line].length + 1)
                } as vscode.TextLine;
            }
        }
        override offsetAt(pos: vscode.Position) {
            const line = pos.line;
            let offset = 0;
            for (let i = 0; i < line; i++) {
                offset += source[i].length + 1;
            }

            return offset + pos.character;
        }
    })();
}

const notebookApi: IVSCodeNotebook = new (class implements IVSCodeNotebook {
    public get onDidOpenNotebookDocument(): vscode.Event<vscode.NotebookDocument> {
        return vscode.workspace.onDidOpenNotebookDocument;
    }
    public get onDidCloseNotebookDocument(): vscode.Event<vscode.NotebookDocument> {
        return vscode.workspace.onDidCloseNotebookDocument;
    }
    public get notebookDocuments(): ReadonlyArray<vscode.NotebookDocument> {
        return vscode.workspace.notebookDocuments;
    }
    public createConcatTextDocument(
        doc: vscode.NotebookDocument,
        selector?: vscode.DocumentSelector
    ): vscode.NotebookConcatTextDocument {
        return vscode.notebooks.createConcatTextDocument(doc, selector) as any;
    }
})();

export function withTestNotebook(
    uri: vscode.Uri,
    cells: [
        source: string[],
        lang: string,
        kind: vscode.NotebookCellKind,
        output?: vscode.NotebookCellOutput[],
        metadata?: any
    ][],
    callback: (notebookDocument: vscode.NotebookDocument, notebookApi: IVSCodeNotebook) => void
) {
    let notebookDocument: vscode.NotebookDocument;
    const notebookCells = cells.map((cell, index) => {
        const cellUri = uri.with({ fragment: `ch${index.toString().padStart(7, '0')}` });

        return new (class extends mock<vscode.NotebookCell>() {
            override get index() {
                return index;
            }
            override get notebook() {
                return notebookDocument;
            }
            override get kind() {
                return cell[2];
            }
            override get document() {
                return mockTextDocument(cellUri, cell[1], cell[0]);
            }
        })();
    });

    notebookDocument = new (class extends mock<vscode.NotebookDocument>() {
        override get uri() {
            return uri;
        }
        override get isDirty() {
            return false;
        }
        override get isUntitled() {
            return false;
        }
        override get metadata() {
            return {};
        }
        override get cellCount() {
            return cells.length;
        }
        override getCells() {
            return notebookCells;
        }
        override cellAt(index: number) {
            return notebookCells[index];
        }
    })();

    callback(notebookDocument, notebookApi);
}

// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/* eslint-disable @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports, no-invalid-this, @typescript-eslint/no-explicit-any */

// Running in Conda environments, things can be a little slower.
export const defaultNotebookTestTimeout = 60_000;

export const PYTHON_LANGUAGE = 'python';
export const MARKDOWN_LANGUAGE = 'markdown';
export const JUPYTER_LANGUAGE = 'jupyter';

export enum CellOutputMimeTypes {
    error = 'application/vnd.code.notebook.error',
    stderr = 'application/vnd.code.notebook.stderr',
    stdout = 'application/vnd.code.notebook.stdout'
}

export const EXTENSION_ROOT_DIR_FOR_TESTS = path.join(__dirname, '..', '..', '..', 'src', 'test');

export function isInsiders(): boolean {
    return vscode.env.appName.includes('Insider');
}

export function swallowExceptions(cb: Function) {
    try {
        cb();
    } catch {
        // Ignore errors.
    }
}

export async function selectCell(notebook: vscode.NotebookDocument, start: number, end: number) {
    await vscode.window.showNotebookDocument(notebook, {
        selections: [new vscode.NotebookRange(start, end)]
    });
}

/**
 * Use this class to perform updates on all cells.
 * We cannot update cells in parallel, this could result in data loss.
 * E.g. assume we update execution order, while that's going on, assume we update the output (as output comes back from jupyter).
 * At this point, VSC is still updating the execution order & we then update the output.
 * Depending on the sequence its possible for some of the updates to get lost.
 *
 * Excellent example:
 * Assume we perform the following updates without awaiting on the promise.
 * Without awaiting, its very easy to replicate issues where the output is never displayed.
 * - We update execution count
 * - We update output
 * - We update status after completion
 */
const pendingCellUpdates = new WeakMap<vscode.NotebookDocument, Promise<unknown>>();

export function isPromise<T>(v: any): v is Promise<T> {
    return typeof v?.then === 'function' && typeof v?.catch === 'function';
}

export async function sleep(milliseconds: number) {
    return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

export async function chainWithPendingUpdates(
    document: vscode.NotebookDocument,
    update: (edit: vscode.WorkspaceEdit) => void | Promise<void>
): Promise<boolean> {
    const notebook = document;
    if (document.isClosed) {
        return true;
    }
    const pendingUpdates = pendingCellUpdates.has(notebook) ? pendingCellUpdates.get(notebook)! : Promise.resolve();
    return new Promise<boolean>((resolve, reject) => {
        const aggregatedPromise = pendingUpdates
            // We need to ensure the update operation gets invoked after previous updates have been completed.
            // This way, the callback making references to cell metadata will have the latest information.
            // Even if previous update fails, we should not fail this current update.
            .finally(async () => {
                const edit = new vscode.WorkspaceEdit();
                const result = update(edit);
                if (isPromise(result)) {
                    await result;
                }
                await vscode.workspace.applyEdit(edit).then(
                    (result) => resolve(result),
                    (ex) => reject(ex)
                );
            })
            .catch(noop);
        pendingCellUpdates.set(notebook, aggregatedPromise);
    });
}

export function clearPendingChainedUpdatesForTests() {
    const editor: vscode.NotebookEditor | undefined = vscode.window.activeNotebookEditor;
    if (editor?.document) {
        pendingCellUpdates.delete(editor.document);
    }
}
export async function insertMarkdownCell(source: string, options?: { index?: number }) {
    const activeEditor = vscode.window.activeNotebookEditor;
    if (!activeEditor) {
        throw new Error('No active editor');
    }
    const startNumber = options?.index ?? activeEditor.document.cellCount;
    await chainWithPendingUpdates(activeEditor.document, (edit) => {
        const cellData = new vscode.NotebookCellData(vscode.NotebookCellKind.Markup, source, MARKDOWN_LANGUAGE);
        cellData.outputs = [];
        cellData.metadata = {};
        edit.replaceNotebookCells(activeEditor.document.uri, new vscode.NotebookRange(startNumber, startNumber), [
            cellData
        ]);
    });
    return activeEditor.document.cellAt(startNumber)!;
}
export async function insertCodeCell(source: string, options?: { language?: string; index?: number }) {
    const activeEditor = vscode.window.activeNotebookEditor;
    if (!activeEditor) {
        throw new Error('No active editor');
    }
    const startNumber = options?.index ?? activeEditor.document.cellCount;
    const edit = new vscode.WorkspaceEdit();
    const cellData = new vscode.NotebookCellData(
        vscode.NotebookCellKind.Code,
        source,
        options?.language || PYTHON_LANGUAGE
    );
    cellData.outputs = [];
    cellData.metadata = {};
    edit.replaceNotebookCells(activeEditor.document.uri, new vscode.NotebookRange(startNumber, startNumber), [
        cellData
    ]);
    await vscode.workspace.applyEdit(edit);

    return activeEditor.document.cellAt(startNumber)!;
}
export async function deleteCell(index: number = 0) {
    const activeEditor = vscode.window.activeNotebookEditor;
    if (!activeEditor || activeEditor.document.cellCount === 0) {
        return;
    }
    if (!activeEditor) {
        assert.fail('No active editor');
        return;
    }
    await chainWithPendingUpdates(activeEditor.document, (edit) =>
        edit.replaceNotebookCells(activeEditor.document.uri, new vscode.NotebookRange(index, index + 1), [])
    );
}
export async function deleteAllCellsAndWait() {
    const activeEditor = vscode.window.activeNotebookEditor;
    if (!activeEditor || activeEditor.document.cellCount === 0) {
        return;
    }
    await chainWithPendingUpdates(activeEditor.document, (edit) =>
        edit.replaceNotebookCells(
            activeEditor.document.uri,
            new vscode.NotebookRange(0, activeEditor.document.cellCount),
            []
        )
    );
}

export async function createTemporaryFile(options: {
    templateFile: string;
    dir: string;
}): Promise<{ file: string } & IDisposable> {
    const extension = path.extname(options.templateFile);
    const tempFile = tmp.tmpNameSync({ postfix: extension, dir: options.dir });
    await fs.copyFile(options.templateFile, tempFile);
    return { file: tempFile, dispose: () => swallowExceptions(() => fs.unlinkSync(tempFile)) };
}

export async function createTemporaryNotebook(
    templateFile: string,
    disposables: IDisposable[],
    kernelName: string = 'Python 3'
): Promise<string> {
    const extension = path.extname(templateFile);
    const tempFile = tmp.tmpNameSync({
        postfix: extension,
        prefix: path.basename(templateFile, '.ipynb')
    });
    if (await fs.pathExists(templateFile)) {
        const contents = JSON.parse(await fs.readFile(templateFile, { encoding: 'utf-8' }));
        if (contents.kernel) {
            contents.kernel.display_name = kernelName;
        }
        await fs.writeFile(tempFile, JSON.stringify(contents, undefined, 4));
    }

    disposables.push({ dispose: () => swallowExceptions(() => fs.unlinkSync(tempFile)) });
    return tempFile;
}

export function canRunNotebookTests() {
    // Can always run notebook tests. Don't currently have a channel dependency
    return true;
}

export async function shutdownAllNotebooks() {
    // Does nothing when no kernels.
}

export function disposeAllDisposables(disposables: vscode.Disposable[] = []) {
    while (disposables.length) {
        const disposable = disposables.shift();
        if (disposable) {
            try {
                disposable.dispose();
            } catch {
                // Don't care.
            }
        }
    }
}

async function closeWindowsInternal() {
    // If there are no editors, we can skip. This seems to time out if no editors visible.
    if (
        !vscode.window.visibleTextEditors ||
        (vscode.env.appName.toLowerCase().includes('insiders') && !vscode.window.visibleNotebookEditors)
    ) {
        // Instead just post the command
        void vscode.commands.executeCommand('workbench.action.closeAllEditors');
        return;
    }

    class CloseEditorsTimeoutError extends Error {
        constructor() {
            super("Command 'workbench.action.closeAllEditors' timed out");
        }
    }
    const closeWindowsImplementation = (timeout = 2_000) => {
        return new Promise<void>((resolve, reject) => {
            // Attempt to fix #1301.
            // Lets not waste too much time.
            const timer = setTimeout(() => reject(new CloseEditorsTimeoutError()), timeout);
            vscode.commands.executeCommand('workbench.action.closeAllEditors').then(
                () => {
                    clearTimeout(timer);
                    resolve();
                },
                (ex) => {
                    clearTimeout(timer);
                    reject(ex);
                }
            );
        });
    };

    // For some reason some times the command times out.
    // If this happens, just wait & retry, no idea why VS Code is flaky.
    // Lets wait & retry executing the command again, hopefully it'll work second time.
    try {
        await closeWindowsImplementation();
    } catch (ex) {
        if (ex instanceof CloseEditorsTimeoutError) {
            // Do nothing. Just stop waiting.
        } else {
            throw ex;
        }
    }
}

function isANotebookOpen() {
    /* eslint-disable */
    if (Array.isArray(vscode.window.visibleNotebookEditors) && vscode.window.visibleNotebookEditors.length) {
        return true;
    }
    return !!vscode.window.activeNotebookEditor;
}

export async function closeActiveWindows(disposables: vscode.Disposable[] = []): Promise<void> {
    if (isInsiders() && process.env.VSC_JUPYTER_RUN_NB_TEST) {
        clearPendingChainedUpdatesForTests();
    }
    clearPendingTimers();
    disposeAllDisposables(disposables);
    await closeActiveNotebooks();
    await closeWindowsInternal();
    // Work around for https://github.com/microsoft/vscode/issues/125211#issuecomment-863592741
    await sleep(2_000);
}
export async function closeActiveNotebooks(): Promise<void> {
    if (!vscode.env.appName.toLowerCase().includes('insiders') || !isANotebookOpen()) {
        return;
    }
    // We could have untitled notebooks, close them by reverting changes.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    while (vscode.window.activeNotebookEditor || vscode.window.activeTextEditor) {
        await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
    }
    // Work around VS Code issues (sometimes notebooks do not get closed).
    // Hence keep trying.
    for (let counter = 0; counter <= 5 && isANotebookOpen(); counter += 1) {
        await sleep(counter * 100);
        await closeWindowsInternal();
    }
    // Work around for https://github.com/microsoft/vscode/issues/125211#issuecomment-863592741
    await sleep(2_000);
}

export async function closeNotebooksAndCleanUpAfterTests(disposables: IDisposable[] = []) {
    clearOutputMessages();
    await closeActiveWindows();
    disposeAllDisposables(disposables);
    await shutdownAllNotebooks();
    await shutdownLanguageServer();
}

const pendingTimers: any[] = [];
export function clearPendingTimers() {
    while (pendingTimers.length) {
        const timer = pendingTimers.shift();
        try {
            clearTimeout(timer);
        } catch {
            // Noop.
        }
        try {
            clearInterval(timer);
        } catch {
            // Noop.
        }
    }
}

/**
 * Wait for a condition to be fulfilled within a timeout.
 *
 * @export
 * @param {() => Promise<boolean>} condition
 * @param {number} timeoutMs
 * @param {string} errorMessage
 * @returns {Promise<void>}
 */
export async function waitForCondition(
    condition: () => Promise<boolean>,
    timeoutMs: number,
    errorMessage: string | (() => string),
    intervalTimeoutMs: number = 10
): Promise<void> {
    return new Promise<void>(async (resolve, reject) => {
        const timeout = setTimeout(() => {
            clearTimeout(timeout);
            // eslint-disable-next-line @typescript-eslint/no-use-before-define
            clearInterval(timer);
            errorMessage = typeof errorMessage === 'string' ? errorMessage : errorMessage();
            console.log(`Test failing --- ${errorMessage}`);
            reject(new Error(errorMessage));
        }, timeoutMs);
        const timer = setInterval(async () => {
            if (!(await condition().catch(() => false))) {
                return;
            }
            clearTimeout(timeout);
            clearInterval(timer);
            resolve();
        }, intervalTimeoutMs);
        pendingTimers.push(timer);
        pendingTimers.push(timeout);
    });
}

export async function closeNotebooks(disposables: IDisposable[] = []) {
    if (!isInsiders()) {
        return false;
    }
    await closeActiveWindows();
    disposeAllDisposables(disposables);
}

/**
 * Open an existing notebook with some metadata that tells extension to use Python kernel.
 * Else creating a blank notebook could result in selection of non-python kernel, based on other tests.
 * We have other tests where we test non-python kernels, this could mean we might end up with non-python kernels
 * when creating a new notebook.
 * This function ensures we always open a notebook for testing that is guaranteed to use a Python kernel.
 */
export async function createEmptyPythonNotebook(disposables: IDisposable[] = []) {
    const templatePythonNbFile = path.join(EXTENSION_ROOT_DIR_FOR_TESTS, 'suite/emptyPython.ipynb');
    // Don't use same file (due to dirty handling, we might save in dirty.)
    // Coz we won't save to file, hence extension will backup in dirty file and when u re-open it will open from dirty.
    const nbFile = await createTemporaryNotebook(templatePythonNbFile, disposables);
    // Open a python notebook and use this for all tests in this test suite.
    await vscode.window.showNotebookDocument(vscode.Uri.file(nbFile));
    assert.isOk(vscode.window.activeNotebookEditor, 'No active notebook');
    await deleteAllCellsAndWait();
}

let workedAroundVSCodeNotebookStartPage = false;
/**
 * VS Code displays a start page when opening notebooks for the first time.
 * This takes focus from the notebook, hence our tests can fail as a result of this.
 * Solution, try to trigger the display of the start page displayed before starting the tests.
 */
export async function workAroundVSCodeNotebookStartPages() {
    if (workedAroundVSCodeNotebookStartPage) {
        return;
    }
    workedAroundVSCodeNotebookStartPage = true;
    await closeActiveWindows();

    // Open a notebook, VS Code will open the start page (wait for 5s for VSCode to react & open it)
    await vscode.workspace.openNotebookDocument('jupyter');
    await sleep(5_000);
    await closeActiveWindows();
}

/**
 *  Wait for VSC to perform some last minute clean up of cells.
 * In tests we can end up deleting cells. However if extension is still dealing with the cells, we need to give it some time to finish.
 */
export async function waitForCellExecutionToComplete(cell: vscode.NotebookCell) {
    // if (!CellExecution.cellsCompletedForTesting.has(cell)) {
    //     CellExecution.cellsCompletedForTesting.set(cell, createDeferred<void>());
    // }
    // // Yes hacky approach, however its difficult to synchronize everything as we update cells in a few places while executing.
    // // 100ms should be plenty sufficient for other code to get executed when dealing with cells.
    // // Again, we need to wait for rest of execution code to access the cells.
    // // Else in tests we'd delete the cells & the extension code could fall over trying to access non-existent cells.
    // // In fact code doesn't fall over, but VS Code just hangs in tests.
    // // If this doesn't work on CI, we'll need to clean up and write more code to ensure we remove these race conditions as done with `CellExecution.cellsCompleted`.
    // await CellExecution.cellsCompletedForTesting.get(cell)!.promise;
    await waitForCondition(
        async () => (cell.executionSummary?.executionOrder || 0) > 0,
        defaultNotebookTestTimeout,
        'Execution did not complete'
    );
    await sleep(100);
}
export async function waitForOutputs(
    cell: vscode.NotebookCell,
    expectedNumberOfOutputs: number,
    timeout: number = defaultNotebookTestTimeout
) {
    await waitForCondition(
        async () => cell.outputs.length === expectedNumberOfOutputs,
        timeout,
        `Cell ${cell.index + 1} did not complete successfully`
    );
}

export async function focusCell(cell: vscode.NotebookCell) {
    // Change current selection
    vscode.window.activeNotebookEditor!.selections = [new vscode.NotebookRange(cell.index, cell.index)];
    // Send a command that will activate a cell
    await vscode.commands.executeCommand('notebook.cell.edit');
}

export async function waitForDiagnostics(
    uri: vscode.Uri,
    timeout: number = defaultNotebookTestTimeout
): Promise<vscode.Diagnostic[]> {
    let diagnostics: vscode.Diagnostic[] = [];
    await waitForCondition(
        async () => {
            diagnostics = vscode.languages.getDiagnostics(uri);
            if (diagnostics && diagnostics.length) {
                return true;
            }
            return false;
        },
        timeout,
        `No diagnostics found for ${uri}`,
        250
    );
    return diagnostics;
}

export async function waitForHover(
    uri: vscode.Uri,
    pos: vscode.Position,
    timeout: number = defaultNotebookTestTimeout
): Promise<vscode.Hover[]> {
    let hovers: vscode.Hover[] = [];
    await waitForCondition(
        async () => {
            // Use a command to get back the list of hovers
            hovers = (await vscode.commands.executeCommand('vscode.executeHoverProvider', uri, pos)) as vscode.Hover[];
            if (hovers && hovers.length) {
                return true;
            }
            return false;
        },
        timeout,
        `No hovers found for ${uri}`,
        250
    );
    return hovers;
}

function getCellOutputs(cell: vscode.NotebookCell) {
    return cell.outputs.length
        ? cell.outputs.map((output) => output.items.map(getOutputText).join('\n')).join('\n')
        : '<No cell outputs>';
}
function getOutputText(output: vscode.NotebookCellOutputItem) {
    if (
        output.mime !== CellOutputMimeTypes.stdout &&
        output.mime !== CellOutputMimeTypes.stderr &&
        output.mime !== 'text/plain' &&
        output.mime !== 'text/markdown'
    ) {
        return '';
    }
    return Buffer.from(output.data as Uint8Array).toString('utf8');
}
function hasTextOutputValue(output: vscode.NotebookCellOutputItem, value: string, isExactMatch = true) {
    if (
        output.mime !== CellOutputMimeTypes.stdout &&
        output.mime !== CellOutputMimeTypes.stderr &&
        output.mime !== 'text/plain' &&
        output.mime !== 'text/markdown'
    ) {
        return false;
    }
    try {
        const haystack = Buffer.from(output.data as Uint8Array).toString('utf8');
        return isExactMatch ? haystack === value || haystack.trim() === value : haystack.includes(value);
    } catch {
        return false;
    }
}

export function assertHasTextOutputInVSCode(
    cell: vscode.NotebookCell,
    text: string,
    index: number = 0,
    isExactMatch = true
) {
    const cellOutputs = cell.outputs;
    assert.ok(cellOutputs.length, 'No output');
    const result = cell.outputs[index].items.some((item) => hasTextOutputValue(item, text, isExactMatch));
    assert.isTrue(
        result,
        `${text} not found in outputs of cell ${cell.index} ${cell.outputs[index].items
            .map((o) => (o.data ? Buffer.from(o.data as Uint8Array).toString('utf8') : ''))
            .join(' ')}`
    );
    return result;
}
export async function waitForTextOutput(
    cell: vscode.NotebookCell,
    text: string,
    index: number = 0,
    isExactMatch = true,
    timeout = defaultNotebookTestTimeout
) {
    await waitForCondition(
        async () => assertHasTextOutputInVSCode(cell, text, index, isExactMatch),
        timeout,
        () =>
            `Output does not contain provided text '${text}' for Cell ${cell.index + 1}, it is ${getCellOutputs(cell)}`
    );
}

export async function waitForCellChange(timeout = defaultNotebookTestTimeout) {
    return new Promise<void>(async (resolve, reject) => {
        let disposable: vscode.Disposable | undefined;
        const timer = setTimeout(() => {
            clearTimeout(timer);
            disposable?.dispose();
            reject(new Error(`Cell change didn't happen before timeout.`));
        }, timeout);
        pendingTimers.push(timer);
        const handler = (_e: vscode.NotebookCellsChangeEvent) => {
            clearTimeout(timer);
            disposable?.dispose();
            resolve();
        };
        disposable = vscode.notebooks.onDidChangeNotebookCells(handler);
    });
}

export async function saveActiveNotebook() {
    await vscode.commands.executeCommand('workbench.action.files.saveAll');
}

export function noop() {
    // Do nothing
}

export function traceInfo(...args: any[]) {
    console.log(args);
}

/**
 * Captures screenshots (png format) & dumps into root directory (on CI).
 * If there's a failure, it will be logged (errors are swallowed).
 */
export async function captureScreenShot(fileNamePrefix: string) {
    if (!process.env.IS_CI) {
        return;
    }
    const name = `${fileNamePrefix}_${uuid()}`.replace(/[\W]+/g, '_');
    const filename = path.join(EXTENSION_ROOT_DIR_FOR_TESTS, `${name}-screenshot.png`);
    try {
        const screenshot = require('screenshot-desktop');
        await screenshot({ filename });
        console.info(`Screenshot captured into ${filename}`);
    } catch (ex) {
        console.error(`Failed to capture screenshot into ${filename}`, ex);
    }
}

let outputMessages: string[] = [];

/**
 * Clears all of the output messages
 */
function clearOutputMessages() {
    outputMessages = [];
}

/**
 * Saves all of the output channel data to a file on CI
 */
export async function captureOutputMessages() {
    if (!process.env.IS_CI) {
        return;
    }
    const filename = path.join(EXTENSION_ROOT_DIR_FOR_TESTS, `pylance-log.text`);
    try {
        await fs.writeFile(filename, outputMessages.join('\n'));
    } catch (ex) {
        console.error(`Failed to capture output messages into ${filename}`, ex);
    }
}

export const NotebookCellScheme = 'vscode-notebook-cell';
export const InteractiveInputScheme = 'vscode-interactive-input';
export const InteractiveScheme = 'vscode-interactive';

export const PYTHON = [
    { scheme: 'file', language: PYTHON_LANGUAGE },
    { scheme: 'untitled', language: PYTHON_LANGUAGE },
    { scheme: 'vscode-notebook', language: PYTHON_LANGUAGE },
    { scheme: NotebookCellScheme, language: PYTHON_LANGUAGE },
    { scheme: InteractiveInputScheme, language: PYTHON_LANGUAGE }
];

let languageClient: vslc.LanguageClient | undefined = undefined;
let languageClientDisposable: vscode.Disposable | undefined = undefined;
let cancellationStrategy: FileBasedCancellationStrategy | undefined = undefined;

function ensure(target: any, key: string) {
    if (target[key] === undefined) {
        target[key] = {};
    }
    return target[key];
}

class NerfedExecuteCommandFeature implements DynamicFeature<ExecuteCommandRegistrationOptions> {
    private _commands: Map<string, vscode.Disposable[]> = new Map<string, vscode.Disposable[]>();

    constructor() {}

    public get registrationType(): RegistrationType<ExecuteCommandRegistrationOptions> {
        return ExecuteCommandRequest.type;
    }

    public fillClientCapabilities(capabilities: ClientCapabilities): void {
        ensure(ensure(capabilities, 'workspace'), 'executeCommand').dynamicRegistration = true;
    }

    public initialize(capabilities: ServerCapabilities): void {
        if (!capabilities.executeCommandProvider) {
            return;
        }
        this.register({
            id: uuid(),
            registerOptions: Object.assign({}, capabilities.executeCommandProvider)
        });
    }

    public register(_data: RegistrationData<ExecuteCommandRegistrationOptions>): void {
        // Do nothing. Otherwise we end up with double registration
        traceInfo('Registering dummy command feature');
    }

    public unregister(id: string): void {
        let disposables = this._commands.get(id);
        if (disposables) {
            disposables.forEach((disposable) => disposable.dispose());
        }
    }

    public dispose(): void {
        this._commands.forEach((value) => {
            value.forEach((disposable) => disposable.dispose());
        });
        this._commands.clear();
    }
}

async function startLanguageServer(languageServerFolder: string, pythonPath: string) {
    const bundlePath = path.join(languageServerFolder, 'server.bundle.js');
    const nonBundlePath = path.join(languageServerFolder, 'server.js');
    const modulePath = (await fs.pathExists(nonBundlePath)) ? nonBundlePath : bundlePath;
    const debugOptions = { execArgv: ['--nolazy', '--inspect=6600'] };
    cancellationStrategy = new FileBasedCancellationStrategy();

    // If the extension is launched in debug mode, then the debug server options are used.
    const serverOptions: vslc.ServerOptions = {
        run: {
            module: bundlePath,
            transport: vslc.TransportKind.ipc,
            args: cancellationStrategy.getCommandLineArguments()
        },
        // In debug mode, use the non-bundled code if it's present. The production
        // build includes only the bundled package, so we don't want to crash if
        // someone starts the production extension in debug mode.
        debug: {
            module: modulePath,
            transport: vslc.TransportKind.ipc,
            options: debugOptions,
            args: cancellationStrategy.getCommandLineArguments()
        }
    };

    // Client options need to include our middleware piece
    const clientOptions: vslc.LanguageClientOptions = {
        documentSelector: PYTHON,
        workspaceFolder: undefined,
        synchronize: {
            configurationSection: PYTHON_LANGUAGE
        },
        outputChannel: vscode.window.createOutputChannel('pylance-test'),
        revealOutputChannelOn: RevealOutputChannelOn.Never,
        middleware: createMiddlewareAddon(
            notebookApi,
            () => languageClient,
            traceInfo,
            'python',
            /.*\.(ipynb|interactive)/m,
            pythonPath,
            (message) => outputMessages.push(message)
        ),
        connectionOptions: {
            cancellationStrategy
        }
    };

    languageClient = new vslc.LanguageClient('lsp-middleware-test', serverOptions, clientOptions);

    // Before starting do a little hack to prevent the pylance double command registration (working with Jake to have an option to skip commands)
    const features: (StaticFeature | DynamicFeature<any>)[] = (languageClient as any)._features;
    const minusCommands = features.filter((f) => (f as any).registrationType?.method != 'workspace/executeCommand');
    minusCommands.push(new NerfedExecuteCommandFeature());
    (languageClient as any)._features = minusCommands;

    // Then start (which will cause the initialize request to be sent to pylance)
    languageClientDisposable = languageClient.start();

    // After starting, wait for it to be ready
    while (languageClient && !languageClient.initializeResult) {
        await sleep(100);
    }
    if (languageClient) {
        await languageClient.onReady();
    }
}

async function shutdownLanguageServer() {
    if (languageClientDisposable) {
        languageClientDisposable.dispose();
        languageClientDisposable = undefined;
    }
    if (cancellationStrategy) {
        cancellationStrategy.dispose();
    }
    if (languageClient) {
        await languageClient.stop();
        languageClient = undefined;
    }
}

export async function initializeTestWorkspace() {
    // Python should be installed too.
    const python = vscode.extensions.getExtension('ms-python.python');
    assert.isOk(python, 'Python extension not installed, test suite cannot run');
    await python?.activate();
    const pythonExports = python?.exports;
    const pythonPath = pythonExports?.settings.getExecutionDetails().execCommand[0] || process.env.CI_PYTHON_PATH;
    assert.isOk(pythonPath, 'Cannot start as no python path for this test');

    // Make sure pylance is installed.
    const pylance = vscode.extensions.getExtension('ms-python.vscode-pylance');
    assert.isOk(pylance, 'Pylance extension not installed, test suite cannot run');

    // If it is, use it to start the language server
    if (pylance) {
        await startLanguageServer(path.join(pylance.extensionPath, 'dist'), pythonPath);
    }
}
