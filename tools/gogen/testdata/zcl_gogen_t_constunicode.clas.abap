CLASS zcl_gogen_t_constunicode DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    CLASS-METHODS run RETURNING VALUE(rv) TYPE string.
ENDCLASS.
CLASS zcl_gogen_t_constunicode IMPLEMENTATION.
  METHOD run.
    CONSTANTS two TYPE c LENGTH 2 VALUE '😀z'.
    CONSTANTS three TYPE c LENGTH 3 VALUE '😀z'.
    CONSTANTS: BEGIN OF record,
      two TYPE c LENGTH 2 VALUE '😀z',
      three TYPE c LENGTH 3 VALUE '😀z',
      END OF record.
    DATA data_two TYPE c LENGTH 2 VALUE '😀z'.
    DATA data_three TYPE c LENGTH 3 VALUE '😀z'.
    ASSERT two = data_two.
    ASSERT three = data_three.
    ASSERT record-two = data_two.
    ASSERT record-three = data_three.
    rv = two && '/' && three && '/' && record-two && '/' && record-three.
  ENDMETHOD.
ENDCLASS.
