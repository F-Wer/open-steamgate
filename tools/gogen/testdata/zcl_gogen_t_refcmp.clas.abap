* Go/IR-JS parity regression: generic references compare target addresses.
CLASS zcl_gogen_t_refcmp DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    CLASS-METHODS run RETURNING VALUE(rv) TYPE string.
    CLASS-METHODS equal IMPORTING a TYPE any b TYPE any RETURNING VALUE(rv) TYPE string.
ENDCLASS.
CLASS zcl_gogen_t_refcmp IMPLEMENTATION.
  METHOD equal.
    IF a = b.
      rv = `1`.
    ELSE.
      rv = `0`.
    ENDIF.
  ENDMETHOD.
  METHOD run.
    TYPES: BEGIN OF ty_row, ref TYPE REF TO data, END OF ty_row.
    DATA row TYPE ty_row.
    DATA copied TYPE ty_row.
    DATA a TYPE REF TO data.
    DATA b TYPE REF TO data.
    DATA x TYPE i VALUE 7.
    DATA y TYPE i VALUE 7.
    rv = equal( a = a b = b ).
    GET REFERENCE OF x INTO a.
    GET REFERENCE OF x INTO b.
    rv = rv && equal( a = a b = b ).
    GET REFERENCE OF y INTO b.
    rv = rv && equal( a = a b = b ).
    b = a.
    rv = rv && equal( a = a b = b ).
    row-ref = a.
    copied = row.
    rv = rv && equal( a = row-ref b = copied-ref ).
  ENDMETHOD.
ENDCLASS.
