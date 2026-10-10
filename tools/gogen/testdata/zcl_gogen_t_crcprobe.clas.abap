CLASS zcl_gogen_t_crcprobe DEFINITION PUBLIC FINAL CREATE PUBLIC.
 PUBLIC SECTION.
 CLASS-METHODS run RETURNING VALUE(rv) TYPE string.
ENDCLASS.
CLASS zcl_gogen_t_crcprobe IMPLEMENTATION.
 METHOD run.
 DATA x TYPE xstring.
 DATA c TYPE i.
    CLEAR x.
    c = cl_abap_zip=>crc32( x ).
    rv = |{ rv }{ c }/|.
    x = '00'.
    c = cl_abap_zip=>crc32( x ).
    rv = |{ rv }{ c }/|.
    x = '0001'.
    c = cl_abap_zip=>crc32( x ).
    rv = |{ rv }{ c }/|.
    x = '000102'.
    c = cl_abap_zip=>crc32( x ).
    rv = |{ rv }{ c }/|.
    x = '00010203'.
    c = cl_abap_zip=>crc32( x ).
    rv = |{ rv }{ c }/|.
    x = '0001020304'.
    c = cl_abap_zip=>crc32( x ).
    rv = |{ rv }{ c }/|.
    x = '000102030405'.
    c = cl_abap_zip=>crc32( x ).
    rv = |{ rv }{ c }/|.
    x = '00010203040506'.
    c = cl_abap_zip=>crc32( x ).
    rv = |{ rv }{ c }/|.
    x = '0001020304050607'.
    c = cl_abap_zip=>crc32( x ).
    rv = |{ rv }{ c }/|.
    x = '000102030405060708'.
    c = cl_abap_zip=>crc32( x ).
    rv = |{ rv }{ c }/|.
 ENDMETHOD.
ENDCLASS.
