// Object RTTI for the exception/reference seam. Descriptor member enumeration
// reads on kernel descriptors are guarded at runtime.
export function objectRttiGo(program, {goType, ident}) {
  const ret = goType({k: "ref", name: "CL_ABAP_TYPEDESCR"});
  const head = `func Native_DESCRIBE_BY_OBJECT_REF(s *abap.Session, p_object_ref any) ${ret} {`;
  if (!["CL_ABAP_CLASSDESCR", "CL_ABAP_TYPEDESCR"].every(n => program.classes.some(c => c.name === n)))
    return [head, '\tpanic(abap.NotCompiled("DESCRIBE_BY_OBJECT_REF", "CL_ABAP_CLASSDESCR is not compiled"))', '}'];
  return [head,
    '\tif abap.RefEq(p_object_ref, nil) { panic(abap.ClassicException{Name: "REFERENCE_IS_INITIAL", Method: "DESCRIBE_BY_OBJECT_REF"}) }',
    '\tname := abap.ClassOf(p_object_ref)',
    '\tif name == "" { panic(abap.NotCompiled("DESCRIBE_BY_OBJECT_REF", "the class of the object is not registered")) }',
    '\to := Alloc_CL_ABAP_CLASSDESCR()',
    '\tif k, ok := p_object_ref.(interface{ GetKernelException() *abap.Exception }); ok { o.KernelRtti = k.GetKernelException() != nil }',
    ...[["TYPE_KIND", "*"], ["KIND", "C"]].map(([n, v]) => `\to.${ident(n)} = ${JSON.stringify(v)}`),
    `\to.${ident("RELATIVE_NAME")} = name[strings.LastIndex(name, ":")+1:]`,
    '\tabsolute := "\\\\CLASS=" + name',
    '\tif i := strings.LastIndex(name, ":"); i >= 0 { absolute = "\\\\CLASS-POOL=" + name[:i] + "\\\\CLASS=" + name[i+1:] }',
    `\to.${ident("ABSOLUTE_NAME")} = absolute`,
    `\to.${ident("MV_OBJECT_NAME")} = name`,
    `\to.${ident("MV_OBJECT_TYPE")} = "CLAS"`,
    '\treturn o', '}', ''];
}
export function objectRttiJs(t, x, ident) {
  return [
    `${t}if (${x} == null) throw new abap.ClassicException("REFERENCE_IS_INITIAL", "DESCRIBE_BY_OBJECT_REF");`,
    `${t}const name = ${x}.constructor.$abap;`,
    `${t}if (!name) throw new abap.AbapError("NOT_COMPILED", "DESCRIBE_BY_OBJECT_REF: the class of the object is not registered");`,
    `${t}const o = new CL_ABAP_CLASSDESCR();`,
    `${t}o.$kernelRtti = !!${x}.$kernelException;`,
    ...[["TYPE_KIND", '"*"'], ["KIND", '"C"'], ["RELATIVE_NAME", 'name.slice(name.lastIndexOf(":") + 1)'], ["ABSOLUTE_NAME", 'name.includes(":") ? "\\\\CLASS-POOL=" + name.replace(":", "\\\\CLASS=") : "\\\\CLASS=" + name'], ["MV_OBJECT_NAME", 'name'], ["MV_OBJECT_TYPE", '"CLAS"']]
      .map(([n, v]) => `${t}o.${ident(n)} = ${v};`),
    `${t}return o;`];
}

export function exceptionClass(cls, classes) {
  for (let c = cls; c; c = classes.get(c.super)) if (c.name === "CX_ROOT") return true;
  return false;
}

/**
 * CL_MESSAGE_HELPER=>GET_TEXT_FOR_MESSAGE, which open-abap writes as kernel
 * code: an exception object that is no IF_T100_MESSAGE and has no text id
 * has the fallback text (A4H gives the same for such a class, 2026-09-23);
 * a T100 message or an OTR text id is not read here and dumps. Kernel
 * objects return their carried GET_TEXT value before inspecting metadata.
 */
export function nativeMessageText(program, {goType, ident, classes: CLASSES, poly: POLY, ancestorsOf}) {
  const head = `func Native_GET_TEXT_FOR_MESSAGE(s *abap.Session, text ${goType({k: "ref", name: "IF_MESSAGE", intf: true})}) string {`;
  const root = CLASSES.get("CX_ROOT");
  // IF_T100_MESSAGE has no methods, so every Go value fits its interface:
  // the classes that implement it are told by name
  const t100 = [...CLASSES.values()].filter((c) => [c, ...ancestorsOf(c)].some((x) => (x.interfaces ?? []).includes("IF_T100_MESSAGE"))).map((c) => c.name);
  return [head, "\tif abap.RefEq(text, nil) {", `\t\tpanic(abap.NotCompiled("CL_MESSAGE_HELPER=>GET_TEXT_FOR_MESSAGE", "an initial reference"))`, "\t}",
    '\tif k, ok := any(text).(interface{ GetKernelException() *abap.Exception }); ok && k.GetKernelException() != nil { return k.GetKernelException().Text() }',
    ...(t100.length ? [`\tswitch abap.ClassOf(text) {`, `\tcase ${t100.map((x) => JSON.stringify(x)).join(", ")}:`, `\t\tpanic(abap.NotCompiled("CL_MESSAGE_HELPER=>GET_TEXT_FOR_MESSAGE", "T100 message texts are not read in the Go host"))`, "\t}"] : []),
    ...(root && POLY.has("CX_ROOT") && root.attributes.some((a) => a.name === "TEXTID" && !a.unsupported)
      ? [`\tif x, ok := any(text).(I_CX_ROOT); !ok || abap.ExceptionRead(x.As_CX_ROOT(), "TEXTID").${ident("TEXTID")} != "" {`, `\t\tpanic(abap.NotCompiled("CL_MESSAGE_HELPER=>GET_TEXT_FOR_MESSAGE", "OTR texts are not read in the Go host"))`, "\t}"]
      : [`\tpanic(abap.NotCompiled("CL_MESSAGE_HELPER=>GET_TEXT_FOR_MESSAGE", "CX_ROOT is not compiled"))`]),
    `\treturn "An exception was raised."`, "}", ""];
}
