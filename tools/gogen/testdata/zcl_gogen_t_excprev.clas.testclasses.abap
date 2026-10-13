CLASS ltcl_previous DEFINITION FINAL FOR TESTING DURATION SHORT RISK LEVEL HARMLESS.
  PRIVATE SECTION.
    METHODS ordinary_interfaces FOR TESTING.
    METHODS chain FOR TESTING.
    METHODS rethrow_lazy FOR TESTING.
    METHODS rethrow_widened FOR TESTING.
    METHODS rethrow_twice FOR TESTING.
    METHODS populated_textid FOR TESTING.
    METHODS helper_text FOR TESTING.
    METHODS interface_text FOR TESTING.
    METHODS helper_vars FOR TESTING.
    METHODS helper_previous FOR TESTING.
ENDCLASS.
CLASS ltcl_previous IMPLEMENTATION.
  METHOD ordinary_interfaces.
    DATA object TYPE REF TO zcl_gogen_t_excprev.
    DATA d TYPE REF TO cl_abap_classdescr.
    CREATE OBJECT object.
    d ?= cl_abap_typedescr=>describe_by_object_ref( object ).
    READ TABLE d->interfaces TRANSPORTING NO FIELDS WITH KEY name = 'IF_OO_ADT_CLASSRUN'.
    cl_abap_unit_assert=>assert_equals( act = sy-subrc exp = 4 ).
    cl_abap_unit_assert=>assert_equals( act = d->absolute_name exp = '\CLASS=ZCL_GOGEN_T_EXCPREV' ).
  ENDMETHOD.
  METHOD rethrow_lazy.
    DATA n TYPE i. DATA a TYPE REF TO cx_root. DATA b TYPE REF TO cx_root.
    TRY.
      TRY. n = 1 / n. CATCH cx_root INTO DATA(x). RAISE EXCEPTION x. ENDTRY.
    CATCH cx_root INTO DATA(y).
      a = x. b = y. ASSERT a = b.
    ENDTRY.
  ENDMETHOD.
  METHOD rethrow_widened.
    DATA n TYPE i. DATA a TYPE REF TO cx_root. DATA b TYPE REF TO cx_root.
    TRY.
      TRY. n = 1 / n. CATCH cx_root INTO DATA(x). a = x. RAISE EXCEPTION x. ENDTRY.
    CATCH cx_root INTO DATA(y).
      b = y. ASSERT a = b.
    ENDTRY.
  ENDMETHOD.
  METHOD rethrow_twice.
    DATA n TYPE i. DATA a TYPE REF TO cx_root. DATA b TYPE REF TO cx_root. DATA c TYPE REF TO cx_root.
    TRY.
      TRY.
        TRY. n = 1 / n. CATCH cx_root INTO DATA(x). RAISE EXCEPTION x. ENDTRY.
      CATCH cx_root INTO DATA(y). RAISE EXCEPTION y. ENDTRY.
    CATCH cx_root INTO DATA(z).
      c = z. a = x. b = y. ASSERT a = b. ASSERT b = c.
    ENDTRY.
  ENDMETHOD.
  METHOD chain.
    cl_abap_unit_assert=>assert_equals(
      act = zcl_gogen_t_excprev=>run( )
      exp = 'bound/instance/text/identity/end/rtti/CX_SY_CONVERSION_NO_NUMBER <- CX_SY_ZERODIVIDE/prev/same/ZCX_GOGEN_T_PREVIOUS <- CX_SY_CONVERSION_NO_NUMBER <- CX_SY_ZERODIVIDE/class text/return/class/classprev/classcast/empty' ).
  ENDMETHOD.
  METHOD populated_textid.
    DATA own TYPE REF TO zcx_gogen_t_previous.
    DATA root TYPE REF TO cx_root.
    CREATE OBJECT own EXPORTING textid = 'known'.
    root = own.
    cl_abap_unit_assert=>assert_equals( act = root->textid exp = 'known' ).
  ENDMETHOD.
  METHOD helper_text.
    DATA n TYPE i. DATA r TYPE REF TO cx_root. DATA text TYPE string.
    TRY. n = 1 / n. CATCH cx_root INTO DATA(x). r = x.
      text = cl_message_helper=>get_text_for_message( r ).
      cl_abap_unit_assert=>assert_equals( act = text exp = x->get_text( ) ).
    ENDTRY.
  ENDMETHOD.
  METHOD interface_text.
    DATA r TYPE REF TO cx_root. DATA msg TYPE REF TO if_message.
    r = zcl_gogen_t_excprev=>widen( ). msg = r.
    cl_abap_unit_assert=>assert_equals( act = msg->get_text( ) exp = r->get_text( ) ).
  ENDMETHOD.
  METHOD helper_vars.
    DATA r TYPE REF TO cx_root. DATA text TYPE string.
    r = zcl_gogen_t_excprev=>widen( ).
    cl_message_helper=>set_msg_vars_for_if_msg( EXPORTING text = r IMPORTING string = text ).
    cl_abap_unit_assert=>assert_equals( act = text exp = r->get_text( ) ).
  ENDMETHOD.
  METHOD helper_previous.
    DATA r TYPE REF TO cx_root. DATA msg TYPE REF TO if_t100_message.
    r = zcl_gogen_t_excprev=>widen( ). msg = cl_message_helper=>get_latest_t100_exception( r ).
    IF msg IS BOUND. cl_abap_unit_assert=>fail( 'unexpected T100 predecessor' ). ENDIF.
  ENDMETHOD.
ENDCLASS.
