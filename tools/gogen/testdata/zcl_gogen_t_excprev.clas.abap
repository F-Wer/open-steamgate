CLASS zcl_gogen_t_excprev DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    CLASS-METHODS run RETURNING VALUE(result) TYPE string.
    CLASS-METHODS describe IMPORTING error TYPE REF TO cx_root
                           RETURNING VALUE(result) TYPE string.
    CLASS-METHODS widen RETURNING VALUE(error) TYPE REF TO cx_root.
ENDCLASS.
CLASS zcl_gogen_t_excprev IMPLEMENTATION.
  METHOD describe.
    DATA current TYPE REF TO cx_root.
    DATA name TYPE string.
    current = error.
    WHILE current IS BOUND.
      name = cl_abap_classdescr=>get_class_name( current ).
      REPLACE FIRST OCCURRENCE OF '\CLASS=' IN name WITH ''.
      IF result IS NOT INITIAL.
        result = result && | <- |.
      ENDIF.
      result = result && name.
      current = current->previous.
    ENDWHILE.
  ENDMETHOD.
  METHOD widen.
    DATA zero TYPE i.
    TRY.
        zero = 1 / zero.
      CATCH cx_root INTO DATA(caught).
        error = caught.
    ENDTRY.
  ENDMETHOD.
  METHOD run.
    DATA zero TYPE i.
    DATA root TYPE REF TO cx_root.
    DATA object TYPE REF TO object.
    DATA typed TYPE REF TO cx_sy_zerodivide.
    DATA own TYPE REF TO zcx_gogen_t_previous.
    DATA rows TYPE STANDARD TABLE OF REF TO cx_root WITH DEFAULT KEY.
    DATA text TYPE string.
    DATA info TYPE REF TO cl_abap_typedescr.
    TRY.
        TRY.
            zero = 1 / zero.
          CATCH cx_sy_zerodivide INTO DATA(inner).
            text = inner->get_text( ).
            root = inner.
            object = inner.
            typed ?= object.
            IF root IS BOUND AND root IS INSTANCE OF cx_sy_zerodivide.
              result = 'bound/instance'.
            ENDIF.
            IF typed->get_text( ) = text AND root->get_text( ) = text.
              result = result && '/text'.
            ENDIF.
            APPEND inner TO rows.
            APPEND root TO rows.
            IF rows[ 1 ] = rows[ 2 ] AND object = root
              AND cl_abap_classdescr=>get_class_name( inner ) = cl_abap_classdescr=>get_class_name( root ).
              result = result && '/identity'.
            ENDIF.
            DATA(last) = inner->previous.
            IF last IS NOT BOUND.
              result = result && '/end'.
            ENDIF.
            info = cl_abap_typedescr=>describe_by_object_ref( object ).
            IF info->absolute_name = '\CLASS=CX_SY_ZERODIVIDE'.
              result = result && '/rtti'.
            ENDIF.
            RAISE EXCEPTION TYPE cx_sy_conversion_no_number EXPORTING previous = inner.
        ENDTRY.
      CATCH cx_root INTO DATA(outer).
        result = result && '/' && describe( outer ).
        DATA(prev) = outer->previous.
        IF prev IS BOUND.
          result = result && '/prev'.
        ENDIF.
        root = prev.
        IF root = object.
          result = result && '/same'.
        ENDIF.
        TRY.
            RAISE EXCEPTION TYPE zcx_gogen_t_previous EXPORTING previous = outer.
          CATCH cx_root INTO DATA(third).
            result = result && '/' && describe( third ).
            root = third.
            own ?= root.
            result = result && '/' && own->get_text( ).
        ENDTRY.
    ENDTRY.
    root = widen( ).
    IF root IS INSTANCE OF cx_sy_zerodivide.
      result = result && '/return'.
    ENDIF.
    CREATE OBJECT own.
    TRY.
        RAISE EXCEPTION TYPE zcx_gogen_t_previous EXPORTING previous = own.
      CATCH cx_root INTO DATA(classcaught).
        root = classcaught.
        object = classcaught.
        info = cl_abap_typedescr=>describe_by_object_ref( object ).
        IF root->get_text( ) = 'class text' AND root IS INSTANCE OF zcx_gogen_t_previous
          AND info->absolute_name = '\CLASS=ZCX_GOGEN_T_PREVIOUS'.
          result = result && '/class'.
        ENDIF.
        root = classcaught->previous.
        IF root = own AND root->previous IS NOT BOUND.
          result = result && '/classprev'.
        ENDIF.
        APPEND classcaught TO rows.
        own ?= object.
        IF own = rows[ 3 ].
          result = result && '/classcast'.
        ENDIF.
        classcaught = classcaught->previous.
        classcaught = classcaught->previous.
        root = classcaught.
        object = classcaught.
        IF root IS NOT BOUND AND object IS NOT BOUND.
          result = result && '/empty'.
        ENDIF.
    ENDTRY.
  ENDMETHOD.
ENDCLASS.
