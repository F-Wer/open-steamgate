CLASS zcl_gogen_t_pcrenegposix DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    CLASS-METHODS run RETURNING VALUE(rv) TYPE string.
ENDCLASS.
CLASS zcl_gogen_t_pcrenegposix IMPLEMENTATION.
  METHOD run.
    DATA off TYPE i.
    FIND FIRST OCCURRENCE OF PCRE `[[:^alpha:] #]` IN `#` MATCH OFFSET off.
    rv = |{ off }|.
  ENDMETHOD.
ENDCLASS.
