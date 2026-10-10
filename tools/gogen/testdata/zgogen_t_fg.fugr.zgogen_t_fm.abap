FUNCTION zgogen_t_fm.
*"----------------------------------------------------------------------
*"*"Local Interface:
*"  IMPORTING
*"     VALUE(IV_N) TYPE  I OPTIONAL
*"     VALUE(IV_BOOM) TYPE  I OPTIONAL
*"  EXPORTING
*"     VALUE(EV_N) TYPE  I
*"     VALUE(EV_S) TYPE  STRING
*"  TABLES
*"      CT_ROW STRUCTURE  ZGOGEN_T_DBW
*"  CHANGING
*"     VALUE(CV_N) TYPE  I
*"  EXCEPTIONS
*"      BOOM
*"----------------------------------------------------------------------
* The module ZCL_GOGEN_T_FM calls; on A4H with the same body and the
* signature in source form (TABLES ct_row LIKE zgogen_t_dbw).

  CONSTANTS factor TYPE f VALUE '2'.
  CONSTANTS increment TYPE i VALUE 1.
  DATA ls TYPE zgogen_t_dbw.
  ev_s = |in:{ iv_n }/{ ev_n }/{ cv_n }/{ lines( ct_row ) }|.
  ev_n = iv_n * factor.
  cv_n = cv_n + increment.
  ls-id = 'F'.
  ls-val = iv_n.
  APPEND ls TO ct_row.
  IF iv_boom = 1.
    RAISE boom.
  ENDIF.

ENDFUNCTION.
