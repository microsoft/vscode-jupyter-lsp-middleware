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
    Diagnostic,
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
    TextEdit,
    Uri,
    WorkspaceEdit
} from 'vscode';
import {
    HandleDiagnosticsSignature,
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
    ResolveCompletionItemSignature} from 'vscode-languageclient/node';

import { ProvideDeclarationSignature } from 'vscode-languageclient/lib/common/declaration';
import { isNotebookCell } from './common/utils';

/**
 * This class is used to hide all intellisense requests for notebook cells.
 */
export class HidingMiddlewareAddon implements Middleware, Disposable {
    constructor() {
        // Make sure a bunch of functions are bound to this. VS code can call them without a this context
        this.handleDiagnostics = this.handleDiagnostics.bind(this);
    }
    
    public dispose(): void {
        // Nothing to dispose at the moment
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
        // Range should have already been remapped.

        // TODO: What if the LS needs to read the range? It won't make sense. This might mean
        // doing this at the extension level is not possible.
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

    public handleDiagnostics(uri: Uri, diagnostics: Diagnostic[], next: HandleDiagnosticsSignature): void {
        if (isNotebookCell(uri)) {
            // Swallow all diagnostics for cells
            next(uri, []);
        } else {
            next(uri, diagnostics);
        }
    }
}
