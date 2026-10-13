* Unmeasured; measure on A4H. sy-subrc and UTF-16 spans on both hosts.
CLASS ltcl_hex DEFINITION FOR TESTING RISK LEVEL HARMLESS DURATION SHORT.
  PRIVATE SECTION.
    METHODS find_and_replace FOR TESTING.
ENDCLASS.
CLASS ltcl_hex IMPLEMENTATION.
  METHOD find_and_replace.
    cl_abap_unit_assert=>assert_equals(
      act = zcl_gogen_t_pcrehex=>run( )
      exp = `nbsp:0/1/1 class:0/1/1 ascii:0/1/1 short:0/1/1 nul:0/1/1 bmp:0/1/1 astral:0/3/2 literal:0/1/4 count:0/2 results:0/3/2 first:0/Xa😀 all:0/XaY` ).
  ENDMETHOD.
ENDCLASS.
