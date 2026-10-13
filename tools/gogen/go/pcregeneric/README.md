# PCRE generic types

Normalize PCRE2 non-UCP generic types before RE2 compilation, preserving
escape parity and character-class unions/complements. The caller handles
extended mode and quoting first; the refusal callback must abort compilation.

SAP's UCP setting is unmeasured; measure on A4H. Tests exercise the public
FIND/REPLACE adapters in `../abap/pcre_newline_test.go`.

Classes are tokenized into literals, generic/POSIX sets and validated ranges
before union and negation. Scalar escapes keep literal metacharacters literal
regardless of position. Unsupported class escapes, collating/equivalence items
and set-valued range endpoints refuse by name.

`../abap/pcre_class_test.go` and the JS frontend suite consume
`../../pcre-class-oracle.json`: 90 patterns × 38 inputs × both case modes,
measured using real PCRE2 10.42 in UTF mode without UCP. Regenerate with
`python tools/gogen/pcre-class-oracle.py` from the repository root (libpcre2-8).
PCRE2 rejects `[\d-z]`, `[\\-\s]` and other generic range endpoints.

All pattern walkers protect named declarations and references, and use the
class tokenizer. Classes model up to three octal digits (including NUL) and
\o{...} scalar escapes; \8 and \9 are literal digits, per pcre2pattern. Named references remain refused by the RE2 adapter.
The oracle records UTF-16 capture spans as well as matches; both adapters check
FIND and REPLACE. Export origin/main and run
`node tools/gogen/pcre-oracle-check.mjs <export>` to check the same table on
both hosts and fail on any case where main agrees with PCRE2 and this branch
does not.
