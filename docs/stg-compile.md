# stg-compile: the SEGW project as one file

SEGW is two things: an editor for a project tree and a generator. We have
the generator (`tools/segw-gen.mjs`: tree → `_MPC`/`_DPC`). `tools/stg-compile.mjs`
is the editor without the GUI: a `<service>.stg.yaml` describes the
service, the compiler writes the tree exactly as abapGit serializes it
(`<project>.iwpr.xml`), the two registration objects (`<service> 0001.iwsv.xml`,
`<model> 0001.iwmo.xml`) and, through segw-gen, the four classes. Deploy the
folder with abapGit and SEGW on the system opens a normal project; here,
`tools/segw-registry.mjs` registers the service from the same objects.

```sh
npm run stg:compile -- src/demo/zstg_demo.stg.yaml            # the tree to stdout
npm run stg:compile -- src/demo/zstg_demo.stg.yaml --out gen/demo
npm run segw:gen -- gen/demo --check                           # identical, of course
npm run segw -- gen/demo --list                                # what the registry would register
```

The `_EXT` pair is written only when missing: it is the developer's code.
A second compile after editing the YAML rewrites the tree and the base
classes and leaves `_EXT` alone, which is what SEGW's "Generate" does.

Node identifiers in the tree are a hash of project, kind and name, so the
same file gives the same bytes; a diff of two compiles is a diff of the
model. The tree is written in SEGW's own shape (`tools/segw-tables.json`,
the field set and order derived from real projects, `docs/segw-tree.md`):
`npm run segw:tree import` takes a compiled file into the `ZSTG_SB*` tables
and `export` gives the same bytes back.

## The file

```yaml
project: ZSTG_DEMO              # SEGW project; classes ZCL_<project>_MPC/_DPC(+_EXT)
service: ZSTG_DEMO_SRV          # technical = external name, version 0001
model: ZSTG_DEMO_MDL            # default <project>_MDL
description: "…"
classes: {mpc: …, dpc: …}       # optional overrides (mpc, mpc_ext, dpc, dpc_ext)

entities:
  Travel:
    set: TravelSet              # default <name>Set
    source: {struct: ZSTG_DEMO} # the ABAP structure behind the type (bind_structure)
            {table: ZSTG_DEMO_BK}   # a DDIC table served by SADL: the DPC delegates
            {cds: ZSTG_I_STATUS}    # a CDS view served by SADL
            {service: ZSTG_SADL_SRV, set: Zc_Stg_TravelSet}   # another service of this
            #   registry, consumed in-process (SEGW's "external service", local flavour)
            # none: the base class declares TS_<entity> from the properties
    keys: [TravelId]
    properties:
      TravelId: String(8)       # shorthand: <Edm type>(<length>) or Decimal(<digits>,<scale>)
      Seats: {type: Int32, field: SEATS, label: Seats, nullable: true}
      StatusText: {type: String(40), readonly: true, sortable: false, filterable: false}
    creatable: true             # set flags: creatable updatable deletable pageable
    searchable: true            # addressable searchable subscribable filterRequired
    operations: [C, R, U, D, Q] # the DPC methods SEGW writes; default all five
    operations:                 # ...or, per operation, SEGW's "Map to Data Source"
      query:
        function: EPM-RFC-MODULE      # an RFC/BOR module
        group: EPM-FG         # its function group (optional)
        destination: NONE                    # RFC destination (optional)
        log: ET_RETURN                       # the BAPIRET2 table (optional)
        ranges: {ProductId: IT_PRODUCT_ID_RANGE}   # $filter -> range table (HIGH/LOW/OPTION/SIGN)
        constants: {"IT_CONTROL\VALUE": "'X'"}     # parameter path -> literal
        out: {ProductId: "ET_LIST\PRODUCT_ID"}     # response side: property <- parameter path
      read:
        function: EPM-RFC-MODULE-2
        in: {ProductId: IV_PRODUCT_ID}             # request side: property -> parameter path
        out: {ProductId: "ES_PRODUCT\PRODUCT_ID"}
      # or a search help instead of a module:
      #   query: {searchhelp: ZSTG_STATUS_SH, in: {Status: STATUS}, out: {Status: "RESULT_LIST\STATUS"}}

associations:
  TravelToBookings:
    from: Travel
    to: Booking
    cardinality: 1:N            # 1:1, 1:N, N:1, N:N (0..1 as 0)
    constraint: {TravelId: TravelId}          # principal (from) -> dependent (to)
    navigation: {Travel: to_Bookings, Booking: to_Travel}
    set: TravelToBookingsSet    # default <name>Set

functions:
  CancelTravel:
    method: POST
    returns: {entity: Travel, set: TravelSet, multiplicity: "1"}
    for: Travel
    parameters:
      TravelId: {type: String(8), field: TRAVEL_ID}
```

Property defaults: `field` = the name in upper case; creatable, updatable,
sortable, filterable = true; nullable = true; a key is not nullable and not
updatable; `readonly: true` turns creatable and updatable off. Labels
become `PROP_LABEL` in the tree (SEGW's text elements are not generated;
the label lives in the tree for the next step).

## What it is checked against

`test/stg-compile.mjs`: the demo's YAML (`src/demo/zstg_demo.stg.yaml`)
reads back through segw-gen as the same model, the generated MPC defines
what the hand-written `zcl_zstg_demo_mpc` defines, the IWSV/IWMO come out
byte-identical to the demo's, `table:`/`cds:` become SADL delegation, and
the compiled classes lint clean against the libraries. The hand-written
demo classes stay as they are: they are the showcase of real DPC code; the
YAML is the same model in the form a system-less workflow edits.

## Complex types (`complexTypes:`)

```yaml
complexTypes:
  Address:                        # SBO_CT, its properties SBO_PR rows below it
    properties: {Street: String(40), City: String(40)}
  Money:
    source: {struct: ZSTG_MONEY}  # bind_structure instead of a declared TYPES block
    properties: {Amount: Decimal(15,2), Currency: String(5)}
entities:
  Customer:
    properties:
      Address: {type: Address, field: ADDR}   # a complex property: create_complex_property
functions:
  Quote: {method: GET, returns: {complexType: Money}}   # set_return_complex_type
```

A property whose `type` names a complex type is a complex property: the
tree row carries `COMPLEX_TYPE` and no Edm type, every flag cleared as
SEGW writes it, and the `_MPC` declares the entity's structure component
with the complex type's type (`ADDR type ADDRESS`) and defines the type in
`DEFINE_COMPLEXTYPES`. A complex property cannot be a key. What segw-gen
makes of it is what the search sample project has.

## Operations mapped to a module or a search help

A map under `operations` is SEGW's "Map to Data Source" per operation
(`docs/segw-mapping.md` has what the tree stores and what the DPC gets):
`function:` writes a data source of type 2, `searchhelp:` one of type 6,
`in`/`out`/`ranges`/`constants` become the `SBD_MP`/`SBD_MR` rows, and
segw-gen writes the RFC or search-help method for it. The module's
signature has to be at hand: an abapGit `*.fugr.xml` next to the YAML or
in a `--lib` folder; without it the method is a stub and the compiler
warns. `test/fixtures/segw/zstg_mapped.stg.yaml` is the YAML twin of the
hand-made `zstg_mapped.iwpr.xml`; the test expects the same DPC methods
from both.

## A service consumed from another one (`service:`)

`source: {service: X, set: S}` is SEGW's "external service" (ODC) in a local
flavour: the entity's read operations are served by another service of the
same registry. The tree carries it as a data source `ODC~X~S` (a steamgate
extension of the DS_TYPE 4 kinds, not something SEGW writes); the generated
DPC delegates `GET_ENTITYSET` and `GET_ENTITY` to
`zcl_stg_odata_client` (`src/gateway`), which turns the request back into an
OData GET (`$filter`, `$top`, `$skip`, `$orderby`, `$inlinecount`, `search`
unchanged), dispatches it in-process to X and reads the answer into the
local structure by property name. So the consuming service declares the
properties it wants, with the provider's names and its own fields and
types; `$metadata` shows only those. Writes stay stubs. `src/demo_odc/`
is such a service made of one file: `ZSTG_ODC_SRV` over the CDS service,
tested in `ltcl_odc`. An online provider (real HTTP) is the same seam with
`cl_http_client` behind it: not done.

## Fiori annotations in the file (`annotations:`)

What a local annotation file (`webapp/annotations/annotations.xml`) used to
carry lives next to the model: an `annotations:` map keyed by entity
(`Travel`) or property (`Travel/Status`). Per entity: `header`
(`UI.HeaderInfo`: typeName, typeNamePlural, title, description),
`selectionFields`, `lineItem` (`value`/`label`, or `semanticObject`+`action`
for `DataFieldWithIntentBasedNavigation`, or `intent: {label, semanticObject,
action}` for a `DataFieldForIntentBasedNavigation` button), `facets`
(`fieldGroup:` or `lineItem: <navigation>` become the `ReferenceFacet`
targets) and `fieldGroups`. Per property: `label` (`Common.Label`),
`text: {path, arrangement}` (`Common.Text` + `UI.TextArrangement`),
`valueList` (`Common.ValueList` with `inOut`/`in`/`out`/`displayOnly`
parameters, `search:`) and `valueListFixed: true`
(`Common.ValueListWithFixedValues`, a drop-down). Since the run cockpit
(DSL L3 slice 6a) also: `criticality: <path>` on a `lineItem` or field-group
entry (the value's colour, `UI.CriticalityType` 0 to 3), `hidden: <path>` on
a facet (`UI.Hidden`, a section hidden while a boolean is true),
`headerFacets` with a `target:` such as `@UI.DataPoint#Q`, `@UI.Chart#Q` or
`to_Nav/@UI.Chart#Q`, `dataPoints: {Q: {value, title, targetValue,
minimumValue, maximumValue, criticality, visualization,
criticalityCalculation: {improvementDirection, toleranceRangeHighValue, ...}}}`
(a number is a constant, a name a path) and `charts: {Q: {type: Donut |
Bullet | BarStacked | ..., title, measures, dimensions, measureAttributes:
[{measure, role, dataPoint}]}}`, which Fiori Elements V2 renders as header
micro charts. The writer is `tools/stg-compile-annotations.mjs`. Anything
else is not in the grammar yet: write it in the `_MPC_EXT` by hand against
`vocab_anno_model`.

stg-compile writes them into a class of their own,
`ZCL_<project>_MPC_ANN`, one static `define( io_vocab )` over the
`/iwbep/if_mgw_vocan_*` object model (open-abap-odata #60/#61), and the
generated `_MPC_EXT` calls it from `DEFINE` the way a SEGW-generated
`_MPC_EXT` writes its vocabulary annotations. `$metadata` then carries the
`<Annotations Target=...>` blocks and the Fiori app needs no local file.
The terms are written fully qualified (`com.sap.vocabularies.UI.v1.…`),
`AnnotationPath` values too, because `$metadata` declares no aliases.
The demo does exactly this: `src/demo/zstg_demo.stg.yaml`, the generated
`gen/stg/zstg_demo/zcl_zstg_demo_mpc_ann`, the hand-written
`zcl_zstg_demo_mpc_ext` calling it; `webapp/annotations/` is gone.

Two kinds of label: `label:` on a property under `entities:` is the model's
label (`sap:label`, written into the `_MPC` as
`create_annotation( 'sap' )->add( iv_key = 'label' )`, the SEGW form;
open-abap-odata #62 lets it win over the field name), `label:` under
`annotations:` is `Common.Label`. Fiori Elements reads both.

## In the build

`stg-compile --all` runs in `npm run transpile`: every `src/**/*.stg.yaml`
compiles into `gen/stg/<project>/` (classes, IWSV, IWMO) except the objects
that already exist under `src/` by name, so the demo's hand-written classes
win over their YAML and `src/demo_odc/` gets everything generated. The
registry reads `gen/` too, so a YAML-only service registers itself.

## Not yet

Include (a model reference of the include kind, `SBO_MR`) and function
imports mapped to a module: neither has an oracle in the 20 corpus
projects (the corpus has `EXT`/`APC` references only, and no `SBD_MH`
below a function import), and the clean-room rule is to write nothing
SEGW's own output has not shown; a sample project built on the A4H
sandbox would unblock both. Also not yet: annotation terms outside the
grammar above (write them in the `_MPC_EXT`), text elements, collections
of complex types (`IS_COLLECTION`).
