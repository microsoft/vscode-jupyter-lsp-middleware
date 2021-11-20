// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires */
import { assert } from 'chai';
import { Position, Disposable, languages, Range, WorkspaceEdit, workspace, Uri } from 'vscode';
import { DocumentFilter } from 'vscode-languageserver-protocol';
import {
    canRunNotebookTests,
    closeNotebooksAndCleanUpAfterTests,
    insertCodeCell,
    createEmptyPythonNotebook,
    traceInfo,
    createLanguageServer,
    focusCell,
    captureScreenShot,
    captureOutputMessages,
    LanguageServer,
    waitForDiagnostics
} from './helper';

export const PYTHON_LANGUAGE = 'python';
export const NotebookCellScheme = 'vscode-notebook-cell';
export const InteractiveInputScheme = 'vscode-interactive-input';
export const NOTEBOOK_SELECTOR: DocumentFilter[] = [
    { scheme: NotebookCellScheme, language: PYTHON_LANGUAGE },
    { scheme: InteractiveInputScheme, language: PYTHON_LANGUAGE }
];

/* eslint-disable @typescript-eslint/no-explicit-any, no-invalid-this */
suite('Pylance tests', function () {
    const disposables: Disposable[] = [];
    let languageServer: LanguageServer | undefined = undefined;
    let allowIntellisense = true;
    let emptyNotebookUri: Uri | undefined;
    const shouldProvideIntellisense = (uri: Uri) => {
        if (emptyNotebookUri?.fsPath === uri.fsPath) {
            return allowIntellisense;
        }
        return false;
    };
    this.timeout(120_000);
    suiteSetup(async function () {
        this.timeout(120_000);
        if (!canRunNotebookTests()) {
            return this.skip();
        }
        languageServer = await createLanguageServer(
            'lsp-middleware-test',
            NOTEBOOK_SELECTOR,
            'pylance',
            shouldProvideIntellisense,
            () => ''
        );
    });
    // Use same notebook without starting kernel in every single test (use one for whole suite).
    setup(async function () {
        traceInfo(`Start Test ${this.currentTest?.title}`);
        allowIntellisense = true;
        emptyNotebookUri = await createEmptyPythonNotebook(disposables);
        traceInfo(`Start Test (completed) ${this.currentTest?.title}`);
    });
    teardown(async function () {
        traceInfo(`Ended Test ${this.currentTest?.title}`);
        if (this.currentTest && this.currentTest.state === 'failed') {
            await captureScreenShot(this.currentTest.title);
            await captureOutputMessages();
        }
        await closeNotebooksAndCleanUpAfterTests(disposables);
        traceInfo(`Ended Test (completed) ${this.currentTest?.title}`);
    });
    suiteTeardown(async () => {
        closeNotebooksAndCleanUpAfterTests(disposables);
        await languageServer?.dispose();
    });
    test('Edit a cell and make sure diagnostics do show up', async () => {
        // Pylance should definitely be able to handle a single cell
        const cell = await insertCodeCell('import sys\nprint(sys.executable)\na = 1');
        // Should be no diagnostics yet
        let diagnostics = languages.getDiagnostics(cell.document.uri);
        assert.isEmpty(diagnostics, 'No diagnostics should be found in the first cell');

        // Edit the cell
        await focusCell(cell);
        const edit = new WorkspaceEdit();
        edit.replace(cell.document.uri, new Range(new Position(0, 7), new Position(0, 10)), 'system');
        await workspace.applyEdit(edit);

        // There should be diagnostics now
        await waitForDiagnostics(cell.document.uri);
    });
});
