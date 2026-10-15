sap.ui.define([
  "sap/ui/core/UIComponent", "sap/ui/model/json/JSONModel",
  "sap/ui/layout/Splitter", "sap/ui/layout/SplitterLayoutData",
  "sap/m/Page", "sap/m/List", "sap/m/StandardListItem", "sap/m/SearchField",
  "sap/m/Select", "sap/ui/core/Item", "sap/m/Toolbar", "sap/m/ToolbarSpacer", "sap/m/Label",
  "sap/m/Text", "sap/m/Title", "sap/m/ObjectStatus", "sap/m/Table", "sap/m/Column",
  "sap/m/ColumnListItem", "sap/m/VBox", "sap/m/MessageStrip", "sap/m/Button"
], function (UIComponent, JSONModel, Splitter, SplitterLayoutData, Page, List, StandardListItem, SearchField,
             Select, Item, Toolbar, ToolbarSpacer, Label, Text, Title, ObjectStatus, Table, Column,
             ColumnListItem, VBox, MessageStrip, Button) {
  "use strict";

  return UIComponent.extend("osd.zvdb.Component", {
    metadata: {manifest: "json"},

    createContent: function () {
      var service = this.getModel();
      var state = new JSONModel({
        bucket: "EGEMMA768", engine: "ANYDB", database: "detecting …", allVectors: [], vectors: [], results: [],
        amdpEnabled: false, hanaEnabled: false,
        queryId: "", queryText: "Choose a text on the left.", queryMeta: "",
        message: "Loading query vectors …"
      });
      this.setModel(state, "state");

      var groups = {
        I01: "alarm · query", I02: "alarm · set",
        I03: "calendar · query", I04: "calendar · set",
        I05: "email · query", I06: "email · send",
        I07: "IoT · cleaning", I08: "IoT · coffee",
        I09: "lists · add", I10: "lists · query",
        I11: "music · likeness", I12: "music · query",
        I13: "play · music", I14: "play · radio",
        I15: "questions · definition", I16: "questions · factoid",
        I17: "recommendations · events", I18: "recommendations · movies",
        I19: "transport · query", I20: "transport · taxi",
        I21: "audio · mute", I22: "audio · volume",
        I23: "cooking · query", I24: "cooking · recipe",
        I25: "datetime · convert", I26: "datetime · query",
        I27: "general · greeting", I28: "general · joke",
        I29: "news · query", I30: "social · post", I31: "social · query",
        I32: "takeaway · order", I33: "takeaway · query",
        I34: "weather · query", I35: "play · audiobook", I36: "play · game",
        I37: "play · podcasts", I38: "questions · currency",
        I39: "questions · maths", I40: "questions · stock"
      };

      var quote = function (value) { return String(value).replace(/'/g, "''"); };
      var errorText = function (error) {
        try {
          var body = JSON.parse(error.responseText || "{}");
          return body.error && body.error.message && (body.error.message.value || body.error.message);
        } catch (ignored) { /* use the transport message below */ }
        return error.message || error.statusText || "HTTP request failed";
      };

      var masterList = new List(this.createId("masterList"), {
        mode: "SingleSelectMaster", growing: true, growingThreshold: 50, noDataText: "No matching texts",
        selectionChange: function (event) {
          var row = event.getParameter("listItem").getBindingContext("state").getObject();
          state.setProperty("/queryId", row.Id);
          state.setProperty("/queryText", row.Payload);
          state.setProperty("/queryMeta", row.Bucket + " · " + row.Id + " · " + row.Dimensions + " bit · " + row.Model);
          runSearch();
        }
      });
      masterList.bindItems({path: "state>/vectors", template: new StandardListItem({
        title: "{state>Payload}", description: "{state>Group} · {state>Id}", info: "{state>Dimensions} bit", type: "Active"
      })});

      var loadVectors = function (term) {
        var bucket = state.getProperty("/bucket");
        state.setProperty("/message", "Loading " + bucket + " …");
        var filter = "Bucket eq '" + quote(bucket) + "'";
        if (term) filter += " and substringof('" + quote(term) + "',Payload)";
        var parameters = {"$filter": filter, "$orderby": "Id asc", "$top": "2500"};
        service.read("/VectorSet", {urlParameters: parameters, success: function (data) {
          // The corpus IDs are grouped by intent. Interleave them by parallel
          // phrase and locale so the initial Master visibly spans all twenty
          // intents instead of looking like an alarm-only corpus.
          var rows = (data.results || []).map(function (row) {
            return Object.assign({}, row, {Group: groups[row.Id.slice(0, 3)] || "corpus"});
          }).sort(function (left, right) {
            return (left.Id.slice(3) + left.Id.slice(0, 3)).localeCompare(right.Id.slice(3) + right.Id.slice(0, 3));
          });
          state.setProperty("/allVectors", rows);
          state.setProperty("/vectors", rows);
          state.setProperty("/message", rows.length + (term ? " matching" : "") + " query vectors in " + bucket + ".");
        }, error: function (error) {
          state.setProperty("/vectors", []);
          state.setProperty("/message", "Cannot load vectors: " + errorText(error));
        }});
      };

      var results = new Table({
        noDataText: "Choose a query text to see its nearest neighbours.",
        columns: [
          new Column({width: "6rem", header: new Text({text: "Rank"})}),
          new Column({width: "8rem", header: new Text({text: "Similarity"})}),
          new Column({header: new Text({text: "Found text"})}),
          new Column({header: new Text({text: "Explanation"})}),
          new Column({width: "7rem", header: new Text({text: "Engine"})})
        ]
      });
      results.bindItems({path: "state>/results", template: new ColumnListItem({cells: [
        new ObjectStatus({text: "{state>Rank}", state: "Success"}),
        new ObjectStatus({text: "{state>Similarity}", state: "Information"}),
        new VBox({items: [new Text({text: "{state>Payload}"}), new Text({text: "{state>ResultId}"})]}),
        new Text({text: "{state>Explanation}"}), new Text({text: "{state>Engine}"})
      ]})});

      var runSearch = function () {
        var bucket = state.getProperty("/bucket");
        var query = state.getProperty("/queryId");
        var engine = state.getProperty("/engine");
        if (engine === "AMDP" && !state.getProperty("/amdpEnabled")) {
          state.setProperty("/results", []);
          state.setProperty("/message", "Portable AMDP requires an OSD instance running on DuckDB. This deployment uses "
            + state.getProperty("/database") + ".");
          return;
        }
        if (engine === "HANA" && !state.getProperty("/hanaEnabled")) {
          state.setProperty("/results", []);
          state.setProperty("/message", "Native AMDP requires an OSD instance running on SAP HANA. This deployment uses "
            + state.getProperty("/database") + ".");
          return;
        }
        if (!query) return;
        state.setProperty("/message", "Searching " + bucket + " with " + engine + " …");
        var filter = "Bucket eq '" + quote(bucket) + "' and QueryId eq '" + quote(query)
          + "' and Engine eq '" + quote(engine) + "'";
        service.read("/SearchResultSet", {urlParameters: {"$filter": filter, "$top": "20"}, success: function (data) {
          var mapped = (data.results || []).map(function (row) {
            var dimensions = Number(row.Dimensions);
            var rank = Number(row.Rank);
            var matching = (dimensions + rank) / 2;
            var percent = dimensions ? 100 * matching / dimensions : 0;
            return Object.assign({}, row, {
              Similarity: percent.toFixed(1) + "%",
              Explanation: matching + " of " + dimensions + " sign bits agree"
            });
          });
          state.setProperty("/results", mapped);
          state.setProperty("/message", mapped.length + " nearest texts, sorted by " + engine + " rank.");
        }, error: function (error) {
          state.setProperty("/results", []);
          var hint = engine === "HANA" ? " Native HANA AMDP needs a reachable HANA destination; check its connection settings."
            : engine === "AMDP" ? " The original SQLScript runs through Portable-AMDP on DuckDB." : "";
          state.setProperty("/message", engine + " failed: " + errorText(error) + hint);
        }});
      };

      var timer;
      var searchField = new SearchField(this.createId("masterSearch"), {
        width: "100%", placeholder: "Find the text to use as a query",
        liveChange: function (event) {
          clearTimeout(timer);
          var value = event.getParameter("newValue");
          timer = setTimeout(function () { loadVectors(value); }, 250);
        }, search: function (event) { loadVectors(event.getParameter("query")); }
      });
      var randomizeMaster = function () {
        var rows = state.getProperty("/allVectors") || [];
        var byGroup = {};
        rows.forEach(function (row) { (byGroup[row.Group] ||= []).push(row); });
        var sample = Object.keys(byGroup).map(function (group) {
          var choices = byGroup[group];
          return choices[Math.floor(Math.random() * choices.length)];
        }).sort(function () { return Math.random() - 0.5; }).slice(0, 20);
        masterList.removeSelections(true);
        state.setProperty("/vectors", sample);
        state.setProperty("/message", sample.length + " random texts, one per distinct group.");
      };
      var bucket = new Select(this.createId("bucketSelect"), {selectedKey: "{state>/bucket}", items: [
        new Item({key: "EGEMMA768", text: "EmbeddingGemma · 768 bit"}),
        new Item({key: "QWEN31024", text: "Qwen3 Embedding · 1024 bit"})
      ], change: function () {
        masterList.removeSelections(true);
        state.setProperty("/queryId", "");
        state.setProperty("/queryText", "Choose a text on the left.");
        state.setProperty("/queryMeta", "");
        state.setProperty("/results", []);
        searchField.setValue("");
        loadVectors("");
      }});
      var engine = new Select(this.createId("engineSelect"), {selectedKey: "{state>/engine}", items: [
        new Item({key: "ANYDB", text: "Portable ABAP (ANYDB)"}),
        new Item({key: "AMDP", text: "Portable AMDP (DuckDB)", enabled: "{state>/amdpEnabled}"}),
        new Item({key: "HANA", text: "SAP HANA AMDP (HANA only)", enabled: "{state>/hanaEnabled}"})
      ], change: runSearch});

      var master = new Page({title: "Choose query text", subHeader: new Toolbar({content: [
        new Label({text: "Bucket"}), bucket, new ToolbarSpacer(), new ObjectStatus({text: "DB: {state>/database}"})
      ]}), content: [new Toolbar({content: [searchField, new Button(this.createId("randomButton"), {
        text: "Random", icon: "sap-icon://random", tooltip: "Show a random sample across distinct groups", press: randomizeMaster
      })]}), masterList]});
      var detail = new Page({title: "Nearest texts", content: [new VBox({items: [
        new MessageStrip({text: "{state>/message}", showIcon: true}),
        new Toolbar({content: [new Label({text: "Engine"}), engine, new ToolbarSpacer(),
          new Button({text: "Search again", icon: "sap-icon://refresh", press: runSearch})]}),
        new Title({text: "{state>/queryText}", level: "H2"}),
        new Text({text: "{state>/queryMeta}"}), results
      ]})]});
      master.setLayoutData(new SplitterLayoutData({size: "32%", minSize: 260, resizable: true}));
      detail.setLayoutData(new SplitterLayoutData({size: "68%", minSize: 420, resizable: true}));
      // A percentage height collapses to the two page headers when the app is
      // opened directly: the UIArea has no explicit CSS height to inherit.
      // A viewport height works both directly and inside the launchpad iframe.
      var split = new Splitter(this.createId("splitter"), {height: "100vh", contentAreas: [master, detail]});
      fetch("../../sap/opu/odata/sap/ZOSD_STATUS_SRV/DatabaseSet?$format=json").then(function (response) {
        return response.json();
      }).then(function (body) {
        var facts = body.d && body.d.results || [];
        var engineFact = facts.find(function (fact) { return fact.Category === "Database" && fact.Name === "Engine"; });
        var storageFact = facts.find(function (fact) { return fact.Category === "Database" && fact.Name === "Storage"; });
        var backend = engineFact ? String(engineFact.Value) : "unknown backend";
        state.setProperty("/database", backend + (storageFact ? " · " + storageFact.Value : ""));
        var portable = backend.toLowerCase() === "duckdb";
        state.setProperty("/amdpEnabled", portable);
        state.setProperty("/hanaEnabled", backend.toUpperCase() === "HDB");
        // On a DuckDB deployment, show the engine this demo exists to prove.
        // Do not switch beneath someone who has already chosen a query/engine.
        if (portable && !state.getProperty("/queryId") && state.getProperty("/engine") === "ANYDB") {
          state.setProperty("/engine", "AMDP");
        }
      }).catch(function () {
        state.setProperty("/database", "unknown backend");
        state.setProperty("/amdpEnabled", false);
        state.setProperty("/hanaEnabled", false);
      });
      setTimeout(function () { loadVectors(""); }, 0);
      return split;
    }
  });
});
