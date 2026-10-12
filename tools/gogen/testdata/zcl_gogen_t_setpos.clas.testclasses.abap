CLASS ltcl_setpos DEFINITION FINAL FOR TESTING DURATION SHORT RISK LEVEL HARMLESS.
  PRIVATE SECTION.
    METHODS positions FOR TESTING.
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
ENDCLASS.
