// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

export const NotebookCellScheme = 'vscode-notebook-cell';
export const InteractiveInputScheme = 'vscode-interactive-input';
export const InteractiveScheme = 'vscode-interactive';
export const PYTHON_LANGUAGE = 'python';

export function isThenable<T>(v: any): v is Thenable<T> {
    return typeof v?.then === 'function';
}

export function isEqual(a: string[], b: string[]): boolean {
    if (a.length !== b.length) {
        return false;
    }

    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) {
            return false;
        }
    }

    return true;
}

export function splitLines(
    str: string,
    splitOptions: { trim?: boolean; removeEmptyEntries?: boolean } = { removeEmptyEntries: true, trim: true }
): string[] {
    let lines = str.split(/\r?\n/g);
    if (splitOptions && splitOptions.trim) {
        lines = lines.map((line) => line.trim());
    }
    if (splitOptions && splitOptions.removeEmptyEntries) {
        lines = lines.filter((line) => line.length > 0);
    }
    return lines;
}
