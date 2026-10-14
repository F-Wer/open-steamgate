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
STARTING_FOLDER layout. Otherwise all files are placed under `src/` and the
builder generates `.abapgit.xml` with STARTING_FOLDER `/src/`. Symlinks and
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
