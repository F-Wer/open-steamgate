// abaplint interprets COMPTYPE=E as a data element unconditionally. Some
// abapGit layers also use E for elementary built-in fields with no ROLLNAME.
// Normalize only that shape before parsing, so ABAP typing, RTTI and the
// transpiler's DatabaseSetup all consume the same built-in DDIC definition.
export function builtinTableFields(source, filename) {
  if (!/\.tabl\.xml$/i.test(filename)) return source;
  return source.replace(/<DD03P>[\s\S]*?<\/DD03P>/g, (field) => {
    if (!/<DATATYPE>\s*[^<\s]+\s*<\/DATATYPE>/.test(field)
        || /<ROLLNAME>\s*[^<\s]+/.test(field)) return field;
    return field.replace(/<COMPTYPE>\s*E\s*<\/COMPTYPE>/, "<COMPTYPE></COMPTYPE>");
  });
}
