CLASS /my_ns/demo DEFINITION PUBLIC CREATE PUBLIC.
  PUBLIC SECTION.
    INTERFACES zif_symbols.
    METHODS constructor.
    CLASS-METHODS class_constructor.
    CLASS-METHODS n_helper_run RETURNING VALUE(r) TYPE i.
    METHODS handle FOR EVENT tick OF /my_ns/demo.
    EVENTS tick.
ENDCLASS.
CLASS /my_ns/demo IMPLEMENTATION.
  METHOD constructor.
  ENDMETHOD.
  METHOD class_constructor.
  ENDMETHOD.
  METHOD zif_symbols~meth.
    TRY.
        DO 1000000 TIMES.
          r = r + 1.
        ENDDO.
      CATCH cx_root.
    ENDTRY.
  ENDMETHOD.
  METHOD n_helper_run.
    DO 1000000 TIMES.
      r = r + 1.
    ENDDO.
  ENDMETHOD.
  METHOD handle.
  ENDMETHOD.
ENDCLASS.
