// abaplint reads every COMPTYPE=E field of a TABL as a data element. A field
// that says E, gives a DATATYPE and no ROLLNAME therefore types as
// UnknownType, and the transpiler's DatabaseSetup then fails with a message
// that names neither the table nor the cause. Refuse that shape up front.
// Fields come from abaplint's own XML parse (getFields), never from the text.
const text = (v) => (v === undefined || v === null ? "" : String(v)).trim();
export function elementaryFieldsWithoutRollname(reg) {
  const out = [];
  for (const obj of reg.getObjects()) {
    if (obj.getType() !== "TABL") continue;
    for (const f of obj.getFields?.() ?? []) {
      if (text(f.COMPTYPE) === "E" && text(f.ROLLNAME) === "" && text(f.DATATYPE) !== "")
        out.push(`${obj.getName().toUpperCase()}-${text(f.FIELDNAME)} (DATATYPE ${text(f.DATATYPE)})`);
    }
  }
  return out;
}
export function assertTableFieldsTyped(reg) {
  const bad = elementaryFieldsWithoutRollname(reg);
  if (bad.length > 0) throw new Error(`TABL field with COMPTYPE E and no ROLLNAME: ${bad.join(", ")}. `
    + "abaplint reads COMPTYPE E as a data element reference; give each field a data element (ROLLNAME).");
}
