
## General ABAP transformation runtime

Track named Simple Transformations and XSLT separately from the application
ZIP/XML converter. The current implementation handles `CALL TRANSFORMATION
ID`; a staged compatibility plan and A4H comparison corpus are in
[ABAP transformation runtime](open-issues/abap-transformations.md).

---

## The guard is a patch; a content-addressed name is the fix (2026-09-19)

`make-release` copied `build/osd` and never built it, so a release whose
`release.json` named the current commit shipped a four-hour-old binary, and
an evening went into conclusions about code that was not running. The
checksum said so in one line and nothing else did.

The guard now refuses a host older than `bin/`, `tools/` or `scripts/`, and
it covers **every** copied host after the first version covered two of three
-- the same "fixed the case, not the class" we caught three times in each
other's work that day.

**But it is a patch, and the tree already holds the fix next to it.**
`build/live` points at `by-input/<hash>`, and **a name that is a function of
the content cannot go stale silently**: change the code and a different
directory is copied. Nothing compares times; there is simply no way for the
name to lie. The binaries have no such property, so they need a watchman,
and a watchman needs a list, and a list needs maintaining -- exactly the
shape of `databaseFile()`'s engine list and of `make-release`'s old package
list, both of which were wrong when somebody finally looked.

So the real repair is to name the built hosts by their content, the way
generations are named. Then `release.json` can answer "which binary is
inside" instead of only "when was this release assembled", and the guard
disappears rather than being maintained.

**And mtime has a known hole**, worth writing down before it bites: it does
not survive `git checkout`. A checkout stamps the working time on files it
restores, so a file nobody edited becomes newer than the binary, and the
refusal is correct about the dates and misleading about the cause. A hash
does not have this failure.

---

## Track B — the runtime underneath

*Deepen what the answers are made of: OData, SADL, RFC, and the database seam.*

```
B.1  SADL beyond read-only                           [S]  DONE 2026-09-19
     ├─ today: CDS projections, an analytics cube, $select -> GROUP BY,
     │  and writes only on a projection of exactly one table
     ├─ **associations in a projection — done 2026-09-19.** `parseDDLS`
     │  reads one view at a time and a view's associations are the clauses it
     │  declares; a projection declares none, it re-exposes an element the
     │  view underneath declared. So `_Child` was collected as "exposed" and
     │  had nothing to be exposed **of**. Measured before the fix on a
     │  projection of a view with one association: the base came back with
     │  its association and the projection with none, silently
     ├─ it is a pass over all the views (`inheritAssociations`) rather than a
     │  line inside one, because the answer is in a different file and
     │  `parseDDLS` never has two. The inherited association names the view
     │  it came from, and one whose ON column the projection **renamed** is
     │  refused by name rather than emitted with pairs that name a column the
     │  target does not have
     └─ next: a write path that is not the single-table special case

B.19 HANA, AMDP and where each machine stands                            [S]
     Decided 2026-09-18 by arithmetic rather than preference.
     ├─ **HXE is up on the i7, 2026-09-18**, and the first AMDP body ran
        in it end to end: `ZCL_VSP_00_AMDP_TEST=>CALCULATE_SQUARES` cut out
        of the class, deployed as a procedure and called, returning the
        five squares. Startup 169 s, instance HXE/HDB90, SYSTEMDB 39013,
        tenant 39017.
        ├─ **the load-bearing assumption is confirmed and is generous**:
        │  `CREATE PROCEDURE` refuses a missing table and names it *with a
        │  position* - `Could not find table/view NO_SUCH_TABLE_HERE in
        │  schema OSD: line 3 col 44`. So HANA is the oracle for which
        │  tables a body needs, and no SQLScript parser is required.
        │  `SYS.OBJECT_DEPENDENCIES` then lists it, which is the
        │  after-the-fact completeness check
        └─ **snapshots need no work**: HXE persists under `/hana/mounts`,
           the one directory the recipe says to bind, so the database is
           already outside the container - 3.7 GB there against 73.6 kB in
           the writable layer. That is the property `~/dev/a4h/a4h-lite.sh`
           had to be written to get for A4H, whose image keeps 38.3 GB in
           the writable layer. A save/restore script in its spirit is worth
           having when we start wanting clean states between experiments;
           until then it is not needed. (Alice, 2026-09-18: "это если прям
           надо - можно и попозже")
     ├─ **decided 2026-09-18: `STG_DB=hana` is the AMDP mode.** Alice:
        "работать целиком на хане имеет смысл если мы веселимся с AMDP и
        там всё мило и красиво бежит". So HANA is not a general backend
        and not a default - it is the mode you switch into when the work
        *is* AMDP, and in that mode everything falls out:
        ├─ the procedure and the tables are in **one database**, so the
        │  mirroring question disappears entirely, along with the
        │  iterative "create, read the error, mirror, retry" plan. That
        │  plan stays written down because it is what you need when the
        │  data layer is *not* HANA, which is every other mode
        ├─ `sy-dbsys = HDB`, which is what a real system reports, so the
        │  oracle work gets a fidelity it cannot get any other way
        └─ and the cost is bounded and known, because it was measured
           before deciding (docs/db-backends.md): per **statement**, not
           per row - a 200-row SELECT is 3.8x the in-process cost, a
           single-row SELECT 52x, an INSERT 146x. Set-wise ABAP ports
           nearly free, row-at-a-time ABAP does not
     ├─ **the two pieces of work, in order**:
        ├─ **the DDL generator, and it does not exist anywhere**: the
        │  transpiler has real schema generators for SQLite, PostgreSQL
        │  and Snowflake and `hdb: ["todo"]` for HANA - a literal string.
        │  This is first because without a schema there is nothing to
        │  point a client at
        └─ **the client**: eleven methods on the npm driver `hdb`, the
           same shape as `tools/duckdb-client.mjs`. Three differences to
           measure rather than assume, the ones DuckDB taught us: the DDL
           flavour, trailing blanks in CHAR comparison, and savepoints -
           HANA has real ones, so that third one should be easier here
           than it was there
     ├─ **what HANA Express is actually for, Alice 2026-09-18**: it is
        **not** a database backend for OSD. It is the engine for one
        narrow case - **cut the AMDP body out of the ABAP class and run it
        in HANA Express**. The body is already valid SQLScript, so HANA
        executes it natively and we never write an interpreter for a
        second language. That is what makes the track cheap, and it is a
        different design from "a fourth DatabaseClient".
        ├─ it also settles the earlier question: transpiling AMDP is not
        │  on the table. Our own `ZCL_Z80_00_CPU_AMDP` - eighteen
        │  DECLAREs, thirty-six SELECTs and three loops in one procedure -
        │  is why
        ├─ **and it must not be the A4H HANA** (Alice, same day): that one
        │  is the sandbox everybody's oracle work depends on, and our
        │  schema has no business in it. HXE is the clean laboratory the
        │  entry always said it should be
        └─ the questions that design raises, none of them answered yet:
           ├─ **where the data is.** An AMDP body selects from tables.
           │  Those tables have to exist in HXE with our rows, so either
           │  the tables it touches are mirrored before the call, or HXE
           │  holds a copy of the schema. Which one is the first real
           │  measurement
           ├─ **how the procedure gets there.** On a real system the AMDP
           │  framework generates a HANA procedure from the method body.
           │  We would do the same: body plus signature in, `CREATE
           │  PROCEDURE` out, cached by a hash of the source
           └─ **how the call travels.** Transpiled ABAP calls the method;
              something has to bind the table parameters, call the
              procedure and read the result back. The npm driver `hdb` is
              the transport
     ├─ **an earlier reading of this entry, kept because the facts in it
        are still true**: a real HANA is reachable from the i7 today -
        premise of this item was that a HANA has to be stood up locally.
        There already is one, and it is reachable from the i7 two ways:
        ├─ `~/dev/a4h` is the landscape and carries the recipe: instance
        │  **02**, SYSTEMDB on **30213**, tenant **HDB** on **30215**, and
        │  the tenant holds the ABAP schema **SAPA4H**. Running
        │  `SELECT DATABASE_NAME, ACTIVE_STATUS FROM M_DATABASES` through
        │  the documented `ssh <host> "docker exec <container> su - hdbadm
        │  -c 'hdbsql ...'"` route answers `SYSTEMDB YES` / `HDB YES`
        ├─ and **both ports already answer on the i7 itself**, forwarded
        │  by the long-running `tools/osd-tcp-forward.mjs`: a TCP connect
        │  to `127.0.0.1:30213` and `:30215` succeeds. That process is
        │  therefore **load bearing, not the idle leftover it looks like**
        │  - its capture file has not grown since 2026-09-14, but the
        │  forwarding is what makes HANA reachable from here at all
        └─ so what is left is a **database client**, not a database: the
           seam in docs/db-backends.md takes an eleven-method
           `DatabaseClient` and a fourth implementation needs no change
           anywhere else. Upstream's `packages/database-hdb` is a
           `todo.txt` naming the npm driver `hdb` and nothing more, so the
           work is ours, and it is the same shape as
           `tools/duckdb-client.mjs`
     ├─ **and the old correction stands: the HXE image was never pulled.** `docker images` holds exactly two,
        `sapse/abap-cloud-developer-trial:2023` (62.4 GB) and portainer;
        `docker ps -a` holds `a4h-107`, **exited four weeks ago**, and
        portainer. So the sentence below was the plan, not the state - the
        image has never been pulled. Anyone starting B.19 pulls it first,
        and should know it is a 1.8 GB download before anything can be
        measured locally. Note also that A4H exists here as a **local
        container** as well as at the address `.mcp.json` names; the
        container is stopped.
     ├─ **the corpus, measured on A4H 2026-09-18 through the vsp CLI**
        (`vsp query SEOMETAREL --where "REFCLSNAME = 'IF_AMDP_MARKER_HDB'"
        --top 5000`), which is the cheap question the peer session asked
        for instead of reading every class:
        ├─ **195 classes implement the marker** - which corroborates the
        │  194 recorded earlier from a different route. 167 SAP standard,
        │  22 compiler fixtures, 3 partner namespace,
        │  and **3 customer classes**
        ├─ **the three customer ones are the interesting part, and they
        │  are all ours**: `ZADT_CL_AMDP_TEST`, `ZCL_VSP_00_AMDP_TEST` and
        │  `ZCL_Z80_00_CPU_AMDP`. The last one is a **Z80 CPU written as
        │  four SQLScript procedures** - `run_steps` alone is 148 lines
        │  with 18 DECLAREs, 36 SELECTs and three loops - and it is the
        │  hardest shape of AMDP there is: imperative, stateful, nothing
        │  like a wrapper over a view. So the corpus says both things at
        │  once: what SAP writes is largely portable, and what *we* wrote
        │  is not portable at all
        ├─ **the sampling caveat stands**: A4H is a delivered sandbox, so
        │  it cannot say whether third-party customers write AMDP. It says
        │  how SAP writes it, and it says what we ourselves wrote
        └─ **how SAP writes it, sampled**: 10 standard classes, 27 AMDP
           method bodies, cut out with a regex - **15 are one portable
           SELECT**, 10 use table variables or are imperative, 1 has no
           SELECT, 1 has several. That supports the thin-wrapper
           hypothesis below, with the caveats stated rather than buried:
           the sample is 10 of 167 and was not random, and the classifier
           treats `:=` as a table variable, so the imperative count is an
           upper bound
     ├─ **a measurement trap that cost the first answer**: `vsp query`
        documents `--top` as "0=all", and `--top 0` **silently returns
        exactly 100 rows**. The first run of the query above answered
        "100 classes, none of them customer", which is wrong in both
        halves, and the round number was the only clue. Alice spotted it.
        Pass an explicit large `--top`, and treat any result that is
        exactly 100 as suspect until a second page is checked with
        `--skip`
     ├─ **HANA Express runs in docker on the i7, and only there.** The
        workstation is WSL2 on a 31 GB Windows host, so the Linux side
        sees 15 GB by the default "half the host" rule; HXE wants 16-24 GB
        and would take all of it, leaving nothing for agents, transpiles
        and webpack - and a Windows reboot would take the database with
        the session, which has already happened once. The i7 has 125 GB,
        16 cores, 581 GB free and docker without sudo, and the image is
        1.8 GB compressed. Raising WSL's memory in `.wslconfig` to 24 GB
        is still worth doing, for the agents, not for HANA
     ├─ **the oracle already exists and it is A4H**: `sy-dbsys = HDB`,
        release 758, and **194 AMDP classes, 191 of them SAP standard**,
        readable through ADT (measured 2026-09-18). A separate HXE is a
        clean laboratory, not the source of truth
     ├─ what a real one looks like, read off A4H: a `method … by database
        procedure … using <a CDS view>.` with a one-line body selecting
        from a **CDS view with a parameter**. A large part of the standard's AMDP is a thin wrapper
        over CDS rather than a table-variable engine, and CDS we already
        generate and read - so the portable share may be much larger than
        it looks. **Measure it before designing anything**: read all 194,
        cut the bodies out with our parser and count how many are one
        portable SELECT, how many use table variables, how many call
        calculation-engine functions, how many are imperative
     ├─ the parser is ready for that cut and it cost nothing: abaplint
        already swallows an AMDP body whole as one `NativeSQL` statement
        (verified by parsing a real class), so the body comes out by
        source position. `FOR HDB` is a string literal in one line of
        `method_implementation.js`, so `FOR DUCKDB` is a one-line grammar
        change - but see the next point before reaching for it
     ├─ **a dialect does not need a grammar fork**: a marker interface of
        our own beside `IF_AMDP_MARKER_HDB` picks the target, and the
        source stays legal ABAP that compiles unchanged on a real system.
        Forking abaplint's grammar for a non-standard `FOR <db>` is a
        divergence in the language itself, which is worse than the carried
        patches we just spent a day getting rid of
     └─ **not inside HANA**: XS Classic is SpiderMonkey at about ES5 and
        deprecated, and our runtime needs classes, async/await, BigInt and
        8893 top-level awaits; XSA is a separate application server that
        costs 3 GB+ to get a Node we already have. Co-location on one
        machine buys the missing network hop and nothing is lost

B.2  BOPF / RAP / drafts: one runtime, two front ends                    [S]
     ├─ **started 2026-09-18**, and the first two pieces are in:
     │  ├─ **a composition**: `@ObjectModel.association.type:
     │  │  [#TO_COMPOSITION_CHILD]` makes the target a part rather than a
     │  │  thing pointed at, and deleting the parent takes the children
     │  │  with it, in the one LUW the request is already in. The
     │  │  `#TO_COMPOSITION_PARENT` end deliberately does not cascade, the
     │  │  same asymmetry a BDEF has between `composition of` and
     │  │  `association to parent`. ZC_STG_TRAVEL / ZC_STG_BOOKING is the
     │  │  worked pair; docs/cds-writes.md
     │  └─ **a transactional bracket, which turned out to be missing
     │     entirely**: nothing in this system ever committed. All three
     │     database clients implement begin/commit/rollback, so the whole
     │     server ran inside one transaction that ended at disconnect.
     │     A `$batch` changeset is now one LUW - a `COMMIT WORK` fences
     │     off everything earlier (the rows the boot writes, an earlier
     │     part of the same batch), then the changeset either commits or
     │     rolls back as a whole. Without the fence a failing changeset
     │     would have undone the process's entire uncommitted history.
     │     The test was checked by removing the rollback and watching it
     │     fail, which is the rule this repository learned the hard way
     ├─ **the parts are readable at runtime**: `ZIF_STG_CDS_COMPOSITION`,
     │  implemented by the generated source class of a view that declares a
     │  child and by no other, so the runtime asks with a cast and carries
     │  on when the cast fails. `children( )` answers the navigation a
     │  client sees, the child view, and how a parent key becomes a child
     │  key. Unit-tested by its content and by the child *not* implementing
     │  it, not by the fact that it compiles - an interface implemented
     │  with an empty method looks the same in a build as a working one
     ├─ **what blocks the deep insert, named so it is not rediscovered**:
     │  `zcl_stg_sadl_dpc` has no `create_deep_entity`, and a generic one
     │  cannot be written the way the demo's hand-written one is. The entry
     │  provider fills a **typed deep structure** - the demo declares
     │  `ts_travel_deep` in its MPC and the provider walks `is_set-navs`
     │  into it - and a generic DPC has no such type. So the next piece is
     │  either a deep structure built at runtime through RTTI (and whether
     │  the transpiler carries `cl_abap_structdescr=>create` with a table
     │  component is the thing to measure first), or a second path in the
     │  provider that hands the nested rows over untyped
     ├─ next in this track: the buffer proper (changes held in memory for
     │  the length of an interaction rather than written through), then
     │  draft. The order is the peer session's, and the argument is sharper
     │  than "cheaper first": a draft is **not a persistent buffer**, it
     │  stands on one. Activating a draft re-runs the behaviour - the
     │  validations and determinations - and that run happens in the
     │  buffer, so a buffer folded into the draft leaves the save sequence
     │  nowhere to happen. What does carry over is the **delta** (entity,
     │  key, operation, state after), which is designed serialisable from
     │  the first day: in a LUW it lives in memory, for a draft the same
     │  delta is written to a table keyed by the draft. Persistence is then
     │  a change of storage, not of model - and the browser preview, which
     │  has no process at all, is why persistence will come
     ├─ still out, as stated on day one
     ├─ oracles planned but not built: docs/oracle-rap.md, oracle-draft.md
     ├─ gated on 0.4 / 0.5 (Alice: build sample objects on the sandbox?)
     │
     ├─ **the order, decided 2026-09-18**: build the runtime once, shaped
     │  in RAP's vocabulary, and enter it first through CDS annotations,
     │  with a behaviour-definition grammar as the second front end.
     ├─ what decided it, measured rather than assumed: abaplint parses a
     │  BDEF with **one regular expression** that extracts the entity name
     │  and its alias (`objects/behavior_definition.js`) - no create/update/
     │  delete, no actions, validations, determinations, draft, locks or
     │  field control. The `@ObjectModel` annotations, by contrast, we
     │  already parse in full: virtual elements, writeEnabled and the
     │  analytics annotations all run on them today. So RAP's front end is
     │  a grammar to write and CDS-BOPF's is free
     ├─ the runtime is the same either way and is most of the work: a
     │  transactional buffer, the composition tree, draft, delegated CUD,
     │  locks, ETags. The choice is only which language describes it first
     ├─ the vocabulary inside is RAP's from day one, because a managed RAP
     │  implementation with `persistent table` + `lock master` says almost
     │  exactly what the CDS-BOPF annotations say (`transactionalProcessing
     │  Enabled`, `writeActivePersistence`, `writeDraftPersistence`,
     │  `association.type: [#TO_COMPOSITION_CHILD]`, `transactional
     │  ProcessingDelegated` on the consumption view). Cheap front end,
     │  modern model
     ├─ writing the BDEF grammar against a runtime that exists is far
     │  easier than designing both at once - and it is a real contribution
     │  to abaplint when it comes, which is a reason to do it second and
     │  not first
     └─ first milestone, and it is visible: a **draft-enabled Fiori app**
        over one composition - header and items, create, change, activate -
        declared in annotations, the machinery ours, checked in a browser

B.3  OData v4                                                            [S]
     └─ the serializer is v2; v4 is a second shape over the same model, and
        nothing in the dispatcher assumes v2 except the JSON writer

B.4  The RFC runtime, both directions                                    [R]
     ├─ today: destinations resolve local / replay / live / record / fallback
     ├─ the bridge is an RFC *server* for exactly one function module
     └─ next: serve more than SADT_REST_RFC_ENDPOINT, so a real RFC client
        (SM59 test, an external caller) reaches a transpiled function module

B.5  Multi-record framing, properly measured                             [R]
     ├─ splitting works and a 606 KB answer was accepted in two records
     └─ but the operation-info length on a *continued* record is inferred
        from single-record captures; capture a real long answer and check

B.6  The client/MANDT story — dormant, with a detector to build      [S+T]
     Re-read 2026-09-18 by the workstation session, acting as critic, and
     the label was wrong rather than the place in the queue.
     ├─ the facts are unchanged: fixed client 123, no implicit MANDT
     │  (ANORMALIES.md). The demo keeps T0009 visible on purpose
     ├─ **but upstream considers the question closed by design**: in
     │  abaplint/transpiler#606 Lars answers "or just ignore it, the runtime
     │  does not need a client, run several instances" — and running one
     │  instance per client is exactly what we do. So this is not a
     │  first-order risk today; it is a **dormant property**
     ├─ it wakes on exactly two events, and neither is in the queue: one
     │  runtime serving more than one client, or running a customer's real
     │  DPC that branches on `sy-mandt`. That is why it sits below G.5/G.6
     │  and that is correct — what was wrong was calling it an alarm
     ├─ **turn it into a detector rather than a standing worry**, the way
     │  `npm run leak` was made: fail the build when transpiled code reads
     │  `sy-mandt`, or when a SELECT hits a CLIDEP table with no explicit
     │  client condition. An alarm nobody touches for a year does not work;
     │  a check does
     └─ and W.1 lowers it further rather than raising it (fable-osd,
        2026-09-18): a client is SAP's own multi-tenancy -- one instance,
        several isolated sets of data -- and a **branch** answers exactly
        that need here, with its own database, its own seed and its own
        port. We get the isolation from a file rather than from a column,
        and the better W.1 works the less MANDT is wanted. HANA does not
        change this either, with one caveat that is not about MANDT at all:
        two branches on one HANA server must sit in different schemas, or
        the isolation-by-file property stops holding there (W.1)

B.8  SICF and SM59 as applications — **merged into G.5**, see there      [S]
     ├─ Alice, 2026-09-16: a SICF editor over the *.sicf.xml / *.sapc.xml the
     │  tree carries (tools/osd-icf.mjs already lists and mounts them), the
     │  way src/segw is SEGW as an application over its own tables
     ├─ a node may point at an ABAP handler (if_http_extension, served by the
     │  child through the shim, as today) OR at a JS — later maybe Go —
     │  implementation: the door (POST /osd/sql) is already a node answered
     │  by JS, so the shape exists; missing is declaring it in a *.sicf.xml
     │  and an editor over the set
     ├─ SM59 in the same manner later: destinations as objects with an
     │  editor, over the .local/rfc-destinations.json the RFC runtime reads
     │  (local / replay / live / record / fallback); track D's gateway makes
     │  the outbound half real
     └─ **merged 2026-09-18.** This entry and G.5 describe the same work in
        two tracks, which is how a thing gets built twice by two owners.
        G.5 carries the fuller specification (Alice, 2026-09-18) and is the
        surviving number; the two ideas that live only here — a node that
        may point at a JS rather than an ABAP handler, and SM59 later —
        move with it. Nothing new starts under B.8

B.9  A forced build mutates a generation under its name                 [S]
     ├─ Astra, 2026-09-16: `--force` replaces the directory build/by-input/<hash>
     │  holds, so a consumer pinned to that name sees changed content under
     │  an unchanged name, which is what immutability was for
     ├─ since 2026-09-16 the swap is two renames (no moment without a live
     │  generation), and the rule that decides the output is part of the
     │  hash, so a forced build differs from the cached one only when the
     │  transpiler or the builder changed under the same inputs
     └─ DONE 2026-09-19: a forced build compares and reports. Identical ->
        the name keeps its bytes and nothing is written. Different -> it is
        a FINDING, said out loud and not overwritten; `--replace` takes the
        new bytes under the same name, in so many words.
        **Measured before any of it was written, because the answer was not
        known**: two forced builds of one generation differed in **1 of 2249
        files**, and the cause was single -- the builder's own process id,
        baked into the copy of `abap_transpile.json` the generation carries
        (`output_folder: build/tmp/<hash>.<pid>/output`). An artefact
        addressed by the hash of its inputs must not carry the number of the
        process that wrote it; nothing reads that copy after the build, so
        it now describes itself (`output_folder: "output"`). With that gone
        the build is byte-for-byte reproducible, twice in a row, 2249 of
        2249 files. So the promise in the name was true and one defect was
        hiding it -- a repair, not a property to rewrite.

B.10 The base image is named by the schema alone                  [S]  DONE 2026-09-17
     ├─ Astra, 2026-09-16: .local/db/base/<schema-hash>.sqlite; a change to
     │  the seed rows (data/*.tabu.json) or to the seeding rules with the
     │  same DDIC keeps the name, so a new instance copies old rows
     └─ the identity is schema + seed data + the loader that applies them;
        a persistent user database is never reseeded by this, only the
        image a new database is copied from
     └─ DONE 2026-09-17 with B.13: the image is named by the schema and
        the rows that went into it, and the tables the generation writes
        at start (tadir, wwwparams, t100) are rewritten from the
        generation on every boot over an existing file

B.12 One work process, and a channel that never waits                    [S]  pool DONE 2026-09-16
     ├─ tools/osd-pool.mjs: OSD_WORKERS children, a push channel pinned to
     │  one for the life of its socket, HTTP on the primary. Deployed to
     │  the second machine with four: over the network 111 frames/s on one
     │  socket, 369 on four, three processes busy at once instead of one
     │  core at 100 %. Nothing in the ABAP or the page changed. Still open
     │  below: HTTP across workers (needs a decision about what a session
     │  is), and the page's missing back-pressure, which is the demo's
     ├─ measured 2026-09-16 on a 16-core machine: one core at 100 %, the
     │  other fifteen at 1 %, load average 1.04. The serving runtime is one
     │  process with one JavaScript thread, so every session's ABAP runs on
     │  the same core — that is one dialog work process, not a pool
     ├─ a frame costs 0.7 ms direct and 1.3 ms through the façade on an idle
     │  server; with a second session playing the demo it is 55 ms at the
     │  median. The cost is contention, not the ABAP
     ├─ and the demo's page never waits: it fires a frame request every
     │  24.6 ms and draws whatever comes back. Over a slow link 247 requests
     │  produced 43 drawn frames and 205 outstanding, replies 4 s behind —
     │  which is why an effect plays slowly and the next one rushes. Two
     │  independent defects: no back-pressure in the page, one core here
     ├─ the client's fan-out buys nothing, which is the proof: the demo's
     │  PRELOAD pulls frames on four sockets at once, and the server stays
     │  at one core (109 % of one, the rest of sixteen idle). Measured on an
     │  idle server here: 474 frames/s on one socket, 599 on two, 491 on
     │  four — flat, and four sockets are slightly worse than one. Four
     │  throats, one work process
     ├─ the pool: the supervisor already owns process lifecycle (recycle,
     │  reap, registry), so N children with sessions pinned to one of them
     │  is the shape — SAP's dispatcher and its dialog work processes, and
     │  what makes APC and the ABAP Daemon Framework scale on a real system
     └─ for this demo specifically a frame is a pure function of (demo,
        tick) through the JSON path, so the per-session state that matters
        is small (which demo, running or not) and frames are cacheable by
        key — the page already has a CACHED mode

B.11 The binary beyond the checkout                                      [S]
     ├─ **two defects the binary's own suite caught on 2026-09-19, and both
     │  are about a path taken from `import.meta.url` inside a bundle** --
     │  the thing CLAUDE.md warns about, in two new places:
     │  ├─ **every main-guard fired.** `process.argv[1] &&
     │  │  import.meta.url.endsWith(argv[1].split("/").pop())` is right for
     │  │  `node tools/x.mjs` and true in EVERY module of the binary, where
     │  │  the shared url ends in `/osd` and argv[1] is the binary: the
     │  │  first such module the bundle evaluates runs its own `main()` and
     │  │  the binary becomes that tool. `build/osd doctor` answered
     │  │  "no packs: nothing in packs". Twenty files carried the form; it
     │  │  had been waiting for an import that changed the evaluation order.
     │  │  Fixed with `runsAs("<file>.mjs")` in `tools/osd-main.mjs` -- the
     │  │  name is a **literal**, because it cannot be derived from a url
     │  │  there is only one of. `test/osd-main.mjs` keeps the form out, and
     │  │  went red on its first run against the helper's own comment, which
     │  │  quotes what it replaces
     │  └─ **the binary and node can no longer name the same generation**,
     │     and it is not the stale binary it looked like: since `267f9a7`
     │     the hash covers the generators, and `generatorClosure()` walks
     │     `fileURLToPath(new URL(".", import.meta.url))`, which inside the
     │     binary is `/$bunfs/root/`. Measured: editing `tools/cds2ddic.mjs`
     │     moved the node hash and left the binary's unchanged. Open, and it
     │     belongs to the hash's design rather than to the binary: either
     │     the closure is read from the tree being served, or the equality
     │     of the two hosts stops being the property that test asserts
     ├─ measured on a second machine 2026-09-16 (bun-spike.md part five):
     │  the Bun binary needs nothing; the Node hosts need a closure of four
     │  packages beside the workspace, because generated code imports the
     │  runtime by name and setup.mjs imports the database adapter, and
     │  neither is bundled outside Bun. scripts/make-release.mjs assembles
     │  a directory that works for all of them
     ├─ what still travels beside any host: src/, webapp/, data/ and the
     │  setup hook — OSD's own content, which wants to be a pack of its own
     ├─ SP4 (bun-spike.md part three) runs the workbench from one binary
     │  with the checkout as its workspace; a directory with only ABAP in
     │  it needs src/, webapp/, data/ and test/setup.mjs brought along —
     │  that is E.2, and the boundary is recorded rather than tested around
     ├─ not measured: other platforms (each needs a native run), APC over
     │  the binary, TLS, the preview build; the parent's 500 MB RSS is the
     │  store's parse plus the bundle and wants a look
     └─ `osd doctor` lists runtime classes the bundle renamed; a bundler
        change that renames another one shows up there first

B.7  Database seam                                                       [S]
     ├─ **PostgreSQL reopened 2026-09-20 (Alice).** Adapter, dedicated-database
     │  atomic seed/schema-drift guard, `sy-dbsys`/System Status, local OData
     │  persistence across restart and short Compose/spin.md example are in
     │  the Docker draft branch. The image from commit `0d816d8` passed the
     │  default SQLite/DuckDB/PostgreSQL container smoke suite and was
     │  published to GHCR. HXE is opt-in. Older image
     │  tags reject `STG_DB=postgres`; user Portainer acceptance remains.
     ├─ SQLite, DuckDB, HANA and PostgreSQL are integrated; sql.js serves
     │  browser preview (docs/db-backends.md). bun:sqlite is 1.1, gated on 0.1
     └─ **DuckDB is parked entirely, 2026-09-18 (Alice)**: "можно
        полностью забыть пока - мы его исследуем когда прям необходимость
        появится острая. То есть далеко в будущем."
        ├─ what that means in practice: `tools/duckdb-client.mjs`,
        │  `STG_DB=duckdb`, `npm run unit:duckdb`, `npm run start:duckdb`
        │  and `npm run bench:cube` stay where they are and keep working;
        │  nothing is deleted. What stops is **investing** in it - no new
        │  features are measured against it, no defect in it is chased,
        │  and it is not a reason to shape anything else
        ├─ **it does not get in the way, checked rather than assumed**:
        │  `npm test` is lint + unit + integration and none of them touch
        │  it. `test/setup.mjs` imports `tools/duckdb-client.mjs` only
        │  behind `STG_DB === "duckdb"`, a dynamic import inside the
        │  branch, so the default build never loads it and
        │  `@duckdb/node-api` is not on the default path at all. Alice,
        │  2026-09-18: "если лежит и есть пить не просит и не мешает - то
        │  ок", and if it ever does get in the way of a build or a test,
        │  it goes to a branch or is ignored rather than fixed
        ├─ the upstream branch `feat/database-duckdb` (PR #1835 in
        │  abaplint/transpiler) is Lars's to merge and needs nothing from
        │  us; `npm run parked` keeps naming it, which is correct
        └─ do not confuse this with B.19: HANA and AMDP are a different
           track and are not parked. DuckDB was the analytics engine
           experiment, HANA is the dialect a real system speaks
```

---

## Track E — content packs and layers: what the tree is made of

*Objects come from more than one folder, and today the first one the disk
walk reaches wins, silently. Make the layering explicit, and make a pack
something you add without a rebuild.*

Added 2026-09-16 (Alice), to give the split document's piece E a track of
its own; the letters of the two lists agree from here on.

```
E.1  Ordered source roots, and a duplicate that does not keep quiet     [S]  DONE 2026-09-16
     ├─ one list, one order: the input_folder of abap_transpile.json is the
     │  layer order for the store and the builder alike, and the LATER
     │  folder wins, as 1.5 says (tools/osd-inputs.mjs `layers`,
     │  tools/osd-store.mjs `rootsOf`). Measured before deciding: the
     │  transpiler on its own writes the later folder's module last, while
     │  abaplint's registry in memory files the first and calls the second
     │  "already defined" — so the winner is decided here and not left to
     │  either. A library is not a layer: it fills only what no root has
     ├─ the builder hands the transpiler the winner only: every file of a
     │  hidden object goes into the build's exclude_filter, the manifest
     │  lists `overridden`, the log says "overridden: CLAS X: <file> hidden
     │  by local/used". Proven with the real transpiler over a two-layer
     │  tree: the winner's method in output, the loser's absent
     ├─ the same file name twice inside one folder is refused before a lock
     │  is taken, both files named (code DUPLICATE; test/osd-build.mjs)
     ├─ local/ is no longer one root: only listed folders are the system, so
     │  677 objects of local/abapgit, local/cpm, local/vivid-vibes left the
     │  ADT tree, which no build ever had. An import now appends its folder
     │  to the list (`Import#enlist`), the newest layer
     └─ `node tools/osd-inputs.mjs` prints overrides, duplicates and shadows

E.2  A pack is a directory, not a rebuild                                [S]  DONE 2026-09-16
     ├─ a pack is a directory with an osd-pack.json in it: ABAP (src/ by
     │  default), seed rows (data/), table definitions (src/ddic), a page
     │  (webapp/), a name and an order. tools/osd-packs.mjs is the only
     │  place that knows this, and everything else asks it
     ├─ found in <root>/packs/ and in every directory OSD_PACKS names (a
     │  pack itself or a container of them); layered after the folders
     │  abap_transpile.json lists, so a pack wins a name it shares and the
     │  build reports the override with both files (E.1)
     ├─ what a pack brings: its ABAP to the transpile and to the ADT tree
     │  as a package of its own ($VIBES, not $SRC), its rows to the seed,
     │  its tables to the DDIC lookup, its page to /app/<name>
     ├─ proven with the compiled binary: build/osd built before the pack
     │  existed serves its class through ADT, its rows through the door and
     │  its page over HTTP, with nothing rebuilt but the generation
     ├─ found on the way and fixed: a generator that read every layer
     │  picked up a CDS fixture under test/ and failed the build, so
     │  generators read content (src + packs), not layers; and cds2ddic now
     │  removes what it no longer generates, because a pack taken away left
     │  its table accessor behind and the next build failed on a table that
     │  did not exist
     └─ a pack that adds generated objects settles on the second build: the
        hash is taken before the generators run and gen/ is an input. The
        dev loop does that second build by itself

E.10 OCI layers and a system index                                      [M]
     ├─ step 1: digest-pinned registry pull, OCI pack sources, tree digest
     │  verification and self-describing fetched folders (PR #737)
     ├─ step 2: reproducible abapGit layer build/push, ordered system index,
     │  cross-repository mounts with upload fallback, inspection and a
     │  fail-closed leak gate; manual GHCR smoke workflow (not run locally)
     ├─ step 3: whole-system install by verified index digest, staged identity,
     │  strict complete library/input/pack resolution and customer precedence;
     │  dev proof: scripts/system-roundtrip.mjs compares complete output trees
     └─ formats, installation and toolchain annotations: docs/oci-layers.md

E.5  The launchpad sandbox asks for a config we do not serve   [S]  DONE 2026-09-19
     ├─ Alice, 2026-09-16, from the browser console on the second machine:
     │  GET /appconfig/fioriSandboxConfig.json answers 404 on every open,
     │  red in the console and harmless — the ushell sandbox looks for its
     │  own file before it takes window["sap-ushell-config"]
     ├─ the answer is not {}: the file the sandbox asks for is where the
     │  sandbox's own settings belong, so what it gets is the config, and
     │  the 404 stops as a consequence rather than as the fix
     └─ **one body, three hosts**: `tools/osd-sandbox-config.mjs` is the
        config, `tools/osd-serve.mjs` and `test/start.mjs` serve it and
        `scripts/build-preview.mjs` writes it as a file, because the
        preview has no server to ask. Three hand-written answers to one
        question is the shape that drifts, and this list already holds the
        case that proved it (the dialog step, written once next to one of
        its three callers)

E.4  The Zork console does not fit its box           [S]  DONE 2026-09-19
     ├─ Alice, 2026-09-16, from the launchpad tile: a long line runs past
     │  the right edge of the terminal frame instead of wrapping inside it,
     │  and the block cursor sits on its own line
     ├─ **it was arithmetic, not a CSS opinion.** xterm renders `cols` x
     │  `rows` at whatever the font measures and the element only clips it:
     │  100 columns of 16px Courier is about 960px, in a box declared 820px
     │  wide. Measured before the fix, in a browser: the drawn terminal stuck
     │  out **127px** past the drawn border. The box is sized by its contents
     │  now, so the frame is exactly as wide as the terminal it draws,
     │  whatever the font does — the one arrangement that cannot be half a
     │  column out
     ├─ the cursor was a consequence of the same thing: with the terminal
     │  wider than its box, a long line wrapped where nobody could see it and
     │  the prompt appeared to stand alone. The last line the machine writes
     │  is `>` with the cursor on it, asserted
     └─ `test/e2e/zork.spec.mjs` asserts **where the two boxes are**, not what
        the stylesheet says — a stylesheet that happens to be wrong would pass
        the second and fails the first

E.3  What a pack may carry                                               [S]
     └─ ABAP and DDIC (today), SEGW projects and CDS (today, through the
        generators), a Fiori app under webapp/ (2.10: a UI5/BSP object type
        so a client can deploy one), SICF and APC declarations (B.8)
     └─ a folder fetched from a repository at a commit, with an overlay
        (sources in the manifest, tools/osd-fetch.mjs) — DONE 2026-09-17;
        packs/o4d and packs/zork are the worked examples and the public
        preview builds from them

E.7  The oracle's leftovers (docs/frame-comparison.md, 2026-09-17)      [S]
     └─ Pages: the demo stops in the middle of plasma while the same
        build on the i7 plays the whole demo; the worker is one thread
        and plasma is 641 rectangles a frame — measure whether it is the
        page's back-pressure (B.12) or a worker error the page swallows
     └─ where the transpiled ABAP is slow: some effects run far below
        the system's speed on one core; profile a frame of plasma,
        julia_morph and the 4D cells in the runtime (node --cpu-prof on
        the serving child) before reaching for fast-math; the suspects
        are Float allocation per operator and the string templates that
        build every colour
     └─ sorted triangles: amiga_ball, amiga_ball_2, sierpinski sort by z
        without a second key, so equal depths paint in an order the sort
        chooses; the demo needs a tie-break key (a PR to vivid-vibes),
        and the runtime's SORT should be checked for stability against
        the kernel's on a table with many equal keys
     └─ ignition's seed chain and one line of copperbars: not traced
     └─ one worker against eight on a problem scene with the APC session
        pinned, to separate arithmetic and table order from state
        distribution (Astra)
     └─ 2026-09-17, later: with the console fix the browser demo reaches
        the frame before rotozoom (Alice); the stop moved, the cause is
        still unmeasured
     └─ work processes in the browser too (Alice): several workers
        behind the service worker, one runtime each, and a page that
        pulls frames over several sockets and interleaves them — the
        B.12 pool, in a browser. Idea only.

D.9  docs/adt-facade.md, the version #7880 links to               [S]  DONE 2026-09-17
     └─ Astra's docs/adt-facade-proposed.md (uncommitted, 2026-09-17) is
        the top half of the next version: the role for the abapGit
        roadmap, the object-type matrix, activation as it is now (the
        original still says fire-and-forget). Before it goes in: DOMA/TTYP
        rows say "no ADT route", persistence names STG_DB=file, the
        RFC bridge points at docs/adt-over-rfc.md, the DIAG sentence
        shrinks to the stub, the review scaffolding goes, the "Do not"
        cadence softens; and the client contract of the original stays
        below it (403/405, encoded names, in-the-tree vs runnable,
        STG_DB_STRICT, unit-run alerts, the shim's pseudo-headers).
        DONE 2026-09-17 evening: merged with the seven corrections, the
        client contract kept below; 696 -> 542 lines, leak scan clean.
        The draft file stays untracked until Astra drops it.

B.13 A new SMW0 object never reaches an existing database file    [S]  DONE 2026-09-17
     └─ found 2026-09-17 with the lsd pack: with STG_DB=file the rows of
        wwwparams are seeded when the file is created, so an object added
        to a pack later (ZLSD-MUSIC) is in the generation and not in the
        table, WWWDATA_IMPORT finds no parameters, and the page answers
        404 while a fresh database serves it. The seed (or the schema
        fingerprint) has to notice a generation's W3MI set changing, or
        the media rows should be read from the generation rather than
        from the table. Until then: delete the file (or use another
        STG_DB_PATH) after adding media to a pack.

U.1  The user's path, measured                                      [S]  DONE 2026-09-17
     └─ a fresh agent with only docs/using-osd.md brought a pack (a YAML
        service over its own table with seed rows, a CDS view with
        @OData.publish), served it on another port, changed a line,
        broke the syntax on purpose: 12 minutes, both services answered.
        What tripped, and what changed for it: the guide now names
        STG_PORT and STG_DB_PATH, says how a running server picks up a
        build (it does not: npm run dev recycles, npm start restarts),
        shows where the file shapes come from and the CDS service's
        naming (<VIEW>_CDS, <View>Set, upper-case properties), and
        reads a failed build's line; stg-compile --all now removes a
        gen/stg project folder no YAML declares (the pack's service kept
        being registered after the pack was gone). Report under
        .local/try/user-path-report.md. Left: the error text for a
        missing period points at the next statement (abaplint's wording);
        the failed line sits among the generators' output.

A.12 SRVD and a minimal SRVB: the service definition as an input       [S+A]
     └─ Alice asked 2026-09-17 whether to take CAP-like syntax; the
        answer is that ABAP already has it and it is native:
        `define service N { expose E as A; }` in a SRVD, with a SRVB
        saying V2 or V4. CAP is a Node/Java runtime with its own
        persistence and handlers - reimplementing it would add an
        application model no SAP system runs, against the rule that the
        same ABAP runs in a system's ICF
     └─ the work: parse the SRVD ourselves in a generator (the way
        cds2ddic reads DDLS), emit the YAML model, let stg-compile make
        the classes; read-only over OData V2, which is what our gateway
        serves. Roughly a day, almost all reuse
     └─ two rocks: the transpiler refuses object type SRVD
        (ANOMALY-2026-09-15-srvd-not-allowed, needs an issue) - the
        generator reads src/ itself, so the object only has to be kept
        out of the transpile input; and V4 naming is unmeasured, V4 is a
        track of its own
     └─ not in scope: BDEF, behaviour implementations, drafts, actions,
        EML - the write side of RAP is its own track
     └─ @OData.publish is the older path (the sandbox warns that
        DDIC-based CDS views are obsolete), so this is the one that
        stays

A.11 A service of several CDS views, without a hand-written class [S+A] DONE 2026-09-17
     └─ today: @OData.publish gives one view one service and no
        navigation (publishedYaml() in tools/cds2ddic.mjs never emits an
        association, though the parser reads them); several CDS entities
        with navigation need either a hand-written MPC carrying the
        exposure XML (src/demo_sadl, as ZSTG_SADL_SRV does) or a
        stg.yaml that declares the navigation (as ZOSD_STATUS_SRV does)
     └─ the shape ABAP gives this is a service definition (SRVD): "these
        views, this service"; the transpiler refuses SRVD objects
        (ANOMALY-2026-09-15-srvd-not-allowed), so the near-term move is
        ours: carry the exposed associations from the parser into the
        generated YAML, and let a marker (a second annotation, or an
        SRVD-shaped file we read ourselves) say which views make one
        service
     └─ measured on the sandbox 2026-09-17 (docs/cds-publish.md): the
        annotation there generates IWSV + IWMO + IWVB and still needs the
        hub to publish; ours serves immediately
     └─ DONE 2026-09-17: publishedYaml() walks the exposed associations
        breadth first with a cycle guard and emits one entity per reached
        view plus the associations; names follow the system
        (<VIEW>Type, <VIEW>, to_<alias>, assoc_<32 hex>, the last one a
        sha256 slice rather than a fresh GUID so a build stays
        reproducible). ZC_STG_TRAVEL_CDS now serves ZC_STG_TRAVEL and
        ZC_STG_BOOKING with to_Bookings and to_Travel both ways
     └─ **and the specification is now measured, not guessed**: one
        published view pulls every view its exposed associations reach
        into the same service. Entity set = the view's name as it is
        (no Set suffix), entity type <VIEW>Type, container
        <SERVICE>_Entities, navigation `_Items` -> `to_Items`,
        association `assoc_<32 hex>` with FromRole_/ToRole_, read-only
        flags on the set, labels from the data elements. $expand and the
        navigation URL both work. So no SRVD is needed for this case:
        the work is to carry the parser's exposed associations into
        publishedYaml() and add the reached views as entities of the
        same service. Note it changes existing services (ZC_STG_TRAVEL_CDS
        would gain the booking entity and to_Bookings), so it is a
        decision, not only a patch

B.16 The demo DPC ignores $orderby                          [S]  DONE 09-17
     └─ found 2026-09-17 writing the conformance suite: a hand-written
        `_DPC_EXT` gets the ordering in `io_tech_request_context` and
        `zcl_zstg_demo_dpc_ext` never applies it, so
        `TravelSet?$orderby=TravelId desc` comes back ascending. The
        SADL and CDS paths do order. Either the demo DPC applies it or
        the dispatcher sorts what a DPC hands back when the DPC says it
        did not - a system does the former. The conformance cases for
        $orderby ride on the SADL service meanwhile


B.18 The release bundle runs 3.5x slower than the same build         [S]
     `ANOMALY-2026-09-17-release-bundle-slower-than-source`, found while
     re-measuring something else. One generation, one machine, one scene:
     100 ms a frame from a checkout, 363 ms from the release bundle. Node
     is not the cause. **This is what the i7 and every release run**, so
     the deployed demo is several times slower than the same demo from a
     checkout, and the work-process pool numbers (B.12) were taken on the
     source host.
     └─ it is not uniform, and that is the clue: with the transpiler's
        typed-arithmetic flag off the bundle costs 3.6x, with it on 2.0x,
        so the penalty falls on the `@abaplint/runtime` operator protocol
        rather than on everything equally
     └─ suspects, none confirmed: Terser's mangling of the runtime's hot
        classes, the single-chunk module wrapper defeating inlining, or
        the generated code reaching the runtime through the bundle
        plugin's `build.module` copy instead of a normal import
     └─ how to isolate it cheaply: build the bundle with Terser off, then
        with the chunk split, then with the runtime external, and profile
        the same generation each time. One scene and 60 frames answers it
     └─ until it is understood, **no performance number may be taken
        through a release**: a bundle that taxes the operator protocol
        flatters any change that removes protocol work, which is how a
        41 % improvement read as 63 % for a day

B.17 The arithmetic protocol: 30 ns an operation, and who fixes it   [S/T]
     Measured 2026-09-17, docs/demo-profile.md and docs/abap-hot-code.md.
     Every ABAP arithmetic operation costs about 30 ns here and about 1 ns
     in plain JavaScript; one frame of sdf_blobs is 1.97 million of them.
     The cost is the protocol around the operation - dispatch on the
     operand types, parse each operand, allocate the result - and not the
     arithmetic. Ranked by measured gain against risk, and the order is
     not the intuitive one:
     └─ a constant Character should remember the number it parses to
        (runtime, operators/_parse.ts with the character factory). Five
        lines, no compiler change, measured 22 % of an sdf_blobs frame,
        because '0.5' is how ABAP spells a float constant. Safe only for
        a literal with a decimal point: an integer-valued one takes the
        Integer branch and folding it would change an inferred type
     └─ a Float/Float branch in add/minus/multiply/divide (runtime). Two
        lines each, measured 9-17 % a frame. Integer addition is 17 ns
        and float addition 33 because the chain tests Integer first;
        divide is cheaper than multiply because its chain is two tests
        and multiply's is eight
     └─ raw JavaScript arithmetic when the operand types are proven
        (transpiler codegen, expressions/arith_operator.ts and source.ts).
        110-200 ns to about 1. The largest item by a wide margin and a
        project rather than a patch: the operator is chosen today by a
        string switch with no type information, source.ts already carries
        a context type it ignores, and abaplint core exports no
        getTypeOfSource(node), so a bottom-up type for a Source subtree
        has to be written. The admission rule is not "both operands f"
        but "no operand is character-like, packed, decfloat34, int8, hex,
        date or time, and at least one is f", which is what makes the
        calculation type fall away; division keeps its zero guard
     └─ a synchronous LOOP AT when the body contains no await (runtime
        plus codegen). LOOP AT is an async generator and costs 172 to 349
        ns a row before the body runs, against 74 for DO with READ TABLE
        INDEX. 2.3x on every table loop in every program, but "no await"
        means "no method call at all", so it reaches leaf arithmetic
        loops and little else
     └─ method inlining. 123 ns to 67, and 206 to 67 when the method
        returns a structure. High gain, high risk (aliasing, sy-subrc,
        exceptions, recursion, everything generated is async), and it is
        the precondition for anything across a call boundary
     └─ loop-invariant code motion: nearly nothing here on its own,
        because the one enormous invariant in the demo (cos of a rotation
        recomputed 128 000 times a frame) is behind a method call and
        invisible without inlining. Not worth starting before it
     └─ **not** a lookup table for a function over a proven range, and
        this was measured rather than argued: sin( ) is 19 ns and a
        READ TABLE INDEX lookup is 71, so the table is four times slower
        than the thing it replaces, and no table equals Math.sin at the
        sampled points, which breaks the frame comparison. The builtins
        are cheaper than the operators here (sqrt 10 ns, less than one
        multiply), so hand-expanding ** into multiplications is also a
        pessimisation
     └─ the demo's own ABAP is the ceiling measurement, not the fix:
        rewriting three scenes by these rules took sdf_blobs -37 %,
        torus_3d -38 %, quat_julia -28 % with every frame identical, so
        at least that much is on the table for a compiler that did it by
        itself. The patch is under .local/hotabap/ and belongs to
        vivid-vibes, not here

B.15 Does our CDS pipeline read a view entity?       [S]  DONE 2026-09-19
     ├─ **yes, and nothing had to be fixed** — which is worth as much as a
     │  fix, because it was a guess before. `parseDDLS` falls back to the
     │  view's own name when there is no sqlViewName, and that turns out to
     │  carry the whole path: generated, registered, listed in the data
     │  browser, read through a generated source class, a cast inside it
     │  behaving exactly as in a DDIC-based view
     ├─ `src/cds/zc_osd_port_ve.ddls.asddls` is the one view entity in the
     │  tree and is there on purpose, so that every build exercises the
     │  shape. It duplicates ZC_OSD_PORT, and that is the price: an
     │  unexercised code path is the more expensive of the two
     └─ pinned in two halves, because one test could not reach both:
        `test/cds-cast.mjs` reads one element without a build,
        `test/se16.mjs` asserts the rest of the path through the browser

B.14 A cast in a CDS view drops the field            [S]  DONE 2026-09-19
     ├─ found 2026-09-17 building the status service:
     │  `cast(pid as abap.char(10)) as Pid` in a view is parsed, but the
     │  field is missing from the row the generated source class returns
     │  and an entity keyed on it answers `PortSet()` with no key
     ├─ **the cause**: the generator handled a cast only when the element
     │  carried `@ObjectModel.virtualElement`. Without it the element has no
     │  direct `CDSName` child at all — the source column sits *inside* the
     │  cast — so the field was skipped by a `continue` meant for elements
     │  with no source. Reproduced before fixing: a three-element view
     │  generated **two** fields
     ├─ a cast over a real column is a column now: the name is the alias, the
     │  type is the cast's, and the column underneath is still named so the
     │  view reads it. A cast the generator cannot read — a constant with no
     │  virtualElement annotation — is **named as a skip** rather than
     │  dropped, because silence was the defect
     └─ `test/cds-cast.mjs`. The first attempt at finding the source column
        scanned the cast for a `CDSName` and picked `char` out of
        `cast( '' as abap.char(12) )` — a field pointing at a column that
        does not exist, which is a disappearance with a name on it. Its own
        test caught that. `parseDDLS` is exported for this; the tool only
        runs `main()` when it is the program.

U.2  The status app on the browser deployment                            [S]
     ├─ DONE 2026-09-17: the worker takes the snapshot itself and posts it
     │  to ZCL_OSD_STATUS=>REFRESH at boot and on every read of the
     │  service (web/preview-backend.mjs); host "browser", one process
     │  with no pid and no port, one port row saying there is none and
     │  why, the services of generated/services.mjs plus the SEGW
     │  registrations, the packs with their object counts from the build
     │  (web/generated/status.mjs). docs/status-service.md "On the
     │  browser deployment"; test/e2e/preview.spec.mjs
     └─ Alice, 2026-09-17: the launchpad on GitHub Pages has the tile and
        the app, but nothing fills the five tables there — no façade, no
        pool, no listeners. What the worker does know and could write at
        boot: host kind (a service worker), one "process" (itself), the
        generation (build.json), every service and channel (the generated
        services.mjs), the packs (packs.json), the objects per pack;
        ports would be honestly empty with a note. web/preview-backend.mjs
        is the place, ZCL_OSD_STATUS=>REFRESH the door, and the JSON
        contract already exists (tools/osd-status.mjs)

E.9  A pack has a page of its own                                        [S]
     └─ Alice, 2026-09-17: a pack tile should open something even when
        the pack brought no webapp — a generated Fiori page (or a
        deep-linked one) with the pack's description, its objects, its
        services, channels and tiles, read from osd-pack.json and the
        object store. Today a tile without a url points at /app/<name>/,
        which is 404 for a pack with ABAP only.

E.8  A DIAG stream as a demo                                      [S+A] milestone 1 DONE 2026-09-17
     └─ Alice, 2026-09-17: record the whole DIAG stream of a SAP GUI
        session (the LSD demo), push it over an APC channel the way ZO4D
        pushes frames, and paint it on the page with a SAP TUI written
        in JS, in the same console as the demos, with music. The DIAG
        reader exists in the sibling project (docs/layers-we-own.md);
        the missing piece is the screen-side renderer and the recording
        format.
     └─ milestone 1 DONE 2026-09-17 (docs/lsd-pack.md): sap-tui --record
        writes the composed screens as styled runs (141 KB gzipped for
        the whole show), packs/lsd carries the recording as an SMW0
        object, ZCL_LSD_APC_HANDLER hands it out by line, the page paints
        it on a canvas with the xterm palette; tile on the launchpad,
        preview test on the channel. Left: the music file (S: is not
        mounted here), icon glyphs, a compressed object once the browser
        side inflates it
     └─ milestone 2, if wanted: a DIAG decoder in JavaScript, so the page
        follows a live dispatcher

E.6  A pack cut out of a system                                        [S+A]
     └─ Alice, 2026-09-17: for vsp, or anything that speaks ADT and the
        abapGit API — prepare a self-contained pack from a system, with
        stubs and shims on the perimeter: the objects asked for, their
        closure inside the package, and a stub for every class, function
        and table the closure reaches outside it (npm run probe knows the
        closure; the stub is the ASSERT 1 = 'todo' shape open-abap-core
        uses, so a missing piece fails loudly and by name). The output is
        a directory with an osd-pack.json in it, so E.2 needs nothing new.
     └─ the perimeter is the hard part, not the export: a DPC_EXT's
        closure is the finding of Sprint 0, and the stubs are what make a
        pack run before the closure is transpiled

E.10 A system is a manifest of layer digests (OCI)                  [S]  M-L
     └─ Alice via dell, 2026-10-14, after Lars, "Storing ABAP build
        artifacts in OCI registry" (SAP Community 2022): a system is
        already an ordered layer list (abap_transpile.json input_folder,
        later wins by object name, E.1), which is OCI layer semantics.
        Alice: she likes the layers -- they are the core, not only
        an oci: source for packs.
     └─ the layer: an OCI artifact (ORAS shape) whose ABAP blob is the
        abapGit offline zip, the same file a real system imports; a pack
        layer adds its data/ and webapp/ as blobs and its osd-pack.json as
        the config. Libraries (open-abap-core ...), our own src/, packs
        and a customer layer exported from a system (E.6, vsp) are all
        layers of the one kind.
     └─ the system manifest: an ordered list of {name, ref, digest},
        itself an artifact, so a whole OSG system is one digest. It is the
        registry counterpart of input_folder + libs.lock.json + the pack
        list; osd-fetch --system <ref|file> pulls each layer by digest,
        verifies sha256 of manifest and blobs, unpacks into a
        content-addressed .local/layers/<digest>/ (immutable, so it is the
        layer cache) and writes the input_folder order. The build is
        unchanged; an unfetched layer is refused as UNFETCHED is today.
     └─ steps: (1) an oci:<ref>@sha256:<digest> source in osd-fetch next
        to git, ~1 day; (2) the manifest, materialise, input_folder from
        it, generation hash = the layer digests, ~2 days; (3) publishing
        from each repository's CI (oras push, GITHUB_TOKEN) + docs, ~1 day.
        First proof is abapiti's: v0.5.0 CI pushes zlnt.zip to GHCR, dell
        pulls, checks sha256, imports into A4H.
     └─ to settle while building (stoker's review, 2026-10-14):
        - pull without the oras binary: the registry v2 API is a token,
          a manifest and blobs by digest, a few dozen lines of fetch, and
          the Bun binary and the Pages workflow must pull too
        - reproducible means the toolchain as well: the manifest records
          the transpiler pin and the OSG commit, or "system = digests"
          holds only for the ABAP
        - redistribution: a layer of a third-party repository is a copy
          of it; open-abap-odata's licence still reads "todo", so it stays
          a git source until that is settled
        - live identifiers: a customer layer goes to the customer's
          private registry only, and osd-leak-scan --paths runs on the
          unpacked tree before any push; a layer is opaque to the
          repository's leak scan
        - development: a manifest entry may name a local folder instead
          of a digest, so a library can still be edited in place
        - a later layer overrides an object but cannot remove one; whether
          a whiteout is needed (OCI's deletion marker) is open, and how
          data/ rows of the same table combine (by file, by key) is too
```

---

## 2a. OSD: the tiers, and who owns which layer

The local system, working name OSD, the off-stack doppelganger. The tiers
say **when**, the layers say **who**; they are the same picture from two
angles and both were agreed across the three sessions on 2026-09-13.

```
Tier 1  OSD speaks ADT well enough for vsp
        waves 0-4 above, plus abapGit in a box as the way content gets in
        gate: vsp's wave 0-4 tools green against localhost, AND
              open-steamgate's own suites unchanged with the facade in
Tier 2  OSD speaks ADT well enough for an IDE. Not one thing: two, with
        very different costs, and the split was measured on 2026-09-13
Tier 2a VS Code, through murbani.vscode-abap-remote-fs on abap-adt-api.
        That client logs on with plain basic auth, no ticket and no RFC,
        and its login calls exactly one resource,
        /sap/bc/adt/compatibility/graph. We were 404ing it; one route was
        the whole distance. Served and tested now (03fa379), with an
        empty graph on purpose: a compatibility graph is a system saying
        which resources a client may use at which versions, and we have
        measured none of those facts
        honest scope: one route served and tested, NOT a connected client
        browsing a tree. What the extension asks for and we lack will
        name itself in /osd/not-served, which is the instrument
Tier 2b Eclipse. RE-COSTED 2026-09-14, because the premise was wrong:
        ADT is NOT only HTTP over the ICM. SADT_REST_RFC_ENDPOINT (function
        group SADT_REST) carries a whole HTTP exchange in one RFC call --
        REQUEST_LINE, HEADER_FIELDS, MESSAGE_BODY in, STATUS_LINE, headers,
        body out. Measured: GET /sap/bc/adt/discovery over RFC answered 200
        with the atomsvc document. Alice had sniffed this; the session had
        asserted the opposite without data. So the on-prem route is not
        "replay an unreplayable logon and then still need HTTP", it is "be
        an RFC server answering one function module", and the payload is
        already the shape the facade speaks. See docs/adt-facade.md.
        The old note below is kept for the reasoning it records.
        Eclipse, still on the logon, not on the ADT surface. Two forks:
        the on-prem project wants an RFC logon on 3399, costed at three
        to eight weeks with a real chance of never converging, because
        the logon-accept is a function of the client's init and cannot be
        replayed; the ABAP Cloud project wants the browser reentrance
        ticket, which is hours, because the ticket is opaque to Eclipse
        and only the accepting system validates it, and that is us
        cheapest next measurement: Alice pastes the string behind
        "Copy Logon URL to Clipboard", which names the loopback port,
        the path and whether a nonce is echoed                        [A]
        rule: an Eclipse capture stays in .local/, never in this repository
Tier 3  OSD speaks the rest: RFC and DIAG fronts, a screen that answers
        "not implemented" instead of nothing
        not ours to build: odgp already draws screens from Go with no
        system behind it, and the DIAG sibling carries the LZH writer
        (docs/layers-we-own.md). The spike is "can odgp answer a screen
        routed from OSD", and it is odgp's question
```

```
Layer                      Owner  What
protocol surface           S      the ADT facade: session, discovery, the
                                  resource tree, content handlers, ETags,
                                  locks; and the packaging that ships it
the object service seam    S      drafted as part of the facade contract:
                                  read, write, activate, delete, list,
                                  search, and the shape activation returns
                                  for an error. The facade never touches
                                  storage, the store never parses HTTP
what is behind it          T      the object store, the activation path
                                  (file, abaplint, transpile), abapGit in
                                  a box, APC and daemons
the client and yardstick   V      the calls a real development loop makes,
                                  the sanitized fixtures, the round trip
```

## W.1 branch plumbing, and what its first real run found (2026-09-19)

`node tools/osd-branch.mjs add <name> [--from <ref>] [--port N]` plants a
worktree with **its own port and its own database file**, `list`, `remove`.
`tools/osd-branch.mjs`, suite `test/osd-branch.mjs`.

The worktree half already existed — `tools/osd-worktree.mjs` shares
`node_modules`, `.local/lars` and `.local/tls` by symlink — and was nearly
written a second time. This is only what W.1 needs on top.

Three things a fresh worktree does not have, and all three fail quietly:

- **a port.** Asked of the operating system, not picked from a range. The
  first version read `address()` on the line after `listen()` and
  destructured `null`; a guess from a range would have worked most of the
  time, and when it did not, two branches would not error — they would
  answer each other's requests.
- **a build.** An unbuilt tree **listens**. It answers 503 to everything, so
  the first replay against one reported thirteen differences of "200 against
  503", which is a true statement about nothing. `isBuilt()` is checked and
  said out loud.
- **the packs' `upstream/`.** The third thing git does not carry. A fresh
  worktree refuses with `UNFETCHED`, correctly. It is **fetched, not shared**:
  a pack pins its upstream by commit in its own manifest, so a ref that moved
  the pin needs different content and a shared folder would quietly hand it
  the other branch's.

### The finding: a generation name is not a function of the commit

Two worktrees at one commit, built by the same command:

```
w1probe  build 1 -> f3ad1cc3189dd5c7
w1twin   build 1 -> fd5fd5a895011136      same commit, another name
w1twin   build 2 -> c0071cd2fef44a3e
w1probe  build 2 -> c0071cd2fef44a3e      the two converge
either   build 3 -> "already built"       and only now does the cache hit
```

`gen/` is an input to the generation hash **and is written by the build**, so
the hash is self-referential: the first build of a fresh tree names itself
from the pre-generation state, and no later build of that commit will ever
name that generation again. Consequences, in the order they cost something:

- "the build is cached by input hash, so the second branch is often free" is
  **false for the first build** of a fresh tree, always
- a generation reported by a freshly built system is not comparable with one
  reported by a settled system, at the same commit
- which is the mechanism behind the deploy rule already in force — compare
  the **commit**, never the generation hash

Not fixed here: `gen/` is an input on purpose (CLAUDE.md records why), so
taking it out is a decision about what a generation *is*, not a repair. What
is fixed is that it is now measured rather than surprising.

### What a planted branch does not isolate (2026-09-19)

`osd-branch` isolates a branch's **sources, port, database and build**. It
does not isolate its **libraries**, and that is not a detail:

```
.local/worktrees/<any>/.local/lars  ->  /home/alice/.../open-steamgate/.local/lars
```

Every worktree's `.local/lars` resolves to **one directory**. There is no
private checkout of `open-abap-core` — there is one checkout, and whoever
moves it moves it for every branch at once, in the middle of whatever
another session is measuring.

It surfaced as a disagreement about a count: 1140 objects against 1134, with
the repository's own objects matching **exactly** at 420, so all six of the
difference came from libraries the two sessions each believed they had.

So the earlier clean-tree numbers (2 failures, then 0; then 0 / 0 / 0) are
clean of **repository content and `$HOME`**, and not of libraries. The tests
in question do not depend on that part of `open-abap-core`, so the numbers
stand — but the boundary was stated more widely than it was measured, which
is the thing this tree keeps paying for, and naming it is the repair.
`tools/osd-branch.mjs` prints the list, with a reason per entry, on every
`add`.

### `npm run branch -- state`: a count that cannot travel alone (2026-09-19)

Two sessions read the object store 55 seconds apart and got **1140 and
1134**. Both readings were correct, and they were of different systems: the
library clones are ONE checkout shared by every worktree, and one session
had moved `open-abap-core` onto a PR branch twenty upstream commits away —
carrying exactly the six objects of the difference (`char5`, `char64`,
`char100`, `char200`, `cx_osql_failure`, `if_ixml_text`: four DTEL, one
CLAS, one INTF, matching the type deltas to the unit).

Nothing said so. `git status` in the repository does not see it, the input
list does not see it, and the number left without the state it was taken in.

`node tools/osd-branch.mjs state` prints the count, the types **and** the
HEAD, branch and dirty count of every library the build reads — together, so
one cannot be quoted without the others.

**And the first version of it lied within a minute.** `git -C` in a
directory that is not a repository answers about the **enclosing** one,
silently: `.local/lars/open-abap-apc` is a plain folder, and the tool
reported open-steamgate's own HEAD as that library's state. A number
travelling with somebody else's state is worse than one travelling with
none. It checks `--show-toplevel` against the folder now and says "not a
clone" rather than borrowing a hash — with a test that asserts no library
ever reports this repository's HEAD.

### gogen Go runtime: split `go/abap` into self-contained packages (2026-09-30)

Rule (Alice): new Go runtime work is idiomatic Go (channels, `select`, context deadlines) in its own small package
under `tools/gogen/go/<name>` with its own tests (`-race` where concurrent); generated code depends on those packages,
never the reverse. First instance: `tools/gogen/go/amc` (the AMC broker). Why: the Go build cache is per package,
so small packages compile and cache independently (the layered build of #254 took the ABAP Unit inventory from
7:25 to 37 s cold / 17 s warm), and an agent can hold one small package in its head.

Refactoring backlog: move out of the `go/abap` monolith, one PR each, behaviour unchanged, measured before/after
(cold + warm `go build` of the osgo host and the unit runner, `go test` time):
`dataset` (DATASET host + sandbox), `sxml`/`xml` helpers, `cmp` (generic comparison, `gencmp*.go`), `codepage`/`conv`,
`gzip`/`zip`, `osql` (where/writes/select), `unitdump`. Keep the public surface the emitter calls stable or change the
emitter in the same PR; `semantics.mjs`, the unit runner compare and the osgo-host smoke are the gates.

Tooling: `gopls` (not installed here yet: `go install golang.org/x/tools/gopls@latest`) for rename / extract /
"move declarations to a new file"-style code actions from the CLI; `gomvpkg` or plain `git mv` + `goimports` for
moving files between packages; `golangci-lint` and `goimports` are installed. GoLand's refactorings (Move across
packages, Change Signature) are available through its built-in MCP server when an IDE session is running on a
workstation -- optional, useful for large moves; never a CI dependency.


## Lazy table providers: one registry, routed like ICF handlers (2026-09-30)

Alice, 2026-09-30: a central way to fill tables lazily, whole or by key, on demand, with triggers.
Today there is none. Each case has its own logic:
- `data/*.tabu.json` seeds at start;
- the status tables (`ZOSD_SVC`, `ZOSD_PACK`, `ZOSD_SYS`) are written by a generator at build time;
- `hostRelation` gives AMDP a per-call relation;
- Go's `RegisterTables` is dictionary only.

- **Registry** (shaped like `src/icf/nodes.json`): table -> provider class implementing
  `zif_osd_table_provider` (`fill_all`, `fill_by_key( ranges )`, `invalidate`).
- **Policy per table:**
  - `eager` at start;
  - `lazy` whole on the first SELECT;
  - `by_key` from the WHERE's `=`/`IN` on key fields, cached per key. Any other WHERE falls back to whole.
- **Hook: the database seam** (`abap.context.databaseConnections["DEFAULT"]`, the one path ABAP reads data
  through). Before a SELECT on a registered table it makes sure the requested part is filled; any other table
  costs one map lookup. Node, Go and the preview get it from one place, which is the lesson of
  `tools/osd-dialog-step.mjs`: a rule for every host lives in a module they all import.
- **Fill runs as ABAP in its own dialog step** (work-process lock, commit on success, rollback on a dump),
  so a failed fill leaves nothing half-written. A provider writes only its own table: no state shared between
  processes (see the no-shared-table-state decision).
- **Triggers for invalidation:**
  - git HEAD change;
  - a saved file (warm compile);
  - a new generation;
  - an explicit `invalidate`.
- **Consumers:**
  1. `VRSD` for versions out of git (adt.md);
  2. **the cross-reference, which already exists as a hand-wired eager provider**: `CROSS`, `WBCROSSGT`,
     `WBCROSSGTX`, `D010INC`, parsed by `tools/osd-xref.mjs` (~3 s on the full tree, cached per generation) and
     seeded by five callers through `tools/osd-xref-seed.mjs`. In the registry it starts as `eager` (same
     behaviour, one wiring instead of five), then `lazy` to take the parse off host start, then `by_key` per
     object so a warm edit re-derives only the rows of the edited object instead of the whole tree. vsp's
     where-used and the Readers CodeLens read the same tables, unchanged;
  3. the status tables, moved from build time to on demand;
  4. later, reference data fetched from an RFC destination on first use.
- **Open questions:**
  - A SELECT with a JOIN touching a lazy table: fill whole first.
  - Sorting and paging over a partial `by_key` fill: only keys asked are present, which is correct for a
    by-key read and wrong for a scan. A scan falls back to whole.

## Parallel ABAP Unit and the next runtimes (2026-09-30, planned for 0.5 / 0.6)

Alice, 2026-09-30. It follows U3 (Go ABAP Unit parity with Node, 0 DIFFERENT).

**0.5 -- parallel ABAP Unit on Go (U4).**
- Step 1: process sharding. The test binary runs N times, and each process takes its share of classes. Each process
  has its own in-memory SQLite, so they share nothing.
- Step 2: goroutines. The seed runs once into a template database, and each unit gets its own copy of that image
  (serialize/deserialize, the backup API or `VACUUM INTO`; check the Go driver). The global `db`/`conn()` (`luw.go`,
  `db.go`) and the class statics move into the Session.
- The unit of isolation is the **test class**. Measured on A4H 2026-09-30 with two local test classes and a class
  with CLASS-DATA plus a class constructor: each test class gets a fresh internal session (statics reset, class
  constructor run again), and the test methods of one class share statics.
- Our Node and Go runners probably keep statics across test classes: a parity gap with SAP. Check it, write an
  ANORMALIES entry and fix both runners.
- Verify with `go test -race`. Measure Node, Go serial, Go xN with one instrument.
- The same step-2 refactor (Session instead of globals) is the first half of a multi-work-process OSGo server.

**0.6 -- IR-JS parity as a third column.** `unit-compare` shows Node / Go / IR-JS. `emit-js.mjs` already runs the
semantics harness, so DB-free tests (template engine, AJSON, parsers, compares) come first. DB tests need IR-JS on
the same `DatabaseClient` seam, a separate and larger step. ADR 0004 still holds: IR-JS is an oracle, not a runtime.

**0.6 -- the Go side of host relations: in-memory tables read in place.** `tools/ir-host-relation.mjs` (#56/#57) is
the contract agreed with the Go runtime on 2026-09-24. An AMDP IN table or a FOR ALL ENTRIES itab reaches the plan as
a relation for one call. JS is the reference and copies the rows once; the Go client was to answer with a **SQLite
virtual table over the host's own memory**, and that part was never built (no vtab under `tools/gogen/go`).
- The precondition is stable row storage in Go tables (U3 wave 3, 2026-09-30: references to rows survive inserts,
  appends and deletes).
- Gate: `tools/ir-host-relation-pairs.mjs`.
- Scope: per call only, which is the decision already taken. There is no shared state between ABAP and a SQL engine
  beyond one call.
- The wider proposal, one DB IR for both runtimes (`docs/pamdp-ir-portability.md`, 2026-09-23), is still a
  proposal awaiting Alice, and pAMDP is parked. The vtab does not depend on it.

**0.6 -- the OSGo dispatcher: hot generation swap behind a stable front, then several work processes.** One track,
two halves of one architecture (Alice, 2026-09-30, joining her 2026-09-23 reload decision with the multi-WP server).
The 2026-09-23 precondition, "not before OSGo parity with OSG on JS", is met by U3 (0 DIFFERENT).
1. Generation gate around the dialog step (the smallest first step of 2026-09-23): count the active steps, stop
   admitting new ones, drain, tag each session with its generation. A new generation is a new Go binary; the
   old one drains.
2. The dispatcher proxy: small and stable, it holds HTTP, WS, session -> generation and ENQUEUE. New sessions and
   stateless requests go to the newest binary; an open session stays pinned to its generation, and an old binary
   retires when its last session ends (no roll-area serialisation). The cut is at the entry of the call stack
   (request, WS message, GUI step), never per class.
3. Several work processes inside one generation: N goroutines on a shared database outside the process (SQLite WAL
   first, then DuckDB / Postgres), one transaction per dialog step; serialise only where SAP does (ENQUEUE, V2 update),
   replacing today's single FIFO lock. Built on the 0.5 Session refactor.
4. "Icicles" (2026-09-23): one small binary per entry point, routed by path. An optimisation after the rest.
Shared prerequisites: DB out of process and shared, Session instead of globals, cut at the entry. Derived tables
filled lazily (ADR 0005) must then publish atomically across processes, not per process (astra's review, 2026-09-30).

**Noted:** `zcl_stg_segw_gen=>mpc_source` through the DSL (#293) takes 3.6 s against 0.94 s before on the largest
project in OSG, while the same engine on A4H is ~4x faster. That makes it a runtime performance case to profile.

## Release plan with priorities (2026-09-30)

Alice, 2026-09-30: every item per release is marked.
- **must**: the release does not ship without it.
- **should**: expected; deferred only with a stated reason.
- **nice**: if time allows.
- **generous**: only if we are being really generous.

**The rule that makes this work:** a release is tagged when its **must** items are done, and nothing else blocks it.
An unfinished should/nice/generous item moves to the next release with one line of reason; it never holds a tag.
A new idea found during a release goes in as nice or generous for a later one, unless it is a correctness bug in
something already shipped (then it is a must of the current release, like the row references in 0.4).

**0.4** (the next tag, on Alice's yes)
- must: U3 wave 3 merged. Go ABAP Unit parity with Node at 0 DIFFERENT, with the 12 reviewed nodeAnomaly rows.
- must: stable row references in Go tables, and NOT_COMPILED and dumps uncatchable by ABAP CATCH (the last wave-3
  blocker; also a possible silent bug on main).
- must: the release draft built by CI, and its artefacts checked by content.
- should: the honest speed measurement, Node vs Go on the whole intersection, one instrument.
  **Measured 2026-09-30 (stoker)** at 464ff680 with the pinned transpiler e97e82c7, on the green intersection that
  wave 3's compare named (35 classes, 289 methods, all SAME, re-verified at that SHA). Instrument: `unit-bench.mjs`
  with `/usr/bin/time -f '%e %U %S %M'`, 3 samples, median, under `flock /tmp/osd-heavy.lock` with nothing else
  running, on an i7-10700K (16 threads).

  | | wall | cpu (user+sys) | peak memory |
  |---|---|---|---|
  | Node, the 35 classes | 16.32 s | 19.06 s | 830 MB |
  | Go run, the 35 classes | 13.07 s | 13.14 s | 132 MB |
  | Node, the 31 without TIMER/AMC/LUW/BATCH_RUNNER | 14.47 s | 18.41 s | 964 MB |
  | Go run, the same 31 | 11.68 s | 12.71 s | 133 MB |
  | Go cold build (empty GOCACHE) | 19.68 s | 93.3 s | 937 MB |
  | Go warm build | 0.13 s | 0.34 s | 31 MB |

  Go runs the intersection 1.25x faster on wall time, 1.45x on cpu, with 6.3x less peak memory. The suite is not
  wait-bound: Go's cpu equals its wall, and dropping the classes that wait does not move the ratios. Profile before
  quoting; the expected dominant cost is the per-class seed replay (each DB-opening class runs `OpenDB` over the
  ~10.9 MB seed script), which U4 step 2 (image copy) targets. A cold build costs more than a whole Node run; a
  warm rebuild is nearly free.

  **Seed image profile and measurement (2026-10-01):** A CPU profile of the Go Unit inventory before the image
  change sampled 16.90 s. `abap.OpenDB` accounted for 10.62 s cumulative (62.8%). The top flat costs were
  `linux.Syscall6` 2.16 s, `libc.Xmemcpy` 1.41 s, SQLite bind 1.29 s, SQLite allocation 0.76 s, and JSON validation
  0.57 s. `OpenDB`'s repeated statement execution and JSON decoding were therefore the main cost. The image is seeded
  once, serialized with modernc SQLite, and deserialized onto a private connection for each DB-using test class.

  The old 35-class list was not retained with the baseline, and the current inventory has changed. For a matched
  before/after comparison, both binaries used the **same current 51-owner inventory** and the same generated seed;
  each had three runs under `flock /tmp/osd-heavy.lock`, with `/usr/bin/time -f '%e %U %S %M'`. These numbers must
  not be compared directly with the 35-class table above.

  | Current 51-owner Go inventory | median wall | median cpu (user+sys) | median peak memory |
  |---|---:|---:|---:|
  | Seed replay per DB class | 17.07 s | 17.41 s | 141,460 KiB |
  | Seed image copy per DB class | 8.65 s | 8.29 s | 127,852 KiB |

  Full Node/Go compare counts before and after stayed at 384 SAME, 6 DIFFERENT, 13 nodeAnomaly, 161 Node-only,
  0 Go-only and 1 SKIPPED. A Go test also checks that a class's inserted row is absent from the next class image.

  **U4 step 1b, process shards (2026-10-01):** With all pinned source packs fetched, the same 51-owner inventory
  was built once per invocation and run with `--jobs 1,2,4,8,16`. Each configuration had three runs under
  `flock /tmp/osd-heavy.lock`, timed with
  `/usr/bin/time -f '%e %U %S %M'` (wall seconds, user seconds, system seconds, peak KiB), as in `unit-bench.mjs`.
  The table reports medians. Runner wall is `timingMs.run` from the same reports; total wall includes frontend and
  Go build. Every one of the 15 reports had the same 565 class/method/status/message rows as `--jobs 1`.

  | Jobs | total wall | total CPU | peak RSS | runner wall |
  |---:|---:|---:|---:|---:|
  | 1 | 22.08 s | 27.34 s | 1,009,448 KiB | 8.31 s |
  | 2 | 19.56 s | 29.35 s | 1,018,404 KiB | 5.04 s |
  | 4 | 18.70 s | 28.45 s | 988,504 KiB | 5.02 s |
  | 8 | 19.99 s | 31.68 s | 986,880 KiB | 5.69 s |
  | 16 | 19.53 s | 31.63 s | 988,736 KiB | 5.08 s |

  Four processes gave the lowest median total wall on this eight-core allocation. Two and four had almost identical
  runner times; eight and sixteen spent more CPU without a further gain. Each shard gets its own temp and DATASET
  directory, including its audit file; the media tree and SQLite seed image are read-only inputs written once before
  processes start. No ABAP Unit class in this inventory binds an HTTP
  or APC listening port: the Go network listeners found are in Go tests, not the generated Unit binary. The only
  shard-owned files under the build directory are its class list, timings, temp files, and DATASET files; the parent
  writes the one timing report. A failed shard assigns its process error to every method it owned.

  **U4 timing breakdown (2026-10-01):** A follow-up instrumented the same 51-owner, 76-test-class inventory.
  `unit.mjs` now reports discovery, frontend, emission, build, seed, per-shard start/end and class times in
  `timingMs`; each Go process also writes its seed/setup duration. These are individual runs under the same
  `/tmp/osd-heavy.lock` and `/usr/bin/time` instrument, so they show phase proportions rather than replacing
  the three-run medians above. The 1- and 4-job runs had identical 565 result rows.

  | Phase | jobs 1 | jobs 4 |
  |---|---:|---:|
  | Total wall (`/usr/bin/time`) | 29.10 s | 25.62 s |
  | Discovery/preparation before emission | 1.19 s | 1.15 s |
  | Frontend closure rounds | 12.10 s | 13.54 s |
  | Emit Go and seed script | 0.81 s | 0.78 s |
  | Go build | 5.17 s | 4.31 s |
  | Runner, including seed and merge | 9.50 s | 5.45 s |
  | Seed image creation inside runner | 0.27 s | 0.27 s |
  | Sum of test-class times / critical shard | 9.21 s | 5.14 s |
  | Merge results and timing file | — | <0.01 s |

  Four-shard start/end times relative to runner start were 0.27–1.29, 0.28–1.38, 0.28–5.45 and 0.29–2.07 s;
  their respective class-time sums were 0.99, 1.07, 5.14 and 1.73 s. The critical shard contains
  `ZCL_OSD_DEMO_DATA:LTCL_DEMO_DATA` (4.61 s in this run; 5.17 s with one job). The next longest class was
  `ZCL_OSD_AMC_TEST:LTCL_AMC` at about 1.06 s. The four-shard wall is already only 0.31 s over its critical
  shard's class time, so further shard scheduling cannot materially shorten this run. Existing LPT scheduling
  uses a previous `class-timings.json` when one is present; a fresh output directory has no history.

  The 8.65 s seed-image figure above timed **only the already-built Go binary**. Re-running that binary from
  this inventory under the same lock and `/usr/bin/time` took 8.16 s. The 22.08/18.70 s shard table and this
  breakdown time the **whole Node command**, including frontend and Go build. That scope difference explains
  the apparent regression; the remaining variation between full-command runs is mainly frontend/build timing.
  The measurement fix is to keep binary-only and full-command figures separately and retain phase/shard timings
  in the runner. No execution-path optimization follows from these numbers: the four-shard runner is near its
  measured lower bound, while most full-command time is compilation outside the shard path.


  **U4 frontend snapshot (2026-10-02):** `tools/gogen/frontend-cache.mjs` stores the whole closure's emitted
  Go, unit runner and SQLite seed script under `.local/gogen-frontend-cache/`, keyed by contents of ordered
  input layers (including pinned library trees and packs), ABAP source, test includes, DDIC and seed data,
  the generator modules, configuration, dependency lock, and Go runtime sources. A changed input rebuilds
  the whole closure; per-class invalidation is deferred. `--no-cache` bypasses it. Entries are written to a
  temporary directory and renamed only after Go compilation succeeds.

  The same `/usr/bin/time -f '%e %U %S %M'` instrument measured the full `node tools/gogen/unit.mjs --jobs 4`
  command three times per case in this worktree. Empty-cache runs removed the snapshot before each sample;
  changed-input runs made a distinct comment edit to one test include per sample and restored the file.
  Go's build cache was warm in all samples. The current worktree's 53-owner, 586-row inventory exits 1 in
  every case because some Go backend tests fail; it is not the earlier 51-owner green inventory.

  | Full command | wall samples (s) | median wall | frontend on median case |
  |---|---|---:|---:|
  | Empty snapshot | 17.91, 16.40, 19.48 | 17.91 s | 7.12 s |
  | Unchanged snapshot | 5.15, 5.47, 5.99 | 5.47 s | 0 s |
  | Edited test include | 12.28, 11.64, 12.59 | 12.28 s | 6.60 s |

  Every warm sample was a hit; every empty or edited sample was a miss. Class, method, status and message
  rows matched between a cached run and `--no-cache` (586 of 586). The edited runs rebuilt the full
  closure as designed. Their shorter wall time than the empty runs reflects warm Go build and runner caches,
  not partial frontend invalidation.
- nice: accept ADR 0005 (lazy table providers) -- done 2026-09-30, narrowed after three reviews.

**0.5**
- must: O, program -> binary. F4 and dialogs in the TUI, Open SQL in the native build, `osd run ZREPORT` = F8.
  `osd run <report.prog.abap>` and F8 on a PROG in VS Code: done (tools/osd-run.mjs, kept builds by source hash; docs/osabap-native.md "osd run").
- must: check and record in ANORMALIES whether our Node/Go runners keep class statics across test classes (A4H
  resets them per test class).
  **Done 2026-09-30 (stoker): both keep them.** In the second test class the counter reads 3 where A4H reads 1,
  on Node and on Go alike. See `ANOMALY-2026-09-30-unit-statics-across-test-classes`, with the fixture in
  `test/fixtures/unit-statics/`. The Go half of the fix is U4 step 2 below; the Node half needs a transpiler issue.
- **status 2026-10-01 (dell):** The SQL corpus of the native build is 18/18, merged (#349).
  Class statics are reset per test class on Go, merged (#365); the Node half stays an upstream issue.
  F4 and the file/folder dialogs in the TUI: branch feat/osabap-f4-file-dialogs.
- should (moved from must, 2026-10-01, decided with codex-astra): **the table-header row model.** The version moves from
  the weak-keyed side map onto the table: `type Itab[T any] struct { Rows []T; ver uint64 }` (`Itab[*T]` for stable
  rows). The version belongs to the destination storage, not the copied ABAP value: a clone starts with its own
  version, an assignment into an existing table keeps and bumps the destination's. Slices, each gated on 388 SAME:
  (1) centralise the emitter's table access/replacement/mutation while keeping slices and the map; (2) add `Itab` and
  header bindings next to the legacy path; (3) an opt-in header backend for the whole generated type graph, parity on
  both backends -- the first slice that removes the lookup cost; (4) headers by default, then delete the map, cache,
  bloom filter and cleanup. **Why not must:** it removes bookkeeping, not a correctness gap. The bloom filter (#337)
  already took the long report from 41 s to 28 s, and the open question in ANOMALY-2026-09-30-go-row-binding-model
  (whether a scalar binding survives a structural change on SAP) is not answered by moving the counter; measure that
  on A4H first. Statics, DB and LUW in the session (U4 step 2) are the prerequisite for parallel classes, not this.
- nice (foreman-dell, after U3 wave 3): the Go generator refuses to read another class's public static attribute in
  an expression (`cl_abap_unit_assert=>assert_equals( act = zcl_x=>gv_attr … )` is NOT_COMPILED, alert
  `ZCL_X=>GV_ATTR`). `--fixture` mode also reports a failed assertion as `KERNEL_CX_ASSERT` without its text.
- should: U4 step 1, process sharding of ABAP Unit on Go.
- should: U4 step 2, Session-owned statics/DB/LUW, one goroutine per test class on a copy of the seed image; statics
  reset per test class as on A4H.
  Move class statics into the session before parallel classes; see session.Reset.
- should: profile the Go unit binary (pprof) on the 35-class intersection, splitting seed replay / `OpenDB`,
  emit-time init and the test bodies, before U4 step 2 is built, so its gain can be measured against a baseline.
- should: lazy tables slice 1 (ADR 0005, accepted narrowed): the xref filled eager in its own step after the host
  listens, host readers await it; measure start and the cold first read; `lazy` only after those numbers.
- nice: `SVRS_*` substitutes over #288's history (by key inside the FM); a `VRSD` table only once standard ABAP
  that reads it enters the tree (ADR 0005, gated part).
- nice: D, daemons DX: `osd samc --derive/--check` on DSL L1, CodeLens from the trace sidecar.
- nice: Node ABAP Unit in worker_threads, one DB copy each.
- must (added 2026-10-01, a correctness gap in shipped code): Go loses what a method wrote before it raised
  `cx_sxml_parse_error` (ZCL_OSD_SXML_STREAM_TEST `ltcl_pull->error_offset` / `utf16_offset` FAILED on Go: the events
  string built before the RAISE is gone). Measure on A4H which writes survive a RAISE (by-reference CHANGING, an
  attribute, EXPORTING by value) and match it. Owner: dell.
- should (added 2026-10-01, Alice's yes): **native sXML, inflate and CRC32 in gogen.** The report keeps its ABAP;
  ZCL_OSD_SXML_PULL, ZCL_OSD_INFLATE and ZCL_OSD_CRC32 get Go host implementations behind the same classes, checked
  by the same suites (the A4H-recorded sXML contract at every split, the zip tests). Baseline: the 150 MB XML
  converter report streams in 21.4 s at 29 MB RSS (#380); target ~10 s, output byte-identical. Node keeps the ABAP
  path for now (estimated 30-90 s; a measurement decides whether Node gets the same hook). Owner: stoker.
- nice (added 2026-10-01): the three Go compile gaps ZCL_OSD_SXML_STREAM_TEST shows (ASSERT_NUMBER, a comparison of
  x with x, a parameter DEFAULT that names a class constant). Owner: dell.

**0.6**
- should: the Go side of host relations. A SQLite virtual table over stable Go rows, per call, gated by
  `ir-host-relation-pairs.mjs`.
- should: the OSGo dispatcher track, step 1, the generation gate around the dialog step.
- should: the OSGo dispatcher track, steps 2-3, the dispatcher proxy with generation-pinned sessions, then several
  work processes on a shared DB.
- generous: the OSGo dispatcher track, step 4, icicles (one binary per entry point).
- nice: IR-JS as a third `unit-compare` column, DB-free tests first.
- nice: profile the #293 slowdown (MPC through the DSL: 3.6 s against 0.94 s in OSG).
- generous: IR-JS on the database seam, so DB tests run too.
- generous: one DB IR for both runtimes (`docs/pamdp-ir-portability.md`, a proposal; pAMDP parked).
- generous: the lazy-table status group (needs the pooled snapshot design first).
- should (added 2026-10-01): **jobs facade, start by date/time and periodic starts.** `JOB_CLOSE` takes
  `SDLSTRTDT`/`SDLSTRTTM`, `LASTSTRTDT`/`LASTSTRTTM` and `PRDMINS`/`PRDHOURS`/`PRDDAYS`/`PRDWEEKS` (system time;
  a past start rewritten to the close time; past start + past latest start = `INVALID_STARTDATE`, BT 386, stays P);
  a released time job is S with its TBTCO fields; the scheduler (`tools/osd-job-scheduler.mjs`) runs on one
  injectable clock, every start through the dialog step; the successor is made at an instance's start, due at the
  scheduled time + period, no instance skipped; `BP_JOB_DELETE` of the waiting successor ends the chain. Gated by
  the sandbox fixtures in `test/fixtures/jobs-periodic/` (docs/job-standard-fms.md, Periodic jobs). Owner:
  osg-research; reviewer: dell (the jobs facade). Follow-ups, nice: `PRDMONTHS` once month-end rules are measured;
  `BP_JOB_ABORT` and side-by-side instances with the multi-work-process dispatcher (ANOMALY-2026-10-01-periodic-jobs-queue).
- nice (added 2026-10-01): pAMDP `XMLTABLE` / `XMLEXTRACT(VALUE)` / `SELECT ... FOR XML` over the streaming sXML
  parser. Measured on A4H HANA 2.00.075: `XMLTABLE` reads ~5.8 MB/s at ~23 bytes of HANA memory per XML byte (166 MB:
  28.6 s, 3.9 GB); over the streaming parser the memory is the window. Owner: osg-research.
- nice (added 2026-10-01): carve the ABAP snippets (preflight, receipt, cleanup, residue) out of
  `tools/osd-prove-on-system.mjs` into a module of their own, so its size budget (1674 lines, re-taken after #409 in
  #412) can come down. Behaviour unchanged, `test/prove-on-system.mjs` and `test/prove-inplace.mjs` the gate. Owner:
  osg-research.

## The lock server (ENQ) and the ADT façade in ABAP (2026-10-01, spike-sprint for 0.6)

Why now: vsp's integration suite against `osd` 0.4.1444 (2026-10-01) found that two sessions can lock one object
and that a stateless request drops a session's ADT locks. The façade's lock map is a private enqueue table. Two 0.6
items need a real one: the ADT façade moving to ABAP (Alice and stoker, 2026-10-01: a lock becomes an ordinary
`ENQUEUE_*` call, as on a system) and the OSGo dispatcher's several work processes (above: "serialise only where
SAP does (ENQUEUE, V2 update)"). Alice, 2026-10-01: start in-process as a goroutine, then the same protocol over a
socket. Clean room: the contract is measured on A4H as a client (Alice: test there as much as needed); no SAP
kernel or server code is read.

Labels follow the release rule: only a must blocks its tag.

**0.4.x patch (Node façade, already shipped code)**
- must: a stateless request keeps the stateful session's locks (`tools/adt-session.mjs`); LOCK, a stateless read,
  PUT answers 200 as on A4H. Owner: dell. Branch `fix/adt-lock-session`.
- must: a database error reaches the client with its text (the wrapped `CX_SY_DYNAMIC_OSQL_SEMANTICS` had an empty
  JS message). Owner: dell.
- should: one lock owner per object across sessions in the façade; a second session is refused with the holder's
  name. Replaced by ENQ E1 when the façade moves to ABAP. Owner: dell.
- should: a package created over ADT (stateless, no packageRef) is visible at once to nodestructure, quickSearch,
  LOCK and DELETE. Owner: dell; becomes a conformance case (osg-research).
- should: `POST .../oo/classes/<name>/includes` creates a test-class include. Owner: dell.

**0.5** -- nothing here blocks the 0.5 tag.

**0.6 -- ENQ, the lock server**
- must: **E0, the contract measured on A4H.** Throwaway lock objects in `$ZOSG_TMP`, deleted afterwards. Measure:
  the E/S/X/O compatibility matrix, same-owner cumulation (E twice, E after S), argument masks and initial fields,
  `_SCOPE` 1/2/3 and what COMMIT WORK / ROLLBACK WORK / the end of the session release, `_WAIT`, `FOREIGN_LOCK` with
  `sy-msgv1` = the holder, `DEQUEUE_ALL`, and the row shape of `ENQUEUE_READ`. Recorded as fixtures with
  `EXPECT` = what A4H answered. Owner: dell.
- must: **E1, the lock table as one goroutine.** Own package `tools/gogen/go/enq` (go-runtime-self-contained
  rule): one goroutine owns the table, requests arrive on a channel, no mutex; owner = session + LUW; release on
  scope rules and on session end. The same contract in-process on Node (one module all hosts import, the
  `osd-dialog-step` lesson). ABAP side: `ENQUEUE_<obj>` / `DEQUEUE_<obj>` generated from lock objects (abapGit
  `ENQU`), `DEQUEUE_ALL`, `ENQUEUE_READ`. Gate: every E0 fixture SAME on Go and Node. Owners: stoker (Go), dell
  (ABAP generation, Node host).
  **Done 2026-10-02** (#393 Go, #403 Node core, #410 every host through the generated modules): 77/77 on the Go
  and Node cores; 73/77 as ABAP, the 4 `update-window-*` cases skipped by name -- the item below.
- should: **an asynchronous update task** (`CALL FUNCTION ... IN UPDATE TASK` queued until COMMIT WORK, V1 run
  after it, `COMMIT WORK AND WAIT` waiting for it, ROLLBACK discarding the queue). Today the runtime calls an
  update module at once, so the window between COMMIT WORK and the update -- where the committed session's own
  `_SCOPE 2` lock answers 601 -- does not exist locally (ANOMALY-2026-10-02-update-task-synchronous). Needs the
  transpiler to mark `IN UPDATE TASK` calls (today it emits a plain call) or a runtime hook; the gate is the 4
  skipped `update-window-*` cases in `test/osd-enq-abap.mjs`. Owner: stoker.
- must: **ADT façade skeleton in ABAP** (ADR 0007): an ICF handler for `/sap/bc/adt/*`, our own URL router, CSRF,
  the stateful session; ADT LOCK/UNLOCK call ENQ E1. The ABAP façade replaces the Node one only when vsp's
  scenarios and the A4H diff harness pass for what it serves (migration by diff against OSG-JS). Owner: dell.
- should: ADT endpoint groups on the skeleton, in parallel: versions + lock/write/unlock/activate (stoker);
  search, nodestructure, source read (osg-research); check, ABAP Unit, data preview (dell).
- should: **E2, the same protocol over a socket.** A local socket (unix socket, or 127.0.0.1 on Windows), no
  authentication, never on a public address. The lock server runs as its own process; OSGo work processes and
  OSG-JS are its clients. A client holds its locks under a lease with a heartbeat, so a dead process's locks go.
  Lands with the dispatcher's several work processes. Owner: stoker.
- should: the CROSS `PROG` and WBCROSSGT `DIRECT` columns, for vsp's callee queries. Owner: osg-research (with
  the where-used group).
- nice: a writable `$TMP` and LOCK on a package, so a test can create and clean up its own package.

**0.7**
- nice: **E3, an SM12 view.** The lock table in the VS Code tree and as a Fiori app over an OData service
  (`ENQUEUE_READ` underneath), with a manual release -- not a webgui screen (docs/backlog/webgui.md, "Where a new
  service app goes").
- generous: a lock table that survives the lock server's restart (replication, as a standalone enqueue server
  keeps it). Only if a measured case needs it.

## ADT on OSGo: what the Go side lacks (measured 2026-10-03)

A compile-and-unit survey of the ADT classes on OSGo after the ADT port's
`PORT_PENDING` reached 0: all 49 ADT classes compile, with 39 statement traps
in 24 methods; their ABAP Unit gives 94 passing and 55 NOT_COMPILED methods,
no failed assertion; `/sap/bc/adt` is not mounted on OSGo (discovery 404).
Whether to serve read-only ADT on OSGo is Alice's call (estimate: several M
slices plus two L integrations -- sessions/ENQ on Go and a parser seam).

- must (parity, independent of ADT): **`ZOSD_STORE`'s Go signature is behind
  the ABAP callers.** `CALL FUNCTION 'ZOSD_STORE'` traps on OSGo because
  `IV_JSON`, `EV_JSON` and `EV_STATE` are not in the host's signature (five
  call sites in ZCL_OSD_ADT_HOST, _DDIC, _FREESTYLE, _VERSIONS). Bring the Go
  destination's signature to the JSON envelope the ABAP side uses. [S/M]
  Owner: stoker.
- should: the small runtime gaps the survey hit -- `WHERE ... NP` on an
  internal table, `CONVERT TIME STAMP ... INTO DATE ... TIME`, converting and
  re-raising an exception reference -- each with a focused parity probe. [M]
  Owner: stoker.
