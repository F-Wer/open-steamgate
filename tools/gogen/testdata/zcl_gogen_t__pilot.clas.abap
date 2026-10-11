* Go/JS parity regression; INSTANCE OF's initial values use the A4H oracle
* in osgo-cases/z_hir_instance_of.clas.testclasses.abap. Other rows are
* open-abap-core / vanilla runtime behavior, not new SAP measurements.
CLASS zcl_gogen_t__pilot DEFINITION PUBLIC CREATE PUBLIC.
  PUBLIC SECTION.
    CLASS-DATA counter TYPE i.
    DATA value TYPE i.
    METHODS constructor IMPORTING count TYPE i DEFAULT 7.
    CLASS-METHODS run RETURNING VALUE(rv) TYPE string.
ENDCLASS.
CLASS zcl_gogen_t__pilot IMPLEMENTATION.
  METHOD constructor.
    value = count.
    counter = counter + 1.
  ENDMETHOD.
  METHOD run.
    DATA initial TYPE REF TO zcl_gogen_t__pilot.
    DATA generic TYPE REF TO object.
    DATA base TYPE REF TO zcl_gogen_t__pilot.
    DATA child TYPE REF TO zcl_gogen_t_pilchild.
    DATA unit TYPE string.
    DATA chars TYPE string.
    DATA bytes TYPE xstring.
    DATA first TYPE i.
    DATA second TYPE i.
    CLEAR counter.
    CREATE OBJECT child TYPE ('ZCL_GOGEN_T_PILCHILD').
    base = child.
    rv = |{ base->value }/{ counter }/{ xsdbool( base IS INSTANCE OF zcl_gogen_t__pilot ) }/{ xsdbool( base IS INSTANCE OF zcl_gogen_t_pilchild ) }|.
    rv = |{ rv }/{ xsdbool( initial IS INSTANCE OF zcl_gogen_t__pilot ) }/{ xsdbool( initial IS INSTANCE OF zcl_gogen_t_pilchild ) }/{ xsdbool( generic IS INSTANCE OF zcl_gogen_t__pilot ) }|.
    child = CAST zcl_gogen_t_pilchild( base ).
    rv = |{ rv }/{ child->value }|.
    unit = '00E4'.
    chars = cl_abap_conv_in_ce=>uccp( unit ).
    bytes = cl_abap_codepage=>convert_to( chars ).
    rv = |{ rv }/{ bytes }|.
    unit = 'D800'.
    chars = cl_abap_conv_in_ce=>uccp( unit ).
    bytes = cl_abap_codepage=>convert_to( source = chars codepage = '4103' ).
    rv = |{ rv }/{ bytes }|.
    sy-msgid = 'AA'.
    sy-msgno = '007'.
    sy-msgv1 = 'hello'.
    CLEAR sy-msgty.
    rv = |{ rv }/{ sy-msgid }/{ sy-msgno }/{ sy-msgv1 }|.
    GET RUN TIME FIELD first.
    GET RUN TIME FIELD second.
    ASSERT first >= 0.
    ASSERT second >= first.
    DO 3 TIMES.
      CHECK sy-index = 2.
      rv = |{ rv }/{ sy-index }|.
    ENDDO.
    CHECK 1 = 2.
    rv = 'unreachable'.
  ENDMETHOD.
ENDCLASS.
