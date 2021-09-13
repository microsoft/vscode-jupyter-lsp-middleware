// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
import {
    CancellationToken,
    CodeAction,
    CodeActionContext,
    CodeLens,
    Command,
    CompletionContext,
    CompletionItem,
    Declaration as VDeclaration,
    Definition,
    DefinitionLink,
    Disposable,
    DocumentHighlight,
    DocumentLink,
    DocumentSymbol,
    FormattingOptions,
    Location,
    Position,
    Position as VPosition,
    ProviderResult,
    Range,
    SignatureHelp,
    SignatureHelpContext,
    SymbolInformation,
    TextDocument,
    TextDocumentChangeEvent,
    TextDocumentWillSaveEvent,
    TextEdit,
    WorkspaceEdit
} from 'vscode';
import {
    Middleware,
    PrepareRenameSignature,
    ProvideCodeActionsSignature,
    ProvideCodeLensesSignature,
    ProvideCompletionItemsSignature,
    ProvideDefinitionSignature,
    ProvideDocumentFormattingEditsSignature,
    ProvideDocumentHighlightsSignature,
    ProvideDocumentLinksSignature,
    ProvideDocumentRangeFormattingEditsSignature,
    ProvideDocumentSymbolsSignature,
    ProvideHoverSignature,
    ProvideOnTypeFormattingEditsSignature,
    ProvideReferencesSignature,
    ProvideRenameEditsSignature,
    ProvideSignatureHelpSignature,
    ProvideWorkspaceSymbolsSignature,
    ResolveCodeLensSignature,
    ResolveCompletionItemSignature,
    ResolveDocumentLinkSignature
} from 'vscode-languageclient/node';

import { ProvideDeclarationSignature } from 'vscode-languageclient/lib/common/declaration';
import { isNotebookCell } from './common/utils';
/**
 * This class is a temporary solution to handling intellisense and diagnostics in python based notebooks.
 *
 * It is responsible for consuming all intellisense operations for python notebook cells
 */
export class ConsumingMiddlewareAddon implements Middleware, Disposable {
    constructor() {
        // Make sure a bunch of functions are bound to this. VS code can call them without a this context
        this.didOpen = this.didOpen.bind(this);
        this.didSave = this.didSave.bind(this);
        this.didChange = this.didChange.bind(this);
        this.didClose = this.didClose.bind(this);
        this.willSave = this.willSave.bind(this);
        this.willSaveWaitUntil = this.willSaveWaitUntil.bind(this);
    }

    public dispose(): void {}

    public didChange(event: TextDocumentChangeEvent, next: (ev: TextDocumentChangeEvent) => void): void {
        if (!isNotebookCell(event.document.uri)) {
            next(event);
        }
    }

    public didOpen(document: TextDocument, next: (ev: TextDocument) => void): () => void {
        if (!isNotebookCell(document.uri)) {
            next(document);
        }

        return () => {
            // Do nothing
        };
    }

    public didClose(document: TextDocument, next: (ev: TextDocument) => void): () => void {
        if (!isNotebookCell(document.uri)) {
            next(document);
        }

        return () => {
            // Do nothing
        };
    }

    // eslint-disable-next-line class-methods-use-this
    public didSave(event: TextDocument, next: (ev: TextDocument) => void): void {
        return next(event);
    }

    // eslint-disable-next-line class-methods-use-this
    public willSave(event: TextDocumentWillSaveEvent, next: (ev: TextDocumentWillSaveEvent) => void): void {
        return next(event);
    }

    // eslint-disable-next-line class-methods-use-this
    public willSaveWaitUntil(
        event: TextDocumentWillSaveEvent,
        next: (ev: TextDocumentWillSaveEvent) => Thenable<TextEdit[]>
    ): Thenable<TextEdit[]> {
        return next(event);
    }

    // eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
    public provideCompletionItem(
        document: TextDocument,
        position: Position,
        context: CompletionContext,
        token: CancellationToken,
        next: ProvideCompletionItemsSignature
    ) {
        if (!isNotebookCell(document.uri)) {
            return next(document, position, context, token);
        }
    }

    // eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
    public provideHover(
        document: TextDocument,
        position: Position,
        token: CancellationToken,
        next: ProvideHoverSignature
    ) {
        if (!isNotebookCell(document.uri)) {
            return next(document, position, token);
        }
    }

    // eslint-disable-next-line class-methods-use-this
    public resolveCompletionItem(
        item: CompletionItem,
        token: CancellationToken,
        next: ResolveCompletionItemSignature
    ): ProviderResult<CompletionItem> {
        return next(item, token);
    }

    public provideSignatureHelp(
        document: TextDocument,
        position: Position,
        context: SignatureHelpContext,
        token: CancellationToken,
        next: ProvideSignatureHelpSignature
    ): ProviderResult<SignatureHelp> {
        if (!isNotebookCell(document.uri)) {
            return next(document, position, context, token);
        }
    }

    public provideDefinition(
        document: TextDocument,
        position: Position,
        token: CancellationToken,
        next: ProvideDefinitionSignature
    ): ProviderResult<Definition | DefinitionLink[]> {
        if (!isNotebookCell(document.uri)) {
            return next(document, position, token);
        }
    }

    public provideReferences(
        document: TextDocument,
        position: Position,
        options: {
            includeDeclaration: boolean;
        },
        token: CancellationToken,
        next: ProvideReferencesSignature
    ): ProviderResult<Location[]> {
        if (!isNotebookCell(document.uri)) {
            return next(document, position, options, token);
        }
    }

    public provideDocumentHighlights(
        document: TextDocument,
        position: Position,
        token: CancellationToken,
        next: ProvideDocumentHighlightsSignature
    ): ProviderResult<DocumentHighlight[]> {
        if (!isNotebookCell(document.uri)) {
            return next(document, position, token);
        }
    }

    public provideDocumentSymbols(
        document: TextDocument,
        token: CancellationToken,
        next: ProvideDocumentSymbolsSignature
    ): ProviderResult<SymbolInformation[] | DocumentSymbol[]> {
        if (!isNotebookCell(document.uri)) {
            return next(document, token);
        }
    }

    public provideWorkspaceSymbols(
        query: string,
        token: CancellationToken,
        next: ProvideWorkspaceSymbolsSignature
    ): ProviderResult<SymbolInformation[]> {
        return next(query, token);
    }

    // eslint-disable-next-line class-methods-use-this
    public provideCodeActions(
        document: TextDocument,
        range: Range,
        context: CodeActionContext,
        token: CancellationToken,
        next: ProvideCodeActionsSignature
    ): ProviderResult<(Command | CodeAction)[]> {
        if (!isNotebookCell(document.uri)) {
            return next(document, range, context, token);
        }
    }

    // eslint-disable-next-line class-methods-use-this
    public provideCodeLenses(
        document: TextDocument,
        token: CancellationToken,
        next: ProvideCodeLensesSignature
    ): ProviderResult<CodeLens[]> {
        if (!isNotebookCell(document.uri)) {
            return next(document, token);
        }
    }

    // eslint-disable-next-line class-methods-use-this
    public resolveCodeLens(
        codeLens: CodeLens,
        token: CancellationToken,
        next: ResolveCodeLensSignature
    ): ProviderResult<CodeLens> {
        return next(codeLens, token);
    }

    // eslint-disable-next-line class-methods-use-this
    public provideDocumentFormattingEdits(
        document: TextDocument,
        options: FormattingOptions,
        token: CancellationToken,
        next: ProvideDocumentFormattingEditsSignature
    ): ProviderResult<TextEdit[]> {
        if (!isNotebookCell(document.uri)) {
            return next(document, options, token);
        }
    }

    // eslint-disable-next-line class-methods-use-this
    public provideDocumentRangeFormattingEdits(
        document: TextDocument,
        range: Range,
        options: FormattingOptions,
        token: CancellationToken,
        next: ProvideDocumentRangeFormattingEditsSignature
    ): ProviderResult<TextEdit[]> {
        if (!isNotebookCell(document.uri)) {
            return next(document, range, options, token);
        }
    }

    // eslint-disable-next-line class-methods-use-this
    public provideOnTypeFormattingEdits(
        document: TextDocument,
        position: Position,
        ch: string,
        options: FormattingOptions,
        token: CancellationToken,
        next: ProvideOnTypeFormattingEditsSignature
    ): ProviderResult<TextEdit[]> {
        if (!isNotebookCell(document.uri)) {
            return next(document, position, ch, options, token);
        }
    }

    // eslint-disable-next-line class-methods-use-this
    public provideRenameEdits(
        document: TextDocument,
        position: Position,
        newName: string,
        token: CancellationToken,
        next: ProvideRenameEditsSignature
    ): ProviderResult<WorkspaceEdit> {
        if (!isNotebookCell(document.uri)) {
            return next(document, position, newName, token);
        }
    }

    // eslint-disable-next-line class-methods-use-this
    public prepareRename(
        document: TextDocument,
        position: Position,
        token: CancellationToken,
        next: PrepareRenameSignature
    ): ProviderResult<
        | Range
        | {
              range: Range;
              placeholder: string;
          }
    > {
        if (!isNotebookCell(document.uri)) {
            return next(document, position, token);
        }
    }

    // eslint-disable-next-line class-methods-use-this
    public provideDocumentLinks(
        document: TextDocument,
        token: CancellationToken,
        next: ProvideDocumentLinksSignature
    ): ProviderResult<DocumentLink[]> {
        if (!isNotebookCell(document.uri)) {
            return next(document, token);
        }
    }

    // eslint-disable-next-line class-methods-use-this
    public resolveDocumentLink(
        link: DocumentLink,
        token: CancellationToken,
        next: ResolveDocumentLinkSignature
    ): ProviderResult<DocumentLink> {
        return next(link, token);
    }

    // eslint-disable-next-line class-methods-use-this
    public provideDeclaration(
        document: TextDocument,
        position: VPosition,
        token: CancellationToken,
        next: ProvideDeclarationSignature
    ): ProviderResult<VDeclaration> {
        if (!isNotebookCell(document.uri)) {
            return next(document, position, token);
        }
    }
}
