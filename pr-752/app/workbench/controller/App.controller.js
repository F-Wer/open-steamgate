sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/ui/model/json/JSONModel",
  "sap/m/MessageBox",
  "sap/m/Column",
  "sap/m/Text",
  "sap/m/ColumnListItem"
], function (Controller, JSONModel, MessageBox, Column, Text, ColumnListItem) {
  "use strict";

  // Absolute `/sap/...` escapes the repository prefix on GitHub Pages.
  const componentRoot = new URL(sap.ui.require.toUrl("stg/workbench") + "/", window.location.href);
  const ADT = new URL("../../../adt", componentRoot).pathname.replace(/\/$/, "");
  const attr = (node, local) => [...node.attributes].find((a) => a.localName === local)?.value || "";
  const nodes = (doc, local) => [...doc.getElementsByTagName("*")].filter((node) => node.localName === local);
  const xml = (text) => new DOMParser().parseFromString(text, "application/xml");
  const escapeXml = (text) => String(text).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const short = (value) => value ? String(value).slice(0, 8) : "-";

  const OBJECT_TYPES = [
    {key: "CLAS/OC", text: "Classes", query: "ZCL_OSD*", mode: "abap", edit: true, tests: true},
    {key: "INTF/OI", text: "Interfaces", query: "ZIF*", mode: "abap", edit: true},
    {key: "PROG/P", text: "Programs", query: "Z*", mode: "abap", edit: true, tests: true},
    {key: "DDLS/DF", text: "CDS definitions", query: "ZC_*", mode: "sql", edit: true, preview: "cds"},
    {key: "TABL/DT", text: "Tables and structures", query: "ZOSD*", mode: "sql", preview: "ddic"},
    {key: "SRVD/SRV", text: "Service definitions", query: "Z*", mode: "sql"},
  ];

  function findings(text) {
    const doc = xml(text);
    const checks = nodes(doc, "checkMessage").map((item) => {
      const at = attr(item, "uri").match(/#start=(\d+),(\d+)/);
      return {line: Number(at?.[1] || 1), column: Number(at?.[2] || 1),
        severity: attr(item, "type") || "E", message: attr(item, "shortText")};
    });
    const activations = nodes(doc, "msg").map((item) => {
      const at = attr(item, "href").match(/#start=(\d+),(\d+)/);
      return {line: Number(attr(item, "line") || at?.[1] || 1), column: Number(at?.[2] || 1),
        severity: attr(item, "type") || "E",
        message: nodes(item, "txt")[0]?.textContent || "Activation failed"};
    });
    return [...checks, ...activations];
  }

  return Controller.extend("stg.workbench.controller.App", {
    onInit() {
      this._token = "";
      this._etag = "";
      this._searchTimer = 0;
      this._searchSeq = 0;
      this._objectSeq = 0;
      this._testSeq = 0;
      this._previewSeq = 0;
      this._objectType = OBJECT_TYPES[0].key;
      this.getView().setModel(new JSONModel({
        busy: false, query: OBJECT_TYPES[0].query, objectType: this._objectType,
        objectTypes: OBJECT_TYPES, editorMode: OBJECT_TYPES[0].mode,
        objects: [], selected: {}, source: "", dirty: false,
        capabilities: {edit: true, preview: "", tests: true},
        diagnostics: [], identity: {},
        preview: {loading: false, columns: [], rows: [], total: 0, ms: 0, query: "", message: "Run Preview Data to read up to 100 rows."},
        tests: {loading: false, classes: [], rows: [], selectedClass: "", selectedMethod: "",
          counts: {classes: 0, methods: 0, passed: 0, failed: 0, classAlerts: 0}, message: "Tests are discovered when a class or program opens."},
        git: {available: false, loading: false, branch: "-", headShort: "-", status: "", diff: "", file: "", reason: "", history: [], selectedRevision: ""},
        message: {text: "Choose an object type, search, and open a source.", type: "Information"}
      }), "ui");
      // Token and cookies are one handshake: no parallel first request may
      // create a second session and leave the token paired with its cookie.
      this._session().then(() => this._loadIdentity()).then(() => this._search(this._model().getProperty("/query")))
        .catch((error) => this._fail(error));
    },

    _model() { return this.getView().getModel("ui"); },
    _set(path, value) { this._model().setProperty(path, value); },
    _message(text, type = "Information") { this._set("/message", {text, type}); },
    _busy(value) { this._set("/busy", value); },
    _isSelected(object) {
      const selected = this._model().getProperty("/selected");
      return selected?.type === object?.type && selected?.name === object?.name &&
        selected?.uri === object?.uri;
    },

    async _mayDiscard(text) {
      if (!this._model().getProperty("/dirty")) return true;
      const action = await new Promise((resolve) => MessageBox.confirm(text, {
        title: "Unsaved edits", emphasizedAction: MessageBox.Action.OK, onClose: resolve
      }));
      return action === MessageBox.Action.OK;
    },

    async onDiscard() {
      if (!(await this._mayDiscard("Discard the unsaved editor buffer?"))) return;
      this.byId("source").setValue(this._model().getProperty("/source"));
      this._set("/dirty", false);
      this._showDiagnostics([]);
      this._message("Unsaved edits discarded. Stored inactive source is unchanged.", "Information");
    },

    async onObjectTypeChange(event) {
      const select = event.getSource();
      const next = select.getSelectedKey();
      const previous = this._objectType;
      if (next === previous) return;
      if (!(await this._mayDiscard("Discard the unsaved buffer and change object type?"))) {
        select.setSelectedKey(previous);
        this._set("/objectType", previous);
        return;
      }
      clearTimeout(this._searchTimer);
      this._searchTimer = 0;
      const config = OBJECT_TYPES.find((item) => item.key === next) || OBJECT_TYPES[0];
      this._objectType = config.key;
      this._etag = "";
      this._searchSeq += 1;
      this._set("/objectType", config.key);
      this._objectSeq += 1;
      this._testSeq += 1;
      this._previewSeq += 1;
      this._busy(false);
      this._set("/editorMode", config.mode);
      this._set("/capabilities", {edit: config.edit === true, preview: config.preview || "", tests: config.tests === true});
      this._set("/query", config.query);
      this._set("/objects", []);
      this._set("/selected", {});
      this._set("/source", "");
      this._set("/dirty", false);
      this._set("/preview", {loading: false, columns: [], rows: [], total: 0, ms: 0, query: "", message: "Run Preview Data to read up to 100 rows."});
      this._set("/tests", {loading: false, classes: [], rows: [], selectedClass: "", selectedMethod: "",
        counts: {classes: 0, methods: 0, passed: 0, failed: 0, classAlerts: 0},
        message: "Tests are discovered when a class or program opens."});
      this._set("/git", {available: false, loading: false, branch: "-", headShort: "-", status: "", diff: "", file: "", reason: "", history: [], selectedRevision: ""});
      this._showDiagnostics([]);
      this._message("Searching " + config.text + ".", "Information");
      await this._search(config.query);
    },

    onExit() {
      clearTimeout(this._searchTimer);
      this._searchSeq += 1;
      this._objectSeq += 1;
      this._testSeq += 1;
      this._previewSeq += 1;
    },

    async _session() {
      const response = await fetch(`${ADT}/core/discovery`, {
        method: "HEAD", headers: {"x-csrf-token": "fetch"}
      });
      if (!response.ok) throw new Error(`ADT discovery failed: HTTP ${response.status}`);
      this._token = response.headers.get("x-csrf-token") || "";
    },

    async _request(path, options = {}) {
      const headers = new Headers(options.headers || {});
      if (options.method && options.method !== "GET" && options.method !== "HEAD") {
        headers.set("x-csrf-token", this._token);
        headers.set("x-sap-adt-sessiontype", "stateful");
      }
      const canonical = "/sap/bc/adt";
      const target = path.startsWith(canonical) ? ADT + path.slice(canonical.length) : ADT + path;
      const response = await fetch(target, {...options, headers});
      if (!response.ok && response.status !== 304) {
        const detail = (await response.text()).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
        throw new Error(`${options.method || "GET"} ${path}: HTTP ${response.status}${detail ? ` — ${detail}` : ""}`);
      }
      return response;
    },

    async _loadIdentity() {
      const build = await (await this._request("/core/http/build")).json();
      const system = build.system || {};
      const identity = {commit: short(build.commit), source: short(system.source),
        live: short(system.live), serving: short(system.serving), synchronized: system.synchronized === true,
        sourceFull: system.source || "", liveFull: system.live || "", servingFull: system.serving || ""};
      this._set("/identity", identity);
      return identity;
    },

    async _loadGit(object = this._model().getProperty("/selected")) {
      if (!object?.name) return;
      this._set("/git/loading", true);
      try {
        const response = await this._request("/core/http/git/object?type=" +
          encodeURIComponent(object.type) + "&name=" + encodeURIComponent(object.name));
        const state = await response.json();
        this._set("/git", {...state, loading: false,
          branch: state.branch || "-", headShort: state.headShort || "-",
          selectedRevision: "",
          reason: state.reason || ""});
      } catch (error) {
        this._set("/git", {available: false, loading: false, branch: "-", headShort: "-",
          status: "unavailable", diff: "", file: "", reason: error.message || String(error), history: [], selectedRevision: ""});
      }
    },

    async onGitRefresh() {
      this._busy(true);
      try { await this._loadGit(); }
      finally { this._busy(false); }
    },

    onGitRevisionSelect(event) {
      const revision = event.getParameter("listItem").getBindingContext("ui").getObject().revision;
      this._set("/git/selectedRevision", revision);
    },

    async onRestoreRevision() {
      const object = this._model().getProperty("/selected");
      const revision = this._model().getProperty("/git/selectedRevision");
      const picked = this._model().getProperty("/git/history").find((item) => item.revision === revision);
      if (!object?.name || !picked) return;
      const action = await new Promise((resolve) => MessageBox.confirm(
        `Replace the current editor buffer with ${picked.shortRevision} — ${picked.subject}?`, {
          title: "Restore Git version", emphasizedAction: MessageBox.Action.OK, onClose: resolve
        }));
      if (action !== MessageBox.Action.OK) return;
      this._busy(true);
      try {
        const response = await this._request("/core/http/git/object/revision?type=" +
          encodeURIComponent(object.type) + "&name=" + encodeURIComponent(object.name) +
          "&revision=" + encodeURIComponent(revision));
        const restored = await response.text();
        this.byId("source").setValue(restored);
        const dirty = restored !== this._model().getProperty("/source");
        this._set("/dirty", dirty);
        this._showDiagnostics([]);
        this._message(dirty ? "Git version loaded into the editor. Save inactive, Check, then Activate when ready."
          : "The selected Git version already matches the stored source.", "Information");
      } catch (error) { this._fail(error); }
      finally { this._busy(false); }
    },

    onSearch(event) { this._search(event.getParameter("query") || event.getSource().getValue()); },
    onSearchLive(event) {
      clearTimeout(this._searchTimer);
      const value = event.getParameter("newValue");
      this._searchTimer = setTimeout(() => this._search(value), 250);
    },
    async _search(query) {
      const wanted = String(query || "").trim();
      if (!wanted) return;
      const request = ++this._searchSeq;
      const objectType = this._model().getProperty("/objectType");
      try {
        const response = await this._request(
          `/repository/informationsystem/search?operation=quickSearch&query=${encodeURIComponent(wanted)}` +
          `&objectType=${encodeURIComponent(objectType)}&maxResults=100`
        );
        const doc = xml(await response.text());
        if (request !== this._searchSeq || objectType !== this._model().getProperty("/objectType")) return;
        this._set("/objects", nodes(doc, "objectReference").map((item) => ({
          name: attr(item, "name"), uri: attr(item, "uri"), type: attr(item, "type"),
          packageName: attr(item, "packageName"), description: attr(item, "description")
        })));
      } catch (error) {
        if (request === this._searchSeq) this._fail(error);
      }
    },

    async onObjectSelect(event) {
      const object = event.getParameter("listItem").getBindingContext("ui").getObject();
      if (!(await this._mayDiscard("Discard the unsaved editor buffer and open another object?"))) return;
      const request = ++this._objectSeq;
      this._testSeq += 1;
      this._previewSeq += 1;
      this._busy(true);
      try {
        const config = OBJECT_TYPES.find((item) => item.key === object.type) || {};
        this._set("/capabilities", {edit: config.edit === true, preview: config.preview || "", tests: config.tests === true});
        this._set("/preview", {loading: false, columns: [], rows: [], total: 0, ms: 0, query: "", message: "Run Preview Data to read up to 100 rows."});
        this._set("/tests", {loading: false, classes: [], rows: [], selectedClass: "", selectedMethod: "",
          counts: {classes: 0, methods: 0, passed: 0, failed: 0, classAlerts: 0},
          message: config.tests ? "Discovering tests…" : "This object type has no ABAP Unit surface."});
        const response = await this._request(object.uri + "/source/main");
        const source = await response.text();
        if (request !== this._objectSeq) return;
        this._etag = response.headers.get("etag") || "";
        this._set("/selected", object);
        this._set("/source", source);
        this._set("/dirty", false);
        this._showDiagnostics([]);
        this._message(`${object.name} opened.`, "Success");
        await Promise.all([this._loadGit(object), config.tests ? this._loadTests(object) : Promise.resolve()]);
      } catch (error) { if (request === this._objectSeq) this._fail(error); }
      finally { if (request === this._objectSeq) this._busy(false); }
    },

    async _loadTests(object) {
      const request = ++this._testSeq;
      this._set("/tests/loading", true);
      try {
        const response = await this._request("/core/http/unit/object?type=" +
          encodeURIComponent(object.type) + "&name=" + encodeURIComponent(object.name));
        const found = await response.json();
        const rows = found.classes.flatMap((testClass) => testClass.methods.map((method) => ({
          className: testClass.name,
          methodName: method.name,
          riskLevel: testClass.riskLevel,
          durationCategory: testClass.durationCategory,
          include: testClass.include,
          line: method.line,
          column: method.column,
          status: "Not run",
          state: "None",
          duration: "",
          details: "",
        })));
        if (request !== this._testSeq || !this._isSelected(object)) return;
        this._set("/tests/classes", found.classes);
        this._set("/tests/rows", rows);
        this._set("/tests/message", rows.length === 0
          ? "No ABAP Unit methods belong to this object."
          : `${rows.length} method(s) in ${found.classes.length} test class(es).`);
      } catch (error) {
        if (request === this._testSeq && this._isSelected(object)) throw error;
      } finally {
        if (request === this._testSeq && this._isSelected(object)) this._set("/tests/loading", false);
      }
    },

    onTestSelect(event) {
      const row = event.getParameter("listItem").getBindingContext("ui").getObject();
      this._set("/tests/selectedClass", row.className);
      this._set("/tests/selectedMethod", row.methodName);
    },

    async onRunTests() { await this._runTests(); },
    async onRunSelectedTest() {
      await this._runTests({
        testClass: this._model().getProperty("/tests/selectedClass"),
        method: this._model().getProperty("/tests/selectedMethod"),
      });
    },

    async _runTests(selection = {}) {
      const object = this._model().getProperty("/selected");
      if (!object?.name) return;
      const request = ++this._testSeq;
      const inScope = (row) =>
        (!selection.testClass || row.className === selection.testClass) &&
        (!selection.method || row.methodName === selection.method);
      this._set("/tests/rows", this._model().getProperty("/tests/rows").map((row) =>
        inScope(row) ? {...row, status: "Running", state: "Information", duration: "", details: ""} : row
      ));
      this._set("/tests/loading", true);
      try {
        let path = "/core/http/unit/object/run?type=" + encodeURIComponent(object.type) +
          "&name=" + encodeURIComponent(object.name);
        if (selection.testClass) path += "&testClass=" + encodeURIComponent(selection.testClass);
        if (selection.method) path += "&method=" + encodeURIComponent(selection.method);
        const run = await (await this._request(path, {method: "POST"})).json();
        if (request !== this._testSeq || !this._isSelected(object)) return;
        const results = new Map();
        for (const testClass of run.testClasses || []) {
          const classAlerts = testClass.alerts || [];
          const classDetails = classAlerts.flatMap((alert) =>
            [alert.title, ...(alert.details || [])]).filter(Boolean).join(" · ");
          if (classAlerts.length > 0 && (testClass.testMethods || []).length === 0) {
            for (const row of this._model().getProperty("/tests/rows")) {
              if (row.className === testClass.name && inScope(row)) {
                results.set(`${row.className}=>${row.methodName}`, {
                  status: "Blocked", state: "Error", duration: "", details: classDetails,
                });
              }
            }
          }
          for (const method of testClass.testMethods || []) {
            const alerts = [...classAlerts, ...(method.alerts || [])];
            results.set(`${testClass.name}=>${method.name}`, {
              status: alerts.length === 0 ? "Passed" : "Failed",
              state: alerts.length === 0 ? "Success" : "Error",
              duration: `${method.executionTime || "0.000"} ${method.unit || "s"}`,
              details: alerts.flatMap((alert) => [alert.title, ...(alert.details || [])]).filter(Boolean).join(" · "),
            });
          }
        }
        const rows = this._model().getProperty("/tests/rows").map((row) => {
          const result = results.get(`${row.className}=>${row.methodName}`);
          if (result) return {...row, ...result};
          return inScope(row) ? {...row, status: "Not executed", state: "Warning",
            duration: "", details: "The runner returned no method result."} : row;
        });
        const classFailures = (run.testClasses || []).filter((item) =>
          (item.alerts || []).length > 0 && (item.testMethods || []).length === 0).length;
        this._set("/tests/rows", rows);
        this._set("/tests/counts", run.counts || {});
        this._set("/tests/message", `${run.counts?.passed || 0} passed, ${run.counts?.failed || 0} failed` +
          (classFailures ? `, ${classFailures} class-level failure(s)` : "") + ` in ${run.ms || 0} ms.`);
        this._message(run.ok ? "ABAP Unit passed." : "ABAP Unit reported failures.", run.ok ? "Success" : "Error");
      } catch (error) {
        if (request === this._testSeq && this._isSelected(object)) {
          const detail = error.message || String(error);
          this._set("/tests/rows", this._model().getProperty("/tests/rows").map((row) =>
            inScope(row) ? {...row, status: "Run failed", state: "Error", duration: "", details: detail} : row
          ));
          this._fail(error);
        }
      } finally {
        if (request === this._testSeq && this._isSelected(object)) this._set("/tests/loading", false);
      }
    },

    async onPreviewData() {
      const object = this._model().getProperty("/selected");
      const kind = this._model().getProperty("/capabilities/preview");
      if (!object?.name || !kind) return;
      const request = ++this._previewSeq;
      this._set("/preview/loading", true);
      try {
        const parameter = kind === "ddic" ? "ddicEntityName" : "ddlSourceName";
        const response = await this._request(`/datapreview/${kind}?rowNumber=100&${parameter}=` +
          encodeURIComponent(object.name), {method: "POST", headers: {"content-type": "text/plain"}, body: ""});
        const doc = xml(await response.text());
        const columns = nodes(doc, "columns").map((column, index) => ({
          name: attr(nodes(column, "metadata")[0], "name"), key: `c${index}`,
          values: nodes(column, "data").map((value) => value.textContent || ""),
        }));
        const count = Math.max(0, ...columns.map((column) => column.values.length));
        const rows = Array.from({length: count}, (_, row) => Object.fromEntries(
          columns.map((column) => [column.key, column.values[row] || ""])
        ));
        if (request !== this._previewSeq || !this._isSelected(object)) return;
        const table = this.byId("previewTable");
        table.unbindItems();
        table.destroyColumns();
        for (const column of columns) table.addColumn(new Column({header: new Text({text: column.name})}));
        table.bindItems({path: "ui>/preview/rows", template: new ColumnListItem({
          cells: columns.map((column) => new Text({text: `{ui>${column.key}}`, wrapping: false})),
        })});
        const value = (name) => nodes(doc, name)[0]?.textContent || "";
        this._set("/preview/columns", columns.map(({name, key}) => ({name, key})));
        this._set("/preview/rows", rows);
        this._set("/preview/total", Number(value("totalRows") || rows.length));
        this._set("/preview/ms", Number(value("queryExecutionTime") || 0));
        this._set("/preview/query", value("executedQueryString"));
        this._set("/preview/message", `${rows.length} row(s), ${columns.length} column(s).`);
      } catch (error) {
        if (request === this._previewSeq && this._isSelected(object)) this._fail(error);
      } finally {
        if (request === this._previewSeq && this._isSelected(object)) this._set("/preview/loading", false);
      }
    },

    onSourceChange(event) {
      // The editor owns its live buffer. Feeding every keystroke back through
      // the JSON model re-renders the editor and can overwrite its own caret.
      // Programmatic source loads also fire this event, so dirty is a real
      // comparison with the stored baseline rather than simply "changed".
      const value = event.getParameter("value") ?? this.byId("source").getCurrentValue();
      const dirty = value !== this._model().getProperty("/source");
      if (dirty !== this._model().getProperty("/dirty")) this._set("/dirty", dirty);
    },

    _checkBody(object, source) {
      return `<?xml version="1.0" encoding="UTF-8"?>` +
        `<chkrun:checkObjectList xmlns:chkrun="http://www.sap.com/adt/checkrun" xmlns:adtcore="http://www.sap.com/adt/core">` +
        `<chkrun:checkObject adtcore:uri="${object.uri}" chkrun:version="active"><chkrun:artifacts>` +
        `<chkrun:artifact chkrun:contentType="text/plain; charset=utf-8" chkrun:uri="${object.uri}/source/main">` +
        `<chkrun:content>${escapeXml(source)}</chkrun:content></chkrun:artifact>` +
        `</chkrun:artifacts></chkrun:checkObject></chkrun:checkObjectList>`;
    },
    _showDiagnostics(items) {
      this._set("/diagnostics", items);
      this.byId("source").setDiagnostics(items);
    },
    async _check() {
      const object = this._model().getProperty("/selected");
      const source = this.byId("source").getCurrentValue();
      const response = await this._request("/checkruns?reporters=abapCheckRun", {
        method: "POST", headers: {"content-type": "application/*"}, body: this._checkBody(object, source)
      });
      const text = await response.text();
      const reports = nodes(xml(text), "checkReport");
      if (reports.length === 0) throw new Error("Check returned no report.");
      const incomplete = reports.find((report) => attr(report, "status") !== "processed");
      if (incomplete) {
        throw new Error("Check did not complete: " +
          (attr(incomplete, "statusText") || attr(incomplete, "status")));
      }
      const items = findings(text);
      this._showDiagnostics(items);
      this._message(items.length ? `${items.length} problem(s). Nothing was saved or activated.`
        : "Check passed. Nothing was saved or activated.", items.length ? "Error" : "Success");
      return items.length === 0;
    },
    async onCheck() {
      this._busy(true);
      try { await this._check(); } catch (error) { this._fail(error); }
      finally { this._busy(false); }
    },

    async _save() {
      const object = this._model().getProperty("/selected");
      const source = this.byId("source").getCurrentValue();
      const locked = await this._request(`${object.uri}?_action=LOCK&accessMode=MODIFY`, {method: "POST"});
      const handle = (await locked.text()).match(/<LOCK_HANDLE>([^<]*)<\/LOCK_HANDLE>/)?.[1] || "";
      if (!handle) throw new Error(`${object.name} is read-only in this system.`);
      try {
        const saved = await this._request(`${object.uri}/source/main?lockHandle=${encodeURIComponent(handle)}`, {
          method: "PUT", headers: {"content-type": "text/plain; charset=utf-8",
            ...(this._etag ? {"if-match": this._etag} : {})}, body: source
        });
        this._etag = saved.headers.get("etag") || this._etag;
        this._set("/source", source);
        this._set("/dirty", false);
        this._message("Saved as inactive source. Runtime is unchanged until Activate.", "Success");
        await this._loadGit(object);
      } finally {
        await this._request(`${object.uri}?_action=UNLOCK&lockHandle=${encodeURIComponent(handle)}`, {method: "POST"});
      }
    },
    async onSave() {
      this._busy(true);
      try { await this._save(); await this._loadIdentity(); } catch (error) { this._fail(error); }
      finally { this._busy(false); }
    },

    async onActivate() {
      this._busy(true);
      try {
        if (!(await this._check())) return;
        if (this._model().getProperty("/dirty")) await this._save();
        const object = this._model().getProperty("/selected");
        const body = `<adtcore:objectReferences xmlns:adtcore="http://www.sap.com/adt/core">` +
          `<adtcore:objectReference adtcore:uri="${object.uri}" adtcore:name="${object.name}"/>` +
          `</adtcore:objectReferences>`;
        const response = await this._request("/activation?method=activate&preauditRequested=true", {
          method: "POST", headers: {"content-type": "application/xml",
            ...(this._etag ? {"if-match": this._etag} : {})}, body
        });
        const text = await response.text();
        const items = findings(text);
        const successful = /activationExecuted="true"/.test(text) && items.length === 0;
        this._showDiagnostics(items);
        const identity = await this._loadIdentity();
        let message = String(items.length || 1) + " activation problem(s). Current source, live and serving identities are shown above.";
        if (successful && identity.synchronized && identity.servingFull === identity.liveFull && identity.servingFull !== "") {
          message = "Activated and serving generation " + identity.serving + ".";
        } else if (successful && identity.sourceFull === identity.liveFull && identity.sourceFull !== "") {
          message = "Activated and built, but the serving runtime has not switched to this generation; restart or child runtime is required.";
        } else if (successful) {
          message = "Activation was accepted, but source, live and serving identities are not synchronized.";
        }
        this._message(message, successful ? (identity.synchronized ? "Success" : "Warning") : "Error");
      } catch (error) { this._fail(error); }
      finally { this._busy(false); }
    },

    onProblemSelect(event) {
      const item = event.getParameter("listItem").getBindingContext("ui").getObject();
      this.byId("source").reveal(item.line, item.column);
    },
    _fail(error) { this._message(error.message || String(error), "Error"); }
  });
});
