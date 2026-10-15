import type {ByteStatement, ByteContext, Expr, ExprHelpers} from './emit-go-types.ts';

// ABAPiti r1-r6: splice bytes; f2: MATCH OFFSET includes the section base.
export function emitByteStatement(st: ByteStatement, ctx: ByteContext, t: string, {expr, place}: Pick<ExprHelpers, 'expr' | 'place'>): string[] {
  const val = (x: Expr | null, fallback: string): string => x ? expr(x, ctx) : fallback;
  if (st.s === "replace_bytes" || st.s === "replace_chars") {
    const target = place(st.target, ctx);
    const type = "type" in st.target ? st.target.type : undefined;
    return [`${t}${target}, s.Sy.Subrc = ${st.s === "replace_bytes" ? "abap.ReplaceBytes" : "hCharsection.Replace"}(${st.s === "replace_chars" ? "abap.Text16, " : ""}${target}, ${expr(st.with, ctx)}, ${val(st.off, "0")}, ${val(st.len, "abap.NoLength")}, ${type?.k === "x" || type?.k === "c" ? type.len : -1})`];
  }
  // P2 ALL C3 reuses the same byte results for MATCH COUNT alone.
  if (st.s === "find_bytes_all") {
    const n = ctx.loop++, matches = `byteMatches${n}`;
    return [`${t}{`, `${t}${matches} := abap.FindBytesAll(${expr(st.subject, ctx)}, ${expr(st.pattern, ctx)})`,
      ...(st.count ? [`${t}${place(st.count, ctx)} = int32(len(${matches}))`] : []),
      `${t}s.Sy.Subrc = 4`, `${t}if len(${matches}) > 0 { s.Sy.Subrc = 0 }`, `${t}}`];
  }
  const pattern = expr(st.pattern, ctx);
  const n = ctx.loop++, fp = `bytePattern${n}`, fb = `byteOffset${n}`, ok = `byteFound${n}`;
  const lines = [`${t}{`, `${t}${fp} := ${pattern}`, `${t}if ${fb}, ${ok} := abap.FindBytes(${expr(st.subject, ctx)}, ${fp}, ${val(st.secOff, "0")}, ${val(st.secLen, "abap.NoLength")}); ${ok} {`, `${t}\ts.Sy.Subrc = 0`];
  lines.push(`${t}\t${st.off ? place(st.off, ctx) : "_"} = ${fb}`);
  if (st.len) lines.push(`${t}\t${place(st.len, ctx)} = int32(len(${fp}))`);
  lines.push(`${t}} else {`, `${t}\ts.Sy.Subrc = 4`, `${t}}`, `${t}}`);
  return lines;
}
