FUNCTION zgogen_t_binary.
* Expectations: unmeasured; ABAP documentation.
* Executed via CALL FUNCTION in ZCL_GOGEN_T_BINARY on both Go and JS.
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
ENDFUNCTION.
