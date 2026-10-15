# The SEGW project tree as our tables

**Date:** 2026-09-12 · **Tools:** `npm run segw:tables` (`tools/segw-tables.mjs`),
`npm run segw:tree` (`tools/segw-tree.mjs`), `npm run segw:cloud`
(`tools/segw-cloud.mjs`) · **Test:** `test/segw-tree.mjs`, `ltcl_tree` in
`test/unit/zcl_stg_segw_test`.

SEGW is an editor over a set of tables: `/IWBEP/I_SBD_*` hold the service
builder design (project, model, service, data sources, mappings, generated
artifacts), `/IWBEP/I_SBO_*` the OData model (entity types, properties,
sets, associations, navigation, function imports, annotations). abapGit
serializes those tables one to one into `<project>.iwpr.xml`, which is what
`tools/segw-gen.mjs` reads and `tools/stg-compile.mjs` writes. "SEGW as an
application" starts with owning those tables: this is that step.

## Where the table definitions come from

We do not have the DDIC of the SAP tables and do not write it from memory.
The IWPR files are the contract: `segw-tables --derive <folder>...` reads
every `*.iwpr.xml` under the folders and records, per table,

- the fields, in the order SEGW writes them (every row is a chain; the
  chains of 21 projects agree without a single contradiction, which is what
  a DDIC field order looks like);
- the longest value seen per field;
- the key: the shortest prefix of the fields that is unique in every file,
  never shorter than PROJECT, NODE_UUID and SYLANGU where the table has
  them. That gives PROJECT + NODE_UUID for design and model tables, SYLANGU
  + PROJECT + NODE_UUID for texts, PROJECT + SYLANGU for the project text,
  PROJECT + NODE_HASH + NODE_UUID for the node map and PROJECT + NODE_UUID +
  DS_ATT_PATH for mapping rules, where NODE_UUID alone repeats.

Sources: the 21 SEGW projects available locally (untracked, `.local/`): the
eight public abapGit repositories of the closure corpus, the SAP sample
projects exported from A4H ([`/IWBEP/GWSAMPLE_BASIC`](https://help.sap.com/docs/ABAP_PLATFORM_NEW/68bf513362174d54b58cddec28794093/59283fc4528f486b83b1a58a4f1063c0.html), `EPM-RFC-SAMPLE`,
`ERROR-LOG-SAMPLE`, `DRAFT-ADMIN-SAMPLE`, `EPM-CDS-SAMPLE`,
`EPM-SADL-TX-SAMPLE`, `SEARCH-ODATA-SAMPLE`, `UCON-HTTP-SAMPLE-PROJECT`) and one project
from the Lars clones. 53 tables, `tools/segw-tables.json`.

The two hand-written fixtures under `test/fixtures/segw/` and stg-compile's
output are not a source: they are written from the spec, not the other way
round.

## What is generated

`segw-tables` without arguments turns the spec into

- `src/segw/ddic/zstg_<table>.tabl.xml`, 53 tables `ZSTG_SBD_*` / `ZSTG_SBO_*`.
  Every field is CHAR of the size class above the longest value seen (1, 4,
  10, 32, 40, 60, 80), LANG for SYLANGU, STRING above 80 (the annotation and
  vocabulary values). Flags, counters, `0001` versions and `20130411152822.077079`
  timestamps come back out of the tables exactly as they went in, which is
  what a byte-identical export needs; typing them would mean inventing the
  SAP domains. One column is ours, `STG_SEQ` (INT4, not key): the row's
  position in the imported file, because SEGW does not write rows in key
  order and the order is part of the file.
- `src/segw/zstg_segw.stg.yaml`: service `ZSTG_SEGW_SRV`, one entity per
  table (`Project`, `EntityType`, `Property`, `EntitySet`, `Association`,
  `NavProperty`, `FunctionImport`, `DataSource`, `MappingProperty`, ...;
  tables segw-gen does not read are named after their table, `SboTm`),
  properties named after the fields (`NodeUuid`, `ParentUuid`, `StgSeq`,
  `Language` for SYLANGU), all creatable / updatable / deletable. SEGW
  builds method names from the first 16 characters of an entity name, so
  the names differ there (`Artifact` and `ArtifactText`, not
  `GeneratedArtifact`).

`stg-compile --all` compiles the YAML into `gen/stg/zstg_segw/` and
`cds2ddic` writes the table source classes `gen/cds/zcl_stg_tab_zstg_sb*`,
so the service is served by the generic CRUD of `zcl_stg_sadl_dpc` without
a line of hand-written ABAP. `segw-tables --check` (and the test) fails when
the tracked files differ from the spec.

## Import and export

`segw-tree import <file.iwpr.xml>` turns every table block into rows of
`ZSTG_<table>` under `data/zstg_<table>.tabu.json` (client 123, `STG_SEQ` =
position); rows the data folder already holds for that project are replaced,
other projects stay. `test/seed.mjs` loads `data/` at start, so the imported
project is served by `ZSTG_SEGW_SRV` in the unit tests and the preview.

`segw-tree export <PROJECT>` writes the rows back in abapGit's form: tables
in alphabetical order (the order abapGit writes them), rows by `STG_SEQ`,
fields in the order of the spec, initial fields left out, XML-escaped as
abapGit does. `segw-tree check <file>...` imports into memory, exports and
compares byte for byte.

**Result:** all 21 SEGW-written IWPR files round trip byte for byte, the
UTF-8 byte order mark aside (abapGit writes one, stg-compile does not; it is
not data). The test runs this over the corpus when `.local/` has it and
skips in CI, like the closure run.

The hand-written fixtures `zstg_mapped.iwpr.xml` and `zstg_mini.iwpr.xml`
were re-sorted to that shape (table blocks alphabetical, fields in the
spec's order) and round trip byte for byte too. `stg-compile` writes the
tree from the same spec: every row's fields in the order
`tools/segw-tables.json` gives, a field the spec does not know refused
at write time, SEGW's label fields in the text tables (`ET_LABEL`,
`ESET_LABEL`, `PROP_LABEL`, `NAVP_LABEL`, `ASSOC_LABEL`, `ASST_LABEL`,
`FI_LABEL`, `FI_PARAM_LABEL`; a `DESCRIPTION` only in `SBD_DST`, `SBD_MDT`,
`SBD_PRT`; the key alone in `SBD_GAT`, `SBD_OPT`, `SBD_SET`, `SBD_SVT`,
`SBO_RCT`), `MODEL_GUID` in `SBO_ASO` / `SBO_AT`. So a compiled YAML
imports and exports byte-identically as well (`test/stg-compile.mjs` checks
the demo; `npm run segw:tree check` any compiled file). Everything segw-gen
reads is unaffected: it parses the file and does not care about order.

## Through the service

`segw-tree push <file.iwpr.xml> [--url http://localhost:3030]` does the
import against a running gateway (`npm start`) in one call: `POST
ImportSet` with the file as `Content`. `zcl_stg_segw_import` (through the
hand-written `zcl_zstg_segw_dpc_ext`, the only ABAP of the service) reads
the `<T><T>row</T></T>` nesting, turns every row into a line of `ZSTG_<T>`
through the generated table source (`ASSIGN COMPONENT` per field, so a
field SEGW never writes is a 400 with `SBO_ET.MADE_UP: not a field of
ZSTG_SBO_ET` and nothing is written), deletes the project's rows in every
`ZSTG_SB*` table and inserts the new ones; the response is `Project`,
`Rows`, `Tables`. The editor sends the file the user picked the same way,
one `$batch` entry. A function import was the first idea, but its
parameters travel in the URL and a 30 KB file does not fit a request line.
`push --rows` is the other route, the generic CRUD only: GET the project's
rows per set, DELETE by key, POST the rows with `StgSeq`.

`pull <PROJECT>` GETs `ExportSet('<PROJECT>')`: `zcl_stg_segw_export`
writes the file in ABAP (tables alphabetical, rows by `STG_SEQ`, fields in
the table's component order, which is the spec's, initial fields left out,
escaped as abapGit does), the mirror of the import, so the editor's Export
button is one GET. `pull --rows` GETs every set with `$filter=Project eq
'...'&$orderby=StgSeq` and writes the IWPR here instead. The round trip goes through the
database, not through JSON files: the test pulls the seeded `ZSTG_MAPPED`
and gets the fixture's bytes, pushes both fixtures through `ImportSet` and
row by row and pulls them back byte for byte, twice (a push replaces, it
does not double). One gateway bug surfaced on the way: a key value with a backslash
(`DS_ATT_PATH`, `IT_TRAVEL_ID_RANGE\HIGH`) reached `__metadata.uri`
unescaped and broke the JSON; `zcl_stg_json` now escapes the URI.

## Deleting a node

`DELETE NodeSet(Project='P',NodeUuid='x')` takes the node with its subtree,
the way SEGW deletes: the rows whose `PARENT_UUID` (`SBD_*`, `SBO_PR`),
`ENTITY_GUID` (`SBO_NP`), `ASSOCIATION_GUID` (`SBO_RC`, `SBO_AT`) or
`FUNCTION_IMPORT` (`SBO_FP`) is the node, their subtrees in turn, and every
row sharing the node's `NODE_UUID` (its text rows, the `SBD_MR` rules of a
mapping property). `zcl_stg_segw_tree` finds the parent columns of every
`ZSTG_SB*` table through RTTI, so a new table joins the cascade by having
one of those columns. `ENTITY_TYPE` of an entity set is a reference, not a
parent: deleting an entity type leaves its sets. The generic `DELETE` on
the table sets stays one row, as the editor's property form expects; the
tree's Delete goes to `NodeSet`. A node nobody has is a 400.

## Generate in ABAP

`GET GenerateSet?$filter=Project eq 'P'` returns the generated classes of a
project as rows (`Name`, `Content`), made by `zcl_stg_segw_gen` from the
`ZSTG_SB*` rows: the same model `tools/segw-gen.mjs` builds from an IWPR
file (entity types with their properties by `SORT_ORDER`, sets, complex
types, associations with constraints and sets, navigation, function
imports; `DEFINE_` stems cut to 23 characters and made unique, `TS_`/`GC_`
to 27) and the same templates, line for line. segw-gen is the oracle: the
test pushes both fixtures, the compiled demo YAML and every corpus project
through `ImportSet` and expects the ABAP MPC to equal segw-gen's byte for
byte (the colleague's rule: same input, same templates, no tolerance).
`npm run segw:tree generate <P> --out <dir>` writes the files. Stage 1 was
the `_MPC`; stage 2 (`zcl_stg_segw_gen_dpc`) the `_DPC` base (the include
banners with the generation stamp, the CRUDQ dispatch per entity set, the
method signatures in the class editor's order, the comm-services block,
SADL delegation and the SADL XML for mapped sets, the local ODC client),
the abapGit XML of both classes with the component texts, and the `_EXT`
pair. Stage 3 (`zcl_stg_segw_gen_rfc`) is "Map to Data Source": the method
of an operation mapped to a function module (one variable per mapped
parameter, inputs from keys, entry data, filter ranges and constants, the
RFC destination, the call local or with DESTINATION, exception handling,
message log, outputs back, read-after-create; commit on writes) and to a
search help (the DDSHSELOPS table, the search-help runtime through
`/IWBEP/IF_SB_GENDPC_SHLP_DATA`, the unpivot of the result list), plus that
interface and its implementation in the class.

The module signatures come from `ZSTG_FM_PARAM`, one row per parameter
(FUNCNAME, PARAM_NAME, KIND I/E/C/T, TYP, OPTIONAL, REMOTE, STG_SEQ; the
parameter's name is `PARAM_NAME` because a system reserves `PARAMETER`, and
the OData property is still `Parameter`): what
SEGW reads from the function library and `tools/segw-gen-mapping.mjs`
from an abapGit `*.fugr.xml`. `POST FunctionGroupSet` with that XML as
`Content` fills it (`zcl_stg_segw_fugr` mirrors `parseFunctionGroup`: the
`<FUNCTIONS><item>` blocks, IMPORT/EXPORT/CHANGING/TABLES, TYP or DBFIELD
or DBSTRUCT), `ModuleParameterSet` reads it. `segw-tree push` posts the
`*.fugr.xml` next to the IWPR first. A module the table does not know, or
a parameter whose type is unknown, leaves the stub segw-gen writes in that
case ("Mapped to X: the function group was not available"). Every
generated file of every project we have equals segw-gen's byte for byte,
the mapped fixture included, and `ZSTG_SEGW` itself (55 SADL sets): its
SADL definition is built in pieces of 200 lines, as segw-gen writes it
since 2990f95, because the transpiler nests an `&` chain one `concat( )`
per operand and a service worker's stack gives out near 800
(abaplint/transpiler#1836 flattens the chain; when it is on npm, both
generators can drop the rule).

## The project as an abapGit repository

`GET RepoFileSet?$filter=Project eq 'P'` gives the whole abapGit repository
of a project as rows (`Name`, `Content`), `GET RepoSet('P')` the same as one
zip in base64 (`Content`, `Files`), and `npm run segw:tree repo <P> --out
<dir> [--zip <file>]` writes it. `zcl_stg_segw_repo` puts together
`.abapgit.xml` (`STARTING_FOLDER /src/`, `FOLDER_LOGIC PREFIX`),
`src/package.devc.xml`, the tree (`ExportSet`), the registration objects
`*.iwsv.xml` and `*.iwmo.xml` (the IWSV/IWMO templates of stg-compile, in
ABAP) and the generated classes with their XML (`GenerateSet`). The test
compiles the demo YAML, imports it and expects the registration objects to
equal stg-compile's byte for byte and the classes segw-gen's.

`segw:tree repo` refuses to write unless a unit of `deploy/manifest.json`
lists every object of the repository and none has an SAP-owned name (the
check `segw:zip` makes, `docs/a4h-deploy.md`); the OData sets are not
checked and are not a route to a system on their own.

That is how a project reaches a system: abapGit pulls the repository and
creates and activates the classes, we write nothing into a live system.
The other route, a class that creates and activates objects through the
Class Builder and a transport, is not built; it would need a system to
develop against and is a decision of its own.

**Free text and truncation.** The size of a column comes from the projects
we have, and a sample can be narrower than the real field: SEGW's project
description is 40 characters in every corpus file, our own demo has 41 and
this service's own YAML 83. So `DESCRIPTION` and `*_LABEL` are STRING
columns, and every other field keeps the derived size. The import no longer
lets a value be cut: `zcl_stg_segw_import` writes each field, reads it back
and refuses the whole import when they differ, with the table, the field
and the length ("SBO_ET.NAME: the value does not fit the column of
ZSTG_SBO_ET (66 characters)"). Before that check a long description came
back shortened from `ExportSet`, silently.

## The Cloud pass

`npm run segw:cloud` runs abaplint over `src/`, the generated table sources
and the generated `ZSTG_SEGW` classes with `syntax.version: Cloud` (ABAP for
Cloud Development) instead of `open-abap`, style rules off, and prints the
issues per rule and file. Informational, exit 0. On 2026-09-12: 155 issues,
133 of them `strict_sql` ("INTO must be last"): the 7.02 form of Open SQL
that the repository's `downport` rule asks for is exactly what Steampunk
does not accept, so a Steampunk build of this code means the strict form in
the sources and the transpiler's own downport. Four `parser_error` are
`DESCRIBE` in the JSON and gateway classes, the rest are unresolved classes
of the narrowed file list, not language findings.

## Next

- The editor is `webapp/segw/` (`docs/segw-editor.md`); what it still
  lacks is listed there.
- Pull the repository of a project into A4H with abapGit and see the
  service run there (needs Alice's go: it is a write to a real system).
- The editor: a "Download repository" button over `RepoSet`.
