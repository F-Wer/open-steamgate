// ABAP DATA has method lifetime. Only shorten it when every use is confined
// to one emitted block and its first touch is an unconditional full reset.
// Body arrays are identity keys; seq is transparent (it emits no Go braces).
const ignored = new Set(['type', 'pos', 'token']);
const blocks = new Set(['if', 'case', 'do', 'while', 'loop', 'try']);
const opaque = new Set(['native', 'kernel_loop', 'stub', 'dynamic', 'assign_comp', 'call_dyn_static', 'select_dyn', 'create_data_dyn', 'create_dyn']);
const escapes = new Set(['get_ref', 'assign_data', 'assign_comp', 'assign_deref', 'assign_deref_typed', 'set_handler', 'raise_event']);

function children(node) {
  return Object.entries(node).filter(([key]) => !ignored.has(key)).map(([, value]) => value);
}

function namesIn(node, names = new Set()) {
  if (!node || typeof node !== 'object') return names;
  if (node.e === 'var') names.add(node.name);
  for (const value of Array.isArray(node) ? node : children(node)) namesIn(value, names);
  return names;
}

function fullReset(stmt, name) {
  if (!['clear', 'assign'].includes(stmt.s) || stmt.target?.e !== 'var'
      || stmt.target.name !== name || stmt.target.ref || stmt.target.box) return false;
  if (stmt.s === 'clear') return true;
  // A call can inspect an aliased slot while evaluating the RHS. Unknown
  // expressions stay conservative even if no explicit self-read is present.
  return !namesIn(stmt.value).has(name) && !hasCall(stmt.value);
}

function hasCall(node) {
  if (!node || typeof node !== 'object') return false;
  if (['call', 'new', 'wrap'].includes(node.e)) return true;
  return (Array.isArray(node) ? node : children(node)).some(hasCall);
}

/** Return Map<body array, local declarations>, without mutating the IR. */
export function sinkLocals(method, enabled = process.env.GOGEN_SINK_LOCALS !== '0') {
  const result = new Map();
  if (!enabled || method.sinkUnsafe) return result;
  const locals = new Map(method.locals.map(local => [local.name, local]));
  const uses = new Map();
  const rejected = new Set();
  let unsafe = false;

  function scan(node, path, top) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const value of node) scan(value, path, top); return; }
    if (opaque.has(node.s) || node.dynamicKeys) unsafe = true;
    if (escapes.has(node.s) || node.fs || node.refInto || node.e === 'wrap' || node.e === 'call' || node.e === 'new'
        || node.s?.startsWith('call_')) {
      for (const name of namesIn(node)) rejected.add(name);
    }
    // CATCH INTO is a name rather than a var expression in this IR.
    if (typeof node.into === 'string') rejected.add(node.into);
    if (node.e === 'var' && locals.has(node.name)) {
      if (node.ref || node.box) rejected.add(node.name);
      const prior = uses.get(node.name);
      if (!prior) uses.set(node.name, {path: [...path], first: new Map(path.map(body => [body, top.get(body)]))});
      else {
        let length = 0;
        while (length < prior.path.length && prior.path[length] === path[length]) length++;
        prior.path.length = length;
      }
    }
    for (const [key, value] of Object.entries(node)) {
      if (ignored.has(key)) continue;
      // Only actual emitter blocks are candidates. Catch/cleanup bodies are
      // scanned in the parent scope so closure captures cannot be overlooked.
      const inner = Array.isArray(value) && ((key === 'body' && blocks.has(node.s))
        || (key === 'body' && !node.s && node.cond) || (key === 'else' && ['if', 'case'].includes(node.s)));
      if (inner) scanBody(value, [...path, value], top);
      else scan(value, path, top);
    }
  }

  function scanBody(body, path, parentTop) {
    for (const stmt of body) {
      const top = new Map(parentTop);
      top.set(body, stmt);
      scan(stmt, path, top);
    }
  }

  scanBody(method.body, [method.body], new Map());
  if (unsafe) return result;
  for (const [name, use] of uses) {
    const local = locals.get(name);
    if (rejected.has(name) || local.static || local.statics || local.value !== undefined) continue;
    // Try innermost first. A shared outer loop is safe only if its own
    // top-level first touch resets the slot, never a conditional inner reset.
    for (let i = use.path.length - 1; i > 0; i--) {
      const body = use.path[i];
      if (!fullReset(use.first.get(body), name)) continue;
      if (!result.has(body)) result.set(body, []);
      result.get(body).push(local);
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
export function generatedBindings(source) {
  // Remove comments and literals first: their contents introduce no bindings.
  const code = source.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|`[^`]*`/g,
    text => text.replace(/[^\n]/g, ' '));
  const names = new Set();
  const add = text => { for (const name of text.match(/[A-Za-z_][A-Za-z_0-9]*/g) ?? []) names.add(name); };
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
