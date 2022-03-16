// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
import {
    CallHierarchyIncomingCall,
    CallHierarchyItem,
    CallHierarchyOutgoingCall,
    CancellationToken,
    CodeAction,
    CodeActionContext,
    CodeLens,
    Color,
    ColorInformation,
    ColorPresentation,
    Command,
    CompletionContext,
    CompletionItem,
    Declaration,
    Definition,
    DefinitionLink,
    Diagnostic,
    Disposable,
    DocumentHighlight,
    DocumentLink,
    DocumentSymbol,
    FoldingContext,
    FoldingRange,
    FormattingOptions,
    LinkedEditingRanges,
    Location,
    NotebookDocument,
    Position,
    Position as VPosition,
    ProviderResult,
    Range,
    SelectionRange,
    SemanticTokens,
    SemanticTokensEdits,
    SignatureHelp,
    SignatureHelpContext,
    SymbolInformation,
    TextDocument,
    TextEdit,
    Uri,
    WorkspaceEdit
} from 'vscode';
import {
    ConfigurationParams,
    ConfigurationRequest,
    DidCloseTextDocumentNotification,
    DidOpenTextDocumentNotification,
    DidOpenTextDocumentParams,
    DocumentSelector,
    HandleDiagnosticsSignature,
    LanguageClient,
    LSPObject,
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
    ResolveDocumentLinkSignature,
    ResponseError
} from 'vscode-languageclient/node';

import { ProvideDeclarationSignature } from 'vscode-languageclient/lib/common/declaration';
import { isThenable } from '../common/utils';
import { ProvideTypeDefinitionSignature } from 'vscode-languageclient/lib/common/typeDefinition';
import { ProvideImplementationSignature } from 'vscode-languageclient/lib/common/implementation';
import {
    ProvideDocumentColorsSignature,
    ProvideColorPresentationSignature
} from 'vscode-languageclient/lib/common/colorProvider';
import { ProvideFoldingRangeSignature } from 'vscode-languageclient/lib/common/foldingRange';
import { ProvideSelectionRangeSignature } from 'vscode-languageclient/lib/common/selectionRange';
import {
    PrepareCallHierarchySignature,
    CallHierarchyIncomingCallsSignature,
    CallHierarchyOutgoingCallsSignature
} from 'vscode-languageclient/lib/common/callHierarchy';
import {
    DocumentRangeSemanticTokensSignature,
    DocumentSemanticsTokensEditsSignature,
    DocumentSemanticsTokensSignature
} from 'vscode-languageclient/lib/common/semanticTokens';
import { ProvideLinkedEditingRangeSignature } from 'vscode-languageclient/lib/common/linkedEditingRange';
import { score } from '../common/vscodeUtils';
import type * as concat from '@vscode/lsp-notebook-concat/dist/types';

/**
 * This class is a temporary solution to handling intellisense and diagnostics in python based notebooks.
 *
 * It is responsible for sending requests to pylance if they are allowed.
 */
export class PylanceMiddlewareAddon implements Middleware, Disposable {
    constructor(
        private readonly getClient: () => LanguageClient | undefined,
        private readonly selector: string | DocumentSelector,
        private readonly pythonPath: string,
        private readonly isDocumentAllowed: (uri: Uri) => boolean,
        private readonly getNotebookHeader: (uri: Uri) => string
    ) {
        // Make sure a bunch of functions are bound to this. VS code can call them without a this context
        this.handleDiagnostics = this.handleDiagnostics.bind(this);
        this.didOpen = this.didOpen.bind(this);
        this.didClose = this.didClose.bind(this);
    }

    public workspace = {
        configuration: async (
            params: ConfigurationParams,
            token: CancellationToken,
            next: ConfigurationRequest.HandlerSignature
        ) => {
            // Handle workspace/configuration requests.
            let settings = next(params, token);
            if (isThenable(settings)) {
                settings = await settings;
            }
            if (settings instanceof ResponseError) {
                return settings;
            }

            for (const [i, item] of params.items.entries()) {
                if (item.section === 'python') {
                    (settings[i] as any).pythonPath = this.pythonPath;

                    // Always disable indexing on notebook. User can't use
                    // auto import on notebook anyway.
                    ((settings[i] as any).analysis as LSPObject).indexing = false;

                    (settings[i] as any).notebookHeader = this.getNotebookHeader(
                        item.scopeUri ? Uri.parse(item.scopeUri) : Uri.parse('')
                    );
                }
            }

            return settings;
        }
    };

    public dispose(): void {
        // Nothing to dispose at the moment
    }

    public stopWatching(notebook: NotebookDocument): void {
        // Close all of the cells. This should cause diags and other things to be cleared
        const client = this.getClient();
        if (client && notebook.cellCount > 0) {
            notebook.getCells().forEach((c) => {
                const params = client.code2ProtocolConverter.asCloseTextDocumentParams(c.document);
                client.sendNotification(DidCloseTextDocumentNotification.type, params);
            });

            // Set the diagnostics to nothing for all the cells
            if (client.diagnostics) {
                notebook.getCells().forEach((c) => {
                    client.diagnostics?.set(c.document.uri, []);
                });
            }
        }
    }

    public startWatching(notebook: NotebookDocument): void {
        // We need to talk directly to the language client here.
        const client = this.getClient();

        // Mimic a document open for all cells
        if (client && notebook.cellCount > 0) {
            notebook.getCells().forEach((c) => {
                this.didOpen(c.document, (ev) => {
                    const params = client.code2ProtocolConverter.asOpenTextDocumentParams(ev);
                    client.sendNotification(DidOpenTextDocumentNotification.type, params);
                });
            });
        }
    }

    public async didOpen(document: TextDocument, next: (ev: TextDocument) => void) {
        if (this.shouldProvideIntellisense(document.uri)) {
            await next(document);
        }
    }

    public async didClose(document: TextDocument, next: (ev: TextDocument) => void) {
        if (this.shouldProvideIntellisense(document.uri)) {
            await next(document);
        }
    }

    public refresh(notebook: NotebookDocument) {
        // Turn this into the custom message instead.
        const client = this.getClient();
        if (client) {
            const cells: DidOpenTextDocumentParams[] = notebook
                .getCells()
                .filter((c) => score(c.document, this.selector))
                .map((c) => {
                    return {
                        textDocument: {
                            uri: c.document.uri.toString(),
                            version: c.document.version,
                            languageId: c.document.languageId,
                            text: c.document.getText()
                        }
                    };
                });
            const params: concat.RefreshNotebookEvent = {
                cells
            };
            client.sendNotification('notebook/refresh', params);
        }
    }

    // eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
    public provideCompletionItem(
        document: TextDocument,
        position: Position,
        context: CompletionContext,
        token: CancellationToken,
        next: ProvideCompletionItemsSignature
    ) {
        if (this.shouldProvideIntellisense(document.uri)) {
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
        if (this.shouldProvideIntellisense(document.uri)) {
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
        if (this.shouldProvideIntellisense(document.uri)) {
            return next(document, position, context, token);
        }
    }

    public provideDefinition(
        document: TextDocument,
        position: Position,
        token: CancellationToken,
        next: ProvideDefinitionSignature
    ): ProviderResult<Definition | DefinitionLink[]> {
        if (this.shouldProvideIntellisense(document.uri)) {
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
        if (this.shouldProvideIntellisense(document.uri)) {
            return next(document, position, options, token);
        }
    }

    public provideDocumentHighlights(
        document: TextDocument,
        position: Position,
        token: CancellationToken,
        next: ProvideDocumentHighlightsSignature
    ): ProviderResult<DocumentHighlight[]> {
        if (this.shouldProvideIntellisense(document.uri)) {
            return next(document, position, token);
        }
    }

    public provideDocumentSymbols(
        document: TextDocument,
        token: CancellationToken,
        next: ProvideDocumentSymbolsSignature
    ): ProviderResult<SymbolInformation[] | DocumentSymbol[]> {
        if (this.shouldProvideIntellisense(document.uri)) {
            return next(document, token);
        }
    }

    public provideWorkspaceSymbols(
        query: string,
        token: CancellationToken,
        next: ProvideWorkspaceSymbolsSignature
    ): ProviderResult<SymbolInformation[]> {
        // Is this one possible to check?
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
        if (this.shouldProvideIntellisense(document.uri)) {
            return next(document, range, context, token);
        }
    }

    // eslint-disable-next-line class-methods-use-this
    public provideCodeLenses(
        document: TextDocument,
        token: CancellationToken,
        next: ProvideCodeLensesSignature
    ): ProviderResult<CodeLens[]> {
        if (this.shouldProvideIntellisense(document.uri)) {
            return next(document, token);
        }
    }

    // eslint-disable-next-line class-methods-use-this
    public resolveCodeLens(
        codeLens: CodeLens,
        token: CancellationToken,
        next: ResolveCodeLensSignature
    ): ProviderResult<CodeLens> {
        // Range should have already been remapped.

        // TODO: What if the LS needs to read the range? It won't make sense. This might mean
        // doing this at the extension level is not possible.
        return next(codeLens, token);
    }

    // eslint-disable-next-line class-methods-use-this
    public provideDocumentFormattingEdits(
        document: TextDocument,
        options: FormattingOptions,
        token: CancellationToken,
        next: ProvideDocumentFormattingEditsSignature
    ): ProviderResult<TextEdit[]> {
        if (this.shouldProvideIntellisense(document.uri)) {
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
        if (this.shouldProvideIntellisense(document.uri)) {
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
        if (this.shouldProvideIntellisense(document.uri)) {
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
        if (this.shouldProvideIntellisense(document.uri)) {
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
        if (this.shouldProvideIntellisense(document.uri)) {
            return next(document, position, token);
        }
    }

    // eslint-disable-next-line class-methods-use-this
    public provideDocumentLinks(
        document: TextDocument,
        token: CancellationToken,
        next: ProvideDocumentLinksSignature
    ): ProviderResult<DocumentLink[]> {
        if (this.shouldProvideIntellisense(document.uri)) {
            return next(document, token);
        }
    }

    // eslint-disable-next-line class-methods-use-this
    public resolveDocumentLink(
        link: DocumentLink,
        token: CancellationToken,
        next: ResolveDocumentLinkSignature
    ): ProviderResult<DocumentLink> {
        // Range should have already been remapped.

        // TODO: What if the LS needs to read the range? It won't make sense. This might mean
        // doing this at the extension level is not possible.
        return next(link, token);
    }

    public handleDiagnostics(uri: Uri, diagnostics: Diagnostic[], next: HandleDiagnosticsSignature): void {
        if (this.shouldProvideIntellisense(uri)) {
            return next(uri, diagnostics);
        } else {
            // Swallow all other diagnostics
            next(uri, []);
        }
    }

    public provideTypeDefinition(
        document: TextDocument,
        position: Position,
        token: CancellationToken,
        next: ProvideTypeDefinitionSignature
    ) {
        if (this.shouldProvideIntellisense(document.uri)) {
            return next(document, position, token);
        }
    }

    public provideImplementation(
        document: TextDocument,
        position: VPosition,
        token: CancellationToken,
        next: ProvideImplementationSignature
    ): ProviderResult<Definition | DefinitionLink[]> {
        if (this.shouldProvideIntellisense(document.uri)) {
            return next(document, position, token);
        }
    }

    public provideDocumentColors(
        document: TextDocument,
        token: CancellationToken,
        next: ProvideDocumentColorsSignature
    ): ProviderResult<ColorInformation[]> {
        if (this.shouldProvideIntellisense(document.uri)) {
            return next(document, token);
        }
    }
    public provideColorPresentations(
        color: Color,
        context: {
            document: TextDocument;
            range: Range;
        },
        token: CancellationToken,
        next: ProvideColorPresentationSignature
    ): ProviderResult<ColorPresentation[]> {
        if (this.shouldProvideIntellisense(context.document.uri)) {
            return next(color, context, token);
        }
    }

    public provideFoldingRanges(
        document: TextDocument,
        context: FoldingContext,
        token: CancellationToken,
        next: ProvideFoldingRangeSignature
    ): ProviderResult<FoldingRange[]> {
        if (this.shouldProvideIntellisense(document.uri)) {
            return next(document, context, token);
        }
    }

    public provideDeclaration(
        document: TextDocument,
        position: Position,
        token: CancellationToken,
        next: ProvideDeclarationSignature
    ): ProviderResult<Declaration> {
        if (this.shouldProvideIntellisense(document.uri)) {
            return next(document, position, token);
        }
    }

    public provideSelectionRanges(
        document: TextDocument,
        positions: Position[],
        token: CancellationToken,
        next: ProvideSelectionRangeSignature
    ): ProviderResult<SelectionRange[]> {
        if (this.shouldProvideIntellisense(document.uri)) {
            return next(document, positions, token);
        }
    }

    public prepareCallHierarchy(
        document: TextDocument,
        positions: Position,
        token: CancellationToken,
        next: PrepareCallHierarchySignature
    ): ProviderResult<CallHierarchyItem | CallHierarchyItem[]> {
        if (this.shouldProvideIntellisense(document.uri)) {
            return next(document, positions, token);
        }
    }
    public provideCallHierarchyIncomingCalls(
        item: CallHierarchyItem,
        token: CancellationToken,
        next: CallHierarchyIncomingCallsSignature
    ): ProviderResult<CallHierarchyIncomingCall[]> {
        if (this.shouldProvideIntellisense(item.uri)) {
            return next(item, token);
        }
    }
    public provideCallHierarchyOutgoingCalls(
        item: CallHierarchyItem,
        token: CancellationToken,
        next: CallHierarchyOutgoingCallsSignature
    ): ProviderResult<CallHierarchyOutgoingCall[]> {
        if (this.shouldProvideIntellisense(item.uri)) {
            return next(item, token);
        }
    }

    public provideDocumentSemanticTokens(
        document: TextDocument,
        token: CancellationToken,
        next: DocumentSemanticsTokensSignature
    ): ProviderResult<SemanticTokens> {
        if (this.shouldProvideIntellisense(document.uri)) {
            return next(document, token);
        }
    }
    public provideDocumentSemanticTokensEdits(
        document: TextDocument,
        previousResultId: string,
        token: CancellationToken,
        next: DocumentSemanticsTokensEditsSignature
    ): ProviderResult<SemanticTokensEdits | SemanticTokens> {
        if (this.shouldProvideIntellisense(document.uri)) {
            return next(document, previousResultId, token);
        }
    }
    public provideDocumentRangeSemanticTokens(
        document: TextDocument,
        range: Range,
        token: CancellationToken,
        next: DocumentRangeSemanticTokensSignature
    ): ProviderResult<SemanticTokens> {
        if (this.shouldProvideIntellisense(document.uri)) {
            return next(document, range, token);
        }
    }

    public provideLinkedEditingRange(
        document: TextDocument,
        position: Position,
        token: CancellationToken,
        next: ProvideLinkedEditingRangeSignature
    ): ProviderResult<LinkedEditingRanges> {
        if (this.shouldProvideIntellisense(document.uri)) {
            return next(document, position, token);
        }
    }

    private shouldProvideIntellisense(uri: Uri): boolean {
        // Make sure document is allowed
        return this.isDocumentAllowed(uri);
    }
}
