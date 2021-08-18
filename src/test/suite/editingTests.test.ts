/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from "assert";
import { withTestNotebook } from "./helper";
import {
  EventEmitter,
  NotebookCellKind,
  NotebookConcatTextDocument,
  NotebookDocument,
  Uri,
} from "vscode";
import { EnhancedNotebookConcatTextDocument } from "../../nativeNotebookConcatTextDocument";
import { IVSCodeNotebook } from "../../common/types";

suite("Editing Tests", () => {
  test("Edit a notebook", () => {
    withTestNotebook(
      Uri.parse("test://test.ipynb"),
      [
        [["print(1)"], "python", NotebookCellKind.Code, [], {}],
        [["print(2)"], "python", NotebookCellKind.Code, [], {}],
        [["test"], "markdown", NotebookCellKind.Markup, [], {}],
        [["foo = 2", "print(foo)"], "python", NotebookCellKind.Code, [], {}],
      ],
      (notebookDocument: NotebookDocument, notebookAPI: IVSCodeNotebook) => {
        const concat = new EnhancedNotebookConcatTextDocument(
          notebookDocument,
          "python",
          notebookAPI
        );
        assert.strictEqual(concat.lineCount, 4);
        assert.strictEqual(concat.languageId, "python");
        assert.strictEqual(
          concat.getText(),
          ["print(1)", "print(2)", "foo = 2", "print(foo)"].join("\n")
        );

        const concatTextDocument: NotebookConcatTextDocument = (concat as any)
          ._concatTextDocument;
        const emitter: EventEmitter<void> = (concatTextDocument as any)
          ._onDidChange;

        // Verify if we delete markdown, we still have same count
        notebookDocument.getCells().splice(2, 1);
        emitter.fire();
        assert.strictEqual(concat.lineCount, 4);

        // Verify if we delete python, we still have new count
        notebookDocument.getCells().splice(1, 1);
        emitter.fire();
        assert.strictEqual(concat.lineCount, 3);
      }
    );
  });
});
