import * as vscode from 'vscode';
import { score } from '../dist/concatTextDocument';
import { NotebookConcatDocument } from './notebookConcatDocument';

/**
 * Wrapper around a notebook document that can provide a concatDocument for the notebook.
 */
export class NotebookWrapper implements vscode.Disposable {
    public firedOpen = false;
    public isComposeDocumentsAllClosed = false;
    public concatDocument: NotebookConcatDocument;
    constructor(
        public notebook: vscode.NotebookDocument,
        private readonly selector: vscode.DocumentSelector,
        public readonly key: string
    ) {
        // Create our concat document and inform it of all of the current cells that match the selector
        this.concatDocument = new NotebookConcatDocument();
        this.notebook.getCells().forEach((c) => {
            if (score(c.document, selector)) {
                this.concatDocument.handleOpen({
                    uri: c.document.uri.toString(),
                    text: c.document.getText(),
                    languageId: c.document.languageId,
                    version: c.document.version
                });
            }
        });
    }
    public dispose() {
        this.concatDocument.dispose();
    }
    public getComposeDocuments() {
        return this.notebook
            .getCells()
            .filter((c) => score(c.document, this.selector) > 0)
            .map((c) => c.document);
    }
    public getTextDocumentAtPosition(position: vscode.Position): vscode.TextDocument | undefined {
        const location = this.concatDocument.locationAt(position);
        return this.getComposeDocuments().find((c) => c.uri === location.uri);
    }
}
