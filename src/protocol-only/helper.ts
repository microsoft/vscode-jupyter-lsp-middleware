// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

'use strict';

import * as protocol from 'vscode-languageserver-protocol';

export function createRange(start: protocol.Position, end: protocol.Position): protocol.Range {
    return {
        start,
        end
    };
}

export function createPosition(line: number, character: number): protocol.Position {
    return {
        line,
        character
    };
}

export function createLocation(uri: string, range: protocol.Range): protocol.Location {
    return {
        uri,
        range
    };
}
