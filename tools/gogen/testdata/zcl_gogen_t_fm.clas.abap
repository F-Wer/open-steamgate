* CALL FUNCTION of a module compiled with the program (parity-wave1: the
* RFC channel's Z_OSD_TEST_ITEM_LIST): VALUE( ) importing, exporting and
* changing parameters, a TABLES parameter by reference (TABLES before
* CHANGING, as CALL FUNCTION wants it), an optional importing parameter
* left out, a classic exception with EXCEPTIONS name
* and OTHERS. ZGOGEN_T_FM is in zgogen_t_fg.fugr.*. Run on A4H as written,
* the module created there with the same source-based signature.
CLASS zcl_gogen_t_fm DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    CLASS-METHODS run RETURNING VALUE(rv) TYPE string.
ENDCLASS.

CLASS zcl_gogen_t_fm IMPLEMENTATION.
  METHOD run.
    DATA lv_n TYPE i.
    DATA lv_s TYPE string.
    DATA lv_c TYPE i.
    DATA lt TYPE STANDARD TABLE OF zgogen_t_dbw WITH DEFAULT KEY.
    DATA ls TYPE zgogen_t_dbw.
    lv_n = 5.
    lv_c = 10.
    ls-id = 'X'.
    APPEND ls TO lt.
    CALL FUNCTION 'ZGOGEN_T_FM'
      EXPORTING
        iv_n   = 3
      IMPORTING
        ev_n   = lv_n
        ev_s   = lv_s
      TABLES
        ct_row = lt
      CHANGING
        cv_n   = lv_c
      EXCEPTIONS
        boom   = 4
        OTHERS = 8.
    rv = |ok:{ sy-subrc }/{ lv_n }/{ lv_c }/{ lines( lt ) }/{ lv_s }|.
    lv_n = 5.
    lv_c = 10.
    lv_s = `keep`.
    CALL FUNCTION 'ZGOGEN_T_FM'
      EXPORTING
        iv_n    = 4
        iv_boom = 1
      IMPORTING
        ev_n    = lv_n
        ev_s    = lv_s
      TABLES
        ct_row  = lt
      CHANGING
        cv_n    = lv_c
      EXCEPTIONS
        boom    = 4
        OTHERS  = 8.
    rv = |{ rv } boom:{ sy-subrc }/{ lv_n }/{ lv_c }/{ lines( lt ) }/{ lv_s }|.
    CALL FUNCTION 'ZGOGEN_T_FM'
      TABLES
        ct_row = lt
      CHANGING
        cv_n   = lv_c.
    rv = |{ rv } opt:{ sy-subrc }/{ lv_c }/{ lines( lt ) }|.
    CALL FUNCTION 'ZGOGEN_T_FM'
      EXPORTING
        iv_boom = 1
      TABLES
        ct_row  = lt
      CHANGING
        cv_n    = lv_c
      EXCEPTIONS
        OTHERS  = 7.
    rv = |{ rv } oth:{ sy-subrc }/{ lv_c }/{ lines( lt ) }|.
    LOOP AT lt INTO ls.
      rv = |{ rv },{ ls-id }{ ls-val }|.
    ENDLOOP.
    DO 2 TIMES.
      CALL FUNCTION 'ZGOGEN_T_FM' IMPORTING ev_s = lv_s CHANGING cv_n = lv_c.
      rv = |{ rv } omitted:{ lv_s }|.
    ENDDO.
  ENDMETHOD.
ENDCLASS.
