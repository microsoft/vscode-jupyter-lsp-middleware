// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
import * as os from 'os';
import * as vscodeUri from 'vscode-uri';
import * as protocol from 'vscode-languageserver-protocol';

import { InteractiveInputScheme, InteractiveScheme, isNotebookCell } from '../common/utils';
import { IDisposable, ITextDocument, RefreshNotebookEvent } from './types';
import { NotebookConcatDocument } from './notebookConcatDocument';
import { createLocation, createPosition, createRange } from './helper';

/**
 * Class responsible for converting incoming requests to outgoing types based on a concatenated document instead.
 */
export class NotebookConverter implements IDisposable {
    private activeConcats: Map<string, NotebookConcatDocument> = new Map<string, NotebookConcatDocument>();

    private activeConcatsOutgoingMap: Map<string, NotebookConcatDocument> = new Map<string, NotebookConcatDocument>();

    private disposables: IDisposable[] = [];

    private mapOfConcatDocumentsWithCellUris = new Map<string, string[]>();

    constructor(private getNotebookHeader: (uri: vscodeUri.URI) => string) {}

    private static getDocumentKey(uri: vscodeUri.URI): string {
        if (uri.scheme === InteractiveInputScheme) {
            // input
            const counter = /InteractiveInput-(\d+)/.exec(uri.path);
            if (counter && counter[1]) {
                return `interactive-${counter[1]}.interactive`;
            }
        }

        if (uri.scheme === InteractiveScheme) {
            return uri.path.toLowerCase();
        }

        // Use the path of the doc uri. It should be the same for all cells
        if (os.platform() === 'win32') {
            return uri.fsPath.toLowerCase();
        }
        return uri.fsPath;
    }

    public dispose(): void {
        this.disposables.forEach((d) => d.dispose());
    }

    public hasCell(cell: protocol.TextDocumentIdentifier): boolean {
        const concat = this.getConcatDocument(cell);
        return concat.contains(cell.uri);
    }

    public isOpen(cell: protocol.TextDocumentIdentifier): boolean | undefined {
        const concat = this.getConcatDocument(cell);
        return concat.isOpen;
    }

    public handleOpen(ev: protocol.DidOpenTextDocumentParams) {
        const concat = this.getConcatDocument(ev.textDocument);
        const results = concat?.handleOpen(ev);

        // concat uri is empty until a cell is added.
        this.activeConcatsOutgoingMap.set(NotebookConverter.getDocumentKey(concat.concatUri), concat);
        return results;
    }

    public handleRefresh(e: RefreshNotebookEvent) {
        // Find the concat for any of the cells
        const concat = e.cells.length ? this.getConcatDocument(e.cells[0].textDocument) : undefined;
        return concat?.handleRefresh(e);
    }

    public handleClose(event: protocol.DidCloseTextDocumentParams) {
        const concat = this.getConcatDocument(event.textDocument.uri);
        return concat.handleClose(event);
    }

    public handleChange(event: protocol.DidChangeTextDocumentParams) {
        const concat = this.getConcatDocument(event.textDocument.uri);
        return concat.handleChange(event);
    }

    public toNotebookDiagnosticsMap(
        concatUri: protocol.TextDocumentIdentifier | string,
        diagnostics: protocol.Diagnostic[]
    ): Map<string, protocol.Diagnostic[]> {
        const concat = this.getConcatDocumentForUri(concatUri);
        const result = new Map<string, protocol.Diagnostic[]>();

        if (concat) {
            // Diagnostics are supposed to be per file and are updated each time
            // Make sure to clear out old ones first
            const cellUris: string[] = [];
            const oldCellUris = this.mapOfConcatDocumentsWithCellUris.get(concatUri.toString()) || [];
            concat.getCells().forEach((uri) => {
                result.set(uri.toString(), []);
                cellUris.push(uri.toString());
            });
            // Possible some cells were deleted, we need to clear the diagnostics of those cells as well.
            const currentCellUris = new Set(cellUris);
            oldCellUris
                .filter((cellUri) => !currentCellUris.has(cellUri))
                .forEach((cellUri) => result.set(cellUri, []));
            this.mapOfConcatDocumentsWithCellUris.set(concatUri.toString(), cellUris);

            // Then for all the new ones, set their values.
            diagnostics.forEach((d) => {
                const location = concat.notebookLocationAt(d.range);
                const uri = vscodeUri.URI.parse(location.uri);

                // Empty location means no fragment (no cell URI)
                if (uri.fragment) {
                    let list = result.get(location.uri);
                    if (!list) {
                        list = [];
                        result.set(location.uri, list);
                    }
                    list.push(this.toNotebookDiagnostic(location.uri, d));
                }
            });
        } else if (this.mapOfConcatDocumentsWithCellUris.has(concatUri.toString())) {
            (this.mapOfConcatDocumentsWithCellUris.get(concatUri.toString()) || []).forEach((cellUri) =>
                result.set(cellUri, [])
            );
            this.mapOfConcatDocumentsWithCellUris.delete(concatUri.toString());
        } else {
            result.set(this.toURI(concatUri).toString(), diagnostics);
        }

        return result;
    }

    // eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
    public toNotebookWorkspaceSymbols(symbols: protocol.SymbolInformation[] | null | undefined) {
        if (Array.isArray(symbols)) {
            return symbols.map(this.toNotebookWorkspaceSymbol.bind(this));
        }
        return symbols ?? undefined;
    }

    public toNotebookWorkspaceEdit(
        workspaceEdit: protocol.WorkspaceEdit | null | undefined
    ): protocol.WorkspaceEdit | undefined {
        if (workspaceEdit) {
            // Translate all of the text edits into a URI map
            const translated = new Map<string, protocol.TextEdit[]>();
            const keys = workspaceEdit.changes ? Object.keys(workspaceEdit.changes) : [];
            keys.forEach((key) => {
                workspaceEdit.changes![key].forEach((e) => {
                    // Location may move this edit to a different cell.
                    const location = this.toNotebookLocationFromRange(key, e.range);

                    // Save this in the entry
                    let list = translated.get(location.uri);
                    if (!list) {
                        list = [];
                        translated.set(location.uri, list);
                    }
                    list.push({
                        ...e,
                        range: location.range
                    });
                });
            });

            // Add translated entries to the new edit
            const newWorkspaceEdit: protocol.WorkspaceEdit = {
                changes: {}
            };
            translated.forEach((list, key) => (newWorkspaceEdit.changes![key] = list));
            return newWorkspaceEdit;
        }
        return workspaceEdit ?? undefined;
    }

    public toConcatDocument(cell: protocol.TextDocumentIdentifier): protocol.TextDocumentItem {
        const result = this.getConcatDocument(cell);

        return {
            text: result.getText(),
            uri: result.uri.toString(),
            languageId: result.languageId,
            version: result.version
        };
    }

    public toConcatTextDocument(cell: protocol.TextDocumentIdentifier): ITextDocument {
        return this.getConcatDocument(cell);
    }

    public toConcatUri(cell: protocol.TextDocumentIdentifier | string): string {
        const result = this.getConcatDocument(cell);
        return result.concatUri.toString();
    }

    public toConcatPosition(cell: protocol.TextDocumentIdentifier, position: protocol.Position): protocol.Position {
        const concat = this.getConcatDocument(cell);
        return concat.concatPositionAt(createLocation(cell.uri, createRange(position, position)));
    }

    public toConcatPositions(cell: protocol.TextDocumentIdentifier, positions: protocol.Position[]) {
        return positions.map((p) => this.toConcatPosition(cell, p));
    }

    public toConcatRange(
        cell: protocol.TextDocumentIdentifier | string,
        cellRange: protocol.Range | undefined
    ): protocol.Range {
        const concat = this.getConcatDocument(cell);

        const uri = this.toURI(cell);
        const range = concat.concatRangeOf(uri);
        return range || cellRange || createRange(createPosition(0, 0), createPosition(0, 0));
    }

    public toRealRange(
        cell: protocol.TextDocumentIdentifier | string,
        cellRange: protocol.Range | undefined
    ): protocol.Range {
        const concat = this.getConcatDocument(cell);

        const uri = this.toURI(cell);
        const range = concat.realRangeOf(uri);
        return range || cellRange || createRange(createPosition(0, 0), createPosition(0, 0));
    }

    public toConcatContext(
        cell: protocol.TextDocumentIdentifier,
        context: protocol.CodeActionContext
    ): protocol.CodeActionContext {
        return {
            ...context,
            diagnostics: context.diagnostics.map(this.toConcatDiagnostic.bind(this, cell))
        };
    }

    public toNotebookHover(
        cell: protocol.TextDocumentIdentifier,
        hover: protocol.Hover | null | undefined
    ): protocol.Hover | undefined {
        if (hover && hover.range) {
            return {
                ...hover,
                range: this.toNotebookRange(cell, hover.range)
            };
        }
        return hover ?? undefined;
    }

    // eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
    public toNotebookCompletions(
        cell: protocol.TextDocumentIdentifier,
        completions: protocol.CompletionItem[] | protocol.CompletionList | null | undefined
    ) {
        if (completions) {
            if (Array.isArray(completions)) {
                return completions.map(this.toNotebookCompletion.bind(this, cell));
            }
            return {
                ...completions,
                items: completions.items.map(this.toNotebookCompletion.bind(this, cell))
            };
        }
        return completions;
    }

    // eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
    public toNotebookLocations(
        location:
            | protocol.Definition
            | protocol.Location
            | protocol.Location[]
            | protocol.LocationLink[]
            | null
            | undefined
    ) {
        if (Array.isArray(location)) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            return (<any>location).map(this.toNotebookLocationOrLink.bind(this));
        }
        if (location?.range) {
            return this.toNotebookRange(location.uri, location.range);
        }
        return location;
    }

    public toNotebookHighlight(
        cell: protocol.TextDocumentIdentifier,
        highlight: protocol.DocumentHighlight[] | null | undefined
    ): protocol.DocumentHighlight[] | undefined {
        if (!highlight) {
            return undefined;
        }

        const concat = this.getConcatDocument(cell);
        const result: protocol.DocumentHighlight[] = [];
        for (let h of highlight) {
            const loc = concat.notebookLocationAt(h.range);
            if (loc.uri.toString() === cell.uri.toString()) {
                result.push({ ...h, range: loc.range });
            }
        }
        return result;
    }

    // eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
    public toNotebookSymbols(
        cell: protocol.TextDocumentIdentifier,
        symbols: protocol.SymbolInformation[] | protocol.DocumentSymbol[] | null | undefined
    ) {
        if (symbols && Array.isArray(symbols) && symbols.length) {
            if ('kind' in symbols[0]) {
                return (<protocol.SymbolInformation[]>symbols).map(
                    this.toNotebookSymbolFromSymbolInformation.bind(this, cell.uri)
                );
            }
            return (<protocol.DocumentSymbol[]>symbols).map(this.toNotebookSymbolFromDocumentSymbol.bind(this, cell));
        }
        return symbols ?? undefined;
    }

    public toNotebookSymbolFromSymbolInformation(
        cellOrConcatUri: protocol.TextDocumentIdentifier | string,
        symbol: protocol.SymbolInformation
    ): protocol.SymbolInformation {
        return {
            ...symbol,
            location: this.toNotebookLocationFromRange(cellOrConcatUri, symbol.location.range)
        };
    }

    public toNotebookDiagnostic(
        cell: protocol.TextDocumentIdentifier | string,
        diagnostic: protocol.Diagnostic
    ): protocol.Diagnostic {
        return {
            ...diagnostic,
            range: this.toNotebookRange(cell, diagnostic.range),
            relatedInformation: diagnostic.relatedInformation
                ? diagnostic.relatedInformation.map(this.toNotebookRelatedInformation.bind(this, cell))
                : undefined
        };
    }

    // eslint-disable-next-line class-methods-use-this
    public toNotebookActions(
        _cell: protocol.TextDocumentIdentifier,
        actions: (protocol.Command | protocol.CodeAction)[] | null | undefined
    ): undefined {
        if (Array.isArray(actions)) {
            // Disable for now because actions are handled directly by the LS sometimes (at least in pylance)
            // If we translate or use them they will either
            // 1) Do nothing because the LS doesn't know about the ipynb
            // 2) Crash (pylance is doing this now)
            return undefined;
        }
        return actions ?? undefined;
    }

    public toNotebookCodeLenses(
        cell: protocol.TextDocumentIdentifier,
        lenses: protocol.CodeLens[] | null | undefined
    ): protocol.CodeLens[] | undefined {
        if (Array.isArray(lenses)) {
            return lenses.map((c) => ({
                ...c,
                range: this.toNotebookRange(cell, c.range)
            }));
        }
        return lenses ?? undefined;
    }

    public toNotebookEdits(
        cell: protocol.TextDocumentIdentifier,
        edits: protocol.TextEdit[] | null | undefined
    ): protocol.TextEdit[] | undefined {
        if (Array.isArray(edits)) {
            return edits.map((e) => ({
                ...e,
                range: this.toNotebookRange(cell, e.range)
            }));
        }
        return edits ?? undefined;
    }

    public toNotebookRename(
        cell: protocol.TextDocumentIdentifier,
        rangeOrRename:
            | protocol.Range
            | {
                  range: protocol.Range;
                  placeholder: string;
              }
            | null
            | undefined
    ):
        | protocol.Range
        | {
              range: protocol.Range;
              placeholder: string;
          }
        | undefined {
        if (rangeOrRename) {
            if ('range' in rangeOrRename) {
                return {
                    ...rangeOrRename,
                    range: this.toNotebookRange(cell, rangeOrRename.range)
                };
            }
            return this.toNotebookRange(cell, rangeOrRename);
        }
        return rangeOrRename ?? undefined;
    }

    public toNotebookDocumentLinks(
        cell: protocol.TextDocumentIdentifier,
        links: protocol.DocumentLink[] | null | undefined
    ): protocol.DocumentLink[] | undefined {
        if (links && Array.isArray(links)) {
            return links.map((l) => {
                const uri = l.target ? l.target : cell.uri;
                const location = this.toNotebookLocationFromRange(uri, l.range);
                return {
                    ...l,
                    range: location.range,
                    target: l.target ? location.uri : undefined
                };
            });
        }
        return links ?? undefined;
    }

    public toNotebookRange(
        cellOrConcatUri: protocol.TextDocumentIdentifier | string,
        range: protocol.Range
    ): protocol.Range {
        // This is dangerous as the URI is not remapped (location uri may be different)
        const concat = this.getConcatDocumentForUri(cellOrConcatUri);
        if (concat) {
            const startLoc = concat.notebookLocationAt(range.start);
            const endLoc = concat.notebookLocationAt(range.end);
            return createRange(startLoc.range.start, endLoc.range.end);
        }

        return range;
    }

    public toNotebookPosition(
        cell: protocol.TextDocumentIdentifier | string,
        position: protocol.Position
    ): protocol.Position {
        // This is dangerous as the URI is not remapped (location uri may be different)
        return this.toNotebookRange(cell, createRange(position, position)).start;
    }

    public toNotebookOffset(cell: protocol.TextDocumentIdentifier | string, offset: number): number {
        const uri = this.toURI(cell);
        const concat = this.getConcatDocument(cell);
        return concat.notebookOffsetAt(uri, offset);
    }

    public toNotebookUri(uri: string, range?: protocol.Range) {
        const concat = this.getConcatDocumentForUri(uri);
        let result: string | undefined;
        if (concat) {
            if (range) {
                const location = concat.notebookLocationAt(range);
                result = location.uri;
            } else {
                result = concat.notebookUri.toString();
            }
        }

        return result || uri;
    }

    public toNotebookColorInformations(
        cell: protocol.TextDocumentIdentifier | string,
        colorInformations: protocol.ColorInformation[] | null | undefined
    ) {
        if (Array.isArray(colorInformations)) {
            const cellUri = this.toURI(cell);
            // Need to filter out color information for other cells. Pylance
            // will return it for all.
            return colorInformations
                .map((c) => {
                    return {
                        color: c.color,
                        location: this.toNotebookLocationFromRange(cell, c.range)
                    };
                })
                .filter((cl) => vscodeUri.URI.parse(cl.location.uri).fragment == cellUri.fragment)
                .map((cl) => {
                    return {
                        color: cl.color,
                        range: cl.location.range
                    };
                });
        }
    }

    public toNotebookColorPresentations(
        cell: protocol.TextDocumentIdentifier | string,
        colorPresentations: protocol.ColorPresentation[] | null | undefined
    ) {
        if (Array.isArray(colorPresentations)) {
            return colorPresentations.map((c) => {
                return {
                    ...c,
                    additionalTextEdits: c.additionalTextEdits
                        ? this.toNotebookTextEdits(cell, c.additionalTextEdits)
                        : undefined,
                    textEdit: c.textEdit ? this.toNotebookTextEdit(cell, c.textEdit) : undefined
                };
            });
        }
    }

    public toNotebookTextEdits(
        cell: protocol.TextDocumentIdentifier | string,
        textEdits: protocol.TextEdit[] | null | undefined
    ) {
        if (Array.isArray(textEdits)) {
            return textEdits.map((t) => this.toNotebookTextEdit(cell, t));
        }
    }

    public toNotebookTextEdit(cell: protocol.TextDocumentIdentifier | string, textEdit: protocol.TextEdit) {
        return {
            ...textEdit,
            range: this.toNotebookRange(cell, textEdit.range)
        };
    }

    public toNotebookFoldingRanges(
        cell: protocol.TextDocumentIdentifier | string,
        ranges: protocol.FoldingRange[] | null | undefined
    ): protocol.FoldingRange[] | null | undefined {
        if (Array.isArray(ranges)) {
            const cellUri = this.toURI(cell);
            return ranges
                .map((r) =>
                    this.toNotebookLocationFromRange(
                        cell,
                        createRange(createPosition(r.startLine, 0), createPosition(r.endLine, 0))
                    )
                )
                .filter((l) => l.uri == cellUri.toString())
                .map((l) => {
                    return {
                        startLine: l.range.start.line,
                        endLine: l.range.end.line
                    };
                });
        }
    }

    public toNotebookSelectionRanges(
        cell: protocol.TextDocumentIdentifier | string,
        ranges: protocol.SelectionRange[] | null | undefined
    ) {
        if (Array.isArray(ranges)) {
            return ranges.map((r) => this.toNotebookSelectionRange(cell, r));
        }
    }

    public toNotebookSelectionRange(
        cell: protocol.TextDocumentIdentifier | string,
        range: protocol.SelectionRange
    ): protocol.SelectionRange {
        return {
            parent: range.parent ? this.toNotebookSelectionRange(cell, range.parent) : undefined,
            range: this.toNotebookRange(cell, range.range)
        };
    }

    public toNotebookCallHierarchyItems(
        cell: protocol.TextDocumentIdentifier | string,
        items: protocol.CallHierarchyItem | protocol.CallHierarchyItem[] | null | undefined
    ) {
        if (Array.isArray(items)) {
            return items.map((r) => this.toNotebookCallHierarchyItem(cell, r));
        } else if (items) {
            return [this.toNotebookCallHierarchyItem(cell, items)];
        }
        return null;
    }

    public toNotebookCallHierarchyItem(
        cell: protocol.TextDocumentIdentifier | string,
        item: protocol.CallHierarchyItem
    ): protocol.CallHierarchyItem {
        return {
            ...item,
            uri: this.toURI(cell).toString(),
            range: this.toNotebookRange(cell, item.range),
            selectionRange: this.toNotebookRange(cell, item.selectionRange)
        };
    }

    public toNotebookCallHierarchyIncomingCallItems(
        cell: protocol.TextDocumentIdentifier | string,
        items: protocol.CallHierarchyIncomingCall[] | null | undefined
    ) {
        if (Array.isArray(items)) {
            return items.map((r) => this.toNotebookCallHierarchyIncomingCallItem(cell, r));
        }
        return null;
    }

    public toNotebookCallHierarchyIncomingCallItem(
        cell: protocol.TextDocumentIdentifier | string,
        item: protocol.CallHierarchyIncomingCall
    ): protocol.CallHierarchyIncomingCall {
        return {
            from: this.toNotebookCallHierarchyItem(cell, item.from),
            fromRanges: item.fromRanges.map((r) => this.toNotebookRange(cell, r))
        };
    }

    public toNotebookCallHierarchyOutgoingCallItems(
        cell: protocol.TextDocumentIdentifier | string,
        items: protocol.CallHierarchyOutgoingCall[] | null | undefined
    ) {
        if (Array.isArray(items)) {
            return items.map((r) => this.toNotebookCallHierarchyOutgoingCallItem(cell, r));
        }
        return null;
    }

    public toNotebookCallHierarchyOutgoingCallItem(
        cell: protocol.TextDocumentIdentifier | string,
        item: protocol.CallHierarchyOutgoingCall
    ): protocol.CallHierarchyOutgoingCall {
        return {
            to: this.toNotebookCallHierarchyItem(cell, item.to),
            fromRanges: item.fromRanges.map((r) => this.toNotebookRange(cell, r))
        };
    }

    public toNotebookSemanticEdit(
        cell: protocol.TextDocumentIdentifier | string,
        edit: protocol.SemanticTokensEdit
    ): protocol.SemanticTokensEdit {
        return {
            ...edit,
            start: this.toNotebookOffset(cell, edit.start)
        };
    }

    public toNotebookSemanticTokens(
        cell: protocol.TextDocumentIdentifier | string,
        tokens: protocol.SemanticTokens | null | undefined
    ) {
        if (tokens) {
            const concat = this.getConcatDocument(cell);
            const cellUri = this.toURI(cell);
            // First line offset is the wrong number. It is from the beginning of the concat doc and not the
            // cell.
            if (concat && tokens.data.length > 0) {
                const startOfCell = concat.concatPositionAt(
                    createLocation(cellUri.toString(), createRange(createPosition(0, 0), createPosition(0, 0)))
                );

                // Note to self: If tokenization stops working, might be pylance's fault. It does handle
                // range requests but was returning stuff outside the range.

                // Rewrite the first item by offsetting from the start of the cell. All other entries
                // are offset from this one, so they don't need to be rewritten
                tokens.data[0] = tokens.data[0] - startOfCell.line;

                // Data array should have been updated.
                return tokens;
            }
        }
        return undefined;
    }

    public toNotebookLinkedEditingRanges(
        cell: protocol.TextDocumentIdentifier | string,
        items: protocol.LinkedEditingRanges | null | undefined
    ) {
        if (items) {
            return {
                ...items,
                ranges: items.ranges.map((e) => this.toNotebookRange(cell, e))
            };
        }
    }

    public remove(cell: protocol.TextDocumentIdentifier) {
        const uri = this.toURI(cell);
        const key = NotebookConverter.getDocumentKey(uri);
        const concat = this.activeConcats.get(key);
        if (concat) {
            this.deleteConcatDocument(concat);
        }
    }

    private toURI(input: protocol.TextDocumentIdentifier | string | vscodeUri.URI): vscodeUri.URI {
        if (vscodeUri.URI.isUri(input)) {
            return input;
        }

        return typeof input === 'string' ? vscodeUri.URI.parse(input) : vscodeUri.URI.parse(input.uri);
    }

    private toNotebookWorkspaceSymbol(symbol: protocol.SymbolInformation): protocol.SymbolInformation {
        // Figure out what cell if any the symbol is for
        return this.toNotebookSymbolFromSymbolInformation(symbol.location.uri, symbol);
    }

    /* Renable this if actions can be translated
    private toNotebookAction(cell: protocol.TextDocumentIdentifier, action: Command | CodeAction): Command | CodeAction {
        if (action instanceof CodeAction) {
            return {
                ...action,
                command: action.command ? this.toNotebookCommand(cell, action.command) : undefined,
                diagnostics: action.diagnostics
                    ? action.diagnostics.map(this.toNotebookDiagnostic.bind(this, cell))
                    : undefined
            };
        }
        return this.toNotebookCommand(cell, action);
    }

    private toNotebookCommand(cell: protocol.TextDocumentIdentifier, command: Command): Command {
        return {
            ...command,
            arguments: command.arguments ? command.arguments.map(this.toNotebookArgument.bind(this, cell)) : undefined
        };
    }


    private toNotebookArgument(cell: protocol.TextDocumentIdentifier, argument: any): any {
        // URIs in a command should be remapped to the cell document if part
        // of one of our open notebooks
        if (isUri(argument)) {
            const concat = this.getWrapperFromOutgoingUri(argument);
            if (concat) {
                return cell.uri;
            }
        }
        if (typeof argument === 'string' && argument.includes(NotebookConcatPrefix)) {
            const concat = this.getWrapperFromOutgoingUri(Uri.file(argument));
            if (concat) {
                return cell.uri;
            }
        }
        if (typeof argument === 'object' && argument.hasOwnProperty('start') && argument.hasOwnProperty('end')) {
            // This is a range like object. Convert it too.
            return this.toNotebookRange(cell, this.toRange(<protocol.Range>argument));
        }
        if (typeof argument === 'object' && argument.hasOwnProperty('line') && argument.hasOwnProperty('character')) {
            // This is a position like object. Convert it too.
            return this.toNotebookPosition(cell, this.toPosition(<protocol.Position>argument));
        }
        return argument;
    }
    */

    private toConcatDiagnostic(
        cell: protocol.TextDocumentIdentifier,
        diagnostic: protocol.Diagnostic
    ): protocol.Diagnostic {
        return {
            ...diagnostic,
            range: this.toConcatRange(cell, diagnostic.range),
            relatedInformation: diagnostic.relatedInformation
                ? diagnostic.relatedInformation.map(this.toConcatRelatedInformation.bind(this, cell))
                : undefined
        };
    }

    private toConcatRelatedInformation(
        cell: protocol.TextDocumentIdentifier,
        relatedInformation: protocol.DiagnosticRelatedInformation
    ): protocol.DiagnosticRelatedInformation {
        const outgoingDoc = this.toConcatDocument(cell);
        return {
            ...relatedInformation,
            location:
                relatedInformation.location.uri === outgoingDoc.uri
                    ? this.toConcatLocation(cell, relatedInformation.location)
                    : relatedInformation.location
        };
    }

    private toConcatLocation(cell: protocol.TextDocumentIdentifier, location: protocol.Location): protocol.Location {
        return {
            uri: this.toConcatDocument(cell).uri,
            range: this.toConcatRange(cell, location.range)
        };
    }

    private toNotebookRelatedInformation(
        cell: protocol.TextDocumentIdentifier | string,
        relatedInformation: protocol.DiagnosticRelatedInformation
    ): protocol.DiagnosticRelatedInformation {
        const outgoingUri = this.toConcatUri(cell);
        return {
            ...relatedInformation,
            location:
                relatedInformation.location.uri === outgoingUri
                    ? this.toNotebookLocationFromLocation(relatedInformation.location)
                    : relatedInformation.location
        };
    }

    private toNotebookSymbolFromDocumentSymbol(
        cell: protocol.TextDocumentIdentifier,
        docSymbol: protocol.DocumentSymbol
    ): protocol.DocumentSymbol {
        return docSymbol.children
            ? {
                  ...docSymbol,
                  range: this.toNotebookRange(cell, docSymbol.range),
                  selectionRange: this.toNotebookRange(cell, docSymbol.selectionRange),
                  children: docSymbol.children.map(this.toNotebookSymbolFromDocumentSymbol.bind(this, cell))
              }
            : {
                  ...docSymbol,
                  range: this.toNotebookRange(cell, docSymbol.range),
                  selectionRange: this.toNotebookRange(cell, docSymbol.selectionRange)
              };
    }

    private toNotebookLocationFromLocation(location: protocol.Location): protocol.Location {
        const uri = this.toNotebookUri(location.uri, location.range);
        return {
            uri,
            range: this.toNotebookRange(uri, location.range)
        };
    }

    private toNotebookLocationLinkFromLocationLink(locationLink: protocol.LocationLink): protocol.LocationLink {
        const uri = this.toNotebookUri(locationLink.targetUri, locationLink.targetRange);

        return {
            originSelectionRange: locationLink.originSelectionRange
                ? this.toNotebookRange(uri, locationLink.originSelectionRange)
                : undefined,
            targetUri: uri,
            targetRange: this.toNotebookRange(uri, locationLink.targetRange),
            targetSelectionRange: this.toNotebookRange(uri, locationLink.targetSelectionRange)
        };
    }

    private toNotebookLocationOrLink(location: protocol.Location | protocol.LocationLink) {
        // Split on if we are dealing with a Location or a LocationLink
        if ('targetUri' in location) {
            // targetUri only for LocationLinks
            return this.toNotebookLocationLinkFromLocationLink(location);
        }
        return this.toNotebookLocationFromLocation(location);
    }

    private toNotebookCompletion(
        cell: protocol.TextDocumentIdentifier,
        item: protocol.CompletionItem
    ): protocol.CompletionItem {
        const itemAny = item as any;

        // Range is not supported in the official stuff yet
        if (itemAny.range) {
            if (itemAny.range.inserting) {
                return {
                    ...item,
                    range: {
                        inserting: this.toNotebookRange(cell, itemAny.range.inserting),
                        replacing: this.toNotebookRange(cell, itemAny.range.replacing)
                    }
                } as any;
            }
            return {
                ...item,
                range: this.toNotebookRange(cell, itemAny.range)
            } as any;
        }
        return item;
    }

    private toNotebookLocationFromRange(
        cellOrConcatUri: protocol.TextDocumentIdentifier | string,
        range: protocol.Range
    ): protocol.Location {
        const concat = this.getConcatDocumentForUri(cellOrConcatUri);
        if (concat) {
            const startLoc = concat.notebookLocationAt(range.start);
            const endLoc = concat.notebookLocationAt(range.end);
            return {
                uri: startLoc.uri,
                range: createRange(startLoc.range.start, endLoc.range.end)
            };
        }

        return {
            uri: protocol.TextDocumentIdentifier.is(cellOrConcatUri) ? cellOrConcatUri.uri : cellOrConcatUri,
            range
        };
    }

    private deleteConcatDocument(concat: NotebookConcatDocument) {
        // Cleanup both maps and dispose of the concat (disconnects the cell change emitter)
        this.activeConcatsOutgoingMap.delete(NotebookConverter.getDocumentKey(concat.concatUri));
        this.activeConcats.delete(concat.key);
        concat.dispose();
    }

    private getConcatDocumentForUri(input: protocol.TextDocumentIdentifier | vscodeUri.URI | string) {
        const uri = this.toURI(input);

        return isNotebookCell(uri) ? this.getConcatDocument(uri) : this.getConcatFromOutgoingUri(uri);
    }

    public getConcatFromOutgoingUri(
        concatDocIdOrUri: protocol.TextDocumentIdentifier | string | vscodeUri.URI
    ): NotebookConcatDocument | undefined {
        const uri = this.toURI(concatDocIdOrUri);
        return this.activeConcatsOutgoingMap.get(NotebookConverter.getDocumentKey(uri));
    }

    // Public for testing
    public getConcatDocument(
        cellIdOrUri: protocol.TextDocumentIdentifier | string | vscodeUri.URI
    ): NotebookConcatDocument {
        const uri = this.toURI(cellIdOrUri);
        const key = NotebookConverter.getDocumentKey(uri);
        let result = this.activeConcats.get(key);
        if (!result) {
            result = new NotebookConcatDocument(key, this.getNotebookHeader);
            this.activeConcats.set(key, result);
        }
        return result;
    }
}
