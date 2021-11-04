/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { generateWrapper, withTestNotebook } from './helper';
import { NotebookCellKind, NotebookDocument, Uri } from 'vscode';

suite('Editing Tests', () => {
    test('Edit a notebook', () => {
        withTestNotebook(
            Uri.from({ scheme: 'vscode-notebook', path: 'test.ipynb' }),
            [
                [['print(1)'], 'python', NotebookCellKind.Code, [], {}],
                [['print(2)'], 'python', NotebookCellKind.Code, [], {}],
                [['test'], 'markdown', NotebookCellKind.Markup, [], {}],
                [['foo = 2', 'print(foo)'], 'python', NotebookCellKind.Code, [], {}]
            ],
            (notebookDocument: NotebookDocument) => {
                const concat = generateWrapper(notebookDocument);
                assert.strictEqual(concat.getConcatDocument().lineCount, 5);
                assert.strictEqual(concat.getConcatDocument().languageId, 'python');
                assert.strictEqual(concat.getText(), ['print(1)', 'print(2)', 'foo = 2', 'print(foo)', ''].join('\n'));

                // Verify if we delete markdown, we still have same count
                const markdown = notebookDocument.getCells()[2];
                notebookDocument.getCells().splice(2, 1);
                concat.handleClose(markdown.document);
                assert.strictEqual(concat.getConcatDocument().lineCount, 5);

                // Verify if we delete python, we still have new count
                const python = notebookDocument.getCells()[1];
                notebookDocument.getCells().splice(1, 1);
                concat.handleClose(python.document);
                assert.strictEqual(concat.getConcatDocument().lineCount, 4);
            }
        );
    });
});
