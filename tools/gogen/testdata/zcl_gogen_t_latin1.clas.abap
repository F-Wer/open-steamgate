* Regression: ISO-8859-1 byte-by-byte decoding.
* 80-9F: unmeasured on A4H; follows TextDecoder per #255.
CLASS zcl_gogen_t_latin1 DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    CLASS-METHODS run RETURNING VALUE(rv) TYPE string.
ENDCLASS.
CLASS zcl_gogen_t_latin1 IMPLEMENTATION.
  METHOD run.
    DATA input TYPE xstring.
    DATA text TYPE string.
    DATA output TYPE xstring.
    DATA decoder TYPE REF TO cl_abap_conv_in_ce.
    input = 'C3A400FF808182838485868788898A8B8C8D8E8F909192939495969798999A9B9C9D9E9F'.
    decoder = cl_abap_conv_in_ce=>create( encoding = 'ISO-8859-1' ).
    decoder->convert( EXPORTING input = input IMPORTING data = text ).
    output = cl_abap_codepage=>convert_to( text ).
    rv = |{ output }|.
  ENDMETHOD.
ENDCLASS.
