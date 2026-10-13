* Hex escape behavior is unmeasured; measure on A4H.
CLASS zcl_gogen_t_pcrehex DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    CLASS-METHODS run RETURNING VALUE(rv) TYPE string.
ENDCLASS.
CLASS zcl_gogen_t_pcrehex IMPLEMENTATION.
  METHOD run.
    DATA text TYPE string.
    DATA off TYPE i.
    DATA len TYPE i.
    DATA count TYPE i.
    DATA res TYPE match_result.
    text = `a` && cl_abap_conv_in_ce=>uccp( `00A0` ).
    FIND PCRE `\xA0` IN text MATCH OFFSET off MATCH LENGTH len.
    rv = rv && |nbsp:{ sy-subrc }/{ off }/{ len } |.
    text = `a` && cl_abap_conv_in_ce=>uccp( `001F` ).
    FIND PCRE `[\x00-\x1F\xA0]` IN text MATCH OFFSET off MATCH LENGTH len.
    rv = rv && |class:{ sy-subrc }/{ off }/{ len } |.
    text = `xA`.
    FIND PCRE `\x41` IN text MATCH OFFSET off MATCH LENGTH len.
    rv = rv && |ascii:{ sy-subrc }/{ off }/{ len } |.
    text = `a` && cl_abap_conv_in_ce=>uccp( `0004` ).
    FIND PCRE `\x4` IN text MATCH OFFSET off MATCH LENGTH len.
    rv = rv && |short:{ sy-subrc }/{ off }/{ len } |.
    text = `a` && cl_abap_conv_in_ce=>uccp( `0000` ).
    FIND PCRE `\x00` IN text MATCH OFFSET off MATCH LENGTH len.
    rv = rv && |nul:{ sy-subrc }/{ off }/{ len } |.
    text = `a☺`.
    FIND PCRE `\x{263A}` IN text MATCH OFFSET off MATCH LENGTH len.
    rv = rv && |bmp:{ sy-subrc }/{ off }/{ len } |.
    text = `😀a😀`.
    FIND PCRE `\x{1F600}\z` IN text MATCH OFFSET off MATCH LENGTH len.
    rv = rv && |astral:{ sy-subrc }/{ off }/{ len } |.
    text = `a\x41`.
    FIND PCRE `\\x41` IN text MATCH OFFSET off MATCH LENGTH len.
    rv = rv && |literal:{ sy-subrc }/{ off }/{ len } |.
    text = `😀a😀`.
    FIND ALL OCCURRENCES OF PCRE `\x{1F600}` IN text MATCH COUNT count.
    rv = rv && |count:{ sy-subrc }/{ count } |.
    FIND PCRE `(\x{1F600})\z` IN text RESULTS res.
    rv = rv && |results:{ sy-subrc }/{ res-offset }/{ res-length } |.
    REPLACE FIRST OCCURRENCE OF PCRE `\x{1F600}` IN text WITH `X`.
    rv = rv && |first:{ sy-subrc }/{ text } |.
    REPLACE ALL OCCURRENCES OF PCRE `\x{1F600}` IN text WITH `Y`.
    rv = rv && |all:{ sy-subrc }/{ text }|.
  ENDMETHOD.
ENDCLASS.
