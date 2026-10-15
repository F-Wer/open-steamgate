import {irChildren as children, irEntries, isExpr, isStmt, isCondition, isIRArray} from "./ir-children.ts";
import type {IRValue} from "./ir-children.ts";
import type {Registry, ArtifactObject} from "./frontend-session-types.ts";
import type {ABAPObject} from "@abaplint/core";
type OwnershipObject = ArtifactObject & Partial<Pick<ABAPObject, "getABAPFiles">>;
import type {OwnershipSafety, OwnershipSafetyMap} from "./frontend-types.ts";
import type {ProgramInput, Class, ClassName, Method, Local, Attribute, SupportedAttribute, Expr, Type, Context, Ownership} from "./emit-go-types.ts";
import type {AttributeProbe} from "./emit-ownership.ts";
import {enumerateObjects, semanticQuery, withArtifact} from "./frontend-provenance.mjs";
// Ownership is per declaration, never a change to an ABAP type or ABI.
// Unknown/reference use positions conservatively retain string storage.
export function sourceOwnershipSafety(reg: Registry): OwnershipSafetyMap {
  const out = new Map<string, OwnershipSafety>();
  const objects: readonly OwnershipObject[] = enumerateObjects(reg, "ownership-dispatch");
  for (const obj of objects) {
    withArtifact({reg}, obj, (): void => {
    const names = new Set<string>();
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

type TruthResult = boolean | '' | 0 | null | undefined;

const places = new Set(["var", "attr", "static", "field", "fs", "row", "row_key", "refattr", "dref_field"]);
const sourceOwner = (cls: Partial<ClassName>): string => cls.name!.startsWith("FUGR:") ? cls.name!.slice(5) : cls.name!.split(":")[0];
const localKey = (cls: Partial<ClassName>, m: Partial<Pick<Method, "name">>): string => `${cls.name}|${m.name ?? "CONSTRUCTOR"}`;
const methods = (cls: Class): readonly Method[] => [...cls.methods, ...(cls.constructor ? [cls.constructor] : [])];

export function analyzeOwnership(program: ProgramInput): Ownership {
  const classes = (program.classes ?? program) as readonly Class[];
  const attrs = new Map<string, Set<string>>(), locals = new Map<string, Set<string>>(), declarations = new Set<Local | SupportedAttribute>();
  for (const cls of classes) {
    const safety = program.ownershipSafety?.get(sourceOwner(cls));
    const eligible = (v: Local | Attribute): boolean | undefined => safety && (v.type?.k === "xstring" || (v.type?.k === "x" && v.type.len >= 1 && v.type.len <= 8)) && !safety.dynamic && !safety.names.has(v.name);
    attrs.set(cls.name, new Set((cls.attributes ?? []).filter((a): boolean | undefined => eligible(a) && a.type?.k === "xstring" && a.private && !a.fromIntf && !cls.stubs?.length && a.value === undefined).map((a): string => a.name)));
    // Class methods/constructors are lowered bodies; signature-only entries
    // live in signatures/stubs and are not visited here.
    for (const m of methods(cls)) locals.set(localKey(cls, m), new Set(m.locals!.filter(eligible).map((v): string => v.name)));
  }
  const external = new Set<string>();
  for (const cls of classes) for (const m of methods(cls)) {
    const aa = attrs.get(cls.name)!, ll = locals.get(localKey(cls, m))!;
    const reject = (n: IRValue): void => {
      if (isIRArray(n)) { n.forEach(reject); return; }
      if (!n || typeof n !== "object") return;
      if (isExpr(n) && n.e === "var") ll.delete(n.name);
      if (isExpr(n) && n.e === "attr") aa.delete(n.name);
      if (isExpr(n) && n.e === "static") attrs.get(n.owner)?.delete(n.name);
      if (isExpr(n) && n.e === "refattr") external.add(n.name);
      for (const v of children(n)) reject(v);
    };
    const read = (n: IRValue): void => {
      if (isIRArray(n)) { n.forEach(read); return; }
      if (!n || typeof n !== "object") return;
      if (isExpr(n) && n.e === "wrap") { if (places.has(n.x.e)) reject(n.x); else read(n.x); return; }
      if ((isExpr(n) && n.e === "table_map") || ("c" in n && typeof n.c === "string" && ["table_eq"].includes(n.c))) { reject(n); return; }
      if (isExpr(n) && n.e === "refattr") external.add(n.name);
      if (isExpr(n) && (n.e === "call" || n.e === "new")) {
        for (const a of n.args) {
          // An opaque object consumer could inspect a private slot. Calls on
          // the object itself are checked through its compiled method bodies.
          const objectActual = a.value ?? a.place ?? a.wrap;
          const ownObject = (x: IRValue): boolean => !!x && typeof x === "object" && ((isExpr(x) && x.e === "me") || ("type" in x && x.type && typeof x.type === "object" && "k" in x.type && x.type.k === "ref" && x.type.name === cls.name) || (isIRArray(x) ? x : children(x)).some(ownObject));
          if (ownObject(objectActual)) aa.clear();
          if (a.dir === "importing" && a.byValue === true) read(a.value);
          else {
            const actual = a.value ?? a.place ?? a.wrap;
            const slot = actual?.e === "wrap" ? actual.x : actual;
            if ((a.dir && a.dir !== "importing") || (slot && places.has(slot.e)) || slot?.e === "substr") reject(actual);
            else read(actual);
          }
        }
        reject("receiving" in n ? n.receiving : undefined); read("receiver" in n ? n.receiver : undefined);
        return;
      }
      for (const v of children(n)) read(v);
    };
    const write = (n: Expr | null | undefined, supported: boolean): void => {
      if (!supported || !n || !["var", "attr", "static"].includes(n.e) || ("ref" in n && n.ref)) reject(n);
    };
    const calls = (n: IRValue): TruthResult => n && typeof n === "object" && ((isExpr(n) && (n.e === "call" || n.e === "new")) || (isStmt(n) && (n.s === "call_fm" || n.s === "call_dyn_static")) || (isIRArray(n) ? n : children(n)).some(calls));
    const statements = (n: IRValue): void => {
      if (isIRArray(n)) { n.forEach(statements); return; }
      if (!n || typeof n !== "object") return;
      if (!isStmt(n)) { if (isExpr(n) || isCondition(n)) { if (calls(n)) reject(n); read(n); } else for (const v of children(n)) statements(v); return; }
      // Snapshot/Sub/Len introduce Go calls where string operands had none.
      // Keep string storage whenever a sibling call could change a read slot.
      // Nested bodies are separate statements, not siblings of the condition.
      const operands = irEntries(n).filter(([k]): boolean => !["target", "body", "then", "else", "branches", "catches", "finally", "cleanup", "pos", "type"].includes(k)).map(([, v]): IRValue => v);
      if (operands.some(calls)) operands.forEach(reject);
      if (n.s === "assign" || n.s === "clear" || n.s === "replace_bytes" || n.s === "concat_bytes") {
        // Reading the target before side-effecting operands needs a snapshot;
        // preserve the ordinary representation for that uncertain form.
        write(n.target, !(["replace_bytes", "concat_bytes"].includes(n.s) && (n.target && "type" in n.target && n.target.type?.k === "x")) && !(n.s === "replace_bytes" && [n.with, n.off, n.len].some(calls)));
        for (const [k, v] of irEntries(n)) if (!["target", "pos", "type"].includes(k)) read(v);
      } else if (["if", "case", "do", "while", "seq", "try"].includes(n.s)) {
        // Conditions are reads, bodies contain independently checked writes.
        for (const [k, v] of irEntries(n)) {
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
    const loaded = new Set<string>();
    const scan = (n: IRValue): void => {
      if (!n || typeof n !== "object") return;
      if (isStmt(n) && n.s === "assign" && n.target?.e === "var") {
        const v = n.value?.e === "conv" ? n.value.x : n.value;
        if (v?.e === "substr" && v.len?.e === "int" && v.len.value > 0 && v.len.value <= 8 &&
            (v.x.e === "attr" ? attrs.get(cls.name)!.has(v.x.name) : v.x.e === "var" && locals.get(localKey(cls, m))!.has(v.x.name) && v.x.type.k === "xstring")) loaded.add(n.target.name);
      }
      for (const v of isIRArray(n) ? n : children(n)) scan(v);
    };
    scan(m.body);
    for (const l of m.locals!) if (l.type.k === "x" && !loaded.has(l.name)) locals.get(localKey(cls, m))!.delete(l.name);
  }
  for (const cls of classes) {
    for (const a of cls.attributes ?? []) if (attrs.get(cls.name)!.has(a.name)) {
      // Membership was established only for a supported xstring declaration.
      declarations.add(a as SupportedAttribute);
    }
    for (const m of methods(cls)) for (const l of m.locals!) if (locals.get(localKey(cls, m))!.has(l.name)) declarations.add(l);
  }
  return {declarations, unescaped(p: Expr | null | undefined, ctx: Context): boolean | undefined {
    const safety = program.ownershipSafety?.get(sourceOwner(ctx.cls));
    const mentions = (n: IRValue): TruthResult => n && typeof n === "object" && ((isExpr(n) && n.e === "var" && n.name === (p && "name" in p ? p.name : undefined)) || children(n).some(mentions));
    const escapes = (n: IRValue): TruthResult => n && typeof n === "object" &&
      ((isExpr(n) && n.e === "wrap" && mentions(n.x)) || (isExpr(n) && (n.e === "call" || n.e === "new") && n.args.some(mentions)) ||
       (isStmt(n) && ["call_fm", "call_dyn_static"].includes(n.s) && mentions(n)) || children(n).some(escapes));
    return p?.e === "var" && !p.ref && safety && !safety.dynamic && !safety.names.has(p.name) && !escapes(ctx.method!.body) &&
      (ctx.method!.locals!.some((l): boolean => l.name === p.name) || ctx.method!.returning?.name === p.name);
  }, width(p: Expr | null | undefined, ctx: Context): number | undefined {
    return p?.e === "var" ? ctx.method!.locals!.find((v): v is Local & {readonly type: Extract<Type, {k: "x"}>} => v.name === p.name && v.type.k === "x")?.type.len : 0;
  }, fixed(p: Expr | null | undefined, ctx: Context): number {
    const decl = p?.e === "var" && !p.ref ? ctx.method!.locals!.find((v): boolean => v.name === p.name) : undefined;
    return decl?.type.k === "x" && declarations.has(decl) ? decl.type.len : 0;
  }, has(p: Expr | AttributeProbe | null | undefined, ctx: Context): boolean | undefined {
    return p?.e === "static" ? p.owner === ctx.cls.name && attrs.get(p.owner)?.has(p.name) : p?.e === "attr" ? attrs.get(ctx.cls.name!)?.has(p.name) : p?.e === "var" && !p.ref && locals.get(localKey(ctx.cls, ctx.method!))?.has(p.name);
  }};
}
