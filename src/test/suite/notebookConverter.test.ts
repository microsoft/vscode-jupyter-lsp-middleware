// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import { assert } from 'chai';
import {
    notebooks,
    Uri,
    NotebookCellKind,
    EventEmitter,
    NotebookConcatTextDocument,
    NotebookDocument,
    DocumentSelector,
    Event,
    Range,
    DocumentHighlight
} from 'vscode';
import { IVSCodeNotebook } from '../../common/types';
import { NotebookConverter } from '../../notebookConverter';
import { withTestNotebook } from './helper';

suite('Notebook Converter', function () {
    let converter: NotebookConverter | undefined;

    teardown(async function () {
        converter?.dispose();
    });

    test('toIncomingHighlight', async () => {
        withTestNotebook(
            Uri.parse('test:///toIncomingHighlight.ipynb'),
            [
                [['first one.'], 'python', NotebookCellKind.Code, [], {}],
                [['second one.'], 'python', NotebookCellKind.Code, [], {}],
                [['third one.'], 'python', NotebookCellKind.Code, [], {}]
            ],
            (notebookDocument: NotebookDocument, _notebookAPI: IVSCodeNotebook) => {
                const notebookApi: IVSCodeNotebook = new (class implements IVSCodeNotebook {
                    notebookDocuments: readonly NotebookDocument[] = [notebookDocument];
                    onDidOpenNotebookDocument: Event<NotebookDocument> = new EventEmitter<NotebookDocument>().event;
                    onDidCloseNotebookDocument: Event<NotebookDocument> = new EventEmitter<NotebookDocument>().event;
                    createConcatTextDocument(
                        notebook: NotebookDocument,
                        selector?: DocumentSelector
                    ): NotebookConcatTextDocument {
                        return notebooks.createConcatTextDocument(notebook, selector);
                    }
                })();

                converter = new NotebookConverter(notebookApi, 'python', /.*\.(ipynb|interactive)/m);

                const allHighlights: DocumentHighlight[] = [
                    // assume every occurence of "one" has been highlighted
                    new DocumentHighlight(new Range(0, 6, 0, 9)),
                    new DocumentHighlight(new Range(1, 7, 1, 10)),
                    new DocumentHighlight(new Range(2, 6, 2, 9))
                ];

                // ask for second cell and ensure only its results are returned
                const cell = notebookDocument.cellAt(1);
                const result = converter.toIncomingHighlight(cell.document, allHighlights)!;
                assert.ok(result);
                assert.strictEqual(result.length, 1);
                assert.ok(result[0].range.isEqual(new Range(0, 7, 0, 10)));
            }
        );
    });
});
