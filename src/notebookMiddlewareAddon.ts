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
    DocumentSelector,
    DocumentSymbol,
    FormattingOptions,
    Location,
    NotebookDocument,
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
    ResponseError
} from 'vscode-languageclient/node';

import { ProvideDeclarationSignature } from 'vscode-languageclient/lib/common/declaration';
import { IVSCodeNotebook } from './common/types';
import { isNotebookCell, isThenable } from './common/utils';
import { NotebookConverter } from './notebookConverter';

/**
 * This class is a temporary solution to handling intellisense and diagnostics in python based notebooks.
 *
 * It is responsible for generating a concatenated document of all of the cells in a notebook and using that as the
 * document for LSP requests.
 */
export class NotebookMiddlewareAddon implements Middleware, Disposable {
    private converter: NotebookConverter;

    private didChangeCellsDisposable: Disposable;
    private traceDisposable: Disposable | undefined;

    constructor(
        notebookApi: IVSCodeNotebook,
        private readonly getClient: () => LanguageClient | undefined,
        private readonly traceInfo: (...args: any[]) => void,
        cellSelector: string | DocumentSelector,
        notebookFileRegex: RegExp,
        private readonly pythonPath: string,
        private readonly shouldProvideIntellisense: (uri: Uri) => boolean
    ) {
        this.converter = new NotebookConverter(notebookApi, cellSelector, notebookFileRegex);
        this.didChangeCellsDisposable = this.converter.onDidChangeCells(this.onDidChangeCells.bind(this));

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
        this.didChangeCellsDisposable.dispose();
        this.converter.dispose();
    }

    public stopWatching(notebook: NotebookDocument): void {
        // Just close the document. This should cause diags and other things to be cleared
        const client = this.getClient();
        if (client && notebook.cellCount > 0) {
            const outgoing = this.converter.toOutgoingDocument(notebook.cellAt(0).document);
            const params = client.code2ProtocolConverter.asCloseTextDocumentParams(outgoing);
            client.sendNotification(DidCloseTextDocumentNotification.type, params);

            // Internally do not track anymore
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
            })
        }
    }

    public didChange(event: TextDocumentChangeEvent): void {
        // We need to talk directly to the language client here.
        const client = this.getClient();

        // If this is a notebook cell, change this into a concat document event
        if (isNotebookCell(event.document.uri) && client) {
            const newEvent = this.converter.toOutgoingChangeEvent(event);

            // Next will not use our params here. We need to send directly as next with the event
            // doesn't let the event change the value
            const params = client.code2ProtocolConverter.asChangeTextDocumentParams(newEvent);
            client.sendNotification(DidChangeTextDocumentNotification.type, params);
        }
    }

    public didOpen(document: TextDocument, next: (ev: TextDocument) => void): () => void {
        // Initialize tracing on the first document open
        this.initializeTracing();

        // If this is a notebook cell, change this into a concat document if this is the first time.
        if (isNotebookCell(document.uri)) {
            if (!this.converter.hasFiredOpen(document)) {
                this.converter.firedOpen(document);
                const newDoc = this.converter.toOutgoingDocument(document);
                next(newDoc);
            }
        }

        return () => {
            // Do nothing
        };
    }

    public didClose(document: TextDocument, next: (ev: TextDocument) => void): () => void {
        // If this is a notebook cell, change this into a concat document if this is the first time.
        if (isNotebookCell(document.uri)) {
            const newDoc = this.converter.firedClose(document);
            if (newDoc) {
                // Cell delete causes this callback, but won't fire the close event because it's not
                // in the document anymore.
                next(newDoc);
            }

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

    // eslint-disable-next-line class-methods-use-this
    public provideDeclaration(
        document: TextDocument,
        _position: VPosition,
        _token: CancellationToken,
        _next: ProvideDeclarationSignature
    ): ProviderResult<VDeclaration> {
        if (this.shouldProvideIntellisense(document.uri)) {
            this.traceInfo('provideDeclaration not currently supported for notebooks');
            return undefined;
        }
    }

    public handleDiagnostics(uri: Uri, diagnostics: Diagnostic[], next: HandleDiagnosticsSignature): void {
        const incomingUri = this.converter.toIncomingUri(uri);
        if (incomingUri && this.shouldProvideIntellisense(incomingUri)) {
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

    private onDidChangeCells(e: TextDocumentChangeEvent) {
        // This event fires when the user moves, deletes, or inserts cells into the concatenated document
        // Since this doesn't fire a change event (since a document wasn't changed), we have to make one ourselves.

        // Note: The event should already be setup to be an outgoing event. It's from the point of view of the concatenated document.
        const client = this.getClient();
        if (client) {
            const params = client.code2ProtocolConverter.asChangeTextDocumentParams(e);
            client.sendNotification(DidChangeTextDocumentNotification.type, params);
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
}
