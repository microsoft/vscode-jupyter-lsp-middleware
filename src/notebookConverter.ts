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
    LinkedEditingRanges,
    workspace
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
        const results = wrapper?.handleOpen(cell) || [];
        if (wrapper) {
            // concat uri is empty until a cell is added.
            this.activeWrappersOutgoingMap.set(NotebookConverter.getDocumentKey(wrapper.concatUri), wrapper);
        }
        return results;
    }

    public handleClose(cell: TextDocument) {
        const wrapper = this.getTextDocumentWrapper(cell);
        return wrapper?.handleClose(cell) || [];
    }

    public handleChange(event: TextDocumentChangeEvent) {
        const wrapper = this.getTextDocumentWrapper(event.document);
        return wrapper?.handleChange(event) || [];
    }

    public toIncomingDiagnosticsMap(uri: Uri, diagnostics: Diagnostic[]): Map<Uri, Diagnostic[]> {
        const wrapper = this.getWrapperFromOutgoingUri(uri);
        const result = new Map<Uri, Diagnostic[]>();

        if (wrapper) {
            // Diagnostics are supposed to be per file and are updated each time
            // Make sure to clear out old ones first
            const cellUris: string[] = [];
            const oldCellUris = this.mapOfConcatDocumentsWithCellUris.get(uri.toString()) || [];
            wrapper.getComposeDocuments().forEach((document: TextDocument) => {
                result.set(document.uri, []);
                cellUris.push(document.uri.toString());
            });
            // Possible some cells were deleted, we need to clear the diagnostics of those cells as well.
            const currentCellUris = new Set(cellUris);
            oldCellUris
                .filter((cellUri) => !currentCellUris.has(cellUri))
                .forEach((cellUri) => result.set(Uri.parse(cellUri), []));
            this.mapOfConcatDocumentsWithCellUris.set(uri.toString(), cellUris);

            // Filter out any diagnostics that have to do with magics or shell escapes
            var filtered = diagnostics.filter(this.filterMagics.bind(this, wrapper));

            // Then for all the new ones, set their values.
            filtered.forEach((d) => {
                const location = wrapper.locationAt(d.range);
                let list = result.get(location.uri);
                if (!list) {
                    list = [];
                    result.set(location.uri, list);
                }
                list.push(this.toIncomingDiagnostic(location.uri, d));
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
    public toIncomingWorkspaceSymbols(symbols: SymbolInformation[] | null | undefined) {
        if (Array.isArray(symbols)) {
            return symbols.map(this.toIncomingWorkspaceSymbol.bind(this));
        }
        return symbols ?? undefined;
    }

    public toIncomingWorkspaceEdit(workspaceEdit: WorkspaceEdit | null | undefined): WorkspaceEdit | undefined {
        if (workspaceEdit) {
            // Translate all of the text edits into a URI map
            const translated = new Map<Uri, TextEdit[]>();
            workspaceEdit.entries().forEach(([key, values]) => {
                values.forEach((e) => {
                    // Location may move this edit to a different cell.
                    const location = this.toIncomingLocationFromRange(key, e.range);

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

    public toOutgoingDocument(cell: TextDocument): TextDocument {
        const result = this.getTextDocumentWrapper(cell);
        return result?.getConcatDocument() || cell;
    }

    public toOutgoingUri(cell: TextDocument | Uri): Uri {
        const uri = cell instanceof Uri ? <Uri>cell : cell.uri;
        const result = this.getTextDocumentWrapper(cell);
        return result ? result.concatUri : uri;
    }

    public toOutgoingPosition(cell: TextDocument, position: Position): Position {
        const wrapper = this.getTextDocumentWrapper(cell);
        return wrapper ? wrapper.positionAt(new Location(cell.uri, position)) : position;
    }

    public toOutgoingPositions(cell: TextDocument, positions: Position[]) {
        return positions.map((p) => this.toOutgoingPosition(cell, p));
    }

    public toOutgoingRange(cell: TextDocument | Uri, cellRange: Range | undefined): Range {
        const wrapper = this.getTextDocumentWrapper(cell);
        if (wrapper) {
            const uri = cell instanceof Uri ? <Uri>cell : cell.uri;
            const notebook = this.getNotebookDocument(cell);
            const cellDocument =
                cell instanceof Uri ? notebook?.getCells().find((c) => c.document.uri == uri)?.document : cell;
            const start = cellRange ? cellRange.start : new Position(0, 0);
            const end = cellRange
                ? cellRange.end
                : cellDocument?.lineAt(cellDocument.lineCount - 1).range.end || new Position(0, 0);
            const startPos = wrapper.positionAt(new Location(uri, start));
            const endPos = wrapper.positionAt(new Location(uri, end));
            return new Range(startPos, endPos);
        }
        return cellRange || new Range(new Position(0, 0), new Position(0, 0));
    }

    public toOutgoingOffset(cell: TextDocument, offset: number): number {
        const wrapper = this.getTextDocumentWrapper(cell);
        if (wrapper) {
            const position = cell.positionAt(offset);
            const overallPosition = wrapper.positionAt(new Location(cell.uri, position));
            return wrapper.offsetAt(overallPosition);
        }
        return offset;
    }

    public toOutgoingContext(cell: TextDocument, context: CodeActionContext): CodeActionContext {
        return {
            ...context,
            diagnostics: context.diagnostics.map(this.toOutgoingDiagnostic.bind(this, cell))
        };
    }

    public toIncomingHover(cell: TextDocument, hover: Hover | null | undefined): Hover | undefined {
        if (hover && hover.range) {
            return {
                ...hover,
                range: this.toIncomingRange(cell, hover.range)
            };
        }
        return hover ?? undefined;
    }

    // eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
    public toIncomingCompletions(
        cell: TextDocument,
        completions: CompletionItem[] | CompletionList | null | undefined
    ) {
        if (completions) {
            if (Array.isArray(completions)) {
                return completions.map(this.toIncomingCompletion.bind(this, cell));
            }
            return {
                ...completions,
                items: completions.items.map(this.toIncomingCompletion.bind(this, cell))
            };
        }
        return completions;
    }

    // eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
    public toIncomingLocations(location: Definition | Location | Location[] | LocationLink[] | null | undefined) {
        if (Array.isArray(location)) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            return (<any>location).map(this.toIncomingLocationOrLink.bind(this));
        }
        if (location?.range) {
            return this.toIncomingLocationFromRange(location.uri, location.range);
        }
        return location;
    }

    public toIncomingHighlight(
        cell: TextDocument,
        highlight: DocumentHighlight[] | null | undefined
    ): DocumentHighlight[] | undefined {
        if (highlight) {
            return highlight.map((h) => ({
                ...h,
                range: this.toIncomingRange(cell, h.range)
            }));
        }
        return highlight ?? undefined;
    }

    // eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
    public toIncomingSymbols(cell: TextDocument, symbols: SymbolInformation[] | DocumentSymbol[] | null | undefined) {
        if (symbols && Array.isArray(symbols) && symbols.length) {
            if (symbols[0] instanceof DocumentSymbol) {
                return (<DocumentSymbol[]>symbols).map(this.toIncomingSymbolFromDocumentSymbol.bind(this, cell));
            }
            return (<SymbolInformation[]>symbols).map(this.toIncomingSymbolFromSymbolInformation.bind(this, cell));
        }
        return symbols ?? undefined;
    }

    public toIncomingSymbolFromSymbolInformation(cell: TextDocument, symbol: SymbolInformation): SymbolInformation {
        return {
            ...symbol,
            location: this.toIncomingLocationFromRange(cell, symbol.location.range)
        };
    }

    public toIncomingDiagnostic(cell: TextDocument | Uri, diagnostic: Diagnostic): Diagnostic {
        return {
            ...diagnostic,
            range: this.toIncomingRange(cell, diagnostic.range),
            relatedInformation: diagnostic.relatedInformation
                ? diagnostic.relatedInformation.map(this.toIncomingRelatedInformation.bind(this, cell))
                : undefined
        };
    }

    // eslint-disable-next-line class-methods-use-this
    public toIncomingActions(_cell: TextDocument, actions: (Command | CodeAction)[] | null | undefined): undefined {
        if (Array.isArray(actions)) {
            // Disable for now because actions are handled directly by the LS sometimes (at least in pylance)
            // If we translate or use them they will either
            // 1) Do nothing because the LS doesn't know about the ipynb
            // 2) Crash (pylance is doing this now)
            return undefined;
        }
        return actions ?? undefined;
    }

    public toIncomingCodeLenses(cell: TextDocument, lenses: CodeLens[] | null | undefined): CodeLens[] | undefined {
        if (Array.isArray(lenses)) {
            return lenses.map((c) => ({
                ...c,
                range: this.toIncomingRange(cell, c.range)
            }));
        }
        return lenses ?? undefined;
    }

    public toIncomingEdits(cell: TextDocument, edits: TextEdit[] | null | undefined): TextEdit[] | undefined {
        if (Array.isArray(edits)) {
            return edits.map((e) => ({
                ...e,
                range: this.toIncomingRange(cell, e.range)
            }));
        }
        return edits ?? undefined;
    }

    public toIncomingRename(
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
                return this.toIncomingLocationFromRange(cell, rangeOrRename).range;
            }
            return {
                ...rangeOrRename,
                range: this.toIncomingLocationFromRange(cell, rangeOrRename.range).range
            };
        }
        return rangeOrRename ?? undefined;
    }

    public toIncomingDocumentLinks(
        cell: TextDocument,
        links: DocumentLink[] | null | undefined
    ): DocumentLink[] | undefined {
        if (links && Array.isArray(links)) {
            return links.map((l) => {
                const uri = l.target ? l.target : cell.uri;
                const location = this.toIncomingLocationFromRange(uri, l.range);
                return {
                    ...l,
                    range: location.range,
                    target: l.target ? location.uri : undefined
                };
            });
        }
        return links ?? undefined;
    }

    public toIncomingRange(cell: TextDocument | Uri, range: Range): Range {
        // This is dangerous as the URI is not remapped (location uri may be different)
        return this.toIncomingLocationFromRange(cell, range).range;
    }

    public toIncomingPosition(cell: TextDocument | Uri, position: Position): Position {
        // This is dangerous as the URI is not remapped (location uri may be different)
        return this.toIncomingLocationFromRange(cell, new Range(position, position)).range.start;
    }

    public toIncomingOffset(cell: TextDocument | Uri, offset: number): number {
        const uri = cell instanceof Uri ? <Uri>cell : cell.uri;
        const wrapper = this.getWrapperFromOutgoingUri(uri);
        if (wrapper && wrapper.notebook) {
            const position = wrapper.positionAt(offset);
            const location = wrapper.locationAt(position);
            const cell = wrapper.notebook.getCells().find((c) => c.document.uri == location.uri);
            if (cell) {
                return cell.document.offsetAt(location.range.start);
            }
        }
        return offset;
    }

    public toIncomingUri(outgoingUri: Uri, range?: Range) {
        const wrapper = this.getWrapperFromOutgoingUri(outgoingUri);
        let result: Uri | undefined;
        if (wrapper && wrapper.notebook) {
            if (range) {
                const location = wrapper.locationAt(range);
                result = location.uri;
            } else {
                result = wrapper.notebook.uri;
            }
        }
        // Might be deleted, check for pending delete
        if (!result) {
            this.pendingCloseWrappers.forEach((n) => {
                if (this.arePathsSame(n.concatUri.fsPath, outgoingUri.fsPath)) {
                    result = n.notebook.uri;
                }
            });
        }
        return result || outgoingUri;
    }

    public toIncomingColorInformations(cellUri: Uri, colorInformations: ColorInformation[] | null | undefined) {
        if (Array.isArray(colorInformations)) {
            // Need to filter out color information for other cells. Pylance
            // will return it for all.
            return colorInformations
                .map((c) => {
                    return {
                        color: c.color,
                        location: this.toIncomingLocationFromRange(cellUri, c.range)
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

    public toIncomingColorPresentations(cellUri: Uri, colorPresentations: ColorPresentation[] | null | undefined) {
        if (Array.isArray(colorPresentations)) {
            return colorPresentations.map((c) => {
                return {
                    ...c,
                    additionalTextEdits: c.additionalTextEdits
                        ? this.toIncomingTextEdits(cellUri, c.additionalTextEdits)
                        : undefined,
                    textEdit: c.textEdit ? this.toIncomingTextEdit(cellUri, c.textEdit) : undefined
                };
            });
        }
    }

    public toIncomingTextEdits(cellUri: Uri, textEdits: TextEdit[] | null | undefined) {
        if (Array.isArray(textEdits)) {
            return textEdits.map((t) => this.toIncomingTextEdit(cellUri, t));
        }
    }

    public toIncomingTextEdit(cellUri: Uri, textEdit: TextEdit) {
        return {
            ...textEdit,
            range: this.toIncomingRange(cellUri, textEdit.range)
        };
    }

    public toIncomingFoldingRanges(cellUri: Uri, ranges: FoldingRange[] | null | undefined) {
        if (Array.isArray(ranges)) {
            return ranges
                .map((r) =>
                    this.toIncomingLocationFromRange(
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

    public toIncomingSelectionRanges(cellUri: Uri, ranges: SelectionRange[] | null | undefined) {
        if (Array.isArray(ranges)) {
            return ranges.map((r) => this.toIncomingSelectionRange(cellUri, r));
        }
    }

    public toIncomingSelectionRange(cellUri: Uri, range: SelectionRange): SelectionRange {
        return {
            parent: range.parent ? this.toIncomingSelectionRange(cellUri, range.parent) : undefined,
            range: this.toIncomingRange(cellUri, range.range)
        };
    }

    public toIncomingCallHierarchyItems(
        cellUri: Uri,
        items: CallHierarchyItem | CallHierarchyItem[] | null | undefined
    ) {
        if (Array.isArray(items)) {
            return items.map((r) => this.toIncomingCallHierarchyItem(cellUri, r));
        } else if (items) {
            return this.toIncomingCallHierarchyItem(cellUri, items);
        }
        return undefined;
    }

    public toIncomingCallHierarchyItem(cellUri: Uri, item: CallHierarchyItem) {
        return {
            ...item,
            uri: cellUri,
            range: this.toIncomingRange(cellUri, item.range),
            selectionRange: this.toIncomingRange(cellUri, item.selectionRange)
        };
    }

    public toIncomingCallHierarchyIncomingCallItems(
        cellUri: Uri,
        items: CallHierarchyIncomingCall[] | null | undefined
    ) {
        if (Array.isArray(items)) {
            return items.map((r) => this.toIncomingCallHierarchyIncomingCallItem(cellUri, r));
        }
        return undefined;
    }

    public toIncomingCallHierarchyIncomingCallItem(
        cellUri: Uri,
        item: CallHierarchyIncomingCall
    ): CallHierarchyIncomingCall {
        return {
            from: this.toIncomingCallHierarchyItem(cellUri, item.from),
            fromRanges: item.fromRanges.map((r) => this.toIncomingRange(cellUri, r))
        };
    }

    public toIncomingCallHierarchyOutgoingCallItems(
        cellUri: Uri,
        items: CallHierarchyOutgoingCall[] | null | undefined
    ) {
        if (Array.isArray(items)) {
            return items.map((r) => this.toIncomingCallHierarchyOutgoingCallItem(cellUri, r));
        }
        return undefined;
    }

    public toIncomingCallHierarchyOutgoingCallItem(
        cellUri: Uri,
        item: CallHierarchyOutgoingCall
    ): CallHierarchyOutgoingCall {
        return {
            to: this.toIncomingCallHierarchyItem(cellUri, item.to),
            fromRanges: item.fromRanges.map((r) => this.toIncomingRange(cellUri, r))
        };
    }

    public toIncomingSemanticEdits(cellUri: Uri, items: SemanticTokensEdits | SemanticTokens | null | undefined) {
        if (items && 'edits' in items) {
            return {
                ...items,
                edits: items.edits.map((e) => this.toIncomingSemanticEdit(cellUri, e))
            };
        } else if (items) {
            return items;
        }
        return undefined;
    }

    public toIncomingSemanticEdit(cellUri: Uri, edit: SemanticTokensEdit) {
        return {
            ...edit,
            start: this.toIncomingOffset(cellUri, edit.start)
        };
    }

    public toIncomingSemanticTokens(cellUri: Uri, tokens: SemanticTokens | null | undefined) {
        if (tokens) {
            const wrapper = this.getTextDocumentWrapper(cellUri);
            // First line offset is the wrong number. It is from the beginning of the concat doc and not the
            // cell.
            if (wrapper && tokens.data.length > 0) {
                const startOfCell = wrapper.positionAt(new Location(cellUri, new Position(0, 0)));

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

    public toIncomingLinkedEditingRanges(cellUri: Uri, items: LinkedEditingRanges | null | undefined) {
        if (items) {
            return {
                ...items,
                ranges: items.ranges.map((e) => this.toIncomingRange(cellUri, e))
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

    private getTextDocumentAtLocation(location: Location): TextDocument | undefined {
        const key = NotebookConverter.getDocumentKey(location.uri);
        const wrapper = this.activeWrappers.get(key);
        if (wrapper) {
            return wrapper.getTextDocumentAtPosition(location.range.start);
        }
        return undefined;
    }

    private toIncomingWorkspaceSymbol(symbol: SymbolInformation): SymbolInformation {
        // Figure out what cell if any the symbol is for
        const document = this.getTextDocumentAtLocation(symbol.location);
        if (document) {
            return this.toIncomingSymbolFromSymbolInformation(document, symbol);
        }
        return symbol;
    }

    /* Renable this if actions can be translated
    private toIncomingAction(cell: TextDocument, action: Command | CodeAction): Command | CodeAction {
        if (action instanceof CodeAction) {
            return {
                ...action,
                command: action.command ? this.toIncomingCommand(cell, action.command) : undefined,
                diagnostics: action.diagnostics
                    ? action.diagnostics.map(this.toIncomingDiagnostic.bind(this, cell))
                    : undefined
            };
        }
        return this.toIncomingCommand(cell, action);
    }

    private toIncomingCommand(cell: TextDocument, command: Command): Command {
        return {
            ...command,
            arguments: command.arguments ? command.arguments.map(this.toIncomingArgument.bind(this, cell)) : undefined
        };
    }


    private toIncomingArgument(cell: TextDocument, argument: any): any {
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
            return this.toIncomingRange(cell, this.toRange(<Range>argument));
        }
        if (typeof argument === 'object' && argument.hasOwnProperty('line') && argument.hasOwnProperty('character')) {
            // This is a position like object. Convert it too.
            return this.toIncomingPosition(cell, this.toPosition(<Position>argument));
        }
        return argument;
    }
    */

    private toOutgoingDiagnostic(cell: TextDocument, diagnostic: Diagnostic): Diagnostic {
        return {
            ...diagnostic,
            range: this.toOutgoingRange(cell, diagnostic.range),
            relatedInformation: diagnostic.relatedInformation
                ? diagnostic.relatedInformation.map(this.toOutgoingRelatedInformation.bind(this, cell))
                : undefined
        };
    }

    private toOutgoingRelatedInformation(
        cell: TextDocument,
        relatedInformation: DiagnosticRelatedInformation
    ): DiagnosticRelatedInformation {
        const outgoingDoc = this.toOutgoingDocument(cell);
        return {
            ...relatedInformation,
            location:
                relatedInformation.location.uri === outgoingDoc.uri
                    ? this.toOutgoingLocation(cell, relatedInformation.location)
                    : relatedInformation.location
        };
    }

    private toOutgoingLocation(cell: TextDocument, location: Location): Location {
        return {
            uri: this.toOutgoingDocument(cell).uri,
            range: this.toOutgoingRange(cell, location.range)
        };
    }

    private toIncomingRelatedInformation(
        cell: TextDocument | Uri,
        relatedInformation: DiagnosticRelatedInformation
    ): DiagnosticRelatedInformation {
        const outgoingUri = this.toOutgoingUri(cell);
        return {
            ...relatedInformation,
            location:
                relatedInformation.location.uri === outgoingUri
                    ? this.toIncomingLocationFromLocation(relatedInformation.location)
                    : relatedInformation.location
        };
    }

    private toIncomingSymbolFromDocumentSymbol(cell: TextDocument, docSymbol: DocumentSymbol): DocumentSymbol {
        return {
            ...docSymbol,
            range: this.toIncomingRange(cell, docSymbol.range),
            selectionRange: this.toIncomingRange(cell, docSymbol.selectionRange),
            children: docSymbol.children.map(this.toIncomingSymbolFromDocumentSymbol.bind(this, cell))
        };
    }

    private toIncomingLocationFromLocation(location: Location): Location {
        if (this.locationNeedsConversion(location.uri)) {
            const uri = this.toIncomingUri(location.uri, location.range);

            return {
                uri,
                range: this.toIncomingRange(uri, location.range)
            };
        }

        return location;
    }

    private toIncomingLocationLinkFromLocationLink(locationLink: LocationLink): LocationLink {
        if (this.locationNeedsConversion(locationLink.targetUri)) {
            const uri = this.toIncomingUri(locationLink.targetUri, locationLink.targetRange);

            return {
                originSelectionRange: locationLink.originSelectionRange
                    ? this.toIncomingRange(uri, locationLink.originSelectionRange)
                    : undefined,
                targetUri: uri,
                targetRange: this.toIncomingRange(uri, locationLink.targetRange),
                targetSelectionRange: locationLink.targetSelectionRange
                    ? this.toIncomingRange(uri, locationLink.targetSelectionRange)
                    : undefined
            };
        }

        return locationLink;
    }

    private toIncomingLocationOrLink(location: Location | LocationLink) {
        // Split on if we are dealing with a Location or a LocationLink
        if ('targetUri' in location) {
            // targetUri only for LocationLinks
            return this.toIncomingLocationLinkFromLocationLink(location);
        }
        return this.toIncomingLocationFromLocation(location);
    }

    // Returns true if the given location needs conversion
    // Should be if it's in a notebook cell or if it's in a notebook concat document
    private locationNeedsConversion(locationUri: Uri): boolean {
        return locationUri.scheme === NotebookCellScheme || this.getWrapperFromOutgoingUri(locationUri) !== undefined;
    }

    private toIncomingCompletion(cell: TextDocument, item: CompletionItem) {
        if (item.range) {
            if (item.range instanceof Range) {
                return {
                    ...item,
                    range: this.toIncomingRange(cell, item.range)
                };
            }
            return {
                ...item,
                range: {
                    inserting: this.toIncomingRange(cell, item.range.inserting),
                    replacing: this.toIncomingRange(cell, item.range.replacing)
                }
            };
        }
        return item;
    }

    private toIncomingLocationFromRange(cell: TextDocument | Uri, range: Range): Location {
        const uri = cell instanceof Uri ? <Uri>cell : cell.uri;
        const wrapper = this.getTextDocumentWrapper(cell);
        if (wrapper) {
            const startLoc = wrapper.locationAt(range.start);
            const endLoc = wrapper.locationAt(range.end);
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
            const doc = workspace.notebookDocuments.find((n) => this.arePathsSame(uri.fsPath, n.uri.fsPath));
            if (!doc) {
                throw new Error(`Invalid uri, not a notebook: ${uri.fsPath}`);
            }
            result = new NotebookWrapper(doc, this.cellSelector, key);
            this.activeWrappers.set(key, result);
        }
        return result;
    }

    private filterMagics(wrapper: NotebookWrapper, value: Diagnostic): boolean {
        // Get the code at the range
        const text = wrapper.getText(value.range);

        // Only skip diagnostics on the front of the line (spacing?)
        if (text && value.range.start.character == 0 && (text.startsWith('%') || text.startsWith('!'))) {
            return false;
        }
        return true;
    }

    private getNotebookDocument(cell: TextDocument | Uri): NotebookDocument | undefined {
        const uri = cell instanceof Uri ? <Uri>cell : cell.uri;
        const key = NotebookConverter.getDocumentKey(uri);
        let result = this.activeWrappers.get(key);
        if (result) {
            return result.notebook;
        }
    }
}
