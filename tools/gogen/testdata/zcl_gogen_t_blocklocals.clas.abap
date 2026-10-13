CLASS zcl_gogen_t_blocklocals DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    CLASS-METHODS try_collision RETURNING VALUE(rv) TYPE i.
    CLASS-METHODS cursor_collision RETURNING VALUE(rv) TYPE i.
    CLASS-METHODS carried RETURNING VALUE(rv) TYPE i.
    CLASS-METHODS reset RETURNING VALUE(rv) TYPE i.
    CLASS-METHODS conditional RETURNING VALUE(rv) TYPE i.
ENDCLASS.
CLASS zcl_gogen_t_blocklocals IMPLEMENTATION.
  METHOD try_collision.
    DATA ctl TYPE i.
    TRY.
      CLEAR ctl.
    CATCH cx_root.
    ENDTRY.
    rv = 1.
  ENDMETHOD.
  METHOD cursor_collision.
    DATA tab TYPE STANDARD TABLE OF i WITH DEFAULT KEY.
    DATA row TYPE i.
    APPEND 1 TO tab.
    APPEND 2 TO tab.
    APPEND 3 TO tab.
    LOOP AT tab INTO row.
      DATA i0 TYPE i.
      CLEAR i0.
      rv = rv + 1.
      DELETE tab.
    ENDLOOP.
  ENDMETHOD.
  METHOD carried.
    DATA counter TYPE i.
    DO 4 TIMES.
      counter = counter + 1.
      rv = counter.
    ENDDO.
  ENDMETHOD.
  METHOD reset.
    DO 4 TIMES.
      DATA temp TYPE i.
      CLEAR temp.
      temp = temp + 1.
      rv = rv + temp.
    ENDDO.
  ENDMETHOD.
  METHOD conditional.
    DATA saved TYPE i VALUE 7.
    DO 3 TIMES.
      IF sy-index = 1.
        saved = 9.
      ENDIF.
      rv = rv + saved.
    ENDDO.
  ENDMETHOD.
ENDCLASS.
