CLASS zcl_gogen_t_pcreplain DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    CLASS-METHODS run RETURNING VALUE(rv) TYPE string.
ENDCLASS.
CLASS zcl_gogen_t_pcreplain IMPLEMENTATION.
  METHOD run.
    DATA text TYPE string VALUE `xxaab`.
    DATA off TYPE i VALUE -1.
    DATA len TYPE i.
    DATA count TYPE i.
    DATA sub TYPE string.
    FIND FIRST OCCURRENCE OF PCRE `a+?b` IN text MATCH OFFSET off MATCH LENGTH len.
    rv = |lazy:{ off }/{ len }/{ sy-subrc }|.
    FIND PCRE `a+?` IN text MATCH OFFSET off MATCH LENGTH len.
    rv = |{ rv } short:{ off }/{ len }|.
    FIND PCRE `a+` IN text MATCH OFFSET off MATCH LENGTH len.
    rv = |{ rv } greedy:{ off }/{ len }|.
    FIND PCRE `(A+?B)` IN text IGNORING CASE MATCH OFFSET off MATCH LENGTH len SUBMATCHES sub.
    rv = |{ rv } ic:{ off }/{ len }/{ sub }|.
    FIND ALL OCCURRENCES OF PCRE `a+?` IN text MATCH COUNT count.
    rv = |{ rv } all:{ count }/{ sy-subrc }|.
    FIND ALL OCCURRENCES OF PCRE `AB` IN `xAbab` IGNORING CASE MATCH COUNT count.
    rv = |{ rv } countic:{ count }/{ sy-subrc }|.
    FIND PCRE `z` IN text MATCH OFFSET off MATCH LENGTH len SUBMATCHES sub.
    rv = |{ rv } miss:{ off }/{ len }/{ sub }/{ sy-subrc }|.
    REPLACE FIRST OCCURRENCE OF PCRE `(a+?)b` IN text WITH `$1!`.
    rv = |{ rv } replace:{ text }/{ sy-subrc }|.
    text = `aAa`.
    REPLACE ALL OCCURRENCES OF PCRE `a+?` IN text WITH `X` IGNORING CASE.
    rv = |{ rv } replaceall:{ text }/{ sy-subrc }|.
    DATA rows TYPE STANDARD TABLE OF string WITH DEFAULT KEY.
    DATA line TYPE i.
    APPEND `miss` TO rows.
    APPEND `xxaab` TO rows.
    FIND PCRE `a+?b` IN TABLE rows MATCH LINE line MATCH OFFSET off MATCH LENGTH len.
    rv = |{ rv } table:{ line }/{ off }/{ len }/{ sy-subrc }|.
    text = `😀a`.
    FIND PCRE `(a)` IN text MATCH OFFSET off MATCH LENGTH len SUBMATCHES sub.
    rv = |{ rv } emoji:{ off }/{ len }/{ sub }|.
    FIND PCRE `(.)` IN `😀` MATCH OFFSET off MATCH LENGTH len SUBMATCHES sub.
    rv = |{ rv } scalar:{ off }/{ len }/{ sub }|.
    DATA matches TYPE match_result_tab.
    DATA match TYPE match_result.
    FIND ALL OCCURRENCES OF PCRE `(.)` IN text RESULTS matches.
    LOOP AT matches INTO match.
      rv = |{ rv } res:{ match-offset }/{ match-length }|.
    ENDLOOP.
    FIND REGEX `(a)` IN text MATCH OFFSET off MATCH LENGTH len.
    rv = |{ rv } regex:{ off }/{ len }|.
    FIND ALL OCCURRENCES OF REGEX `(.)` IN text RESULTS matches.
    LOOP AT matches INTO match.
      rv = |{ rv } rxres:{ match-offset }/{ match-length }|.
    ENDLOOP.
    REPLACE PCRE `(a)` IN text WITH `$1!`.
    rv = |{ rv } emreplace:{ text }|.
    text = `😀a`.
    REPLACE REGEX `(a)` IN text WITH `$1!`.
    rv = |{ rv } rxreplace:{ text }|.
    FIND PCRE `a b` IN `ab` MATCH LENGTH len.
    rv = |{ rv } extended:{ len }/{ sy-subrc }|.
    FIND PCRE `a\ b` IN `a b` MATCH LENGTH len.
    rv = |{ rv } escaped:{ len }/{ sy-subrc }|.
    FIND PCRE `[ ]` IN ` ` MATCH LENGTH len.
    rv = |{ rv } class:{ len }/{ sy-subrc }|.
    FIND PCRE `(?-x)a b` IN `a b` MATCH LENGTH len.
    rv = |{ rv } noextended:{ len }/{ sy-subrc }|.
    text = `ab`.
    REPLACE PCRE `(ab)` IN text WITH `\\\$$0/$1/$9`.
    rv = |{ rv } literals:{ text }|.
    FIND PCRE `[^] #]` IN `#`.
    rv = |{ rv } negclass:{ sy-subrc }|.
    FIND PCRE `[^] #]` IN `a` MATCH LENGTH len.
    rv = |{ rv } classletter:{ len }/{ sy-subrc }|.
    FIND PCRE `[] #]` IN `]` MATCH LENGTH len.
    rv = |{ rv } initialbracket:{ len }/{ sy-subrc }|.
    FIND ALL OCCURRENCES OF PCRE `[[:alpha:] #]` IN `a #` MATCH COUNT count.
    rv = |{ rv } posix:{ count }/{ sy-subrc }|.
    DATA fixed TYPE c LENGTH 3.
    fixed = `😀a`.
    REPLACE PCRE `[ ]` IN fixed WITH `X`.
    rv = |{ rv } fixedpcre:{ fixed }/{ sy-subrc }|.
    fixed = `😀a`.
    REPLACE REGEX `[ ]` IN fixed WITH `X`.
    rv = |{ rv } fixedregex:{ fixed }/{ sy-subrc }|.
    fixed = `😀`.
    REPLACE PCRE `[ ]` IN fixed WITH `X`.
    rv = |{ rv } padded:{ fixed }/{ sy-subrc }|.
  ENDMETHOD.
ENDCLASS.
