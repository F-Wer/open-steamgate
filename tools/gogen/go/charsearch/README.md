# Character comparison positions

CO and CA update SY-FDPOS as well as returning a boolean. CN and NA negate
those results without changing the position. Both emitters use helpers with
an explicit session; legacy boolean-only runtime helpers remain callable.

CO records the first excluded character, or the subject length if all match.
CA records the first included character, or the subject length if none match.
Matching is case-sensitive and retains trailing blanks. Runtime positions use
UTF-16 units, including isolated surrogate halves.

Reference: [SAP character comparisons](https://help.sap.com/docs/SUPPORT_CONTENT/abaptools/3362709374.html).
SAP behaviour, including surrogate-half membership, is unmeasured; measure on A4H.
Go/JS parity does not establish SAP behaviour.

Verification on 2026-10-12:

- `go test ./charsearch`: passed.
- `node --test --test-concurrency=1 tools/gogen/parity.test.mjs tools/gogen/emit-go.test.mjs`: 50 passed.
- `unit.mjs --fixture tools/gogen/testdata --class ZCL_GOGEN_T_SETPOS --no-cache`: SUCCESS.

The test files must run sequentially because they share generated Go scratch
packages. A concurrent run encountered a temporary-package removal race.
