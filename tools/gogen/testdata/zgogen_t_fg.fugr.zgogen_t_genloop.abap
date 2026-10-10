FUNCTION zgogen_t_genloop.
* Unmeasured; documented LOOP / DELETE cursor and TABLES reference semantics.
  FIELD-SYMBOLS <row> TYPE any.
  FIELD-SYMBOLS <part> TYPE any.
  FIELD-SYMBOLS <nested> TYPE ANY TABLE.
  FIELD-SYMBOLS <line> TYPE any.
  DATA pos TYPE i VALUE 2.
  CLEAR ev_text.
  LOOP AT ct_row ASSIGNING <row>.
    IF iv_mode = 0.
      ASSIGN COMPONENT pos OF STRUCTURE <row> TO <part>.
      ev_text = |{ ev_text }{ sy-subrc }/{ <part> }|.
      <part> = 'written'.
      ASSIGN COMPONENT 3 OF STRUCTURE <row> TO <nested>.
      LOOP AT <nested> ASSIGNING <line>.
        <line> = 'nested'.
      ENDLOOP.
    ELSE.
      ev_text = |{ ev_text }{ <row> }|.
      IF iv_mode = 1.
        DELETE ct_row INDEX sy-tabix.
      ELSEIF iv_mode = 2.
        IF sy-tabix = 2.
          DELETE ct_row INDEX 1.
        ENDIF.
      ELSEIF iv_mode = 3.
        DELETE ct_row INDEX 99.
      ELSEIF iv_mode = 4.
        DELETE ct_row INDEX 2.
      ELSEIF iv_mode = 5.
        DELETE ct_row INDEX 1.
      ENDIF.
    ENDIF.
  ENDLOOP.
ENDFUNCTION.
