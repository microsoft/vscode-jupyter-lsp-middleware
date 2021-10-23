// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

import { Position, Range, Uri, Event, Location, TextLine, TextDocument, DocumentSelector, languages } from 'vscode';

export interface IConcatTextDocument {
    onDidChange: Event<void>;
    isClosed: boolean;
    lineCount: number;
    languageId: string;
    isComposeDocumentsAllClosed: boolean;
    getText(range?: Range): string;
    contains(uri: Uri): boolean;
    offsetAt(position: Position): number;
    positionAt(locationOrOffset: Location | number): Position;
    rangeAt(uri: Uri): Range | undefined;
    validateRange(range: Range): Range;
    validatePosition(position: Position): Position;
    locationAt(positionOrRange: Position | Range): Location;
    lineAt(posOrNumber: Position | number): TextLine;
    getWordRangeAtPosition(position: Position, regexp?: RegExp | undefined): Range | undefined;
    getComposeDocuments(): TextDocument[];
}

export function score(document: TextDocument, selector: DocumentSelector): number {
    return languages.match(selector, document);
}
