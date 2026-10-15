import {Nodes, Statements, isStmt, Unsupported, upper, S, XS, I} from "./frontend-base.mjs";
import {variable, refAttribute, fieldOf, constructorSignature, convert, defaultValue, withSupplied} from "./frontend.mjs";

/*
 * Statements A4H does not activate, which abaplint takes and the transpiler
 * gives a meaning; refused everywhere (ANORMALIES), except in the methods
 * named here, which are compiled with the transpiler's meaning until the
 * library is fixed upstream. A decision of the foreman's, not a rule:
 *   /UI2/CL_JSON=>_DESERIALIZE: CREATE DATA ref LIKE LINE OF data (data TYPE
 *   data): the line type of the table data holds at run time, as the
 *   transpiler reads it (ANORMALIES create-data-like-line-generic; the fix
 *   upstream is LIKE LINE OF <at> after ASSIGN data TO <at>)
 */
const TRANSPILER_MEANING = new Map([
  ["/UI2/CL_JSON=>_DESERIALIZE", "CREATE DATA LIKE LINE OF generic data"],
]);

// ultra/events: the host functions whose TYPE p parameters are read as p(16,7) (typeOf)
const P_GENERIC = new Set(["CL_ABAP_TSTMP=>SUBTRACT", "CL_ABAP_TSTMP=>SUBTRACTSECS"]);
/** methods whose ABAP is kernel code in the transpiler runtime, and the host function that does their work */
/** @type {Map<string, string | {fn: string; args: string[]}>} */ const NATIVE = new Map([
  // ultra/events (the WEBGUI's transaction sessions, ZCL_OSD_TRAN_SESSION):
  // the seconds from TSTMP2 to TSTMP1, their fractions cut off, as
  // open-abap-core's kernel lines compute them (its RETURNING is an i; a
  // system's is a p with decimals); a random integer 0 .. 2^31-2 as
  // open-abap-core's INT (a seed given to CREATE is ignored there too)
  ["CL_ABAP_TSTMP=>SUBTRACT", {fn: "abap.TstmpSubtract", args: ["TSTMP1:p", "TSTMP2:p"]}],
  // the time stamp SECS seconds earlier, as open-abap-core's ADD computes it (go/tstmp)
  ["CL_ABAP_TSTMP=>SUBTRACTSECS", {fn: "tstmpsecs.SubtractSecs", args: ["TSTMP:p", "SECS:i"]}],
  ["CL_ABAP_RANDOM=>INT", {fn: "abap.RandomInt31", args: []}],
  ["CL_ABAP_MESSAGE_DIGEST=>CALCULATE_HASH_FOR_CHAR", {fn: "hashchar.Calculate", args: ["IF_ALGORITHM:string", "IF_DATA:string", "&EF_HASHXSTRING:xstring", "&EF_HASHSTRING:string", "&EF_HASHB64STRING:string"]}],
  // crypto.randomUUID() on Node (go/abap/uuid.go); CREATE_UUID_* are ABAP around it
  ["CL_SYSTEM_UUID=>RANDOM", {fn: "abap.UUIDRandom", args: []}],
  ["CL_ABAP_TYPEDESCR=>DESCRIBE_BY_NAME", "Native_DESCRIBE_BY_NAME"],
  ["CL_ABAP_TYPEDESCR=>DESCRIBE_BY_OBJECT_REF", "Native_DESCRIBE_BY_OBJECT_REF"],
  // ultra/json: the descriptor of a value (emit-go nativeRttiData), and the
  // JSON.parse half of open-abap-core's JSON reader (go/abap/jsonparse.go);
  // both are @KERNEL code on Node, and the JS emitter has neither
  ["CL_ABAP_TYPEDESCR=>DESCRIBE_BY_DATA", "Native_DESCRIBE_BY_DATA"],
  ["CL_SXML_STRING_READER:LCL_JSON_PARSER=>PARSE", "Native_JSON_PARSE"],
  // AJSON chooses a converter by a dynamic class/method name and falls back
  // to the older converter on CX_SY_DYN_CALL_ILLEGAL_CLASS. Both paths are
  // UTF-8 on Node; use the existing host text conversion for this pair.
  ["ZCL_AJSON:LCL_UTILS=>STRING_TO_XSTRING_UTF8", "Native_AJSON_ENCODE"],
  ["ZCL_AJSON:LCL_UTILS=>XSTRING_TO_STRING_UTF8", "Native_AJSON_DECODE"],
  ["CL_HTTP_UTILITY=>IF_HTTP_UTILITY~UNESCAPE_URL", "abap.UnescapeURL"],
  // the zip reader's CRC-32 register over a piece (src/zip): the ABAP loop,
  // a byte at a time, was a third of a 150 MB zip read (go/abap/crc32.go)
  ["ZCL_OSD_CRC32=>COMBINE", "abap.Crc32Combine"],
  // the zip reader's raw DEFLATE: the same state machine in Go, with a table
  // for short codes (go/abap/inflate.go); FEED decodes in ABAP without it
  ["ZCL_OSD_INFLATE=>HOST_OPEN", "abap.InflateHostOpen"],
  ["ZCL_OSD_INFLATE=>HOST_FEED", {fn: "abap.InflateHostFeed", args: ["IV_HANDLE:i", "IV_DATA:xstring", "IV_MAX_OUT:i", "&EV_RAW:xstring", "&EV_STATE:i", "&EV_UNUSED:xstring", "&EV_REASON:string"]}],
  // the streaming sXML parser's scans over its window (src/sxml): a name to
  // its delimiter, white space to its end (go/abap/sxmlscan.go)
  ["ZCL_OSD_SXML_PULL=>NAME_END", "abap.SxmlNameEnd"],
  ["ZCL_OSD_SXML_PULL=>SPACE_END", "abap.SxmlSpaceEnd"],
  ["ZCL_OSD_SXML_PULL=>UTF8_TEXT", {fn: "abap.SxmlUtf8Text", args: ["IV_PART:xstring", "&EV_TEXT:string", "&EV_OK:i"]}],
  // the value text of CL_ABAP_UNIT_ASSERT's messages: Object.keys( ) of a
  // structure and an object's constructor name are @KERNEL lines in
  // open-abap-core's LCL_DUMP (go/abap/unitdump.go)
  ["CL_ABAP_UNIT_ASSERT:LCL_DUMP=>TO_STRING", "abap.UnitDumpToString"],
  ["CL_ABAP_UNIT_ASSERT:LCL_DUMP=>DUMP_STRUCTURE", "abap.UnitDumpStructure"],
  // bytes as base64, RFC 4648 with padding (A4H 2026-09-24, ZCL_GOGEN_T_B64);
  // the LSD channel sends the show this way (ultra/packs). Invalid base64
  // behavior on a system has not been measured.
  ["CL_HTTP_UTILITY=>ENCODE_X_BASE64", "abap.EncodeXBase64"],
  ["CL_HTTP_UTILITY=>DECODE_X_BASE64", "abap.DecodeXBase64"],
  ["ZCL_OAO_RFC_DESTINATION=>REGISTER_LOCAL", "abap.RegisterLocalDestination"],
  // get_text( ) of an exception without a T100 message or a text id: the
  // fallback text, which A4H gives too (2026-09-23); anything else dumps
  ["CL_MESSAGE_HELPER=>GET_TEXT_FOR_MESSAGE", "Native_GET_TEXT_FOR_MESSAGE"],
  // the ICF entity's text body: UTF-8 both ways, as open-abap-core's
  // CL_ABAP_CONV_IN_CE / _OUT_CE do it (TextDecoder with fatal, so bytes that
  // are not UTF-8 raise CX_SY_CONVERSION_CODEPAGE); those two classes take
  // generic parameters, which the subset has no signature for
  // what the host is: runtime, platform, memory, one "name<TAB>value" line
  // each (go/abap/sysinfo.go; on Node the class's own @KERNEL lines)
  ["ZCL_OSD_SYSINFO=>ENVIRONMENT", {fn: "abap.SysInfoEnv", args: []}],
  // ultra/events: abapGit's UTF-8 decoding, which its local class LCL_IN does
  // through a codepage class found by name at run time (the class
  // constructor of ZCL_ABAPGIT_GUI_EVENT needs it): the first IV_LENGTH bytes
  // (all when not positive) read as UTF-8; bytes that are not UTF-8 would be
  // a ZCX_ABAPGIT_EXCEPTION there, which the host does not make, so it dumps
  ["ZCL_ABAPGIT_CONVERT=>XSTRING_TO_STRING_UTF8", {fn: "abap.XStringToStringUTF8", args: ["IV_DATA:xstring", "IV_LENGTH:i"]}],
  ["CL_HTTP_ENTITY=>IF_HTTP_ENTITY~GET_CDATA", {fn: "abap.ICFGetCData", args: ["MV_DATA:xstring"]}],
  ["CL_HTTP_ENTITY=>IF_HTTP_ENTITY~SET_CDATA", {fn: "abap.ICFSetCData", args: ["&MV_DATA:xstring", "DATA:string"]}],
  // ultra/httpc: what CL_HTTP_CLIENT needs around its kernel lines. The
  // answer to accept-encoding: gzip is inflated with zlib.gunzipSync, a
  // string as base64 is Buffer.from(string) (UTF-8) as base64 (authenticate)
  ["CL_ABAP_GZIP=>DECOMPRESS_BINARY_WITH_HEADER", {fn: "abap.GunzipWithHeader", args: ["GZIP_IN:xstring", "&RAW_OUT:xstring"]}],
  // parity-wave2: raw DEFLATE both ways (zlib.deflateRawSync /
  // inflateRawSync on Node, go/abap/gzip.go): cl_abap_zip's ADD and GET,
  // the SEGW RepoSet zip. Go's encoder is not zlib's, so the compressed
  // bytes differ; the stream inflates to the same input on both
  ["CL_ABAP_GZIP=>COMPRESS_BINARY", {fn: "abap.DeflateRaw", args: ["RAW_IN:xstring", "&GZIP_OUT:xstring", "&GZIP_OUT_LEN:i"]}],
  ["CL_ABAP_GZIP=>DECOMPRESS_BINARY", {fn: "abap.InflateRaw", args: ["GZIP_IN:xstring", "&RAW_OUT:xstring", "&RAW_OUT_LEN:i"]}],
  ["CL_HTTP_UTILITY=>IF_HTTP_UTILITY~ENCODE_BASE64", {fn: "abap.EncodeBase64", args: ["UNENCODED:string"]}],
  ["CL_HTTP_UTILITY=>IF_HTTP_UTILITY~DECODE_BASE64", {fn: "abap.DecodeBase64", args: ["ENCODED:string"]}],
  // Native application host: the browser implementation of these classic
  // frontend services is intentionally inert. In a compiled command the
  // frontend is the local machine, so files and directories map to the OS.
  ["CL_GUI_FRONTEND_SERVICES=>GET_TEMP_DIRECTORY", {fn: "abap.FrontendTempDirectory", args: ["&TEMP_DIR:string"]}],
  ["CL_GUI_FRONTEND_SERVICES=>DIRECTORY_GET_CURRENT", {fn: "abap.FrontendCurrentDirectory", args: ["&CURRENT_DIRECTORY:string"]}],
  ["CL_GUI_FRONTEND_SERVICES=>FILE_EXIST", {fn: "abap.FrontendFileExist", args: ["FILE:string"]}],
  ["CL_GUI_FRONTEND_SERVICES=>DIRECTORY_EXIST", {fn: "abap.FrontendDirectoryExist", args: ["DIRECTORY:string"]}],
  ["CL_GUI_FRONTEND_SERVICES=>FILE_GET_SIZE", {fn: "abap.FrontendFileSize", args: ["FILE_NAME:string", "&FILE_SIZE:i"]}],
  ["CL_GUI_FRONTEND_SERVICES=>GUI_UPLOAD", {fn: "abap.FrontendUpload", args: ["FILENAME:string", "FILETYPE:c", "&FILELENGTH:i", "&HEADER:xstring", "&DATA_TAB:data"]}],
  ["CL_GUI_FRONTEND_SERVICES=>GUI_DOWNLOAD", {fn: "abap.FrontendDownload", args: ["FILENAME:string", "FILETYPE:string", "BIN_FILESIZE:i", "WRITE_LF:c", "APPEND:c", "DATA_TAB:data"]}],
  ["CL_GUI_FRONTEND_SERVICES=>FILE_OPEN_DIALOG", {fn: "abap.FrontendFileOpenDialog", args: ["WINDOW_TITLE:string", "DEFAULT_FILENAME:string", "FILE_FILTER:string", "DEFAULT_EXTENSION:string", "INITIAL_DIRECTORY:string", "MULTISELECTION:c", "&FILE_TABLE:table", "&RC:i", "&USER_ACTION:i"]}],
  ["CL_GUI_FRONTEND_SERVICES=>FILE_SAVE_DIALOG", {fn: "abap.FrontendFileSaveDialog", args: ["WINDOW_TITLE:string", "DEFAULT_FILE_NAME:string", "FILE_FILTER:string", "DEFAULT_EXTENSION:string", "INITIAL_DIRECTORY:string", "PROMPT_ON_OVERWRITE:c", "&FILENAME:string", "&PATH:string", "&FULLPATH:string", "&USER_ACTION:i"]}],
  ["CL_GUI_FRONTEND_SERVICES=>DIRECTORY_BROWSE", {fn: "abap.FrontendDirectoryBrowse", args: ["WINDOW_TITLE:string", "INITIAL_FOLDER:string", "&SELECTED_FOLDER:string"]}],
  ["ZCL_OSABAP_RUNTIME=>GETENV", {fn: "abap.FrontendGetenv", args: ["NAME:string"]}],
]);

/*
 * The kernel lines of the ICF shim (express-icf-shim's cl_express_icf_shim,
 * WRITE '@KERNEL ...' JavaScript on Node) as host functions of the Go
 * runtime (go/abap/icf.go); the ABAP around them compiles as it is. Keyed
 * by method and the line's text. INPUT.req and INPUT.res are the method's
 * REQ and RES, which the host binds to its exchange (abap.ICFExchange);
 * INPUT.class travels in that exchange too. An argument is a name, a
 * component (LS_FIELD-NAME), "&" before a place the function writes, and
 * ":kind" the type it must have. A line of the shim not listed here stays
 * a stub that dumps, as every other @KERNEL line does.
 *   {fn, args}            one statement
 *   {loop, args, binds}   a JavaScript for (...) { over what fn returns,
 *                         each pair written to the binds; its body is the
 *                         statements up to the line {end}
 *   {bound}               a line of that loop whose work the binds do
 */
/** @type {Map<string, import("./frontend-types.ts").KernelSpec>} */ const KERNEL = new Map([
  // ADT capability answers match Node's parent kernel / non-one-runtime host.
  ["ZCL_OSD_ADT_HOST=>ONE_RUNTIME|rv_on.set(abap.context.RFCDestinations.STORE?.localSystem ? \"X\" : \"\");", {fn: "abap.ADTOneRuntime", args: ["&RV_ON:c"]}],
  ["ZCL_OSD_KERNEL_GUARD=>HAS_SERVING_DATABASE|if (globalThis.__osdAdtKernel !== undefined) rv_available.set(\" \");", {fn: "abap.ADTUnavailable", args: ["&RV_AVAILABLE:c"]}],
  ["ZCL_OSD_KERNEL_GUARD=>HAS_GENERATION|if (globalThis.__osdAdtKernel !== undefined || !((typeof process !== \"undefined\" && process.env?.OSD_ADT_ONE_RUNTIME === \"1\") || abap.context.RFCDestinations.STORE?.oneRuntimeEnabled?.() === true)) rv_available.set(\" \");", {fn: "abap.ADTUnavailable", args: ["&RV_AVAILABLE:c"]}],
  // CALL_CLASSRUN's try/catch needs an exception boundary and a caught host
  // error; fn/loop/bound/end cannot express those, so its lines stay refused.
  // the class name of an object as the transpiler runtime names it (go/classname)
  ["CL_ABAP_CLASSDESCR=>GET_CLASS_NAME|lv_name.set(p_object.get().constructor.INTERNAL_NAME);", {fn: "classname.Internal", args: ["P_OBJECT:ref", "&LV_NAME:string"]}],
  ["CL_EXPRESS_ICF_SHIM=>RUN|lv_classname.set(INPUT.class);", {fn: "abap.ICFClass", args: ["REQ:data", "&LV_CLASSNAME:string"]}],
  ["CL_EXPRESS_ICF_SHIM=>REQUEST|lv_xstr.set(INPUT.req.body.toString(\"hex\").toUpperCase());", {fn: "abap.ICFRequestBody", args: ["REQ:data", "&LV_XSTR:xstring"]}],
  ["CL_EXPRESS_ICF_SHIM=>REQUEST|lv_str.set(INPUT.req.method);", {fn: "abap.ICFRequestMethod", args: ["REQ:data", "&LV_STR:string"]}],
  ["CL_EXPRESS_ICF_SHIM=>REQUEST|for (const h in INPUT.req.headers) {", {loop: "abap.ICFRequestHeaders", args: ["REQ:data"], binds: ["LV_NAME", "LV_VALUE"]}],
  ["CL_EXPRESS_ICF_SHIM=>REQUEST|lv_name.set(h);", {bound: "LV_NAME"}],
  ["CL_EXPRESS_ICF_SHIM=>REQUEST|lv_value.set(INPUT.req.headers[h]);", {bound: "LV_VALUE"}],
  ["CL_EXPRESS_ICF_SHIM=>REQUEST|}", {end: true}],
  ["CL_EXPRESS_ICF_SHIM=>REQUEST|lv_value.set(INPUT.req.url);", {fn: "abap.ICFRequestURL", args: ["REQ:data", "&LV_VALUE:string"]}],
  ["CL_EXPRESS_ICF_SHIM=>REQUEST|lv_value.set(INPUT.req.path);", {fn: "abap.ICFRequestPath", args: ["REQ:data", "&LV_VALUE:string"]}],
  ["CL_EXPRESS_ICF_SHIM=>RESPONSE|INPUT.res.append(ls_field.get().name.get(), ls_field.get().value.get());", {fn: "abap.ICFResponseAppend", args: ["RES:data", "LS_FIELD-NAME:string", "LS_FIELD-VALUE:string"]}],
  ["CL_EXPRESS_ICF_SHIM=>RESPONSE|INPUT.res.status(lv_code.get()).send(Buffer.from(lv_xstr.get(), \"hex\"));", {fn: "abap.ICFResponseSend", args: ["RES:data", "LV_CODE:i", "LV_XSTR:xstring"]}],
  // ultra/httpc: open-abap-core's CL_HTTP_CLIENT sends with Node's http /
  // https modules (go/abap/httpc.go). `headers` and `response` are the
  // JavaScript locals of SEND; here they live with the client object (ME).
  // The lines that import the modules, declare postData and pick the agent
  // are nops: HTTPCSend does all of that
  ...[
    ["let headers = {};", {fn: "abap.HTTPCHeadersNew", args: ["ME:ref"]}],
    ["headers[ls_field.get().name.get()] = ls_field.get().value.get();", {fn: "abap.HTTPCHeader", args: ["ME:ref", "LS_FIELD-NAME:string", "LS_FIELD-VALUE:string"]}],
    ["headers[\"content-type\"] = lv_content_type.get();", {fn: "abap.HTTPCContentType", args: ["ME:ref", "LV_CONTENT_TYPE:string"]}],
    ["headers[\"accept-encoding\"] = \"gzip\";", {fn: "abap.HTTPCAcceptGzip", args: ["ME:ref"]}],
    ["headers[\"content-length\"] = lv_body.get().length;", {fn: "abap.HTTPCContentLength", args: ["ME:ref", "LV_BODY:string"]}],
    ...[
      "const https = await import(\"https\");",
      "const http = await import(\"http\");",
      "function postData(url, options, requestBody) {",
      "return new Promise((resolve, reject) => {",
      "const prot = url.startsWith(\"http://\") ? http : https;",
      "const req = prot.request(url, options,",
      "(res) => {",
      "let chunks = [];",
      "res.on(\"data\", (chunk) => {chunks.push(chunk);});",
      "res.on(\"error\", reject);",
      "res.on(\"end\", () => {",
      "resolve({statusCode: res.statusCode, headers: res.headers, body: Buffer.concat(chunks)});",
      "});",
      "req.on(\"error\", reject);",
      "req.write(requestBody, \"binary\");",
      "req.end();",
      "const prot = lv_url.get().startsWith(\"http://\") ? http : https;",
      "if (this.agent === undefined) {this.agent = new prot.Agent({keepAlive: true, maxSockets: 1});}",
    ].map((line) => [line, {nop: true}]),
    ["let response = await postData(lv_url.get(), {method: lv_method.get(), headers: headers, agent: this.agent}, lv_body.get());",
      {fn: "abap.HTTPCSend", args: ["ME:ref", "LV_URL:string", "LV_METHOD:string", "LV_BODY:string"]}],
    // Node gives set-cookie as an array, which the loop skips: HTTPCResponseHeaders leaves it out
    ["for (const h in response.headers) {", {loop: "abap.HTTPCResponseHeaders", args: ["ME:ref"], binds: ["LV_NAME", "LV_VALUE"]}],
    ["lv_name.set(h);", {bound: "LV_NAME"}],
    ["if (Array.isArray(response.headers[h])) continue;", {bound: "LV_NAME"}],
    ["lv_value.set(response.headers[h]);", {bound: "LV_VALUE"}],
    // the same text closes postData above the loop, a nop there
    ["}", {end: true, nop: true}],
    ["lo_entity.get().mv_content_type.set(response.headers[\"content-type\"] || \"\");", {fn: "abap.HTTPCResponseContentType", args: ["ME:ref", "&LO_ENTITY->MV_CONTENT_TYPE:string"]}],
    ["lo_entity.get().mv_status.set(response.statusCode);", {fn: "abap.HTTPCResponseStatus", args: ["ME:ref", "&LO_ENTITY->MV_STATUS:i"]}],
    ["lo_entity.get().mv_data.set(response.body.toString(\"hex\").toUpperCase());", {fn: "abap.HTTPCResponseBody", args: ["ME:ref", "&LO_ENTITY->MV_DATA:xstring"]}],
  ].map(([line, k]) => [`CL_HTTP_CLIENT=>IF_HTTP_CLIENT~SEND|${line}`, k]),
]);

/** the line of a WRITE '@KERNEL ...' as the JavaScript it holds, else undefined */
/** @param {import("./frontend-types.ts").SyntaxNode} node @returns {string | undefined} */ function kernelText(node) {
  if (!(node instanceof Nodes.StatementNode) || !isStmt(node, Statements.Write)) return undefined;
  const m = /^WRITE\s+'@KERNEL(.*)'\s*\.?$/is.exec(node.concatTokens());
  return m === null ? undefined : m[1].replace(/''/g, "'").trim();
}

/** @param {import("./frontend-types.ts").SyntaxNode} node @param {import("./frontend-types.ts").MethodContext} ctx @returns {import("./frontend-types.ts").KernelSpec | undefined} */ function kernelOf(node, ctx) {
  const text = kernelText(node);
  return text === undefined ? undefined : KERNEL.get(`${ctx.className}=>${ctx.method}|${text}`);
}

/** the arguments of a host function (see KERNEL), resolved in the method */
/** @param {readonly string[]} specs @param {import("./frontend-types.ts").VariableContext} ctx @returns {import("./frontend-types.ts").NativeArgument[]} */ function nativeArgs(specs, ctx) {
  return specs.map((spec) => {
    const m = /^(&?)([\w\/~]+)(?:(->|-)([\w]+))?:(\w+)$/.exec(spec);
    if (m === null) throw new Error(`host function argument ${spec}`);
    const [, ref, name, sel, comp, kind] = m;
    let value = variable(name, ctx);
    if (sel === "->") {
      // an attribute of the object a reference points to (LO_ENTITY->MV_DATA)
      value = refAttribute(value, {concatTokens: () => comp}, ctx, ref === "&");
    } else if (sel === "-") {
      const f = fieldOf(ctx, value.type, comp, `${ctx.className}=>${ctx.method}`);
      value = {e: "field", base: value, name: f.name, type: f.type};
    }
    if (value.type.k !== kind) throw new Unsupported(`host function argument ${spec} is a ${value.type.k}`);
    return {ref: m[1] === "&", value};
  });
}

/*
 * AMC on the Go host (go/amc, docs/abap-daemons.md): the methods
 * open-abap-apc leaves to a host -- CL_AMC_CHANNEL_MANAGER's statics, the
 * producer's SENDs, the consumer's START/STOP -- are bodies that call the
 * broker, as tools/osd-amc.mjs patches them on Node. A refusal comes back as
 * text and is raised as CX_AMC_ERROR with that reason, the way the Node host
 * raises it. Who is calling is decided when the program is compiled: every
 * method of a class whose source names the AMC API enters its class pool on
 * the session while it runs (amcProgram below), where Node reads the class
 * off the call stack.
 */
const AMC_HOST = new Map([
  ["CL_AMC_CHANNEL_MANAGER=>CREATE_MESSAGE_PRODUCER", {op: "create_producer", cls: "ZCL_AMC_PRODUCER",
    args: {APP: "I_APPLICATION_ID", PATH: "I_CHANNEL_ID", EXT: "I_CHANNEL_EXTENSION_ID", COMM: "I_COMMUNICATION_TYPE", ECHO: "I_SUPPRESS_ECHO"}}],
  ["CL_AMC_CHANNEL_MANAGER=>CREATE_MESSAGE_CONSUMER", {op: "create_consumer", cls: "ZCL_AMC_CONSUMER",
    args: {APP: "I_APPLICATION_ID", PATH: "I_CHANNEL_ID", EXT: "I_CHANNEL_EXTENSION_ID"}}],
  ["CL_AMC_CHANNEL_MANAGER=>GET_CONSUMER_SESSION_ID", {op: "session_id", args: {}}],
  ["ZCL_AMC_PRODUCER=>IF_AMC_MESSAGE_PRODUCER_TEXT~SEND", {op: "send", type: "TEXT", args: {MESSAGE: "I_MESSAGE"}}],
  ["ZCL_AMC_PRODUCER=>IF_AMC_MESSAGE_PRODUCER_BINARY~SEND", {op: "send", type: "BINARY", args: {MESSAGE: "I_MESSAGE"}}],
  ["ZCL_AMC_PRODUCER=>IF_AMC_MESSAGE_PRODUCER_PCP~SEND", {op: "send", type: "PCP", args: {MESSAGE: "I_MESSAGE"}}],
  ["ZCL_AMC_CONSUMER=>IF_AMC_MESSAGE_CONSUMER~START_MESSAGE_DELIVERY", {op: "start", args: {RECEIVER: "I_RECEIVER"}}],
  ["ZCL_AMC_CONSUMER=>IF_AMC_MESSAGE_CONSUMER~STOP_MESSAGE_DELIVERY", {op: "stop", args: {RECEIVER: "I_RECEIVER"}}],
]);
// a class whose source names one of these calls the AMC API
const AMC_CALLER = /\b(CL_AMC_CHANNEL_MANAGER|IF_AMC_MESSAGE_PRODUCER\w*|IF_AMC_MESSAGE_CONSUMER)\b/i;
// the program the SAMC authorities name: a class's class pool
const amcProgramOf = (cls) => upper(cls).padEnd(30, "=") + "CP";

/** the body of an AMC host method, and CX_AMC_ERROR for its refusals */
function amcMethod(spec, ctx) {
  const args = Object.fromEntries(Object.entries(spec.args).map(([k, n]) => [k, variable(n, ctx)]));
  const err = {e: "var", name: "LV_AMC_ERROR", type: S};
  const sig = constructorSignature(ctx, "CX_AMC_ERROR");
  const ctorArgs = sig.map((p) => {
    if (p.suppliedOf) return {dir: "importing", byValue: true, type: p.type, value: {e: "chars", value: p.suppliedOf === "IV_REASON" ? "X" : "", type: p.type}};
    if (p.name === "IV_REASON") return {name: p.name, dir: "importing", byValue: p.byValue, type: p.type, value: convert(err, p.type)};
    if (p.default !== undefined) return {name: p.name, supplied: false, dir: "importing", byValue: p.byValue, type: p.type, value: defaultValue(p, ctx)};
    return {name: p.name, supplied: false, dir: "importing", byValue: p.byValue, type: p.type, value: {e: "zero", type: p.type}};
  });
  const raise = {s: "raise", value: {e: "new", cls: "CX_AMC_ERROR", args: ctorArgs, type: {k: "ref", name: "CX_AMC_ERROR"}}, cls: "CX_AMC_ERROR"};
  return {s: "amc", op: spec.op, cls: spec.cls, type: spec.type, args, err, raise};
}

/**
 * Function modules whose work is the host's: the kernel services of a
 * system that open-abap-core writes as '@KERNEL' JavaScript, called with
 * CALL FUNCTION '<literal>'. Each maps its formal parameters to the side
 * they are passed from (exporting: the caller's EXPORTING, importing: the
 * caller's IMPORTING, tables) and names the host function, which takes
 * every actual parameter as generic data and raises the module's classic
 * exceptions by name. A parameter the map does not name, a DESTINATION, an
 * IN UPDATE TASK or a name that is not a literal is refused.
 *
 * WWWDATA_IMPORT and SCMS_BINARY_TO_XSTRING are SMW0's (go/abap/w3mi.go),
 * their rules measured on A4H 2026-09-23 (ZCL_GOGEN_T_W3MI in semantics.mjs).
 */
const NATIVE_FM = new Map([
  ["F4_FILENAME", {fn: "abap.F4_FILENAME", params: {PROGRAM_NAME: "exporting", DYNPRO_NUMBER: "exporting", FIELD_NAME: "exporting", FILE_NAME: "importing"}}],
  ["KD_GET_FILENAME_ON_F4", {fn: "abap.KD_GET_FILENAME_ON_F4", params: {PROGRAM_NAME: "exporting", DYNPRO_NUMBER: "exporting", FIELD_NAME: "exporting", MASK: "exporting", STATIC: "exporting", FILE_NAME: "changing"}}],
  ["WWWDATA_IMPORT", {fn: "abap.WWWDATA_IMPORT", params: {KEY: "exporting", MIME: "tables"}}],
  ["SCMS_BINARY_TO_XSTRING", {fn: "abap.SCMS_BINARY_TO_XSTRING",
    params: {INPUT_LENGTH: "exporting", FIRST_LINE: "exporting", LAST_LINE: "exporting", BUFFER: "importing", BINARY_TAB: "tables"}}],
]);

/**
 * Function modules a DESTINATION of the host answers, by destination and
 * name: the Node host installs the same destinations in test/setup.mjs.
 * 'STORE' is the object store over the files of the tree
 * (tools/osd-store-destination.mjs on Node, go/abap/store.go here): the
 * editor screen's LIST READ WRITE, and CHECK ACTIVATE TOKENS answered as
 * work this binary has no compiler for. The signature is ZOSD_STORE's
 * (src/webgui/zosd_store.fugr.xml).
 */
const DESTINATION_FM = new Map([
  ["STORE ZOSD_STORE", {fn: "abap.ZOSD_STORE", params: {
    IV_COMMAND: "exporting", IV_TYPE: "exporting", IV_NAME: "exporting", IV_INCLUDE: "exporting",
    IV_SOURCE: "exporting", IV_FILTER: "exporting", IV_LIMIT: "exporting", IV_REVISION: "exporting", IV_JSON: "exporting",
    EV_SOURCE: "importing", EV_FILE: "importing", EV_PACKAGE: "importing", EV_VERSION: "importing",
    EV_WRITABLE: "importing", EV_ACTIVE: "importing", EV_LIVE: "importing", EV_NOTE: "importing",
    EV_COUNT: "importing", EV_MS: "importing", EV_ERROR: "importing", EV_JSON: "importing", EV_STATE: "importing", EV_CHANGED: "importing",
    ET_OBJECT: "tables", ET_ISSUE: "tables", ET_TYPE: "tables", ET_TOKEN: "tables", ET_REVISION: "tables"}}],
]);

/**
 * instance methods of the kernel whose ABAP signature is generic (TYPE
 * simple, xsequence), so the subset cannot type them: the host function
 * does the work and receives the object (me) first, and the signature it
 * is called with is written here. A caller whose argument does not fit the
 * written type is refused by the ordinary conversion rules.
 * UTF-8 / UTF-16LE text <-> bytes: cl_abap_conv_out_ce / cl_abap_conv_in_ce.
 */
/** @type {Map<string, import("./frontend-types.ts").NativeMe>} */ const NATIVE_ME = new Map([
  ["CL_ABAP_CONV_OUT_CE=>CONVERT", {fn: "Native_CONV_OUT_CONVERT", params: [["DATA", "importing", "string"], ["N", "importing", "i", true], ["BUFFER", "exporting", "xstring"]]}],
  ["CL_ABAP_CONV_IN_CE=>CONVERT", {fn: "Native_CONV_IN_CONVERT", params: [["INPUT", "importing", "xstring"], ["N", "importing", "i", true], ["DATA", "exporting", "string"]]}],
]);
/** @param {import("./frontend-types.ts").FrontendProgram} program @param {string} key @param {string} name @returns {import("./frontend-types.ts").Signature} */ const nativeMeSig = (program, key, name) => {
  const n = NATIVE_ME.get(key);
  const T = {string: S, xstring: XS, i: I};
  const own = n.params.map(([pn, dir, t, optional]) => ({name: pn, dir, byValue: false, type: T[t], optional: optional === true}));
  return {name, static: false, private: false, abstract: false, params: withSupplied(program, key, own), returning: null};
};

/*
 * TRY / CATCH, the part a runtime can honour today: the exceptions the
 * runtime itself raises (arithmetic, conversion, table line, offset). Which
 * of them a CATCH covers is decided here, by the class hierarchy abaplint
 * knows. Exception objects of compiled classes (RAISE EXCEPTION) are taken
 * by the class hierarchy at run time; see tryBlock.
 */
const RUNTIME_CX = ["CX_SY_ZERODIVIDE", "CX_SY_ARITHMETIC_OVERFLOW", "CX_SY_CONVERSION_NO_NUMBER", "CX_SY_CONVERSION_OVERFLOW",
  "CX_SY_ITAB_LINE_NOT_FOUND", "CX_SY_RANGE_OUT_OF_BOUNDS", "CX_SY_ARG_OUT_OF_DOMAIN",
  "CX_SY_CREATE_OBJECT_ERROR", "CX_SY_CREATE_DATA_ERROR", "CX_SY_MOVE_CAST_ERROR", "CX_SY_DYN_CALL_ILLEGAL_CLASS", "CX_SY_DYN_CALL_ILLEGAL_METHOD",
  "CX_SY_DYN_CALL_PARAM_MISSING", "CX_SY_DYN_CALL_PARAM_NOT_FOUND",
  // the string functions (repeat( ) replace( ): a parameter out of range)
  "CX_SY_STRG_PAR_VAL",
  // REPLACE ALL OCCURRENCES OF an empty pattern; open-abap-core has no such
  // class, so its superclass is written down below as A4H defines it
  "CX_SY_REPLACE_INFINITE_LOOP",
  // the ICF entity's get_cdata over bytes that are not UTF-8 (abap.ICFGetCData)
  "CX_SY_CONVERSION_CODEPAGE",
  // Open SQL (go/abap/select.go, dbwrite.go, ranges.go): a database error
  // and INSERT FROM TABLE with a duplicate key; a range value longer than
  // its column; a CP pattern past twice the column (tools/ir-ranges.mjs)
  "CX_SY_OPEN_SQL_DB", "CX_SY_OPEN_SQL_DATA_ERROR", "CX_SY_DYNAMIC_OSQL_SEMANTICS",
  // a dynamic WHERE A4H refused (go/abap osqlwhere.go, tools/ir-osql-where.mjs)
  "CX_SY_DYNAMIC_OSQL_SYNTAX",
  // CALL FUNCTION ... DESTINATION 'AMDP' on a host without HANA (callFunction)
  "CX_SY_DYN_CALL_ILLEGAL_FUNC",
  // the DATASET statements (go/abap/dataset.go): READ or TRANSFER on a file
  // not open, TRANSFER on one opened FOR INPUT; OPEN of an open file
  "CX_SY_FILE_OPEN_MODE", "CX_SY_FILE_OPEN"];
// the superclass of a runtime exception the registry does not hold, read
// off A4H (CX_SY_REPLACE_INFINITE_LOOP inheriting from CX_DYNAMIC_CHECK), and
// CX_SY_OPEN_SQL_DATA_ERROR from CX_SY_OPEN_SQL_ERROR (its definition on
// A4H, 2026-09-23)
const RUNTIME_CX_SUPER = {CX_SY_REPLACE_INFINITE_LOOP: "CX_DYNAMIC_CHECK", CX_SY_OPEN_SQL_DATA_ERROR: "CX_SY_OPEN_SQL_ERROR"};

export {TRANSPILER_MEANING, P_GENERIC, NATIVE, kernelOf, nativeArgs, AMC_HOST, AMC_CALLER, amcProgramOf, amcMethod, NATIVE_FM, DESTINATION_FM, NATIVE_ME, nativeMeSig, RUNTIME_CX, RUNTIME_CX_SUPER};
