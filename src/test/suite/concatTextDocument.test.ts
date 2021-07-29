/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { score } from '../../concatTextDocument';
import { mockTextDocument, withTestNotebook } from './helper';
import { Location, NotebookCellKind, NotebookDocument, Position, Uri, Range } from 'vscode';
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

    test('concat document for interactive window', () => {
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
                assert.strictEqual(concat.lineAt(0).text, 'print(1)');
                assert.strictEqual(concat.lineAt(1).text, 'foo = 2');
                assert.strictEqual(concat.lineAt(2).text, 'print(foo)');
                assert.strictEqual(concat.lineAt(3).text, 'print("bar")');

                assert.strictEqual(concat.locationAt(new Position(0, 0)).uri, notebookDocument.getCells()[0].document.uri);
                assert.strictEqual(concat.locationAt(new Position(1, 0)).uri, notebookDocument.getCells()[2].document.uri);
                assert.strictEqual(concat.locationAt(new Position(2, 0)).uri, notebookDocument.getCells()[2].document.uri);
                assert.strictEqual(concat.locationAt(new Position(3, 0)).uri, inputDocument.uri);

                assert.deepStrictEqual(concat.positionAt(new Location(notebookDocument.getCells()[0].document.uri, new Position(0, 0))), new Position(0, 0));
                assert.deepStrictEqual(concat.positionAt(new Location(notebookDocument.getCells()[0].document.uri, new Position(0, 3))), new Position(0, 3));
                assert.deepStrictEqual(concat.positionAt(new Location(notebookDocument.getCells()[2].document.uri, new Position(0, 0))), new Position(1, 0));
                assert.deepStrictEqual(concat.positionAt(new Location(notebookDocument.getCells()[2].document.uri, new Position(0, 3))), new Position(1, 3));
                assert.deepStrictEqual(concat.positionAt(new Location(notebookDocument.getCells()[2].document.uri, new Position(1, 0))), new Position(2, 0));
                assert.deepStrictEqual(concat.positionAt(new Location(notebookDocument.getCells()[2].document.uri, new Position(1, 3))), new Position(2, 3));
                assert.deepStrictEqual(concat.positionAt(new Location(inputDocument.uri, new Position(0, 0))), new Position(3, 0));
                assert.deepStrictEqual(concat.positionAt(new Location(inputDocument.uri, new Position(0, 3))), new Position(3, 3));
            }
            
        );
    });

    test('concat document for interactive window 2', () => {
        withTestNotebook(
            Uri.parse('test://test.ipynb'),
            [
                [['print(1)'], 'python', NotebookCellKind.Code, [], {}],
                [['test'], 'markdown', NotebookCellKind.Markup, [], {}],
                [['foo = 2', 'print(foo)'], 'python', NotebookCellKind.Code, [], {}],
            ],
            (notebookDocument: NotebookDocument, notebookAPI: IVSCodeNotebook) => {
                const inputDocument = mockTextDocument(Uri.parse(`${InteractiveInputScheme}://1.interactive`), 'python', ['print("bar")', 'p.']);
                const concat = new InteractiveConcatTextDocument(notebookDocument, 'python', notebookAPI, inputDocument);
                assert.strictEqual(concat.lineCount, 5);
                assert.strictEqual(concat.languageId, 'python');
                assert.strictEqual(concat.getText(), ['print(1)', 'foo = 2', 'print(foo)', 'print("bar")', 'p.'].join('\n'));
                assert.strictEqual(concat.lineAt(0).text, 'print(1)');
                assert.strictEqual(concat.lineAt(1).text, 'foo = 2');
                assert.strictEqual(concat.lineAt(2).text, 'print(foo)');
                assert.strictEqual(concat.lineAt(3).text, 'print("bar")');
                assert.strictEqual(concat.lineAt(4).text, 'p.');

                assert.deepStrictEqual(concat.locationAt(new Position(4, 2)).range, new Range(1, 2, 1, 2));
            }
            
        );
    });
});