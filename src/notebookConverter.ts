// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
import * as os from 'os';
import {
    CodeAction,
    CodeActionContext,
    CodeLens,
    Command,
    CompletionItem,
    CompletionList,
    Diagnostic,
    DiagnosticRelatedInformation,
    Disposable,
    DocumentHighlight,
    DocumentLink,
    DocumentSymbol,
    Hover,
    Location,
    LocationLink,
    Position,
    Range,
    SymbolInformation,
    TextDocument,
    TextDocumentChangeEvent,
    TextEdit,
    Uri,
    WorkspaceEdit,
    NotebookDocument,
    DocumentSelector,
    Definition,
    ColorInformation,
    ColorPresentation,
    FoldingRange,
    SelectionRange,
    CallHierarchyItem,
    CallHierarchyIncomingCall,
    CallHierarchyOutgoingCall,
    SemanticTokens,
    SemanticTokensEdits,
    SemanticTokensEdit,
    LinkedEditingRanges
} from 'vscode';
import { InteractiveInputScheme, InteractiveScheme, NotebookCellScheme } from './common/utils';
import * as path from 'path';
import { NotebookWrapper } from './notebookWrapper';

/**
 * Class responsible for converting incoming requests to outgoing types based on a concatenated document instead.
 */
export class NotebookConverter implements Disposable {
    private activeWrappers: Map<string, NotebookWrapper> = new Map<string, NotebookWrapper>();

    private pendingCloseWrappers: Map<string, NotebookWrapper> = new Map<string, NotebookWrapper>();

    private activeWrappersOutgoingMap: Map<string, NotebookWrapper> = new Map<string, NotebookWrapper>();

    private disposables: Disposable[] = [];

    private mapOfConcatDocumentsWithCellUris = new Map<string, string[]>();

    constructor(private cellSelector: DocumentSelector) {}

    private static getDocumentKey(uri: Uri): string {
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

    public hasCell(cell: TextDocument): boolean {
        const wrapper = this.getTextDocumentWrapper(cell);
        return wrapper?.contains(cell.uri) ?? false;
    }

    public isOpen(cell: TextDocument): boolean | undefined {
        const wrapper = this.getTextDocumentWrapper(cell);
        if (wrapper) {
            return wrapper.isOpen;
        }
        return undefined;
    }

    public handleOpen(cell: TextDocument) {
        const wrapper = this.getTextDocumentWrapper(cell);
        const results = wrapper?.handleOpen(cell);
        if (wrapper) {
            // concat uri is empty until a cell is added.
            this.activeWrappersOutgoingMap.set(NotebookConverter.getDocumentKey(wrapper.concatUri), wrapper);
        }
        return results;
    }

    public handleRefresh(notebook: NotebookDocument) {
        // Find the wrapper for any of the cells
        const wrapper =
            notebook.cellCount > 0 ? this.getTextDocumentWrapper(notebook.getCells()[0].document) : undefined;
        return wrapper?.handleRefresh(notebook);
    }

    public handleClose(cell: TextDocument) {
        const wrapper = this.getTextDocumentWrapper(cell);
        return wrapper?.handleClose(cell);
    }

    public handleChange(event: TextDocumentChangeEvent) {
        const wrapper = this.getTextDocumentWrapper(event.document);
        return wrapper?.handleChange(event);
    }

    public toNotebookDiagnosticsMap(uri: Uri, diagnostics: Diagnostic[]): Map<Uri, Diagnostic[]> {
        const wrapper = this.getWrapperFromOutgoingUri(uri);
        const result = new Map<Uri, Diagnostic[]>();

        if (wrapper) {
            // Diagnostics are supposed to be per file and are updated each time
            // Make sure to clear out old ones first
            const cellUris: string[] = [];
            const oldCellUris = this.mapOfConcatDocumentsWithCellUris.get(uri.toString()) || [];
            wrapper.getCells().forEach((uri) => {
                result.set(uri, []);
                cellUris.push(uri.toString());
            });
            // Possible some cells were deleted, we need to clear the diagnostics of those cells as well.
            const currentCellUris = new Set(cellUris);
            oldCellUris
                .filter((cellUri) => !currentCellUris.has(cellUri))
                .forEach((cellUri) => result.set(Uri.parse(cellUri), []));
            this.mapOfConcatDocumentsWithCellUris.set(uri.toString(), cellUris);

            // Then for all the new ones, set their values.
            diagnostics.forEach((d) => {
                const location = wrapper.notebookLocationAt(d.range);
                let list = result.get(location.uri);
                if (!list) {
                    list = [];
                    result.set(location.uri, list);
                }
                list.push(this.toNotebookDiagnostic(location.uri, d));
            });
        } else if (this.mapOfConcatDocumentsWithCellUris.has(uri.toString())) {
            (this.mapOfConcatDocumentsWithCellUris.get(uri.toString()) || [])
                .map((cellUri) => Uri.parse(cellUri))
                .forEach((cellUri) => result.set(cellUri, []));
            this.mapOfConcatDocumentsWithCellUris.delete(uri.toString());
        } else {
            result.set(uri, diagnostics);
        }

        return result;
    }

    // eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
    public toNotebookWorkspaceSymbols(symbols: SymbolInformation[] | null | undefined) {
        if (Array.isArray(symbols)) {
            return symbols.map(this.toNotebookWorkspaceSymbol.bind(this));
        }
        return symbols ?? undefined;
    }

    public toNotebookWorkspaceEdit(workspaceEdit: WorkspaceEdit | null | undefined): WorkspaceEdit | undefined {
        if (workspaceEdit) {
            // Translate all of the text edits into a URI map
            const translated = new Map<Uri, TextEdit[]>();
            workspaceEdit.entries().forEach(([key, values]) => {
                values.forEach((e) => {
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
            const newWorkspaceEdit = new WorkspaceEdit();
            translated.forEach((v, k) => newWorkspaceEdit.set(k, v));
            return newWorkspaceEdit;
        }
        return workspaceEdit ?? undefined;
    }

    public toConcatDocument(cell: TextDocument): TextDocument {
        const result = this.getTextDocumentWrapper(cell);
        return result?.getConcatDocument() || cell;
    }

    public toConcatUri(cell: TextDocument | Uri): Uri {
        const uri = cell instanceof Uri ? <Uri>cell : cell.uri;
        const result = this.getTextDocumentWrapper(cell);
        return result ? result.concatUri : uri;
    }

    public toConcatPosition(cell: TextDocument, position: Position): Position {
        const wrapper = this.getTextDocumentWrapper(cell);
        return wrapper ? wrapper.concatPositionAt(new Location(cell.uri, position)) : position;
    }

    public toConcatPositions(cell: TextDocument, positions: Position[]) {
        return positions.map((p) => this.toConcatPosition(cell, p));
    }

    public toConcatRange(cell: TextDocument | Uri, cellRange: Range | undefined): Range {
        const wrapper = this.getTextDocumentWrapper(cell);
        if (wrapper) {
            const uri = cell instanceof Uri ? <Uri>cell : cell.uri;
            const range = wrapper.concatRangeOf(uri);
            return range || cellRange || new Range(new Position(0, 0), new Position(0, 0));
        }
        return cellRange || new Range(new Position(0, 0), new Position(0, 0));
    }

    public toRealRange(cell: TextDocument | Uri, cellRange: Range | undefined): Range {
        const wrapper = this.getTextDocumentWrapper(cell);
        if (wrapper) {
            const uri = cell instanceof Uri ? <Uri>cell : cell.uri;
            const range = wrapper.realRangeOf(uri);
            return range || cellRange || new Range(new Position(0, 0), new Position(0, 0));
        }
        return cellRange || new Range(new Position(0, 0), new Position(0, 0));
    }

    public toConcatContext(cell: TextDocument, context: CodeActionContext): CodeActionContext {
        return {
            ...context,
            diagnostics: context.diagnostics.map(this.toConcatDiagnostic.bind(this, cell))
        };
    }

    public toNotebookHover(cell: TextDocument, hover: Hover | null | undefined): Hover | undefined {
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
        cell: TextDocument,
        completions: CompletionItem[] | CompletionList | null | undefined
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
    public toNotebookLocations(location: Definition | Location | Location[] | LocationLink[] | null | undefined) {
        if (Array.isArray(location)) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            return (<any>location).map(this.toNotebookLocationOrLink.bind(this));
        }
        if (location?.range) {
            return this.toNotebookLocationFromRange(location.uri, location.range);
        }
        return location;
    }

    public toNotebookHighlight(
        cell: TextDocument,
        highlight: DocumentHighlight[] | null | undefined
    ): DocumentHighlight[] | undefined {
        if (!highlight) {
            return undefined;
        }
        const wrapper = this.getTextDocumentWrapper(cell);
        if (!wrapper) {
            return undefined;
        }
        const result: DocumentHighlight[] = [];
        for (let h of highlight) {
            const loc = wrapper.notebookLocationAt(h.range);
            if (loc.uri.toString() === cell.uri.toString()) {
                result.push({ ...h, range: loc.range });
            }
        }
        return result;
    }

    // eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
    public toNotebookSymbols(cell: TextDocument, symbols: SymbolInformation[] | DocumentSymbol[] | null | undefined) {
        if (symbols && Array.isArray(symbols) && symbols.length) {
            if (symbols[0] instanceof DocumentSymbol) {
                return (<DocumentSymbol[]>symbols).map(this.toNotebookSymbolFromDocumentSymbol.bind(this, cell));
            }
            return (<SymbolInformation[]>symbols).map(this.toNotebookSymbolFromSymbolInformation.bind(this, cell.uri));
        }
        return symbols ?? undefined;
    }

    public toNotebookSymbolFromSymbolInformation(cellUri: Uri, symbol: SymbolInformation): SymbolInformation {
        return {
            ...symbol,
            location: this.toNotebookLocationFromRange(cellUri, symbol.location.range)
        };
    }

    public toNotebookDiagnostic(cell: TextDocument | Uri, diagnostic: Diagnostic): Diagnostic {
        return {
            ...diagnostic,
            range: this.toNotebookRange(cell, diagnostic.range),
            relatedInformation: diagnostic.relatedInformation
                ? diagnostic.relatedInformation.map(this.toNotebookRelatedInformation.bind(this, cell))
                : undefined
        };
    }

    // eslint-disable-next-line class-methods-use-this
    public toNotebookActions(_cell: TextDocument, actions: (Command | CodeAction)[] | null | undefined): undefined {
        if (Array.isArray(actions)) {
            // Disable for now because actions are handled directly by the LS sometimes (at least in pylance)
            // If we translate or use them they will either
            // 1) Do nothing because the LS doesn't know about the ipynb
            // 2) Crash (pylance is doing this now)
            return undefined;
        }
        return actions ?? undefined;
    }

    public toNotebookCodeLenses(cell: TextDocument, lenses: CodeLens[] | null | undefined): CodeLens[] | undefined {
        if (Array.isArray(lenses)) {
            return lenses.map((c) => ({
                ...c,
                range: this.toNotebookRange(cell, c.range)
            }));
        }
        return lenses ?? undefined;
    }

    public toNotebookEdits(cell: TextDocument, edits: TextEdit[] | null | undefined): TextEdit[] | undefined {
        if (Array.isArray(edits)) {
            return edits.map((e) => ({
                ...e,
                range: this.toNotebookRange(cell, e.range)
            }));
        }
        return edits ?? undefined;
    }

    public toNotebookRename(
        cell: TextDocument,
        rangeOrRename:
            | Range
            | {
                  range: Range;
                  placeholder: string;
              }
            | null
            | undefined
    ):
        | Range
        | {
              range: Range;
              placeholder: string;
          }
        | undefined {
        if (rangeOrRename) {
            if (rangeOrRename instanceof Range) {
                return this.toNotebookLocationFromRange(cell, rangeOrRename).range;
            }
            return {
                ...rangeOrRename,
                range: this.toNotebookLocationFromRange(cell, rangeOrRename.range).range
            };
        }
        return rangeOrRename ?? undefined;
    }

    public toNotebookDocumentLinks(
        cell: TextDocument,
        links: DocumentLink[] | null | undefined
    ): DocumentLink[] | undefined {
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

    public toNotebookRange(cell: TextDocument | Uri, range: Range): Range {
        // This is dangerous as the URI is not remapped (location uri may be different)
        return this.toNotebookLocationFromRange(cell, range).range;
    }

    public toNotebookPosition(cell: TextDocument | Uri, position: Position): Position {
        // This is dangerous as the URI is not remapped (location uri may be different)
        return this.toNotebookLocationFromRange(cell, new Range(position, position)).range.start;
    }

    public toNotebookOffset(cell: TextDocument | Uri, offset: number): number {
        const uri = cell instanceof Uri ? <Uri>cell : cell.uri;
        const wrapper = this.getWrapperFromOutgoingUri(uri);
        if (wrapper) {
            return wrapper.notebookOffsetAt(uri, offset);
        }
        return offset;
    }

    public toNotebookUri(outgoingUri: Uri, range?: Range) {
        const wrapper = this.getWrapperFromOutgoingUri(outgoingUri);
        let result: Uri | undefined;
        if (wrapper) {
            if (range) {
                const location = wrapper.notebookLocationAt(range);
                result = location.uri;
            } else {
                result = wrapper.notebookUri;
            }
        }
        // Might be deleted, check for pending delete
        if (!result) {
            this.pendingCloseWrappers.forEach((n) => {
                if (this.arePathsSame(n.concatUri.fsPath, outgoingUri.fsPath)) {
                    result = n.notebookUri;
                }
            });
        }
        return result || outgoingUri;
    }

    public toNotebookColorInformations(cellUri: Uri, colorInformations: ColorInformation[] | null | undefined) {
        if (Array.isArray(colorInformations)) {
            // Need to filter out color information for other cells. Pylance
            // will return it for all.
            return colorInformations
                .map((c) => {
                    return {
                        color: c.color,
                        location: this.toNotebookLocationFromRange(cellUri, c.range)
                    };
                })
                .filter((cl) => cl.location.uri.fragment == cellUri.fragment)
                .map((cl) => {
                    return {
                        color: cl.color,
                        range: cl.location.range
                    };
                });
        }
    }

    public toNotebookColorPresentations(cellUri: Uri, colorPresentations: ColorPresentation[] | null | undefined) {
        if (Array.isArray(colorPresentations)) {
            return colorPresentations.map((c) => {
                return {
                    ...c,
                    additionalTextEdits: c.additionalTextEdits
                        ? this.toNotebookTextEdits(cellUri, c.additionalTextEdits)
                        : undefined,
                    textEdit: c.textEdit ? this.toNotebookTextEdit(cellUri, c.textEdit) : undefined
                };
            });
        }
    }

    public toNotebookTextEdits(cellUri: Uri, textEdits: TextEdit[] | null | undefined) {
        if (Array.isArray(textEdits)) {
            return textEdits.map((t) => this.toNotebookTextEdit(cellUri, t));
        }
    }

    public toNotebookTextEdit(cellUri: Uri, textEdit: TextEdit) {
        return {
            ...textEdit,
            range: this.toNotebookRange(cellUri, textEdit.range)
        };
    }

    public toNotebookFoldingRanges(cellUri: Uri, ranges: FoldingRange[] | null | undefined) {
        if (Array.isArray(ranges)) {
            return ranges
                .map((r) =>
                    this.toNotebookLocationFromRange(
                        cellUri,
                        new Range(new Position(r.start, 0), new Position(r.end, 0))
                    )
                )
                .filter((l) => l.uri == cellUri)
                .map((l) => {
                    return {
                        start: l.range.start.line,
                        end: l.range.end.line
                    };
                });
        }
    }

    public toNotebookSelectionRanges(cellUri: Uri, ranges: SelectionRange[] | null | undefined) {
        if (Array.isArray(ranges)) {
            return ranges.map((r) => this.toNotebookSelectionRange(cellUri, r));
        }
    }

    public toNotebookSelectionRange(cellUri: Uri, range: SelectionRange): SelectionRange {
        return {
            parent: range.parent ? this.toNotebookSelectionRange(cellUri, range.parent) : undefined,
            range: this.toNotebookRange(cellUri, range.range)
        };
    }

    public toNotebookCallHierarchyItems(
        cellUri: Uri,
        items: CallHierarchyItem | CallHierarchyItem[] | null | undefined
    ) {
        if (Array.isArray(items)) {
            return items.map((r) => this.toNotebookCallHierarchyItem(cellUri, r));
        } else if (items) {
            return this.toNotebookCallHierarchyItem(cellUri, items);
        }
        return undefined;
    }

    public toNotebookCallHierarchyItem(cellUri: Uri, item: CallHierarchyItem) {
        return {
            ...item,
            uri: cellUri,
            range: this.toNotebookRange(cellUri, item.range),
            selectionRange: this.toNotebookRange(cellUri, item.selectionRange)
        };
    }

    public toNotebookCallHierarchyIncomingCallItems(
        cellUri: Uri,
        items: CallHierarchyIncomingCall[] | null | undefined
    ) {
        if (Array.isArray(items)) {
            return items.map((r) => this.toNotebookCallHierarchyIncomingCallItem(cellUri, r));
        }
        return undefined;
    }

    public toNotebookCallHierarchyIncomingCallItem(
        cellUri: Uri,
        item: CallHierarchyIncomingCall
    ): CallHierarchyIncomingCall {
        return {
            from: this.toNotebookCallHierarchyItem(cellUri, item.from),
            fromRanges: item.fromRanges.map((r) => this.toNotebookRange(cellUri, r))
        };
    }

    public toNotebookCallHierarchyOutgoingCallItems(
        cellUri: Uri,
        items: CallHierarchyOutgoingCall[] | null | undefined
    ) {
        if (Array.isArray(items)) {
            return items.map((r) => this.toNotebookCallHierarchyOutgoingCallItem(cellUri, r));
        }
        return undefined;
    }

    public toNotebookCallHierarchyOutgoingCallItem(
        cellUri: Uri,
        item: CallHierarchyOutgoingCall
    ): CallHierarchyOutgoingCall {
        return {
            to: this.toNotebookCallHierarchyItem(cellUri, item.to),
            fromRanges: item.fromRanges.map((r) => this.toNotebookRange(cellUri, r))
        };
    }

    public toNotebookSemanticEdits(cellUri: Uri, items: SemanticTokensEdits | SemanticTokens | null | undefined) {
        if (items && 'edits' in items) {
            return {
                ...items,
                edits: items.edits.map((e) => this.toNotebookSemanticEdit(cellUri, e))
            };
        } else if (items) {
            return items;
        }
        return undefined;
    }

    public toNotebookSemanticEdit(cellUri: Uri, edit: SemanticTokensEdit) {
        return {
            ...edit,
            start: this.toNotebookOffset(cellUri, edit.start)
        };
    }

    public toNotebookSemanticTokens(cellUri: Uri, tokens: SemanticTokens | null | undefined) {
        if (tokens) {
            const wrapper = this.getTextDocumentWrapper(cellUri);
            // First line offset is the wrong number. It is from the beginning of the concat doc and not the
            // cell.
            if (wrapper && tokens.data.length > 0) {
                const startOfCell = wrapper.concatPositionAt(new Location(cellUri, new Position(0, 0)));

                // Note to self: If tokenization stops working, might be pylance's fault. It does handle
                // range requests but was returning stuff outside the range.

                // Rewrite the first item by offsetting from the start of the cell. All other entries
                // are offset from this one, so they don't need to be rewritten
                tokens.data.set([tokens.data[0] - startOfCell.line], 0);

                // Data array should have been updated.
                return tokens;
            }
        }
        return undefined;
    }

    public toNotebookLinkedEditingRanges(cellUri: Uri, items: LinkedEditingRanges | null | undefined) {
        if (items) {
            return {
                ...items,
                ranges: items.ranges.map((e) => this.toNotebookRange(cellUri, e))
            };
        }
    }

    public remove(cell: TextDocument) {
        const key = NotebookConverter.getDocumentKey(cell.uri);
        const wrapper = this.activeWrappers.get(key);
        if (wrapper) {
            this.deleteWrapper(wrapper);
        }
    }

    private toNotebookWorkspaceSymbol(symbol: SymbolInformation): SymbolInformation {
        // Figure out what cell if any the symbol is for
        return this.toNotebookSymbolFromSymbolInformation(symbol.location.uri, symbol);
    }

    /* Renable this if actions can be translated
    private toNotebookAction(cell: TextDocument, action: Command | CodeAction): Command | CodeAction {
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

    private toNotebookCommand(cell: TextDocument, command: Command): Command {
        return {
            ...command,
            arguments: command.arguments ? command.arguments.map(this.toNotebookArgument.bind(this, cell)) : undefined
        };
    }


    private toNotebookArgument(cell: TextDocument, argument: any): any {
        // URIs in a command should be remapped to the cell document if part
        // of one of our open notebooks
        if (isUri(argument)) {
            const wrapper = this.getWrapperFromOutgoingUri(argument);
            if (wrapper) {
                return cell.uri;
            }
        }
        if (typeof argument === 'string' && argument.includes(NotebookConcatPrefix)) {
            const wrapper = this.getWrapperFromOutgoingUri(Uri.file(argument));
            if (wrapper) {
                return cell.uri;
            }
        }
        if (typeof argument === 'object' && argument.hasOwnProperty('start') && argument.hasOwnProperty('end')) {
            // This is a range like object. Convert it too.
            return this.toNotebookRange(cell, this.toRange(<Range>argument));
        }
        if (typeof argument === 'object' && argument.hasOwnProperty('line') && argument.hasOwnProperty('character')) {
            // This is a position like object. Convert it too.
            return this.toNotebookPosition(cell, this.toPosition(<Position>argument));
        }
        return argument;
    }
    */

    private toConcatDiagnostic(cell: TextDocument, diagnostic: Diagnostic): Diagnostic {
        return {
            ...diagnostic,
            range: this.toConcatRange(cell, diagnostic.range),
            relatedInformation: diagnostic.relatedInformation
                ? diagnostic.relatedInformation.map(this.toConcatRelatedInformation.bind(this, cell))
                : undefined
        };
    }

    private toConcatRelatedInformation(
        cell: TextDocument,
        relatedInformation: DiagnosticRelatedInformation
    ): DiagnosticRelatedInformation {
        const outgoingDoc = this.toConcatDocument(cell);
        return {
            ...relatedInformation,
            location:
                relatedInformation.location.uri === outgoingDoc.uri
                    ? this.toConcatLocation(cell, relatedInformation.location)
                    : relatedInformation.location
        };
    }

    private toConcatLocation(cell: TextDocument, location: Location): Location {
        return {
            uri: this.toConcatDocument(cell).uri,
            range: this.toConcatRange(cell, location.range)
        };
    }

    private toNotebookRelatedInformation(
        cell: TextDocument | Uri,
        relatedInformation: DiagnosticRelatedInformation
    ): DiagnosticRelatedInformation {
        const outgoingUri = this.toConcatUri(cell);
        return {
            ...relatedInformation,
            location:
                relatedInformation.location.uri === outgoingUri
                    ? this.toNotebookLocationFromLocation(relatedInformation.location)
                    : relatedInformation.location
        };
    }

    private toNotebookSymbolFromDocumentSymbol(cell: TextDocument, docSymbol: DocumentSymbol): DocumentSymbol {
        return {
            ...docSymbol,
            range: this.toNotebookRange(cell, docSymbol.range),
            selectionRange: this.toNotebookRange(cell, docSymbol.selectionRange),
            children: docSymbol.children.map(this.toNotebookSymbolFromDocumentSymbol.bind(this, cell))
        };
    }

    private toNotebookLocationFromLocation(location: Location): Location {
        if (this.locationNeedsConversion(location.uri)) {
            const uri = this.toNotebookUri(location.uri, location.range);

            return {
                uri,
                range: this.toNotebookRange(uri, location.range)
            };
        }

        return location;
    }

    private toNotebookLocationLinkFromLocationLink(locationLink: LocationLink): LocationLink {
        if (this.locationNeedsConversion(locationLink.targetUri)) {
            const uri = this.toNotebookUri(locationLink.targetUri, locationLink.targetRange);

            return {
                originSelectionRange: locationLink.originSelectionRange
                    ? this.toNotebookRange(uri, locationLink.originSelectionRange)
                    : undefined,
                targetUri: uri,
                targetRange: this.toNotebookRange(uri, locationLink.targetRange),
                targetSelectionRange: locationLink.targetSelectionRange
                    ? this.toNotebookRange(uri, locationLink.targetSelectionRange)
                    : undefined
            };
        }

        return locationLink;
    }

    private toNotebookLocationOrLink(location: Location | LocationLink) {
        // Split on if we are dealing with a Location or a LocationLink
        if ('targetUri' in location) {
            // targetUri only for LocationLinks
            return this.toNotebookLocationLinkFromLocationLink(location);
        }
        return this.toNotebookLocationFromLocation(location);
    }

    // Returns true if the given location needs conversion
    // Should be if it's in a notebook cell or if it's in a notebook concat document
    private locationNeedsConversion(locationUri: Uri): boolean {
        return locationUri.scheme === NotebookCellScheme || this.getWrapperFromOutgoingUri(locationUri) !== undefined;
    }

    private toNotebookCompletion(cell: TextDocument, item: CompletionItem) {
        if (item.range) {
            if (item.range instanceof Range) {
                return {
                    ...item,
                    range: this.toNotebookRange(cell, item.range)
                };
            }
            return {
                ...item,
                range: {
                    inserting: this.toNotebookRange(cell, item.range.inserting),
                    replacing: this.toNotebookRange(cell, item.range.replacing)
                }
            };
        }
        return item;
    }

    private toNotebookLocationFromRange(cell: TextDocument | Uri, range: Range): Location {
        const uri = cell instanceof Uri ? <Uri>cell : cell.uri;
        const wrapper = this.getTextDocumentWrapper(cell);
        if (wrapper) {
            const startLoc = wrapper.notebookLocationAt(range.start);
            const endLoc = wrapper.notebookLocationAt(range.end);
            return {
                uri: startLoc.uri,
                range: new Range(startLoc.range.start, endLoc.range.end)
            };
        }
        return {
            uri,
            range
        };
    }

    private deleteWrapper(wrapper: NotebookWrapper) {
        // Cleanup both maps and dispose of the wrapper (disconnects the cell change emitter)
        this.activeWrappersOutgoingMap.delete(NotebookConverter.getDocumentKey(wrapper.concatUri));
        this.activeWrappers.delete(wrapper.key);
        wrapper.dispose();
    }

    private arePathsSame(path1: string, path2: string): boolean {
        path1 = path.normalize(path1);
        path2 = path.normalize(path2);
        return path1 === path2;
    }

    private getWrapperFromOutgoingUri(outgoingUri: Uri): NotebookWrapper | undefined {
        return this.activeWrappersOutgoingMap.get(NotebookConverter.getDocumentKey(outgoingUri));
    }

    private getTextDocumentWrapper(cell: TextDocument | Uri): NotebookWrapper {
        const uri = cell instanceof Uri ? <Uri>cell : cell.uri;
        const key = NotebookConverter.getDocumentKey(uri);
        let result = this.activeWrappers.get(key);
        if (!result) {
            result = new NotebookWrapper(this.cellSelector, key);
            this.activeWrappers.set(key, result);
        }
        return result;
    }
}
