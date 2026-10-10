* Expectations: unmeasured; ABAP documentation.
CLASS zcl_gogen_t_binary DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    CLASS-METHODS run RETURNING VALUE(rv) TYPE string.
  PRIVATE SECTION.
    CLASS-METHODS probe EXPORTING ev_text TYPE string CHANGING binary_tab TYPE ANY TABLE.
ENDCLASS.
CLASS zcl_gogen_t_binary IMPLEMENTATION.
  METHOD probe.
* Expectations: unmeasured; ABAP documentation.
  FIELD-SYMBOLS <ls_row> TYPE any.
  FIELD-SYMBOLS <lv_line> TYPE any.
  DATA lv_kind TYPE c LENGTH 1.
  DATA lv_part TYPE string.
  DATA lt_parts TYPE STANDARD TABLE OF string WITH DEFAULT KEY.
  DATA lv_all TYPE string.
  DATA lv_pos TYPE i VALUE 2.
  DATA lv_write TYPE x LENGTH 2.
  CLEAR ev_text.
  lv_write = 'CCDD'.
  LOOP AT binary_tab ASSIGNING <ls_row>.
    DESCRIBE FIELD <ls_row> TYPE lv_kind.
    IF lv_kind = 'u'.
      ASSIGN COMPONENT 1 OF STRUCTURE <ls_row> TO <lv_line>.
    ELSE.
      ASSIGN <ls_row> TO <lv_line>.
    ENDIF.
    lv_part = <lv_line>.
    APPEND lv_part TO lt_parts.
    <lv_line> = lv_write.
    IF lv_kind = 'u'.
      ASSIGN COMPONENT lv_pos OF STRUCTURE <ls_row> TO <lv_line>.
      ev_text = |{ ev_text } second:{ sy-subrc }/{ <lv_line> }|.
      ASSIGN COMPONENT 3 OF STRUCTURE <ls_row> TO <lv_line>.
    ELSE.
      ASSIGN COMPONENT 1 OF STRUCTURE <ls_row> TO <lv_line>.
    ENDIF.
    ev_text = |{ ev_text } miss:{ sy-subrc }|.
    IF <lv_line> IS ASSIGNED.
      ev_text = |{ ev_text }/bound|.
    ELSE.
      ev_text = |{ ev_text }/free|.
    ENDIF.
  ENDLOOP.
  CONCATENATE LINES OF lt_parts INTO lv_all.
  ev_text = |{ lv_all }{ ev_text }|.
  ENDMETHOD.
  METHOD run.
    TYPES: BEGIN OF ty_row,
             bytes TYPE x LENGTH 2,
             label TYPE c LENGTH 1,
           END OF ty_row.
    TYPES ty_x TYPE x LENGTH 2.
    DATA lt_x TYPE STANDARD TABLE OF ty_x WITH DEFAULT KEY.
    DATA lt_s TYPE STANDARD TABLE OF ty_row WITH DEFAULT KEY.
    DATA lx TYPE x LENGTH 2.
    DATA ls TYPE ty_row.
    DATA text TYPE string.
    lx = '0102'. APPEND lx TO lt_x.
    lx = 'A0B0'. APPEND lx TO lt_x.
    ls-bytes = '1122'. ls-label = 'Q'. APPEND ls TO lt_s.
    CALL FUNCTION 'ZGOGEN_T_BINARY' IMPORTING ev_text = text TABLES binary_tab = lt_x.
    rv = |x:{ text }|.
    LOOP AT lt_x INTO lx.
      rv = |{ rv }/{ lx }|.
    ENDLOOP.
    CALL FUNCTION 'ZGOGEN_T_BINARY' IMPORTING ev_text = text TABLES binary_tab = lt_s.
    rv = |{ rv } s:{ text }|.
    READ TABLE lt_s INDEX 1 INTO ls.
    rv = |{ rv }/{ ls-bytes }/{ ls-label }|.
    probe( IMPORTING ev_text = text CHANGING binary_tab = lt_x ).
    rv = |{ rv } any:{ text }|.
    text = 'not empty'.
    CALL FUNCTION 'ZGOGEN_T_BINARY' IMPORTING ev_text = text.
    rv = |{ rv } omitted:[{ text }]|.
  ENDMETHOD.
ENDCLASS.
