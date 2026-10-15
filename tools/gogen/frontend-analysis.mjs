// Source-only analyses, keyed by the immutable parsed/rearranged node.
import {readText, listEntries, join} from "./host-io.ts";
import {parseSamc} from "../osd-samc.ts";

// Match frontend.mjs: AST instanceof checks must use the transpiler's core.
import {createRequire} from "node:module";
const require = createRequire(import.meta.url);
const transpilerRequire = createRequire(require.resolve("@abaplint/transpiler/package.json"));
const abaplint = transpilerRequire("@abaplint/core");
const {CDSLexer} = transpilerRequire("@abaplint/core/build/src/cds/cds_lexer");
const {seq, star, opt} = transpilerRequire("@abaplint/core/build/src/abap/2_statements/combi");
const {Result} = transpilerRequire("@abaplint/core/build/src/abap/2_statements/result");
const {Expressions, ExpressionsCDS, Nodes} = abaplint;

const trees = new WeakMap();
const inlineTables = new WeakMap();
export function rearrangedClass(node, Rearranger) {
  if (!trees.has(node)) trees.set(node, new Rearranger().run("CLAS", node));
  return trees.get(node);
}

export function inlineTableLocals(body) {
  if (!body) return new Set();
  if (!inlineTables.has(body)) {
    const names = new Set();
    for (const st of body.findAllStatementNodes()) {
      for (const into of st.findAllExpressions(Expressions.SQLIntoTable)) {
        for (const inline of into.findAllExpressions(Expressions.InlineData)) {
          const name = inline.findFirstExpression(Expressions.TargetField);
          if (name) names.add(name.concatTokens().toUpperCase());
        }
      }
    }
    inlineTables.set(body, names);
  }
  return inlineTables.get(body);
}

// The later folder wins each AMC channel name, as the runtime layers do.
export function samcOf(folders) {
  const byName = new Map();
  const walk = (dir) => {
    let entries;
    try { entries = listEntries(dir); } catch { return; }
    for (const [name, directory] of entries.sort((a, b) => a[0].localeCompare(b[0]))) {
      if (directory) walk(join(dir, name));
      else if (name.toLowerCase().endsWith(".samc.xml")) byName.set(name.toUpperCase(), join(dir, name));
    }
  };
  for (const f of folders) walk(f);
  const rows = [...byName.values()].flatMap((file) => parseSamc(readText(file), file));
  return [...new Map(rows.map((r) => [`${r.applicationId}|${r.path}`, r])).values()];
}

// Keep failures out of the serializable map and defer them until SQL uses a
// view. The map belongs to the registry, including reused registry compiles.
const cdsFailures = new WeakMap();
export const cdsMappingError = (views, name) => cdsFailures.get(views)?.get(name);
// Let core parse the header even when the SELECT body cannot be parsed. This
// preserves the definition name when the abapGit object has a different name.
const cdsHeader = seq(star(ExpressionsCDS.CDSAnnotation), opt("DEFINE"), opt("ROOT"),
  opt("WRITABLE"), "VIEW", opt("ENTITY"), ExpressionsCDS.CDSName);
function sqlViewName(annotations) {
  for (const annotation of annotations) {
    const key = annotation.getChildren().filter(c => c instanceof Nodes.TokenNode)
      .map(c => c.getFirstToken().getStr()).join("").toUpperCase();
    if (key !== "@ABAPCATALOG.SQLVIEWNAME:") continue;
    const value = annotation.findFirstExpression(ExpressionsCDS.CDSString)?.getFirstToken().getStr();
    if (value) return value.slice(1, -1).toUpperCase();
  }
}

// A CDS view entity has no SQL view name and is left out.
export function cdsSqlViews(sources) {
  const out = {};
  const failures = new Map();
  cdsFailures.set(out, failures);
  for (const [index, input] of sources.entries()) {
    const {filename, source} = typeof input === "string"
      ? {filename: `gogen_${index}.ddls.asddls`, source: input} : input;
    const src = source.startsWith("\uFEFF") ? source.slice(1) : source;
    // Core recognizes only lowercase extensions. Keep the original for messages.
    // Do not add CDS sources to the ABAP registry used for type checking.
    const reg = new abaplint.Registry();
    const file = new abaplint.MemoryFile(filename.toLowerCase(), src);
    reg.addFile(file);
    reg.parse();
    const obj = reg.getFirstObject();
    // Pinned core's getSQLViewName() searches raw text and includes comments.
    // Its parsed CDS annotations exclude comments and expose the string token.
    const tree = obj?.getTree();
    if (!tree) {
      const message = `${filename}: DDLS view mapping could not be read`;
      if (obj) failures.set(obj.getName().toUpperCase(), message);
      const tokens = CDSLexer.run(file).filter(t => !(t instanceof abaplint.Tokens.Comment));
      const header = cdsHeader.run([new Result(tokens, 0)])[0]?.getNodes() ?? [];
      const name = header.find(n => n.get() instanceof ExpressionsCDS.CDSName)?.concatTokens().toUpperCase();
      if (name) failures.set(name, message);
      const sql = sqlViewName(header.filter(n => n.get() instanceof ExpressionsCDS.CDSAnnotation));
      if (sql) failures.set(sql, message);
      continue;
    }
    if (!(tree.get() instanceof ExpressionsCDS.CDSDefineView)) continue;
    const cds = obj.getDefinitionName();
    if (tree.getChildren().some((c) => c instanceof Nodes.TokenNode && c.getFirstToken().getStr().toUpperCase() === "ENTITY")) continue;
    const sql = sqlViewName(tree.findDirectExpressions(ExpressionsCDS.CDSAnnotation));
    if (sql && cds) out[cds.toUpperCase()] = sql;
  }
  return out;
}
