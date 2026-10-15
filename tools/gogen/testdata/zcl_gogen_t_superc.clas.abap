CLASS zcl_gogen_t_superc DEFINITION PUBLIC INHERITING FROM zcl_gogen_t_superb.
  PUBLIC SECTION.
    CLASS-METHODS run RETURNING VALUE(result) TYPE string.
ENDCLASS.
CLASS zcl_gogen_t_superc IMPLEMENTATION.
  METHOD run.
    DATA obj TYPE REF TO zcl_gogen_t_superc.
    DATA descr TYPE REF TO cl_abap_classdescr.
    DATA parent TYPE REF TO cl_abap_classdescr.
    CREATE OBJECT obj.
    descr ?= cl_abap_typedescr=>describe_by_object_ref( obj ).
    parent = descr->get_super_class_type( ).
    result = parent->absolute_name && '/'.
    WHILE descr IS BOUND.
      result = result && descr->absolute_name && '/'.
      CALL METHOD descr->get_super_class_type
        RECEIVING p_descr_ref = descr
        EXCEPTIONS super_class_not_found = 1.
      result = result && sy-subrc && '/'.
      IF sy-subrc <> 0.
        CLEAR descr.
      ENDIF.
    ENDWHILE.
  ENDMETHOD.
ENDCLASS.
