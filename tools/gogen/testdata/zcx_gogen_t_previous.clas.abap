CLASS zcx_gogen_t_previous DEFINITION PUBLIC INHERITING FROM cx_static_check CREATE PUBLIC.
  PUBLIC SECTION.
    METHODS if_message~get_text REDEFINITION.
ENDCLASS.
CLASS zcx_gogen_t_previous IMPLEMENTATION.
  METHOD if_message~get_text.
    result = 'class text'.
  ENDMETHOD.
ENDCLASS.
