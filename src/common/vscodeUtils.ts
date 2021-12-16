// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import { DocumentSelector, languages, TextDocument, NotebookDocument } from 'vscode';
import { RefreshNotebookEvent } from './types';

export function score(document: TextDocument, selector: DocumentSelector): number {
    return languages.match(selector, document);
}

export function asRefreshEvent(notebook: NotebookDocument, selector: DocumentSelector): RefreshNotebookEvent {
    return {
        cells: notebook
            .getCells()
            .filter((c) => score(c.document, selector) > 0)
            .map((c) => {
                return {
                    textDocument: {
                        uri: c.document.uri.toString(),
                        text: c.document.getText(),
                        languageId: c.document.languageId,
                        version: c.document.version
                    }
                };
            })
    };
}
