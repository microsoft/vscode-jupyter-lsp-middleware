// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires */
import { assert } from 'chai';
import {
    window,
    commands,
    CompletionList,
    Position,
    Disposable,
    languages,
    Range,
    WorkspaceEdit,
    workspace
} from 'vscode';
import {
    canRunNotebookTests,
    closeNotebooksAndCleanUpAfterTests,
    insertCodeCell,
    createEmptyPythonNotebook,
    traceInfo,
    initializeTestWorkspace,
    focusCell,
    captureScreenShot,
    captureOutputMessages,
    shutdownLanguageServer,
    sleep
} from './helper';

/* eslint-disable @typescript-eslint/no-explicit-any, no-invalid-this */
suite('Consuming tests', function () {
    const disposables: Disposable[] = [];
    this.timeout(120_000);
    suiteSetup(async function () {
        this.timeout(120_000);
        if (!canRunNotebookTests()) {
            return this.skip();
        }
        await initializeTestWorkspace('consuming-test', 'python');
    });
    // Use same notebook without starting kernel in every single test (use one for whole suite).
    setup(async function () {
        traceInfo(`Start Test ${this.currentTest?.title}`);
        await createEmptyPythonNotebook(disposables);
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
        await shutdownLanguageServer();
    });
    test('Add some cells and get empty completions', async () => {
        await insertCodeCell('import sys\nprint(sys.executable)\na = 1', { index: 0 });
        await insertCodeCell('a.', { index: 1 });
        const cell2 = window.activeNotebookEditor!.document.cellAt(1);

        const position = new Position(0, 2);
        traceInfo('Get completions in test');
        // Executing the command `vscode.executeCompletionItemProvider` to simulate triggering completion
        const completions = (await commands.executeCommand(
            'vscode.executeCompletionItemProvider',
            cell2.document.uri,
            position
        )) as CompletionList;
        const items = completions.items.map((item) => item.label);
        assert.isEmpty(items);
    });
    test('Edit a cell and make sure diagnostics dont show up', async () => {
        const cell = await insertCodeCell('import sys\nprint(sys.executable)\na = 1');
        // Should be no diagnostics yet
        let diagnostics = languages.getDiagnostics(cell.document.uri);
        assert.isEmpty(diagnostics, 'No diagnostics should be found in the first cell');

        // Edit the cell
        await focusCell(cell);
        const edit = new WorkspaceEdit();
        edit.replace(cell.document.uri, new Range(new Position(0, 7), new Position(0, 10)), 'system');
        await workspace.applyEdit(edit);

        // Wait a bit
        await sleep(1000);
        diagnostics = languages.getDiagnostics(cell.document.uri);
        assert.isEmpty(diagnostics, 'No diagnostics should be found after edit of first cell');
    });
});
