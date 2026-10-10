CLASS zcl_gogen_t_bitprobe DEFINITION PUBLIC FINAL CREATE PUBLIC.
 PUBLIC SECTION.
 CLASS-METHODS run RETURNING VALUE(rv) TYPE string.
ENDCLASS.
CLASS zcl_gogen_t_bitprobe IMPLEMENTATION.
 METHOD run.
 DATA a TYPE x LENGTH 3 VALUE '112233'.
 DATA b TYPE x LENGTH 4 VALUE 'AABBCCDD'.
 DATA x TYPE xstring VALUE 'AABBCCDD'.
 DATA r TYPE x LENGTH 4.
 r = a BIT-XOR b.
 rv = |{ r }/|.
 r = b BIT-XOR a.
 rv = |{ rv }{ r }/|.
 r = a BIT-AND b.
 rv = |{ rv }{ r }/|.
 r = b BIT-AND a.
 rv = |{ rv }{ r }/|.
 r = a BIT-OR b.
 rv = |{ rv }{ r }/|.
 r = b BIT-OR a.
 rv = |{ rv }{ r }/|.
 r = a BIT-XOR x.
 rv = |{ rv }{ r }/|.
 r = x BIT-XOR a.
 rv = |{ rv }{ r }/|.
 x = 'AA'.
 x = a BIT-XOR x.
 rv = |{ rv }{ x }/|.
 x = 'AA'.
 x = x BIT-XOR a.
 rv = |{ rv }{ x }/|.
 CLEAR x.
 x = a BIT-XOR x.
 rv = |{ rv }{ x }/|.
 CLEAR x.
 x = x BIT-XOR a.
 rv = |{ rv }{ x }|.
 ENDMETHOD.
ENDCLASS.
