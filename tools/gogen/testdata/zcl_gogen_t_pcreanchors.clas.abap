CLASS zcl_gogen_t_pcreanchors DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    CLASS-METHODS run RETURNING VALUE(rv) TYPE string.
ENDCLASS.
CLASS zcl_gogen_t_pcreanchors IMPLEMENTATION.
  METHOD run.
    DATA off TYPE i.
    DATA cnt TYPE i.
    DATA text TYPE string.
    FIND FIRST OCCURRENCE OF PCRE `\Aab` IN `abab` MATCH OFFSET off.
    rv = |start:{ off }/{ sy-subrc }|.
    FIND ALL OCCURRENCES OF PCRE `\Aab` IN `abab` MATCH COUNT cnt.
    rv = rv && | count:{ cnt }/{ sy-subrc }|.
    FIND FIRST OCCURRENCE OF PCRE `ab\z` IN `abab` MATCH OFFSET off.
    rv = rv && | end:{ off }/{ sy-subrc }|.
    text = `ab` && cl_abap_char_utilities=>newline.
    FIND FIRST OCCURRENCE OF PCRE `ab\z` IN text MATCH OFFSET off.
    rv = rv && | newline:{ sy-subrc }|.
    FIND FIRST OCCURRENCE OF PCRE `\\A` IN `x\A` MATCH OFFSET off.
    rv = rv && | literal:{ off }/{ sy-subrc }|.
    text = `abab`.
    REPLACE ALL OCCURRENCES OF PCRE `ab\z` IN text WITH `X`.
    rv = rv && | replace:{ text }/{ sy-subrc }|.
  ENDMETHOD.
ENDCLASS.
