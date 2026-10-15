import {isDeepStrictEqual} from "node:util";
import type {ProgramInput, FunctionModule, Class, ClassName, Method, Expr, Stmt, Context, MovePair, Type, TypeProbe} from "./emit-go-types.ts";
import {irChildren, isExpr, isStmt} from "./ir-children.ts";
import type {IRNode, IRValue} from "./ir-children.ts";

interface MovePath { readonly root: string; readonly path: string; readonly object?: string }
type Stable = (type: TypeProbe) => boolean | undefined;
type StorageKeys = (value: Expr | null | undefined, cls: Partial<ClassName>, method: Partial<Method>, binding?: boolean) => Set<string>;
type VisitBinding = (value: Expr | null, node: Stmt | Expr) => void;
type Origins = Map<string, string>;

export function analyzeTableMoves(program: ProgramInput, stable: Stable): MovePair {
  const classes = (program.classes ?? program) as readonly Class[];
  const tainted = new Map<string, string>(), escaped = new Map<string, string>();
  const attrKey = (name: string): string => `attr:${name.toUpperCase()}`;
  const attributes = new Set(classes.flatMap((c): string[] => (c.attributes ?? []).map((a): string => attrKey(a.name))));
  // Follow storage ancestry only: indices and key values are independent.
  // Attribute names deliberately span classes, inheritance and interfaces.
  const keys: StorageKeys = (value, cls, method, binding = false): Set<string> => {
    const result = new Set<string>();
    for (let n: Expr | Type | boolean | null | undefined = value; n && typeof n === "object"; n = ("base" in n ? n.base : undefined) ?? ("table" in n ? n.table : undefined) ?? ("x" in n ? n.x : undefined)) {
      if ("e" in n && (n.e === "attr" || n.e === "refattr" || n.e === "static")) result.add(attrKey(n.name));
      if ("e" in n && n.e === "var") {
        const name = n.name;
        if (!binding || (!n.ref && !method.params?.some((p): boolean => p.name.toUpperCase() === name.toUpperCase())
          && !["data", "any", "dref"].includes(n.type?.k)))
          result.add(`local:${cls.name}=>${method.name}:${name.toUpperCase()}`);
      }
    }
    return result;
  };
  const record = (map: Origins, storage: Iterable<string>, origin: string): void => {
    for (const key of storage) if (!map.has(key)) map.set(key, origin);
  };
  const literal = (value: IRValue): string | null => {
    while (value && typeof value === "object" && "x" in value && value.x) value = value.x;
    return value && typeof value === "object" && isExpr(value) && value.e === "str" ? value.value : null;
  };
  // every body that can bind or pass storage: methods, the instance
  // constructor (kept apart from cls.methods; critic round 5) and function
  // modules
  const bodies: [ClassName, Method][] = [...classes.flatMap((cls): [ClassName, Method][] => [...(cls.methods ?? []), ...(cls.constructor ? [cls.constructor] : [])].map((method): [ClassName, Method] => [cls, method])),
    ...[...(program.functionModules?.values?.() ?? [])].map((fm): FunctionModule["module"] => fm.module).filter((m): m is Method => "body" in m && !!m.body).map((m): [ClassName, Method] => [{name: "FUNCTION"}, m])];
  for (const [cls, method] of bodies) {
    const origin = (node: IRNode): string => `${cls.name}=>${method.name} ${"s" in node ? node.s : "e" in node ? node.e : undefined}`;
    walkMoveBindings(method.body, (value, node): void => record(tainted, keys(value, cls, method, true), origin(node)));
    walkMove(method.body, (node): void => {
      // Formal direction is used here (IMPORTING without VALUE is by reference).
      // Output wrappers retain the actual in x; RETURNING targets escape too.
      if ((isExpr(node) && (node.e === "call" || node.e === "new")) || (isStmt(node) && (node.s === "call_dyn_static" || node.s === "call_fm"))) {
        for (const arg of node.args ?? []) if (arg.dir !== "importing" || !arg.byValue)
          record(escaped, keys(arg.value ?? arg.place ?? arg.wrap, cls, method), origin(node));
        if ("receiving" in node && node.receiving) record(escaped, keys(node.receiving, cls, method), origin(node));
      }
      // COMPONENT access is bounded by the structure's own storage ancestry.
      if (isStmt(node) && node.s === "assign_comp") record(escaped, keys(node.from, cls, method), origin(node));
      if ("s" in node && typeof node.s === "string" && ["assign_name"].includes(node.s)) {
        const name = literal("name" in node ? node.name : undefined);
        record(escaped, name === null ? attributes : [attrKey(name)], origin(node));
      }
      // Unsupported dynamic attribute forms retain their source in the stub.
      // Parse only operand positions, never FIELD-SYMBOL(<name>) targets or
      // dynamic class/method/type names. A literal names just that attribute.
      if (isStmt(node) && node.s === "stub") {
        const text = node.reason ?? "";
        const names: RegExpMatchArray[] = [...text.matchAll(/(?:->|=>)\s*\(\s*([^)]*)\)/g)];
        const assign = text.match(/\bASSIGN\s+\(\s*([^)]*)\)/i);
        if (assign) names.push(assign);
        for (const match of names) {
          const name = match[1].trim().match(/^'((?:[^']|'')*)'$/);
          record(escaped, name ? [attrKey(name[1].replaceAll("''", "'"))] : attributes, origin(node));
        }
      }
    });
  }
  return (st, next, ctx, previous): boolean => {
    while (next?.s === "seq" && next.body.length === 1) next = next.body[0];
    if (st.s !== "assign" || next?.s !== "clear" || !("type" in st.target) || st.target.type?.k !== "table") return false;
    const b = movePath(st.value), cleared = movePath(next.target);
    if (b ? b.path !== cleared?.path : !isDeepStrictEqual(st.value, next.target)) return false;
    const rule = movePair(st, next, ctx, previous, tainted, escaped, keys, stable);
    if (process.env.GOGEN_MOVE_TRACE === "1")
      console.error(`GOGEN_MOVE_TRACE ${ctx.cls.name}=>${ctx.method!.name} ${movePath(st.target)?.path ?? JSON.stringify(st.target)} <- ${b?.path ?? JSON.stringify(st.value)}: ${rule}`);
    return rule === "moved";
  };
}

// Only independent, plain storage paths can transfer table ownership.
// A by-reference parameter may be the very same slot as another parameter.
function movePath(p: Expr | null | undefined): MovePath | null {
  if (!p) return null;
  if (p.e === "field") {
    const base = movePath(p.base);
    return base && {...base, path: `${base.path}.${p.name}`};
  }
  if (p.e === "var" && !p.ref) return {root: `var:${p.name}`, path: `var:${p.name}`};
  if (p.e === "attr") return {root: "me", path: `me.${p.name}`};
  if (p.e === "static") return {root: `static:${p.owner}`, path: `static:${p.owner}.${p.name}`};
  if (p.e === "refattr" && p.base.e === "var" && !p.base.ref)
    return {root: `object:${p.base.name}`, path: `object:${p.base.name}.${p.name}`, object: p.base.name};
  return null;
}

function walkMove(node: IRValue, visit: (node: IRNode) => void): void {
  if (!node || typeof node !== "object") return;
  visit(node);
  for (const value of irChildren(node, [])) walkMove(value, visit);
}

const objectRoot = (path: MovePath | null): boolean => path?.root === "me" || !!path?.object;
const moveRootsOverlap = (a: MovePath | null, b: MovePath | null): boolean | null => a && b && (a.root === b.root || (objectRoot(a) && objectRoot(b)));

function walkMoveBindings(body: readonly Stmt[] | undefined, visit: VisitBinding): void {
  walkMove(body, (node): void => {
    if (!isStmt(node)) return;
    // Dynamic/dereferenced bindings cannot be proved independent of source.
    if (node.s === "assign_deref" || node.s === "assign_deref_typed" || node.s === "assign_comp") visit(null, node);
    // the operand bound, not its subexpressions (a key value or an index
    // is not bound)
    if (node.s === "get_ref" || node.s === "assign_data" || ("fs" in node && node.fs) || ("refInto" in node && node.refInto)) {
      for (const value of [("table" in node ? node.table : undefined), ("value" in node ? node.value : undefined), ("from" in node ? node.from : undefined)]) if (value && typeof value === "object" && isExpr(value)) visit(value, node);
    }
  });
}

function moveBound(source: MovePath, method: Partial<Method>): Stmt | Expr | false {
  let bound: Stmt | Expr | false = false;
  walkMoveBindings(method.body, (value, node): void => {
    const path = movePath(value);
    if (!bound && (!path || moveRootsOverlap(path, source))) bound = node;
  });
  return bound;
}

function movePair(st: Stmt, next: Stmt | undefined, ctx: Context, previous: Stmt | undefined, tainted: Origins, escaped: Origins, keys: StorageKeys, stable: Stable): string | false {
  while (next?.s === "seq" && next.body.length === 1) next = next.body[0];
  if (st.s !== "assign" || next?.s !== "clear" || !("type" in st.target) || st.target.type?.k !== "table") return false;
  const a = movePath(st.target), b = movePath(st.value), cleared = movePath(next.target);
  if (!a || !b || b.path !== cleared?.path || a.root === b.root) return "alias";
  if (!isDeepStrictEqual(st.target.type, ("type" in st.value ? st.value.type : undefined))) return "type";
  // All table kinds currently use slices, but keep keyed tables on the
  // established copying path (including their row representation/metadata).
  const valueType = "type" in st.value ? st.value.type : undefined;
  if (valueType?.k === "table" && (valueType.sorted || valueType.hashed || valueType.secondary?.length)) return "keyed";
  if (ctx.loopStack?.some((loop): boolean | null => moveRootsOverlap(movePath(loop.table), b))) return "loop";
  const binding = moveBound(b, ctx.method!);
  if (binding) return `moveBound ${[...keys(st.value, ctx.cls, ctx.method!)].join(",")} by ${ctx.cls.name}=>${ctx.method!.name} ${(isStmt(binding) ? binding.s : undefined)}`;
  if (stable(valueType!)) return "stable";
  for (const key of keys(st.value, ctx.cls, ctx.method!)) {
    if (tainted.has(key)) return `boundStorage ${key} by ${tainted.get(key)}`;
    if (escaped.has(key)) return `escapedStorage ${key} by ${escaped.get(key)}`;
  }
  // Two object references can name the same object, even with different names.
  // A fresh result object and me are distinct; this covers Array.splice1.
  if (a.object || b.object) {
    const obj = a.object ? a : b, other = a.object ? b : a;
    if (other.object) return "object-root";
    if (other.root === "me") {
      if (previous?.s !== "assign" || previous.target.e !== "var"
        || previous.target.name !== obj.object || previous.value.e !== "new") return "object-root";
    } else if (!other.root.startsWith("var:")) return "object-root";
  }
  return "moved";
}
