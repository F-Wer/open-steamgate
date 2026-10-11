CLASS zcl_gogen_t_localconst DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    CONSTANTS class_float TYPE f VALUE '1E+2'.
    CLASS-METHODS run RETURNING VALUE(rv) TYPE string.
    CLASS-METHODS probe RETURNING VALUE(rv) TYPE string.
ENDCLASS.
CLASS zcl_gogen_t_localconst IMPLEMENTATION.
  METHOD run.
    rv = probe( ) && '/' && probe( ).
  ENDMETHOD.
  METHOD probe.
    CONSTANTS lower TYPE f VALUE '-2147483648'.
    CONSTANTS upper TYPE f VALUE '2147483647'.
    CONSTANTS exponent TYPE f VALUE '1E+2'.
    CONSTANTS packed TYPE p LENGTH 8 DECIMALS 2 VALUE '1.235'.
    CONSTANTS minimum TYPE int8 VALUE '-9223372036854775808'.
    CONSTANTS maximum TYPE int8 VALUE '9223372036854775807'.
    CONSTANTS integer TYPE i VALUE '-42'.
    CONSTANTS digits TYPE n LENGTH 5 VALUE '12'.
    CONSTANTS date TYPE d VALUE '2024'.
    CONSTANTS time TYPE t VALUE '12'.
    CONSTANTS chars TYPE c LENGTH 5 VALUE 'xy'.
    CONSTANTS text TYPE string VALUE `hello`.
    CONSTANTS: BEGIN OF record,
      float TYPE f VALUE '1E+2',
      amount TYPE p LENGTH 8 DECIMALS 2 VALUE '2.345',
      label TYPE c LENGTH 5 VALUE 'ab',
      END OF record.
    DATA copy LIKE record.
    copy = record.
    copy-label = 'cd'.
    ASSERT record-label = 'ab'.
    ASSERT copy-label = 'cd'.
    DATA total TYPE i.
    DO 3 TIMES.
      CONSTANTS step TYPE i VALUE 7.
      total = total + step.
    ENDDO.
    ASSERT lower = CONV f( '-2147483648' ).
    ASSERT upper = CONV f( '2147483647' ).
    ASSERT exponent = 100.
    ASSERT class_float = exponent.
    ASSERT date+4(4) = '    '.
    ASSERT time+2(4) = '    '.
    ASSERT chars+2(3) = '   '.
    ASSERT packed = '1.24'.
    ASSERT record-float = exponent.
    ASSERT record-amount = '2.35'.
    rv = |{ minimum }/{ maximum }/{ integer }/{ digits }/[{ date }]/[{ time }]/[{ chars WIDTH = 5 }]/{ text }/[{ record-label WIDTH = 5 }]/{ total }|.
  ENDMETHOD.
ENDCLASS.
