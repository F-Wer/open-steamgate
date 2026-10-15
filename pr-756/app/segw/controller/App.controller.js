sap.ui.define([
  "sap/ui/core/mvc/Controller",
  "sap/ui/model/json/JSONModel",
  "sap/ui/model/Filter",
  "sap/ui/model/FilterOperator",
  "sap/ui/model/Sorter",
  "sap/ui/core/Title",
  "sap/m/Label",
  "sap/m/Input",
  "sap/m/Dialog",
  "sap/m/Button",
  "sap/m/List",
  "sap/m/StandardListItem",
  "sap/m/TextArea",
  "sap/m/Select",
  "sap/ui/core/Item",
  "sap/m/Table",
  "sap/m/Column",
  "sap/m/ColumnListItem",
  "sap/m/Text",
  "sap/m/OverflowToolbar",
  "sap/m/ToolbarSpacer",
  "sap/m/Title",
  "sap/m/MessageToast",
  "sap/m/MessageBox",
], function (Controller, JSONModel, Filter, FilterOperator, Sorter, Title, Label, Input, Dialog, Button, List,
  StandardListItem, TextArea, Select, Item, Table, Column, ColumnListItem, Text, OverflowToolbar, ToolbarSpacer, MTitle,
  MessageToast, MessageBox) {
  "use strict";

  // The tree SEGW shows, in terms of the entity sets of ZSTG_SEGW_SRV (one
  // per /IWBEP/I_SB* table). A folder lists the rows of a set below a
  // parent; `by` names the property that points at the parent's NODE_UUID,
  // `text` the property shown, `children` the folders under each row.
  const TREE = [
    {text: "Data Model", icon: "sap-icon://tree", children: [
      {text: "Entity Types", set: "EntityTypeSet", entity: "EntityType", icon: "sap-icon://database", children: [
        {text: "Properties", set: "PropertySet", entity: "Property", by: "ParentUuid", icon: "sap-icon://text"},
        {text: "Navigation Properties", set: "NavPropertySet", entity: "NavProperty", by: "EntityGuid", icon: "sap-icon://chain-link"},
      ]},
      {text: "Complex Types", set: "ComplexTypeSet", entity: "ComplexType", icon: "sap-icon://group-2", children: [
        {text: "Properties", set: "PropertySet", entity: "Property", by: "ParentUuid", icon: "sap-icon://text"},
      ]},
      {text: "Associations", set: "AssociationSet", entity: "Association", icon: "sap-icon://connected", children: [
        {text: "Referential Constraints", set: "RefConstraintSet", entity: "RefConstraint", by: "AssociationGuid", icon: "sap-icon://key"},
      ]},
      {text: "Entity Sets", set: "EntitySetSet", entity: "EntitySet", icon: "sap-icon://list"},
      {text: "Association Sets", set: "AssociationSetSet", entity: "AssociationSet", icon: "sap-icon://multiselect-all"},
      {text: "Function Imports", set: "FunctionImportSet", entity: "FunctionImport", icon: "sap-icon://action", children: [
        {text: "Parameters", set: "FunctionParamSet", entity: "FunctionParam", by: "FunctionImport", icon: "sap-icon://text"},
      ]},
    ]},
    {text: "Service Implementation", icon: "sap-icon://provision", children: [
      {text: "", set: "ServiceEntitySet", entity: "ServiceEntity", icon: "sap-icon://list", children: [
        {text: "", set: "OperationSet", entity: "Operation", by: "ParentUuid", icon: "sap-icon://process", children: [
          {text: "", set: "MappingHeaderSet", entity: "MappingHeader", by: "ParentUuid", icon: "sap-icon://map-2", children: [
            {text: "", set: "MappingPropertySet", entity: "MappingProperty", by: "ParentUuid", icon: "sap-icon://arrow-right"},
          ]},
        ]},
      ]},
    ]},
    {text: "Data Sources", set: "DataSourceSet", entity: "DataSource", icon: "sap-icon://source-code"},
    {text: "Runtime Artifacts", set: "ArtifactSet", entity: "Artifact", icon: "sap-icon://syntax"},
    {text: "Service Maintenance", set: "ServiceSet", entity: "Service", icon: "sap-icon://settings"},
  ];
  // the text table of a node's table, where SEGW keeps the label
  const TEXTS = {
    Project: "ProjectTextSet", Model: "ModelTextSet", EntityType: "EntityTypeTextSet", Property: "PropertyTextSet",
    EntitySet: "EntitySetTextSet", NavProperty: "NavPropertyTextSet", AssociationSet: "AssociationSetTextSet",
    FunctionImport: "FunctionImportTextSet", FunctionParam: "FunctionParamTextSet", DataSource: "DataSourceTextSet",
    ComplexType: "ComplexTypeTextSet",
  };
  const label = (row, entity) => {
    if (entity === "MappingProperty") {
      // property (or constant) and the module parameter it maps to
      const source = row.PropertyPath || ("'" + (row.ConstantVal || "") + "'");
      return row.Direction === "O" ? source + " <- " + row.DsAttPath : source + " -> " + row.DsAttPath;
    }
    return row.Name || row.TechnicalName || row.TrobjName || row.DsGroup || row.NodeUuid;
  };
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random()).replace(/[^0-9a-f]/gi, "").toUpperCase().padEnd(32, "0").slice(0, 32);

  // What SEGW's "Create" on a node makes, as rows: a folder (the set it
  // lists) or a row (its entity) offers the adds below; `fields` is the
  // dialog, `rows(v, c)` the [set, row] pairs POSTed in one $batch. c gives
  // the project, the model and service node ids, the rows of the tree
  // (c.rows[set]), the selected row (c.row), fresh ids (c.id()) and the next
  // STG_SEQ (c.seq()). The shapes are stg-compile's (tools/stg-compile.mjs,
  // iwprXml), i.e. what SEGW writes.
  const OPERATIONS = [["C", "Create", "CREATE_ENTITY"], ["R", "GetEntity (Read)", "GET_ENTITY"], ["U", "Update", "UPDATE_ENTITY"], ["D", "Delete", "DELETE_ENTITY"], ["Q", "GetEntitySet (Query)", "GET_ENTITYSET"]];
  const key = (c, id) => ({Project: c.project, NodeUuid: id});
  // the text row of a node: SEGW's label field, or the key alone
  const textRow = (c, set, id, field, value) => [set, {Language: "E", Project: c.project, NodeUuid: id, ...(field ? {[field]: value} : {}), StgSeq: c.seq()}];
  const typeOptions = (c) => (c.rows.EntityTypeSet || []).map((r) => ({key: r.NodeUuid, text: r.Name}));
  const firstSetOf = (c, typeUuid) => (c.rows.EntitySetSet || []).find((r) => r.EntityType === typeUuid);
  const ADDS = {
    entityType: {
      label: "Add entity type", fields: [{key: "Name", label: "Name", placeholder: "e.g. Plane"}],
      rows: (v, c) => {
        const id = c.id();
        return [
          ["EntityTypeSet", {...key(c, id), Name: v.Name, Model: c.model, RefType: "T", TechName: v.Name.toUpperCase(), DescriptionXu: "X", StgSeq: c.seq()}],
          textRow(c, "EntityTypeTextSet", id, "EtLabel", v.Name),
        ];
      },
    },
    entitySet: {
      label: "Add entity set", fields: [{key: "Name", label: "Name", placeholder: "e.g. PlaneSet"}, {key: "EntityType", label: "Entity type", options: typeOptions}],
      rows: (v, c) => {
        const es = c.id();
        const se = c.id();
        const rows = [
          ["EntitySetSet", {...key(c, es), Model: c.model, Name: v.Name, EntityType: v.EntityType, Creatable: "X",
            Updatable: "X", Deletable: "X", Pageable: "X", Addressable: "X", RefType: "T", TechName: v.Name.toUpperCase(),
            DescriptionXu: "X", StgSeq: c.seq()}],
          textRow(c, "EntitySetTextSet", es, "EsetLabel", v.Name),
          // the service implementation node of the set and its five operations
          ["ServiceEntitySet", {...key(c, se), ParentUuid: c.service, Name: v.Name, EntitySetUuid: es, StgSeq: c.seq()}],
          textRow(c, "ServiceEntityTextSet", se),
        ];
        for (const [type, name, suffix] of OPERATIONS) {
          const op = c.id();
          rows.push(["OperationSet", {...key(c, op), ParentUuid: se, Name: name, OperationType: type, ImpMethod: `${v.Name.toUpperCase().slice(0, 16)}_${suffix}`, StgSeq: c.seq()}]);
          rows.push(textRow(c, "OperationTextSet", op));
        }
        return rows;
      },
    },
    association: {
      label: "Add association",
      fields: [
        {key: "Name", label: "Name", placeholder: "e.g. PlaneToSeats"},
        {key: "Left", label: "Left entity type", options: typeOptions}, {key: "LeftCard", label: "Left cardinality", options: () => [{key: "1", text: "1"}, {key: "0", text: "0..1"}, {key: "N", text: "N"}]},
        {key: "Right", label: "Right entity type", options: typeOptions}, {key: "RightCard", label: "Right cardinality", options: () => [{key: "N", text: "N"}, {key: "1", text: "1"}, {key: "0", text: "0..1"}]},
      ],
      rows: (v, c) => {
        const aso = c.id();
        const rows = [
          ["AssociationSet", {...key(c, aso), Name: v.Name, ModelGuid: c.model, LeftEndGuid: v.Left, RightEndGuid: v.Right, LeftEndCard: v.LeftCard, RightEndCard: v.RightCard, RefType: "T", DescriptionXu: "X", StgSeq: c.seq()}],
          textRow(c, "SboAstSet", aso, "AssocLabel", v.Name),
        ];
        // the association set between the first sets of the two types, when both have one
        const left = firstSetOf(c, v.Left);
        const right = firstSetOf(c, v.Right);
        if (left && right) {
          const at = c.id();
          rows.push(["AssociationSetSet", {...key(c, at), Name: v.Name + "Set", ModelGuid: c.model, LeftEndGuid: left.NodeUuid, RightEndGuid: right.NodeUuid, AssociationGuid: aso, RefType: "T", DescriptionXu: "X", StgSeq: c.seq()}]);
          rows.push(textRow(c, "AssociationSetTextSet", at, "AsstLabel", v.Name + "Set"));
        }
        return rows;
      },
    },
    navigationProperty: {
      label: "Add navigation property",
      fields: [{key: "Name", label: "Name", placeholder: "e.g. to_Seats"}, {key: "Association", label: "Association", options: (c) => (c.rows.AssociationSet || []).map((r) => ({key: r.NodeUuid, text: r.Name}))}],
      rows: (v, c) => {
        const np = c.id();
        return [
          ["NavPropertySet", {...key(c, np), Name: v.Name, RelationGuid: v.Association, EntityGuid: c.row.NodeUuid, RefType: "T", TechName: v.Name.toUpperCase(), DescriptionXu: "X", StgSeq: c.seq()}],
          textRow(c, "NavPropertyTextSet", np, "NavpLabel", v.Name),
        ];
      },
    },
    functionImport: {
      label: "Add function import",
      fields: [
        {key: "Name", label: "Name", placeholder: "e.g. Refuel"},
        {key: "HttpMethod", label: "HTTP method", options: () => [{key: "POST", text: "POST"}, {key: "GET", text: "GET"}]},
        {key: "ReturnType", label: "Returns entity type", options: (c) => [{key: "", text: "(nothing)"}, ...typeOptions(c)]},
      ],
      rows: (v, c) => {
        const fi = c.id();
        const set = v.ReturnType ? firstSetOf(c, v.ReturnType) : undefined;
        return [
          ["FunctionImportSet", {...key(c, fi), Model: c.model, Name: v.Name, HttpMethod: v.HttpMethod,
            ReturnCard: v.ReturnType ? "1" : "", ReturnRefType: v.ReturnType, ReturnTypeKind: v.ReturnType ? "ETYP" : "",
            ReturnEntityset: set ? set.NodeUuid : "", RefType: "T", DescriptionXu: "X", StgSeq: c.seq()}],
          textRow(c, "FunctionImportTextSet", fi, "FiLabel", v.Name),
        ];
      },
    },
    parameter: {
      label: "Add parameter", fields: [{key: "Name", label: "Name", placeholder: "e.g. PlaneId"}],
      rows: (v, c) => {
        const fp = c.id();
        return [
          ["FunctionParamSet", {...key(c, fp), Name: v.Name, FunctionImport: c.row.NodeUuid, AbapField: v.Name.toUpperCase(), EdmCoreType: "Edm.String", MaxLength: "10", RefType: "T", AbtyXu: "X", DescriptionXu: "X", StgSeq: c.seq()}],
          textRow(c, "FunctionParamTextSet", fp, "FiParamLabel", v.Name),
        ];
      },
    },
    property: {
      label: "Add property", fields: [{key: "Name", label: "Name", placeholder: "e.g. Price"}],
      rows: (v, c) => {
        const pr = c.id();
        const siblings = (c.rows.PropertySet || []).filter((r) => r.ParentUuid === c.row.NodeUuid);
        return [
          ["PropertySet", {...key(c, pr), ParentUuid: c.row.NodeUuid, Name: v.Name, EdmCoreType: "Edm.String", MaxLength: "10", Creatable: "X", Updatable: "X", Sortable: "X", Filterable: "X", IsNullable: "X",
            RefType: "T", AbapField: v.Name.toUpperCase(), AbtyXu: "X", SortOrder: String(siblings.length + 1), StgSeq: c.seq()}],
          textRow(c, "PropertyTextSet", pr, "PropLabel", v.Name),
        ];
      },
    },
  };
  // which adds a folder (by the set it lists) or a row (by its entity) offers
  const FOLDER_ADDS = {EntityTypeSet: ["entityType"], EntitySetSet: ["entitySet"], AssociationSet: ["association"], FunctionImportSet: ["functionImport"]};
  const ROW_ADDS = {EntityType: ["property", "navigationProperty"], ComplexType: ["property"], FunctionImport: ["parameter"]};
  // the overview of a folder: the columns worth a glance per set (the rest
  // is the row's form); a set not listed shows Name and the node id
  const OVERVIEW = {
    EntityTypeSet: ["Name", "TechName", "AbapStruct", "IsMedia"],
    ComplexTypeSet: ["Name", "TechName", "AbapStruct"],
    PropertySet: ["Name", "EdmCoreType", "MaxLength", "IsKey", "IsNullable", "AbapField", "ComplexType"],
    NavPropertySet: ["Name", "TechName", "RelationGuid"],
    AssociationSet: ["Name", "LeftEndGuid", "LeftEndCard", "RightEndGuid", "RightEndCard"],
    RefConstraintSet: ["Name", "PrincipalPropR", "DependentPropR"],
    EntitySetSet: ["Name", "EntityType", "Creatable", "Updatable", "Deletable", "Searchable", "Pageable"],
    AssociationSetSet: ["Name", "AssociationGuid", "LeftEndGuid", "RightEndGuid"],
    FunctionImportSet: ["Name", "HttpMethod", "ReturnTypeKind", "ReturnRefType", "ReturnCard"],
    FunctionParamSet: ["Name", "EdmCoreType", "MaxLength", "AbapField"],
    ServiceEntitySet: ["Name", "EntitySetUuid"],
    OperationSet: ["Name", "OperationType", "ImpMethod"],
    MappingHeaderSet: ["Name", "DsUuid"],
    MappingPropertySet: ["PropertyPath", "ConstantVal", "Direction", "DsAttPath"],
    DataSourceSet: ["Name", "DsType", "DsGroup", "FunctionName", "RfcDest"],
    ArtifactSet: ["Name", "TrobjType", "GenArtType"],
    ServiceSet: ["TechnicalName", "Version", "Dpc", "ExternalName"],
  };
  // a node id in a column reads as the name of the node it points at
  const GUID_COLUMNS = new Set(["EntityType", "RelationGuid", "LeftEndGuid", "RightEndGuid", "AssociationGuid", "ReturnRefType", "EntitySetUuid", "DsUuid", "PrincipalPropR", "DependentPropR", "ComplexType"]);

  return Controller.extend("stg.segw.controller.App", {
    onInit() {
      this.getView().setModel(new JSONModel({nodes: []}), "tree");
      this.getView().setModel(new JSONModel({}), "node");
      const model = this.getOwnerComponent().getModel();
      model.metadataLoaded().then(() => {
        // the first project once the Select has its items
        const select = this.byId("project");
        const binding = select.getBinding("items");
        const first = () => {
          if (select.getSelectedItem() === null && select.getItems().length > 0) {
            select.setSelectedItem(select.getItems()[0]);
          }
          if (select.getSelectedKey()) {
            binding.detachDataReceived(first);
            this.loadProject(select.getSelectedKey());
          }
        };
        binding.attachDataReceived(first);
        first();
      });
    },

    // an abapGit IWPR file into the tables: POST ImportSet {Content}, the
    // service replaces the project's rows (zcl_stg_segw_import), then the
    // project list and the tree are read again
    onImport() {
      let input = document.getElementById("stg-segw-import");
      if (!input) {
        input = document.createElement("input");
        input.type = "file";
        input.id = "stg-segw-import";
        input.accept = ".xml";
        input.hidden = true;
        input.addEventListener("change", () => {
          const file = input.files[0];
          input.value = "";
          if (!file) {
            return;
          }
          file.text().then((content) => this.importIwpr(content, file.name));
        });
        document.body.appendChild(input);
      }
      input.click();
    },

    importIwpr(content, name) {
      const model = this.getOwnerComponent().getModel();
      // an abapGit function group: its module signatures go to ZSTG_FM_PARAM
      // (FunctionGroupSet), which Generate reads for the RFC-mapped operations
      if (content.includes('serializer="LCL_OBJECT_FUGR"')) {
        model.create("/FunctionGroupSet", {Name: name.slice(0, 30), Content: content}, {
          success: (data) => MessageToast.show(name + ": " + data.Modules + " modules, " + data.Rows + " parameters"),
          error: (e) => MessageBox.error(String(e && (e.responseText || e.message))),
        });
        model.submitChanges();
        return;
      }
      model.create("/ImportSet", {Content: content}, {
        success: (data) => {
          MessageToast.show(name + ": " + data.Rows + " rows in " + data.Tables + " tables of " + data.Project);
          const select = this.byId("project");
          const binding = select.getBinding("items");
          const pick = () => {
            binding.detachDataReceived(pick);
            select.setSelectedKey(data.Project);
            this.loadProject(data.Project);
          };
          binding.attachDataReceived(pick);
          binding.refresh(true);
        },
        error: (e) => MessageBox.error(String(e && (e.responseText || e.message))),
      });
      model.submitChanges();
    },

    // a new project: the rows stg-compile writes for an empty one (the
    // project node and its text, the model, the service, the six generated
    // artifacts), then it is selected with its empty folders
    onNewProject() {
      const model = this.getOwnerComponent().getModel();
      const name = new Input({placeholder: "e.g. ZSTG_TRIP", maxLength: 30});
      const description = new Input({placeholder: "Description"});
      const dialog = new Dialog({
        title: "New project",
        contentWidth: "24rem",
        content: [new Label({text: "Project", labelFor: name}), name, new Label({text: "Description", labelFor: description}), description],
        beginButton: new Button({
          text: "Create", type: "Emphasized",
          press: () => {
            const project = name.getValue().trim().toUpperCase();
            if (!/^(\/[A-Z0-9_]+\/)?[A-Z][A-Z0-9_]*$/.test(project)) {
              MessageBox.error("A project name: letters, digits, underscore, an optional /NS/ in front.");
              return;
            }
            dialog.close();
            const ns = /^\/([^/]+)\/(.*)$/.exec(project);
            const cls = (suffix) => (ns ? "/" + ns[1] + "/CL_" + ns[2] : "ZCL_" + project) + "_" + suffix;
            const service = project + "_SRV";
            const modelName = project + "_MDL";
            const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14) + ".000000";
            const ids = {project: uuid(), model: uuid(), service: uuid()};
            const text = (set, id, field, value) => [set, {Language: "E", Project: project, NodeUuid: id, ...(field ? {[field]: value} : {})}];
            let seq = 0;
            const rows = [
              ["ProjectSet", {Project: project, NodeUuid: ids.project, CreationUserId: "STEAMGATE", CreationTime: stamp, LastChgUserId: "STEAMGATE", LastChgTime: stamp, Plugin: "/IWBEP/GEN", StratName: "0001", StratVersion: "0001", ProjectType: "1"}],
              ["ProjectTextSet", {Project: project, Language: "E", Description: description.getValue().trim()}],
              ["ModelSet", {Project: project, NodeUuid: ids.model, NodeUuidPa: ids.project, PluginPa: "/IWBEP/CORE", NodeTypePa: "PROJ", TechnicalName: modelName, Version: "0001", Mpc: cls("MPC_EXT"), StateNs: "S", ValueNs: service}],
              text("ModelTextSet", ids.model, "Description", description.getValue().trim()),
              ["ServiceSet", {Project: project, NodeUuid: ids.service, TechnicalName: service, Version: "0001", Dpc: cls("DPC_EXT"), ExternalName: service}],
              text("ServiceTextSet", ids.service),
            ];
            for (const [kind, artifact, type] of [["MPCB", cls("MPC"), "CLAS"], ["MPCS", cls("MPC_EXT"), "CLAS"], ["DPCB", cls("DPC"), "CLAS"], ["DPCS", cls("DPC_EXT"), "CLAS"], ["MDL", modelName, "IWMO"], ["SRV", service, "IWSV"]]) {
              const id = uuid();
              rows.push(["ArtifactSet", {Project: project, NodeUuid: id, Name: artifact, Pgmid: "R3TR", TrobjType: type, TrobjName: artifact, GenArtType: kind}]);
              rows.push(text("ArtifactTextSet", id));
            }
            for (const [, data] of rows) {
              data.StgSeq = ++seq;
            }
            Promise.all(rows.map(([set, data]) => new Promise((resolve, reject) => model.create("/" + set, data, {success: resolve, error: reject}))))
              .then(() => {
                MessageToast.show("Project " + project + " created");
                const select = this.byId("project");
                const binding = select.getBinding("items");
                const pick = () => {
                  binding.detachDataReceived(pick);
                  select.setSelectedKey(project);
                  this.loadProject(project);
                };
                binding.attachDataReceived(pick);
                binding.refresh(true);
              })
              .catch((e) => MessageBox.error(String(e && (e.responseText || e.message))));
            model.submitChanges();
          },
        }),
        endButton: new Button({text: "Cancel", press: () => dialog.close()}),
        afterClose: () => dialog.destroy(),
      });
      dialog.open();
    },

    onProjectChange(event) {
      this.loadProject(event.getParameter("selectedItem").getKey());
    },

    // one $batch of GETs: every set the tree shows, this project's rows in
    // STG_SEQ order, then the tree is assembled here by parent UUID
    async loadProject(project) {
      this.project = project;
      this.select(null);
      const model = this.getOwnerComponent().getModel();
      const sets = new Set();
      const collect = (folders) => folders.forEach((f) => { if (f.set) { sets.add(f.set); } if (f.children) { collect(f.children); } });
      collect(TREE);
      const rows = {};
      await Promise.all([...sets].map((set) => this.read(model, set, project).then((r) => { rows[set] = r; })));
      const folder = (spec, parent, indexFolder) => {
        const list = (rows[spec.set] || []).filter((r) => !spec.by || r[spec.by] === parent.NodeUuid);
        const nodes = list.map((r) => ({
          text: label(r, spec.entity), icon: spec.icon, entity: spec.entity, set: spec.set, row: r,
          path: "/" + model.createKey(spec.set, {Project: r.Project, NodeUuid: r.NodeUuid}),
          nodes: (spec.children || []).map((c) => folder(c, r, true)).filter((n) => n.nodes.length > 0 || n.text !== ""),
        }));
        return indexFolder && spec.text === "" ? {text: "", nodes} : {text: spec.text, icon: spec.icon, nodes, folder: spec.set};
      };
      const build = (spec, parent) => {
        if (spec.set) {
          const f = folder(spec, parent, false);
          // a nameless level lists its rows directly under the parent
          return f;
        }
        return {text: spec.text, icon: spec.icon, nodes: spec.children.map((c) => build(c, parent))};
      };
      const projectRow = (await this.read(model, "ProjectSet", project))[0] || {Project: project};
      // the ids the adds hang new rows on: the model node, the service node
      this.rows = rows;
      this.modelUuid = ((await this.read(model, "ModelSet", project))[0] || {}).NodeUuid || "";
      this.serviceUuid = ((rows.ServiceSet || [])[0] || {}).NodeUuid || "";
      const root = {
        text: project, icon: "sap-icon://folder-blank", entity: "Project", set: "ProjectSet", row: projectRow,
        path: "/" + model.createKey("ProjectSet", {Project: projectRow.Project, NodeUuid: projectRow.NodeUuid}),
        nodes: TREE.map((spec) => build(spec, projectRow)),
      };
      // nameless folders (the service implementation levels) collapse into their parent
      const flatten = (n) => {
        n.nodes = (n.nodes || []).flatMap((c) => (c.text === "" && !c.path ? c.nodes.map(flatten) : [flatten(c)]));
        return n;
      };
      // a selection kept across the reload would swallow the next click on
      // the same node (no selectionChange), so none is kept
      this.byId("tree").removeSelections(true);
      this.getView().getModel("tree").setData({nodes: [flatten(root)]});
      this.byId("tree").expandToLevel(9);
    },

    read(model, set, project, sorted = true) {
      return new Promise((resolve, reject) => {
        model.read("/" + set, {
          filters: [new Filter("Project", FilterOperator.EQ, project)],
          sorters: sorted ? [new Sorter("StgSeq")] : [],
          success: (data) => resolve(data.results),
          error: reject,
        });
      });
    },

    onSelect(event) {
      const item = event.getParameter("listItem");
      const node = item && item.getBindingContext("tree").getObject();
      this.select(node || null);
    },

    // the detail: a form with one field per property of the node's entity
    // type (from $metadata), the keys read-only; below it the text row
    select(node) {
      const nodeModel = this.getView().getModel("node");
      const form = this.byId("form");
      const textForm = this.byId("textForm");
      form.removeAllContent();
      textForm.removeAllContent();
      textForm.setVisible(false);
      form.unbindElement();
      textForm.unbindElement();
      const adds = (keys) => keys.map((k) => ({key: k, label: ADDS[k].label}));
      const overview = this.byId("overview");
      overview.destroyItems();
      overview.setVisible(false);
      if (!node || !node.path) {
        // a folder: the overview of what is in it, the adds it offers
        nodeModel.setData(node && node.folder ? {folder: node.folder, title: node.text, adds: adds(FOLDER_ADDS[node.folder] || [])} : {});
        if (node && node.folder) {
          overview.addItem(this.overviewTable(node));
          overview.setVisible(true);
        }
        return;
      }
      nodeModel.setData({path: node.path, entity: node.entity, set: node.set, title: node.entity + ": " + node.text, row: node.row, adds: adds(ROW_ADDS[node.entity] || [])});
      const model = this.getOwnerComponent().getModel();
      this.fields(form, node.entity, [], node.entity);
      form.bindElement({path: node.path});
      const textSet = TEXTS[node.entity];
      if (textSet) {
        const keys = {Language: "E", Project: node.row.Project, NodeUuid: node.row.NodeUuid};
        if (node.entity === "Project") {
          delete keys.NodeUuid;
        }
        const textPath = "/" + model.createKey(textSet, keys);
        this.fields(textForm, textSet.replace(/Set$/, ""), ["Language", "Project", "NodeUuid", "StgSeq"], "Texts (EN)");
        textForm.bindElement({
          path: textPath,
          events: {
            dataReceived: (e) => textForm.setVisible(!!e.getParameter("data")),
          },
        });
        const existing = model.getProperty(textPath);
        textForm.setVisible(!!existing);
      }
    },

    fields(form, entityName, skip, title) {
      const model = this.getOwnerComponent().getModel();
      const schema = model.getServiceMetadata().dataServices.schema[0];
      const type = schema.entityType.find((t) => t.name === entityName);
      if (!type) {
        return;
      }
      const keys = type.key.propertyRef.map((k) => k.name);
      form.addContent(new Title({text: title}));
      for (const p of type.property) {
        if (skip.includes(p.name)) {
          continue;
        }
        const input = new Input({value: "{" + p.name + "}", editable: !keys.includes(p.name)});
        form.addContent(new Label({text: p.name, labelFor: input}));
        form.addContent(input);
      }
    },

    onSave() {
      const model = this.getOwnerComponent().getModel();
      if (!model.hasPendingChanges()) {
        MessageToast.show("Nothing to save");
        return;
      }
      model.submitChanges({
        success: (data) => {
          const failed = (data.__batchResponses || []).some((r) => r.response && Number(r.response.statusCode) >= 400);
          if (failed) {
            MessageBox.error("The service rejected a change; see the message log.");
          } else {
            MessageToast.show("Saved");
            const node = this.getView().getModel("node").getData();
            if (node.path) {
              // the tree text follows a renamed node
              this.loadProject(this.project);
            }
          }
        },
        error: (e) => MessageBox.error(String(e && e.message)),
      });
    },

    // the rows of a folder as a table with its commands: a row press selects
    // the node in the tree, Delete takes the selected rows (NodeSet)
    overviewTable(node) {
      const children = node.nodes.filter((n) => n.row);
      const columns = OVERVIEW[node.folder] || ["Name", "NodeUuid"];
      const names = new Map();
      for (const list of Object.values(this.rows || {})) {
        for (const r of list) {
          if (r.NodeUuid && (r.Name || r.TechnicalName)) {
            names.set(r.NodeUuid, r.Name || r.TechnicalName);
          }
        }
      }
      const cell = (r, c) => {
        const v = r[c] === undefined || r[c] === null ? "" : String(r[c]);
        return GUID_COLUMNS.has(c) && names.has(v) ? names.get(v) : v;
      };
      const table = new Table({
        mode: "MultiSelect",
        headerToolbar: new OverflowToolbar({
          content: [
            new MTitle({text: node.text + " (" + children.length + ")"}),
            new ToolbarSpacer(),
            new Button({
              text: "Delete", icon: "sap-icon://delete", type: "Transparent",
              press: () => {
                const selected = table.getSelectedItems().map((i) => children[table.indexOfItem(i)]);
                if (selected.length === 0) {
                  MessageToast.show("Select rows first");
                  return;
                }
                MessageBox.confirm("Delete " + selected.map((n) => n.text).join(", ") + " with everything below?", {
                  onClose: (action) => {
                    if (action !== MessageBox.Action.OK) {
                      return;
                    }
                    const model = this.getOwnerComponent().getModel();
                    Promise.all(selected.map((n) => new Promise((resolve, reject) => model.remove("/" + model.createKey("NodeSet", {Project: n.row.Project, NodeUuid: n.row.NodeUuid}), {success: resolve, error: reject}))))
                      .then(() => { MessageToast.show("Deleted"); this.loadProject(this.project); })
                      .catch((e) => { MessageBox.error(String(e && (e.responseText || e.message))); this.loadProject(this.project); });
                    model.submitChanges();
                  },
                });
              },
            }),
          ],
        }),
        columns: columns.map((c, i) => new Column({header: new Text({text: c}), minScreenWidth: i > 2 ? "Tablet" : undefined, demandPopin: i > 2})),
        items: children.map((n) => new ColumnListItem({type: "Navigation", cells: columns.map((c) => new Text({text: cell(n.row, c)}))})),
      });
      // the row and its node by position (custom data does not survive the
      // control); itemPress, not the item's own press, because the list
      // handles the click itself in a selection mode; deferred, because
      // select( ) destroys this table
      const nodeOf = (item) => children[table.indexOfItem(item)];
      table.attachItemPress((event) => {
        const node = nodeOf(event.getParameter("listItem"));
        setTimeout(() => this.selectInTree(node), 0);
      });
      return table;
    },

    selectInTree(node) {
      const tree = this.byId("tree");
      const item = tree.getItems().find((i) => i.getBindingContext("tree") && i.getBindingContext("tree").getObject() === node);
      if (item) {
        tree.setSelectedItem(item, true);
      }
      this.select(node);
    },

    onAdd(event) {
      const which = event.getSource().data("add");
      const spec = ADDS[which];
      const node = this.getView().getModel("node").getData();
      const model = this.getOwnerComponent().getModel();
      let seq = this.maxSeq();
      const c = {project: this.project, model: this.modelUuid, service: this.serviceUuid, rows: this.rows, row: node.row, id: uuid, seq: () => ++seq};
      const controls = {};
      const content = [];
      for (const f of spec.fields) {
        const control = f.options
          ? new Select({items: f.options(c).map((o) => new Item({key: o.key, text: o.text})), width: "100%"})
          : new Input({placeholder: f.placeholder || ""});
        controls[f.key] = control;
        content.push(new Label({text: f.label, labelFor: control}), control);
      }
      const dialog = new Dialog({
        title: spec.label + (node.row ? " to " + (node.row.Name || node.title) : ""),
        contentWidth: "24rem",
        content,
        beginButton: new Button({
          text: "Add", type: "Emphasized",
          press: () => {
            const v = {};
            for (const f of spec.fields) {
              v[f.key] = f.options ? controls[f.key].getSelectedKey() : controls[f.key].getValue().trim();
            }
            if (!v.Name) {
              return;
            }
            dialog.close();
            const rows = spec.rows(v, c);
            Promise.all(rows.map(([set, data]) => new Promise((resolve, reject) => model.create("/" + set, data, {success: resolve, error: reject}))))
              .then(() => { MessageToast.show(spec.label.replace(/^Add /, "") + " " + v.Name + " added"); this.loadProject(this.project); })
              .catch((e) => { MessageBox.error(String(e && (e.responseText || e.message))); this.loadProject(this.project); });
            model.submitChanges();
          },
        }),
        endButton: new Button({text: "Cancel", press: () => dialog.close()}),
        afterClose: () => dialog.destroy(),
      });
      dialog.open();
    },

    // STG_SEQ orders the rows of a table the way SEGW wrote them; a new row
    // goes after the last one of the project
    maxSeq() {
      let max = 0;
      const walk = (n) => { if (n.row && n.row.StgSeq > max) { max = Number(n.row.StgSeq); } (n.nodes || []).forEach(walk); };
      this.getView().getModel("tree").getData().nodes.forEach(walk);
      return max;
    },

    // DELETE NodeSet(P, uuid): the node with its subtree, as SEGW deletes
    // (zcl_stg_segw_tree follows the parent columns of every table). An
    // entity type that still has entity sets is refused here: the service
    // treats ENTITY_TYPE as a reference and would leave the sets dangling.
    async onDelete() {
      const node = this.getView().getModel("node").getData();
      const model = this.getOwnerComponent().getModel();
      if (node.entity === "EntityType") {
        const sets = (await this.read(model, "EntitySetSet", node.row.Project)).filter((r) => r.EntityType === node.row.NodeUuid);
        if (sets.length > 0) {
          MessageBox.error("Entity type " + node.row.Name + " is used by " + sets.map((r) => r.Name).join(", ") + ". Delete the entity set first.");
          return;
        }
      }
      MessageBox.confirm("Delete " + node.entity + " " + node.title.replace(/^.*: /, "") + " with everything below it?", {
        onClose: (action) => {
          if (action !== MessageBox.Action.OK) {
            return;
          }
          model.remove("/" + model.createKey("NodeSet", {Project: node.row.Project, NodeUuid: node.row.NodeUuid}), {
            success: () => { MessageToast.show("Deleted"); this.loadProject(this.project); },
            error: (e) => MessageBox.error(String(e && (e.responseText || e.message))),
          });
          model.submitChanges();
        },
      });
    },

    // Generate is the service's: GET GenerateSet?$filter=Project eq 'P'
    // gives the classes as files (segw-gen in ABAP: zcl_stg_segw_gen); the
    // dialog lists them and shows a source. Nothing writes them to disk from
    // here: the project reaches a system as an abapGit repository
    // (RepoSet), and on a system this button is SEGW's own Generate.
    async onGenerate() {
      const model = this.getOwnerComponent().getModel();
      const project = this.project;
      let files;
      try {
        files = await this.read(model, "GenerateSet", project, false);
      } catch (e) {
        MessageBox.error(String(e && (e.responseText || e.message)));
        return;
      }
      const list = new List({
        items: files.map((f) => new StandardListItem({
          title: f.Name, description: f.Content.length + " characters", type: "Active", icon: "sap-icon://syntax",
          press: () => this.showSource(f.Name, f.Content),
        })),
      });
      const dialog = new Dialog({
        title: "Generated " + project + ": " + files.length + " files",
        contentWidth: "40rem",
        content: [list],
        endButton: new Button({text: "Close", press: () => dialog.close()}),
        afterClose: () => dialog.destroy(),
      });
      dialog.open();
    },

    showSource(name, content) {
      const dialog = new Dialog({
        title: name,
        contentWidth: "60rem",
        contentHeight: "70%",
        content: [new TextArea({value: content, editable: false, width: "100%", height: "100%", wrapping: "Off"})],
        endButton: new Button({text: "Close", press: () => dialog.close()}),
        afterClose: () => dialog.destroy(),
      });
      dialog.open();
    },

    // the project as an abapGit file: GET ExportSet('P'), Content is the
    // IWPR written in ABAP (zcl_stg_segw_export), handed over as a download
    onExport() {
      const model = this.getOwnerComponent().getModel();
      const project = this.project;
      model.read("/" + model.createKey("ExportSet", {Project: project}), {
        success: (data) => {
          const link = document.createElement("a");
          link.href = URL.createObjectURL(new Blob([data.Content], {type: "application/xml"}));
          link.download = project.toLowerCase() + ".iwpr.xml";
          document.body.appendChild(link);
          link.click();
          link.remove();
          URL.revokeObjectURL(link.href);
        },
        error: (e) => MessageBox.error(String(e && (e.responseText || e.message))),
      });
    },
  });
});
