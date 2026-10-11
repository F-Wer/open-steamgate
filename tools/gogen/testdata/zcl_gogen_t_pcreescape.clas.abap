CLASS zcl_gogen_t_pcreescape DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    CLASS-METHODS run RETURNING VALUE(rv) TYPE string.
ENDCLASS.
CLASS zcl_gogen_t_pcreescape IMPLEMENTATION.
  METHOD run.
    DATA text TYPE string VALUE `ab`.
    rv = text.
    REPLACE PCRE `(ab)` IN text WITH `\U$0`.
    rv = text.
  ENDMETHOD.
ENDCLASS.
