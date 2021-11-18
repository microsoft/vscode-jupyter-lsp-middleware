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
    workspace,
    Uri,
    DocumentHighlight
} from 'vscode';
import { DocumentFilter } from 'vscode-languageserver-protocol';
import {
    canRunNotebookTests,
    closeNotebooksAndCleanUpAfterTests,
    insertCodeCell,
    createEmptyPythonNotebook,
    traceInfo,
    createLanguageServer,
    focusCell,
    waitForDiagnostics,
    waitForCellChange,
    deleteCell,
    insertMarkdownCell,
    captureScreenShot,
    captureOutputMessages,
    LanguageServer,
    sleep,
    waitForCondition,
    defaultNotebookTestTimeout
} from './helper';

export const PYTHON_LANGUAGE = 'python';
export const NotebookCellScheme = 'vscode-notebook-cell';
export const InteractiveInputScheme = 'vscode-interactive-input';
export const NOTEBOOK_SELECTOR: DocumentFilter[] = [
    { scheme: NotebookCellScheme, language: PYTHON_LANGUAGE },
    { scheme: InteractiveInputScheme, language: PYTHON_LANGUAGE }
];

/* eslint-disable @typescript-eslint/no-explicit-any, no-invalid-this */
suite('Notebook tests', function () {
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
            'notebook',
            shouldProvideIntellisense
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
    test('Edit a cell and make sure diagnostics change', async () => {
        const cell = await insertCodeCell('import sys\nprint(sys.executable)\na = 1');
        // Should be no diagnostics yet
        let diagnostics = languages.getDiagnostics(cell.document.uri);
        assert.isEmpty(diagnostics, 'No diagnostics should be found in the first cell');

        // Edit the cell
        await focusCell(cell);
        const edit = new WorkspaceEdit();
        edit.replace(cell.document.uri, new Range(new Position(0, 7), new Position(0, 10)), 'system');
        await workspace.applyEdit(edit);

        // Wait for an error to show up
        diagnostics = await waitForDiagnostics(cell.document.uri);
        assert.ok(diagnostics, 'Import system should generate a diag error');
        assert.ok(
            diagnostics.find((item) => item.message.includes('system')),
            'System message not found'
        );
    });
    test('Insert cells in the middle', async () => {
        await insertCodeCell('import sys\nprint(sys.executable)');
        await insertCodeCell('import sys\nprint(sys.executable)');
        const cell3 = await insertCodeCell('import system\nprint(sys.executable)', { index: 1 });

        // Wait for an error to show up
        const diagnostics = await waitForDiagnostics(cell3.document.uri);
        assert.ok(diagnostics, 'Import system should generate a diag error on middle cell');
        assert.ok(
            diagnostics.find((item) => item.message.includes('system')),
            'System message not found'
        );
    });
    test('Replace contents of cell', async () => {
        const cell = await insertCodeCell('import sys\nprint(sys.executable)\na = 1');
        // Should be no diagnostics yet
        let diagnostics = languages.getDiagnostics(cell.document.uri);
        assert.isEmpty(diagnostics, 'No diagnostics should be found in the first cell');

        // Edit the cell
        const edit = new WorkspaceEdit();
        edit.replace(cell.document.uri, new Range(new Position(0, 7), new Position(2, 5)), 'stuff');
        await workspace.applyEdit(edit);

        // Wait for an error to show up
        diagnostics = await waitForDiagnostics(cell.document.uri);
        assert.ok(diagnostics, 'Replace should generate a diag error');
        assert.ok(
            diagnostics.find((item) => item.message.includes('stuff')),
            'stuff message not found'
        );
    });
    test('Move cell up and down (and make sure diags move with it)', async () => {
        await insertCodeCell('import sys\nprint(sys.executable)');
        let cell2 = await insertCodeCell('import system\nprint(sys.executable)');
        await insertCodeCell('import sys\nprint(sys.executable)');

        let diagnostics = await waitForDiagnostics(cell2.document.uri);
        assert.ok(diagnostics, 'Import system should generate a diag error on middle cell');
        assert.ok(
            diagnostics.find((item) => item.message.includes('system')),
            'System message not found'
        );

        await focusCell(cell2);
        let changePromise = waitForCellChange();
        await commands.executeCommand('notebook.cell.moveUp');
        await changePromise;

        // First cell should have diags now
        const cell1 = window.activeNotebookEditor?.document.cellAt(0)!;
        diagnostics = await waitForDiagnostics(cell1.document.uri);
        assert.ok(diagnostics, 'Import system should generate a diag error on middle cell');
        assert.ok(
            diagnostics.find((item) => item.message.includes('system')),
            'System message not found'
        );

        // Cell 2 should not have the 'system' problem
        cell2 = window.activeNotebookEditor?.document.cellAt(1)!;
        diagnostics = languages.getDiagnostics(cell2.document.uri);
        assert.notOk(
            diagnostics.find((item) => item.message.includes('system'), 'System diag should not be found after moving')
        );

        // Move cell back down, should have same results.
        await focusCell(cell1);
        changePromise = waitForCellChange();
        await commands.executeCommand('notebook.cell.moveDown');
        await changePromise;
        cell2 = window.activeNotebookEditor?.document.cellAt(1)!;
        diagnostics = await waitForDiagnostics(cell2.document.uri);
        assert.ok(diagnostics, 'Import system should generate a diag error on middle cell');
        assert.ok(
            diagnostics.find((item) => item.message.includes('system')),
            'System message not found'
        );
    });
    test('Move cell with variable up and down (and make sure diags appear)', async () => {
        await insertCodeCell('x = 4');
        await insertMarkdownCell('# HEADER1');
        const cell3 = await insertCodeCell('print(x)');

        await focusCell(cell3);
        let changePromise = waitForCellChange();
        await commands.executeCommand('notebook.cell.moveUp');
        await changePromise;

        // Move again
        const cell2 = window.activeNotebookEditor?.document.cellAt(1)!;

        await focusCell(cell2);
        changePromise = waitForCellChange();
        await commands.executeCommand('notebook.cell.moveUp');
        await changePromise;

        // First cell should have diags now
        const cell1 = window.activeNotebookEditor?.document.cellAt(0)!;
        const diagnostics = await waitForDiagnostics(cell1.document.uri);
        assert.ok(diagnostics, 'Moving variable down should cause diags to show up');
        assert.ok(
            diagnostics.find((item) => item.message.includes('x')),
            'X message not found'
        );
    });
    test('Add some errors with markdown and delete some cells', async () => {
        await insertCodeCell('import sys\nprint(sys.executable)');
        await insertMarkdownCell('# HEADER1');
        let codeCell = await insertCodeCell('import sys\nimport fuzzbaz');
        await insertMarkdownCell('# HEADER2');
        let diagnostics = await waitForDiagnostics(codeCell.document.uri);
        assert.ok(diagnostics, 'Import fuzzbaz should generate a diag error on middle cell');
        assert.ok(
            diagnostics.find((item) => item.range.start.line == 1),
            'Line should be consistent'
        );
        await deleteCell(1);
        codeCell = window.activeNotebookEditor?.document.cellAt(1)!;
        diagnostics = await waitForDiagnostics(codeCell.document.uri);
        assert.ok(diagnostics, 'Import fuzzbaz should generate a diag error on middle cell');
        assert.ok(
            diagnostics.find((item) => item.range.start.line == 1),
            'Line should be consistent'
        );
    });
    test('Make sure diags are skipped when not allowing', async function () {
        this.skip(); // Skip for now. Requires jupyter extension to not be providing intellisense too
        allowIntellisense = false;
        await insertCodeCell('import sys\nprint(sys.executable)');
        await insertCodeCell('import sys\nprint(sys.executable)');
        const cell3 = await insertCodeCell('import system\nprint(sys.executable)', { index: 1 });
        await sleep(3000); // Give some time for diag to show up
        const diagnostics = languages.getDiagnostics(cell3.document.uri);
        assert.isEmpty(diagnostics, `No diagnostics should be found in the third cell ${JSON.stringify(diagnostics)}`);
    });
    test('Delete a cell with a variable in it', async () => {
        await insertCodeCell('import sys');
        await insertMarkdownCell('# HEADER1');
        let codeCell = await insertCodeCell('print(sys.executable)');
        await insertMarkdownCell('# HEADER2');

        // Need to sleep because diagnostics that are empty cannot be waited for as they're the default
        await sleep(1000);
        let diagnostics = languages.getDiagnostics(codeCell.document.uri);
        assert.isEmpty(diagnostics, `No diagnostics should be found`);
        await deleteCell(0);
        codeCell = window.activeNotebookEditor?.document.cellAt(1)!;
        diagnostics = await waitForDiagnostics(codeCell.document.uri);
        assert.isNotEmpty(diagnostics, 'Deleting sys should create diagnostics');
    });
    test('Document highlights', async () => {
        await insertCodeCell('import sys');
        let codeCell = await insertCodeCell('print(sys.executable)');

        let highlights: DocumentHighlight[] = [];
        await waitForCondition(
            async () => {
                highlights = (await commands.executeCommand(
                    'vscode.executeDocumentHighlights',
                    codeCell.document.uri,
                    new Position(0, 7)
                )) as DocumentHighlight[];
                return highlights && highlights.length > 0;
            },
            defaultNotebookTestTimeout,
            `No highlights found for sys`
        );

        // Highlights should be just for this cell
        assert.isNotEmpty(highlights, `No highlights found`);
        assert.equal(highlights.length, 1, `Wrong number of highlights found`);
        assert.ok(
            highlights.find((item) => item.range.start.line == 0 && item.range.start.character == 6),
            `Wrong range found for highlight`
        );
    });
});
