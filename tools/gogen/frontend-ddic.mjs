// abaplint reads every COMPTYPE=E field of a TABL as a data element. A field
// that says E and has no ROLLNAME therefore types as UnknownType, and the
// transpiler's DatabaseSetup then fails with "todo toType handle:
// UnknownType", which names the field but not the cause. Refuse that shape
// up front, for the tables DatabaseSetup builds: transparent ones only
// (abaplint's TableCategory.Transparent, pinned by the test).
// Fields come from abaplint's own XML parse (getFields), never from the text.
export const TRANSPARENT = "TRANSP";
const text = (v) => (v === undefined || v === null ? "" : String(v)).trim();
export function elementaryFieldsWithoutRollname(reg) {
  const out = [];
  for (const obj of reg.getObjects()) {
    if (obj.getType() !== "TABL" || obj.getTableCategory?.() !== TRANSPARENT) continue;
    for (const f of obj.getFields?.() ?? []) {
      if (text(f.COMPTYPE) === "E" && text(f.ROLLNAME) === "")
        out.push(`${obj.getName().toUpperCase()}-${text(f.FIELDNAME)} (DATATYPE ${text(f.DATATYPE) || "none"})`);
    }
  }
  return out;
}
export function assertTableFieldsTyped(reg) {
  const bad = elementaryFieldsWithoutRollname(reg);
  if (bad.length > 0) throw new Error(`TABL field with COMPTYPE E and no ROLLNAME: ${bad.join(", ")}. `
    + "abaplint reads COMPTYPE E as a data element reference; give each field a data element (ROLLNAME).");
}
