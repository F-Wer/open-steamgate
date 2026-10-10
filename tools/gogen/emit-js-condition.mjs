// Conditions over native IR-JS values; recursion stays with the emitter.
export function emitCondition(c, ctx, {expr, zero, place, ident, cond}) {
  switch (c.c) {
    case "instance_of": return `((value) => value == null ? ${!!c.initial} : ${c.type.name === "OBJECT" ? "true" : `!!value.constructor?.$is?.has(${JSON.stringify(c.type.name)})`})(${expr(c.x, ctx)})`;
    case "num_data_cmp": return `abap.CmpNumericData(${expr(c.l, ctx)}, ${expr(c.r, ctx)}) ${c.op === "=" ? "===" : c.op === "<>" ? "!==" : c.op} 0`;
    case "in_range": {
      const n = ctx.loop++;
      return `(() => { const rows${n} = ${expr(c.range, ctx)}; let hasI${n} = false, hit${n} = false; for (const r${n} of rows${n}) { let match${n}; if (r${n}.Option === "EQ") match${n} = ${expr(c.value, ctx)} === r${n}.Low; else if (r${n}.Option === "BT") match${n} = ${expr(c.value, ctx)} >= r${n}.Low && ${expr(c.value, ctx)} <= r${n}.High; else throw new abap.AbapError("NOT_COMPILED", "IN range: selection option other than EQ or BT"); if (r${n}.Sign === "I") { hasI${n} = true; if (match${n}) hit${n} = true; } else if (r${n}.Sign === "E") { if (match${n}) return false; } else throw new abap.AbapError("NOT_COMPILED", "IN range: selection sign other than I or E"); } return !hasI${n} || hit${n}; })()`;
    }
    case "co": return `abap.CO(${expr(c.l, ctx)}, ${expr(c.r, ctx)})`;
    case "cs": return `abap.CSWithPos(s, ${expr(c.l, ctx)}, ${expr(c.r, ctx)}, ${!!c.csubject})`;
    case "cp": return `abap.CP(${expr(c.l, ctx)}, ${expr(c.r, ctx)}, ${!!c.cpat}, ${!!c.csubject})`;
    case "ca": return `abap.CA(${expr(c.l, ctx)}, ${expr(c.r, ctx)})`;
    case "cmp":
      if (c.l.e === "unwrap_chars" || c.r.e === "unwrap_chars") {
        const side = x => x.e === "unwrap_chars" ? expr(x.x, ctx) : `abap.cell(${expr(x, ctx)}, abap.TString)`;
        return `abap.CmpData(${side(c.l)}, ${side(c.r)}) ${c.op === "=" ? "===" : c.op === "<>" ? "!==" : c.op} 0`;
      }
      if (c.type?.k === "p") return `abap.CmpP(${expr(c.l, ctx)}, ${expr(c.r, ctx)}) ${c.op === "=" ? "===" : c.op === "<>" ? "!==" : c.op} 0`;
      return `${expr(c.l, ctx)} ${c.op === "=" ? "===" : c.op === "<>" ? "!==" : c.op} ${expr(c.r, ctx)}`;
    // ultra/events: line_exists( ) (frontend lineExists)
    case "line_exists": {
      const n = ctx.loop++;
      const keys = c.keys.map((k) => (k.line ? `r${n} === ${expr(k.value, ctx)}` : `r${n}.${ident(k.name)} === ${expr(k.value, ctx)}`)).join(" && ");
      return `${expr(c.table, ctx)}.some((r${n}) => ${keys})`;
    }
    // two object references (ultra/json refeq; ultra/events: undefined and
    // null are both the initial reference)
    case "refeq": return `(${c.op === "=" ? "" : "!"}abap.RefEq(${expr(c.l, ctx)}, ${expr(c.r, ctx)}))`;
    case "data_bound": return `abap.DataBound(${expr(c.x, ctx)})`;
    case "initial":
      if (c.x.type.k === "data") return `abap.IsInitialData(${expr(c.x, ctx)})`;
      if (c.x.type.k === "dref") return `(${expr(c.x, ctx)} === null)`;
      // "" or the typed zero for d, t and n; a structure or table compared component by component
      if (["d", "t", "n"].includes(c.x.type.k)) return `abap.InitialCh(${expr(c.x, ctx)}, ${zero(c.x.type)})`;
      if (c.x.type.k === "struct" || c.x.type.k === "table") return `abap.IsInitialDeep(${expr(c.x, ctx)}, ${zero(c.x.type)})`;
      return `${expr(c.x, ctx)} === ${zero(c.x.type)}`;
    case "assigned": return `${ident(c.fs.name)} !== null`;
    case "and": return `(${cond(c.l, ctx)} && ${cond(c.r, ctx)})`;
    case "true": return "true";
    // two tables, = or <>: the row counts, then each row at its index
    case "tableeq":
      return `(${c.op === "=" ? "" : "!"}(() => { const l = ${expr(c.l, ctx)}, r = ${expr(c.r, ctx)}; if (l.length !== r.length) return false; for (let i = 0; i < l.length; i++) { ${place(c.a, ctx)} = l[i]; ${place(c.b, ctx)} = r[i]; if (!(${cond(c.rowEq, ctx)})) return false; } return true; })())`;
    case "or": return `(${cond(c.l, ctx)} || ${cond(c.r, ctx)})`;
    case "not": return `!(${cond(c.x, ctx)})`;
    default: throw new Error(`no JS for condition ${c.c}`);
  }
}
