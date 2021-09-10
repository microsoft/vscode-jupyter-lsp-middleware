// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires */
import { assert } from 'chai';
import { window, commands, CompletionList, Position, Disposable } from 'vscode';
import {
    canRunNotebookTests,
    closeNotebooksAndCleanUpAfterTests,
    insertCodeCell,
    createEmptyPythonNotebook,
    traceInfo,
    initializeTestWorkspace
} from './helper';

/* eslint-disable @typescript-eslint/no-explicit-any, no-invalid-this */
suite('Notebook tests', function () {
    const disposables: Disposable[] = [];
    this.timeout(120_000);
    suiteSetup(async function () {
        this.timeout(120_000);
        if (!canRunNotebookTests()) {
            return this.skip();
        }
        await initializeTestWorkspace();
    });
    // Use same notebook without starting kernel in every single test (use one for whole suite).
    setup(async function () {
        traceInfo(`Start Test ${this.currentTest?.title}`);
        await createEmptyPythonNotebook(disposables);
        process.env.VSC_JUPYTER_IntellisenseTimeout = '30000';
        traceInfo(`Start Test (completed) ${this.currentTest?.title}`);
    });
    teardown(async function () {
        traceInfo(`Ended Test ${this.currentTest?.title}`);
        delete process.env.VSC_JUPYTER_IntellisenseTimeout;
        await closeNotebooksAndCleanUpAfterTests(disposables);
        traceInfo(`Ended Test (completed) ${this.currentTest?.title}`);
    });
    suiteTeardown(() => closeNotebooksAndCleanUpAfterTests(disposables));
    test('Add some cells and get completions', async () => {
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
        assert.isOk(items.length);
        assert.ok(
            items.find((item) =>
                typeof item === 'string' ? item.includes('bit_length') : item.label.includes('bit_length')
            )
        );
        assert.ok(
            items.find((item) =>
                typeof item === 'string' ? item.includes('to_bytes') : item.label.includes('to_bytes')
            )
        );
    });
});
