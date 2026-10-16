#!/usr/bin/env node
// Classic reports, through Lars's PROG-to-CLAS converter, into a transaction
// this tree's webgui can enter (spike, backlog G.5 -- docs/gui-reports.md).
//
// Three pieces, generated together for every *.prog.abap the content
// folders declare (src + every pack, tools/osd-packs.mjs, the same
// convention amdp-gen.mjs and osd-tran-registry.mjs already follow):
//
//   1. the converted report, converter/src/api.mjs's own output, unmodified
//      -- a class implementing zif_gg_report_v1 (or zif_gg_dynpro_v1 for a
//      module pool, which this generator writes but does not wire: the
//      bridge below only drives a report, not a dynpro)
//   2. a wrapper class implementing this tree's ZIF_OSD_TRANSACTION,
//      hand-shaped once and stamped out per report, because
//      ZCL_OSD_TRAN_REGISTRY does a static `CREATE OBJECT ... TYPE
//      <className>` with no constructor argument -- one class per report is
//      the smallest change that fits that contract
//   3. the *.tran.xml naming the wrapper, so ZCL_OSD_TRAN_REGISTRY picks it
//      up the way it picks up any other transaction (CLAUDE.md, backlog E.1:
//      later folder wins a name, same as everywhere else)
//
// The bridge the wrapper drives, in one paragraph (docs/gui-reports.md has
// the rest): Lars's own zcl_gg_host_runtime keeps a session's state in its
// own CLASS-DATA, keyed by a session id it hands back in every response --
// so ZIF_OSD_TRANSACTION's own state string only has to carry that id, not
// the report's model. The page Lars renders already posts a plain HTML form
// to a real relative URL, `action="/dispatch"`, with every field the
// dispatcher needs as a plain form field (session_id, page_id, and either
// gg_ucomm or gg_action carrying the verb) -- so the one rewrite this
// wrapper has to do is turn that action into `sapevent:dispatch`, and
// cl_gui_control's existing rewrite and cl_gui_html_viewer's existing raise
// (docs/webgui.md, G.2) carry the rest unchanged. The wrapper's own
// `request_of` is a deliberately small subset of what
// framework/http/zcl_gg_http_handler.clas.abap parses for the same fields
// (SUBMIT/Execute, EXIT/Cancel, a list LINE click, a COMMAND button) --
// enough for the three examples this pack fetches, not a second copy of
// Lars's own HTTP adapter.
import {readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, statSync} from "node:fs";
import {basename, join, resolve} from "node:path";
import {contentFoldersOf, winningByLayer} from "./osd-packs.mjs";
import {hostModules} from "./osd-host.mjs";
import {systemFile} from "./osd-system.mjs";
import {libraryPath} from "./osd-lib-path.mjs";
import {stripLiterals} from "./abap-additions.mjs";

const DEFAULT_OUT = "gen/gui";
const CONVERTER = "converter/src/api.mjs";

/** A closed dispatch table for one-shot batch execution. The host owns the
 * report lifecycle; this registry only chooses a converter-proven report and
 * returns its typed result. No transaction session or HTML is involved. */
export function batchRegistrySource(reports) {
  const known = reports.filter((entry) => entry.programName !== undefined);
  const supported = known.filter((entry) => entry.wired === true)
    .map((entry) => `      WHEN ${abapLiteral(entry.programName)}. rv_supported = abap_true.`).join("\n");
  const cases = known.map((entry) => `      WHEN ${abapLiteral(entry.programName)}.
${entry.wired === true ? `        lo_report = NEW ${entry.className.toLowerCase()}( ).
${[...new Set(entry.selectionNames ?? [])].map((name) => `        INSERT ${abapLiteral(name)} INTO TABLE lt_allowed.`).join("\n")}
${(entry.selectionElements ?? []).filter((element) => element.kind === "select-option").map((element) => `        INSERT ${abapLiteral(element.name)} INTO TABLE lt_select_options.`).join("\n")}
${(entry.selectionElements ?? []).filter((element) => /\bLOWER\s+CASE\b/i.test(stripLiterals(element.additions))).map((element) => `        INSERT ${abapLiteral(element.name)} INTO TABLE lt_lower_case.`).join("\n")}` : `        rs_result-status = 'UNSUPPORTED'.
        rs_result-detail = ${abapLiteral(entry.skipped ?? "conversion unsupported")}.
        RETURN.`}`).join("\n");
  return `CLASS zcl_osd_batch_report DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    TYPES: BEGIN OF ty_result,
             status   TYPE string,
             detail   TYPE string,
             lines    TYPE zcl_gg_host_list=>ty_text_lines,
             messages TYPE zcl_gg_host_session=>ty_messages,
             terminal TYPE string,
             navigation TYPE zif_gg_host_html_v1=>ty_navigation,
           END OF ty_result.
    CLASS-METHODS run
      IMPORTING
        iv_program TYPE string
        it_input TYPE zif_gg_selection_screen_types=>ty_values OPTIONAL
        iv_batch TYPE abap_bool DEFAULT abap_true
      RETURNING VALUE(rs_result) TYPE ty_result.
    CLASS-METHODS submit
      IMPORTING
        iv_program TYPE string
        it_input TYPE zif_gg_selection_screen_types=>ty_values OPTIONAL
        iv_batch TYPE abap_bool DEFAULT abap_false.
    CLASS-METHODS submit_via_job
      IMPORTING iv_program TYPE string iv_jobname TYPE string
                iv_jobcount TYPE string iv_authcknam TYPE tbtcjob-sdluname
                it_input TYPE zif_gg_selection_screen_types=>ty_values OPTIONAL.
    CLASS-METHODS supports
      IMPORTING iv_program TYPE string
      RETURNING VALUE(rv_supported) TYPE abap_bool.
    CLASS-METHODS result_of
      IMPORTING is_host TYPE zcl_gg_host=>ty_result
      RETURNING VALUE(rs_result) TYPE ty_result.
ENDCLASS.

CLASS zcl_osd_batch_report IMPLEMENTATION.
  METHOD supports.
    DATA lv_program TYPE string.
    lv_program = iv_program.
    TRANSLATE lv_program TO UPPER CASE.
    CASE lv_program.
${supported}
    ENDCASE.
  ENDMETHOD.
  METHOD run.
    DATA lv_program TYPE string.
    DATA lv_name TYPE string.
    DATA lt_allowed TYPE SORTED TABLE OF string WITH UNIQUE KEY table_line.
    DATA lt_select_options TYPE SORTED TABLE OF string WITH UNIQUE KEY table_line.
    DATA lt_lower_case TYPE SORTED TABLE OF string WITH UNIQUE KEY table_line.
    DATA lt_input TYPE zif_gg_selection_screen_types=>ty_values.
    DATA lo_screen TYPE REF TO zcl_gg_host_screen.
    DATA lt_elements TYPE zcl_gg_host_screen=>ty_elements.
    DATA lo_report TYPE REF TO zif_gg_report_v1.
    DATA ls_host TYPE zcl_gg_host=>ty_result.
    lv_program = iv_program.
    TRANSLATE lv_program TO UPPER CASE.
    CASE lv_program.
${cases}
      WHEN OTHERS.
        rs_result-status = 'UNKNOWN'.
        rs_result-detail = |Report { iv_program } is not in the converted report registry|.
        RETURN.
    ENDCASE.
    lo_screen = NEW zcl_gg_host_screen( ).
    lo_report->build_screen( lo_screen ).
    lt_elements = lo_screen->get_elements( ).
    LOOP AT it_input INTO DATA(ls_input).
      lv_name = ls_input-name.
      TRANSLATE lv_name TO UPPER CASE.
      IF NOT line_exists( lt_allowed[ table_line = lv_name ] ).
        rs_result-status = 'INVALID_INPUT'.
        rs_result-detail = |Unknown selection field { ls_input-name } for { lv_program }|.
        RETURN.
      ENDIF.
      ls_input-name = lv_name.
      IF line_exists( lt_select_options[ table_line = lv_name ] ).
        IF ls_input-ranges IS INITIAL.
          APPEND VALUE #( sign = 'I' option = 'EQ' low = ls_input-value ) TO ls_input-ranges.
        ENDIF.
        IF line_exists( lt_input[ name = lv_name ] ).
          APPEND LINES OF ls_input-ranges TO lt_input[ name = lv_name ]-ranges.
        ELSE.
          INSERT ls_input INTO TABLE lt_input.
        ENDIF.
      ELSE.
        IF ls_input-ranges IS NOT INITIAL.
          READ TABLE ls_input-ranges INTO DATA(ls_last_range) INDEX lines( ls_input-ranges ).
          ls_input-value = ls_last_range-low.
          CLEAR ls_input-ranges.
        ENDIF.
        IF line_exists( lt_input[ name = lv_name ] ).
          lt_input[ name = lv_name ] = ls_input.
        ELSE.
          INSERT ls_input INTO TABLE lt_input.
        ENDIF.
      ENDIF.
    ENDLOOP.
    LOOP AT lt_input ASSIGNING FIELD-SYMBOL(<ls_value>).
      READ TABLE lt_elements INTO DATA(ls_element) WITH KEY name = <ls_value>-name.
      IF sy-subrc <> 0.
        CONTINUE.
      ENDIF.
      IF line_exists( lt_select_options[ table_line = <ls_value>-name ] ).
        DELETE <ls_value>-ranges WHERE sign = '#' AND option = '  '
          AND low = '' AND high = ''.
        LOOP AT <ls_value>-ranges ASSIGNING FIELD-SYMBOL(<ls_range>).
          DATA(lv_lower_case) = xsdbool( sy-tabix <> 1
            OR line_exists( lt_lower_case[ table_line = <ls_value>-name ] ) ).
          <ls_range>-low = zcl_osd_submit_semantics=>value(
            iv_value = <ls_range>-low is_type = ls_element-data_type
            iv_lower_case = lv_lower_case ).
          IF <ls_range>-high IS NOT INITIAL.
            <ls_range>-high = zcl_osd_submit_semantics=>value(
              iv_value = <ls_range>-high is_type = ls_element-data_type
              iv_lower_case = lv_lower_case ).
          ENDIF.
        ENDLOOP.
      ELSE.
        <ls_value>-value = zcl_osd_submit_semantics=>value(
          iv_value = <ls_value>-value is_type = ls_element-data_type
          iv_lower_case = xsdbool( line_exists( lt_lower_case[ table_line = <ls_value>-name ] ) ) ).
      ENDIF.
    ENDLOOP.
    ls_host = zcl_gg_host=>run(
      io_report = lo_report
      iv_program = CONV #( lv_program )
      it_input = lt_input
      iv_batch = iv_batch ).
    rs_result = result_of( ls_host ).
  ENDMETHOD.

  METHOD submit.
    DATA lv_subrc TYPE sysubrc.
    lv_subrc = sy-subrc.
    DATA(ls_result) = run(
      iv_program = iv_program
      it_input = it_input
      iv_batch = iv_batch ).
    IF ls_result-status <> 'COMPLETED'.
      RAISE EXCEPTION NEW zcx_osd_submit(
        iv_detail = |SUBMIT { iv_program }: { ls_result-status } { ls_result-detail }| ).
    ENDIF.
    sy-subrc = lv_subrc.
  ENDMETHOD.

  METHOD submit_via_job.
    DATA lv_subrc TYPE sysubrc.
    lv_subrc = sy-subrc.
    DATA lv_error TYPE string.
    DATA lv_input TYPE string.
    IF iv_authcknam <> sy-uname.
      RAISE EXCEPTION NEW zcx_osd_submit( iv_detail = 'SUBMIT authorization user mismatch' ).
    ENDIF.
    IF supports( iv_program ) <> abap_true.
      RAISE EXCEPTION NEW zcx_osd_submit( iv_detail = |SUBMIT { iv_program }: program_missing| ).
    ENDIF.
    lv_input = /ui2/cl_json=>serialize( data = it_input ).
    CALL FUNCTION 'ZOSD_JOB_PORT' DESTINATION 'JOBS'
      EXPORTING iv_command = 'SUBMIT' iv_jobname = iv_jobname
                iv_jobcount = iv_jobcount iv_program = iv_program
                iv_input_json = lv_input iv_owner = sy-uname iv_client = sy-mandt
      IMPORTING ev_error = lv_error.
    IF lv_error IS NOT INITIAL.
      RAISE EXCEPTION NEW zcx_osd_submit( iv_detail = |SUBMIT { iv_program }: { lv_error }| ).
    ENDIF.
    sy-subrc = lv_subrc.
  ENDMETHOD.

  METHOD result_of.
    rs_result-lines = is_host-lines.
    rs_result-messages = is_host-messages.
    rs_result-terminal = is_host-terminal.
    rs_result-navigation = is_host-navigation.
    IF is_host-unsupported IS NOT INITIAL.
      rs_result-status = 'UNSUPPORTED'.
      rs_result-detail = is_host-unsupported.
    ELSEIF ( is_host-terminal IS NOT INITIAL
        AND is_host-terminal <> 'LEAVE PROGRAM' )
        OR ( is_host-navigation-kind IS NOT INITIAL
        AND is_host-navigation-kind <> zcx_gg_control_flow=>kind_leave_program )
        OR is_host-submit-program IS NOT INITIAL
        OR is_host-transaction_call-tcode IS NOT INITIAL.
      rs_result-status = 'INCOMPLETE'.
      rs_result-detail = |Report requested { is_host-navigation-kind } { is_host-navigation-target } { is_host-terminal }|.
    ELSEIF is_host-selection_active = abap_true.
      rs_result-status = 'SELECTION'.
      rs_result-detail = 'Selection screen did not complete'.
    ELSE.
      rs_result-status = 'COMPLETED'.
    ENDIF.
  ENDMETHOD.
ENDCLASS.
`;
}

/** every *.prog.abap under the given folders */
function reportFiles(folders) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, {withFileTypes: true});
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
        walk(path);
      } else if (/\.prog\.abap$/i.test(entry.name)) {
        out.push(path);
      }
    }
  };
  for (const folder of folders) walk(folder);
  return out;
}

/** REPORT <name>. is a report's own first statement; read it without paying
 *  for a parse just to name the generated objects. */
export function programNameOf(source) {
  const m = /^\s*REPORT\s+([a-z_][a-z0-9_]*)\s*(?:\.|MESSAGE-ID)/im.exec(source);
  return m ? m[1].toUpperCase() : undefined;
}

/** the three names generated for one report, all derived from its program
 *  name so a second run names the same report the same thing */
export function namesOf(programName) {
  const base = programName.replace(/^Z/i, "").toUpperCase();
  return {
    base,
    className: `ZCL_OSD_GUI_${base}`,
    wrapperClassName: `ZCL_OSD_GUITX_${base}`,
    tcode: `ZGUI_${base}`,
  };
}

// The converter emits the declarations, while this host supplies SAP's
// selection-screen conversion at the boundary where they enter the builder.
export function selectionSemanticsSource(source, elements) {
  const additions = new Map(elements.map((element) => [element, stripLiterals(element.additions)]));
  const hasExplicitRadioDefault = (element) => {
    const clean = additions.get(element);
    const marker = /\bDEFAULT\b/i.exec(clean);
    return marker !== null && /^(?:'X'|X|ABAP_TRUE)(?=\s|$)/i.test(
      (element.additions ?? "").slice(marker.index + marker[0].length).trimStart());
  };
  const radios = new Map();
  for (const element of elements) {
    if (element.kind !== "parameter") continue;
    const group = /\bRADIOBUTTON\s+GROUP\s+(\w+)/i.exec(additions.get(element))?.[1]?.toUpperCase();
    if (!group) continue;
    if (!radios.has(group)) radios.set(group, []);
    radios.get(group).push(element);
  }
  return source.split("\n").map((line) => {
    const name = /io_builder->add_(?:parameter|select_option|radiobutton)\( VALUE #\( name = '([^']+)'/.exec(line)?.[1];
    const element = elements.find((item) => item.name === name);
    if (!element) return line;
    if (line.includes("io_builder->add_parameter(")) {
      return line.replace("add_parameter( VALUE #(", "add_parameter( zcl_osd_submit_semantics=>parameter( VALUE #(")
        .replace(/\) \)\.$/, ") ) ).");
    }
    if (line.includes("io_builder->add_select_option(")) {
      const option = /\bOPTION\s+(EQ|NE|GT|GE|LT|LE|BT|NB|CP|NP)\b/i.exec(additions.get(element))?.[1]?.toUpperCase();
      const sign = /\bSIGN\s+([IE])\b/i.exec(additions.get(element))?.[1]?.toUpperCase();
      if (option) line = line.replace(/(default = VALUE #\( sign = '[IE]' option = ')[A-Z]+(')/, `$1${option}$2`);
      if (sign) line = line.replace(/(default = VALUE #\( sign = ')[IE](')/, `$1${sign}$2`);
      if (/\bLOWER\s+CASE\b/i.test(additions.get(element)) && !/\blower_case\s*=/i.test(line)) {
        line = line.replace(/\) \)\.$/, " lower_case = abap_true ) ).");
      }
      return line.replace("add_select_option( VALUE #(", "add_select_option( zcl_osd_submit_semantics=>select_option( VALUE #(")
        .replace(/\) \)\.$/, ") ) ).");
    }
    const group = /\bRADIOBUTTON\s+GROUP\s+(\w+)/i.exec(additions.get(element))?.[1]?.toUpperCase();
    const members = radios.get(group) ?? [];
    if (hasExplicitRadioDefault(element) && !line.includes(" default = abap_true")) {
      return line.replace(/\) \)\.$/, " default = abap_true ) ).");
    }
    if (members[0] === element && !members.some(hasExplicitRadioDefault)) {
      return line.replace(/\) \)\.$/, " default = abap_true ) ).");
    }
    return line;
  }).join("\n");
}

/** an ABAP backtick string literal, not a JSON one -- ABAP's `"` starts an
 *  end-of-line comment, so JSON.stringify's double quotes silently eat the
 *  rest of the statement (and, once, everything after it) rather than
 *  erroring where the mistake was made. */
const abapLiteral = (s) => "`" + String(s ?? "").replace(/`/g, "``") + "`";

/** the wrapper class: ZIF_OSD_TRANSACTION driving zcl_gg_host_runtime for
 *  one converted report class. See the module header for the design. */
export function wrapperClassSource({wrapperClassName, className, tcode, title}) {
  const cls = wrapperClassName.toLowerCase();
  return `CLASS ${cls} DEFINITION PUBLIC FINAL CREATE PUBLIC.
* generated by tools/osd-gui-convert.mjs -- do not edit. See docs/gui-reports.md.
*
* ZIF_OSD_TRANSACTION for one converted report, ${className}, run through
* Lars's zcl_gg_host_runtime (open-abap-gui). The state string this class
* hands ZCL_OSD_TRAN is only the host's own session id: the report's actual
* state lives in zcl_gg_host_runtime's CLASS-DATA for as long as this
* process lives, which is the one thing this bridge does not solve --
* docs/gui-reports.md says so.
  PUBLIC SECTION.
    INTERFACES zif_osd_transaction.

    METHODS on_sapevent FOR EVENT sapevent OF cl_gui_html_viewer
      IMPORTING action query_table.

  PRIVATE SECTION.
    DATA mv_session_id TYPE string.
    DATA ms_response TYPE zif_gg_host_html_v1=>ty_response.
    DATA mv_has_response TYPE abap_bool.
    DATA mo_container TYPE REF TO cl_gui_custom_container.
    DATA mo_viewer TYPE REF TO cl_gui_html_viewer.

    METHODS document
      RETURNING VALUE(rv_html) TYPE string.

    METHODS request_of
      IMPORTING it_query          TYPE cnht_query_table
      RETURNING VALUE(rs_request) TYPE zif_gg_host_html_v1=>ty_request.

    METHODS esc
      IMPORTING iv_text        TYPE string
      RETURNING VALUE(rv_text) TYPE string.
ENDCLASS.


CLASS ${cls} IMPLEMENTATION.

  METHOD esc.
    rv_text = cl_gui_control=>escape_html( iv_text ).
  ENDMETHOD.

  METHOD zif_osd_transaction~title.
    IF mv_has_response = abap_true AND ms_response-valid = abap_true
        AND ms_response-current_page-title IS NOT INITIAL.
      rv_title = ms_response-current_page-title.
    ELSE.
      rv_title = ${abapLiteral(title)}.
    ENDIF.
  ENDMETHOD.

  METHOD zif_osd_transaction~message.
    IF mv_has_response = abap_false.
      RETURN.
    ENDIF.
    IF ms_response-valid = abap_false.
      rv_message = ms_response-error.
    ELSEIF lines( ms_response-messages ) > 0.
      rv_message = ms_response-messages[ 1 ]-text.
    ENDIF.
  ENDMETHOD.

  METHOD zif_osd_transaction~roll_in.
    CLEAR: mv_session_id, ms_response, mv_has_response.
    IF iv_state IS INITIAL.
* the first dialog step of this transaction: a fresh host session, its own
* class-data row keyed by the id it hands back below
      ms_response = zcl_gg_host_runtime=>start( io_report = NEW ${className.toLowerCase()}( ) ).
      mv_has_response = abap_true.
      mv_session_id = ms_response-session_id.
    ELSE.
* a later step: the row already exists in zcl_gg_host_runtime's class-data,
* this instance only carries the id back to it
      mv_session_id = iv_state.
    ENDIF.
  ENDMETHOD.

  METHOD zif_osd_transaction~roll_out.
    rv_state = COND #( WHEN mv_has_response = abap_true AND ms_response-session_id IS NOT INITIAL
                        THEN ms_response-session_id
                        ELSE mv_session_id ).
  ENDMETHOD.

  METHOD document.
    IF mv_has_response = abap_false.
* the first PBO of a resumed step, before the click is dispatched: nothing
* rendered here reaches the browser -- ZCL_OSD_TRAN draws again after PAI --
* it only has to exist so cl_gui_html_viewer has something to raise sapevent
* on. docs/webgui.md, "one document per request".
      rv_html = \`<!doctype html><html><body></body></html>\`.
      RETURN.
    ENDIF.
    IF ms_response-valid = abap_false.
      rv_html = \`<!doctype html><html lang="en"><head><meta charset="utf-8"></head><body>\`
        && |<p>{ esc( ms_response-error ) }</p>| && \`</body></html>\`.
      RETURN.
    ENDIF.
    rv_html = ms_response-html.
* Lars's own forms already carry every field the dispatcher reads
* (session_id, page_id, gg_ucomm/gg_action) as plain POST fields; the only
* thing standing between them and cl_gui_control's existing sapevent
* rewrite is the action they post to, which is a real relative URL because
* Lars's own frontend (web/web.mjs) is a plain HTTP client and does not need
* it to be anything else.
    REPLACE ALL OCCURRENCES OF \`action="/dispatch"\` IN rv_html WITH \`action="sapevent:dispatch"\`.
  ENDMETHOD.

  METHOD request_of.
    DATA ls_query TYPE cnht_query_struct.
    DATA lv_gg_ucomm TYPE string.
    DATA lv_gg_action TYPE string.
    DATA lv_kind TYPE string.
    DATA lv_rest TYPE string.
    DATA lv_row TYPE string.
    DATA lv_token TYPE string.
    DATA ls_value TYPE zif_gg_selection_screen_types=>ty_value.

    LOOP AT it_query INTO ls_query.
      CASE ls_query-name.
        WHEN 'session_id'.
          rs_request-session_id = ls_query-value.
        WHEN 'page_id'.
          rs_request-page_id = ls_query-value.
        WHEN 'gg_ucomm'.
          lv_gg_ucomm = ls_query-value.
        WHEN 'gg_action'.
          lv_gg_action = ls_query-value.
        WHEN 'action' OR 'gg_free_action'.
* the plain SUBMIT / free-selection marker of the form itself, not a value
* of the report's own selection screen
        WHEN OTHERS.
          CLEAR ls_value.
          ls_value-name = ls_query-name.
          ls_value-value = ls_query-value.
          INSERT ls_value INTO TABLE rs_request-values.
      ENDCASE.
    ENDLOOP.

* This is a deliberately small subset of what
* framework/http/zcl_gg_http_handler.clas.abap's request_from_payload does
* with the same fields -- enough for Execute/Cancel on a selection screen, a
* list line click and a plain command button. docs/gui-reports.md names
* what is not covered (tabs, dynpro grids, F4, free selections).
    IF lv_gg_ucomm IS NOT INITIAL.
      rs_request-action = zif_gg_host_html_v1=>action_submit.
      rs_request-ucomm  = lv_gg_ucomm.
      RETURN.
    ENDIF.
    IF lv_gg_action IS INITIAL.
      RETURN.
    ENDIF.
    SPLIT lv_gg_action AT ':' INTO lv_kind lv_rest.
    CASE lv_kind.
      WHEN 'LINE'.
        rs_request-action = zif_gg_host_html_v1=>action_line.
        SPLIT lv_rest AT '|' INTO lv_row lv_token.
        rs_request-row   = lv_row.
        rs_request-token = lv_token.
      WHEN 'COMMAND'.
        rs_request-action = zif_gg_host_html_v1=>action_command.
        rs_request-ucomm  = lv_rest.
      WHEN 'EXIT'.
        rs_request-action = zif_gg_host_html_v1=>action_exit.
      WHEN 'SCREEN'.
        rs_request-action = zif_gg_host_html_v1=>action_screen.
        rs_request-target = lv_rest.
      WHEN OTHERS.
* a kind this bridge does not parse (TAB, a dynpro grid cell, ...): treated
* as a command with the whole value as its ucomm, which is wrong for some of
* them and refused by the host rather than silently misfiring for the rest
        rs_request-action = zif_gg_host_html_v1=>action_command.
        rs_request-ucomm  = lv_kind.
    ENDCASE.
  ENDMETHOD.

  METHOD on_sapevent.
    ms_response = zcl_gg_host_runtime=>dispatch( request_of( query_table ) ).
    mv_has_response = abap_true.
  ENDMETHOD.

  METHOD zif_osd_transaction~pbo.
* Built from scratch every dialog step, the way ZCL_OSD_NOTE is: PBO runs
* once before the click is dispatched (registering the viewer sapevent is
* raised on) and once after (rendering what the click produced), and
* cl_gui_control's snapshots are class data that ZCL_OSD_TRAN clears between
* the two, so nothing here may assume it survives from the first call to the
* second.
    DATA lt_html   TYPE STANDARD TABLE OF string WITH DEFAULT KEY.
    DATA lt_events TYPE cntl_simple_events.
    DATA ls_event  LIKE LINE OF lt_events.
    DATA lv_html   TYPE string.
    DATA lv_url    TYPE c LENGTH 255.

    CREATE OBJECT mo_container
      EXPORTING
        container_name = 'OSD_GUI'.
    CREATE OBJECT mo_viewer
      EXPORTING
        parent = mo_container.

    ls_event-eventid    = cl_gui_html_viewer=>m_id_sapevent.
    ls_event-appl_event = abap_true.
    APPEND ls_event TO lt_events.
    mo_viewer->set_registered_events( lt_events ).

    SET HANDLER on_sapevent FOR mo_viewer.

    lv_html = document( ).
    APPEND lv_html TO lt_html.
    CALL METHOD mo_viewer->load_data
      EXPORTING
        type         = 'text'
        subtype      = 'html'
        size         = strlen( lv_html )
      IMPORTING
        assigned_url = lv_url
      CHANGING
        data_table   = lt_html
      EXCEPTIONS
        OTHERS       = 1.
    IF sy-subrc = 0.
      CALL METHOD mo_viewer->show_url
        EXPORTING
          url    = lv_url
        EXCEPTIONS
          OTHERS = 1.
    ENDIF.
  ENDMETHOD.

ENDCLASS.
`;
}

/** the *.tran.xml naming the wrapper -- abapGit's own TRAN shape,
 *  tools/osd-tran-registry.mjs reads it the same way it reads a hand-written
 *  one (src/webgui/zosd_note.tran.xml is the model). */
export function tranXml({wrapperClassName, tcode, title}) {
  const t = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<?xml version="1.0" encoding="utf-8"?>
<abapGit version="v1.0.0" serializer="LCL_OBJECT_TRAN" serializer_version="v1.0.0">
 <asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0">
  <asx:values>
   <TSTC>
    <TCODE>${tcode}</TCODE>
    <PGMNA>${wrapperClassName}</PGMNA>
   </TSTC>
   <TSTCC>
    <TCODE>${tcode}</TCODE>
    <S_WEBGUI>1</S_WEBGUI>
   </TSTCC>
   <TSTCT>
    <SPRSL>E</SPRSL>
    <TCODE>${tcode}</TCODE>
    <TTEXT>${t(title)}</TTEXT>
   </TSTCT>
   <TSTCP>
    <TCODE>${tcode}</TCODE>
    <PARAM>\\PROGRAM=${wrapperClassName}\\CLASS=${wrapperClassName}\\METHOD=ZIF_OSD_TRANSACTION~PBO</PARAM>
   </TSTCP>
  </asx:values>
 </asx:abap>
</abapGit>
`;
}

export async function generate(folders, out = DEFAULT_OUT, options = {}) {
  const root = options.root ?? process.cwd();
  // import() needs a file:// URL for an absolute path: a bare "C:\..." is
  // read as a URL with the scheme "c:" on Windows. node:url is loaded here,
  // not at module scope, so a bundle with its own guiConverter never needs it.
  const {convertProgram} = hostModules()?.guiConverter ?? await import(
    (await import(/* webpackIgnore: true */ "node:url")).pathToFileURL(resolve(libraryPath(root, "open-abap-gui"), CONVERTER)).href);
  const reports = [];
  const files = winningByLayer(folders, (folder) => reportFiles([folder]),
    (file) => basename(file).replace(/\.prog\.abap$/i, "").toUpperCase());
  const candidates = files.map((file) => {
    const source = readFileSync(file, "utf8");
    return {file, source, programName: programNameOf(source)};
  });
  const seen = new Map();
  for (const candidate of candidates) {
    if (candidate.programName === undefined) continue;
    const previous = seen.get(candidate.programName);
    if (previous !== undefined) {
      throw new Error(`duplicate REPORT ${candidate.programName}: ${previous} and ${candidate.file}`);
    }
    seen.set(candidate.programName, candidate.file);
  }
  rmSync(out, {recursive: true, force: true});

  for (const {file, source, programName} of candidates) {
    if (programName === undefined) {
      reports.push({file, skipped: "no REPORT statement found"});
      continue;
    }
    const names = namesOf(programName);
    if (names.className.length > 30 || names.wrapperClassName.length > 30) {
      reports.push({file, programName, ...names, skipped: `derived class name (${names.wrapperClassName}, ${names.wrapperClassName.length} chars) exceeds ABAP's 30-character limit`});
      continue;
    }
    const attempt = async (mode, partialStrategy) => convertProgram({
      source,
      filename: basename(file),
      mode,
      partialStrategy,
      className: names.className,
      transactionCode: names.tcode,
    });
    let result = await attempt("strict");
    let usedMode = "strict";
    if (result.supported === false) {
      result = await attempt("partial", "skeleton");
      usedMode = "partial/skeleton";
    }
    mkdirSync(out, {recursive: true});
    const selectionElements = (result.reportIR?.selections ?? [])
      .flatMap((screen) => screen.elements ?? [])
      .filter((element) => ["parameter", "select-option"].includes(element.kind));
    const selectionNames = selectionElements
      .map((element) => element.name).filter(Boolean);
    const entry = {file, programName, ...names, mode: usedMode, supported: result.supported, diagnostics: result.diagnostics.length, selectionNames, selectionElements};
    if (result.classSource !== undefined) {
      writeFileSync(join(out, `${names.className.toLowerCase()}.clas.abap`),
        selectionSemanticsSource(result.classSource, selectionElements));
      for (const helper of result.helperSources ?? []) {
        writeFileSync(join(out, `${helper.className.toLowerCase()}.clas.abap`), helper.source);
      }
    }
    const kind = result.reportIR?.programKind;
    if (result.supported !== true) {
      entry.skipped = `conversion unsupported even in ${usedMode} mode`;
    } else if (kind !== "report") {
      entry.skipped = `programKind is ${kind}; this bridge only drives zif_gg_report_v1 (a dynpro host bridge is not built)`;
    } else {
      const title = result.reportIR?.description || result.reportIR?.reportTitle || `Converted report ${programName}`;
      writeFileSync(join(out, `${names.wrapperClassName.toLowerCase()}.clas.abap`), wrapperClassSource({...names, title}));
      writeFileSync(join(out, `${names.wrapperClassName.toLowerCase()}.tran.xml`), tranXml({...names, title}));
      entry.wired = true;
    }
    reports.push(entry);
  }
  mkdirSync(out, {recursive: true});
  writeFileSync(join(out, "zcl_osd_batch_report.clas.abap"), batchRegistrySource(reports));
  return {reports};
}

function usage() {
  console.log(`usage: osd-gui-convert.mjs [--out gen/gui]

Converts every *.prog.abap under the content folders (src + every pack) with
open-abap-gui's converter and, for every report it can run, writes a
ZIF_OSD_TRANSACTION wrapper and a *.tran.xml so webgui can enter it as a
transaction. docs/gui-reports.md has the design and the gaps.`);
}

if (basename(process.argv[1] ?? "") === "osd-gui-convert.mjs") {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    usage();
    process.exit(0);
  }
  const out = args.includes("--out") ? args[args.indexOf("--out") + 1] : DEFAULT_OUT;
  // Local integration reports are an input to this generator when present.
  // The VSIX seed omits those reports, so its generation has no demo entries.
  const folders = [...contentFoldersOf(process.cwd()), systemFile(process.cwd(), "test/integration")];
  const {reports} = await generate(folders, out);
  if (reports.length === 0) {
    console.log("osd-gui-convert: no *.prog.abap found");
  }
  for (const r of reports) {
    if (r.skipped !== undefined) {
      console.log(`osd-gui-convert: ${r.file}: skipped -- ${r.skipped}`);
    } else if (r.wired === true) {
      console.log(`osd-gui-convert: ${r.file} -> ${r.className} (${r.mode}), ${r.tcode} runs ${r.wrapperClassName}`);
    }
  }
}
