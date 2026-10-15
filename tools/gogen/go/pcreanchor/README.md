# PCRE anchor syntax

Recognize the supported absolute-anchor assertion spellings and repetition tokens
at syntax positions supplied by the host walker. This leaf does not parse names,
classes, escapes or comments; callers skip those before consulting it.
FIND and REPLACE regressions live in abap/pcre_lookaround_anchor_test.go.
