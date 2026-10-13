* Newline-independent PCRE cases; not measured on A4H.
CLASS zcl_gogen_t_pcrenewline DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    CLASS-METHODS run RETURNING VALUE(rv) TYPE string.
ENDCLASS.
CLASS zcl_gogen_t_pcrenewline IMPLEMENTATION.
  METHOD run.
    DATA text TYPE string.
    DATA original TYPE string.
    DATA off TYPE i.
    DATA len TYPE i.
    text = |WHEN &1.\n|.
    REPLACE ALL OCCURRENCES OF PCRE `&1` IN text WITH `'a'`.
    ASSERT text = |WHEN 'a'.\n|.
    rv = |macro:{ sy-subrc } |.
    original = |\ndefine root view entity zi_lockentity as select from zfoo \{\n  key field1\n\}|.
    text = original.
    REPLACE ALL OCCURRENCES OF PCRE cl_abap_conv_in_ce=>uccp( `00A0` ) IN text WITH ` `.
    rv = rv && |nbsp:{ sy-subrc } |.
    ASSERT text = original.
    text = |a\n\ra|.
    FIND PCRE `[^a]+` IN text MATCH OFFSET off MATCH LENGTH len.
    rv = rv && |class:{ sy-subrc }/{ off }/{ len } |.
    REPLACE ALL OCCURRENCES OF PCRE `[^a]+` IN text WITH `X`.
    ASSERT text = `aXa`.
    text = |a \n\r\tb|.
    FIND PCRE `\s+` IN text MATCH OFFSET off MATCH LENGTH len.
    rv = rv && |space:{ sy-subrc }/{ off }/{ len } |.
    REPLACE ALL OCCURRENCES OF PCRE `\s+` IN text WITH `X`.
    ASSERT text = `aXb`.
    text = |a.b\n|.
    FIND PCRE `\.` IN text MATCH OFFSET off MATCH LENGTH len.
    rv = rv && |dot:{ sy-subrc }/{ off }/{ len }|.
    REPLACE ALL OCCURRENCES OF PCRE `\.` IN text WITH `X`.
    ASSERT text = |aXb\n|.
    text = cl_abap_conv_in_ce=>uccp( `000A` ) && cl_abap_conv_in_ce=>uccp( `00A0` ).
    REPLACE ALL OCCURRENCES OF PCRE `\s+` IN text WITH `X`.
    ASSERT text = `X` && cl_abap_conv_in_ce=>uccp( `00A0` ).
    text = cl_abap_conv_in_ce=>uccp( `000A` ) && cl_abap_conv_in_ce=>uccp( `000B` ).
    REPLACE ALL OCCURRENCES OF PCRE `\s+` IN text WITH `X`.
    ASSERT text = `X`.
    text = cl_abap_conv_in_ce=>uccp( `000A` ) && cl_abap_conv_in_ce=>uccp( `00A0` ).
    REPLACE ALL OCCURRENCES OF PCRE `\S+` IN text WITH `X`.
    ASSERT text = cl_abap_conv_in_ce=>uccp( `000A` ) && `X`.
    text = cl_abap_conv_in_ce=>uccp( `000A` ) && cl_abap_conv_in_ce=>uccp( `00A0` ).
    REPLACE ALL OCCURRENCES OF PCRE `[^\s]+` IN text WITH `X`.
    ASSERT text = cl_abap_conv_in_ce=>uccp( `000A` ) && `X`.
    text = cl_abap_conv_in_ce=>uccp( `000A` ) && cl_abap_conv_in_ce=>uccp( `000B` ) && `1` && `2` && cl_abap_conv_in_ce=>uccp( `00A0` ).
    REPLACE ALL OCCURRENCES OF PCRE `[\s\d]+` IN text WITH `X`.
    ASSERT text = `X` && cl_abap_conv_in_ce=>uccp( `00A0` ).
    text = cl_abap_conv_in_ce=>uccp( `000A` ) && cl_abap_conv_in_ce=>uccp( `00A0` ) && `1` && `2`.
    REPLACE ALL OCCURRENCES OF PCRE `[\S\d]+` IN text WITH `X`.
    ASSERT text = cl_abap_conv_in_ce=>uccp( `000A` ) && `X`.
    text = cl_abap_conv_in_ce=>uccp( `000A` ) && cl_abap_conv_in_ce=>uccp( `00A0` ) && `1` && `2`.
    REPLACE ALL OCCURRENCES OF PCRE `[^\S\d]+` IN text WITH `X`.
    ASSERT text = `X` && cl_abap_conv_in_ce=>uccp( `00A0` ) && `1` && `2`.
    text = cl_abap_conv_in_ce=>uccp( `017F` ) && cl_abap_conv_in_ce=>uccp( `212A` ) && `K`.
    REPLACE ALL OCCURRENCES OF PCRE `\w+` IN text WITH `X` IGNORING CASE.
    ASSERT text = cl_abap_conv_in_ce=>uccp( `017F` ) && cl_abap_conv_in_ce=>uccp( `212A` ) && `X`.
    text = cl_abap_conv_in_ce=>uccp( `017F` ) && cl_abap_conv_in_ce=>uccp( `212A` ) && `K`.
    REPLACE ALL OCCURRENCES OF PCRE `[\w]+` IN text WITH `X` IGNORING CASE.
    ASSERT text = cl_abap_conv_in_ce=>uccp( `017F` ) && cl_abap_conv_in_ce=>uccp( `212A` ) && `X`.
    text = cl_abap_conv_in_ce=>uccp( `017F` ) && cl_abap_conv_in_ce=>uccp( `212A` ) && `K`.
    REPLACE ALL OCCURRENCES OF PCRE `[^\w]+` IN text WITH `X` IGNORING CASE.
    ASSERT text = `X` && `K`.
    text = cl_abap_conv_in_ce=>uccp( `017F` ) && cl_abap_conv_in_ce=>uccp( `212A` ) && `K`.
    REPLACE ALL OCCURRENCES OF PCRE `[\wſ]+` IN text WITH `X` IGNORING CASE.
    ASSERT text = `X` && cl_abap_conv_in_ce=>uccp( `212A` ) && `X`.
    text = cl_abap_conv_in_ce=>uccp( `017F` ) && cl_abap_conv_in_ce=>uccp( `212A` ) && `K`.
    REPLACE ALL OCCURRENCES OF PCRE `\W+` IN text WITH `X` IGNORING CASE.
    ASSERT text = `X` && `K`.
    text = cl_abap_conv_in_ce=>uccp( `0661` ) && `1`.
    REPLACE ALL OCCURRENCES OF PCRE `\d+` IN text WITH `X` IGNORING CASE.
    ASSERT text = cl_abap_conv_in_ce=>uccp( `0661` ) && `X`.
    text = cl_abap_conv_in_ce=>uccp( `0661` ) && `1`.
    REPLACE ALL OCCURRENCES OF PCRE `\D+` IN text WITH `X` IGNORING CASE.
    ASSERT text = `X` && `1`.
    text = cl_abap_conv_in_ce=>uccp( `00A0` ) && `K` && cl_abap_conv_in_ce=>uccp( `00A0` ).
    REPLACE ALL OCCURRENCES OF PCRE `\bK\b` IN text WITH `X` IGNORING CASE.
    ASSERT text = cl_abap_conv_in_ce=>uccp( `00A0` ) && `X` && cl_abap_conv_in_ce=>uccp( `00A0` ).
    text = cl_abap_conv_in_ce=>uccp( `017F` ) && `K` && cl_abap_conv_in_ce=>uccp( `212A` ).
    REPLACE ALL OCCURRENCES OF PCRE `\b` IN text WITH `X` IGNORING CASE.
    ASSERT text = cl_abap_conv_in_ce=>uccp( `017F` ) && `X` && `K` && `X` && cl_abap_conv_in_ce=>uccp( `212A` ).
  ENDMETHOD.
ENDCLASS.
