CLASS ltcl_setpos DEFINITION FINAL FOR TESTING DURATION SHORT RISK LEVEL HARMLESS.
  PRIVATE SECTION.
    METHODS positions FOR TESTING.
    METHODS trailing_blanks FOR TESTING.
    METHODS short_circuit FOR TESTING.
ENDCLASS.
CLASS ltcl_setpos IMPLEMENTATION.
  METHOD positions.
    DATA subject TYPE string.
    subject = `abX`.
    sy-fdpos = 99.
    IF subject CN `ab`.
      cl_abap_unit_assert=>assert_equals( act = sy-fdpos exp = 2 ).
    ELSE.
      cl_abap_unit_assert=>fail( ).
    ENDIF.
    subject = `abba`.
    IF subject CO `ab`.
      cl_abap_unit_assert=>assert_equals( act = sy-fdpos exp = 4 ).
    ELSE.
      cl_abap_unit_assert=>fail( ).
    ENDIF.
    subject = `XXb`.
    IF subject CA `ab`.
      cl_abap_unit_assert=>assert_equals( act = sy-fdpos exp = 2 ).
    ELSE.
      cl_abap_unit_assert=>fail( ).
    ENDIF.
    subject = `XXX`.
    IF subject NA `ab`.
      cl_abap_unit_assert=>assert_equals( act = sy-fdpos exp = 3 ).
    ELSE.
      cl_abap_unit_assert=>fail( ).
    ENDIF.
  ENDMETHOD.
  METHOD trailing_blanks.
    DATA subject TYPE c LENGTH 4.
    subject = 'ab'.
    IF subject CN `ab`.
      cl_abap_unit_assert=>assert_equals( act = sy-fdpos exp = 2 ).
    ELSE.
      cl_abap_unit_assert=>fail( ).
    ENDIF.
    IF subject CO `ab `.
      cl_abap_unit_assert=>assert_equals( act = sy-fdpos exp = 4 ).
    ELSE.
      cl_abap_unit_assert=>fail( ).
    ENDIF.
    IF subject CA ` `.
      cl_abap_unit_assert=>assert_equals( act = sy-fdpos exp = 2 ).
    ELSE.
      cl_abap_unit_assert=>fail( ).
    ENDIF.
    IF subject NA `X`.
      cl_abap_unit_assert=>assert_equals( act = sy-fdpos exp = 4 ).
    ELSE.
      cl_abap_unit_assert=>fail( ).
    ENDIF.
  ENDMETHOD.
  METHOD short_circuit.
    DATA subject TYPE string.
    subject = `abX`.
    " False CO skips CA; the skipped CA would change the position to zero.
    sy-fdpos = 99.
    IF subject CO `ab` AND subject CA `a`.
      cl_abap_unit_assert=>fail( ).
    ENDIF.
    cl_abap_unit_assert=>assert_equals( act = sy-fdpos exp = 2 ).
    " True CA skips CO; the skipped CO would change the position to three.
    sy-fdpos = 99.
    IF subject CA `X` OR subject CO `abX`.
      cl_abap_unit_assert=>assert_equals( act = sy-fdpos exp = 2 ).
    ELSE.
      cl_abap_unit_assert=>fail( ).
    ENDIF.
    " A skipped comparison also preserves a position set by a prior statement.
    sy-fdpos = 17.
    IF 1 = 2 AND subject CO `ab`.
      cl_abap_unit_assert=>fail( ).
    ENDIF.
    cl_abap_unit_assert=>assert_equals( act = sy-fdpos exp = 17 ).
    sy-fdpos = 17.
    IF 1 = 1 OR subject CA `X`.
      cl_abap_unit_assert=>assert_equals( act = sy-fdpos exp = 17 ).
    ELSE.
      cl_abap_unit_assert=>fail( ).
    ENDIF.
  ENDMETHOD.
ENDCLASS.
