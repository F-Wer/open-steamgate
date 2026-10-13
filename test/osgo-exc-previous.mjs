import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {libraryPath} from '../tools/osd-lib-path.mjs';
import {home} from '../tools/gogen/home.mjs';

describe('caught exceptions widen and retain PREVIOUS on both hosts', function () {
  this.timeout(240000);
  it('runs the kernel and class-based ABAP Unit fixture', () => {
    const dir = mkdtempSync(join(tmpdir(), 'exc-previous-'));
    const input = join(dir, 'input'); mkdirSync(input);
    try {
      for (const name of ['zcl_gogen_t_excprev.clas.abap', 'zcl_gogen_t_excprev.clas.testclasses.abap', 'zcx_gogen_t_previous.clas.abap'])
        copyFileSync(join('tools/gogen/testdata', name), join(input, name));
      // The generic testdata runner requires SUCCESS; stage negative cases
      // only here, where both hosts have explicit refusal/dump expectations.
      const negative = {
        kernel_metadata: `
    DATA n TYPE i. DATA r TYPE REF TO cx_root. DATA result TYPE string.
    TRY. n = 'abc'. CATCH cx_root INTO DATA(x). r = x.
      result = 'textid=' && r->textid && '/errid=' && r->kernel_errid. ENDTRY.
`,
        kernel_errid: `
    DATA r TYPE REF TO cx_root. DATA result TYPE string.
    r = zcl_gogen_t_excprev=>widen( ). result = r->kernel_errid.
`,
        initial_text: `
    DATA n TYPE i. DATA result TYPE string.
    TRY.
      TRY. n = 1 / n. CATCH cx_root INTO DATA(x).
        x = x->previous. result = x->get_text( ).
      ENDTRY.
    CATCH cx_sy_ref_is_initial.
      cl_abap_unit_assert=>fail( 'host dump unexpectedly became catchable' ).
    ENDTRY.
`,
        initial_class: `
    DATA n TYPE i. DATA result TYPE string.
    TRY.
      TRY. n = 1 / n. CATCH cx_root INTO DATA(x).
        x = x->previous. result = cl_abap_classdescr=>get_class_name( x ).
      ENDTRY.
    CATCH cx_sy_ref_is_initial.
      cl_abap_unit_assert=>fail( 'host dump unexpectedly became catchable' ).
    ENDTRY.
`,
        initial_previous: `
    DATA n TYPE i. DATA result TYPE string.
    TRY.
      TRY. n = 1 / n. CATCH cx_root INTO DATA(x).
        x = x->previous. x = x->previous.
      ENDTRY.
    CATCH cx_sy_ref_is_initial.
      cl_abap_unit_assert=>fail( 'host dump unexpectedly became catchable' ).
    ENDTRY.
`,
        ref_text: `
    DATA r TYPE REF TO cx_root. DATA result TYPE string.
    result = r->get_text( ).
`,
        ref_class: `
    DATA r TYPE REF TO cx_root. DATA result TYPE string.
    result = cl_abap_classdescr=>get_class_name( r ).
`,
        kernel_byref: `
    DATA r TYPE REF TO cx_root. r = zcl_gogen_t_excprev=>widen( ).
    cl_message_helper=>get_otr_text_raw( EXPORTING textid = r->textid ).
`,
        interface_longtext: `
    DATA r TYPE REF TO cx_root. DATA msg TYPE REF TO if_message. DATA text TYPE string.
    r = zcl_gogen_t_excprev=>widen( ). msg = r. text = msg->get_longtext( ).
`,
        source_position: `
    DATA r TYPE REF TO cx_root. r = zcl_gogen_t_excprev=>widen( ). r->get_source_position( ).
`,
        helper_kind: `
    DATA r TYPE REF TO cx_root. r = zcl_gogen_t_excprev=>widen( ). cl_message_helper=>check_msg_kind( r ).
`,
        helper_params: `
    DATA r TYPE REF TO cx_root. r = zcl_gogen_t_excprev=>widen( ). cl_message_helper=>get_text_params( r ).
`,
        helper_replace: `
    DATA r TYPE REF TO cx_root. DATA text TYPE string. r = zcl_gogen_t_excprev=>widen( ).
    cl_message_helper=>replace_text_params( EXPORTING obj = r CHANGING result = text ).
`,
        helper_otr: `
    cl_message_helper=>get_otr_text_raw( EXPORTING textid = 'known' ).
`,
        rtti_members: `
    DATA r TYPE REF TO cx_root. DATA d TYPE REF TO cl_abap_classdescr.
    r = zcl_gogen_t_excprev=>widen( ). d ?= cl_abap_typedescr=>describe_by_object_ref( r ).
    IF d->attributes IS INITIAL. ENDIF.
`,
        rtti_attribute_type: `
    DATA r TYPE REF TO cx_root. DATA d TYPE REF TO cl_abap_classdescr. DATA t TYPE REF TO cl_abap_datadescr.
    r = zcl_gogen_t_excprev=>widen( ). d ?= cl_abap_typedescr=>describe_by_object_ref( r ).
    t = d->get_attribute_type( 'PREVIOUS' ).
`,
        rtti_methods: `
    DATA r TYPE REF TO cx_root. DATA d TYPE REF TO cl_abap_classdescr. r = zcl_gogen_t_excprev=>widen( ). d ?= cl_abap_typedescr=>describe_by_object_ref( r ). IF d->methods IS INITIAL. ENDIF.
`,
        rtti_interfaces: `
    DATA r TYPE REF TO cx_root. DATA d TYPE REF TO cl_abap_classdescr. r = zcl_gogen_t_excprev=>widen( ). d ?= cl_abap_typedescr=>describe_by_object_ref( r ). IF d->interfaces IS INITIAL. ENDIF.
`,
        rtti_types: `
    DATA r TYPE REF TO cx_root. DATA d TYPE REF TO cl_abap_classdescr. r = zcl_gogen_t_excprev=>widen( ). d ?= cl_abap_typedescr=>describe_by_object_ref( r ). IF d->types IS INITIAL. ENDIF.
`,
        rtti_events: `
    DATA r TYPE REF TO cx_root. DATA d TYPE REF TO cl_abap_classdescr. r = zcl_gogen_t_excprev=>widen( ). d ?= cl_abap_typedescr=>describe_by_object_ref( r ). IF d->events IS INITIAL. ENDIF.
`,
        rtti_parameter: `
    DATA d TYPE REF TO cl_abap_classdescr. DATA t TYPE REF TO cl_abap_datadescr. d ?= cl_abap_typedescr=>describe_by_object_ref( zcl_gogen_t_excprev=>widen( ) ). t = d->get_method_parameter_type( p_method_name = 'CONSTRUCTOR' p_parameter_name = 'TEXTID' ).
`,
        rtti_interface: `
    DATA d TYPE REF TO cl_abap_classdescr. DATA t TYPE REF TO cl_abap_intfdescr. d ?= cl_abap_typedescr=>describe_by_object_ref( zcl_gogen_t_excprev=>widen( ) ). t = d->get_interface_type( 'IF_MESSAGE' ).
`,
        rtti_super: `
    DATA d TYPE REF TO cl_abap_classdescr. DATA t TYPE REF TO cl_abap_classdescr. d ?= cl_abap_typedescr=>describe_by_object_ref( zcl_gogen_t_excprev=>widen( ) ). t = d->get_super_class_type( ).
`,
        json_object: `
    DATA r TYPE REF TO cx_root. DATA text TYPE string. r = zcl_gogen_t_excprev=>widen( ). text = /ui2/cl_json=>serialize( r ).
`,
      };
      const tests = join(input, 'zcl_gogen_t_excprev.clas.testclasses.abap');
      writeFileSync(tests, readFileSync(tests, 'utf8')
        .replace('  PRIVATE SECTION.', '  PRIVATE SECTION.\n' + Object.keys(negative).map(n => `    METHODS ${n} FOR TESTING.`).join('\n'))
        .replace(/ENDCLASS\.\s*$/, Object.entries(negative).map(([n, body]) => `  METHOD ${n}.${body}  ENDMETHOD.`).join('\n') + '\nENDCLASS.'));
      for (const host of ['unit', 'unit-js']) {
        const out = join(dir, host);
        const run = spawnSync(process.execPath, [`tools/gogen/${host}.mjs`, '--fixture', input, '--out', out],
          {encoding: 'utf8', timeout: 110000, maxBuffer: 4e6});
        assert.equal(run.error, undefined, run.stderr);
        assert.equal(run.status, 1, run.stderr + run.stdout);
        const result = host === 'unit' ? JSON.parse(run.stdout).rows : JSON.parse(readFileSync(join(out, 'results.json'), 'utf8'));
        const success = ['ORDINARY_INTERFACES', 'CHAIN', 'RETHROW_LAZY', 'RETHROW_WIDENED', 'RETHROW_TWICE', 'POPULATED_TEXTID', 'HELPER_TEXT', 'INTERFACE_TEXT', 'HELPER_VARS', 'HELPER_PREVIOUS'];
        const refusals = {
          KERNEL_METADATA: /exception attribute TEXTID/, KERNEL_ERRID: /exception attribute KERNEL_ERRID/,
          KERNEL_BYREF: /exception attribute TEXTID/, INTERFACE_LONGTEXT: /exception method GET_LONGTEXT/,
          SOURCE_POSITION: /CX_ROOT=>GET_SOURCE_POSITION/, HELPER_KIND: /CL_MESSAGE_HELPER=>CHECK_MSG_KIND/,
          HELPER_PARAMS: /CL_MESSAGE_HELPER=>GET_TEXT_PARAMS/, HELPER_REPLACE: /CL_MESSAGE_HELPER=>REPLACE_TEXT_PARAMS/,
          HELPER_OTR: /CL_MESSAGE_HELPER=>GET_OTR_TEXT_RAW/, RTTI_MEMBERS: /object RTTI member ATTRIBUTES/,
          RTTI_ATTRIBUTE_TYPE: /object RTTI method GET_ATTRIBUTE_TYPE/,
          RTTI_METHODS: /object RTTI member METHODS/, RTTI_INTERFACES: /object RTTI member INTERFACES/,
          RTTI_TYPES: /object RTTI member TYPES/, RTTI_EVENTS: /object RTTI member EVENTS/,
          RTTI_PARAMETER: /object RTTI method GET_METHOD_PARAMETER_TYPE/, RTTI_INTERFACE: /object RTTI method GET_INTERFACE_TYPE/,
          RTTI_SUPER: /object RTTI method GET_SUPER_CLASS_TYPE/, JSON_OBJECT: host === 'unit' ? /CL_ABAP_TYPEDESCR=>DESCRIBE_BY_DATA: an unmeasured object reference: CX_ROOT/ : /Native_DESCRIBE_BY_DATA/,

        };
        assert.equal(result.length, 34);
        for (const row of result) {
          if (success.includes(row.method)) assert.equal(row.status, 'SUCCESS', JSON.stringify(row));
          else if (refusals[row.method]) {
            assert.equal(row.status, 'NOT_COMPILED', JSON.stringify(row));
            assert.match(row.message, refusals[row.method]);
          } else {
            assert.equal(row.status, 'FAILED', JSON.stringify(row));
            assert.match(row.message, /OBJECTS_OBJREF_NOT_ASSIGNED/);
            assert.doesNotMatch(row.message, /nil pointer|Cannot read properties/);
          }
        }
      }
    } finally { rmSync(dir, {recursive: true, force: true}); }
  });
  it('guards interface metadata, including helper and by-reference reads', () => {
    const dir = mkdtempSync(join(tmpdir(), 'exc-t100-'));
    const input = join(dir, 'input'); mkdirSync(input);
    try {
      const lib = join(dir, 'core');
      cpSync(join(libraryPath(home, 'open-abap-core'), 'src'), join(lib, 'src'), {recursive: true});
      const core = join(lib, 'src/exceptions/cx_sy_zerodivide.clas.abap');
      // Synthetic compiled kernel class: expose the interface route that a
      // CX_ROOT-typed guard cannot see. No SAP metadata values are asserted.
      writeFileSync(core, readFileSync(core, 'utf8')
        .replace('PUBLIC SECTION.', 'PUBLIC SECTION. INTERFACES if_t100_message. METHODS read_metadata RETURNING VALUE(result) TYPE string.')
        .replace('CLASS cx_sy_zerodivide IMPLEMENTATION.', 'CLASS cx_sy_zerodivide IMPLEMENTATION. METHOD read_metadata. result = textid. ENDMETHOD.'));
      const bodies = {
        direct: 'DATA key TYPE scx_t100key. key = msg->t100key.',
        component: 'DATA text TYPE string. text = msg->t100key-msgid.',
        explicit: 'DATA typed TYPE REF TO cx_sy_zerodivide. DATA key TYPE scx_t100key. typed ?= r. key = typed->if_t100_message~t100key.',
        implicit: 'DATA typed TYPE REF TO cx_sy_zerodivide. DATA text TYPE string. typed ?= r. text = typed->read_metadata( ).',
        byref: 'cl_message_helper=>check_msg_kind( EXPORTING msg = r IMPORTING t100key = msg->t100key ).',
        helper: 'cl_message_helper=>check_msg_kind( r ).',
        text: 'cl_abap_unit_assert=>assert_equals( act = cl_message_helper=>get_text_for_message( r ) exp = r->get_text( ) ).',
      };
      writeFileSync(join(input, 'zcl_interface_probe.clas.abap'), 'CLASS zcl_interface_probe DEFINITION PUBLIC FINAL CREATE PUBLIC. ENDCLASS. CLASS zcl_interface_probe IMPLEMENTATION. ENDCLASS.');
      writeFileSync(join(input, 'zcl_interface_probe.clas.testclasses.abap'),
        `CLASS ltcl_interface DEFINITION FINAL FOR TESTING DURATION SHORT RISK LEVEL HARMLESS. PRIVATE SECTION.
        ${Object.keys(bodies).map(n => `METHODS ${n} FOR TESTING.`).join('\n')}
        ENDCLASS. CLASS ltcl_interface IMPLEMENTATION.
        ${Object.entries(bodies).map(([n, body]) => `METHOD ${n}.
          DATA zero TYPE i. DATA r TYPE REF TO cx_root. DATA msg TYPE REF TO if_t100_message.
          TRY. zero = 1 / zero. CATCH cx_root INTO DATA(x). r = x. msg ?= r. ${body} ENDTRY.
          ENDMETHOD.`).join('\n')} ENDCLASS.`);
      for (const host of ['unit', 'unit-js']) {
        const out = join(dir, host);
        const run = spawnSync(process.execPath, [`tools/gogen/${host}.mjs`, '--fixture', input, '--out', out],
          {encoding: 'utf8', timeout: 110000, maxBuffer: 4e6, env: {...process.env, OSD_LIB_OPEN_ABAP_CORE: lib}});
        assert.equal(run.error, undefined, run.stderr);
        assert.equal(run.status, 2, run.stderr + run.stdout);
        const rows = host === 'unit' ? JSON.parse(run.stdout).rows : JSON.parse(readFileSync(join(out, 'results.json'), 'utf8'));
        assert.equal(rows.length, 7);
        for (const row of rows) {
          assert.equal(row.status, row.method === 'TEXT' ? 'SUCCESS' : 'NOT_COMPILED', JSON.stringify(row));
          if (row.method !== 'TEXT') assert.match(row.message, row.method === 'IMPLICIT' ? /exception attribute TEXTID/ : /exception attribute IF_T100_MESSAGE~T100KEY/);
        }
      }
    } finally { rmSync(dir, {recursive: true, force: true}); }
  });
  it('keeps kernel long texts refused by name after widening', () => {
    const dir = mkdtempSync(join(tmpdir(), 'exc-longtext-'));
    const input = join(dir, 'input'); mkdirSync(input);
    try {
      for (const name of ['zcl_gogen_t_excprev.clas.abap', 'zcl_gogen_t_excprev.clas.testclasses.abap', 'zcx_gogen_t_previous.clas.abap'])
        copyFileSync(join('tools/gogen/testdata', name), join(input, name));
      const source = join(input, 'zcl_gogen_t_excprev.clas.abap');
      writeFileSync(source, readFileSync(source, 'utf8').replace(/  METHOD run\.[\s\S]*?  ENDMETHOD\./,
        '  METHOD run. DATA root TYPE REF TO cx_root. root = widen( ). result = root->get_longtext( ). ENDMETHOD.'));
      for (const host of ['unit', 'unit-js']) {
        const out = join(dir, host);
        const run = spawnSync(process.execPath, [`tools/gogen/${host}.mjs`, '--fixture', input, '--out', out],
          {encoding: 'utf8', timeout: 110000, maxBuffer: 4e6});
        assert.equal(run.error, undefined, run.stderr);
        assert.equal(run.status, 2, run.stderr + run.stdout);
        const result = host === 'unit' ? JSON.parse(run.stdout).rows : JSON.parse(readFileSync(join(out, 'results.json'), 'utf8'));
        const row = result.find(r => r.method === 'CHAIN');
        assert.equal(row.status, 'NOT_COMPILED', JSON.stringify(result));
        assert.match(row.message, /exception method GET_LONGTEXT/);
      }
    } finally { rmSync(dir, {recursive: true, force: true}); }
  });
});
