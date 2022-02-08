// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
import * as vscode from 'vscode';
import * as protocol from 'vscode-languageclient';
import * as protocolNode from 'vscode-languageclient/node';
import * as os from 'os';

import { ProvideDeclarationSignature } from 'vscode-languageclient/lib/common/declaration';
import { isInteractiveCell, isNotebookCell, isThenable } from '../common/utils';
import * as concat from '@vscode/lsp-notebook-concat';
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
import { asRefreshEvent, score } from '../common/vscodeUtils';
import type { NotebookConverter } from '@vscode/lsp-notebook-concat/dist/notebookConverter';

/**
 * This class is a temporary solution to handling intellisense and diagnostics in python based notebooks.
 *
 * It is responsible for generating a concatenated document of all of the cells in a notebook and using that as the
 * document for LSP requests.
 */
export class NotebookMiddlewareAddon implements protocol.Middleware, vscode.Disposable {
    private converter: NotebookConverter;
    private disposables: vscode.Disposable[] = [];

    constructor(
        private readonly getClient: () => protocolNode.LanguageClient | undefined,
        private readonly traceInfo: (...args: any[]) => void,
        private cellSelector: string | vscode.DocumentSelector,
        private readonly pythonPath: string,
        private readonly isDocumentAllowed: (uri: vscode.Uri) => boolean,
        getNotebookHeader: (uri: vscode.Uri) => string
    ) {
        this.converter = concat.createConverter(getNotebookHeader, () => os.platform());

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
            params: protocol.ConfigurationParams,
            token: vscode.CancellationToken,
            next: protocol.ConfigurationRequest.HandlerSignature
        ) => {
            // Handle workspace/configuration requests.
            let settings = next(params, token);
            if (isThenable(settings)) {
                settings = await settings;
            }
            if (settings instanceof protocol.ResponseError) {
                return settings;
            }

            for (const [i, item] of params.items.entries()) {
                if (item.section === 'python') {
                    settings[i].pythonPath = this.pythonPath;

                    // Always disable indexing on notebook. User can't use
                    // auto import on notebook anyway.
                    settings[i].analysis.indexing = false;
                }
            }

            return settings;
        }
    };

    public dispose(): void {
        this.disposables.forEach((d) => d.dispose());
        this.disposables = [];
        this.converter.dispose();
    }

    public refresh(notebook: vscode.NotebookDocument) {
        const client = this.getClient();

        // Turn this into a change notification
        if (client && notebook.cellCount > 0) {
            const documentItem = this.asTextDocumentIdentifier(notebook.cellAt(0).document);
            // Make sure still open.
            const isOpen = this.converter.isOpen(documentItem);
            if (isOpen) {
                // Send this to our converter and then the change notification to the server
                const params = this.converter.handleRefresh(asRefreshEvent(notebook, this.cellSelector));
                if (params) {
                    client.sendNotification(protocol.DidChangeTextDocumentNotification.type, params);
                }
            }
        }
    }

    public stopWatching(notebook: vscode.NotebookDocument): void {
        // Just close the document. This should cause diags and other things to be cleared
        const client = this.getClient();
        if (client && notebook.cellCount > 0) {
            const documentItem = this.asTextDocumentIdentifier(notebook.cellAt(0).document);
            const outgoing = this.converter.toConcatDocument(documentItem);
            const params: protocol.DidCloseTextDocumentParams = {
                textDocument: outgoing
            };
            client.sendNotification(protocol.DidCloseTextDocumentNotification.type, params);

            // Set the diagnostics to nothing for all the cells
            if (client.diagnostics) {
                notebook.getCells().forEach((c) => {
                    client.diagnostics?.set(c.document.uri, []);
                });
            }

            // Remove from tracking by the converter
            notebook.getCells().forEach((c) => {
                this.converter.handleClose({ textDocument: { uri: c.document.uri.toString() } });
            });
        }
    }

    public startWatching(notebook: vscode.NotebookDocument): void {
        // We need to talk directly to the language client here.
        const client = this.getClient();

        // Mimic a document open for all cells
        if (client && notebook.cellCount > 0) {
            notebook.getCells().forEach((c) => {
                this.didOpen(c.document, (ev) => {
                    const params = client.code2ProtocolConverter.asOpenTextDocumentParams(ev);
                    client.sendNotification(protocol.DidOpenTextDocumentNotification.type, params);
                });
            });
        }
    }

    public didChange(event: vscode.TextDocumentChangeEvent): void {
        // We need to talk directly to the language client here.
        const client = this.getClient();

        // If this is a notebook cell, change this into a concat document event
        if (isNotebookCell(event.document.uri) && client && score(event.document, this.cellSelector)) {
            const documentItem = this.asTextDocumentIdentifier(event.document);
            const sentOpen = this.converter.isOpen(documentItem);
            const params = this.converter.handleChange(client.code2ProtocolConverter.asChangeTextDocumentParams(event));
            if (!sentOpen) {
                // First time opening, send an open instead
                const newDoc = this.converter.toConcatDocument(documentItem);
                const params: protocol.DidOpenTextDocumentParams = {
                    textDocument: newDoc
                };
                client.sendNotification(protocol.DidOpenTextDocumentNotification.type, params);
            } else if (params) {
                client.sendNotification(protocol.DidChangeTextDocumentNotification.type, params);
            }
        }
    }

    public didOpen(document: vscode.TextDocument, _next: (ev: vscode.TextDocument) => void): () => void {
        // We need to talk directly to the language client here.
        const client = this.getClient();

        // If this is a notebook cell, change this into a concat document if this is the first time.
        if (
            isNotebookCell(document.uri) &&
            this.isDocumentAllowed(document.uri) &&
            client &&
            score(document, this.cellSelector)
        ) {
            const documentId = this.asTextDocumentIdentifier(document);
            const documentItem = this.asTextDocumentItem(document);
            const sentOpen = this.converter.isOpen(documentId);
            const params = this.converter.handleOpen({ textDocument: documentItem });

            // If first time opening, just send the initial doc
            if (!sentOpen) {
                const newDoc = this.converter.toConcatDocument(documentId);
                client.sendNotification(protocol.DidOpenTextDocumentNotification.type, { textDocument: newDoc });
            } else if (params) {
                // Otherwise send a change event
                client.sendNotification(protocol.DidChangeTextDocumentNotification.type, params);
            }
        }

        return () => {
            // Do nothing
        };
    }

    public didClose(document: vscode.TextDocument, _next: (ev: vscode.TextDocument) => void): () => void {
        // We need to talk directly to the language client here.
        const client = this.getClient();

        // If this is a notebook cell, change this into a concat document if this is the first time.
        if (isNotebookCell(document.uri) && client && score(document, this.cellSelector)) {
            // Track if this is the message that closes the whole thing.
            const documentItem = this.asTextDocumentItem(document);
            const wasOpen = this.converter.isOpen(documentItem);
            const params = this.converter.handleClose({ textDocument: documentItem });
            const isClosed = !this.converter.isOpen(documentItem);
            if (isClosed && wasOpen) {
                // All cells deleted, send a close notification
                const newDoc = this.converter.toConcatDocument(documentItem);
                client.sendNotification(protocol.DidCloseTextDocumentNotification.type, { textDocument: newDoc });
            } else if (!isClosed && params) {
                // Otherwise we changed the document by deleting cells.
                client.sendNotification(protocol.DidChangeTextDocumentNotification.type, params);
            }
        }
        return () => {
            // Do nothing
        };
    }

    // eslint-disable-next-line class-methods-use-this
    public didSave(event: vscode.TextDocument, next: (ev: vscode.TextDocument) => void): void {
        return next(event);
    }

    // eslint-disable-next-line class-methods-use-this
    public willSave(
        event: vscode.TextDocumentWillSaveEvent,
        next: (ev: vscode.TextDocumentWillSaveEvent) => void
    ): void {
        return next(event);
    }

    // eslint-disable-next-line class-methods-use-this
    public willSaveWaitUntil(
        event: vscode.TextDocumentWillSaveEvent,
        next: (ev: vscode.TextDocumentWillSaveEvent) => Thenable<vscode.TextEdit[]>
    ): Thenable<vscode.TextEdit[]> {
        return next(event);
    }

    // eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
    public async provideCompletionItem(
        document: vscode.TextDocument,
        position: vscode.Position,
        context: vscode.CompletionContext,
        token: vscode.CancellationToken,
        _next: protocol.ProvideCompletionItemsSignature
    ) {
        const client = this.getClient();
        if (this.shouldProvideIntellisense(document.uri) && client) {
            const documentId = this.asTextDocumentIdentifier(document);
            const newDoc = this.converter.toConcatDocument(documentId);
            const newPos = this.converter.toConcatPosition(documentId, position);
            const convertedParams = client.code2ProtocolConverter.asCompletionParams(document, position, context);
            const params: protocol.CompletionParams = {
                textDocument: newDoc,
                position: newPos,
                context: convertedParams.context
            };
            const result = await client.sendRequest(protocolNode.CompletionRequest.type, params, token);
            const notebookResults = this.converter.toNotebookCompletions(documentId, result);
            return client.protocol2CodeConverter.asCompletionResult(notebookResults);
        }
    }

    // eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
    public async provideHover(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken,
        _next: protocol.ProvideHoverSignature
    ) {
        const client = this.getClient();
        if (this.shouldProvideIntellisense(document.uri) && client) {
            const documentId = this.asTextDocumentIdentifier(document);
            const newDoc = this.converter.toConcatDocument(documentId);
            const newPos = this.converter.toConcatPosition(documentId, position);
            const params: protocol.HoverParams = {
                textDocument: newDoc,
                position: newPos
            };
            const result = await client.sendRequest(protocolNode.HoverRequest.type, params, token);
            const notebookResults = this.converter.toNotebookHover(documentId, result);
            return client.protocol2CodeConverter.asHover(notebookResults);
        }
    }

    // eslint-disable-next-line class-methods-use-this
    public resolveCompletionItem(
        item: vscode.CompletionItem,
        token: vscode.CancellationToken,
        next: protocol.ResolveCompletionItemSignature
    ): vscode.ProviderResult<vscode.CompletionItem> {
        // vscode.Range should have already been remapped.

        // TODO: What if the LS needs to read the range? It won't make sense. This might mean
        // doing this at the extension level is not possible.
        return next(item, token);
    }

    public async provideSignatureHelp(
        document: vscode.TextDocument,
        position: vscode.Position,
        context: vscode.SignatureHelpContext,
        token: vscode.CancellationToken,
        _next: protocol.ProvideSignatureHelpSignature
    ) {
        const client = this.getClient();
        if (this.shouldProvideIntellisense(document.uri) && client) {
            const documentId = this.asTextDocumentIdentifier(document);
            const newDoc = this.converter.toConcatDocument(documentId);
            const newPos = this.converter.toConcatPosition(documentId, position);
            const convertedParams = client.code2ProtocolConverter.asSignatureHelpParams(document, position, context);
            const params: protocol.SignatureHelpParams = {
                textDocument: newDoc,
                position: newPos,
                context: convertedParams.context
            };
            const result = await client.sendRequest(protocolNode.SignatureHelpRequest.type, params, token);
            return client.protocol2CodeConverter.asSignatureHelp(result);
        }
    }

    public async provideDefinition(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken,
        _next: protocol.ProvideDefinitionSignature
    ) {
        const client = this.getClient();
        if (this.shouldProvideIntellisense(document.uri) && client) {
            const documentId = this.asTextDocumentIdentifier(document);
            const newDoc = this.converter.toConcatDocument(documentId);
            const newPos = this.converter.toConcatPosition(documentId, position);
            const params: protocol.DefinitionParams = {
                textDocument: newDoc,
                position: newPos
            };
            const result = await client.sendRequest(protocolNode.DefinitionRequest.type, params, token);
            const notebookResults = this.converter.toNotebookLocations(result);
            return client.protocol2CodeConverter.asDefinitionResult(notebookResults);
        }
    }

    public async provideReferences(
        document: vscode.TextDocument,
        position: vscode.Position,
        options: {
            includeDeclaration: boolean;
        },
        token: vscode.CancellationToken,
        _next: protocol.ProvideReferencesSignature
    ) {
        const client = this.getClient();
        if (this.shouldProvideIntellisense(document.uri) && client) {
            const documentId = this.asTextDocumentIdentifier(document);
            const newDoc = this.converter.toConcatDocument(documentId);
            const newPos = this.converter.toConcatPosition(documentId, position);
            const params: protocol.ReferenceParams = {
                textDocument: newDoc,
                position: newPos,
                context: {
                    includeDeclaration: options.includeDeclaration
                }
            };
            const result = await client.sendRequest(protocolNode.ReferencesRequest.type, params, token);
            const notebookResults = this.converter.toNotebookLocations(result);
            return client.protocol2CodeConverter.asReferences(notebookResults);
        }
    }

    public async provideDocumentHighlights(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken,
        _next: protocol.ProvideDocumentHighlightsSignature
    ) {
        const client = this.getClient();
        if (this.shouldProvideIntellisense(document.uri) && client) {
            const documentId = this.asTextDocumentIdentifier(document);
            const newDoc = this.converter.toConcatDocument(documentId);
            const newPos = this.converter.toConcatPosition(documentId, position);
            const params: protocol.DocumentHighlightParams = {
                textDocument: newDoc,
                position: newPos
            };
            const result = await client.sendRequest(protocolNode.DocumentHighlightRequest.type, params, token);
            const notebookResults = this.converter.toNotebookHighlight(documentId, result);
            return client.protocol2CodeConverter.asDocumentHighlights(notebookResults);
        }
    }

    public async provideDocumentSymbols(
        document: vscode.TextDocument,
        token: vscode.CancellationToken,
        _next: protocol.ProvideDocumentSymbolsSignature
    ) {
        const client = this.getClient();
        if (this.shouldProvideIntellisense(document.uri) && client) {
            const documentId = this.asTextDocumentIdentifier(document);
            const newDoc = this.converter.toConcatDocument(documentId);
            const params: protocol.DocumentSymbolParams = {
                textDocument: newDoc
            };
            const result = await client.sendRequest(protocolNode.DocumentSymbolRequest.type, params, token);
            const notebookResults = this.converter.toNotebookSymbols(documentId, result);
            const element = notebookResults ? notebookResults[0] : undefined;
            if (protocol.DocumentSymbol.is(element)) {
                return client.protocol2CodeConverter.asDocumentSymbols(notebookResults as protocol.DocumentSymbol[]);
            } else if (element) {
                return client.protocol2CodeConverter.asSymbolInformations(
                    notebookResults as protocol.SymbolInformation[]
                );
            }
        }
    }

    public async provideWorkspaceSymbols(
        query: string,
        token: vscode.CancellationToken,
        _next: protocol.ProvideWorkspaceSymbolsSignature
    ) {
        const client = this.getClient();
        if (client) {
            const params: protocol.WorkspaceSymbolParams = {
                query
            };
            const result = await client.sendRequest(protocolNode.WorkspaceSymbolRequest.type, params, token);
            const notebookResults = this.converter.toNotebookWorkspaceSymbols(result);
            return client.protocol2CodeConverter.asSymbolInformations(notebookResults);
        }
    }

    // eslint-disable-next-line class-methods-use-this
    public provideCodeActions(
        document: vscode.TextDocument,
        _range: vscode.Range,
        _context: vscode.CodeActionContext,
        _token: vscode.CancellationToken,
        _next: protocol.ProvideCodeActionsSignature
    ) {
        if (this.shouldProvideIntellisense(document.uri)) {
            this.traceInfo('provideCodeActions not currently supported for notebooks');
            return undefined;
        }
    }

    // eslint-disable-next-line class-methods-use-this
    public provideCodeLenses(
        document: vscode.TextDocument,
        _token: vscode.CancellationToken,
        _next: protocol.ProvideCodeLensesSignature
    ) {
        if (this.shouldProvideIntellisense(document.uri)) {
            this.traceInfo('provideCodeLenses not currently supported for notebooks');
            return undefined;
        }
    }

    // eslint-disable-next-line class-methods-use-this
    public resolveCodeLens(
        codeLens: vscode.CodeLens,
        token: vscode.CancellationToken,
        next: protocol.ResolveCodeLensSignature
    ) {
        // vscode.Range should have already been remapped.

        // TODO: What if the LS needs to read the range? It won't make sense. This might mean
        // doing this at the extension level is not possible.
        return next(codeLens, token);
    }

    // eslint-disable-next-line class-methods-use-this
    public provideDocumentFormattingEdits(
        document: vscode.TextDocument,
        _options: vscode.FormattingOptions,
        _token: vscode.CancellationToken,
        _next: protocol.ProvideDocumentFormattingEditsSignature
    ) {
        if (this.shouldProvideIntellisense(document.uri)) {
            this.traceInfo('provideDocumentFormattingEdits not currently supported for notebooks');
            return undefined;
        }
    }

    // eslint-disable-next-line class-methods-use-this
    public provideDocumentRangeFormattingEdits(
        document: vscode.TextDocument,
        _range: vscode.Range,
        _options: vscode.FormattingOptions,
        _token: vscode.CancellationToken,
        _next: protocol.ProvideDocumentRangeFormattingEditsSignature
    ) {
        if (this.shouldProvideIntellisense(document.uri)) {
            this.traceInfo('provideDocumentRangeFormattingEdits not currently supported for notebooks');
            return undefined;
        }
    }

    // eslint-disable-next-line class-methods-use-this
    public provideOnTypeFormattingEdits(
        document: vscode.TextDocument,
        _position: vscode.Position,
        _ch: string,
        _options: vscode.FormattingOptions,
        _token: vscode.CancellationToken,
        _next: protocol.ProvideOnTypeFormattingEditsSignature
    ) {
        if (this.shouldProvideIntellisense(document.uri)) {
            this.traceInfo('provideOnTypeFormattingEdits not currently supported for notebooks');
            return undefined;
        }
    }

    // eslint-disable-next-line class-methods-use-this
    public provideRenameEdits(
        document: vscode.TextDocument,
        _position: vscode.Position,
        _newName: string,
        _token: vscode.CancellationToken,
        _next: protocol.ProvideRenameEditsSignature
    ) {
        if (this.shouldProvideIntellisense(document.uri)) {
            this.traceInfo('provideRenameEdits not currently supported for notebooks');
            return undefined;
        }
    }

    // eslint-disable-next-line class-methods-use-this
    public prepareRename(
        document: vscode.TextDocument,
        _position: vscode.Position,
        _token: vscode.CancellationToken,
        _next: protocol.PrepareRenameSignature
    ) {
        if (this.shouldProvideIntellisense(document.uri)) {
            this.traceInfo('prepareRename not currently supported for notebooks');
            return undefined;
        }
    }

    // eslint-disable-next-line class-methods-use-this
    public provideDocumentLinks(
        document: vscode.TextDocument,
        _token: vscode.CancellationToken,
        _next: protocol.ProvideDocumentLinksSignature
    ) {
        if (this.shouldProvideIntellisense(document.uri)) {
            this.traceInfo('provideDocumentLinks not currently supported for notebooks');
            return undefined;
        }
    }

    // eslint-disable-next-line class-methods-use-this
    public resolveDocumentLink(
        link: vscode.DocumentLink,
        token: vscode.CancellationToken,
        next: protocol.ResolveDocumentLinkSignature
    ) {
        // vscode.Range should have already been remapped.

        // TODO: What if the LS needs to read the range? It won't make sense. This might mean
        // doing this at the extension level is not possible.
        return next(link, token);
    }

    public handleDiagnostics(
        uri: vscode.Uri,
        diagnostics: vscode.Diagnostic[],
        next: protocol.HandleDiagnosticsSignature
    ): void {
        try {
            const incomingUriString = this.converter.toNotebookUri(uri.toString());
            const incomingUri = incomingUriString ? vscode.Uri.parse(incomingUriString) : undefined;
            const client = this.getClient();
            if (
                client &&
                incomingUri &&
                incomingUriString != uri.toString() &&
                this.shouldProvideIntellisense(incomingUri) &&
                !isInteractiveCell(incomingUri) // Skip diagnostics on the interactive window. Not particularly useful
            ) {
                const protocolDiagnostics = client.code2ProtocolConverter.asDiagnostics(diagnostics);

                // Remap any wrapped documents so that diagnostics appear in the cells. Note that if we
                // get a diagnostics list for our concated document, we have to tell VS code about EVERY cell.
                // Otherwise old messages for cells that didn't change this time won't go away.
                const newDiagMapping = this.converter.toNotebookDiagnosticsMap(uri.toString(), protocolDiagnostics);
                [...newDiagMapping.keys()].forEach((k) =>
                    next(vscode.Uri.parse(k), client.protocol2CodeConverter.asDiagnostics(newDiagMapping.get(k)!))
                );
            } else {
                // Swallow all other diagnostics
                next(uri, []);
            }
        } catch (e) {
            this.traceInfo(`Error during handling diagnostics: ${e}`);
            next(uri, []);
        }
    }

    public async provideTypeDefinition(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken,
        _next: ProvideTypeDefinitionSignature
    ) {
        const client = this.getClient();
        if (this.shouldProvideIntellisense(document.uri) && client) {
            const documentId = this.asTextDocumentIdentifier(document);
            const newDoc = this.converter.toConcatDocument(documentId);
            const newPos = this.converter.toConcatPosition(documentId, position);
            const params: protocol.TypeDefinitionParams = {
                textDocument: newDoc,
                position: newPos
            };
            const result = await client.sendRequest(protocolNode.TypeDefinitionRequest.type, params, token);
            const notebookResults = this.converter.toNotebookLocations(result);
            return client.protocol2CodeConverter.asDefinitionResult(notebookResults);
        }
    }

    public async provideImplementation(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken,
        _next: ProvideImplementationSignature
    ) {
        const client = this.getClient();
        if (this.shouldProvideIntellisense(document.uri) && client) {
            const documentId = this.asTextDocumentIdentifier(document);
            const newDoc = this.converter.toConcatDocument(documentId);
            const newPos = this.converter.toConcatPosition(documentId, position);
            const params: protocol.ImplementationParams = {
                textDocument: newDoc,
                position: newPos
            };
            const result = await client.sendRequest(protocolNode.ImplementationRequest.type, params, token);
            const notebookResults = this.converter.toNotebookLocations(result);
            return client.protocol2CodeConverter.asDefinitionResult(notebookResults);
        }
    }

    public async provideDocumentColors(
        document: vscode.TextDocument,
        token: vscode.CancellationToken,
        _next: ProvideDocumentColorsSignature
    ) {
        const client = this.getClient();
        if (this.shouldProvideIntellisense(document.uri) && client) {
            const documentId = this.asTextDocumentIdentifier(document);
            const newDoc = this.converter.toConcatDocument(documentId);
            const params: protocol.DocumentColorParams = {
                textDocument: newDoc
            };
            const result = await client.sendRequest(protocolNode.DocumentColorRequest.type, params, token);
            const notebookResults = this.converter.toNotebookColorInformations(documentId, result);
            return client.protocol2CodeConverter.asColorInformations(notebookResults);
        }
    }
    public async provideColorPresentations(
        color: vscode.Color,
        context: {
            document: vscode.TextDocument;
            range: vscode.Range;
        },
        token: vscode.CancellationToken,
        _next: ProvideColorPresentationSignature
    ) {
        const client = this.getClient();
        if (this.shouldProvideIntellisense(context.document.uri) && client) {
            const documentId = this.asTextDocumentIdentifier(context.document);
            const newDoc = this.converter.toConcatDocument(documentId);
            const newRange = this.converter.toRealRange(documentId, context.range);
            const params: protocol.ColorPresentationParams = {
                textDocument: newDoc,
                range: newRange,
                color
            };
            const result = await client.sendRequest(protocolNode.ColorPresentationRequest.type, params, token);
            const notebookResults = this.converter.toNotebookColorPresentations(documentId, result);
            return client.protocol2CodeConverter.asColorPresentations(notebookResults);
        }
    }

    public async provideFoldingRanges(
        document: vscode.TextDocument,
        _context: vscode.FoldingContext,
        token: vscode.CancellationToken,
        _next: ProvideFoldingRangeSignature
    ) {
        const client = this.getClient();
        if (this.shouldProvideIntellisense(document.uri) && client) {
            const documentId = this.asTextDocumentIdentifier(document);
            const newDoc = this.converter.toConcatDocument(documentId);
            const params: protocol.FoldingRangeParams = {
                textDocument: newDoc
            };
            const result = await client.sendRequest(protocolNode.FoldingRangeRequest.type, params, token);
            const notebookResults = this.converter.toNotebookFoldingRanges(documentId, result);
            return client.protocol2CodeConverter.asFoldingRanges(notebookResults);
        }
    }

    public async provideDeclaration(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken,
        _next: ProvideDeclarationSignature
    ) {
        const client = this.getClient();
        if (this.shouldProvideIntellisense(document.uri) && client) {
            const documentId = this.asTextDocumentIdentifier(document);
            const newDoc = this.converter.toConcatDocument(documentId);
            const newPos = this.converter.toConcatPosition(documentId, position);
            const params: protocol.DeclarationParams = {
                textDocument: newDoc,
                position: newPos
            };
            const result = await client.sendRequest(protocolNode.DeclarationRequest.type, params, token);
            const notebookResults = this.converter.toNotebookLocations(result);
            return client.protocol2CodeConverter.asDeclarationResult(notebookResults);
        }
    }

    public async provideSelectionRanges(
        document: vscode.TextDocument,
        positions: vscode.Position[],
        token: vscode.CancellationToken,
        _next: ProvideSelectionRangeSignature
    ) {
        const client = this.getClient();
        if (this.shouldProvideIntellisense(document.uri) && client) {
            const documentId = this.asTextDocumentIdentifier(document);
            const newDoc = this.converter.toConcatDocument(documentId);
            const newPositions = this.converter.toConcatPositions(documentId, positions);
            const params: protocol.SelectionRangeParams = {
                textDocument: newDoc,
                positions: newPositions
            };
            const result = await client.sendRequest(protocolNode.SelectionRangeRequest.type, params, token);
            const notebookResults = this.converter.toNotebookSelectionRanges(documentId, result);
            return client.protocol2CodeConverter.asSelectionRanges(notebookResults);
        }
    }

    public async prepareCallHierarchy(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken,
        _next: PrepareCallHierarchySignature
    ) {
        const client = this.getClient();
        if (this.shouldProvideIntellisense(document.uri) && client) {
            const documentId = this.asTextDocumentIdentifier(document);
            const newDoc = this.converter.toConcatDocument(documentId);
            const newPos = this.converter.toConcatPosition(documentId, position);
            const params: protocol.CallHierarchyPrepareParams = {
                textDocument: newDoc,
                position: newPos
            };
            const result = await client.sendRequest(protocolNode.CallHierarchyPrepareRequest.type, params, token);
            const notebookResults = this.converter.toNotebookCallHierarchyItems(documentId, result);
            return client.protocol2CodeConverter.asCallHierarchyItems(notebookResults);
        }
    }
    public async provideCallHierarchyIncomingCalls(
        item: vscode.CallHierarchyItem,
        token: vscode.CancellationToken,
        _next: CallHierarchyIncomingCallsSignature
    ) {
        const client = this.getClient();
        if (this.shouldProvideIntellisense(item.uri) && client) {
            const documentId = this.asTextDocumentIdentifier(item.uri);
            const newDoc = this.converter.toConcatDocument(documentId);
            const newRange = this.converter.toRealRange(documentId, item.range);
            const newSelectionRange = this.converter.toRealRange(documentId, item.selectionRange);
            const params: protocol.CallHierarchyIncomingCallsParams = {
                item: {
                    ...client.code2ProtocolConverter.asCallHierarchyItem(item),
                    uri: newDoc.uri,
                    range: newRange,
                    selectionRange: newSelectionRange
                }
            };
            const result = await client.sendRequest(protocolNode.CallHierarchyIncomingCallsRequest.type, params, token);
            const notebookResults = this.converter.toNotebookCallHierarchyIncomingCallItems(documentId, result);
            return client.protocol2CodeConverter.asCallHierarchyIncomingCalls(notebookResults);
        }
    }
    public async provideCallHierarchyOutgoingCalls(
        item: vscode.CallHierarchyItem,
        token: vscode.CancellationToken,
        _next: CallHierarchyOutgoingCallsSignature
    ) {
        const client = this.getClient();
        if (this.shouldProvideIntellisense(item.uri) && client) {
            const documentId = this.asTextDocumentIdentifier(item.uri);
            const newDoc = this.converter.toConcatDocument(documentId);
            const newRange = this.converter.toRealRange(documentId, item.range);
            const newSelectionRange = this.converter.toRealRange(documentId, item.selectionRange);
            const params: protocol.CallHierarchyOutgoingCallsParams = {
                item: {
                    ...client.code2ProtocolConverter.asCallHierarchyItem(item),
                    uri: newDoc.uri,
                    range: newRange,
                    selectionRange: newSelectionRange
                }
            };
            const result = await client.sendRequest(protocolNode.CallHierarchyOutgoingCallsRequest.type, params, token);
            const notebookResults = this.converter.toNotebookCallHierarchyOutgoingCallItems(documentId, result);
            return client.protocol2CodeConverter.asCallHierarchyOutgoingCalls(notebookResults);
        }
    }

    public async provideDocumentSemanticTokens(
        document: vscode.TextDocument,
        token: vscode.CancellationToken,
        _next: DocumentSemanticsTokensSignature
    ) {
        const client = this.getClient();
        if (this.shouldProvideIntellisense(document.uri) && client) {
            const documentId = this.asTextDocumentIdentifier(document);
            const newDoc = this.converter.toConcatDocument(documentId);

            // Since tokens are for a cell, we need to change the request for a range and not the entire document.
            const newRange = this.converter.toRealRange(documentId, undefined);

            const params: protocol.SemanticTokensRangeParams = {
                textDocument: newDoc,
                range: newRange
            };
            const result = await client.sendRequest(protocol.SemanticTokensRangeRequest.type, params, token);

            // Then convert from protocol back to vscode types
            const notebookResults = this.converter.toNotebookSemanticTokens(documentId, result);
            return client.protocol2CodeConverter.asSemanticTokens(notebookResults);
        }
    }
    public async provideDocumentSemanticTokensEdits(
        document: vscode.TextDocument,
        _previousResultId: string,
        token: vscode.CancellationToken,
        _next: DocumentSemanticsTokensEditsSignature
    ) {
        // Token edits work with previous token response. However pylance
        // doesn't know about the cell so it sends back ALL tokens.
        // Instead just ask for a range.
        const client = this.getClient();
        if (this.shouldProvideIntellisense(document.uri) && client) {
            const documentId = this.asTextDocumentIdentifier(document);
            const newDoc = this.converter.toConcatDocument(documentId);

            // Since tokens are for a cell, we need to change the request for a range and not the entire document.
            const newRange = this.converter.toRealRange(documentId, undefined);

            const params: protocol.SemanticTokensRangeParams = {
                textDocument: newDoc,
                range: newRange
            };
            const result = await client.sendRequest(protocol.SemanticTokensRangeRequest.type, params, token);

            // Then convert from protocol back to vscode types
            const notebookResults = this.converter.toNotebookSemanticTokens(documentId, result);
            return client.protocol2CodeConverter.asSemanticTokens(notebookResults);
        }
    }
    public async provideDocumentRangeSemanticTokens(
        document: vscode.TextDocument,
        range: vscode.Range,
        token: vscode.CancellationToken,
        _next: DocumentRangeSemanticTokensSignature
    ) {
        const client = this.getClient();
        if (this.shouldProvideIntellisense(document.uri) && client) {
            const documentId = this.asTextDocumentIdentifier(document);
            const newDoc = this.converter.toConcatDocument(documentId);
            const newRange = this.converter.toRealRange(documentId, range);
            const params: protocol.SemanticTokensRangeParams = {
                textDocument: newDoc,
                range: newRange
            };
            const result = await client.sendRequest(protocol.SemanticTokensRangeRequest.type, params, token);

            // Then convert from protocol back to vscode types
            const notebookResults = this.converter.toNotebookSemanticTokens(documentId, result);
            return client.protocol2CodeConverter.asSemanticTokens(notebookResults);
        }
    }

    public async provideLinkedEditingRange(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken,
        _next: ProvideLinkedEditingRangeSignature
    ) {
        const client = this.getClient();
        if (this.shouldProvideIntellisense(document.uri) && client) {
            const documentId = this.asTextDocumentIdentifier(document);
            const newDoc = this.converter.toConcatDocument(documentId);
            const newPosition = this.converter.toConcatPosition(documentId, position);
            const params: protocol.LinkedEditingRangeParams = {
                textDocument: newDoc,
                position: newPosition
            };
            const result = await client.sendRequest(protocol.LinkedEditingRangeRequest.type, params, token);

            // Then convert from protocol back to vscode types
            const notebookResults = this.converter.toNotebookLinkedEditingRanges(documentId, result);
            return client.protocol2CodeConverter.asLinkedEditingRanges(notebookResults);
        }
    }

    private shouldProvideIntellisense(uri: vscode.Uri): boolean {
        // Make sure document is allowed
        return this.isDocumentAllowed(uri);
    }

    private asTextDocumentIdentifier(documentOrUri: vscode.TextDocument | vscode.Uri): protocol.TextDocumentIdentifier {
        return {
            uri: 'uri' in documentOrUri ? documentOrUri.uri.toString() : documentOrUri.toString()
        };
    }

    private asTextDocumentItem(document: vscode.TextDocument): protocol.TextDocumentItem {
        return {
            uri: document.uri.toString(),
            text: document.getText(),
            languageId: document.languageId,
            version: document.version
        };
    }
}
