/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import * as path from 'path';
import { generateWrapper, InteractiveScheme, mockTextDocument, withTestNotebook } from './helper';
import { Location, NotebookCellKind, NotebookDocument, Position, Uri, Range, DocumentFilter } from 'vscode';
import { InteractiveInputScheme, score } from '../../common/utils';

suite('concatTextDocument', () => {
    test('score', () => {
        assert.strictEqual(score(mockTextDocument(Uri.file('test.ipynb'), 'python', []), '*'), 5);
        assert.strictEqual(score(mockTextDocument(Uri.file('test.ipynb'), 'python', []), 'python'), 10);
        assert.strictEqual(score(mockTextDocument(Uri.file('test.ipynb'), 'markdown', []), 'python'), 0);
        let filter: DocumentFilter = {
            pattern: `${path.sep}test.ipynb`
        };
        assert.strictEqual(score(mockTextDocument(Uri.file('test.ipynb'), 'python', []), filter), 10);
        const longer = path.sep === '\\' ? 'c:\\users\\test\\foo.ipynb' : '/home/users/test/foo.ipynb';
        filter = {
            pattern: longer
        };
        assert.strictEqual(score(mockTextDocument(Uri.file(longer), 'python', []), filter), 10);
    });

    test('concat document for notebook', () => {
        withTestNotebook(
            Uri.from({ scheme: 'vscode-notebook', path: 'test.ipynb' }),
            [
                [['print(1)'], 'python', NotebookCellKind.Code, [], {}],
                [['test'], 'markdown', NotebookCellKind.Markup, [], {}],
                [['foo = 2', 'print(foo)'], 'python', NotebookCellKind.Code, [], {}]
            ],
            (notebookDocument: NotebookDocument) => {
                const concat = generateWrapper(notebookDocument);
                assert.strictEqual(concat.getConcatDocument().lineCount, 4);
                assert.strictEqual(concat.getConcatDocument().languageId, 'python');
                assert.strictEqual(concat.getText(), ['print(1)', 'foo = 2', 'print(foo)', ''].join('\n'));
            }
        );
    });

    test('concat document for interactive window', () => {
        withTestNotebook(
            Uri.from({ scheme: InteractiveScheme, path: 'test.ipynb' }),
            [
                [['print(1)'], 'python', NotebookCellKind.Code, [], {}],
                [['test'], 'markdown', NotebookCellKind.Markup, [], {}],
                [['foo = 2', 'print(foo)'], 'python', NotebookCellKind.Code, [], {}]
            ],
            (notebookDocument: NotebookDocument) => {
                const inputDocument = mockTextDocument(
                    Uri.from({ scheme: InteractiveInputScheme, path: '1.interactive' }),
                    'python',
                    ['print("bar")']
                );
                const concat = generateWrapper(notebookDocument, [inputDocument]);
                assert.strictEqual(concat.getConcatDocument().lineCount, 5);
                assert.strictEqual(concat.getConcatDocument().languageId, 'python');
                assert.strictEqual(
                    concat.getText(),
                    ['print(1)', 'foo = 2', 'print(foo)', 'print("bar")', ''].join('\n')
                );
                assert.strictEqual(concat.getConcatDocument().lineAt(0).text, 'print(1)');
                assert.strictEqual(concat.getConcatDocument().lineAt(1).text, 'foo = 2');
                assert.strictEqual(concat.getConcatDocument().lineAt(2).text, 'print(foo)');
                assert.strictEqual(concat.getConcatDocument().lineAt(3).text, 'print("bar")');

                assert.strictEqual(
                    concat.locationAt(new Position(0, 0)).uri.toString(),
                    notebookDocument.getCells()[0].document.uri.toString()
                );
                assert.strictEqual(
                    concat.locationAt(new Position(1, 0)).uri.toString(),
                    notebookDocument.getCells()[2].document.uri.toString()
                );
                assert.strictEqual(
                    concat.locationAt(new Position(2, 0)).uri.toString(),
                    notebookDocument.getCells()[2].document.uri.toString()
                );
                assert.strictEqual(concat.locationAt(new Position(3, 0)).uri.toString(), inputDocument.uri.toString());

                assert.deepStrictEqual(
                    concat.positionAt(new Location(notebookDocument.getCells()[0].document.uri, new Position(0, 0))),
                    new Position(0, 0)
                );
                assert.deepStrictEqual(
                    concat.positionAt(new Location(notebookDocument.getCells()[0].document.uri, new Position(0, 3))),
                    new Position(0, 3)
                );
                assert.deepStrictEqual(
                    concat.positionAt(new Location(notebookDocument.getCells()[2].document.uri, new Position(0, 0))),
                    new Position(1, 0)
                );
                assert.deepStrictEqual(
                    concat.positionAt(new Location(notebookDocument.getCells()[2].document.uri, new Position(0, 3))),
                    new Position(1, 3)
                );
                assert.deepStrictEqual(
                    concat.positionAt(new Location(notebookDocument.getCells()[2].document.uri, new Position(1, 0))),
                    new Position(2, 0)
                );
                assert.deepStrictEqual(
                    concat.positionAt(new Location(notebookDocument.getCells()[2].document.uri, new Position(1, 3))),
                    new Position(2, 3)
                );
                assert.deepStrictEqual(
                    concat.positionAt(new Location(inputDocument.uri, new Position(0, 0))),
                    new Position(3, 0)
                );
                assert.deepStrictEqual(
                    concat.positionAt(new Location(inputDocument.uri, new Position(0, 3))),
                    new Position(3, 3)
                );
            }
        );
    });

    test('concat document for interactive window 2', () => {
        withTestNotebook(
            Uri.from({ scheme: InteractiveScheme, path: 'test.ipynb' }),
            [
                [['print(1)'], 'python', NotebookCellKind.Code, [], {}],
                [['test'], 'markdown', NotebookCellKind.Markup, [], {}],
                [['foo = 2', 'print(foo)'], 'python', NotebookCellKind.Code, [], {}]
            ],
            (notebookDocument: NotebookDocument) => {
                const inputDocument = mockTextDocument(
                    Uri.from({ scheme: InteractiveInputScheme, path: '1.interactive' }),
                    'python',
                    ['print("bar")', 'p.']
                );
                const concat = generateWrapper(notebookDocument, [inputDocument]);
                assert.strictEqual(concat.getConcatDocument().lineCount, 6);
                assert.strictEqual(concat.getConcatDocument().languageId, 'python');
                assert.strictEqual(
                    concat.getText(),
                    ['print(1)', 'foo = 2', 'print(foo)', 'print("bar")', 'p.', ''].join('\n')
                );
                assert.strictEqual(concat.getConcatDocument().lineAt(0).text, 'print(1)');
                assert.strictEqual(concat.getConcatDocument().lineAt(1).text, 'foo = 2');
                assert.strictEqual(concat.getConcatDocument().lineAt(2).text, 'print(foo)');
                assert.strictEqual(concat.getConcatDocument().lineAt(3).text, 'print("bar")');
                assert.strictEqual(concat.getConcatDocument().lineAt(4).text, 'p.');

                assert.deepStrictEqual(concat.locationAt(new Position(4, 2)).range, new Range(1, 2, 1, 2));
            }
        );
    });

    test('concat document for interactive window, empty history', () => {
        withTestNotebook(
            Uri.from({ scheme: InteractiveScheme, path: 'test.ipynb' }),
            [],
            (notebookDocument: NotebookDocument) => {
                const inputDocument = mockTextDocument(
                    Uri.from({ scheme: InteractiveInputScheme, path: '1.interactive' }),
                    'python',
                    ['print("bar")', 'p.']
                );
                const concat = generateWrapper(notebookDocument, [inputDocument]);
                assert.strictEqual(concat.getConcatDocument().lineCount, 3);
                // assert.strictEqual(concat.languageId, 'python');
                // assert.strictEqual(concat.getText(), ['print(1)', 'foo = 2', 'print(foo)', 'print("bar")', 'p.'].join('\n'));
                // assert.strictEqual(concat.lineAt(0).text, 'print(1)');
                // assert.strictEqual(concat.lineAt(1).text, 'foo = 2');
                // assert.strictEqual(concat.lineAt(2).text, 'print(foo)');
                // assert.strictEqual(concat.lineAt(3).text, 'print("bar")');
                // assert.strictEqual(concat.lineAt(4).text, 'p.');

                assert.deepStrictEqual(concat.locationAt(new Position(1, 2)).range, new Range(1, 2, 1, 2));
            }
        );
    });
});
