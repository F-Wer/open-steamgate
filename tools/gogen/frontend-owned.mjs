import {children} from "./ir-children.ts";
import {enumerateObjects, semanticQuery, withArtifact} from "./frontend-provenance.mjs";
// Ownership is per declaration, never a change to an ABAP type or ABI.
// Unknown/reference use positions conservatively retain string storage.
export function sourceOwnershipSafety(reg) {
  const out = new Map();
  for (const obj of enumerateObjects(reg, "ownership-dispatch")) {
    withArtifact({reg}, obj, () => {
    const names = new Set();
    let dynamic = false;
    for (const file of obj.getABAPFiles?.() ?? []) for (const st of file.getStatements()) {
      const text = st.concatTokens().toUpperCase();
      // Include statements in refused methods. A dynamic name can identify any
      // slot in this class pool; literals are conservatively dynamic too.
      if (/\bFRIENDS\b|^ASSIGN COMPONENT\b|^ASSIGN\s*\(|(?:->|=>)\s*\(/.test(text)) dynamic = true;
      if (/^(ASSIGN|GET REFERENCE)\b|\bREF\s*#|^.*\bKERNEL\b/.test(text) || st.get().constructor.name === "Unknown") {
        for (const word of text.match(/[A-Z_][A-Z0-9_~]*/g) ?? []) names.add(word);
      }
    }
    out.set(obj.getName().toUpperCase(), {names, dynamic});
    semanticQuery(reg, "ownershipSafety", [obj.getName().toUpperCase()], [obj.getName().toUpperCase()], {names: [...names], dynamic, providers: [`${obj.getType()} ${obj.getName().toUpperCase()}`], policy: "expanded-statements"});
    }, "ownership-safety");
  }
  return out;
}

const places = new Set(["var", "attr", "static", "field", "fs", "row", "row_key", "refattr", "dref_field"]);
const sourceOwner = (cls) => cls.name.startsWith("FUGR:") ? cls.name.slice(5) : cls.name.split(":")[0];
const localKey = (cls, m) => `${cls.name}|${m.name ?? "CONSTRUCTOR"}`;
const methods = (cls) => [...cls.methods, ...(cls.constructor ? [cls.constructor] : [])];

export function analyzeOwnership(program) {
  const classes = program.classes ?? program;
  const attrs = new Map(), locals = new Map(), declarations = new Set();
  for (const cls of classes) {
    const safety = program.ownershipSafety?.get(sourceOwner(cls));
    const eligible = (v) => safety && (v.type?.k === "xstring" || (v.type?.k === "x" && v.type.len >= 1 && v.type.len <= 8)) && !safety.dynamic && !safety.names.has(v.name);
    attrs.set(cls.name, new Set((cls.attributes ?? []).filter((a) => eligible(a) && a.type.k === "xstring" && a.private && !a.fromIntf && !cls.stubs?.length && a.value === undefined).map((a) => a.name)));
    for (const m of methods(cls)) locals.set(localKey(cls, m), new Set(m.locals.filter(eligible).map((v) => v.name)));
  }
  const external = new Set();
  for (const cls of classes) for (const m of methods(cls)) {
    const aa = attrs.get(cls.name), ll = locals.get(localKey(cls, m));
    const reject = (n) => {
      if (Array.isArray(n)) { n.forEach(reject); return; }
      if (!n || typeof n !== "object") return;
      if (n.e === "var") ll.delete(n.name);
      if (n.e === "attr") aa.delete(n.name);
      if (n.e === "static") attrs.get(n.owner)?.delete(n.name);
      if (n.e === "refattr") external.add(n.name);
      for (const v of children(n)) reject(v);
    };
    const read = (n) => {
      if (Array.isArray(n)) { n.forEach(read); return; }
      if (!n || typeof n !== "object") return;
      if (n.e === "wrap") { if (places.has(n.x.e)) reject(n.x); else read(n.x); return; }
      if (n.e === "table_map" || n.c === "table_eq") { reject(n); return; }
      if (n.e === "refattr") external.add(n.name);
      if (n.e === "call" || n.e === "new") {
        for (const a of n.args) {
          // An opaque object consumer could inspect a private slot. Calls on
          // the object itself are checked through its compiled method bodies.
          const objectActual = a.value ?? a.place ?? a.wrap;
          const ownObject = (x) => x && typeof x === "object" && (x.e === "me" || (x.type?.k === "ref" && x.type.name === cls.name) || (Array.isArray(x) ? x : children(x)).some(ownObject));
          if (ownObject(objectActual)) aa.clear();
          if (a.dir === "importing" && a.byValue === true) read(a.value);
          else {
            const actual = a.value ?? a.place ?? a.wrap;
            const slot = actual?.e === "wrap" ? actual.x : actual;
            if ((a.dir && a.dir !== "importing") || places.has(slot?.e) || slot?.e === "substr") reject(actual);
            else read(actual);
          }
        }
        reject(n.receiving); read(n.receiver);
        return;
      }
      for (const v of children(n)) read(v);
    };
    const write = (n, supported) => {
      if (!supported || !["var", "attr", "static"].includes(n?.e) || n.ref) reject(n);
    };
    const calls = (n) => n && typeof n === "object" && (n.e === "call" || n.e === "new" || n.s === "call_fm" || n.s === "call_dyn_static" || (Array.isArray(n) ? n : children(n)).some(calls));
    const statements = (n) => {
      if (Array.isArray(n)) { n.forEach(statements); return; }
      if (!n || typeof n !== "object") return;
      if (!n.s) { if (n.e || n.c) { if (calls(n)) reject(n); read(n); } else for (const v of children(n)) statements(v); return; }
      // Snapshot/Sub/Len introduce Go calls where string operands had none.
      // Keep string storage whenever a sibling call could change a read slot.
      // Nested bodies are separate statements, not siblings of the condition.
      const operands = Object.entries(n).filter(([k]) => !["target", "body", "then", "else", "branches", "catches", "finally", "cleanup", "pos", "type"].includes(k)).map(([, v]) => v);
      if (operands.some(calls)) operands.forEach(reject);
      if (["assign", "clear", "replace_bytes", "concat_bytes"].includes(n.s)) {
        // Reading the target before side-effecting operands needs a snapshot;
        // preserve the ordinary representation for that uncertain form.
        write(n.target, !(["replace_bytes", "concat_bytes"].includes(n.s) && n.target?.type?.k === "x") && !(n.s === "replace_bytes" && [n.with, n.off, n.len].some(calls)));
        for (const [k, v] of Object.entries(n)) if (!["target", "pos", "type"].includes(k)) read(v);
      } else if (["if", "case", "do", "while", "seq", "try"].includes(n.s)) {
        // Conditions are reads, bodies contain independently checked writes.
        for (const [k, v] of Object.entries(n)) {
          if (["cond", "times", "value"].includes(k)) read(v);
          else statements(v);
        }
      } else if (["call", "write", "check", "assert", "return", "raise"].includes(n.s)) read(n);
      else { if (n.s === "native" || n.s === "kernel_loop") aa.clear(); reject(n); }
    };
    statements(m.body);
  }
  for (const names of attrs.values()) for (const name of external) names.delete(name);
  for (const cls of classes) for (const m of methods(cls)) {
    const loaded = new Set();
    const scan = (n) => {
      if (!n || typeof n !== "object") return;
      if (n.s === "assign" && n.target?.e === "var") {
        const v = n.value?.e === "conv" ? n.value.x : n.value;
        if (v?.e === "substr" && v.len?.e === "int" && v.len.value > 0 && v.len.value <= 8 &&
            (v.x.e === "attr" ? attrs.get(cls.name).has(v.x.name) : v.x.e === "var" && locals.get(localKey(cls, m)).has(v.x.name) && v.x.type.k === "xstring")) loaded.add(n.target.name);
      }
      for (const v of Array.isArray(n) ? n : children(n)) scan(v);
    };
    scan(m.body);
    for (const l of m.locals) if (l.type.k === "x" && !loaded.has(l.name)) locals.get(localKey(cls, m)).delete(l.name);
  }
  for (const cls of classes) {
    for (const a of cls.attributes ?? []) if (attrs.get(cls.name).has(a.name)) declarations.add(a);
    for (const m of methods(cls)) for (const l of m.locals) if (locals.get(localKey(cls, m)).has(l.name)) declarations.add(l);
  }
  return {declarations, unescaped(p, ctx) {
    const safety = program.ownershipSafety?.get(sourceOwner(ctx.cls));
    const mentions = (n) => n && typeof n === "object" && ((n.e === "var" && n.name === p?.name) || children(n).some(mentions));
    const escapes = (n) => n && typeof n === "object" &&
      ((n.e === "wrap" && mentions(n.x)) || (["call", "new"].includes(n.e) && n.args.some(mentions)) ||
       (["call_fm", "call_dyn_static"].includes(n.s) && mentions(n)) || children(n).some(escapes));
    return p?.e === "var" && !p.ref && safety && !safety.dynamic && !safety.names.has(p.name) && !escapes(ctx.method.body) &&
      (ctx.method.locals.some((l) => l.name === p.name) || ctx.method.returning?.name === p.name);
  }, width(p, ctx) {
    return p?.e === "var" ? ctx.method.locals.find((v) => v.name === p.name && v.type.k === "x")?.type.len : 0;
  }, fixed(p, ctx) {
    const decl = p?.e === "var" && !p.ref ? ctx.method.locals.find((v) => v.name === p.name) : undefined;
    return decl?.type.k === "x" && declarations.has(decl) ? decl.type.len : 0;
  }, has(p, ctx) {
    return p?.e === "static" ? p.owner === ctx.cls.name && attrs.get(p.owner)?.has(p.name) : p?.e === "attr" ? attrs.get(ctx.cls.name)?.has(p.name) : p?.e === "var" && !p.ref && locals.get(localKey(ctx.cls, ctx.method))?.has(p.name);
  }};
}
