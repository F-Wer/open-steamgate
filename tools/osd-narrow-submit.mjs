// Lower only the synchronous, static SUBMIT slice that the one-shot report
// registry can execute. The upstream transpiler still throws for SUBMIT; a
// broader rewrite here would make unsupported SAP syntax appear to work.
// Parse statements with abaplint so comments and string literals are never
// mistaken for an operator. Keep the line count stable for source maps.

// A report name, a namespaced one included; SAP allows 40 characters.
const PROGRAM = /^(?:\/[A-Z0-9_]+\/)?[A-Z][A-Z0-9_]*$/i;
const PROGRAM_MAX = 40;
// A selection name as SELECT-OPTIONS / PARAMETERS declare it.
const SELECTION = /^[A-Z_][A-Z0-9_]*$/i;
// A data object the caller passes: a name with component, instance and
// static access (`ls-f`, `lo->a`, `zcl=>c`, chained), or a literal.
const OPERAND = /^(?:[A-Z_][A-Z0-9_]*(?:(?:-|->|=>)[A-Z_][A-Z0-9_]*)*|'(?:[^']|'')*'|`[^`]*`|-?\d+(?:\.\d+)?)$/i;
// WDash is a minus with a space before it: in `WITH p = -3` it joins the
// number after it; before a name it makes `-x`, which OPERAND refuses.
const JOINERS = new Set(["Dash", "WDash", "InstanceArrow", "StaticArrow"]);

function offsetAt(source, position) {
  let offset = 0;
  for (let row = 1; row < position.getRow(); row++) {
    const next = source.indexOf("\n", offset);
    if (next < 0) throw new Error("ABAP source position exceeds the file");
    offset = next + 1;
  }
  return offset + position.getCol() - 1;
}

// abaplint splits `ls_x-field` and `lo_job->name` into three tokens each. A
// SUBMIT operand is one data object, so tokens joined by `-`, `->` or `=>`
// with no space between them become one word again.
function wordsOf(statement) {
  const words = [];
  let last;
  for (const token of statement.getTokens()) {
    const kind = token.constructor.name;
    const touches = last !== undefined && token.getStart().getRow() === last.getStart().getRow()
      && token.getStart().getCol() === last.getStart().getCol() + last.getStr().length;
    if (touches && (JOINERS.has(kind) || JOINERS.has(last.constructor.name))) {
      words[words.length - 1] += token.getStr();
    } else {
      words.push(token.getStr());
    }
    last = token;
  }
  return words;
}

function replacement(statement, filename) {
  const words = wordsOf(statement);
  const line = statement.getStart().getRow();
  const unsupported = (why) => {
    throw new Error(`${filename}:${line}: supported SUBMIT forms are a static program with, in any order, `
      + `[VIA JOB job NUMBER count] and [WITH sel = value | WITH sel IN range ...], then AND RETURN`
      + `${why ? ` (${why})` : ""}; got ${statement.concatTokens()}`);
  };
  const upper = (at) => words[at]?.toUpperCase();
  if (upper(0) !== "SUBMIT" || !PROGRAM.test(words[1] ?? "") || words[1].length > PROGRAM_MAX || words.at(-1) !== ".") unsupported();
  const program = words[1].toUpperCase();
  const values = [];
  let job;
  let at = 2;
  while (!(upper(at) === "AND" && upper(at + 1) === "RETURN" && at + 2 === words.length - 1)) {
    if (upper(at) === "VIA") {
      if (job !== undefined) unsupported("VIA JOB twice");
      if (upper(at + 1) !== "JOB" || !OPERAND.test(words[at + 2] ?? "")
          || upper(at + 3) !== "NUMBER" || !OPERAND.test(words[at + 4] ?? "")) unsupported();
      job = {name: words[at + 2], count: words[at + 4]};
      at += 5;
    } else if (upper(at) === "WITH") {
      const name = words[at + 1];
      const operator = upper(at + 2);
      const value = words[at + 3];
      if (!SELECTION.test(name ?? "") || !["=", "EQ", "IN"].includes(operator) || !OPERAND.test(value ?? "")) unsupported();
      values.push({name: name.toUpperCase(), value, range: operator === "IN"});
      at += 4;
    } else {
      unsupported();
    }
  }
  const rows = values.map(({name, value, range}) => range
    ? `( name = '${name}' ranges = zcl_osd_submit_ranges=>for_submit( ${value} ) )`
    : `( name = '${name}' value = CONV string( ${value} ) )`);
  const input = rows.length === 0 ? "" : ` it_input = zcl_osd_submit_semantics=>combine( VALUE #( ${rows.join(" ")} ) )`;
  const saved = `lv_osd_submit_subrc_${line}_${statement.getStart().getCol()}`;
  // SAP's SUBMIT takes the job name and count in its own types (TBTCJOB-
  // JOBNAME, CHAR 32; TBTCJOB-JOBCOUNT, CHAR 8); the registry's parameters
  // are STRING, so each is converted rather than passed by reference
  // (ANORMALIES 2026-10-01-submit-via-job-char-operands)
  const call = job ? `zcl_osd_batch_report=>submit_via_job( iv_program = '${program}' iv_jobname = CONV string( ${job.name} ) iv_jobcount = CONV string( ${job.count} ) iv_authcknam = sy-uname${input} ).` :
    `zcl_osd_batch_report=>submit( iv_program = '${program}'${input} iv_batch = sy-batch ).`;
  return `DATA(${saved}) = sy-subrc. ${call} sy-subrc = ${saved}.`;
}

// The lowered call takes the statement's first line. A comment the developer
// wrote inside the statement stays on the line it was on, so neither the
// comment nor the line count is lost.
function withComments(lowered, comments, startRow, lineCount, indent) {
  const lines = [lowered, ...Array(lineCount - 1).fill("")];
  for (const token of comments) {
    const index = token.getStart().getRow() - startRow;
    const text = token.getStr();
    if (index === 0) {
      lines[0] += ` "${text.replace(/^["*]\s?/, " ")}`;
    } else {
      lines[index] = text.startsWith("*") ? text : `${indent}${text}`;
    }
  }
  return lines.join("\n");
}

/** @param {string} source @param {string} filename @param {typeof import("@abaplint/core")} core */
export function lowerNarrowSubmit(source, filename, core) {
  if (!/\.abap$/i.test(filename) || !/\bSUBMIT\b/i.test(source)) return source;
  const registry = new core.Registry().addFile(new core.MemoryFile(filename, source)).parse();
  /** @type {readonly import("@abaplint/core").ABAPFile[] | undefined} */ const files = registry.getFirstObject()?.getABAPFiles();
  const file = files?.find((entry) => entry.getFilename() === filename);
  if (file === undefined) return source;
  const changes = [];
  for (const statement of file.getStatements()) {
    if (!/^(Submit|Unknown)$/.test(statement.get().constructor.name) ||
        statement.getTokens()[0]?.getStr()?.toUpperCase() !== "SUBMIT") continue;
    const start = offsetAt(source, statement.getStart());
    const end = offsetAt(source, statement.getEnd());
    const original = source.slice(start, end);
    const comments = file.getTokens().filter((token) => token.constructor.name === "Comment"
      && offsetAt(source, token.getStart()) >= start && offsetAt(source, token.getStart()) < end);
    const indent = " ".repeat(Math.max(0, statement.getStart().getCol() - 1));
    const lowered = withComments(replacement(statement, filename), comments,
      statement.getStart().getRow(), (original.match(/\n/g) ?? []).length + 1, indent);
    changes.push({start, end, lowered});
  }
  for (const change of changes.reverse()) {
    source = source.slice(0, change.start) + change.lowered + source.slice(change.end);
  }
  return source;
}
