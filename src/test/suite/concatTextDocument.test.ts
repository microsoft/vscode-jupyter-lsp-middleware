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

    test(`edits to a cell`, () => {
        withTestNotebook(
            Uri.from({ scheme: 'vscode-notebook', path: 'test.ipynb' }),
            [
                [['print(1)'], 'python', NotebookCellKind.Code, [], {}],
                [['test'], 'markdown', NotebookCellKind.Markup, [], {}],
                [['foo = 2', 'print(foo)'], 'python', NotebookCellKind.Code, [], {}]
            ],
            (notebookDocument: NotebookDocument) => {
                const concat = generateWrapper(notebookDocument);

                // Try insertion
                concat.handleChange({
                    document: notebookDocument.cellAt(2).document,
                    contentChanges: [
                        {
                            range: new Range(new Position(0, 0), new Position(0, 0)),
                            rangeOffset: 0,
                            rangeLength: 0,
                            text: 'bar'
                        }
                    ],
                    reason: undefined
                });

                assert.strictEqual(
                    concat.getText(),
                    ['import IPython', 'print(1)', 'barfoo = 2', 'print(foo)', ''].join('\n')
                );
                // Then deletion
                concat.handleChange({
                    document: notebookDocument.cellAt(2).document,
                    contentChanges: [
                        {
                            range: new Range(new Position(0, 3), new Position(0, 6)),
                            rangeOffset: 3,
                            rangeLength: 3,
                            text: ''
                        }
                    ],
                    reason: undefined
                });

                assert.strictEqual(
                    concat.getText(),
                    ['import IPython', 'print(1)', 'bar = 2', 'print(foo)', ''].join('\n')
                );

                // Then replace
                concat.handleChange({
                    document: notebookDocument.cellAt(2).document,
                    contentChanges: [
                        {
                            range: new Range(new Position(1, 6), new Position(1, 9)),
                            rangeOffset: 0,
                            rangeLength: 3,
                            text: 'bar'
                        }
                    ],
                    reason: undefined
                });

                assert.strictEqual(
                    concat.getText(),
                    ['import IPython', 'print(1)', 'bar = 2', 'print(bar)', ''].join('\n')
                );
            }
        );
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
                assert.strictEqual(
                    concat.getText(),
                    ['import IPython', 'print(1)', 'foo = 2', 'print(foo)', ''].join('\n')
                );
            }
        );
    });

    test('refresh (move) concat document for notebook', () => {
        withTestNotebook(
            Uri.from({ scheme: 'vscode-notebook', path: 'test.ipynb' }),
            [
                [['print(1)'], 'python', NotebookCellKind.Code, [], {}],
                [['test'], 'markdown', NotebookCellKind.Markup, [], {}],
                [['foo = 2', 'print(foo)'], 'python', NotebookCellKind.Code, [], {}]
            ],
            (notebookDocument: NotebookDocument) => {
                const concat = generateWrapper(notebookDocument);
                assert.strictEqual(
                    concat.getText(),
                    ['import IPython', 'print(1)', 'foo = 2', 'print(foo)', ''].join('\n')
                );
                const firstCell = notebookDocument.getCells()[0];
                const lastCell = notebookDocument.getCells()[2];
                notebookDocument.getCells().splice(0, 1, lastCell);
                notebookDocument.getCells().splice(2, 1, firstCell);
                concat.handleRefresh(notebookDocument);
                assert.strictEqual(
                    concat.getText(),
                    ['import IPython', 'foo = 2', 'print(foo)', 'print(1)', ''].join('\n')
                );
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
                    ['import IPython', 'print(1)', 'foo = 2', 'print(foo)', 'print("bar")', ''].join('\n')
                );
                assert.strictEqual(concat.getConcatDocument().lineAt(1).text, 'print(1)');
                assert.strictEqual(concat.getConcatDocument().lineAt(2).text, 'foo = 2');
                assert.strictEqual(concat.getConcatDocument().lineAt(3).text, 'print(foo)');
                assert.strictEqual(concat.getConcatDocument().lineAt(4).text, 'print("bar")');

                assert.strictEqual(
                    concat.notebookLocationAt(new Position(1, 0)).uri.toString(),
                    notebookDocument.getCells()[0].document.uri.toString()
                );
                assert.strictEqual(
                    concat.notebookLocationAt(new Position(2, 0)).uri.toString(),
                    notebookDocument.getCells()[2].document.uri.toString()
                );
                assert.strictEqual(
                    concat.notebookLocationAt(new Position(3, 0)).uri.toString(),
                    notebookDocument.getCells()[2].document.uri.toString()
                );
                assert.strictEqual(
                    concat.notebookLocationAt(new Position(4, 0)).uri.toString(),
                    inputDocument.uri.toString()
                );

                assert.deepStrictEqual(
                    concat.concatPositionAt(
                        new Location(notebookDocument.getCells()[0].document.uri, new Position(0, 0))
                    ),
                    new Position(1, 0)
                );
                assert.deepStrictEqual(
                    concat.concatPositionAt(
                        new Location(notebookDocument.getCells()[0].document.uri, new Position(0, 3))
                    ),
                    new Position(1, 3)
                );
                assert.deepStrictEqual(
                    concat.concatPositionAt(
                        new Location(notebookDocument.getCells()[2].document.uri, new Position(0, 0))
                    ),
                    new Position(2, 0)
                );
                assert.deepStrictEqual(
                    concat.concatPositionAt(
                        new Location(notebookDocument.getCells()[2].document.uri, new Position(0, 3))
                    ),
                    new Position(2, 3)
                );
                assert.deepStrictEqual(
                    concat.concatPositionAt(
                        new Location(notebookDocument.getCells()[2].document.uri, new Position(1, 0))
                    ),
                    new Position(3, 0)
                );
                assert.deepStrictEqual(
                    concat.concatPositionAt(
                        new Location(notebookDocument.getCells()[2].document.uri, new Position(1, 3))
                    ),
                    new Position(3, 3)
                );
                assert.deepStrictEqual(
                    concat.concatPositionAt(new Location(inputDocument.uri, new Position(0, 0))),
                    new Position(4, 0)
                );
                assert.deepStrictEqual(
                    concat.concatPositionAt(new Location(inputDocument.uri, new Position(0, 3))),
                    new Position(4, 3)
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
                    ['import IPython', 'print(1)', 'foo = 2', 'print(foo)', 'print("bar")', 'p.', ''].join('\n')
                );
                assert.strictEqual(concat.getConcatDocument().lineAt(0).text, 'import IPython');
                assert.strictEqual(concat.getConcatDocument().lineAt(1).text, 'print(1)');
                assert.strictEqual(concat.getConcatDocument().lineAt(2).text, 'foo = 2');
                assert.strictEqual(concat.getConcatDocument().lineAt(3).text, 'print(foo)');
                assert.strictEqual(concat.getConcatDocument().lineAt(4).text, 'print("bar")');
                assert.strictEqual(concat.getConcatDocument().lineAt(5).text, 'p.');

                assert.deepStrictEqual(concat.notebookLocationAt(new Position(5, 2)).range, new Range(1, 2, 1, 2));
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

                assert.deepStrictEqual(concat.notebookLocationAt(new Position(2, 2)).range, new Range(1, 2, 1, 2));
            }
        );
    });

    test('Cell with magics/shell escape/await', () => {
        withTestNotebook(
            Uri.from({ scheme: 'vscode-notebook', path: 'test.ipynb' }),
            [
                [['await print(1)'], 'python', NotebookCellKind.Code, [], {}],
                [['test'], 'markdown', NotebookCellKind.Markup, [], {}],
                [['%foo = 2', 'print(foo)'], 'python', NotebookCellKind.Code, [], {}],
                [['%%foo = 2', 'print(foo)'], 'python', NotebookCellKind.Code, [], {}],
                [['!foo = 2', 'print(foo)'], 'python', NotebookCellKind.Code, [], {}]
            ],
            (notebookDocument: NotebookDocument) => {
                const concat = generateWrapper(notebookDocument);
                assert.strictEqual(concat.getConcatDocument().lineCount, 8);
                assert.strictEqual(concat.getConcatDocument().languageId, 'python');
                assert.strictEqual(
                    concat.getText(),
                    [
                        'import IPython',
                        'await print(1) # type: ignore',
                        '%foo = 2 # type: ignore',
                        'print(foo)',
                        '%%foo = 2 # type: ignore',
                        'print(foo)',
                        '!foo = 2 # type: ignore',
                        'print(foo)',
                        ''
                    ].join('\n')
                );
            }
        );
    });

    test('Edit a magic/shell/await', () => {
        withTestNotebook(
            Uri.from({ scheme: 'vscode-notebook', path: 'test.ipynb' }),
            [
                [['await print(1)'], 'python', NotebookCellKind.Code, [], {}],
                [['test'], 'markdown', NotebookCellKind.Markup, [], {}],
                [['%foo = 2', 'print(foo)'], 'python', NotebookCellKind.Code, [], {}],
                [['%%foo = 2', 'print(foo)'], 'python', NotebookCellKind.Code, [], {}],
                [['!foo = 2', 'print(foo)'], 'python', NotebookCellKind.Code, [], {}]
            ],
            (notebookDocument: NotebookDocument) => {
                const concat = generateWrapper(notebookDocument);
                assert.strictEqual(concat.getConcatDocument().lineCount, 8);
                assert.strictEqual(concat.getConcatDocument().languageId, 'python');

                // Try insertion
                concat.handleChange({
                    document: notebookDocument.cellAt(2).document,
                    contentChanges: [
                        {
                            range: new Range(new Position(0, 0), new Position(0, 0)),
                            rangeOffset: 0,
                            rangeLength: 0,
                            text: 'bar'
                        }
                    ],
                    reason: undefined
                });

                assert.strictEqual(
                    concat.getText(),
                    [
                        'import IPython',
                        'await print(1) # type: ignore',
                        'bar%foo = 2',
                        'print(foo)',
                        '%%foo = 2 # type: ignore',
                        'print(foo)',
                        '!foo = 2 # type: ignore',
                        'print(foo)',
                        ''
                    ].join('\n')
                );

                // Then deletion
                concat.handleChange({
                    document: notebookDocument.cellAt(0).document,
                    contentChanges: [
                        {
                            range: new Range(new Position(0, 0), new Position(0, 1)),
                            rangeOffset: 0,
                            rangeLength: 0,
                            text: ''
                        }
                    ],
                    reason: undefined
                });

                assert.strictEqual(
                    concat.getText(),
                    [
                        'import IPython',
                        'wait print(1)',
                        'bar%foo = 2',
                        'print(foo)',
                        '%%foo = 2 # type: ignore',
                        'print(foo)',
                        '!foo = 2 # type: ignore',
                        'print(foo)',
                        ''
                    ].join('\n')
                );
                // Undo deletion
                concat.handleChange({
                    document: notebookDocument.cellAt(0).document,
                    contentChanges: [
                        {
                            range: new Range(new Position(0, 0), new Position(0, 0)),
                            rangeOffset: 0,
                            rangeLength: 0,
                            text: 'a'
                        }
                    ],
                    reason: undefined
                });

                assert.strictEqual(
                    concat.getText(),
                    [
                        'import IPython',
                        'await print(1) # type: ignore',
                        'bar%foo = 2',
                        'print(foo)',
                        '%%foo = 2 # type: ignore',
                        'print(foo)',
                        '!foo = 2 # type: ignore',
                        'print(foo)',
                        ''
                    ].join('\n')
                );
                // Insertion after
                concat.handleChange({
                    document: notebookDocument.cellAt(0).document,
                    contentChanges: [
                        {
                            range: new Range(new Position(0, 14), new Position(0, 14)),
                            rangeOffset: 0,
                            rangeLength: 0,
                            text: '\n'
                        }
                    ],
                    reason: undefined
                });

                assert.strictEqual(
                    concat.getText(),
                    [
                        'import IPython',
                        'await print(1) # type: ignore',
                        '',
                        'bar%foo = 2',
                        'print(foo)',
                        '%%foo = 2 # type: ignore',
                        'print(foo)',
                        '!foo = 2 # type: ignore',
                        'print(foo)',
                        ''
                    ].join('\n')
                );
                // Replace whole line
                concat.handleChange({
                    document: notebookDocument.cellAt(0).document,
                    contentChanges: [
                        {
                            range: new Range(new Position(0, 0), new Position(0, 14)),
                            rangeOffset: 0,
                            rangeLength: 0,
                            text: 'dude'
                        }
                    ],
                    reason: undefined
                });

                assert.strictEqual(
                    concat.getText(),
                    [
                        'import IPython',
                        'dude',
                        '',
                        'bar%foo = 2',
                        'print(foo)',
                        '%%foo = 2 # type: ignore',
                        'print(foo)',
                        '!foo = 2 # type: ignore',
                        'print(foo)',
                        ''
                    ].join('\n')
                );
            }
        );
    });
});
