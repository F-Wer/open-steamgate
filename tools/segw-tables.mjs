// The SEGW project tree as our own tables.
//
// SEGW keeps a project in /IWBEP/I_SBD_* (service builder design: project,
// model, service, data sources, mappings, generated artifacts) and
// /IWBEP/I_SBO_* (the OData model: entity types, properties, sets,
// associations, navigation, function imports, annotations). abapGit
// serializes those tables one to one into <project>.iwpr.xml. We do not
// have the DDIC of the SAP tables and do not write it from memory; the
// IWPR files are the contract. `--derive` reads every IWPR file it finds
// and records, per table, the fields in the order SEGW writes them (the
// DDIC order), the longest value seen, and the key: the shortest prefix
// of the fields that is unique (PROJECT + NODE_UUID; SYLANGU + PROJECT +
// NODE_UUID for texts; PROJECT + NODE_UUID + DS_ATT_PATH for mapping
// rules). The spec lands in tools/segw-tables.json.
//
// Without arguments the script turns the spec into src/segw/ddic/
// zstg_<table>.tabl.xml and src/segw/zstg_segw.stg.yaml (ZSTG_SEGW_SRV, one
// entity per table, plus ImportSet (POST an IWPR file as Content) and
// ExportSet (GET the project as one), served by the hand-written
// zcl_zstg_segw_dpc_ext). Every field is CHAR of the size class above the
// longest value seen (1, 4, 10, 32, 40, 60, 80), LANG for SYLANGU, STRING
// above 80 and for free text: SEGW's flags, counters and timestamps come back out of the
// tables exactly as they went in, which is what a byte-identical export
// needs. One column is ours: STG_SEQ (INT4) keeps the row order of the
// imported file, because SEGW does not write rows in key order.
//
// Usage: node tools/segw-tables.mjs [--check]
//        node tools/segw-tables.mjs --derive <folder>... [--spec <file>]
import {existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync} from "node:fs";
import {join} from "node:path";
import {runsAs} from "./osd-main.mjs";

export const SPEC_FILE = "tools/segw-tables.json";
export const DDIC_DIR = "src/segw/ddic";
export const YAML_FILE = "src/segw/zstg_segw.stg.yaml";
export const SEQ_FIELD = "STG_SEQ";
export const CLIENT = "123";

// entity names for the tables segw-gen and stg-compile read; the rest are
// named after their table. SEGW builds method names from the first 16
// characters of the entity name, so those must differ (Artifact and
// ArtifactText, not GeneratedArtifact...)
const NAMES = {
  SBD_PR: "Project", SBD_MD: "Model", SBD_SV: "Service", SBD_GA: "Artifact", SBD_DS: "DataSource",
  SBD_OP: "Operation", SBD_SE: "ServiceEntity", SBD_MH: "MappingHeader", SBD_MP: "MappingProperty", SBD_MR: "MappingRule",
  SBD_AT: "Attachment", SBD_MAP: "NodeMap", SBD_NOI: "NodeOfInterest",
  SBO_ET: "EntityType", SBO_PR: "Property", SBO_ES: "EntitySet", SBO_ASO: "Association", SBO_AT: "AssociationSet",
  SBO_NP: "NavProperty", SBO_RC: "RefConstraint", SBO_FI: "FunctionImport", SBO_FP: "FunctionParam",
  SBO_CT: "ComplexType", SBO_DSR: "ReferenceDataSource", SBO_MR: "ModelReference",
};

const camel = (s) => String(s).toLowerCase().replace(/(^|_)([a-z0-9])/g, (_, __, c) => c.toUpperCase());

export function entityName(tag) {
  if (NAMES[tag]) {
    return NAMES[tag];
  }
  const base = tag.replace(/T$/, "");
  if (base !== tag && NAMES[base]) {
    return NAMES[base] + "Text";
  }
  return camel(tag);
}

export function propertyName(field) {
  if (field === "SYLANGU") {
    return "Language";
  }
  return camel(field);
}

// ------------------------------------------------------------- IWPR rows

// abapGit nests <T><T>row</T><T>row</T></T>; a row is a flat list of fields
export function iwprTables(xml) {
  const out = new Map();
  const re = /<_-IWBEP_-I_(SB[DO]_[A-Z]+)>\n([\s\S]*?)\n   <\/_-IWBEP_-I_\1>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const [, tag, body] = m;
    const rows = [];
    const rowRe = new RegExp(`    <_-IWBEP_-I_${tag}>\\n([\\s\\S]*?)\\n    </_-IWBEP_-I_${tag}>`, "g");
    let r;
    while ((r = rowRe.exec(body)) !== null) {
      const row = {};
      for (const f of r[1].matchAll(/     <([A-Z_0-9]+)>([\s\S]*?)<\/\1>/g)) {
        row[f[1]] = unescape(f[2]);
      }
      rows.push(row);
    }
    out.set(tag, rows);
  }
  return out;
}

export function unescape(s) {
  return s.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", "\"").replaceAll("&apos;", "'").replaceAll("&amp;", "&");
}

export function escape(s) {
  return String(s).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("\"", "&quot;").replaceAll("'", "&apos;");
}

function findIwpr(folder, out = []) {
  for (const name of readdirSync(folder)) {
    if (name === "node_modules" || name === ".git") {
      continue;
    }
    const p = join(folder, name);
    if (statSync(p).isDirectory()) {
      findIwpr(p, out);
    } else if (name.endsWith(".iwpr.xml")) {
      out.push(p);
    }
  }
  return out;
}

// the order fields appear in across all rows; every row is a chain, the
// chains must agree (they do: it is the DDIC order of the SAP table)
function fieldOrder(chains) {
  const before = new Map();
  for (const chain of chains) {
    for (let i = 0; i < chain.length; i++) {
      if (!before.has(chain[i])) {
        before.set(chain[i], new Set());
      }
      for (let j = 0; j < i; j++) {
        before.get(chain[i]).add(chain[j]);
      }
    }
  }
  const order = [];
  const done = new Set();
  while (done.size < before.size) {
    const ready = [...before.keys()].filter((f) => !done.has(f) && [...before.get(f)].every((p) => done.has(p)));
    if (ready.length === 0) {
      throw new Error("the field orders of the IWPR files contradict each other: " + [...before.keys()].filter((f) => !done.has(f)).join(", "));
    }
    // several fields ready at once never appear in one row together: keep
    // the one seen first, so the result is stable
    const first = [...before.keys()].find((f) => ready.includes(f));
    order.push(first);
    done.add(first);
  }
  return order;
}

// The sizes come from the projects we have, and a sample can be narrower
// than the real column: the description of SEGW's project is 40 characters
// in every corpus file, our own demo has 41 and this service's own YAML 83.
// Free text (a DESCRIPTION, a *_LABEL) is therefore a STRING: it holds
// whatever a project puts there, and a string round trips exactly like a
// CHAR field (trailing blanks are trimmed on both). Other fields stay as
// the sample says; the import refuses anything a column cannot hold, so a
// value that does not fit is a 400 naming the table, the field and the
// length, never a silent cut.
const isFreeText = (field) => /(^|_)(DESCRIPTION|LABEL)$/.test(field);

function sizeClass(max) {
  for (const n of [1, 4, 10, 32, 40, 60, 80]) {
    if (max <= n) {
      return `CHAR ${n}`;
    }
  }
  return "STRG";
}

export function derive(folders) {
  const files = folders.flatMap((f) => findIwpr(f));
  const chains = new Map();
  const longest = new Map();
  const rows = new Map();
  for (const file of files) {
    for (const [tag, list] of iwprTables(readFileSync(file, "utf8"))) {
      if (!chains.has(tag)) {
        chains.set(tag, []);
        longest.set(tag, new Map());
        rows.set(tag, []);
      }
      for (const row of list) {
        chains.get(tag).push(Object.keys(row));
        for (const [f, v] of Object.entries(row)) {
          longest.get(tag).set(f, Math.max(longest.get(tag).get(f) ?? 0, v.length));
        }
        rows.get(tag).push({...row, __file: file});
      }
    }
  }
  const spec = {};
  for (const tag of [...chains.keys()].sort()) {
    const order = fieldOrder(chains.get(tag));
    const fields = {};
    for (const f of order) {
      fields[f] = f === "PROJECT" ? "CHAR 30" : f === "SYLANGU" ? "LANG" : isFreeText(f) ? "STRG" : sizeClass(longest.get(tag).get(f));
    }
    // the key is the shortest prefix of the fields that is unique in every
    // file (a DDIC key is a prefix), and never shorter than PROJECT,
    // NODE_UUID and SYLANGU where the table has them
    const must = ["PROJECT", "NODE_UUID", "SYLANGU"].filter((k) => order.includes(k)).map((k) => order.indexOf(k));
    const keys = order.slice(0, Math.max(...must) + 1);
    const unique = (k) => {
      const seen = new Set();
      for (const row of rows.get(tag)) {
        const v = k.map((f) => row[f] ?? "").join("|") + "|" + row.__file;
        if (seen.has(v)) {
          return false;
        }
        seen.add(v);
      }
      return true;
    };
    while (!unique(keys) && keys.length < order.length) {
      keys.push(order[keys.length]);
    }
    if (!unique(keys)) {
      throw new Error(`${tag}: no unique key`);
    }
    spec[tag] = {entity: entityName(tag), keys, fields};
  }
  return {spec, files: files.length};
}

// ----------------------------------------------------------- generation

function dd03p(name, type, key) {
  const [datatype, len] = type.split(" ");
  const L = (n) => String(n).padStart(6, "0");
  let s = `    <DD03P>\n     <FIELDNAME>${name}</FIELDNAME>\n`;
  if (key) {
    s += `     <KEYFLAG>X</KEYFLAG>\n`;
  }
  if (name === "MANDT") {
    return s + `     <ROLLNAME>MANDT</ROLLNAME>\n     <ADMINFIELD>0</ADMINFIELD>\n     <NOTNULL>X</NOTNULL>\n     <COMPTYPE>E</COMPTYPE>\n    </DD03P>\n`;
  }
  s += `     <ADMINFIELD>0</ADMINFIELD>\n`;
  const notnull = key ? `     <NOTNULL>X</NOTNULL>\n` : "";
  if (datatype === "CHAR") {
    s += `     <INTTYPE>C</INTTYPE>\n     <INTLEN>${L(len * 2)}</INTLEN>\n${notnull}     <DATATYPE>CHAR</DATATYPE>\n     <LENG>${L(len)}</LENG>\n     <MASK>  CHAR</MASK>\n`;
  } else if (datatype === "LANG") {
    s += `     <INTTYPE>C</INTTYPE>\n     <INTLEN>000002</INTLEN>\n${notnull}     <DATATYPE>LANG</DATATYPE>\n     <LENG>000001</LENG>\n     <MASK>  LANG</MASK>\n`;
  } else if (datatype === "STRG") {
    s += `     <INTTYPE>g</INTTYPE>\n     <INTLEN>000008</INTLEN>\n     <DATATYPE>STRG</DATATYPE>\n     <MASK>  STRG</MASK>\n`;
  } else if (datatype === "INT4") {
    s += `     <INTTYPE>X</INTTYPE>\n     <INTLEN>000004</INTLEN>\n     <DATATYPE>INT4</DATATYPE>\n     <LENG>000010</LENG>\n     <MASK>  INT4</MASK>\n`;
  } else {
    throw new Error(`unknown type ${type}`);
  }
  return s + `    </DD03P>\n`;
}

export function tableName(tag) {
  return `ZSTG_${tag}`;
}

export function tablXml(tag, t) {
  const name = tableName(tag);
  const text = `SEGW tree: /IWBEP/I_${tag}`;
  let s = `<?xml version="1.0" encoding="utf-8"?>
<abapGit version="v1.0.0" serializer="LCL_OBJECT_TABL" serializer_version="v1.0.0">
 <asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0">
  <asx:values>
   <DD02V>
    <TABNAME>${name}</TABNAME>
    <DDLANGUAGE>E</DDLANGUAGE>
    <TABCLASS>TRANSP</TABCLASS>
    <CLIDEP>X</CLIDEP>
    <DDTEXT>${text}</DDTEXT>
    <MAINFLAG>X</MAINFLAG>
    <CONTFLAG>A</CONTFLAG>
    <EXCLASS>1</EXCLASS>
   </DD02V>
   <DD09L>
    <TABNAME>${name}</TABNAME>
    <AS4LOCAL>A</AS4LOCAL>
    <TABKAT>0</TABKAT>
    <TABART>APPL1</TABART>
    <BUFALLOW>N</BUFALLOW>
   </DD09L>
   <DD03P_TABLE>
`;
  s += dd03p("MANDT", "CLNT 3", true);
  for (const [f, type] of Object.entries(t.fields)) {
    s += dd03p(f, type, t.keys.includes(f));
  }
  s += dd03p(SEQ_FIELD, "INT4", false);
  return s + `   </DD03P_TABLE>
  </asx:values>
 </asx:abap>
</abapGit>
`;
}

function edmOf(type) {
  const [datatype, len] = type.split(" ");
  return datatype === "CHAR" ? `String(${len})` : datatype === "LANG" ? "String(1)" : datatype === "STRG" ? "String" : "Int32";
}

export function serviceYaml(spec) {
  let s = `# generated by tools/segw-tables.mjs from ${SPEC_FILE}; edit the spec, not this file
project: ZSTG_SEGW
service: ZSTG_SEGW_SRV
description: "SEGW as an application: the project tree, served from its own tables"

entities:
`;
  for (const [tag, t] of Object.entries(spec)) {
    s += `  ${t.entity}:\n    set: ${t.entity}Set\n    description: "/IWBEP/I_${tag} as ${tableName(tag)}"\n    source: {table: ${tableName(tag)}}\n`;
    s += `    keys: [${t.keys.map(propertyName).join(", ")}]\n    properties:\n`;
    for (const [f, type] of Object.entries(t.fields)) {
      s += `      ${propertyName(f)}: {type: ${edmOf(type)}, field: ${f}}\n`;
    }
    s += `      ${propertyName(SEQ_FIELD)}: {type: Int32, field: ${SEQ_FIELD}}\n`;
  }
  // the import: POST an IWPR file as Content, the project's rows are
  // replaced (zcl_stg_segw_import through zcl_zstg_segw_dpc_ext); the
  // export: GET ExportSet('P'), the project as a file (zcl_stg_segw_export);
  // DELETE NodeSet(P, uuid): a node with its subtree (zcl_stg_segw_tree);
  // RepoSet / RepoFileSet: the project as an abapGit repository, what a
  // system pulls to have it (zcl_stg_segw_repo)
  s += `  Import:
    set: ImportSet
    description: "POST an IWPR file as Content; the project's rows in every table are replaced"
    keys: [Project]
    properties:
      Project: {type: String(30)}
      Content: {type: String}
      Rows: {type: Int32}
      Tables: {type: Int32}
    updatable: false
    deletable: false
  Node:
    set: NodeSet
    description: "DELETE NodeSet(Project='P',NodeUuid='x'): the node and its subtree, as SEGW deletes"
    keys: [Project, NodeUuid]
    properties:
      Project: {type: String(30)}
      NodeUuid: {type: String(32)}
    creatable: false
    updatable: false
  FunctionGroup:
    set: FunctionGroupSet
    description: "POST an abapGit *.fugr.xml as Content: the module signatures go to ZSTG_FM_PARAM"
    keys: [Name]
    properties:
      Name: {type: String(30)}
      Content: {type: String}
      Modules: {type: Int32}
      Rows: {type: Int32}
    updatable: false
    deletable: false
  ModuleParameter:
    set: ModuleParameterSet
    description: "ZSTG_FM_PARAM: a function module's parameters, what the generator reads for a mapped operation"
    source: {table: ZSTG_FM_PARAM}
    keys: [Funcname, Parameter]
    properties:
      Funcname: {type: String(30), field: FUNCNAME}
      Parameter: {type: String(30), field: PARAM_NAME}
      Kind: {type: String(1), field: KIND}
      Typ: {type: String(30), field: TYP}
      Optional: {type: String(1), field: OPTIONAL}
      Remote: {type: String(1), field: REMOTE}
      StgSeq: {type: Int32, field: STG_SEQ}
  Repo:
    set: RepoSet
    description: "GET RepoSet('P'): the project as an abapGit repository, one zip in base64"
    keys: [Project]
    properties:
      Project: {type: String(30)}
      Content: {type: String}
      Files: {type: Int32}
    creatable: false
    updatable: false
    deletable: false
  RepoFile:
    set: RepoFileSet
    description: "GET RepoFileSet?$filter=Project eq 'P': the files of that repository (Name, Content)"
    keys: [Project, Name]
    properties:
      Project: {type: String(30)}
      Name: {type: String(80)}
      Content: {type: String}
    creatable: false
    updatable: false
    deletable: false
  Generate:
    set: GenerateSet
    description: "GET GenerateSet?$filter=Project eq 'P': the generated classes as files (Name, Content), segw-gen in ABAP"
    keys: [Project, Name]
    properties:
      Project: {type: String(30)}
      Name: {type: String(80)}
      Content: {type: String}
    creatable: false
    updatable: false
    deletable: false
  Export:
    set: ExportSet
    description: "GET ExportSet('P'): the project as an IWPR file in Content"
    keys: [Project]
    properties:
      Project: {type: String(30)}
      Content: {type: String}
    creatable: false
    updatable: false
    deletable: false
`;
  return s;
}

export function readSpec(file = SPEC_FILE) {
  return JSON.parse(readFileSync(file, "utf8"));
}

export function generated(spec) {
  const files = {};
  for (const [tag, t] of Object.entries(spec)) {
    files[join(DDIC_DIR, `${tableName(tag).toLowerCase()}.tabl.xml`)] = tablXml(tag, t);
  }
  files[YAML_FILE] = serviceYaml(spec);
  return files;
}

function main(args) {
  if (args[0] === "--derive") {
    const folders = args.slice(1).filter((a) => !a.startsWith("--"));
    const at = args.indexOf("--spec");
    const target = at >= 0 ? args[at + 1] : SPEC_FILE;
    const {spec, files} = derive(folders);
    writeFileSync(target, JSON.stringify(spec, null, 1) + "\n");
    console.log(`${target}: ${Object.keys(spec).length} tables from ${files} IWPR files`);
    return 0;
  }
  const files = generated(readSpec());
  if (args.includes("--check")) {
    const stale = Object.entries(files).filter(([f, s]) => !existsSync(f) || readFileSync(f, "utf8") !== s).map(([f]) => f);
    const extra = readdirSync(DDIC_DIR).map((f) => join(DDIC_DIR, f)).filter((f) => !(f in files));
    for (const f of [...stale, ...extra]) {
      console.log(`${f}: ${stale.includes(f) ? "differs from the spec" : "not in the spec"}`);
    }
    console.log(`${Object.keys(files).length} files, ${stale.length + extra.length} out of step`);
    return stale.length + extra.length === 0 ? 0 : 1;
  }
  mkdirSync(DDIC_DIR, {recursive: true});
  for (const [f, s] of Object.entries(files)) {
    writeFileSync(f, s);
  }
  console.log(`${Object.keys(files).length} files written`);
  return 0;
}

if (runsAs("segw-tables.mjs")) {
  process.exit(main(process.argv.slice(2)));
}
