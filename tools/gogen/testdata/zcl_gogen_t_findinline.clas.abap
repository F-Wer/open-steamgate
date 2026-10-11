CLASS zcl_gogen_t_findinline DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    CLASS-METHODS run RETURNING VALUE(rv) TYPE string.
  PRIVATE SECTION.
    CLASS-METHODS tab IMPORTING matches TYPE match_result_tab
      RETURNING VALUE(rv) TYPE string.
ENDCLASS.

CLASS zcl_gogen_t_findinline IMPLEMENTATION.
  METHOD tab.
    DATA hit TYPE match_result.
    DATA groups TYPE submatch_result_tab.
    DATA group TYPE submatch_result.
    rv = |{ lines( matches ) }[|.
    LOOP AT matches INTO hit.
      rv = |{ rv }{ hit-line }:{ hit-offset },{ hit-length }|.
      groups = hit-submatches.
      LOOP AT groups INTO group.
        rv = |{ rv }({ group-offset },{ group-length })|.
      ENDLOOP.
      rv = |{ rv };|.
    ENDLOOP.
    rv = |{ rv }]|.
  ENDMETHOD.

  METHOD run.
    DATA first TYPE match_result_tab.
    DATA hit TYPE match_result.
    DATA explicit TYPE match_result_tab.
    FIND ALL OCCURRENCES OF REGEX '(a)(b)?' IN 'x ab a' RESULTS DATA(matches).
    rv = |all:{ sy-subrc }/{ tab( matches ) }|.
    explicit = matches.
    rv = |{ rv } copy:{ tab( explicit ) }|.
    FIND FIRST OCCURRENCE OF REGEX '(a)(b)?' IN 'xab ab' RESULTS first.
    rv = |{ rv } first:{ sy-subrc }/{ tab( first ) }|.
    FIND FIRST OCCURRENCE OF REGEX '(z)' IN 'xab ab' RESULTS first.
    rv = |{ rv } miss:{ sy-subrc }/{ tab( first ) }|.
    FIND FIRST OCCURRENCE OF REGEX '(a)(b)?' IN 'xa' RESULTS DATA(single).
    hit = single.
    APPEND hit TO first.
    rv = |{ rv } single:{ sy-subrc }/{ tab( first ) }|.
    FIND ALL OCCURRENCES OF REGEX '(z)' IN 'xa' RESULTS matches.
    rv = |{ rv } allmiss:{ sy-subrc }/{ tab( matches ) }|.
  ENDMETHOD.
ENDCLASS.
