CLASS ltcl_newline DEFINITION FOR TESTING RISK LEVEL HARMLESS DURATION SHORT.
  PRIVATE SECTION.
    METHODS find_and_replace FOR TESTING.
ENDCLASS.
CLASS ltcl_newline IMPLEMENTATION.
  METHOD find_and_replace.
    cl_abap_unit_assert=>assert_equals(
      act = zcl_gogen_t_pcrenewline=>run( )
      exp = `macro:0 nbsp:4 class:0/1/2 space:0/1/4 dot:0/1/1` ).
  ENDMETHOD.
ENDCLASS.
