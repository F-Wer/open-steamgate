import type {Program, ProgramInput, Class, RenderName, Rtti, RttiHelpers, MessageHelpers} from "./emit-go-types.ts";

// Object RTTI for the exception/reference seam. Descriptor member enumeration
// reads on kernel descriptors are guarded at runtime.
export function objectRttiGo(program: Pick<Program, "classes">, {goType, ident}: RttiHelpers): string[] {
  const ret = goType({k: "ref", name: "CL_ABAP_TYPEDESCR"});
  const classRef = goType({k: "ref", name: "CL_ABAP_CLASSDESCR"});
  const concreteClass = classRef.startsWith("I_") ? "*" + classRef.slice(2) : classRef;
  const head = `func Native_DESCRIBE_BY_OBJECT_REF(s *abap.Session, p_object_ref any) ${ret} {`;
  if (!["CL_ABAP_CLASSDESCR", "CL_ABAP_TYPEDESCR"].every((n): boolean => program.classes.some((c): boolean => c.name === n)))
    return [head, '\tpanic(abap.NotCompiled("DESCRIBE_BY_OBJECT_REF", "CL_ABAP_CLASSDESCR is not compiled"))', '}'];
  return [head,
    '\tif abap.RefEq(p_object_ref, nil) { panic(abap.ClassicException{Name: "REFERENCE_IS_INITIAL", Method: "DESCRIBE_BY_OBJECT_REF"}) }',
    '\tname := abap.ClassOf(p_object_ref)',
    '\tif name == "" { panic(abap.NotCompiled("DESCRIBE_BY_OBJECT_REF", "the class of the object is not registered")) }',
    '\to := objectRttiClass(name)',
    '\tif k, ok := p_object_ref.(interface{ GetKernelException() *abap.Exception }); ok { o.KernelRtti = k.GetKernelException() != nil }',
    '\treturn o', '}', '',
    `func objectRttiClass(name string) ${concreteClass} {`,
    '\to := Alloc_CL_ABAP_CLASSDESCR()',
    ...[["TYPE_KIND", "*"], ["KIND", "C"]].map(([n, v]): string => `\to.${ident(n)} = ${JSON.stringify(v)}`),
    `\to.${ident("RELATIVE_NAME")} = name[strings.LastIndex(name, ":")+1:]`,
    '\tabsolute := "\\\\CLASS=" + name',
    '\tif i := strings.LastIndex(name, ":"); i >= 0 { absolute = "\\\\CLASS-POOL=" + name[:i] + "\\\\CLASS=" + name[i+1:] }',
    `\to.${ident("ABSOLUTE_NAME")} = absolute`,
    `\to.${ident("MV_OBJECT_NAME")} = name`,
    `\to.${ident("MV_OBJECT_TYPE")} = "CLAS"`,
    '\treturn o', '}', ''];
}
export function objectRttiJs(t: string, x: string, ident: RenderName): string[] {
  return [
    `${t}if (${x} == null) throw new abap.ClassicException("REFERENCE_IS_INITIAL", "DESCRIBE_BY_OBJECT_REF");`,
    `${t}const name = ${x}.constructor.$abap;`,
    `${t}if (!name) throw new abap.AbapError("NOT_COMPILED", "DESCRIBE_BY_OBJECT_REF: the class of the object is not registered");`,
    ...classDescrJs(t, ident, `!!${x}.$kernelException`)];
}
function classDescrJs(t: string, ident: RenderName, kernel = "false"): string[] {
  return [
    `${t}const o = new CL_ABAP_CLASSDESCR();`,
    `${t}o.$kernelRtti = ${kernel};`,
    ...[["TYPE_KIND", '"*"'], ["KIND", '"C"'], ["RELATIVE_NAME", 'name.slice(name.lastIndexOf(":") + 1)'], ["ABSOLUTE_NAME", 'name.includes(":") ? "\\\\CLASS-POOL=" + name.replace(":", "\\\\CLASS=") : "\\\\CLASS=" + name'], ["MV_OBJECT_NAME", 'name'], ["MV_OBJECT_TYPE", '"CLAS"']]
      .map(([n, v]): string => `${t}o.${ident(n)} = ${v};`),
    `${t}return o;`];
}

export function exceptionClass(cls: Partial<Pick<Class, "name" | "super">> | null | undefined, classes: ReadonlyMap<string | null | undefined, Class>): boolean {
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
export function nativeMessageText(program: ProgramInput, {goType, ident, classes: CLASSES, poly: POLY, ancestorsOf}: MessageHelpers): string[] {
  const head = `func Native_GET_TEXT_FOR_MESSAGE(s *abap.Session, text ${goType({k: "ref", name: "IF_MESSAGE", intf: true})}) string {`;
  const root = CLASSES.get("CX_ROOT");
  // IF_T100_MESSAGE has no methods, so every Go value fits its interface:
  // the classes that implement it are told by name
  const t100 = [...CLASSES.values()].filter((c): boolean => [c, ...ancestorsOf(c)].some((x): boolean => (x.interfaces ?? []).includes("IF_T100_MESSAGE"))).map((c): string => c.name);
  return [head, "\tif abap.RefEq(text, nil) {", `\t\tpanic(abap.NotCompiled("CL_MESSAGE_HELPER=>GET_TEXT_FOR_MESSAGE", "an initial reference"))`, "\t}",
    '\tif k, ok := any(text).(interface{ GetKernelException() *abap.Exception }); ok && k.GetKernelException() != nil { return k.GetKernelException().Text() }',
    ...(t100.length ? [`\tswitch abap.ClassOf(text) {`, `\tcase ${t100.map((x): string => JSON.stringify(x)).join(", ")}:`, `\t\tpanic(abap.NotCompiled("CL_MESSAGE_HELPER=>GET_TEXT_FOR_MESSAGE", "T100 message texts are not read in the Go host"))`, "\t}"] : []),
    ...(root && POLY.has("CX_ROOT") && root.attributes.some((a): boolean => a.name === "TEXTID" && !a.unsupported)
      ? [`\tif x, ok := any(text).(I_CX_ROOT); !ok || abap.ExceptionRead(x.As_CX_ROOT(), "TEXTID").${ident("TEXTID")} != "" {`, `\t\tpanic(abap.NotCompiled("CL_MESSAGE_HELPER=>GET_TEXT_FOR_MESSAGE", "OTR texts are not read in the Go host"))`, "\t}"]
      : [`\tpanic(abap.NotCompiled("CL_MESSAGE_HELPER=>GET_TEXT_FOR_MESSAGE", "CX_ROOT is not compiled"))`]),
    `\treturn "An exception was raised."`, "}", ""];
}

// SAP's answer without an explicit superclass is unmeasured (measure on A4H).
// Follow Node/open-abap-core: raise SUPER_CLASS_NOT_FOUND, never invent OBJECT.
export function superClassGo(program: Pick<Program, "classes"> & {readonly rtti: Rtti}, {goType, ident}: RttiHelpers): string[] {
  const ref = goType({k: "ref", name: "CL_ABAP_CLASSDESCR"});
  const head = `func Native_GET_SUPER_CLASS_TYPE(s *abap.Session, me ${ref}) ${ref} {`;
  if (!["CL_ABAP_CLASSDESCR", "CL_ABAP_TYPEDESCR"].every((n): boolean => program.classes.some((c): boolean => c.name === n)))
    return [head, '\tpanic(abap.NotCompiled("GET_SUPER_CLASS_TYPE", "class RTTI is not compiled"))', '}'];
  return [`var rttiClassSupers = map[string]string{`,
    ...[...program.rtti.classSupers].sort().map(([n, sup]): string => `\t${JSON.stringify(n)}: ${JSON.stringify(sup ?? "")},`),
    "}", "var rttiCompiledClasses = map[string]bool{",
    ...program.classes.map((c): string => c.name).sort().map((n): string => `\t${JSON.stringify(n)}: true,`),
    "}", head,
    ...(ref.startsWith("I_") ? ["\tbase := me.As_CL_ABAP_CLASSDESCR()"] : ["\tbase := me"]),
    `\tname := strings.ToUpper(strings.TrimRight(base.${ident("MV_OBJECT_NAME")}, " "))`,
    `\tif name == "" { name = strings.ToUpper(strings.TrimRight(base.${ident("RELATIVE_NAME")}, " ")) }`,
    // Empty names match Node's classic exception. Unknown non-empty names
    // stay NOT_COMPILED: this registry inventory may be incomplete.
    '\tif name == "" { panic(abap.ClassicException{Name: "SUPER_CLASS_NOT_FOUND", Method: "GET_SUPER_CLASS_TYPE"}) }',
    '\tsup, ok := rttiClassSupers[name]',
    '\tif !ok { panic(abap.NotCompiled("GET_SUPER_CLASS_TYPE", "class RTTI is unavailable: "+name)) }',
    '\tif sup == "" { panic(abap.ClassicException{Name: "SUPER_CLASS_NOT_FOUND", Method: "GET_SUPER_CLASS_TYPE"}) }',
    '\tif !rttiCompiledClasses[sup] { panic(abap.NotCompiled("GET_SUPER_CLASS_TYPE", "superclass "+sup+" is not compiled")) }',
    '\to := objectRttiClass(sup)',
    '\to.KernelRtti = base.KernelRtti',
    '\ts.Sy.Subrc = 0',
    '\treturn o', "}", ""];
}
export function superClassJsDeclarations(program: Pick<Program, "classes"> & {readonly rtti: Rtti}): string[] {
  if (!program.classes.some((c): boolean => c.methods.some((m): boolean => m.body?.[0]?.s === "native" && m.body[0].fn === "Native_GET_SUPER_CLASS_TYPE"))) return [];
  return [`const rttiClassSupers = new Map(${JSON.stringify([...program.rtti.classSupers].sort())});`,
    `const rttiCompiledClasses = new Set(${JSON.stringify(program.classes.map((c): string => c.name).sort())});`];
}
export function superClassJs(t: string, ident: RenderName): string[] {
  return [
    `${t}const currentName = (me.${ident("MV_OBJECT_NAME")}.trimEnd() || me.${ident("RELATIVE_NAME")}.trimEnd()).toUpperCase();`,
    // Empty names match Node's classic exception. Unknown non-empty names
    // stay NOT_COMPILED: this registry inventory may be incomplete.
    `${t}if (!currentName) throw new abap.ClassicException("SUPER_CLASS_NOT_FOUND", "GET_SUPER_CLASS_TYPE");`,
    `${t}if (!rttiClassSupers.has(currentName)) throw new abap.AbapError("NOT_COMPILED", "GET_SUPER_CLASS_TYPE: class RTTI is unavailable: " + currentName);`,
    `${t}const sup = rttiClassSupers.get(currentName);`,
    `${t}if (!sup) throw new abap.ClassicException("SUPER_CLASS_NOT_FOUND", "GET_SUPER_CLASS_TYPE");`,
    `${t}if (!rttiCompiledClasses.has(sup)) throw new abap.AbapError("NOT_COMPILED", "GET_SUPER_CLASS_TYPE: superclass " + sup + " is not compiled");`,
    `${t}const name = sup;`, `${t}s.sy.subrc = 0;`, ...classDescrJs(t, ident, "me.$kernelRtti")];
}
