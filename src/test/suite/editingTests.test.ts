/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as protocol from 'vscode-languageclient';
import { generateConcat, withTestNotebook } from './helper';
import { NotebookCellKind, NotebookDocument, TextDocument, Uri } from 'vscode';
import { NotebookConcatDocument } from '../../protocol-only/notebookConcatDocument';

suite('Editing Tests', () => {
    function close(concat: NotebookConcatDocument, document: TextDocument) {
        const params: protocol.DidCloseTextDocumentParams = {
            textDocument: {
                uri: document.uri.toString()
            }
        };
        return concat.handleClose(params);
    }

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
                const concat = generateConcat(notebookDocument);
                assert.strictEqual(concat.lineCount, 6);
                assert.strictEqual(concat.languageId, 'python');
                assert.strictEqual(
                    concat.getText(),
                    ['import IPython\nIPython.get_ipython()', 'print(1)', 'print(2)', 'foo = 2', 'print(foo)', ''].join(
                        '\n'
                    )
                );

                // Verify if we delete markdown, we still have same count
                const markdown = notebookDocument.getCells()[2];
                notebookDocument.getCells().splice(2, 1);
                close(concat, markdown.document);
                assert.strictEqual(concat.lineCount, 6);

                // Verify if we delete python, we still have new count
                const python = notebookDocument.getCells()[1];
                notebookDocument.getCells().splice(1, 1);
                close(concat, python.document);
                assert.strictEqual(concat.lineCount, 5);
            }
        );
    });
});
