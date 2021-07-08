/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { score } from '../../concatTextDocument';
import { mockTextDocument, withTestNotebook } from './helper';
import { NotebookCellKind, NotebookDocument, Uri } from 'vscode';
import { EnhancedNotebookConcatTextDocument } from '../../nativeNotebookConcatTextDocument';
import { IVSCodeNotebook } from '../../common/types';
import { InteractiveInputScheme } from '../../common/utils';
import { InteractiveConcatTextDocument } from '../../interactiveConcatTextDocument';

suite('concatTextDocument', () => {
	test('score', () => {
        assert.strictEqual(score(mockTextDocument(Uri.parse('test://test.ipynb'), 'python', []), '*'), 5);
        assert.strictEqual(score(mockTextDocument(Uri.parse('test://test.ipynb'), 'python', []), 'python'), 10);
        assert.strictEqual(score(mockTextDocument(Uri.parse('test://test.ipynb'), 'markdown', []), 'python'), 0);
    });

    test('concat document for notebook', () => {
        withTestNotebook(
            Uri.parse('test://test.ipynb'),
            [
                [['print(1)'], 'python', NotebookCellKind.Code, [], {}],
                [['test'], 'markdown', NotebookCellKind.Markup, [], {}],
                [['foo = 2', 'print(foo)'], 'python', NotebookCellKind.Code, [], {}],
            ],
            (notebookDocument: NotebookDocument, notebookAPI: IVSCodeNotebook) => {
                const concat = new EnhancedNotebookConcatTextDocument(notebookDocument, 'python', notebookAPI);
                assert.strictEqual(concat.lineCount, 3);
                assert.strictEqual(concat.languageId, 'python');
                assert.strictEqual(concat.getText(), ['print(1)', 'foo = 2', 'print(foo)'].join('\n'));
            }
        );
    });

    test.skip('concat document for interactive window', () => {
        withTestNotebook(
            Uri.parse('test://test.ipynb'),
            [
                [['print(1)'], 'python', NotebookCellKind.Code, [], {}],
                [['test'], 'markdown', NotebookCellKind.Markup, [], {}],
                [['foo = 2', 'print(foo)'], 'python', NotebookCellKind.Code, [], {}],
            ],
            (notebookDocument: NotebookDocument, notebookAPI: IVSCodeNotebook) => {
                const inputDocument = mockTextDocument(Uri.parse(`${InteractiveInputScheme}://1.interactive`), 'python', ['print("bar")']);
                const concat = new InteractiveConcatTextDocument(notebookDocument, 'python', notebookAPI, inputDocument);
                assert.strictEqual(concat.lineCount, 4);
                assert.strictEqual(concat.languageId, 'python');
                assert.strictEqual(concat.getText(), ['print(1)', 'foo = 2', 'print(foo)', 'print("bar")'].join('\n'));
            }
        );
    });
});