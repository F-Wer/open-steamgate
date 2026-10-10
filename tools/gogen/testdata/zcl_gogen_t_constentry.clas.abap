CLASS zcl_gogen_t_constentry DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    CONSTANTS base TYPE i VALUE 5.
    CLASS-DATA entered TYPE i.
    CLASS-METHODS run RETURNING VALUE(rv) TYPE string.
    CLASS-METHODS a__b RETURNING VALUE(rv) TYPE i.
    CLASS-METHODS a RETURNING VALUE(rv) TYPE i.
    CLASS-METHODS unused RETURNING VALUE(rv) TYPE i.
    CLASS-METHODS bad.
    CLASS-METHODS recurse IMPORTING n TYPE i RETURNING VALUE(rv) TYPE i.
ENDCLASS.
CLASS zcl_gogen_t_constentry IMPLEMENTATION.
  METHOD a__b.
    CONSTANTS c TYPE i VALUE 1.
    rv = c.
  ENDMETHOD.
  METHOD a.
    CONSTANTS b__c TYPE i VALUE 2.
    rv = b__c.
  ENDMETHOD.
  METHOD unused.
    CONSTANTS bad TYPE f VALUE '1E+999'.
    rv = 0.
  ENDMETHOD.
  METHOD bad.
    CONSTANTS good TYPE f VALUE '100'.
    CONSTANTS bad TYPE f VALUE '1E+999'.
    entered = entered + 1.
  ENDMETHOD.
  METHOD recurse.
    CONSTANTS c TYPE f VALUE '3'.
    CONSTANTS dependent TYPE i VALUE c.
    CONSTANTS class_dependent TYPE i VALUE base.
    CONSTANTS bytes TYPE x LENGTH 3 VALUE 'ABCD'.
    CONSTANTS variable_bytes TYPE xstring VALUE '1234'.
    ASSERT bytes = 'ABCD00'.
    ASSERT variable_bytes = '1234'.
    ASSERT dependent = c.
    ASSERT class_dependent = 5.
    IF n > 0.
      rv = recurse( n - 1 ) + c.
    ELSE.
      rv = c.
    ENDIF.
  ENDMETHOD.
  METHOD run.
    DATA failures TYPE i.
    DATA result TYPE i.
    ASSERT a__b( ) = 1.
    ASSERT a( ) = 2.
    result = recurse( 3 ).
    ASSERT result = 12.
    DO 2 TIMES.
      TRY.
          bad( ).
        CATCH cx_sy_conversion_overflow.
          failures = failures + 1.
      ENDTRY.
    ENDDO.
    ASSERT entered = 0.
    ASSERT failures = 2.
    rv = |1/2/{ result }/{ failures }/{ entered }|.
  ENDMETHOD.
ENDCLASS.
