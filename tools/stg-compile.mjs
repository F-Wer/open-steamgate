// stg-compile: one YAML file for a Gateway service -> the SEGW objects.
//
//   npm run stg:compile -- src/demo/zstg_demo.stg.yaml [--out <dir>] [--lib <fugr folder>]
//
// SEGW is an editor for a project tree plus a generator. The tree is the
// IWPR object; the generator is tools/segw-gen.mjs. This is the editor
// without the GUI: `<name>.stg.yaml` describes the service (entities,
// properties, sets, associations, navigation, function imports, where each
// entity's data comes from) and stg-compile writes the tree as abapGit
// serializes it (`<project>.iwpr.xml`), the registration objects
// (`<service> 0001.iwsv.xml`, `<model> 0001.iwmo.xml`) and, through
// segw-gen, the `_MPC`/`_DPC` classes plus the empty `_EXT` pair. Deploy the
// folder with abapGit and SEGW on the system opens a normal project.
//
// Node identifiers are deterministic (a hash of project + kind + name), so
// compiling the same file twice gives the same tree, byte for byte.
//
// Format (see docs/stg-compile.md; every key but `project`, `service` and
// `entities` is optional):
//
//   project: ZSTG_DEMO                 # SEGW project; classes ZCL_<project>_MPC/_DPC(+_EXT)
//   service: ZSTG_DEMO_SRV             # technical = external name, version 0001
//   model: ZSTG_DEMO_MDL               # default <project>_MDL
//   description: ...
//   entities:
//     Travel:
//       set: TravelSet                 # default <name>Set
//       source: {struct: ZSTG_DEMO}    # ABAP structure behind the type (bind_structure)
//               {table: ZSTG_DEMO_BK}  # DDIC table served by SADL, the DPC delegates
//               {cds: ZSTG_I_STATUS}   # CDS view served by SADL
//               {service: ZSTG_SADL_SRV, set: Zc_Stg_TravelSet}   # another service of this registry (local ODC)
//               (none)                 # the DPC declares the structure from the properties
//       keys: [TravelId]
//       properties:
//         TravelId: String(8)          # shorthand: <Edm type>(<length>) or <type>(<digits>,<scale>)
//         Seats: {type: Int32, field: SEATS, nullable: true, label: Seats}
//         StatusText: {type: String(40), readonly: true, sortable: false, filterable: false}
//       creatable: true ... (set flags: creatable updatable deletable pageable addressable searchable subscribable filterRequired)
//       operations: [C, R, U, D, Q]    # the DPC methods SEGW writes; default all five
//   associations:
//     TravelToBookings:
//       from: Travel
//       to: Booking
//       cardinality: 1:N               # 1:1, 1:N, N:1, N:N (0..1 as 0)
//       constraint: {TravelId: TravelId}   # principal (from) -> dependent (to)
//       navigation: {Travel: to_Bookings, Booking: to_Travel}
//   functions:
//     CancelTravel:
//       method: POST
//       returns: {entity: Travel, set: TravelSet, multiplicity: "1"}   # or {complex: CT_X}
//       for: Travel
//       parameters: {TravelId: String(8)}
import {existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync} from "node:fs";
import {generatorFoldersOf, winningByLayer} from "./osd-packs.mjs";
import {createHash} from "node:crypto";
import {basename, dirname, join} from "node:path";
import yaml from "js-yaml";
import {generate} from "./segw-gen.mjs";
import {AnnotationWriter} from "./stg-compile-annotations.mjs";
import {loadFunctionGroups} from "./segw-gen-mapping.mjs";
import SPEC from "./segw-tables.json" with {type: "json"};

// ------------------------------------------------------------- the model

// `date` and `datetime` are the same Edm type and not the same ABAP type,
// which is the whole reason `date` exists. OData V2 has one temporal type,
// so a model that only names Edm types cannot say which of the two a field
// is, and the generated structure component came out TIMESTAMP for a column
// that is DATS -- A4H refused to activate the DPC over it (2026-09-19,
// "the data type of the component FLIGHT_DATE ... is not compatible").
// SEGW says it in the tree instead: TYPE_KIND D, LENGTH 8 and a TYPE_NAME,
// which is what three date properties in SAP's own sample projects carry
// (EPM-RFC-SAMPLE, EPM-SADL-TX-SAMPLE).
const EDM = {
  string: "Edm.String", int32: "Edm.Int32", int16: "Edm.Int16", int64: "Edm.Int64", boolean: "Edm.Boolean", datetime: "Edm.DateTime",
  date: "Edm.DateTime",
  decimal: "Edm.Decimal", guid: "Edm.Guid", time: "Edm.Time", byte: "Edm.Byte", double: "Edm.Double", binary: "Edm.Binary", datetimeoffset: "Edm.DateTimeOffset",
};

function edmType(name) {
  const key = String(name).replace(/^Edm\./, "").toLowerCase();
  if (!EDM[key]) {
    throw new Error(`unknown type ${name}`);
  }
  return EDM[key];
}

// "String(8)", "Decimal(15,2)", "Int32" -> {type, length, digits, scale}
function parseTypeText(text) {
  const m = /^\s*([A-Za-z][A-Za-z0-9.]*)\s*(?:\(\s*(\d+)\s*(?:,\s*(\d+)\s*)?\))?\s*$/.exec(String(text));
  if (m === null) {
    throw new Error(`cannot read the type ${JSON.stringify(text)}`);
  }
  const spelling = String(m[1]).replace(/^Edm\./, "").toLowerCase();
  const type = edmType(m[1]);
  if (spelling === "date") {
    // The ABAP side of a date, in SEGW's own shape. SYDATE and not SYDATUM:
    // the corpus shows SYDATUM, both are DATS(8) and only SYDATE is in
    // open-abap-core and in the S/4 2022 data-element dump, so this one
    // generates code that compiles here as well as on a system. A property
    // may still name its own data element with `typeName:`.
    return {type, typeName: "SYDATE", typeKind: "D", abapLength: "8"};
  }
  if (type === "Edm.Decimal" || type === "Edm.DateTime") {
    return {type, digits: m[2] ?? "", scale: m[3] ?? ""};
  }
  return {type, length: m[2] ?? ""};
}

function property(name, spec, isKey, complexTypes = []) {
  const s = typeof spec === "string" || spec === null || spec === undefined ? {type: spec ?? "String"} : {...spec};
  // type: <name of a complex type> is a complex property: a structure
  // component, no Edm type, no facets, no flags (SEGW clears them all)
  if (complexTypes.includes(String(s.type ?? ""))) {
    if (isKey) {
      throw new Error(`${name}: a complex property cannot be a key`);
    }
    return {name, field: s.field ?? name.toUpperCase(), isKey: false, complexType: String(s.type), type: "", length: "", digits: "", scale: "",
      typeName: "", typeKind: "", abapLength: "",
      creatable: false, updatable: false, sortable: false, nullable: false, filterable: false, label: "", semantics: "", unicode: true};
  }
  const t = parseTypeText(s.type ?? "String");
  const readonly = s.readonly === true;
  const flag = (key, fallback) => (s[key] === undefined ? fallback : s[key] === true);
  return {
    name,
    field: s.field ?? name.toUpperCase(),
    isKey,
    type: t.type,
    length: s.length !== undefined ? String(s.length) : t.length ?? "",
    digits: s.digits !== undefined ? String(s.digits) : t.digits ?? "",
    scale: s.scale !== undefined ? String(s.scale) : t.scale ?? "",
    typeName: s.typeName ?? t.typeName ?? "",
    typeKind: t.typeKind ?? "",
    abapLength: t.abapLength ?? "",
    creatable: flag("creatable", !readonly),
    updatable: flag("updatable", !readonly && !isKey),
    sortable: flag("sortable", true),
    nullable: flag("nullable", !isKey),
    filterable: flag("filterable", true),
    label: s.label ?? "",
    semantics: s.semantics ?? "",
    unicode: s.unicode !== false,
  };
}

function cardinality(text) {
  const m = /^\s*([01N*])\s*:\s*([01N*])\s*$/i.exec(String(text ?? "1:N"));
  if (m === null) {
    throw new Error(`cardinality ${JSON.stringify(text)}: use 1:N, 1:1, N:1, 0:N`);
  }
  const card = (c) => (c === "*" ? "N" : c.toUpperCase());
  return {left: card(m[1]), right: card(m[2])};
}

const OP_CODE = {create: "C", read: "R", update: "U", delete: "D", query: "Q", c: "C", r: "R", u: "U", d: "D", q: "Q"};
const RANGE_COMPONENTS = {H: "HIGH", L: "LOW", O: "OPTION", S: "SIGN"};

// `operations` is either the list of what the DPC gets ([C, R, U, D, Q]) or a
// map operation -> data-source mapping (SEGW's "Map to Data Source"):
//   query:
//     function: EPM-RFC-MODULE       # RFC/BOR module...
//     group: EPM-FG          #   its function group (optional)
//     destination: NONE                     #   RFC destination (optional)
//     log: ET_RETURN                        #   the BAPIRET2 table (optional)
//     in: {ProductId: IV_PRODUCT_ID}        # property -> parameter path, request side
//     ranges: {Name: IT_NAME_RANGE}         # property -> range table (HIGH/LOW/OPTION/SIGN)
//     constants: {"IT_CONTROL\\VALUE": "'X'"}  # parameter path -> literal
//     out: {ProductId: "ET_LIST\\PRODUCT_ID"}  # property <- parameter path, response side
//   read:
//     searchhelp: ZSTG_STATUS_SH            # ...or a search help
//     in: {Status: STATUS}                  # property -> search help field
//     out: {Status: "RESULT_LIST\\STATUS"}
function operationsOf(spec, entity, props, file) {
  if (spec === undefined || Array.isArray(spec)) {
    return (spec ?? ["C", "R", "U", "D", "Q"]).map((o) => ({type: String(o).toUpperCase()}));
  }
  const propertyOf = (name) => {
    const p = props.find((x) => x.name === name);
    if (!p) {
      throw new Error(`${file}: ${entity}: mapping names property ${name}, which is not there`);
    }
    return p;
  };
  const pairs = (m, direction) => Object.entries(m ?? {}).map(([property, path]) => ({property: propertyOf(property).name, direction, path: String(path)}));
  return Object.entries(spec).map(([key, m]) => {
    const type = OP_CODE[String(key).toLowerCase()];
    if (!type) {
      throw new Error(`${file}: ${entity}: operation ${key}: use create, read, update, delete or query`);
    }
    const op = {type};
    if (m === null || m === undefined || m === true) {
      return op;
    }
    if (m.function && m.searchhelp) {
      throw new Error(`${file}: ${entity}.${key}: function or searchhelp, not both`);
    }
    if (m.function) {
      op.mapping = {
        kind: "RFC", function: String(m.function).toUpperCase(), group: m.group ? String(m.group).toUpperCase() : "",
        destination: m.destination ? String(m.destination).toUpperCase() : "", log: m.log ? String(m.log).toUpperCase() : "",
      };
    } else if (m.searchhelp) {
      op.mapping = {kind: "SHLP", searchhelp: String(m.searchhelp).toUpperCase(), maxHits: m.maxhits ? String(m.maxhits).toUpperCase() : "MAX_HITS"};
    } else {
      throw new Error(`${file}: ${entity}.${key}: a mapping needs function: or searchhelp:`);
    }
    op.mapping.in = pairs(m.in, "I");
    op.mapping.ranges = Object.entries(m.ranges ?? {}).map(([property, r]) => {
      const table = typeof r === "string" ? r : r.table;
      const components = Object.entries(RANGE_COMPONENTS).map(([sem, name]) => ({semantics: sem, component: typeof r === "string" ? name : String(r[name.toLowerCase()] ?? name).toUpperCase()}));
      return {property: propertyOf(property).name, table: String(table).toUpperCase(), components};
    });
    op.mapping.constants = Object.entries(m.constants ?? {}).map(([path, value]) => ({path: String(path), value: String(value)}));
    op.mapping.out = pairs(m.out, "O");
    return op;
  });
}

// the YAML, checked and defaulted
export function readModel(text, file = "stg.yaml") {
  const y = yaml.load(text) ?? {};
  // things the model may legally say that a system will not accept; collected
  // rather than thrown, and carried out on the model so compile() can report
  // them beside everything else
  const modelWarnings = [];
  for (const key of ["project", "service", "entities"]) {
    if (!y[key]) {
      throw new Error(`${file}: "${key}" is required`);
    }
  }
  const project = String(y.project).toUpperCase();
  const service = String(y.service).toUpperCase();
  const model = String(y.model ?? `${project}_MDL`).toUpperCase();
  const stem = project.replace(/^\/([^/]+)\//, "/$1/").toUpperCase();
  const cls = (suffix) => {
    // /NS/CL_<project>_MPC keeps the namespace in front
    const ns = /^\/([^/]+)\/(.*)$/.exec(stem);
    const base = ns ? `/${ns[1]}/CL_${ns[2]}` : `ZCL_${stem}`;
    return (y.classes?.[suffix.toLowerCase()] ?? `${base}_${suffix}`).toUpperCase();
  };
  // complex types: a named group of properties, used as the type of a
  // property or as what a function import returns
  const complexTypes = Object.entries(y.complexTypes ?? {}).map(([name, c]) => {
    const spec = c ?? {};
    const source = spec.source ?? {};
    if (Object.keys(source).some((k) => k !== "struct")) {
      throw new Error(`${file}: complex type ${name}: only source.struct`);
    }
    return {
      name, description: spec.description ?? "",
      abapStruct: source.struct ? String(source.struct).toUpperCase() : "",
      properties: Object.entries(spec.properties ?? {}).map(([p, ps], i) => ({...property(p, ps, false), order: i + 1})),
    };
  });
  const complexNames = complexTypes.map((c) => c.name);
  const entities = Object.entries(y.entities).map(([name, e]) => {
    const spec = e ?? {};
    const keys = (spec.keys ?? []).map(String);
    const props = Object.entries(spec.properties ?? {}).map(([p, ps], i) => ({...property(p, ps, keys.includes(p), complexNames), order: i + 1}));
    for (const k of keys) {
      if (!props.some((p) => p.name === k)) {
        throw new Error(`${file}: ${name}: key ${k} is not a property`);
      }
    }
    const source = spec.source ?? {};
    // one source, plus an optional struct: the ABAP structure the model binds
    // to when it is not the source's own name (a published CDS view binds to
    // the row type of its generated source class, virtual elements included)
    if (Object.keys(source).filter((k) => k !== "set" && k !== "struct").length > 1) {
      throw new Error(`${file}: ${name}: one source only`);
    }
    const flag = (key, fallback) => (spec[key] === undefined ? fallback : spec[key] === true);
    if (source.service && !source.set) {
      throw new Error(`${file}: ${name}: source.service needs source.set (the entity set of that service)`);
    }
    const sadl = source.table ? {kind: "DDIC", binding: String(source.table).toUpperCase()}
      : source.cds ? {kind: "CDS", binding: String(source.cds)}
      : source.service ? {kind: "ODC", binding: `${String(source.service).toUpperCase()}~${source.set}`}
      : undefined;
    return {
      name, set: spec.set ?? `${name}Set`, keys, properties: props, description: spec.description ?? "",
      abapStruct: source.struct ? String(source.struct).toUpperCase() : sadl && sadl.kind !== "ODC" ? sadl.binding.toUpperCase() : "",
      sadl,
      // a media entity: the content is a stream, read and written at
      // <entity>/$value through the DPC's GET_STREAM / UPDATE_STREAM
      media: flag("media", false),
      creatable: flag("creatable", true), updatable: flag("updatable", true), deletable: flag("deletable", true),
      pageable: flag("pageable", true), addressable: flag("addressable", true), searchable: flag("searchable", false),
      subscribable: flag("subscribable", false), filterRequired: flag("filterRequired", false),
      operations: operationsOf(spec.operations, name, props, file),
    };
  });
  const entity = (n) => {
    const found = entities.find((e) => e.name === n);
    if (!found) {
      throw new Error(`${file}: entity ${n} is not defined`);
    }
    return found;
  };
  const associations = Object.entries(y.associations ?? {}).map(([name, a]) => {
    const spec = a ?? {};
    const from = entity(spec.from);
    const to = entity(spec.to);
    const card = cardinality(spec.cardinality);
    const constraint = Object.entries(spec.constraint ?? {}).map(([principal, dependent]) => ({principal, dependent: String(dependent)}));
    const navigation = Object.entries(spec.navigation ?? {}).map(([owner, nav]) => ({entity: entity(owner), name: String(nav)}));
    return {name, from, to, card, constraint, navigation, set: spec.set ?? `${name}Set`};
  });
  const functions = Object.entries(y.functions ?? {}).map(([name, f]) => {
    const spec = f ?? {};
    const returns = spec.returns ?? {};
    if (returns.complexType && !complexNames.includes(String(returns.complexType))) {
      throw new Error(`${file}: function ${name}: complex type ${returns.complexType} is not defined`);
    }
    if (returns.complexType && returns.entity) {
      throw new Error(`${file}: function ${name}: returns either an entity or a complex type`);
    }
    // **A function import must declare a return.** SEGW refuses to generate
    // runtime objects without one -- "No return is currently not supported by
    // the runtime" -- and the tree we wrote without it looked fine here,
    // because our own dispatcher does not mind (measured on A4H 2026-09-19).
    //
    // Refused rather than guessed. Defaulting to the entity of `set:` would
    // put a return type in the model that the author did not write, and a
    // model that quietly says more than its source is the thing this file
    // exists to avoid.
    if (!returns.complexType && !returns.entity && !returns.primitive) {
      throw new Error(`${file}: function ${name}: no return. A function import must declare one: ` +
        `returns: {entity: <Entity>}, {complexType: <CT>} or {primitive: <Edm type>}. SEGW will ` +
        `not generate runtime objects for a function import without a return.`);
    }
    // **A primitive return is ours and not SEGW's.** Our dispatcher answers
    // `{"d":{"TravelCount":3}}` for one, which is the correct OData V2 shape,
    // and classic SEGW's model has no return kind for it: on A4H the project
    // would not generate until the function import was given an entity or a
    // complex type by hand. So the YAML may say it -- the model should
    // describe what we actually serve -- and the compiler says out loud what
    // a system will do with it, rather than the author finding out from a
    // browser (measured 2026-09-19).
    if (returns.primitive) {
      modelWarnings.push(`function ${name}: returns the primitive ${returns.primitive}, which this ` +
        `runtime serves and classic SEGW's editor has no return kind for. The tree carries no ` +
        `return kind, and the function import reaches $metadata without a ReturnType.`);
    }
    return {
      name,
      label: spec.label === undefined ? "" : String(spec.label),
      method: (spec.method ?? "POST").toUpperCase(),
      returnEntity: returns.entity ? entity(returns.entity) : undefined,
      returnComplex: returns.complexType ? String(returns.complexType) : "",
      returnSet: returns.set ?? (returns.entity ? entity(returns.entity).set : ""),
      multiplicity: String(returns.multiplicity ?? (returns.entity || returns.complexType ? "1" : "")),
      actionFor: spec.for ? entity(spec.for) : undefined,
      parameters: Object.entries(spec.parameters ?? {}).map(([p, ps]) => property(p, ps, false)),
    };
  });
  const annotations = Object.entries(y.annotations ?? {}).map(([target, a]) => {
    const [entityName, propertyName] = String(target).split("/");
    const e = entity(entityName);
    if (propertyName && !e.properties.some((p) => p.name === propertyName)) {
      throw new Error(`${file}: annotations: ${target}: ${entityName} has no property ${propertyName}`);
    }
    return {target, entity: e, property: propertyName ?? "", spec: a ?? {}};
  });
  return {
    project, service, model, description: y.description ?? "", namespace: y.namespace ?? service,
    classes: {mpc: cls("MPC"), mpcExt: cls("MPC_EXT"), dpc: cls("DPC"), dpcExt: cls("DPC_EXT"), mpcAnn: cls("MPC_ANN")},
    entities, associations, functions, annotations, complexTypes,
    warnings: modelWarnings,
  };
}

// ------------------------------------------------- vocabulary annotations

// the writer and its grammar: tools/stg-compile-annotations.mjs

export function annotationsClass(m) {
  if (m.annotations.length === 0) {
    return {};
  }
  const cls = m.classes.mpcAnn;
  const w = new AnnotationWriter();
  for (const a of m.annotations) {
    w.target(`${m.namespace}.${a.target}`);
    if (a.property) {
      w.property(a);
    } else {
      w.entity(a);
    }
  }
  // FINAL, and the two empty sections, because a real system refuses this
  // class without them: "For technical reasons, the statement PROTECTED
  // SECTION or PRIVATE SECTION must exist in non-final global classes."
  // abaplint accepts it either way, so the defect was invisible here and
  // showed on the first deploy to A4H (2026-09-19). FINAL is also the truth
  // -- nothing subclasses this one, unlike the _MPC that SEGW generates.
  const abap = `CLASS ${cls} DEFINITION PUBLIC FINAL CREATE PUBLIC.
* generated by tools/stg-compile.mjs from the annotations of ${m.project} - do not edit
* The vocabulary annotations of the service, written through the model's
* vocab_anno_model the way a SEGW-generated _MPC_EXT writes them; called
* from ${m.classes.mpcExt}->define( ) after super->define( ).
  PUBLIC SECTION.
    CLASS-METHODS define
      IMPORTING
        io_vocab TYPE REF TO /iwbep/if_mgw_vocan_model.
  PROTECTED SECTION.
  PRIVATE SECTION.
ENDCLASS.

CLASS ${cls} IMPLEMENTATION.

  METHOD define.
    DATA lo_target     TYPE REF TO /iwbep/if_mgw_vocan_ann_target.
    DATA lo_annotation TYPE REF TO /iwbep/if_mgw_vocan_annotation.
    DATA lo_nested     TYPE REF TO /iwbep/if_mgw_vocan_annotation.
    DATA lo_record     TYPE REF TO /iwbep/if_mgw_vocan_record.
    DATA lo_item       TYPE REF TO /iwbep/if_mgw_vocan_record.
    DATA lo_collection TYPE REF TO /iwbep/if_mgw_vocan_collection.
${w.lines.join("\n")}
  ENDMETHOD.

ENDCLASS.
`;
  return {[objectFile(cls, ".clas.abap")]: abap, [objectFile(cls, ".clas.xml")]: clasXml(cls, `Vocabulary annotations of ${m.service}`)};
}

// the _MPC_EXT of a service with annotations calls the annotation class
function mpcExtWithAnnotations(m) {
  const ext = m.classes.mpcExt;
  return `class ${ext} definition
  public
  inheriting from ${m.classes.mpc}
  create public .

public section.

  methods DEFINE
    redefinition .
protected section.
private section.
ENDCLASS.



CLASS ${ext} IMPLEMENTATION.


  METHOD define.
    super->define( ).
    ${m.classes.mpcAnn}=>define( vocab_anno_model ).
  ENDMETHOD.
ENDCLASS.
`;
}

function clasXml(name, description) {
  return `\ufeff<?xml version="1.0" encoding="utf-8"?>
<abapGit version="v1.0.0" serializer="LCL_OBJECT_CLAS" serializer_version="v1.0.0">
 <asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0">
  <asx:values>
   <VSEOCLASS>
    <CLSNAME>${name}</CLSNAME>
    <LANGU>E</LANGU>
    <DESCRIPT>${description}</DESCRIPT>
    <STATE>1</STATE>
    <CLSCCINCL>X</CLSCCINCL>
    <FIXPT>X</FIXPT>
    <UNICODE>X</UNICODE>
   </VSEOCLASS>
  </asx:values>
 </asx:abap>
</abapGit>
`;
}

// ----------------------------------------------------------------- IWPR

/** A stable node id in the shape SEGW uses: base64 of a 16-byte GUID.
 *
 *  **It is the bytes that are cut to 16, not the text to 22.** This used to
 *  take the first 22 characters of a base64 digest and staple "==" on, which
 *  produces a string of the right length and the wrong content: base64 only
 *  ends in "==" when the last significant character has its low four bits
 *  clear, and a sliced digest does not care. 55 of our 59 node ids decoded
 *  with non-zero padding bits; all 60 in a real export were canonical.
 *  abapGit answered "Error during deserialization" and named no field, which
 *  is what a decoder does when it refuses input it cannot describe.
 *
 *  Sixteen bytes of a sha1 digest encode to exactly 24 characters ending in
 *  "==", by construction -- so the shape is a consequence rather than
 *  something arranged afterwards. */
function nodeId(...parts) {
  return createHash("sha1").update(parts.join("")).digest().subarray(0, 16).toString("base64");
}

const X = (b) => (b ? "X" : "");
const esc = (s) => String(s).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("'", "&apos;").replaceAll("\"", "&quot;");

// one abapGit table block: <TAG><TAG>row</TAG>...</TAG>; rows are ordered
// by the fields given, empty values are left out as abapGit does
// the fields of every table in the order SEGW writes them (derived from the
// real projects by tools/segw-tables.mjs); a field the spec does not know
// is a mistake here, not something to write
let spec;
function fieldsOf(tag) {
  // Toolchain schema is bundled even when no source checkout is present.
  spec ??= SPEC;
  if (!spec[tag]) {
    throw new Error(`${tag}: not a table of the SEGW project tree`);
  }
  return Object.keys(spec[tag].fields);
}

function table(tag, rows) {
  if (rows.length === 0) {
    return "";
  }
  const fields = fieldsOf(tag);
  let s = `   <_-IWBEP_-I_${tag}>\n`;
  for (const row of rows) {
    for (const k of Object.keys(row)) {
      if (!fields.includes(k)) {
        throw new Error(`${tag}.${k}: not a field SEGW writes`);
      }
    }
    s += `    <_-IWBEP_-I_${tag}>\n`;
    for (const k of fields) {
      const v = row[k];
      if (v !== "" && v !== undefined && v !== false) {
        s += `     <${k}>${esc(v)}</${k}>\n`;
      }
    }
    s += `    </_-IWBEP_-I_${tag}>\n`;
  }
  return s + `   </_-IWBEP_-I_${tag}>\n`;
}

const OPERATIONS = {C: "Create", R: "GetEntity (Read)", U: "Update", D: "Delete", Q: "GetEntitySet (Query)"};
const OP_SUFFIX = {C: "CREATE_ENTITY", R: "GET_ENTITY", U: "UPDATE_ENTITY", D: "DELETE_ENTITY", Q: "GET_ENTITYSET"};

export function iwprXml(m, opts = {}) {
  const P = m.project;
  const id = (...parts) => nodeId(P, ...parts);
  const projectId = id("PROJ");
  const modelId = id("MODL");
  const serviceId = id("SRVC");
  const dataSourcesId = id("DSRC");
  const rows = {
    SBD_AT: [], SBD_DS: [], SBD_DST: [], SBD_GA: [], SBD_GAT: [], SBD_MD: [], SBD_MDT: [], SBD_MH: [], SBD_MP: [], SBD_MR: [], SBD_OP: [], SBD_OPT: [], SBD_PR: [], SBD_PRT: [],
    SBD_SE: [], SBD_SET: [], SBD_SV: [], SBD_SVT: [], SBO_ASO: [], SBO_AST: [], SBO_AT: [], SBO_ATT: [], SBO_ES: [], SBO_EST: [], SBO_ET: [], SBO_ETT: [],
    SBO_FI: [], SBO_FIT: [], SBO_FP: [], SBO_FPT: [], SBO_NP: [], SBO_NPT: [], SBO_PR: [], SBO_PRT: [], SBO_RC: [], SBO_RCT: [], SBO_CT: [], SBO_CTT: [],
  };
  const stamp = opts.timestamp ?? "20260912000000.000000";
  // the text tables: SEGW keeps a label in some (ET_LABEL, ESET_LABEL,
  // PROP_LABEL...), a description in SBD_DST/MDT/PRT, and nothing but the
  // key in the rest (SBD_GAT, SBD_OPT, SBD_SET, SBD_SVT, SBO_RCT)
  const text = (uuid, field, value) => (field ? {SYLANGU: "E", PROJECT: P, NODE_UUID: uuid, [field]: value} : {SYLANGU: "E", PROJECT: P, NODE_UUID: uuid});

  rows.SBD_PR.push({PROJECT: P, NODE_UUID: projectId, CREATION_USER_ID: "STEAMGATE", CREATION_TIME: stamp, LAST_CHG_USER_ID: "STEAMGATE", LAST_CHG_TIME: stamp, PLUGIN: "/IWBEP/GEN", STRAT_NAME: "0001", STRAT_VERSION: "0001", PROJECT_TYPE: "1"});
  rows.SBD_PRT.push({PROJECT: P, SYLANGU: "E", DESCRIPTION: m.description});
  rows.SBD_MD.push({PROJECT: P, NODE_UUID: modelId, NODE_UUID_PA: projectId, PLUGIN_PA: "/IWBEP/CORE", NODE_TYPE_PA: "PROJ", TECHNICAL_NAME: m.model, VERSION: "0001", MPC: m.classes.mpcExt, STATE_NS: "S", VALUE_NS: m.namespace});
  rows.SBD_MDT.push(text(modelId, "DESCRIPTION", m.description));
  rows.SBD_SV.push({PROJECT: P, NODE_UUID: serviceId, TECHNICAL_NAME: m.service, VERSION: "0001", DPC: m.classes.dpcExt, EXTERNAL_NAME: m.service});
  rows.SBD_SVT.push(text(serviceId));

  const artifacts = [["MPCB", m.classes.mpc, "CLAS"], ["MPCS", m.classes.mpcExt, "CLAS"], ["DPCB", m.classes.dpc, "CLAS"], ["DPCS", m.classes.dpcExt, "CLAS"], ["MDL", m.model, "IWMO"], ["SRV", m.service, "IWSV"]];
  for (const [kind, name, type] of artifacts) {
    rows.SBD_GA.push({PROJECT: P, NODE_UUID: id("GA", kind), NAME: name, PGMID: "R3TR", TROBJ_TYPE: type, TROBJ_NAME: name, GEN_ART_TYPE: kind});
    rows.SBD_GAT.push(text(id("GA", kind)));
  }

  const etId = (e) => id("ETYP", e.name);
  const ctId = (c) => id("CTYP", c.name);
  const propertyRow = (uuid, parent, p) => (p.complexType
    // a complex property: the type by reference, no Edm type, every flag cleared
    ? {PROJECT: P, NODE_UUID: uuid, PARENT_UUID: parent, NAME: p.name, COMPLEX_TYPE: ctId({name: p.complexType}), REF_TYPE: "T", ABAP_FIELD: p.field,
      AS_AUTHOR_XU: "X", AS_ETAG_XU: "X", AS_PUBLISHED_XU: "X", AS_TITLE_XU: "X", AS_UPDATED_XU: "X", CREATABLE_XU: "X", FILTERABLE_XU: "X",
      SORTABLE_XU: "X", UPDATABLE_XU: "X", IS_NULLABLE_XU: "X", ABTY_XU: "X", SORT_ORDER: String(p.order), DESCRIPTION_XU: "X"}
    : {
      PROJECT: P, NODE_UUID: uuid, PARENT_UUID: parent, NAME: p.name, IS_KEY: X(p.isKey), CREATABLE: X(p.creatable), UPDATABLE: X(p.updatable),
      SORTABLE: X(p.sortable), FILTERABLE: X(p.filterable), IS_NULLABLE: X(p.nullable), MAX_LENGTH: p.length, PROP_PRECISION: p.digits, SCALE: p.scale,
      SEMANTICS: p.semantics, EDM_CORE_TYPE: p.type, REF_TYPE: "T", ABAP_FIELD: p.field, ABTY_XU: "X", SORT_ORDER: String(p.order),
      TYPE_NAME: p.typeName ?? "", TYPE_KIND: p.typeKind ?? "", LENGTH: p.abapLength ?? "",
      IS_UNICODE_XU: X(!p.unicode), DESCRIPTION_XU: "X",
    });
  for (const c of m.complexTypes ?? []) {
    rows.SBO_CT.push({PROJECT: P, NODE_UUID: ctId(c), NAME: c.name, MODEL: modelId, REF_TYPE: "T", TECH_NAME: c.name.toUpperCase(), ABAP_STRUCT: c.abapStruct, BASE_TYPE_XU: "X", DESCRIPTION_XU: "X"});
    rows.SBO_CTT.push(text(ctId(c)));
    for (const p of c.properties) {
      rows.SBO_PR.push(propertyRow(id("PROP", "CTYP", c.name, p.name), ctId(c), p));
      rows.SBO_PRT.push(text(id("PROP", "CTYP", c.name, p.name), "PROP_LABEL", p.label));
    }
  }
  const esId = (e) => id("ESET", e.set);
  const prId = (e, p) => id("PROP", e.name, p.name);
  for (const e of m.entities) {
    rows.SBO_ET.push({PROJECT: P, NODE_UUID: etId(e), NAME: e.name, IS_MEDIA: X(e.media), MODEL: modelId, REF_TYPE: "T", ABAP_STRUCT: e.abapStruct, TECH_NAME: e.name.toUpperCase(), DESCRIPTION_XU: X(!e.description)});
    rows.SBO_ETT.push(text(etId(e), "ET_LABEL", e.description || e.name));
    for (const p of e.properties) {
      rows.SBO_PR.push(propertyRow(prId(e, p), etId(e), p));
      if (!p.complexType) {
        rows.SBO_PRT.push(text(prId(e, p), "PROP_LABEL", p.label));
      }
    }
    rows.SBO_ES.push({
      PROJECT: P, NODE_UUID: esId(e), MODEL: modelId, NAME: e.set, ENTITY_TYPE: etId(e), CREATABLE: X(e.creatable), UPDATABLE: X(e.updatable), DELETABLE: X(e.deletable),
      PAGEABLE: X(e.pageable), ADDRESSABLE: X(e.addressable), SEARCHABLE: X(e.searchable), SUBSCRIBABLE: X(e.subscribable), REQUIRES_FILTER: X(e.filterRequired),
      REF_TYPE: "T", TECH_NAME: e.set.toUpperCase(), DESCRIPTION_XU: "X",
    });
    rows.SBO_EST.push(text(esId(e), "ESET_LABEL", e.set));
    // the design side: the entity set's node, one operation node per method
    const seId = id("DSET", e.set);
    // the service implementation node of the set hangs below the service node (SBD_SV), as SEGW writes it
    rows.SBD_SE.push({PROJECT: P, NODE_UUID: seId, PARENT_UUID: serviceId, NAME: e.set, ENTITY_SET_UUID: esId(e)});
    rows.SBD_SET.push(text(seId));
    for (const op of ["C", "R", "U", "D", "Q"].map((o) => e.operations.find((x) => x.type === o)).filter(Boolean)) {
      const opId = id("OPER", e.set, op.type);
      rows.SBD_OP.push({PROJECT: P, NODE_UUID: opId, PARENT_UUID: seId, NAME: OPERATIONS[op.type], OPERATION_TYPE: op.type, IMP_METHOD: `${e.set.toUpperCase().slice(0, 16)}_${OP_SUFFIX[op.type]}`});
      rows.SBD_OPT.push(text(opId));
      if (!op.mapping) {
        continue;
      }
      // one data-source node per module / search help, shared by the operations that use it
      const mp = op.mapping;
      const dsName = mp.kind === "RFC" ? mp.function : mp.searchhelp;
      const dsId = id("DSRC", mp.kind, dsName);
      if (!rows.SBD_DS.some((r) => r.NODE_UUID === dsId)) {
        if (mp.kind === "RFC") {
          rows.SBD_DS.push({PROJECT: P, NODE_UUID: dsId, PARENT_UUID: dataSourcesId, NAME: mp.function, DS_GROUP: mp.group, DS_TYPE: "2", RFC_DEST: mp.destination, FUNCTION_NAME: mp.function, LOG_DS_ATTR: mp.log});
        } else {
          rows.SBD_DS.push({PROJECT: P, NODE_UUID: dsId, PARENT_UUID: dataSourcesId, NAME: mp.searchhelp, DS_TYPE: "6", MAX_HITS_DS_ATTR: mp.maxHits});
        }
        rows.SBD_DST.push(text(dsId, "DESCRIPTION", dsName));
      }
      const mhId = id("MAPH", e.set, op.type);
      rows.SBD_MH.push({PROJECT: P, NODE_UUID: mhId, PARENT_UUID: opId, NAME: "Mapping", DS_UUID: dsId});
      const mpRow = (n, fields) => ({PROJECT: P, NODE_UUID: id("MAPP", e.set, op.type, String(n)), PARENT_UUID: mhId, ...fields});
      let n = 0;
      for (const x of mp.in) {
        rows.SBD_MP.push(mpRow(n++, {PROPERTY_UUID: prId(e, e.properties.find((p) => p.name === x.property)), PROPERTY_PATH: x.property, DIRECTION: "I", DS_ATT_PATH: x.path}));
      }
      for (const r of mp.ranges) {
        const row = mpRow(n++, {PROPERTY_UUID: prId(e, e.properties.find((p) => p.name === r.property)), PROPERTY_PATH: r.property, DIRECTION: "I", DS_ATT_PATH: r.table});
        rows.SBD_MP.push(row);
        for (const c of r.components) {
          rows.SBD_MR.push({PROJECT: P, NODE_UUID: row.NODE_UUID, DS_ATT_PATH: `${r.table}\\${c.component}`, SEMANTICS: c.semantics});
        }
      }
      for (const c of mp.constants) {
        rows.SBD_MP.push(mpRow(n++, {CONSTANT_VAL: c.value, DIRECTION: "I", DS_ATT_PATH: c.path}));
      }
      for (const x of mp.out) {
        rows.SBD_MP.push(mpRow(n++, {PROPERTY_UUID: prId(e, e.properties.find((p) => p.name === x.property)), PROPERTY_PATH: x.property, DIRECTION: "O", DS_ATT_PATH: x.path}));
      }
    }
    if (e.sadl) {
      const dsId = id("DSRC", e.name);
      rows.SBD_DS.push({PROJECT: P, NODE_UUID: dsId, PARENT_UUID: dataSourcesId, DS_GROUP: `${e.sadl.kind}~${e.sadl.binding}`, DS_TYPE: "4"});
      rows.SBD_DST.push(text(dsId, "DESCRIPTION", `${e.sadl.kind} ${e.sadl.binding}`));
      rows.SBD_MH.push({PROJECT: P, NODE_UUID: id("MAPH", e.set), PARENT_UUID: seId, NAME: "Mapping", DS_UUID: dsId});
    }
  }

  for (const a of m.associations) {
    const asoId = id("ASSO", a.name);
    rows.SBO_ASO.push({
      PROJECT: P, NODE_UUID: asoId, MODEL_GUID: modelId, NAME: a.name, LEFT_END_GUID: etId(a.from), RIGHT_END_GUID: etId(a.to),
      LEFT_END_CARD: a.card.left, RIGHT_END_CARD: a.card.right, REF_TYPE: "T", DESCRIPTION_XU: "X",
    });
    rows.SBO_AST.push(text(asoId, "ASSOC_LABEL", a.name));
    for (const c of a.constraint) {
      const principal = a.from.properties.find((p) => p.name === c.principal);
      const dependent = a.to.properties.find((p) => p.name === c.dependent);
      if (!principal || !dependent) {
        throw new Error(`${a.name}: constraint ${c.principal} -> ${c.dependent} names a property that is not there`);
      }
      const rcId = id("RCON", a.name, c.principal, c.dependent);
      rows.SBO_RC.push({PROJECT: P, NODE_UUID: rcId, ASSOCIATION_GUID: asoId, NAME: c.dependent, PRINCIPAL_PROP_R: prId(a.from, principal), DEPENDENT_PROP_R: prId(a.to, dependent), REF_TYPE: "T", DESCRIPTION_XU: "X"});
      rows.SBO_RCT.push(text(rcId));
    }
    const atId = id("ASET", a.set);
    rows.SBO_AT.push({PROJECT: P, NODE_UUID: atId, MODEL_GUID: modelId, NAME: a.set, ASSOCIATION_GUID: asoId, LEFT_END_GUID: esId(a.from), RIGHT_END_GUID: esId(a.to), REF_TYPE: "T", DESCRIPTION_XU: "X"});
    rows.SBO_ATT.push(text(atId, "ASST_LABEL", a.set));
    for (const n of a.navigation) {
      const npId = id("NAVP", n.entity.name, n.name);
      rows.SBO_NP.push({PROJECT: P, NODE_UUID: npId, ENTITY_GUID: etId(n.entity), NAME: n.name, RELATION_GUID: asoId, REF_TYPE: "T", TECH_NAME: n.name.toUpperCase(), DESCRIPTION_XU: "X"});
      rows.SBO_NPT.push(text(npId, "NAVP_LABEL", n.name));
    }
  }

  for (const f of m.functions) {
    const fiId = id("FUNC", f.name);
    rows.SBO_FI.push({
      PROJECT: P, NODE_UUID: fiId, MODEL: modelId, NAME: f.name, HTTP_METHOD: f.method, ACTION_FOR: f.actionFor ? etId(f.actionFor) : "",
      RETURN_CARD: f.multiplicity, RETURN_REF_TYPE: f.returnEntity ? etId(f.returnEntity) : f.returnComplex ? ctId({name: f.returnComplex}) : "",
      RETURN_TYPE_KIND: f.returnEntity ? "ETYP" : f.returnComplex ? "CTYP" : "",
      // **An action bound to an entity type may not name a return entity
      // set.** SEGW refuses the project with "Function Import 'CancelTravel'
      // may not specify an Entity Set" (A4H, 2026-09-19) -- and the entity
      // set is in the metadata anyway, because Gateway derives it from the
      // type the action is for. We were writing it as well, which is the
      // conflict. A free-standing function import still names its set.
      RETURN_ENTITYSET: (f.returnSet && !f.actionFor)
        ? esId(m.entities.find((e) => e.set === f.returnSet) ?? f.returnEntity) : "",
      REF_TYPE: "T", DESCRIPTION_XU: "X",
    });
    // **A label is what a person typed; the name is what the tool made.**
    // This wrote the name unconditionally, and both generators read no label
    // at all, so the three agreed by all being blind in the same place. A
    // YAML can now say `label:` on an operation or a parameter, and where it
    // does not the name is still written -- which is what SEGW does and what
    // a system shows.
    rows.SBO_FIT.push(text(fiId, "FI_LABEL", f.label || f.name));
    for (const p of f.parameters) {
      const fpId = id("FPAR", f.name, p.name);
      rows.SBO_FP.push({PROJECT: P, NODE_UUID: fpId, NAME: p.name, FUNCTION_IMPORT: fiId, ABAP_FIELD: p.field, EDM_CORE_TYPE: p.type, MAX_LENGTH: p.length, REF_TYPE: "T", ABTY_XU: "X", DESCRIPTION_XU: "X"});
      rows.SBO_FPT.push(text(fpId, "FI_PARAM_LABEL", p.label || p.name));
    }
  }

  let body = "";
  for (const tag of Object.keys(rows).sort()) {
    body += table(tag, rows[tag]);
  }
  // A BOM, because every real export has one: `EF BB BF` on all 44 corpus
  // files and on everything abapGit wrote for S_APS_ODATA_GBT_NTE. The class
  // XML above already had it, these three did not, and zcl_stg_segw_repo adds
  // one on the ABAP side -- so the two implementations differed here too, in
  // a place the test that holds them byte-identical does not look.
  return `\ufeff<?xml version="1.0" encoding="utf-8"?>
<abapGit version="v1.0.0" serializer="LCL_OBJECT_IWPR" serializer_version="v1.0.0">
 <asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0">
  <asx:values>
${body}  </asx:values>
 </asx:abap>
</abapGit>
`;
}

// --------------------------------------------------------- IWSV / IWMO

export function iwsvXml(m) {
  // A BOM, because every real export has one: `EF BB BF` on all 44 corpus
  // files and on everything abapGit wrote for S_APS_ODATA_GBT_NTE. The class
  // XML above already had it, these three did not, and zcl_stg_segw_repo adds
  // one on the ABAP side -- so the two implementations differed here too, in
  // a place the test that holds them byte-identical does not look.
  return `\ufeff<?xml version="1.0" encoding="utf-8"?>
<abapGit version="v1.0.0" serializer="LCL_OBJECT_IWSV" serializer_version="v1.0.0">
 <asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0">
  <asx:values>
   <_-IWBEP_-I_MGW_SRG>
    <_-IWBEP_-I_MGW_SRG>
     <GROUP_TECH_NAME>${m.service}</GROUP_TECH_NAME>
     <GROUP_VERSION>0001</GROUP_VERSION>
     <MODEL_TECH_NAME>${m.model}</MODEL_TECH_NAME>
     <MODEL_VERSION>0001</MODEL_VERSION>
    </_-IWBEP_-I_MGW_SRG>
   </_-IWBEP_-I_MGW_SRG>
   <_-IWBEP_-I_MGW_SRH>
    <_-IWBEP_-I_MGW_SRH>
     <TECHNICAL_NAME>${m.service}</TECHNICAL_NAME>
     <VERSION>0001</VERSION>
     <EXTERNAL_NAME>${m.service}</EXTERNAL_NAME>
     <CLASS_NAME>${m.classes.dpcExt}</CLASS_NAME>
     <IS_SAP_SERVICE>-</IS_SAP_SERVICE>
    </_-IWBEP_-I_MGW_SRH>
   </_-IWBEP_-I_MGW_SRH>
   <_-IWBEP_-I_MGW_SRT>
    <_-IWBEP_-I_MGW_SRT>
     <TECHNICAL_NAME>${m.service}</TECHNICAL_NAME>
     <VERSION>0001</VERSION>
     <LANGUAGE>E</LANGUAGE>
     <DESCRIPTION>${esc(m.description)}</DESCRIPTION>
    </_-IWBEP_-I_MGW_SRT>
   </_-IWBEP_-I_MGW_SRT>
  </asx:values>
 </asx:abap>
</abapGit>
`;
}

export function iwmoXml(m) {
  // A BOM, because every real export has one: `EF BB BF` on all 44 corpus
  // files and on everything abapGit wrote for S_APS_ODATA_GBT_NTE. The class
  // XML above already had it, these three did not, and zcl_stg_segw_repo adds
  // one on the ABAP side -- so the two implementations differed here too, in
  // a place the test that holds them byte-identical does not look.
  return `\ufeff<?xml version="1.0" encoding="utf-8"?>
<abapGit version="v1.0.0" serializer="LCL_OBJECT_IWMO" serializer_version="v1.0.0">
 <asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0">
  <asx:values>
   <_-IWBEP_-I_MGW_OHD>
    <_-IWBEP_-I_MGW_OHD>
     <TECHNICAL_NAME>${m.model}</TECHNICAL_NAME>
     <VERSION>0001</VERSION>
     <CLASS_NAME>${m.classes.mpcExt}</CLASS_NAME>
    </_-IWBEP_-I_MGW_OHD>
   </_-IWBEP_-I_MGW_OHD>
   <_-IWBEP_-I_MGW_OHT>
    <_-IWBEP_-I_MGW_OHT>
     <TECHNICAL_NAME>${m.model}</TECHNICAL_NAME>
     <VERSION>0001</VERSION>
     <LANGUAGE>E</LANGUAGE>
     <DESCRIPTION>${esc(m.description)}</DESCRIPTION>
    </_-IWBEP_-I_MGW_OHT>
   </_-IWBEP_-I_MGW_OHT>
  </asx:values>
 </asx:abap>
</abapGit>
`;
}

// abapGit names: /NS/X -> #ns#x; a versioned key is the technical name
// padded, then a four-character version.
//
// **The padding is per object type, and this cost two wrong answers before a
// real export settled it.** It was 34 for both here and in
// zcl_stg_segw_repo, and the two agreed, so the test holding them
// byte-identical passed for months: it compares the implementations with
// each other and never with a system. Then abapGit refused the import --
// "This syntax cannot be used for an object name" -- and the first fix made
// both 32, from three IWMO objects read off A4H's ADT URIs. That fixed the
// IWMO and broke the IWSV, which is not 32.
//
// Measured properly by exporting a real SEGW package from A4H with abapGit
// (S_APS_ODATA_GBT_NTE, 31 objects) and reading the file names it wrote:
//
//   IWMO  sgbt_nte_demo_mdl               0001   padded to 32, key 36
//   IWVB  sgbt_nte_demo_anno_mdl          0001   padded to 32, key 36
//   IWSV  sgbt_nte_demo_srv                  0001   padded to 35, key 39
//
// Three of each, all agreeing. The tree had both answers already and they
// were both right: test/segw.mjs held `zui5_code_search_mdl` at 36 and
// `zui5_code_search_srv` at 39, and the first "fix" made the second wrong.
// Taking one measurement and generalising it over a second object type is
// how a correct fixture gets edited to match a broken generator.
export const KEY_WIDTH = {".iwsv.xml": 35, ".iwmo.xml": 32, ".iwvb.xml": 32};
const objectFile = (name, ext) => name.toLowerCase().replaceAll("/", "#") + ext;
const versionedFile = (name, ext) => {
  const width = KEY_WIDTH[ext];
  if (width === undefined) throw new Error(`no key width known for ${ext}`);
  return name.toLowerCase().padEnd(width, " ") + "0001" + ext;
};

// everything the folder gets: the tree, the registration objects, the
// classes (generated from the tree by segw-gen, so what SEGW would write)
export function compile(text, opts = {}) {
  const m = readModel(text, opts.file);
  const iwpr = iwprXml(m, opts);
  const files = {
    [objectFile(m.project, ".iwpr.xml")]: iwpr,
    [versionedFile(m.service, ".iwsv.xml")]: iwsvXml(m),
    [versionedFile(m.model, ".iwmo.xml")]: iwmoXml(m),
  };
  const warnings = [];
  const generated = generate(iwpr, {functionModules: opts.functionModules ?? new Map(), warnings, labelAnnotations: true, ...(opts.generateOptions ?? {})});
  const classes = {...generated.files, ...annotationsClass(m)};
  const ext = {...generated.ext};
  if (m.annotations.length > 0) {
    ext[objectFile(m.classes.mpcExt, ".clas.abap")] = mpcExtWithAnnotations(m);
  }
  return {model: m, iwpr, files, classes, ext, segw: generated.model,
    warnings: [...(m.warnings ?? []), ...warnings]};
}

// ---------------------------------------------------- the build step

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir).sort();
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) {
      if (e !== "node_modules" && e !== ".git") {
        walk(p, out);
      }
    } else {
      out.push(p);
    }
  }
  return out;
}

// `npm run transpile` step: every <name>.stg.yaml in the configured inputs compiles into
// gen/stg/<project>/ (the classes, IWSV and IWMO; the registry reads gen/
// too), except the files a developer already keeps under src/ by the same
// name: the demo's hand-written classes and registration objects win, so
// the YAML there documents the model and is checked by test/stg-compile.mjs
// without producing a second copy of the service.
export function compileAll(root = "src", out = "gen/stg", libs = [], extraRoots = []) {
  // by object, not by file: a hand-written zcl_x.clas.abap keeps the
  // generated zcl_x.clas.xml out as well
  const objectOf = (name) => basename(name).toLowerCase().replace(/\.(abap|xml)$/, "");
  // **Where the file is, not only that it exists.** "kept from src/" reads
  // like a convenience and is in fact a list of places where two versions of
  // one object live and nothing compares them: 18 objects across three
  // services on 2026-09-19, of which `Text` against `status_text` was one.
  // Carrying the path lets a test read both sides off disk instead of
  // trusting a literal somebody transcribed.
  // A pack is source too. Looking only under `src/` made a hand-written
  // pack-local DPC_EXT invisible, so the empty generated skeleton in gen/
  // overrode it. Every model root contributes both models and owned objects.
  const roots = (Array.isArray(root) ? root : [root, ...extraRoots]).filter((d) => existsSync(d));
  // an object's .xml sorts after its .abap and would stand for it; the path
  // is read as source (test/shadowed-objects.mjs), so within a folder the
  // .abap is listed last and wins
  const sourceLast = (a, b) => Number(a.endsWith(".abap")) - Number(b.endsWith(".abap"));
  const existingPaths = new Map(winningByLayer(roots, (dir) => walk(dir).sort(sourceLast), objectOf)
    .map((file) => [objectOf(file), file]));
  const existing = new Set(existingPaths.keys());
  const functionModules = loadFunctionGroups([...libs, ...roots]);
  const report = [];
  // The configured layer order also applies to models another generator wrote
  // (a CDS view published with @OData.publish, gen/cds/*.stg.yaml).
  const files = winningByLayer(roots, (dir) => walk(dir).filter((p) => p.endsWith(".stg.yaml")),
    (file) => readModel(readFileSync(file, "utf8"), basename(file)).project);
  for (const file of files) {
    const result = compile(readFileSync(file, "utf8"), {file: basename(file), functionModules});
    const target = join(out, result.model.project.toLowerCase().replaceAll("/", "#"));
    const written = [];
    const kept = [];
    const shadowed = [];
    for (const [name, content] of Object.entries({...result.files, ...result.classes, ...result.ext})) {
      if (name.endsWith(".iwpr.xml")) {
        continue; // the tree itself is not ABAP; --out writes it
      }
      if (existing.has(objectOf(name))) {
        // and a copy generated before src/ got the object goes, or the
        // transpiler would see the object twice and may take the stale one
        if (existsSync(join(target, name))) {
          rmSync(join(target, name));
        }
        kept.push(name);
        shadowed.push({name, generated: content, path: existingPaths.get(objectOf(name))});
        continue;
      }
      mkdirSync(target, {recursive: true});
      writeFileSync(join(target, name), content);
      written.push(name);
    }
    // the folder belongs to this model: what an earlier run left there and
    // this one did not write (a renamed class, an object that moved to src/)
    // would otherwise be transpiled as a second copy
    if (existsSync(target)) {
      for (const name of readdirSync(target).sort()) {
        if (!written.includes(name)) {
          rmSync(join(target, name));
        }
      }
    }
    report.push({file, project: result.model.project, service: result.model.service, written, kept, shadowed, warnings: result.warnings});
  }
  // A project whose YAML is gone leaves its folder behind otherwise, and the
  // registry keeps serving a service nobody declares any more; measured on
  // the user's path 2026-09-17: unsetting OSD_PACKS after a trial left two
  // folders under gen/stg and the build failed on a class of a pack that was
  // no longer there. What this run did not write, it removes.
  const produced = new Set(report.map((r) => r.project.toLowerCase().replaceAll("/", "#")));
  if (existsSync(out)) {
    for (const name of readdirSync(out).sort()) {
      const dir = join(out, name);
      if (statSync(dir).isDirectory() && produced.has(name) === false) {
        rmSync(dir, {recursive: true, force: true});
        report.push({file: undefined, project: name.toUpperCase(), service: undefined, written: [], kept: [], warnings: [], removed: true});
      }
    }
  }
  return report;
}

export function compileConfiguredAll(root = process.env.OSD_ROOT ?? process.cwd(), out = "gen/stg", libs = [], env = process.env) {
  return compileAll(generatorFoldersOf(root, env).map((f) => f === "gen" ? "gen/cds" : f), out, libs);
}

/** Everything a compiled project puts in a folder. Lifted out of the CLI
 *  because a second caller appeared: `osd-abapgit-zip` used to compile a
 *  YAML by spawning this file with `process.execPath`, which is the one
 *  thing `test/osd-binary.mjs` forbids -- in a compiled binary
 *  `process.execPath` is the binary and there is no script beside it, so
 *  the zip builder worked from a checkout and not from a release. A
 *  library call has no such seam. */
export function writeCompiled(result, out) {
  mkdirSync(out, {recursive: true});
  for (const [name, content] of Object.entries({...result.files, ...result.classes})) {
    writeFileSync(join(out, name), content);
  }
  // the _EXT pair is the developer's: written once, never overwritten
  for (const [name, content] of Object.entries(result.ext)) {
    if (!existsSync(join(out, name))) {
      writeFileSync(join(out, name), content);
    }
  }
  return {objects: Object.keys(result.files).length, classes: Object.keys(result.classes).length};
}

/** Compile one `.stg.yaml` into a folder, the way the command does. */
export function compileFile(file, out, libs = []) {
  const result = compile(readFileSync(file, "utf8"),
    {file: basename(file), functionModules: loadFunctionGroups([...libs, dirname(file)])});
  if (out !== undefined) {
    writeCompiled(result, out);
  }
  return result;
}

// ------------------------------------------------------------------ CLI

if (process.argv[1] && /stg-compile\.mjs$/.test(process.argv[1])) {
  const args = process.argv.slice(2);
  const valued = ["--out", "--lib"];
  const file = args.find((a, i) => !a.startsWith("--") && !valued.includes(args[i - 1]));
  const out = args.includes("--out") ? args[args.indexOf("--out") + 1] : undefined;
  const libs = args.flatMap((a, i) => (a === "--lib" ? [args[i + 1]] : []));
  if (args.includes("--all")) {
    for (const r of compileConfiguredAll(process.env.OSD_ROOT ?? process.cwd(), "gen/stg", libs)) {
      if (r.removed === true) {
        console.log(`stg-compile: gen/stg/${r.project.toLowerCase()}: removed, no YAML declares it any more`);
        continue;
      }
      console.log(`stg-compile: ${r.file}: ${r.service}${r.written.length > 0 ? ` -> gen/stg: ${r.written.length} files` : ""}${r.kept.length > 0 ? ` (${r.kept.length} held by src/, not compared)` : ""}`);
      for (const w of r.warnings) {
        console.log(`  warning: ${w}`);
      }
    }
    process.exit(0);
  }
  if (!file) {
    console.error("usage: stg-compile.mjs <service.stg.yaml> [--out <dir>] [--lib <folder with *.fugr.xml>]... | --all (every src/**/*.stg.yaml into gen/stg/)");
    process.exit(2);
  }
  const result = compile(readFileSync(file, "utf8"), {file: basename(file), functionModules: loadFunctionGroups([...libs, dirname(file)])});
  const m = result.model;
  console.log(`stg-compile: ${m.project} -> service ${m.service}, model ${m.model}: ${m.entities.length} entities, ${m.associations.length} associations, ${m.functions.length} function imports; classes ${Object.values(m.classes).join(", ")}`);
  for (const w of result.warnings) {
    console.log(`  warning: ${w}`);
  }
  if (out) {
    const wrote = writeCompiled(result, out);
    console.log(`  written to ${out}: ${wrote.objects} objects, ${wrote.classes} class files, _EXT pair if it was missing`);
  } else {
    process.stdout.write(result.iwpr);
  }
}
