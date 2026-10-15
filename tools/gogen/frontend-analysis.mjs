// Source-only analyses, keyed by the immutable parsed/rearranged node.
import {readText, listEntries, join} from "./host-io.ts";
import {parseSamc} from "../osd-samc.ts";

// Match frontend.mjs: AST instanceof checks must use the transpiler's core.
import {createRequire} from "node:module";
const require = createRequire(import.meta.url);
const abaplint = createRequire(require.resolve("@abaplint/transpiler/package.json"))("@abaplint/core");
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

// A CDS view entity has no SQL view name and is left out.
export function cdsSqlViews(sources) {
  const out = {};
  for (const [index, input] of sources.entries()) {
    const {filename, source} = typeof input === "string"
      ? {filename: `gogen_${index}.ddls.asddls`, source: input} : input;
    const src = source.startsWith("\uFEFF") ? source.slice(1) : source;
    // Give abaplint a DDLS object with its source filename for diagnostics, without
    // adding the CDS sources to the ABAP registry used for type checking.
    const reg = new abaplint.Registry();
    reg.addFile(new abaplint.MemoryFile(filename, src));
    reg.parse();
    const obj = reg.getFirstObject();
    // Pinned core's getSQLViewName() searches raw text and includes comments.
    // Its parsed CDS annotations exclude comments and expose the string token.
    const tree = obj?.getTree();
    if (!tree) throw new Error(`${filename}: DDLS view mapping could not be read`);
    if (!(tree.get() instanceof ExpressionsCDS.CDSDefineView)) continue;
    const cds = obj.getDefinitionName();
    if (tree.getChildren().some((c) => c instanceof Nodes.TokenNode && c.getFirstToken().getStr().toUpperCase() === "ENTITY")) continue;
    for (const annotation of tree.findDirectExpressions(ExpressionsCDS.CDSAnnotation)) {
      const key = annotation.getChildren().filter((c) => c instanceof Nodes.TokenNode)
        .map((c) => c.getFirstToken().getStr()).join("").toUpperCase();
      if (key !== "@ABAPCATALOG.SQLVIEWNAME:") continue;
      const value = annotation.findFirstExpression(ExpressionsCDS.CDSString)?.getFirstToken().getStr();
      if (value && cds) out[cds.toUpperCase()] = value.slice(1, -1).toUpperCase();
    }
  }
  return out;
}
