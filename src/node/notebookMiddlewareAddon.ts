// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
import * as vscode from 'vscode';
import * as protocol from 'vscode-languageclient';
import * as protocolNode from 'vscode-languageclient/node';

import { ProvideDeclarationSignature } from 'vscode-languageclient/lib/common/declaration';
import { isInteractiveCell, isNotebookCell, isThenable } from '../common/utils';
import { NotebookConverter } from '../protocol-only/notebookConverter';
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
import { score } from '../common/utils';
import { RefreshNotebookEvent } from '../protocol-only/types';
import { TextDocumentWrapper } from './textDocumentWrapper';
import { RequestType1 } from 'vscode-languageclient';
import { arrayDiff } from 'vscode-languageclient/lib/common/workspaceFolders';

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
        this.converter = new NotebookConverter(getNotebookHeader);

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
                const params = this.converter.handleRefresh(this.asRefreshEvent(notebook));
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
    public provideCompletionItem(
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
            const params: protocol.CompletionParams = {
                textDocument: newDoc,
                position: newPos,
                context: {
                    triggerKind: this.asCompletionTriggerKind(context.triggerKind),
                    triggerCharacter: context.triggerCharacter
                }
            };
            const result = client.sendRequest(protocolNode.CompletionRequest.type, params, token);
            if (isThenable(result)) {
                return result.then(client.protocol2CodeConverter.asCompletionResult);
            }
            return client.protocol2CodeConverter.asCompletionResult(result);
        }
    }

    // eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
    public provideHover(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken,
        next: protocol.ProvideHoverSignature
    ) {
        return this.callNext(document, position, token, next, this.convertHovers.bind(this, document));
    }

    // eslint-disable-next-line class-methods-use-this
    public resolveCompletionItem(
        item: vscode.CompletionItem,
        token: vscode.CancellationToken,
        next: protocol.ResolveCompletionItemSignature
    ): vscode.ProviderResult<vscode.CompletionItem> {
        // Range should have already been remapped.

        // TODO: What if the LS needs to read the range? It won't make sense. This might mean
        // doing this at the extension level is not possible.
        return next(item, token);
    }

    public provideSignatureHelp(
        document: vscode.TextDocument,
        position: vscode.Position,
        context: vscode.SignatureHelpContext,
        token: vscode.CancellationToken,
        next: protocol.ProvideSignatureHelpSignature
    ): vscode.ProviderResult<vscode.SignatureHelp> {
        return this.callNextWithArg(
            document,
            position,
            token,
            context,
            next,
            (r) => r // No conversion after coming back
        );
    }

    public provideDefinition(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken,
        next: protocol.ProvideDefinitionSignature
    ) {
        return this.callNext(document, position, token, next, this.convertLocations.bind(this, document));
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
            const newDoc = this.converter.toConcatDocument(document);
            const newPos = this.converter.toConcatPosition(document, position);
            const result = next(newDoc, newPos, options, token);
            if (isThenable(result)) {
                return result.then(this.converter.toNotebookLocations.bind(this.converter));
            }
            return this.converter.toNotebookLocations(result);
        }
    }

    public provideDocumentHighlights(
        document: TextDocument,
        position: Position,
        token: CancellationToken,
        next: ProvideDocumentHighlightsSignature
    ): ProviderResult<DocumentHighlight[]> {
        if (this.shouldProvideIntellisense(document.uri)) {
            const newDoc = this.converter.toConcatDocument(document);
            const newPos = this.converter.toConcatPosition(document, position);
            const result = next(newDoc, newPos, token);
            if (isThenable(result)) {
                return result.then(this.converter.toNotebookHighlight.bind(this.converter, document));
            }
            return this.converter.toNotebookHighlight(document, result);
        }
    }

    public provideDocumentSymbols(
        document: TextDocument,
        token: CancellationToken,
        next: ProvideDocumentSymbolsSignature
    ): ProviderResult<SymbolInformation[] | DocumentSymbol[]> {
        if (this.shouldProvideIntellisense(document.uri)) {
            const newDoc = this.converter.toConcatDocument(document);
            const result = next(newDoc, token);
            if (isThenable(result)) {
                return result.then(this.converter.toNotebookSymbols.bind(this.converter, document));
            }
            return this.converter.toNotebookSymbols(document, result);
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
            return result.then(this.converter.toNotebookWorkspaceSymbols.bind(this.converter));
        }
        return this.converter.toNotebookWorkspaceSymbols(result);
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
        try {
            const incomingUri = this.converter.toNotebookUri(uri);
            if (
                incomingUri &&
                incomingUri != uri &&
                this.shouldProvideIntellisense(incomingUri) &&
                !isInteractiveCell(incomingUri) // Skip diagnostics on the interactive window. Not particularly useful
            ) {
                // Remap any wrapped documents so that diagnostics appear in the cells. Note that if we
                // get a diagnostics list for our concated document, we have to tell VS code about EVERY cell.
                // Otherwise old messages for cells that didn't change this time won't go away.
                const newDiagMapping = this.converter.toNotebookDiagnosticsMap(uri, diagnostics);
                [...newDiagMapping.keys()].forEach((k) => next(k, newDiagMapping.get(k)!));
            } else {
                // Swallow all other diagnostics
                next(uri, []);
            }
        } catch (e) {
            this.traceInfo(`Error during handling diagnostics: ${e}`);
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
            const newDoc = this.converter.toConcatDocument(document);
            const newPos = this.converter.toConcatPosition(document, position);
            const result = next(newDoc, newPos, token);
            if (isThenable(result)) {
                return result.then(this.converter.toNotebookLocations.bind(this.converter));
            }
            return this.converter.toNotebookLocations(result);
        }
    }

    public provideImplementation(
        document: TextDocument,
        position: VPosition,
        token: CancellationToken,
        next: ProvideImplementationSignature
    ): ProviderResult<Definition | DefinitionLink[]> {
        if (this.shouldProvideIntellisense(document.uri)) {
            const newDoc = this.converter.toConcatDocument(document);
            const newPos = this.converter.toConcatPosition(document, position);
            const result = next(newDoc, newPos, token);
            if (isThenable(result)) {
                return result.then(this.converter.toNotebookLocations.bind(this.converter));
            }
            return this.converter.toNotebookLocations(result);
        }
    }

    public provideDocumentColors(
        document: TextDocument,
        token: CancellationToken,
        next: ProvideDocumentColorsSignature
    ): ProviderResult<ColorInformation[]> {
        if (this.shouldProvideIntellisense(document.uri)) {
            const newDoc = this.converter.toConcatDocument(document);
            const result = next(newDoc, token);
            if (isThenable(result)) {
                return result.then(this.converter.toNotebookColorInformations.bind(this.converter, document.uri));
            }
            return this.converter.toNotebookColorInformations(document.uri, result);
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
            const newDoc = this.converter.toConcatDocument(context.document);
            const newRange = this.converter.toRealRange(context.document, context.range);
            const result = next(color, { document: newDoc, range: newRange }, token);
            if (isThenable(result)) {
                return result.then(
                    this.converter.toNotebookColorPresentations.bind(this.converter, context.document.uri)
                );
            }
            return this.converter.toNotebookColorPresentations(context.document.uri, result);
        }
    }

    public provideFoldingRanges(
        document: TextDocument,
        context: FoldingContext,
        token: CancellationToken,
        next: ProvideFoldingRangeSignature
    ): ProviderResult<FoldingRange[]> {
        if (this.shouldProvideIntellisense(document.uri)) {
            const newDoc = this.converter.toConcatDocument(document);
            const result = next(newDoc, context, token);
            if (isThenable(result)) {
                return result.then(this.converter.toNotebookFoldingRanges.bind(this.converter, document.uri));
            }
            return this.converter.toNotebookFoldingRanges(document.uri, result);
        }
    }

    public provideDeclaration(
        document: TextDocument,
        position: Position,
        token: CancellationToken,
        next: ProvideDeclarationSignature
    ): ProviderResult<Declaration> {
        if (this.shouldProvideIntellisense(document.uri)) {
            const newDoc = this.converter.toConcatDocument(document);
            const newPos = this.converter.toConcatPosition(document, position);
            const result = next(newDoc, newPos, token);
            if (isThenable(result)) {
                return result.then(this.converter.toNotebookLocations.bind(this.converter));
            }
            return this.converter.toNotebookLocations(result);
        }
    }

    public provideSelectionRanges(
        document: TextDocument,
        positions: Position[],
        token: CancellationToken,
        next: ProvideSelectionRangeSignature
    ): ProviderResult<SelectionRange[]> {
        if (this.shouldProvideIntellisense(document.uri)) {
            const newDoc = this.converter.toConcatDocument(document);
            const newPositions = this.converter.toConcatPositions(document, positions);
            const result = next(newDoc, newPositions, token);
            if (isThenable(result)) {
                return result.then(this.converter.toNotebookSelectionRanges.bind(this.converter, document.uri));
            }
            return this.converter.toNotebookSelectionRanges(document.uri, result);
        }
    }

    public prepareCallHierarchy(
        document: TextDocument,
        positions: Position,
        token: CancellationToken,
        next: PrepareCallHierarchySignature
    ): ProviderResult<CallHierarchyItem | CallHierarchyItem[]> {
        if (this.shouldProvideIntellisense(document.uri)) {
            const newDoc = this.converter.toConcatDocument(document);
            const newPositions = this.converter.toConcatPosition(document, positions);
            const result = next(newDoc, newPositions, token);
            if (isThenable(result)) {
                return result.then(this.converter.toNotebookCallHierarchyItems.bind(this.converter, document.uri));
            }
            return this.converter.toNotebookCallHierarchyItems(document.uri, result);
        }
    }
    public provideCallHierarchyIncomingCalls(
        item: CallHierarchyItem,
        token: CancellationToken,
        next: CallHierarchyIncomingCallsSignature
    ): ProviderResult<CallHierarchyIncomingCall[]> {
        if (this.shouldProvideIntellisense(item.uri)) {
            const newUri = this.converter.toConcatUri(item.uri);
            const newRange = this.converter.toRealRange(item.uri, item.range);
            const result = next({ ...item, uri: newUri, range: newRange }, token);
            if (isThenable(result)) {
                return result.then(
                    this.converter.toNotebookCallHierarchyIncomingCallItems.bind(this.converter, item.uri)
                );
            }
            return this.converter.toNotebookCallHierarchyIncomingCallItems(item.uri, result);
        }
    }
    public provideCallHierarchyOutgoingCalls(
        item: CallHierarchyItem,
        token: CancellationToken,
        next: CallHierarchyOutgoingCallsSignature
    ): ProviderResult<CallHierarchyOutgoingCall[]> {
        if (this.shouldProvideIntellisense(item.uri)) {
            const newUri = this.converter.toConcatUri(item.uri);
            const newRange = this.converter.toRealRange(item.uri, item.range);
            const result = next({ ...item, uri: newUri, range: newRange }, token);
            if (isThenable(result)) {
                return result.then(
                    this.converter.toNotebookCallHierarchyOutgoingCallItems.bind(this.converter, item.uri)
                );
            }
            return this.converter.toNotebookCallHierarchyOutgoingCallItems(item.uri, result);
        }
    }

    public provideDocumentSemanticTokens(
        document: TextDocument,
        token: CancellationToken,
        _next: DocumentSemanticsTokensSignature
    ): ProviderResult<SemanticTokens> {
        const client = this.getClient();
        if (this.shouldProvideIntellisense(document.uri) && client) {
            const newDoc = this.converter.toConcatDocument(document);

            // Since tokens are for a cell, we need to change the request for a range and not the entire document.
            const newRange = this.converter.toRealRange(document.uri, undefined);

            const params: SemanticTokensRangeParams = {
                textDocument: client.code2ProtocolConverter.asTextDocumentIdentifier(newDoc),
                range: client.code2ProtocolConverter.asRange(newRange)
            };

            // Make the request directly (dont use the 'next' value)
            const result = client.sendRequest(SemanticTokensRangeRequest.type, params, token);

            // Then convert from protocol back to vscode types
            return result.then((r) => {
                const vscodeTokens = client.protocol2CodeConverter.asSemanticTokens(r);
                return this.converter.toNotebookSemanticTokens(document.uri, vscodeTokens);
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
            const newDoc = this.converter.toConcatDocument(document);

            // Since tokens are for a cell, we need to change the request for a range and not the entire document.
            const newRange = this.converter.toRealRange(document.uri, undefined);

            const params: SemanticTokensRangeParams = {
                textDocument: client.code2ProtocolConverter.asTextDocumentIdentifier(newDoc),
                range: client.code2ProtocolConverter.asRange(newRange)
            };

            // Make the request directly (dont use the 'next' value)
            const result = client.sendRequest(SemanticTokensRangeRequest.type, params, token);

            // Then convert from protocol back to vscode types
            return result.then((r) => {
                const vscodeTokens = client.protocol2CodeConverter.asSemanticTokens(r);
                return this.converter.toNotebookSemanticTokens(document.uri, vscodeTokens);
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
            const newDoc = this.converter.toConcatDocument(document);
            const newRange = this.converter.toRealRange(document, range);
            const result = next(newDoc, newRange, token);
            if (isThenable(result)) {
                return result.then(this.converter.toNotebookSemanticTokens.bind(this.converter, document.uri));
            }
            return this.converter.toNotebookSemanticTokens(document.uri, result);
        }
    }

    public provideLinkedEditingRange(
        document: TextDocument,
        position: Position,
        token: CancellationToken,
        next: ProvideLinkedEditingRangeSignature
    ): ProviderResult<LinkedEditingRanges> {
        if (this.shouldProvideIntellisense(document.uri)) {
            const newDoc = this.converter.toConcatDocument(document);
            const newPosition = this.converter.toConcatPosition(document, position);
            const result = next(newDoc, newPosition, token);
            if (isThenable(result)) {
                return result.then(this.converter.toNotebookLinkedEditingRanges.bind(this.converter, document.uri));
            }
            return this.converter.toNotebookLinkedEditingRanges(document.uri, result);
        }
    }

    private callNext<R1>(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken,
        next: (d: vscode.TextDocument, p: vscode.Position, t: vscode.CancellationToken) => vscode.ProviderResult<R1>,
        converter: (result: R1 | null | undefined) => R1 | null | undefined
    ) {
        if (this.shouldProvideIntellisense(document.uri)) {
            const documentId = this.asTextDocumentIdentifier(document);
            const newDoc = this.converter.toConcatTextDocument(documentId);
            const newPos = this.converter.toConcatPosition(documentId, position);
            const result = next(
                new TextDocumentWrapper(newDoc),
                new vscode.Position(newPos.line, newPos.character),
                token
            );
            if (isThenable(result)) {
                return result.then(converter);
            }
            return converter(result);
        }
    }

    private callNextWithArg<T1, R1>(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken,
        arg: T1,
        next: (
            d: vscode.TextDocument,
            p: vscode.Position,
            arg: T1,
            t: vscode.CancellationToken
        ) => vscode.ProviderResult<R1>,
        converter: (result: R1 | null | undefined) => R1 | null | undefined
    ) {
        if (this.shouldProvideIntellisense(document.uri)) {
            const documentId = this.asTextDocumentIdentifier(document);
            const newDoc = this.converter.toConcatTextDocument(documentId);
            const newPos = this.converter.toConcatPosition(documentId, position);
            const result = next(
                new TextDocumentWrapper(newDoc),
                new vscode.Position(newPos.line, newPos.character),
                arg,
                token
            );
            if (isThenable(result)) {
                return result.then(converter);
            }
            return converter(result);
        }
    }

    private shouldProvideIntellisense(uri: vscode.Uri): boolean {
        // Make sure document is allowed
        return this.isDocumentAllowed(uri);
    }

    private asTextDocumentIdentifier(document: vscode.TextDocument): protocol.TextDocumentIdentifier {
        return {
            uri: document.uri.toString()
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

    private asRefreshEvent(notebook: vscode.NotebookDocument): RefreshNotebookEvent {
        return {
            cells: notebook
                .getCells()
                .filter((c) => score(c.document, this.cellSelector) > 0)
                .map((c) => {
                    return {
                        textDocument: this.asTextDocumentItem(c.document)
                    };
                })
        };
    }

    private asCompletionItem(item: vscode.CompletionItem) {
        const client = this.getClient();
        return client!.code2ProtocolConverter.asCompletionItem(item);
    }

    private asCompletionList(
        list: vscode.CompletionItem[] | vscode.CompletionList<vscode.CompletionItem> | null | undefined
    ): protocol.CompletionList | protocol.CompletionItem[] | undefined {
        if (!list) {
            return undefined;
        }
        if (Array.isArray(list)) {
            return list.map(this.asCompletionItem.bind(this));
        }
        return list.items.map(this.asCompletionItem.bind(this));
    }

    private asHover(result: vscode.Hover | null | undefined): protocol.Hover | undefined | null {
        if (!result) {
            return undefined;
        }
        return result as any; // Types should be the same if you skip deprecated values?
    }

    private asLocation(item: vscode.Location | vscode.LocationLink): protocol.Location | protocol.LocationLink {
        const client = this.getClient();
        if ('targetUri' in item) {
            return {
                targetUri: client!.code2ProtocolConverter.asUri(item.targetUri),
                targetSelectionRange: client!.code2ProtocolConverter.asRange(item.targetSelectionRange)!,
                targetRange: client!.code2ProtocolConverter.asRange(item.targetRange)!,
                originSelectionRange: client!.code2ProtocolConverter.asRange(item.originSelectionRange)!
            };
        }
        return client!.code2ProtocolConverter.asLocation(item);
    }

    private asLocations(
        result: vscode.Definition | vscode.LocationLink[] | null | undefined
    ): protocol.Definition | protocol.LocationLink[] | undefined | null {
        if (!result) {
            return undefined;
        }
        if (Array.isArray(result)) {
            return result.map(this.asLocation.bind(this));
        }
        return this.asLocation(result); // Types should be the same if you skip deprecated values?
    }

    private convertCompletions(
        document: vscode.TextDocument,
        list: vscode.CompletionItem[] | vscode.CompletionList<vscode.CompletionItem> | null | undefined
    ) {
        const client = this.getClient();
        const documentId = this.asTextDocumentIdentifier(document);
        const from = this.asCompletionList(list);
        const to = this.converter.toNotebookCompletions(documentId, from);
        return client!.protocol2CodeConverter.asCompletionResult(to);
    }

    private convertHovers(document: vscode.TextDocument, result: vscode.Hover | null | undefined) {
        const client = this.getClient();
        const documentId = this.asTextDocumentIdentifier(document);
        const from = this.asHover(result);
        const to = this.converter.toNotebookHover(documentId, from);
        return client!.protocol2CodeConverter.asHover(to);
    }

    private convertLocations(
        _document: vscode.TextDocument,
        result: vscode.Definition | vscode.DefinitionLink[] | null | undefined
    ) {
        const client = this.getClient();
        const from = this.asLocations(result);
        const to = this.converter.toNotebookLocations(from);
        return client!.protocol2CodeConverter.asDefinitionResult(to);
    }
    private asCompletionTriggerKind(triggerKind: vscode.CompletionTriggerKind): protocol.CompletionTriggerKind {
        switch (triggerKind) {
            case vscode.CompletionTriggerKind.TriggerCharacter:
                return protocol.CompletionTriggerKind.TriggerCharacter;
            case vscode.CompletionTriggerKind.TriggerForIncompleteCompletions:
                return protocol.CompletionTriggerKind.TriggerForIncompleteCompletions;
            default:
                return protocol.CompletionTriggerKind.Invoked;
        }
    }
}
