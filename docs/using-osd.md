# Using OSD: services, CDS, packs and tiles

OSD is an ABAP application server you run on your own machine. It transpiles
the ABAP in front of it, serves the result as OData v2 and as ICF paths, and
answers ADT so Eclipse can edit it. This is the working guide: how to start
it, how to add a Gateway service by hand or from CDS, how to bring content in
as a pack, how to put any of it on the launchpad, and how to write a method
whose body runs inside the database.

Everything below is measured against the system as it is, not planned.

---

## 1. Starting it

```
npm start                 # transpile, then serve on 3030
npm run dev               # the same, and rebuild + recycle whenever ABAP changes
STG_PORT=3050 npm start   # another port; STG_DB_PATH=.local/db/mine.sqlite keeps its rows apart
```

Open `http://localhost:3030/` and the launchpad answers. Behind it:

| path | what is there |
| --- | --- |
| `/app/flp.html` | the launchpad, every app and demo as a tile |
| `/sap/opu/odata/sap/<SERVICE>/` | the OData v2 services |
| `/sap/bc/adt/…` | the ADT façade, which is what Eclipse talks to |
| `/sap/bc/<node>` | whatever the ICF nodes in the content serve |

Useful while working:

```
npm run builds            # the generations built so far, live marked
npm run ps                # which runtimes are up, on what port and database
npm run transpile         # build a generation without serving
npm run rebuild           # build it again even if the inputs did not change
```

Every answer carries `X-OSD-Generation`, and `/sap/bc/adt/core/http/build`
reports three names — the source on disk, the generation built from it, and
the one actually serving — plus whether they agree. When they do not, the
build or the recycle is the thing to look at.

---

## 2. A Gateway service of your own

There are three ways in, and they end in the same place: a service the
dispatcher serves and Eclipse can see.

### From a YAML file, which is SEGW without the GUI

One file describes the project, the service, the entities and what they read.
`src/demo/zstg_demo.stg.yaml` is the worked example; the shape is:

```yaml
project: ZMY_PROJECT
service: ZMY_SRV
model: ZMY_MDL
description: "what this service is"

entities:
  Item:
    set: ItemSet
    keys: [ItemId]
    table: ZMY_ITEM              # or cds: ZC_MY_VIEW, or nothing and write the DPC
    properties:
      ItemId: {type: String(8), field: ITEM_ID, label: Item}
      Name:   {type: String(40), label: Name}
```

Compile it:

```
npm run stg:compile -- src/my/zmy_srv.stg.yaml --out .local/try   # to look; the build itself writes gen/stg/<project>/
```

That writes the SEGW project tree (the IWPR), the registration objects (IWSV
and IWMO) and the `_MPC` / `_DPC` classes SEGW would have generated, plus the
`_EXT` pair if it is not there yet. The `_EXT` classes are yours: that is
where hand-written `GET_ENTITYSET` goes.

A YAML under `src/` is compiled by every build, so in practice you write the
file and run `npm run transpile`. If `src/` already holds an object the YAML
would generate, yours wins and the generated copy is removed.

What a source can be, per entity: nothing (you write the DPC), `struct:`,
`table:` or `cds:` (served generically, no DPC needed), or `service:` plus
`set:` to read another service of the same system. Per operation you can map
`function:` (an RFC-style function module) or `searchhelp:`. Annotations for
Fiori Elements — line items, selection fields, facets, value helps — go under
`annotations:` and become an `ZCL_<project>_MPC_ANN` class, so the app needs
no local annotation file.

### From the SEGW editor, in the browser

`http://localhost:3030/app/segw/` is SEGW as an application: the project tree
in SEGW's own shape, every node edited in place, Create and Delete, Import of
an `.iwpr.xml`, Export back out, and Generate, which shows the classes the
project generates. To take them further, export the project as an abapGit
repository (`RepoSet`, or `npm run segw:tree repo <P> --out <dir>`).

### From an existing project

```
npm run segw:tree import <project>.iwpr.xml     # into the tables OSD serves
npm run segw:tree export ZMY_PROJECT            # byte-identical back out
npm run segw:gen -- <folder> --check            # what would be generated, vs what is there
```

---

## 3. OData out of CDS

Write the view under `src/cds/` (or inside a pack) as `*.ddls.asddls`, with
its abapGit companion `*.ddls.xml`, and mark it:

```abap
@AbapCatalog.sqlViewName: 'ZVMYVIEW'
@AccessControl.authorizationCheck: #NOT_REQUIRED
@EndUserText.label: 'My view'
@OData.publish: true
define view ZC_MY_VIEW as select from zmy_item {
  key item_id as ItemId,
      name    as Name
}
```

Then build. `npm run cds` (part of `npm run transpile`) turns every view into
a DDIC view under its SQL view name **and** under the CDS name, a source
class, and the registry; `@OData.publish: true` additionally writes
`gen/cds/<view>_cds.stg.yaml`, which the same build compiles into a service.
The service is then `<VIEW>_CDS` (`ZC_MY_VIEW_CDS` for `ZC_MY_VIEW`), its
one entity set `<View>Set` in the view's casing (`Zc_My_ViewSet`), and its
properties are the view's field names as the database has them, upper
case (`ITEMID`, not `ItemId`). The `.ddls.asddls` needs its abapGit
companion beside it, a `.ddls.xml` naming the view; copy one from
`src/cds/` and change the name.

Three things worth knowing:

- **A projection of one table can be written**, not only read: put
  `@ObjectModel.writeEnabled: true` on it and POST, PUT and DELETE work. A
  write the model does not allow answers 405 rather than failing oddly.
- **Analytics**: `@Analytics.dataCategory: #CUBE` with
  `@Aggregation.default: #SUM` makes `$select` become `GROUP BY`, which is
  what the Analytical List Page in `webapp/analytics/` uses.
- **A virtual element** (`@ObjectModel.virtualElement` with
  `virtualElementCalculatedBy: 'ABAP:ZCL_X'`) is a field an ABAP class fills
  after the read.

For a plain table with no view at all there is nothing to write: every TABL in
the content gets a generic read/insert/update/delete class, so `table:` in a
YAML is enough.

---

## 4. Packs: bringing content in without touching this repository

A pack is a **directory**, and adding one is not a rebuild of anything but the
generation. It looks like this:

```
packs/my-pack/
  osd-pack.json
  src/                  ABAP, abapGit-named   (the pack's layer)
  src/ddic/             the tables its rows belong to
  data/                 *.tabu.json seed rows
  webapp/               static files, served at /app/my-pack/
```

`osd-pack.json`, all fields optional except by convention:

```json
{
  "name": "my-pack",
  "description": "what this pack is",
  "order": 100,
  "abap": ["src"],
  "tiles": [
    {
      "title": "My pack",
      "subtitle": "what it does",
      "info": "$MY_PACK",
      "icon": "sap-icon://palette",
      "url": "/app/my-pack/index.html"
    }
  ]
}
```

A pack or workspace layer can require a minimum system version with
`"osd": ">=0.6.1650"` in `osd-pack.json`. Only `>=x.y.z` is supported;
omitting `osd` means no requirement. Versions compare numerically, and an
invalid requirement refuses the build. The check runs before generation or
transpilation, including cached and warm builds.

Packaged systems carry `osd-version.json`, stamped with the extension version;
seeded binaries use the same version rule. A source checkout without that
marker, including a checkout-mode binary, skips the comparison and logs a
debug line. A mismatch leaves the live generation untouched and tells you to
update the extension or binary. In desktop VS Code, the error notification
shows the diagnostic verbatim; **Update** opens the installed extension's
entry in the Extensions view.

Explicit `--layer` and `OSD_LAYERS` inputs can name the manifest directory or
its declared ABAP folder, including a nested path such as `"abap": "abap/src"`.

Where packs are found: `packs/` beside the tree, and every directory
`OSD_PACKS` names (a pack itself, or a folder full of them, colon-separated).

```
OSD_PACKS=/somewhere/packs npm start
node tools/osd-packs.mjs            # what is found, in layer order
```

What a pack brings, and where it lands:

| in the pack | in the system |
| --- | --- |
| `src/**.abap`, `*.xml` | objects of the system, in a package named after the pack (`$MY_PACK`), editable from Eclipse |
| `src/ddic/*.tabl.xml` | tables of the database |
| `data/*.tabu.json` | rows, seeded at start |
| `*.sicf.xml` | an ICF node, served at its path |
| `*.sapc.xml` | a push channel, mounted at its path |
| `*.ddls.asddls`, `*.stg.yaml` | CDS and services, generated like the tree's own |
| `webapp/` | static files at `/app/<name>/` |
| `tiles` | tiles on the launchpad |
| `sources` | folders fetched from a repository at a commit, layered under the pack's own (below) |

**Layer order.** The `input_folder` list of `abap_transpile.json` is the
tree's own content; packs come after it, sorted by `order` then name. The
**later layer wins** a name it shares, and the build says so with both files
named. The same file name twice inside one folder is refused rather than
guessed. `node tools/osd-inputs.mjs` prints overrides, duplicates, and folders
that look like inputs and are not.

**Adding a pack is a new generation**, because the generation is the hash of
everything that went into it. That is the point: the system you were serving
and the system with the pack in it have different names, and the switch is
deliberate. A pack that adds generated objects (CDS, a YAML service) settles
on the second build, because the generators write into `gen/`, which is
itself an input; `npm run dev` does that second build by itself.

**Activating.** Editing ABAP in a pack is editing ABAP: with `npm run dev`
running, a save is checked, built and recycled, and the generation on the next
answer is a new one. From Eclipse, activate as usual — the pack's objects are
writable, the store finds them where the pack is. A check that fails leaves
the live generation untouched, so a broken save never takes the system down.

**Removing** a pack is deleting the directory (or unsetting `OSD_PACKS`) and
building again; a service the pack declared as YAML disappears from
`gen/stg/` with it.

**Picking up a build.** `npm run transpile` switches the tree's live
generation; a server started with `npm start` keeps serving the one it
started with (`/sap/bc/adt/core/http/build` shows `live` and `serving`
side by side, and `synchronized: false` when they differ). `npm run dev`
rebuilds and recycles by itself on every save; under `npm start`, stop
the server and start it again, or activate from Eclipse, which recycles.

**The files a pack needs, and where to copy a shape from.** A table is a
`*.tabl.xml` (abapGit, `src/ddic/zstg_status.tabl.xml` is a small one);
seed rows are `data/<table>.tabu.json`, a JSON array of rows with the
field names upper case (`data/zstg_status.tabu.json`); a hand-written
`_DPC_EXT` redefines `<set>_get_entityset` and needs no `.clas.xml`; the
YAML makes the rest. A pack's `_EXT` pair is generated into `gen/stg/`
and hidden by the pack's own when both exist, and the build says so
(`overridden: CLAS ZCL_X_DPC_EXT: gen/stg/... hidden by packs/...`).

**A pack that fetches instead of carrying.** A repository you do not own, or
one you do not want copied into this tree, is named in the manifest and
fetched into the pack:

```json
{
  "name": "zork",
  "abap": ["upstream", "src"],
  "sources": [
    {
      "folder": "upstream",
      "repo": "https://github.com/oisee/zork-abap",
      "ref": "0c8d96b908f88fc3207e7f9a00bc43f724b32b6f",
      "path": "src/zork_00",
      "exclude": ["\\.clas\\.testclasses\\.abap$", "^zcl_ork_00_game_loader_file\\."]
    }
  ]
}
```

`node tools/osd-fetch.mjs` (or `osd fetch`, `npm run packs:fetch`) copies
`/src/zork_00` of that repository at that commit into `packs/zork/upstream/`,
minus the files `exclude` matches (regular expressions over the path inside
the repository folder: a test class, a program that needs the GUI). The
pack's own `src/` comes **after** it in `abap`, so the few files a
repository needs changed to run here are the overlay and nothing else, and
`git status` of the pack shows exactly what was changed against upstream.

For building and publishing layers and ordered systems, see
[OCI layers and systems](oci-layers.md).

An OCI registry can supply the same folder by manifest digest:

```json
{"folder": "upstream", "oci": "registry.example.invalid/osd/pack@sha256:<64 hex>", "path": "src", "exclude": []}
```

`oci` cannot be combined with `repo`, `lock` or `ref`. Tags are refused;
pin `host/repository@sha256:<64 hex>`. `path` defaults to `src` and `exclude`
to `[]`, with the same relative-path regular expressions as git sources.
The payload is an abapGit offline ZIP layer with media type
`application/vnd.osd.abapgit.zip`. A bare `oras push` artifact is also accepted
when its single layer has an `org.opencontainers.image.title` ending in `.zip`,
regardless of that layer's media type. Other layer layouts are refused.

The tree digest is `sha256:` plus the SHA-256 of concatenated
`<content sha256 hex>  <archive relative path>\n` lines for every file in the
archive, sorted by UTF-8 byte order, before `path` selection or exclusions.
Content is hashed as raw bytes: CRLF and BOMs are preserved, without
normalisation. A config `treeDigest` must match. Blob digests and ZIP safety
are checked before the fetched folder is replaced; failure preserves the
previous folder. Blobs are cached under `.local/oci`, with their digest and
length checked on reuse. Manifest and config reads are capped at 4 MiB;
blob reads are capped at their descriptor size. Config identity is verified
before interpreting `treeDigest`; only the exact OCI empty descriptor is skipped.

Token realms must use HTTPS, except for a registry on localhost or 127.0.0.1.
A realm may have a different host (for example Docker Hub's auth service).
`GITHUB_TOKEN` is used only for `ghcr.io`. To use `OSD_OCI_USER` and
`OSD_OCI_TOKEN`, set `OSD_OCI_REGISTRY` to the exact registry host (including
its port, if any); these credentials are never used for other registries.

Git and OCI fetches stage a complete replacement with its identity in
`.osd-source.json` inside the folder, then publish with one rename. There is
no pack lock. An existing folder is renamed to a unique ignored
`.osd-fetch-old-*` name first; cleanup after publication is best effort.
A crash may leave a missing folder, but never new bytes with an old identity.

Readiness reads the folder's `.osd-source.json`: git compares `repo`,
`ref`, `path`, `exclude`; OCI compares `oci`, `path`, `exclude`.
Legacy fetched folders without this file are missing and the next
`osd-fetch` refetches them. The pack-level `.osd-fetched.json` is only an
informational summary, written best effort. CI artifacts carry both files.
The identity file is metadata, excluded from content scans and generation
hashes; its timestamp does not change the generation.

The fetched folder is not tracked (`packs/*/upstream/` is ignored).
A second run at the same identity needs no write access; `--force` fetches
again. Pin `ref` to a commit: a
generation is the hash of its inputs, and an input that moves under a branch
name is a generation that changes with nobody changing anything. **A build
refuses a pack whose declared source is not fetched**, naming the
repository, rather than building a smaller system that looks complete.
This is how the demo and Zork reach the public preview on GitHub Pages:
`packs/o4d` and `packs/zork` in this repository are two manifests and an
overlay, and the workflow fetches the rest.

---

## 5. Tiles on the launchpad

Two ways, depending on whose the tile is.

**A pack's own tile** goes in its `osd-pack.json`, as above. The launchpad
asks the server for `./packs.json` when it starts and adds a "Content packs"
group from the answer, so no file in this repository needs to know the pack
exists. `url` may be anything this system serves: the pack's own page, an ICF
path an ABAP class writes, a UI5 app.

**A built-in tile** — one of this repository's own apps — is declared in
`webapp/flp.html`, in two places that belong together:

```js
// the tile, in window["stg-launchpad-groups"]
{
  id: "myapp",
  tileType: "sap.ushell.ui.tile.StaticTile",
  properties: {
    title: "My app", subtitle: "what it is", info: "ZMY_SRV",
    icon: "sap-icon://table-view", targetURL: "#MyApp-manage"
  }
}

// what that intent resolves to, in applications
"MyApp-manage": {
  title: "My app",
  additionalInformation: "SAPUI5.Component=stg.myapp",   // a UI5 component
  applicationType: "SAPUI5",
  url: "./myapp/"
}
```

For a page that is not UI5 — anything an ABAP class writes — leave
`additionalInformation` out and give it `applicationType: "URL"` with
`navigationMode: "embedded"`. That is how the ZO4D demo and Zork are on the
launchpad: a tile is a launchpad's way of pointing at a service, and what is
behind it does not have to be UI5 to belong there.

---

## 6. Running it somewhere else

```
bun scripts/build-binary.mjs          # build/osd, one file, runtime inside
bun scripts/make-release.mjs          # a directory to copy anywhere
```

The release directory carries the binary, a Node single executable, a bundle
with a private Node, the content, the packs, one prebuilt generation and a
`run.sh` that picks a host. On the far machine:

```
./run.sh          # the Bun binary — needs nothing installed
./run.sh sea      # a Node single executable
./run.sh node     # the bundle on the private Node
```

Then open `http://<that machine>:3030/`. Measured on a second machine with
Node 18 and no Bun: all three serve the same generation, and the demo's frame
stream is byte-identical to the one recorded here.

---

## 7. A method whose body runs in the database

Most of what you write here is ABAP that the transpiler turns into
JavaScript. An **AMDP** method is the exception: its body is SQLScript, the
database's own language, so there is nothing to transpile. It runs in HANA
instead, and the caller cannot tell.

You need a HANA for it. HANA Express in docker is enough:

```
docker pull saplabs/hanaexpress:latest
bash ~/hxe/run.sh                 # a few minutes to come up; the tenant is on 39041
```

Then write the method as you would on a system — `src/amdp/zcl_osd_amdp_demo`
is the worked example:

```abap
    CLASS-METHODS squares
      IMPORTING VALUE(iv_count)  TYPE i
      EXPORTING VALUE(et_square) TYPE tt_square.
...
  METHOD squares BY DATABASE PROCEDURE FOR HDB
                 LANGUAGE SQLSCRIPT
                 OPTIONS READ-ONLY.
    DECLARE lv_i INTEGER;
    et_square = SELECT 0 AS id, '' AS label, 0 AS square FROM DUMMY WHERE 1 = 0;
    ...
  ENDMETHOD.
```

and call it like any other method:

```abap
zcl_osd_amdp_demo=>squares( EXPORTING iv_count = 4 IMPORTING et_square = lt ).
```

Run it with the database set to HANA:

```
STG_DB=hana npm run unit:hana         # the ABAP unit suite
STG_DB=hana STG_AMDP_TRACE=1 node output/index.mjs    # and watch the deploy and the call
```

Three things worth knowing before you write one.

**Without HANA the call fails, and that is on purpose.** There is nowhere else
to run an AMDP body, and a test that wants to work on SQLite too should ask
`IF sy-dbsys <> 'HDB'. RETURN. ENDIF.` rather than expect a silent empty
result.

**A body that reads a table needs that table in HANA.** The worked example
computes from `DUMMY` and reads nothing, which is why it runs against an empty
schema. If yours selects from a table, run the whole tree on HANA
(`STG_DB=hana`) so the table is already there — that is what the mode is for.

**`STG_DB=hana` is a mode, not a default.** Measured: a 200-row `SELECT` costs
3.8x what it costs in-process, a single-row one 52x, an `INSERT` 146x. Set-wise
ABAP barely notices; row-at-a-time ABAP does. Develop on SQLite, switch when
the work is AMDP.

### A CDS table function

The other shape, and its result is queryable like a view:

```
define table function ZTF_OSD_SQUARES
  with parameters p_count : abap.int4
  returns { id : abap.int4; label : abap.char(40); square : abap.int4; }
  implemented by method zcl_osd_amdp_demo=>squares_tf;
```

with `METHOD squares_tf BY DATABASE FUNCTION FOR HDB ... RETURNING VALUE(rt)`.
The `returns` list is the authority: if the method's row type disagrees by a
name, an order or a width, **the build fails and names the field**. It has to,
because a table function fills its columns by position and a silent mismatch
gives rows that look right.

The rest, including what is not solved yet, is
[`docs/amdp-in-hana.md`](amdp-in-hana.md).

---

## 8. Taking it to a real SAP system

Everything above runs here. This step puts the same objects on a system
that has never seen this repository, as an abapGit offline repository — a
zip somebody imports. The full account, with every constant that a real
system checks and this runtime does not, is
[`a4h-deploy.md`](a4h-deploy.md); this is the recipe.

### The service

```bash
npm run segw:zip -- src/demo/zstg_demo.stg.yaml --out /tmp/zstg_demo.zip --data data
```

In abapGit on the system: **New Offline Repository** → pick a package →
*Import zip* → *Pull zip*. The zip names no package, so nothing in it
decides where it lands.

Only what the deploy unit `demo` in `deploy/manifest.json` lists goes in,
and never an SAP-owned name (`CL_`, `IF_`, `CX_`, a foreign `/namespace/`,
the standard DDIC); anything else refuses the build and is named
([`a4h-deploy.md`](a4h-deploy.md#what-may-leave-for-a-system)).
It prints what it carried, **by object and not by file**, and names what it
did not carry and why — a `.tabu.json` with no `.conf.json` beside it, a row
written for a client other than the file's own (abapGit deserializes into
the logon client, so such a row would arrive as *this* client's).

### Give each attempt its own name

A failed import leaves registry rows behind, and the next import with the
same names dumps on them (`DBSQL_DUPLICATE_KEY_ERROR` in
`/IWBEP/I_MGW_SRG`). So rename per attempt:

```bash
node tools/osd-rename.mjs --from ZSTG_ --to ZOSD_004_ --out <dir> src/demo
```

It renames whole identifiers only, and re-pads the two versioned file names
— an IWSV is the object padded to 35 plus `0001`, an IWMO padded to 32, and
a prefix that is four characters longer silently breaks both.

### The Fiori application

A UI5 app on a system is a BSP application **plus an ICF node**. abapGit
creates the first and not the second, so both are generated:

```bash
node tools/osd-bsp-app.mjs webapp --name ZOSD_008_APP --out <dir> \
     --service ZOSD_006_DEMO_SRV
npm run segw:zip -- <dir> --unit demo-app --out /tmp/app.zip
```

The name is at most **15 characters** — it becomes the ICF node name — and
the tool refuses a longer one rather than letting the system answer
`WAPA - error from create_new: 4`. `--service` rewrites the one line in
`manifest.json` that names the data source, in the written copy and not in
the tree.

After the import the system answers on
`/sap/bc/ui5_ui5/sap/<app>/index.html`. If that is a 404 saying *ICF Node
NOT found*, the node did not arrive; a 403 *Service cannot be reached* means
it arrived inactive.

### A page here, reading a service there

The other direction. Two things are named apart, the way SM59 names them: a
**destination** is a system, and a **binding** says which of this system's
paths that one answers. Both live in `.local/destinations.json` (gitignored
— a host name and a logon are not repository content;
[`destinations.example.json`](destinations.example.json) is the shape):

```json
{
  "destinations": {
    "A4H": { "type": "http", "url": "http://…", "user": "…", "password": "…", "client": "001" }
  },
  "services": { "ZOSD_006_DEMO_SRV": "A4H" }
}
```

RFC destinations live in the same file with `"type": "rfc"`, keeping their
own `mode` (`local`, `live`, `replay`, `record`, `fallback`) — that is *how
to satisfy a call* and not a transport, which is why it is not called `type`.
The older `.local/rfc-destinations.json` and `.local/gateway-destinations.json`
are still read when this file is absent, and the tool says which it read.

and OSD answers that service on **its own origin**, so a page it serves
reads it with no CORS and no logon prompt. A local service of the same name
always wins. The CSRF token and its session cookie are carried together,
which is what a modifying `$batch` needs; without the pair a Create answers
`/IWFND/CM_MGW/098`.

`packs/travels-a4h` is such a page: the demo app, one line different,
reading a service on another system.

## 9. When something is wrong

```
npm run ps                                   # what is running
curl localhost:3030/sap/bc/adt/core/http/build   # source / live / serving, and whether they agree
node tools/osd-inputs.mjs                    # layers, overrides, shadows
node tools/osd-packs.mjs                     # packs, in order
node tools/osd-transpiler.mjs                # which transpiler and runtime are in use
curl localhost:<child port>/osd/dumps        # the last runtime errors, each naming its ABAP statement
```

A request that dies in ABAP answers with the statement that raised it and the
ABAP frames under it, because the transpile carries source maps. A build
that fails prints `osd-build: FAILED: <check>, <message>, <file>:<line>`
among the generators' own lines; the file is named without its folder, and
a missing period is reported as the *next* statement not existing in
"the configured ABAP version" — look one statement up. `npm run dev`
prints what it rebuilt and why it refused when a check failed.

See also: [`generations.md`](generations.md) for what a generation is and how
the dev loop decides, [`backlog/README.md`](backlog/README.md) for what is not done, and
[`bun-spike.md`](bun-spike.md) for the packaging measurements.

### Run an abapGit ZIP or folder

```sh
osd up --layer /path/to/repository.zip
# From a source checkout:
node bin/osd.mjs up --layer /path/to/repository.zip
# The existing environment form accepts folders and ZIPs too:
OSD_LAYERS=/path/to/repository.zip node bin/osd.mjs up
```

Repeat `--layer` to add layers in order; later objects win. Quote paths containing
spaces. `OSD_LAYERS` is separated by the platform path delimiter (`:` on Unix,
`;` on Windows). A repository folder uses its `.abapgit.xml` starting folder,
FULL/PREFIX layout and package headers. A ZIP must contain `.abapgit.xml` at
its root and uses the same rules without modifying the archive.

The instance verifies paths, entry types, CRCs and sizes before extracting to
`build/source-layers/<SHA-256 of ZIP bytes>`. This source is immutable. Edits
through STORE or ADT copy the complete object to `local/overlays/<SHA-256>`;
new objects in its packages also land there. Active source remains available
from the generation snapshots. Reusing the ZIP reuses its cache and overlay;
replacing its bytes starts a new cache and clean overlay. Prior revisions remain
on disk. Startup warns about edited older revisions of the same root package;
`osd doctor` lists orphaned overlays with recovery instructions. No edits carry
over automatically. With other inputs fixed, any byte change produces a new generation.

abapGit usually omits the root package name. A single custom prefix derives the
local package (`ZCL_DEMO_*` → `$ZDEMO`); set `OSD_LAYER_PACKAGE` for an ambiguous
archive. Explicit package names in DEVC metadata take precedence. See
[Source layers](source-layers.md) for the implemented policy and supported ZIP
formats. The input archive is never rewritten or copied into project source.
