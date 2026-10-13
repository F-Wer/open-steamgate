CLASS ltcl_blocks DEFINITION FOR TESTING RISK LEVEL HARMLESS DURATION SHORT.
  PRIVATE SECTION.
    METHODS try_collision FOR TESTING.
    METHODS cursor_collision FOR TESTING.
    METHODS carried FOR TESTING.
    METHODS reset FOR TESTING.
    METHODS conditional FOR TESTING.
ENDCLASS.
CLASS ltcl_blocks IMPLEMENTATION.
  METHOD try_collision.
    cl_abap_unit_assert=>assert_equals( act = zcl_gogen_t_blocklocals=>try_collision( ) exp = 1 ).
  ENDMETHOD.
  METHOD cursor_collision.
    cl_abap_unit_assert=>assert_equals( act = zcl_gogen_t_blocklocals=>cursor_collision( ) exp = 3 ).
  ENDMETHOD.
  METHOD carried.
    cl_abap_unit_assert=>assert_equals( act = zcl_gogen_t_blocklocals=>carried( ) exp = 4 ).
  ENDMETHOD.
  METHOD reset.
    cl_abap_unit_assert=>assert_equals( act = zcl_gogen_t_blocklocals=>reset( ) exp = 4 ).
  ENDMETHOD.
  METHOD conditional.
    cl_abap_unit_assert=>assert_equals( act = zcl_gogen_t_blocklocals=>conditional( ) exp = 27 ).
  ENDMETHOD.
ENDCLASS.
