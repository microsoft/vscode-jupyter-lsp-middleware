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
    DocumentSelector,
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
    TextDocumentChangeEvent,
    TextDocumentWillSaveEvent,
    TextEdit,
    Uri,
    WorkspaceEdit
} from 'vscode';
import {
    ConfigurationParams,
    ConfigurationRequest,
    DidChangeTextDocumentNotification,
    DidCloseTextDocumentNotification,
    DidOpenTextDocumentNotification,
    HandleDiagnosticsSignature,
    LanguageClient,
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
    ResponseError,
    SemanticTokensRangeParams,
    SemanticTokensRangeRequest
} from 'vscode-languageclient/node';

import { ProvideDeclarationSignature } from 'vscode-languageclient/lib/common/declaration';
import { IVSCodeNotebook } from './common/types';
import { isNotebookCell, isThenable } from './common/utils';
import { NotebookConverter } from './notebookConverter';
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

/**
 * This class is a temporary solution to handling intellisense and diagnostics in python based notebooks.
 *
 * It is responsible for generating a concatenated document of all of the cells in a notebook and using that as the
 * document for LSP requests.
 */
export class NotebookMiddlewareAddon implements Middleware, Disposable {
    private converter: NotebookConverter;
    private traceDisposable: Disposable | undefined;

    constructor(
        private readonly notebookApi: IVSCodeNotebook,
        private readonly getClient: () => LanguageClient | undefined,
        private readonly traceInfo: (...args: any[]) => void,
        cellSelector: string | DocumentSelector,
        notebookFileRegex: RegExp,
        private readonly pythonPath: string,
        private readonly isDocumentAllowed: (uri: Uri) => boolean
    ) {
        this.converter = new NotebookConverter(notebookApi, cellSelector, notebookFileRegex);

        // Make sure a bunch of functions are bound to this. VS code can call them without a this context
        this.handleDiagnostics = this.handleDiagnostics.bind(this);
        this.didOpen = this.didOpen.bind(this);
        this.didSave = this.didSave.bind(this);
        this.didChange = this.didChange.bind(this);
        this.didClose = this.didClose.bind(this);
        this.willSave = this.willSave.bind(this);
        this.willSaveWaitUntil = this.willSaveWaitUntil.bind(this);
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
                    settings[i].pythonPath = this.pythonPath;
                }
            }

            return settings;
        }
    };

    public dispose(): void {
        this.traceDisposable?.dispose();
        this.traceDisposable = undefined;
        this.converter.dispose();
    }

    public stopWatching(notebook: NotebookDocument): void {
        // Just close the document. This should cause diags and other things to be cleared
        const client = this.getClient();
        if (client && notebook.cellCount > 0) {
            const outgoing = this.converter.toOutgoingDocument(notebook.cellAt(0).document);
            const params = client.code2ProtocolConverter.asCloseTextDocumentParams(outgoing);
            client.sendNotification(DidCloseTextDocumentNotification.type, params);

            // Set the diagnostics to nothing for all the cells
            if (client.diagnostics) {
                notebook.getCells().forEach((c) => {
                    client.diagnostics?.set(c.document.uri, []);
                });
            }

            // Remove from tracking by the converter
            this.converter.remove(notebook.cellAt(0).document);
        }
    }

    public startWatching(notebook: NotebookDocument): void {
        // We need to talk directly to the language client here.
        const client = this.getClient();

        // Mimic a document open
        if (client && notebook.cellCount > 0) {
            this.didOpen(notebook.cellAt(0).document, (ev) => {
                const params = client.code2ProtocolConverter.asOpenTextDocumentParams(ev);
                client.sendNotification(DidOpenTextDocumentNotification.type, params);
            });
        }
    }

    public didChange(event: TextDocumentChangeEvent): void {
        // We need to talk directly to the language client here.
        const client = this.getClient();

        // If this is a notebook cell, change this into a concat document event
        if (isNotebookCell(event.document.uri) && client) {
            // Converter will change to the correct params
            const params = this.converter.handleChange(event);
            client.sendNotification(DidChangeTextDocumentNotification.type, params);
        }
    }

    public didOpen(document: TextDocument, next: (ev: TextDocument) => void): () => void {
        // Initialize tracing on the first document open
        this.initializeTracing();

        // We need to talk directly to the language client here.
        const client = this.getClient();

        // If this is a notebook cell, change this into a concat document if this is the first time.
        if (
            isNotebookCell(document.uri) &&
            this.isDocumentAllowed(document.uri) &&
            this.notebookApi.notebookDocuments.find((n) => n.uri.fsPath === document.uri.fsPath) &&
            client
        ) {
            const sentOpen = this.converter.isOpen(document);
            const params = this.converter.handleOpen(document);

            // If first time opening, just send the initial doc
            if (!sentOpen) {
                const newDoc = this.converter.toOutgoingDocument(document);
                next(newDoc);
            } else {
                // Otherwise send a change event
                client.sendNotification(DidChangeTextDocumentNotification.type, params);
            }
        }

        return () => {
            // Do nothing
        };
    }

    public didClose(document: TextDocument, next: (ev: TextDocument) => void): () => void {
        // We need to talk directly to the language client here.
        const client = this.getClient();

        // If this is a notebook cell, change this into a concat document if this is the first time.
        if (isNotebookCell(document.uri) && client) {
            const params = this.converter.handleClose(document);
            const isClosed = !this.converter.isOpen(document);
            if (isClosed) {
                // All cells deleted, send a close notification
                const newDoc = this.converter.toOutgoingDocument(document);
                next(newDoc);
            } else {
                // Otherwise we changed the document by deleting cells.
                client.sendNotification(DidChangeTextDocumentNotification.type, params);
            }
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
        if (this.shouldProvideIntellisense(document.uri)) {
            const newDoc = this.converter.toOutgoingDocument(document);
            const newPos = this.converter.toOutgoingPosition(document, position);
            const result = next(newDoc, newPos, context, token);
            if (isThenable(result)) {
                return result.then(this.converter.toIncomingCompletions.bind(this.converter, document));
            }
            return this.converter.toIncomingCompletions(document, result);
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
            const newDoc = this.converter.toOutgoingDocument(document);
            const newPos = this.converter.toOutgoingPosition(document, position);
            const result = next(newDoc, newPos, token);
            if (isThenable(result)) {
                return result.then(this.converter.toIncomingHover.bind(this.converter, document));
            }
            return this.converter.toIncomingHover(document, result);
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
            const newDoc = this.converter.toOutgoingDocument(document);
            const newPos = this.converter.toOutgoingPosition(document, position);
            return next(newDoc, newPos, context, token);
        }
    }

    public provideDefinition(
        document: TextDocument,
        position: Position,
        token: CancellationToken,
        next: ProvideDefinitionSignature
    ): ProviderResult<Definition | DefinitionLink[]> {
        if (this.shouldProvideIntellisense(document.uri)) {
            const newDoc = this.converter.toOutgoingDocument(document);
            const newPos = this.converter.toOutgoingPosition(document, position);
            const result = next(newDoc, newPos, token);
            if (isThenable(result)) {
                return result.then(this.converter.toIncomingLocations.bind(this.converter));
            }
            return this.converter.toIncomingLocations(result);
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
            const newDoc = this.converter.toOutgoingDocument(document);
            const newPos = this.converter.toOutgoingPosition(document, position);
            const result = next(newDoc, newPos, options, token);
            if (isThenable(result)) {
                return result.then(this.converter.toIncomingLocations.bind(this.converter));
            }
            return this.converter.toIncomingLocations(result);
        }
    }

    public provideDocumentHighlights(
        document: TextDocument,
        position: Position,
        token: CancellationToken,
        next: ProvideDocumentHighlightsSignature
    ): ProviderResult<DocumentHighlight[]> {
        if (this.shouldProvideIntellisense(document.uri)) {
            const newDoc = this.converter.toOutgoingDocument(document);
            const newPos = this.converter.toOutgoingPosition(document, position);
            const result = next(newDoc, newPos, token);
            if (isThenable(result)) {
                return result.then(this.converter.toIncomingHighlight.bind(this.converter, document));
            }
            return this.converter.toIncomingHighlight(document, result);
        }
    }

    public provideDocumentSymbols(
        document: TextDocument,
        token: CancellationToken,
        next: ProvideDocumentSymbolsSignature
    ): ProviderResult<SymbolInformation[] | DocumentSymbol[]> {
        if (this.shouldProvideIntellisense(document.uri)) {
            const newDoc = this.converter.toOutgoingDocument(document);
            const result = next(newDoc, token);
            if (isThenable(result)) {
                return result.then(this.converter.toIncomingSymbols.bind(this.converter, document));
            }
            return this.converter.toIncomingSymbols(document, result);
        }
    }

    public provideWorkspaceSymbols(
        query: string,
        token: CancellationToken,
        next: ProvideWorkspaceSymbolsSignature
    ): ProviderResult<SymbolInformation[]> {
        // Is this one possible to check?
        const result = next(query, token);
        if (isThenable(result)) {
            return result.then(this.converter.toIncomingWorkspaceSymbols.bind(this.converter));
        }
        return this.converter.toIncomingWorkspaceSymbols(result);
    }

    // eslint-disable-next-line class-methods-use-this
    public provideCodeActions(
        document: TextDocument,
        _range: Range,
        _context: CodeActionContext,
        _token: CancellationToken,
        _next: ProvideCodeActionsSignature
    ): ProviderResult<(Command | CodeAction)[]> {
        if (this.shouldProvideIntellisense(document.uri)) {
            this.traceInfo('provideCodeActions not currently supported for notebooks');
            return undefined;
        }
    }

    // eslint-disable-next-line class-methods-use-this
    public provideCodeLenses(
        document: TextDocument,
        _token: CancellationToken,
        _next: ProvideCodeLensesSignature
    ): ProviderResult<CodeLens[]> {
        if (this.shouldProvideIntellisense(document.uri)) {
            this.traceInfo('provideCodeLenses not currently supported for notebooks');
            return undefined;
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
        _options: FormattingOptions,
        _token: CancellationToken,
        _next: ProvideDocumentFormattingEditsSignature
    ): ProviderResult<TextEdit[]> {
        if (this.shouldProvideIntellisense(document.uri)) {
            this.traceInfo('provideDocumentFormattingEdits not currently supported for notebooks');
            return undefined;
        }
    }

    // eslint-disable-next-line class-methods-use-this
    public provideDocumentRangeFormattingEdits(
        document: TextDocument,
        _range: Range,
        _options: FormattingOptions,
        _token: CancellationToken,
        _next: ProvideDocumentRangeFormattingEditsSignature
    ): ProviderResult<TextEdit[]> {
        if (this.shouldProvideIntellisense(document.uri)) {
            this.traceInfo('provideDocumentRangeFormattingEdits not currently supported for notebooks');
            return undefined;
        }
    }

    // eslint-disable-next-line class-methods-use-this
    public provideOnTypeFormattingEdits(
        document: TextDocument,
        _position: Position,
        _ch: string,
        _options: FormattingOptions,
        _token: CancellationToken,
        _next: ProvideOnTypeFormattingEditsSignature
    ): ProviderResult<TextEdit[]> {
        if (this.shouldProvideIntellisense(document.uri)) {
            this.traceInfo('provideOnTypeFormattingEdits not currently supported for notebooks');
            return undefined;
        }
    }

    // eslint-disable-next-line class-methods-use-this
    public provideRenameEdits(
        document: TextDocument,
        _position: Position,
        _newName: string,
        _token: CancellationToken,
        _next: ProvideRenameEditsSignature
    ): ProviderResult<WorkspaceEdit> {
        if (this.shouldProvideIntellisense(document.uri)) {
            this.traceInfo('provideRenameEdits not currently supported for notebooks');
            return undefined;
        }
    }

    // eslint-disable-next-line class-methods-use-this
    public prepareRename(
        document: TextDocument,
        _position: Position,
        _token: CancellationToken,
        _next: PrepareRenameSignature
    ): ProviderResult<
        | Range
        | {
              range: Range;
              placeholder: string;
          }
    > {
        if (this.shouldProvideIntellisense(document.uri)) {
            this.traceInfo('prepareRename not currently supported for notebooks');
            return undefined;
        }
    }

    // eslint-disable-next-line class-methods-use-this
    public provideDocumentLinks(
        document: TextDocument,
        _token: CancellationToken,
        _next: ProvideDocumentLinksSignature
    ): ProviderResult<DocumentLink[]> {
        if (this.shouldProvideIntellisense(document.uri)) {
            this.traceInfo('provideDocumentLinks not currently supported for notebooks');
            return undefined;
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
        const incomingUri = this.converter.toIncomingUri(uri);
        if (incomingUri && incomingUri != uri && this.shouldProvideIntellisense(incomingUri)) {
            // Remap any wrapped documents so that diagnostics appear in the cells. Note that if we
            // get a diagnostics list for our concated document, we have to tell VS code about EVERY cell.
            // Otherwise old messages for cells that didn't change this time won't go away.
            const newDiagMapping = this.converter.toIncomingDiagnosticsMap(uri, diagnostics);
            [...newDiagMapping.keys()].forEach((k) => next(k, newDiagMapping.get(k)!));
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
            const newDoc = this.converter.toOutgoingDocument(document);
            const newPos = this.converter.toOutgoingPosition(document, position);
            const result = next(newDoc, newPos, token);
            if (isThenable(result)) {
                return result.then(this.converter.toIncomingLocations.bind(this.converter));
            }
            return this.converter.toIncomingLocations(result);
        }
    }

    public provideImplementation(
        document: TextDocument,
        position: VPosition,
        token: CancellationToken,
        next: ProvideImplementationSignature
    ): ProviderResult<Definition | DefinitionLink[]> {
        if (this.shouldProvideIntellisense(document.uri)) {
            const newDoc = this.converter.toOutgoingDocument(document);
            const newPos = this.converter.toOutgoingPosition(document, position);
            const result = next(newDoc, newPos, token);
            if (isThenable(result)) {
                return result.then(this.converter.toIncomingLocations.bind(this.converter));
            }
            return this.converter.toIncomingLocations(result);
        }
    }

    public provideDocumentColors(
        document: TextDocument,
        token: CancellationToken,
        next: ProvideDocumentColorsSignature
    ): ProviderResult<ColorInformation[]> {
        if (this.shouldProvideIntellisense(document.uri)) {
            const newDoc = this.converter.toOutgoingDocument(document);
            const result = next(newDoc, token);
            if (isThenable(result)) {
                return result.then(this.converter.toIncomingColorInformations.bind(this.converter, document.uri));
            }
            return this.converter.toIncomingColorInformations(document.uri, result);
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
            const newDoc = this.converter.toOutgoingDocument(context.document);
            const newRange = this.converter.toOutgoingRange(context.document, context.range);
            const result = next(color, { document: newDoc, range: newRange }, token);
            if (isThenable(result)) {
                return result.then(
                    this.converter.toIncomingColorPresentations.bind(this.converter, context.document.uri)
                );
            }
            return this.converter.toIncomingColorPresentations(context.document.uri, result);
        }
    }

    public provideFoldingRanges(
        document: TextDocument,
        context: FoldingContext,
        token: CancellationToken,
        next: ProvideFoldingRangeSignature
    ): ProviderResult<FoldingRange[]> {
        if (this.shouldProvideIntellisense(document.uri)) {
            const newDoc = this.converter.toOutgoingDocument(document);
            const result = next(newDoc, context, token);
            if (isThenable(result)) {
                return result.then(this.converter.toIncomingFoldingRanges.bind(this.converter, document.uri));
            }
            return this.converter.toIncomingFoldingRanges(document.uri, result);
        }
    }

    public provideDeclaration(
        document: TextDocument,
        position: Position,
        token: CancellationToken,
        next: ProvideDeclarationSignature
    ): ProviderResult<Declaration> {
        if (this.shouldProvideIntellisense(document.uri)) {
            const newDoc = this.converter.toOutgoingDocument(document);
            const newPos = this.converter.toOutgoingPosition(document, position);
            const result = next(newDoc, newPos, token);
            if (isThenable(result)) {
                return result.then(this.converter.toIncomingLocations.bind(this.converter));
            }
            return this.converter.toIncomingLocations(result);
        }
    }

    public provideSelectionRanges(
        document: TextDocument,
        positions: Position[],
        token: CancellationToken,
        next: ProvideSelectionRangeSignature
    ): ProviderResult<SelectionRange[]> {
        if (this.shouldProvideIntellisense(document.uri)) {
            const newDoc = this.converter.toOutgoingDocument(document);
            const newPositions = this.converter.toOutgoingPositions(document, positions);
            const result = next(newDoc, newPositions, token);
            if (isThenable(result)) {
                return result.then(this.converter.toIncomingSelectionRanges.bind(this.converter, document.uri));
            }
            return this.converter.toIncomingSelectionRanges(document.uri, result);
        }
    }

    public prepareCallHierarchy(
        document: TextDocument,
        positions: Position,
        token: CancellationToken,
        next: PrepareCallHierarchySignature
    ): ProviderResult<CallHierarchyItem | CallHierarchyItem[]> {
        if (this.shouldProvideIntellisense(document.uri)) {
            const newDoc = this.converter.toOutgoingDocument(document);
            const newPositions = this.converter.toOutgoingPosition(document, positions);
            const result = next(newDoc, newPositions, token);
            if (isThenable(result)) {
                return result.then(this.converter.toIncomingCallHierarchyItems.bind(this.converter, document.uri));
            }
            return this.converter.toIncomingCallHierarchyItems(document.uri, result);
        }
    }
    public provideCallHierarchyIncomingCalls(
        item: CallHierarchyItem,
        token: CancellationToken,
        next: CallHierarchyIncomingCallsSignature
    ): ProviderResult<CallHierarchyIncomingCall[]> {
        if (this.shouldProvideIntellisense(item.uri)) {
            const newUri = this.converter.toOutgoingUri(item.uri);
            const newRange = this.converter.toOutgoingRange(item.uri, item.range);
            const result = next({ ...item, uri: newUri, range: newRange }, token);
            if (isThenable(result)) {
                return result.then(
                    this.converter.toIncomingCallHierarchyIncomingCallItems.bind(this.converter, item.uri)
                );
            }
            return this.converter.toIncomingCallHierarchyIncomingCallItems(item.uri, result);
        }
    }
    public provideCallHierarchyOutgoingCalls(
        item: CallHierarchyItem,
        token: CancellationToken,
        next: CallHierarchyOutgoingCallsSignature
    ): ProviderResult<CallHierarchyOutgoingCall[]> {
        if (this.shouldProvideIntellisense(item.uri)) {
            const newUri = this.converter.toOutgoingUri(item.uri);
            const newRange = this.converter.toOutgoingRange(item.uri, item.range);
            const result = next({ ...item, uri: newUri, range: newRange }, token);
            if (isThenable(result)) {
                return result.then(
                    this.converter.toIncomingCallHierarchyOutgoingCallItems.bind(this.converter, item.uri)
                );
            }
            return this.converter.toIncomingCallHierarchyOutgoingCallItems(item.uri, result);
        }
    }

    public provideDocumentSemanticTokens(
        document: TextDocument,
        token: CancellationToken,
        _next: DocumentSemanticsTokensSignature
    ): ProviderResult<SemanticTokens> {
        const client = this.getClient();
        if (this.shouldProvideIntellisense(document.uri) && client) {
            const newDoc = this.converter.toOutgoingDocument(document);

            // Since tokens are for a cell, we need to change the request for a range and not the entire document.
            const newRange = this.converter.toOutgoingRange(document.uri, undefined);

            const params: SemanticTokensRangeParams = {
                textDocument: client.code2ProtocolConverter.asTextDocumentIdentifier(newDoc),
                range: client.code2ProtocolConverter.asRange(newRange)
            };

            // Make the request directly (dont use the 'next' value)
            const result = client.sendRequest(SemanticTokensRangeRequest.type, params, token);

            // Then convert from protocol back to vscode types
            return result.then((r) => {
                const vscodeTokens = client.protocol2CodeConverter.asSemanticTokens(r);
                return this.converter.toIncomingSemanticTokens(document.uri, vscodeTokens);
            });
        }
    }
    public provideDocumentSemanticTokensEdits(
        document: TextDocument,
        _previousResultId: string,
        token: CancellationToken,
        _next: DocumentSemanticsTokensEditsSignature
    ): ProviderResult<SemanticTokensEdits | SemanticTokens> {
        // Token edits work with previous token response. However pylance
        // doesn't know about the cell so it sends back ALL tokens.
        // Instead just ask for a range.
        const client = this.getClient();
        if (this.shouldProvideIntellisense(document.uri) && client) {
            const newDoc = this.converter.toOutgoingDocument(document);

            // Since tokens are for a cell, we need to change the request for a range and not the entire document.
            const newRange = this.converter.toOutgoingRange(document.uri, undefined);

            const params: SemanticTokensRangeParams = {
                textDocument: client.code2ProtocolConverter.asTextDocumentIdentifier(newDoc),
                range: client.code2ProtocolConverter.asRange(newRange)
            };

            // Make the request directly (dont use the 'next' value)
            const result = client.sendRequest(SemanticTokensRangeRequest.type, params, token);

            // Then convert from protocol back to vscode types
            return result.then((r) => {
                const vscodeTokens = client.protocol2CodeConverter.asSemanticTokens(r);
                return this.converter.toIncomingSemanticTokens(document.uri, vscodeTokens);
            });
        }
    }
    public provideDocumentRangeSemanticTokens(
        document: TextDocument,
        range: Range,
        token: CancellationToken,
        next: DocumentRangeSemanticTokensSignature
    ): ProviderResult<SemanticTokens> {
        if (this.shouldProvideIntellisense(document.uri)) {
            const newDoc = this.converter.toOutgoingDocument(document);
            const newRange = this.converter.toOutgoingRange(document, range);
            const result = next(newDoc, newRange, token);
            if (isThenable(result)) {
                return result.then(this.converter.toIncomingSemanticTokens.bind(this.converter, document.uri));
            }
            return this.converter.toIncomingSemanticTokens(document.uri, result);
        }
    }

    public provideLinkedEditingRange(
        document: TextDocument,
        position: Position,
        token: CancellationToken,
        next: ProvideLinkedEditingRangeSignature
    ): ProviderResult<LinkedEditingRanges> {
        if (this.shouldProvideIntellisense(document.uri)) {
            const newDoc = this.converter.toOutgoingDocument(document);
            const newPosition = this.converter.toOutgoingPosition(document, position);
            const result = next(newDoc, newPosition, token);
            if (isThenable(result)) {
                return result.then(this.converter.toIncomingLinkedEditingRanges.bind(this.converter, document.uri));
            }
            return this.converter.toIncomingLinkedEditingRanges(document.uri, result);
        }
    }

    private initializeTracing() {
        if (!this.traceDisposable && this.traceInfo) {
            const client = this.getClient();
            if (client) {
                this.traceDisposable = client.onNotification('window/logMessage', this.traceInfo);
            }
        }
    }

    private shouldProvideIntellisense(uri: Uri): boolean {
        // Make sure document is allowed
        return this.isDocumentAllowed(uri);
    }
}
