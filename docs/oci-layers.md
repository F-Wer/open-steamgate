# OCI layers and systems

`tools/osd-layer.mjs` builds reproducible abapGit repositories, publishes them
through the OCI Distribution API, and groups layers into an ordered system.
No external registry client is needed.

```sh
node tools/osd-layer.mjs build ./src/example --name example --kind input --out /tmp/example-layer
node tools/osd-layer.mjs push ghcr.io/owner/osd/example:v1 ./src/example --name example --kind input
node tools/osd-layer.mjs system push ghcr.io/owner/osd/system:v1 ghcr.io/owner/osd/example@sha256:<64-hex>
node tools/osd-layer.mjs inspect ghcr.io/owner/osd/system@sha256:<64-hex>
```

Build prints the tree and manifest digests. Push commands print a digest
reference suitable for pinning; inspect accepts a tag for discovery as well
as a digest. System inputs must be digest references. Earlier layers are lower;
later layers overlay them. Publishing does not install or transpile a system.

## Layer format

A layer is an OCI image manifest v1.1, with `schemaVersion: 2`, media type
`application/vnd.oci.image.manifest.v1+json` and artifact type
`application/vnd.osd.layer.v1`. Its config has media type
`application/vnd.osd.layer.config.v1+json` and this JSON shape:

```json
{"schema":1,"name":"example","kind":"input","treeDigest":"sha256:<64-hex>","source":{"repo":"https://github.com/owner/repo","commit":"<commit>","path":"src"}}
```

`kind` is one of `lib`, `input`, `pack`, `customer`. The optional `source`
is supplied by `--source <repo>@<commit>:<path>`. The manifest annotations
are `org.osd.layer.name`, `org.osd.layer.kind` and, when source is known,
`org.opencontainers.image.source` (the repository).

There is exactly one layer blob, media type `application/vnd.osd.abapgit.zip`,
with `org.opencontainers.image.title` equal to `<name>.zip`. Config and blob
descriptors contain the SHA-256 digest and byte size of their exact bytes.

The ZIP is an abapGit offline repository. When the folder contains a root
`.abapgit.xml`, its files retain their relative paths, including its
STARTING_FOLDER layout. Otherwise input/customer files are placed under
`src/`, while lib/pack files keep their paths; the builder generates
`.abapgit.xml` with STARTING_FOLDER `/src/`. Symlinks and
other nonregular entries are refused, as is `.osd-source.json` at any depth;
build from the original source tree rather than a fetched tree's identity file.
The builder skips `.git` (directories and files) and `node_modules` at any
depth and logs each exclusion. Copied layers containing them are refused.

Files are sorted by UTF-8 path bytes, stored without compression (method 0),
and encoded with UTF-8 flags, fixed version fields, no extra fields and the fixed ZIP date
1980-01-01. No current timestamps appear in the config, manifest or index.
The shared ZIP encoder also serves `osd-abapgit-zip`'s in-process path, which
retains its existing compression level. Rebuilding the same inputs produces
identical ZIP, config and manifest bytes across Node and Bun: the digest is
runtime-independent because entries are stored. abapGit's `cl_abap_zip` reads
method 0. Before republishing a layer, the tool extracts and re-encodes its
ZIP and requires byte equality (`NOT_CANONICAL` otherwise), rejecting comments,
extra fields, compression and differing entry order. It also verifies treeDigest.
So a system holds only layers built by `osd-layer`: `osd-fetch` accepts a
foreign zip (a plain `oras push`, an abapGit export) as a pack source, but to
join a system it is unpacked and rebuilt with `osd-layer build`, which gives it
a new digest.

The leak gate before every push scans each file's content under a neutral
name, the archive paths, the config, the annotations and the destination
reference, and refuses a capture file (`*.pcap`, `*.pcapng`, `*.jsonl`) and any
file larger than the scanner reads. The repository's `.leak-allow.json` does
not apply to a published layer: a folder whose content is only allowed in this
repository (`packs/lsd`, `packs/zvdb`'s vectors) cannot be published as is.
A layer brings its own exceptions instead: `osd-layer push … --leak-allow
<file>` and `osd-layer system push … --leak-allow <file>` take a file in the
format of `.leak-allow.json` whose `file` is the path inside the layer archive.
Every entry needs a reason, applies to that archive path and value only, and an
entry naming a path the layer does not have is refused rather than ignored. An
entry may add `layer` (the layer's name) to apply to that layer of a system
only. The flag repeats, and the metadata documents are never covered, whatever
an archive file is called. The file belongs in the layer's own repository,
where it is reviewed; abapiti's rules layers use it for a GUID and a hex ID
that are literals of abaplint's own public tests.

`treeDigest` uses `tools/osd-oci.mjs`'s shared helper: SHA-256 of concatenated
`<content sha256 hex>  <archive relative path>\n` lines, sorted by UTF-8 path
bytes, over exactly every file in the ZIP, including `.abapgit.xml`. Content
is hashed as raw bytes, preserving BOM and line endings. `osd-fetch` verifies
this before selecting `path` (default `src`) and applying exclusions:

```json
{"sources":[{"folder":"upstream","oci":"ghcr.io/owner/osd/example@sha256:<64-hex>","path":"src","exclude":[]}]}
```

A layer whose STARTING_FOLDER is not `/src/` needs an explicit `path` in the
pack source, for example `"path":"objects"` for STARTING_FOLDER `/objects/`.

## System format

A system is an OCI image index with `schemaVersion: 2`, media type
`application/vnd.oci.image.index.v1+json` and artifact type
`application/vnd.osd.system.v1`. `manifests` holds layer manifest descriptors
in layer order, each with `org.osd.layer.name`, `org.osd.layer.kind`, and
`org.osd.layer.order` annotations. Orders are decimal strings `"0"`, `"1"`,
… without gaps or duplicates. Resolvers verify these annotations and sort by
them; array position alone does not establish order. Inspect checks the index
identity against each layer config and verifies each layer's tree digest.

Index annotations include `org.osd.osg.commit` from `git rev-parse HEAD` of the
tool's OSG checkout (resolved relative to the module), omitted when it has no
Git metadata. `org.osd.transpiler` is `repo@ref` from `libs.lock.json` under
`OSD_ROOT` or the working directory, omitted when no transpiler is recorded.
There is no created timestamp.

All referenced manifests and blobs live in the index's repository. Descriptors
carry no repository. For layers from other repositories on the same registry,
publishing first tries `POST /v2/<repo>/blobs/uploads/?mount=<digest>&from=<other>`.
If a mount is unavailable it uploads the verified bytes; layers from other
registries also use verified downloads and uploads. The layer manifest is PUT
by digest into the destination repository before the index is published.
Existing blobs are skipped after HEAD. Uploads use POST followed by monolithic
PUT to the returned Location, preserving its query and adding `digest`.
Upload locations must have the same origin as the registry.

## Authentication and publication gate

Push uses `repository:<repo>:pull,push` token scope, with the same credential
rules as pull: `OSD_OCI_USER` and `OSD_OCI_TOKEN` apply only to the exact host
in `OSD_OCI_REGISTRY`; `GITHUB_TOKEN` applies only to `ghcr.io`. Token realms
must be HTTPS except for local test registries. JSON reads are capped at 4 MiB;
blob reads are bounded by their descriptor size and verified by digest.

Before any registry write, the layer CLI runs `tools/osd-leak-scan.mjs --paths`
over every published file's content under neutral `content/000001.txt` names,
a `paths.txt` listing archive paths, and `meta.json` with config, manifest/index
annotations and destination references (repository and tag). Original OCI JSON
bytes also pass through the neutral content scan before publication. Files and
metadata exceeding the scanner's 8 MiB size limit are refused rather than skipped.
A system scans every downloaded layer and the index before copying anything.
Scanner exit 1 refuses publication with `LEAK` and redacted findings (CLI exit 2).
Scanner exit 2, including a missing identifier list, or a spawn failure refuses
with `SCAN_FAILED` and its reason. The scanner finds `.local/leak-identifiers.json`
or the path in `OSD_LEAK_IDENTIFIERS` using its normal lookup rules. Findings are
redacted. The gate does not change or weaken scanner rules.

`.github/workflows/oci-layers.yml` is manual only. It publishes two smoke
layers and a system to GHCR, inspects the system and fetches a pinned layer
through an OSD pack. It needs the `OSD_LEAK_IDENTIFIERS` Actions secret and
package write permission; it fails closed when the secret is absent.

## Install one complete system (E.10 step 3)

```sh
node tools/osd-fetch.mjs --system ghcr.io/owner/osd/system@sha256:<64-hex>
npm run transpile
```

The reference must be pinned by digest, without a tag. Alternatively pass a
local system index JSON, or an OCI layout's `index.json` containing one
system-index descriptor. The layout wrapper is followed one level, verifying
the descriptor's digest and size. Layer manifests, configs and ZIPs must be
present under `blobs/sha256/<hex>` beside the supplied file. The system index's
exact bytes are hashed to obtain its identity; every referenced blob is checked against
its descriptor's digest and size. Registry indexes are verified against the
requested digest. Both forms verify contiguous orders, layer identities,
canonical ZIPs and tree digests before installation.

The installer extracts into a sibling staging directory, writes every layer's
`.osd-layer.json` and the system's `.osd-system.json` there, then renames the
complete directory to `.local/system/`. An existing installation is moved
aside only after validation; a failed final rename restores it. Validation
failures leave the previous installation untouched. The system identity holds
`digest`, toolchain `annotations`, and `layers`, each with `order`, `name`,
`kind`, manifest `digest`, `treeDigest` and a system-relative `path`.

`tools/osd-system.mjs` supplies the shared `activeSystem(root, env)` resolver:

- `lib` layers live in `libs/<name>/`. The name is the library's
  `libs.lock.json` folder. Libraries retain repository paths even when they
  have no `.abapgit.xml` (one is generated without wrapping the tree). They
  remain transpiler dependencies with the configured `files` and
  `exclude_filter` selection rules. Installed layer identity replaces the
  Git checkout gate; a missing configured library is an error naming it.
- `input` and `customer` layers live in `inputs/<name>/`; their abapGit
  STARTING_FOLDER supplies the input folder. Inputs, packs and customers
  follow index order, with `gen/` appended last. Put customer layers after
  the tree's own inputs. Later objects win and override reports name both
  paths. The checkout's own `src/` and `test/` are ignored in system mode.
- `pack` layers live in `packs/<name>/`; only these packs are discovered.
  Their index order supplies ABAP, whole-table TABU seed precedence, DDIC,
  tiles and webapps, regardless of the manifests' development `order` values.
  Pack names must be lowercase, matching pack discovery.
  Pack files retain their paths at the ZIP root. A missing `.abapgit.xml`
  is generated with STARTING_FOLDER `/src/`; a web-only pack needs no src.

The proof includes `test/` as an input layer named `test`: its ABAP Unit
objects are part of today's transpiled system. Generator inputs exclude
this layer, just as they exclude the development tree's incomplete fixtures.
`gen/` is always regenerated and never published as a layer. The `src` input
can be built from a staged repository root containing `.abapgit.xml`, `src/`,
`data/` and `webapp/`, so the tree's seed captures and static pages also belong
to the digest. Only the input layer named `src` supplies these root `data/`
and `webapp/` directories. Other input layers and customer layers contribute
ABAP from their STARTING_FOLDER; their repository-root `data/` and `webapp/`
are not consumed. Use a pack layer for additional seed data and pages.
Logical source paths preserve configuration exclusions and
source maps after installation. The SEGW schema now lives at
`tools/segw-tables.json`, as part of the toolchain rather than an ABAP input.

For a pack with fetched sources, fetch first, stage a copy of the complete
pack, remove `.osd-source.json` and `.osd-fetched.json`, and strip `sources`
from its staged `osd-pack.json`. Preserve its `abap` folder list and the
resolved folders at their original paths. Build that copy with `--kind pack`.
Unresolved `sources`, names differing from `--name`, escaping folder paths and
fetch identities are refused. `scripts/system-roundtrip.mjs` implements this
staging recipe. No later source fetch is needed by an installed pack.

System mode refuses `OSD_PACKS`, `OSD_WEB_PACKS`, `OSD_LAYERS`, every
`OSD_LIB_*` override (including empty settings), and an existing `local/tmp`
layer even with `OSD_TMP=off`. Removing `.local/system/` returns to ordinary
checkout resolution. With no active system, development resolution retains
its existing behavior. The generation hash adds the system digest to its
existing content and toolchain hashing. Internal registry discovery uses
an explicit option to reuse already selected roots; unit discovery can omit
extra checkout packs without setting environment overrides. An installed
system always retains its complete index closure. ADT exposes installed source
roots as read-only and refuses saves, creates and deletes through its existing
ReadOnly response before writing source or inactive versions. `$TMP` has no
writable root in system mode; creating an object there is also refused.
The VS Code debugger resolves logical source maps to the installed files,
including breakpoint discovery and attach path overrides.

Each build's `prepare()` re-reads and verifies every installed layer's complete
treeDigest, including libraries, source, seeds and static pages, before using
a cached generation or running generators. Only the installer's root identity
file is excluded. Added, changed, missing or nonregular files refuse the build,
name the layer and say `run osd-fetch --system again`. There is no development
bypass: edit a checkout and rebuild/refetch the layer. Verification logs its
file count, byte count and elapsed time; the roundtrip report records that cost.

“System = digest” covers the ABAP, fresh seed data and pages, with the OSG
commit and transpiler pin recorded by `org.osd.osg.commit` and
`org.osd.transpiler`. A different running OSG commit prints a warning and is
allowed; reproducing the original toolchain uses those annotations. No live
database state is included or restored.

### Local roundtrip proof

```sh
OSD_HEAVY_RANGE=50-59 GOCACHE=/mnt/ssd-510/osg/go-build TMPDIR=/mnt/ram/stoker \
  tools/osd-heavy.sh node scripts/system-roundtrip.mjs
```

This dev tool is outside CI. It syncs absent libraries, fetches pack sources,
builds all locked libraries plus src, test and every pack, and uploads them to
the in-process loopback registry from the test helper. It creates a scratch
checkout without src, packs, data, webapp or gen, installs by digest, builds
both roots and compares SHA-256 hashes of every output file and both file sets.
It reports the index digest, per-layer file counts and byte sizes, total size,
object counts, differing paths, layer-verification cost and elapsed time. `OSD_ROUNDTRIP_DIR` can name
a directory outside the heavy wrapper's temporary directory to keep its
scratch tree, build logs and `report.json` after the wrapper exits.

The proof uses the registry fixture's low-level upload functions, so it can
include the repository-allowed pack vectors that the public publication leak
gate refuses. Its registry binds only loopback and is closed on completion;
it never publishes to a network registry. Real publication continues through
`osd-layer push` / `system push` and their unchanged fail-closed leak gate.
