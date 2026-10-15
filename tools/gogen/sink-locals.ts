import type {Method, Local, Stmt, Expr, SunkLocals} from './emit-go-types.ts';
import {children as propertyChildren, entries} from './ir-children.ts';
import type {IRNode, IRValue} from './ir-children.ts';

// Sinking inspects storage uses, so callers may supply partial tagged IR probes
// (the direct sinking tests do). Keep renderer-only payload fields optional in
// this inspection view, deriving their names and shapes from the shared IR.
type InspectionKeys<T> = Extract<keyof T, 'e' | 's' | 'c' | 'k' | (T extends {readonly e: 'var'} ? 'name' : never)>;
type Inspection<T> = T extends readonly (infer V)[] ? readonly Inspection<V>[]
  : T extends object ? Pick<T, InspectionKeys<T>> & {
    readonly [K in Exclude<keyof T, InspectionKeys<T>>]?: Inspection<T[K]>;
  } : T;
type Node = Inspection<IRNode>;
type Value = Inspection<IRValue>;
type Statement = Inspection<Stmt>;
type Expression = Inspection<Expr>;
type Body = readonly Statement[];
interface SinkMethod<B extends Body = Body> extends Required<Pick<Method, 'locals'>>, Pick<Method, 'sinkUnsafe'> { readonly body: B }
type Tops = ReadonlyMap<Body, Statement>;
interface Use { readonly path: Body[]; readonly first: Map<Body, Statement | undefined> }
function isIRArray(value: Value): value is readonly Value[] { return Array.isArray(value); }
function isExpr(value: Node): value is Expression { return 'e' in value && typeof value.e === 'string'; }
function isStmt(value: Node): value is Statement { return 's' in value && typeof value.s === 'string'; }

// ABAP DATA has method lifetime. Only shorten it when every use is confined
// to one emitted block and its first touch is an unconditional full reset.
// Body arrays are identity keys; seq is transparent (it emits no Go braces).
const ignored = new Set(['type', 'pos', 'token']);
const blocks = new Set(['if', 'case', 'do', 'while', 'loop', 'try']);
const opaque = new Set(['native', 'kernel_loop', 'stub', 'dynamic', 'assign_comp', 'call_dyn_static', 'select_dyn', 'create_data_dyn', 'create_dyn']);
const escapes = new Set(['get_ref', 'assign_data', 'assign_comp', 'assign_deref', 'assign_deref_typed', 'set_handler', 'raise_event']);

function children(node: Node): readonly Value[] {
  return propertyChildren(node, [...ignored]);
}

function namesIn(node: Value, names = new Set<string>()): Set<string> {
  if (!node || typeof node !== 'object') return names;
  if (isExpr(node) && node.e === 'var') names.add(node.name);
  for (const value of isIRArray(node) ? node : children(node)) namesIn(value, names);
  return names;
}

function fullReset(stmt: Statement, name: string): boolean {
  if ((stmt.s !== 'clear' && stmt.s !== 'assign') || stmt.target?.e !== 'var'
      || stmt.target.name !== name || stmt.target.ref || stmt.target.box) return false;
  if (stmt.s === 'clear') return true;
  // A call can inspect an aliased slot while evaluating the RHS. Unknown
  // expressions stay conservative even if no explicit self-read is present.
  return !namesIn(stmt.value).has(name) && !hasCall(stmt.value);
}

function hasCall(node: Value): boolean {
  if (!node || typeof node !== 'object') return false;
  if (isExpr(node) && ['call', 'new', 'wrap'].includes(node.e)) return true;
  return (isIRArray(node) ? node : children(node)).some(hasCall);
}

/** Return Map<body array, local declarations>, without mutating the IR. */
export function sinkLocals(method: SinkMethod<readonly Stmt[]>, enabled?: boolean): SunkLocals;
export function sinkLocals(method: SinkMethod, enabled?: boolean): SunkLocals<Body>;
export function sinkLocals(method: SinkMethod, enabled = process.env.GOGEN_SINK_LOCALS !== '0'): SunkLocals<Body> {
  const result = new Map<Body, Local[]>();
  if (!enabled || method.sinkUnsafe) return result;
  const locals = new Map(method.locals.map((local): [string, Local] => [local.name, local]));
  const uses = new Map<string, Use>();
  const rejected = new Set<string>();
  let unsafe = false;

  function scan(node: Value, path: readonly Body[], top: Tops): void {
    if (!node || typeof node !== 'object') return;
    if (isIRArray(node)) { for (const value of node) scan(value, path, top); return; }
    const stmt = isStmt(node) ? node : undefined;
    const expr = isExpr(node) ? node : undefined;
    if ((stmt && opaque.has(stmt.s)) || ('dynamicKeys' in node && node.dynamicKeys)) unsafe = true;
    if ((stmt && escapes.has(stmt.s)) || ('fs' in node && node.fs) || ('refInto' in node && node.refInto) || expr?.e === 'wrap' || expr?.e === 'call' || expr?.e === 'new'
        || stmt?.s.startsWith('call_')) {
      for (const name of namesIn(node)) rejected.add(name);
    }
    // CATCH INTO is a name rather than a var expression in this IR.
    if ('into' in node && typeof node.into === 'string') rejected.add(node.into);
    if (isExpr(node) && node.e === 'var' && locals.has(node.name)) {
      if (node.ref || node.box) rejected.add(node.name);
      const prior = uses.get(node.name);
      if (!prior) uses.set(node.name, {path: [...path], first: new Map(path.map((body): [Body, Statement | undefined] => [body, top.get(body)]))});
      else {
        let length = 0;
        while (length < prior.path.length && prior.path[length] === path[length]) length++;
        prior.path.length = length;
      }
    }
    for (const [key, value] of entries(node)) {
      if (ignored.has(key)) continue;
      // Only actual emitter blocks are candidates. Catch/cleanup bodies are
      // scanned in the parent scope so closure captures cannot be overlooked.
      const inner = isBlockBody(node, key, value);
      if (inner) scanBody(value, [...path, value], top);
      else scan(value, path, top);
    }
  }

  function scanBody(body: Body, path: readonly Body[], parentTop: Tops): void {
    for (const stmt of body) {
      const top = new Map(parentTop);
      top.set(body, stmt);
      scan(stmt, path, top);
    }
  }

  scanBody(method.body, [method.body], new Map());
  if (unsafe) return result;
  for (const [name, use] of uses) {
    const local = locals.get(name)!;
    if (rejected.has(name) || local.static || local.statics || local.value !== undefined) continue;
    // Try innermost first. A shared outer loop is safe only if its own
    // top-level first touch resets the slot, never a conditional inner reset.
    for (let i = use.path.length - 1; i > 0; i--) {
      const body = use.path[i];
      if (!fullReset(use.first.get(body)!, name)) continue;
      if (!result.has(body)) result.set(body, []);
      result.get(body)!.push(local);
      break;
    }
  }
  return result;
}

/** Conservative binding guard over rendered Go, before ABAP locals are added.
 * Collect whole declaration/header lines rather than trying to parse Go types.
 * Extra names only cost sinking opportunities. null means uncertain syntax.
 * The entire method is checked, including generated closures and loop headers,
 * so both direct collisions and reverse shadowing retain function lifetime.
 */
export function generatedBindings(source: string): Set<string> | null {
  // Remove comments and literals first: their contents introduce no bindings.
  const code = source.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|`[^`]*`/g,
    (text): string => text.replace(/[^\n]/g, ' '));
  const names = new Set<string>();
  const add = (text: string): void => { for (const name of text.match(/[A-Za-z_][A-Za-z_0-9]*/g) ?? []) names.add(name); };
  for (const line of code.split('\n')) {
    if (/\bvar\s*(?:\(|$)/.test(line) || (/\bfunc\b/.test(line) && !line.includes('{'))) return null;
    for (const match of line.matchAll(/\bfunc\b/g)) {
      const header = line.slice(match.index, line.indexOf('{', match.index));
      // An inline struct/interface type or a split parameter list makes the
      // first brace ambiguous. Retain all locals instead of guessing scope.
      if (/\b(?:struct|interface)\b/.test(header)
          || (header.match(/\(/g)?.length ?? 0) !== (header.match(/\)/g)?.length ?? 0)) return null;
    }
    if (/\b(?:var|func)\b/.test(line) || line.includes(':=')) add(line);
    // Labels have function scope; also conservatively includes struct keys.
    for (const match of line.matchAll(/\b([A-Za-z_][A-Za-z_0-9]*)\s*:(?!=)/g)) names.add(match[1]);
    // A split short declaration cannot be analyzed as a single header line.
    if (/^\s*:=|,\s*$/.test(line)) return null;
  }
  return names;
}

// These are precisely the body properties that introduce emitter scopes.
function isBlockBody(node: Node, key: string, value: Value): value is Body {
  const stmt = isStmt(node) ? node : undefined;
  return isIRArray(value) && ((key === 'body' && !!stmt && blocks.has(stmt.s))
    || (key === 'body' && !stmt && 'cond' in node && !!node.cond)
    || (key === 'else' && !!stmt && ['if', 'case'].includes(stmt.s)));
}
