* Unmeasured; documented TABLES references and LOOP / DELETE cursor semantics.
CLASS zcl_gogen_t_genloop DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    CLASS-METHODS run RETURNING VALUE(rv) TYPE string.
  PRIVATE SECTION.
    CLASS-METHODS deletion IMPORTING mode TYPE i EXPORTING text TYPE string
      CHANGING tab TYPE ANY TABLE.
ENDCLASS.
CLASS zcl_gogen_t_genloop IMPLEMENTATION.
  METHOD deletion.
    FIELD-SYMBOLS <row> TYPE any.
    CLEAR text.
    LOOP AT tab ASSIGNING <row>.
      text = |{ text }{ <row> }|.
      IF mode = 1.
        DELETE tab INDEX sy-tabix.
      ELSEIF mode = 2.
        IF sy-tabix = 2.
          DELETE tab INDEX 1.
        ENDIF.
      ELSEIF mode = 3.
        DELETE tab INDEX 99.
      ELSEIF mode = 4.
        DELETE tab INDEX 2.
      ELSEIF mode = 5.
        DELETE tab INDEX 1.
      ENDIF.
    ENDLOOP.
  ENDMETHOD.
  METHOD run.
    TYPES ty_lines TYPE STANDARD TABLE OF string WITH DEFAULT KEY.
    TYPES: BEGIN OF ty_row,
             id TYPE i,
             payload TYPE string,
             children TYPE ty_lines,
           END OF ty_row.
    DATA standard TYPE STANDARD TABLE OF ty_row WITH DEFAULT KEY.
    DATA sorted TYPE SORTED TABLE OF ty_row WITH UNIQUE KEY id.
    DATA hashed TYPE HASHED TABLE OF ty_row WITH UNIQUE KEY id.
    DATA row TYPE ty_row.
    DATA text TYPE string.
    DATA child TYPE string.
    DATA line TYPE string.
    DATA tab TYPE ty_lines.
    DATA mode TYPE i.
    DATA sorted_lines TYPE SORTED TABLE OF string WITH UNIQUE KEY table_line.
    row-id = 1. row-payload = 'before'.
    APPEND 'child' TO row-children.
    APPEND row TO standard.
    INSERT row INTO TABLE sorted.
    INSERT row INTO TABLE hashed.
    CALL FUNCTION 'ZGOGEN_T_GENLOOP' EXPORTING iv_mode = 0
      IMPORTING ev_text = text TABLES ct_row = standard.
    rv = |std:{ text }|.
    LOOP AT standard INTO row.
      READ TABLE row-children INDEX 1 INTO child.
      rv = |{ rv }/{ row-id }/{ row-payload }/{ child }|.
    ENDLOOP.
    CALL FUNCTION 'ZGOGEN_T_GENLOOP' EXPORTING iv_mode = 0
      IMPORTING ev_text = text TABLES ct_row = sorted.
    rv = |{ rv } sorted:{ text }|.
    LOOP AT sorted INTO row.
      READ TABLE row-children INDEX 1 INTO child.
      rv = |{ rv }/{ row-id }/{ row-payload }/{ child }|.
    ENDLOOP.
    CALL FUNCTION 'ZGOGEN_T_GENLOOP' EXPORTING iv_mode = 0
      IMPORTING ev_text = text TABLES ct_row = hashed.
    rv = |{ rv } hashed:{ text }|.
    LOOP AT hashed INTO row.
      READ TABLE row-children INDEX 1 INTO child.
      rv = |{ rv }/{ row-id }/{ row-payload }/{ child }|.
    ENDLOOP.
    INSERT `c` INTO TABLE sorted_lines.
    INSERT `a` INTO TABLE sorted_lines.
    INSERT `b` INTO TABLE sorted_lines.
    CALL FUNCTION 'ZGOGEN_T_GENLOOP' EXPORTING iv_mode = 1
      IMPORTING ev_text = text TABLES ct_row = sorted_lines.
    rv = |{ rv } sorted-delete:{ text }/{ lines( sorted_lines ) }|.
    DO 5 TIMES.
      mode = sy-index.
      CLEAR tab. APPEND 'a' TO tab. APPEND 'b' TO tab. APPEND 'c' TO tab.
      CALL FUNCTION 'ZGOGEN_T_GENLOOP' EXPORTING iv_mode = mode
        IMPORTING ev_text = text TABLES ct_row = tab.
      rv = |{ rv } fm{ mode }:{ text }/{ lines( tab ) }|.
      CLEAR tab. APPEND 'a' TO tab. APPEND 'b' TO tab. APPEND 'c' TO tab.
      deletion( EXPORTING mode = mode IMPORTING text = text CHANGING tab = tab ).
      rv = |{ rv } any{ mode }:{ text }/{ lines( tab ) }|.
      CLEAR tab. APPEND 'a' TO tab. APPEND 'b' TO tab. APPEND 'c' TO tab.
      CLEAR text.
      LOOP AT tab INTO line.
        text = |{ text }{ line }|.
        IF mode = 1.
          DELETE tab INDEX sy-tabix.
        ELSEIF mode = 2.
          IF sy-tabix = 2. DELETE tab INDEX 1. ENDIF.
        ELSEIF mode = 3.
          DELETE tab INDEX 99.
        ELSEIF mode = 4.
          DELETE tab INDEX 2.
        ELSEIF mode = 5.
          DELETE tab INDEX 1.
        ENDIF.
      ENDLOOP.
      rv = |{ rv } typed{ mode }:{ text }/{ lines( tab ) }|.
    ENDDO.
  ENDMETHOD.
ENDCLASS.
