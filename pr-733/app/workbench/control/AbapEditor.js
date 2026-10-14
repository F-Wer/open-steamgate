sap.ui.define(["sap/ui/codeeditor/CodeEditor"], function (CodeEditor) {
  "use strict";

  // The pinned UI5 control owns input, undo, accessibility, themes, resize
  // and destruction. Keep its one restricted Ace seam here: replacing the
  // measured editor engine must not change the Workbench or ADT contract.
  return CodeEditor.extend("stg.workbench.control.AbapEditor", {
    metadata: {properties: {diagnostics: {type: "object", defaultValue: null}}},
    renderer: CodeEditor.getMetadata().getRenderer(),

    setValue(value) {
      // UI5 writes a bound value through this setter. Remember that this is
      // an intentional source replacement, not an unrelated rerender.
      this._renderValue = String(value ?? "");
      this._valuePending = true;
      this.setProperty("value", value);
      return this;
    },
    onBeforeRendering() {
      // CodeEditor reapplies its value property after rendering. Preserve the
      // live Ace buffer when a parent layout rerenders without changing that
      // property, or unsaved keystrokes would silently disappear.
      if (!this._valuePending && this.getInternalEditorInstance?.()) {
        this._renderValue = this.getCurrentValue();
      }
      CodeEditor.prototype.onBeforeRendering?.apply(this, arguments);
    },
    setDiagnostics(aDiagnostics) {
      this.setProperty("diagnostics", aDiagnostics || [], true);
      this._applyDiagnostics();
      return this;
    },
    onAfterRendering() {
      CodeEditor.prototype.onAfterRendering.apply(this, arguments);
      const editor = this.getInternalEditorInstance && this.getInternalEditorInstance();
      if (editor && this._renderValue !== undefined && this.getCurrentValue() !== this._renderValue) {
        editor.getSession().setValue(this._renderValue);
      }
      this._valuePending = false;
      this._applyDiagnostics();
    },
    _applyDiagnostics() {
      const editor = this.getInternalEditorInstance && this.getInternalEditorInstance();
      if (!editor || !editor.getSession) return;
      editor.getSession().setAnnotations((this.getDiagnostics() || []).map((item) => ({
        row: Math.max(0, Number(item.line || 1) - 1),
        column: Math.max(0, Number(item.column || 1) - 1),
        text: item.message || "Check finding",
        type: item.severity === "W" ? "warning" : item.severity === "I" ? "info" : "error"
      })));
    },
    reveal(line, column) {
      const editor = this.getInternalEditorInstance && this.getInternalEditorInstance();
      if (editor) {
        editor.gotoLine(Math.max(1, Number(line || 1)), Math.max(0, Number(column || 1) - 1), true);
        editor.focus();
      }
    }
  });
});
