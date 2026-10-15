CLASS zcl_gogen_t_pcreanchors DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    CLASS-METHODS run RETURNING VALUE(rv) TYPE string.
ENDCLASS.
CLASS zcl_gogen_t_pcreanchors IMPLEMENTATION.
  METHOD run.
    DATA off TYPE i.
    DATA cnt TYPE i.
    DATA len TYPE i.
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
    FIND FIRST OCCURRENCE OF PCRE `(?<![\s\S])ab` IN `Abab`
      IGNORING CASE MATCH OFFSET off MATCH LENGTH len.
    rv = rv && | first:{ sy-subrc }/{ off }/{ len }|.
    FIND ALL OCCURRENCES OF PCRE `(?<![\d\D])ab` IN `abab` MATCH COUNT cnt.
    rv = rv && | all:{ sy-subrc }/{ cnt }|.
    text = `ab` && cl_abap_char_utilities=>newline && `AB`.
    FIND FIRST OCCURRENCE OF PCRE `ab(?![\w\W])` IN text
      IGNORING CASE MATCH OFFSET off MATCH LENGTH len.
    rv = rv && | end:{ sy-subrc }/{ off }/{ len }|.
    REPLACE ALL OCCURRENCES OF PCRE `ab(?![\S\s])` IN text WITH `X` IGNORING CASE.
    REPLACE FIRST OCCURRENCE OF PCRE `(?<![\D\d])ab` IN text WITH `Y`.
    FIND FIRST OCCURRENCE OF PCRE `X(?![\W\w])` IN text MATCH OFFSET off MATCH LENGTH len.
    rv = rv && | replace:{ sy-subrc }/{ off }/{ len }|.
    text = ``.
    FIND FIRST OCCURRENCE OF PCRE `(?<![\s\S])(?![\s\S])` IN text MATCH OFFSET off MATCH LENGTH len.
    rv = rv && | empty:{ sy-subrc }/{ off }/{ len }|.
  ENDMETHOD.
ENDCLASS.
