// Style: abapiti-friendly erasable TypeScript, https://github.com/oisee/abapiti/blob/main/docs/ts-style.md
// One absence value per field, except documented frontend shapes awaiting phase 2.
// The frontend IR contract. Numeric lengths, offsets, rows and counts are integers.
// Readonly describes nodes after lowering; Program's compilation state remains mutable.
import type * as abaplint from '@abaplint/core';

export interface Field { readonly name: string; readonly type: Type }
export interface SecondaryKey { readonly name: string; readonly comps: readonly string[]; readonly sorted?: boolean; readonly hashed?: boolean; readonly unique?: boolean }
export interface Argument { readonly name?: string; readonly dir?: 'importing' | 'exporting' | 'changing'; readonly byValue?: boolean; readonly type?: Type; readonly value?: Expr;
    // two absence values today: null at frontend.mjs:6336, omitted at 6321; phase 2 normalises
    readonly place?: Expr | null; readonly wrap?: Expr; readonly supplied?: boolean; readonly fitc?: number }
export interface ExceptionCase { readonly name: string; readonly code: number }
export interface Where { readonly name?: string; readonly fx?: Expr; readonly ftype?: Type; readonly op: string; readonly value?: Expr; readonly calc?: Type }
export interface SortKey { readonly name?: string; readonly line?: boolean; readonly desc?: boolean; readonly type: Type }
export interface TableKey { readonly name?: string; readonly line?: boolean; readonly value: Expr }
// Loop tokens are opaque identity objects, compared by identity rather than read.
export type LoopToken = object;

export type Type = TypeMetadata & (
  | { readonly k: 'i' }
  | { readonly k: 'f' }
  | { readonly k: 'int8' }
  | { readonly k: 'p'; readonly len: number; readonly dec: number; readonly calc?: boolean }
  | { readonly k: 'string' }
  | { readonly k: 'c'; readonly len: number }
  | { readonly k: 'x'; readonly len: number }
  | { readonly k: 'xstring' }
  | { readonly k: 'exc' }
  | { readonly k: 'table'; readonly row: Type; readonly stable?: boolean; readonly skey?: string | readonly string[]; readonly secondary?: readonly SecondaryKey[]; readonly hashed?: readonly string[]; readonly sorted?: readonly string[]; readonly unique?: boolean }
  | { readonly k: 'data'; readonly table?: boolean; readonly numeric?: boolean }
  | { readonly k: 'ref'; readonly name: string; readonly intf?: boolean }
  | { readonly k: 'void' }
  | { readonly k: 'dref'; readonly to?: Type }
  | { readonly k: 'd'; readonly len?: number }
  | { readonly k: 't'; readonly len?: number }
  | { readonly k: 'n'; readonly len: number }
  | { readonly k: 'struct'; readonly go: string; readonly fields?: readonly Field[]; readonly shape?: string; readonly qname?: string }
  | { readonly k: 'bool' });

export type Expr = ExprMetadata & (
  | { readonly e: 'field'; readonly base: Expr; readonly name: string; readonly type: Type }
  | { readonly e: 'var'; readonly name: string; readonly type: Type; readonly ref?: boolean; readonly box?: boolean }
  | { readonly e: 'chars'; readonly value: string; readonly type: Type }
  | { readonly e: 'zero'; readonly type: Type }
  | { readonly e: 'new'; readonly cls: string; readonly args: readonly Argument[]; readonly type: Type }
  | { readonly e: 'wrap'; readonly x: Expr; readonly type: Type }
  | { readonly e: 'call'; readonly method: string; readonly static: boolean; readonly owner: string | null;
    // two absence values today: null at frontend.mjs:1233, omitted at 6373; phase 2 normalises
    readonly receiver?: Expr | null;
    // two absence values today: null at frontend.mjs:1233, omitted at 6373; phase 2 normalises
    readonly sup?: string | null; readonly args: readonly Argument[]; readonly type: Type;
    // two absence values today: null at frontend.mjs:5817, omitted at 6373; phase 2 normalises
    readonly exceptions?: Exceptions | null;
    // two absence values today: null at frontend.mjs:1233, omitted at 6373; phase 2 normalises
    readonly receiving?: Expr | null; readonly callee: string }
  | { readonly e: 'sy'; readonly field: string; readonly type: Type }
  | { readonly e: 'int'; readonly value: number; readonly type: Type }
  | { readonly e: 'temp'; readonly name: string; readonly type: Type }
  | { readonly e: 'lrow'; readonly type: Type }
  | { readonly e: 'bool'; readonly cond: Condition; readonly blank: string; readonly type: Type }
  | { readonly e: 'fs'; readonly name: string; readonly type: Type }
  | { readonly e: 'bin'; readonly op: string; readonly l: Expr; readonly r: Expr; readonly type: Type }
  | { readonly e: 'padc'; readonly x: Expr; readonly n: number; readonly type: Type }
  | { readonly e: 'str'; readonly value: string; readonly type: Type }
  | { readonly e: 'flag'; readonly value: boolean; readonly type?: Type }
  | { readonly e: 'refattr'; readonly base: Expr; readonly name: string; readonly type: Type }
  | { readonly e: 'str_fn'; readonly fn: string; readonly args: readonly Expr[]; readonly type: Type }
  | { readonly e: 'xbytes'; readonly value: string; readonly type: Type }
  | { readonly e: 'me'; readonly type: Type }
  | { readonly e: 'const'; readonly go: string; readonly type: Type }
  | { readonly e: 'attr'; readonly name: string; readonly type: Type }
  | { readonly e: 'substr_target'; readonly base: Expr; readonly off: Expr | null; readonly len: Expr | null; readonly type: Type }
  | { readonly e: 'dref_field'; readonly base: Expr; readonly name: string; readonly type: Type; readonly struct: Type }
  | { readonly e: 'row'; readonly base: Expr; readonly index: Expr; readonly type: Type }
  | { readonly e: 'row_key'; readonly base: Expr; readonly keys: readonly TableKey[]; readonly type: Type }
  | { readonly e: 'type_length'; readonly x: Expr; readonly type: Type }
  | { readonly e: 'type_kind'; readonly x: Expr; readonly type: Type }
  | { readonly e: 'date_add'; readonly date: Expr; readonly days: Expr; readonly subtract: boolean; readonly type: Type }
  | { readonly e: 'gen_arith'; readonly statics: string; readonly charTarget: boolean; readonly target: Expr | null; readonly leaves: readonly Expr[]; readonly branches: ArithmeticBranches; readonly text: string; readonly type: Type }
  | { readonly e: 'concat'; readonly l: Expr; readonly r: Expr; readonly type: Type }
  | { readonly e: 'neg'; readonly x: Expr; readonly type: Type }
  | { readonly e: 'sy_mandt'; readonly type: Type }
  | { readonly e: 'sy_host'; readonly name: string; readonly type: Type }
  | { readonly e: 'substr'; readonly x: Expr; readonly off: Expr | null; readonly len: Expr | null; readonly base: Type; readonly type: Type }
  | { readonly e: 'table_map'; readonly from: Expr | null; readonly row: Expr; readonly value: Expr; readonly type: Type }
  | { readonly e: 'struct'; readonly fields: readonly { readonly name: string; readonly value: Expr }[]; readonly type: Type }
  | { readonly e: 'cond'; readonly branches: readonly { readonly cond: Condition; readonly value: Expr }[]; readonly else: Expr; readonly type: Type }
  | { readonly e: 'fae_row'; readonly n: number; readonly type: Type }
  | { readonly e: 'strlist'; readonly values: readonly string[] }
  | { readonly e: 'ev_sender'; readonly type: Type }
  | { readonly e: 'ev_arg'; readonly name: string; readonly type: Type }
  | { readonly e: 'ev_handler'; readonly type: Type }
  | { readonly e: 'table_lit'; readonly rows: readonly Expr[]; readonly type: Type }
  | { readonly e: 'sorted_move'; readonly x: Expr; readonly keys: readonly string[]; readonly unique: boolean; readonly type: Type }
  | { readonly e: 'template'; readonly parts: readonly TemplatePart[]; readonly type: Type }
  | { readonly e: 'exc_text'; readonly x: Expr; readonly type: Type }
  | { readonly e: 'exc_class'; readonly x: Expr; readonly type: Type }
  | { readonly e: 'random'; readonly min: Expr; readonly max: Expr | null; readonly type: Type }
  | { readonly e: 'lines_data'; readonly x: Expr; readonly type: Type }
  | { readonly e: 'lines'; readonly table: Expr; readonly type: Type }
  | { readonly e: 'case_fn'; readonly upper: boolean; readonly x: Expr; readonly type: Type }
  | { readonly e: 'strlen'; readonly x: Expr; readonly type: Type }
  | { readonly e: 'reverse'; readonly x: Expr; readonly type: Type }
  | { readonly e: 'find_occ'; readonly val: Expr; readonly sub: Expr; readonly occ: Expr; readonly type: Type }
  | { readonly e: 'find'; readonly val: Expr; readonly sub: Expr; readonly off: Expr | null; readonly type: Type }
  | { readonly e: 'xstrlen'; readonly x: Expr; readonly type: Type }
  | { readonly e: 'uccp'; readonly x: Expr; readonly type: Type }
  | { readonly e: 'uccpi'; readonly x: Expr; readonly type: Type }
  | { readonly e: 'utf16unit'; readonly x: Expr; readonly type: Type }
  | { readonly e: 'nop_call'; readonly type: Type }
  | { readonly e: 'unwrap_calc'; readonly x: Expr; readonly type: Type }
  | { readonly e: 'unwrap'; readonly x: Expr; readonly type: Type }
  | { readonly e: 'conv'; readonly kind: string; readonly from: Type; readonly to: Type; readonly x: Expr; readonly type: Type; readonly fields?: readonly { readonly name: string; readonly len: number }[]; readonly pairs?: readonly (readonly [string, string])[]; readonly row?: Expr }
  | { readonly e: 'upcast'; readonly x: Expr; readonly type: Type }
  | { readonly e: 'cast'; readonly x: Expr; readonly type: Type }
  | { readonly e: 'unwrap_chars'; readonly x: Expr; readonly type: Type }
  | { readonly e: 'static'; readonly owner: string; readonly name: string; readonly type: Type; readonly go: string }
  | { readonly e: 'fn'; readonly name: string; readonly args: readonly Expr[]; readonly type: Type });

export type Stmt =
  | { readonly s: 'note_update_task' }
  | { readonly s: 'raise'; readonly value: Expr; readonly cls: string | null }
  | { readonly s: 'amc'; readonly op: string; readonly cls: string | undefined; readonly type: string | undefined; readonly args: Readonly<Record<string, Expr>>; readonly err: Expr; readonly raise: Stmt }
  | { readonly s: 'raise_runtime'; readonly cls: string; readonly op: string }
  | { readonly s: 'call_fm'; readonly name: string; readonly fn: string; readonly args: readonly Argument[]; readonly exceptions: Exceptions | null }
  | { readonly s: 'call_enq'; readonly kind: string; readonly name: string; readonly args: readonly Argument[]; readonly table?: string; readonly fields?: readonly string[]; readonly object?: string;
    // two absence values today: null at frontend.mjs:1104, omitted at 1093; phase 2 normalises
    readonly exceptions?: Exceptions | null }
  | { readonly s: 'assign'; readonly target: Expr; readonly value: Expr }
  | { readonly s: 'clear'; readonly target: Expr }
  | { readonly s: 'call'; readonly call: Expr }
  | { readonly s: 'if'; readonly branches: readonly { readonly cond: Condition; readonly body: readonly Stmt[] }[]; readonly else: readonly Stmt[] | null }
  | { readonly s: 'seq'; readonly body: readonly Stmt[] }
  | { readonly s: 'native'; readonly fn: string; readonly me?: boolean; readonly args?: readonly Argument[]; readonly stmt?: boolean }
  | { readonly s: 'stub'; readonly where: string; readonly reason: string; readonly pos: Position }
  | { readonly s: 'kernel_loop'; readonly fn: string; readonly args: readonly Argument[]; readonly binds: readonly Expr[]; readonly body: readonly Stmt[]; readonly pos: Position }
  | { readonly s: 'try'; readonly body: readonly Stmt[]; readonly catches: readonly Catch[]; readonly cleanup: readonly Stmt[] | null }
  | { readonly s: 'nop' }
  | { readonly s: 'case'; readonly temp: string; readonly subject: Expr; readonly branches: readonly { readonly cond: Condition; readonly body: readonly Stmt[] }[]; readonly else: readonly Stmt[] | null }
  | { readonly s: 'do'; readonly times: Expr | null; readonly body: readonly Stmt[] }
  | { readonly s: 'while'; readonly cond: Condition; readonly body: readonly Stmt[] }
  | { readonly s: 'loop_data'; readonly table: Expr; readonly fs: string | null; readonly fsType?: Type; readonly text?: string; readonly token: LoopToken; readonly body: readonly Stmt[] }
  | { readonly s: 'loop'; readonly table: Expr; readonly into: Expr | null; readonly fs: string | null; readonly where: readonly Where[] | null; readonly from: Expr | null; readonly to: Expr | null; readonly rowType: Type; readonly key?: ResolvedKey; readonly dynamicKeys?: { readonly value: Expr; readonly options: readonly ResolvedKey[] }; readonly token: LoopToken; readonly body: readonly Stmt[] }
  | { readonly s: 'unassign'; readonly fs: Expr }
  | { readonly s: 'get_ref'; readonly target: Expr; readonly value: Expr }
  | { readonly s: 'describe_kind'; readonly x: Expr; readonly target: Expr }
  | { readonly s: 'shift_places'; readonly target: Expr; readonly amount: Expr; readonly left: boolean; readonly circular: boolean }
  | { readonly s: 'shift_left_circ_bytes'; readonly target: Expr }
  | { readonly s: 'shift_left_leading'; readonly target: Expr; readonly mask: Expr; readonly maskLen: number }
  | { readonly s: 'shift_right_trailing'; readonly target: Expr; readonly mask: Expr; readonly maskLen: number }
  | { readonly s: 'concat_bytes'; readonly target: Expr; readonly table?: Expr; readonly row?: Expr; readonly parts?: readonly Expr[]; readonly fixed?: number }
  | { readonly s: 'condense'; readonly target: Expr; readonly noGaps: boolean }
  | { readonly s: 'assert'; readonly cond: Condition; readonly text: string }
  | { readonly s: 'set_data'; readonly target: Expr; readonly value: Expr }
  | { readonly s: 'append_lines'; readonly table: Expr; readonly src: Expr; readonly from: Expr | null; readonly to: Expr | null; readonly value: Expr }
  | { readonly s: 'append'; readonly table: Expr; readonly value: Expr; readonly refInto?: Expr; readonly fs?: string }
  | { readonly s: 'concat'; readonly target: Expr; readonly sep: Expr; readonly table?: Expr; readonly row?: Expr; readonly parts?: readonly Expr[] }
  | { readonly s: 'append_initial_data'; readonly table: Expr; readonly fs: string | null }
  | { readonly s: 'append_data'; readonly table: Expr; readonly value: Expr }
  | { readonly s: 'read_seckey'; readonly table: Expr; readonly key: ResolvedKey; readonly values: readonly Expr[]; readonly into: Expr | null; readonly fs: string | null; readonly refInto: boolean }
  | { readonly s: 'read_key'; readonly table: Expr; readonly keys: readonly TableKey[]; readonly into: Expr | null; readonly fs: string | null; readonly refInto: boolean; readonly hashed: boolean; readonly sorted: {readonly prefix: readonly number[]; readonly extra: boolean} | null }
  | { readonly s: 'read_index_data'; readonly table: Expr; readonly index: Expr; readonly fs: string | null }
  | { readonly s: 'read_index'; readonly table: Expr; readonly index: Expr; readonly fs?: string; readonly into?: Expr }
  | { readonly s: 'sort'; readonly table: Expr; readonly keys: readonly SortKey[] }
  | { readonly s: 'delete_adjacent'; readonly table: Expr; readonly fields: readonly string[] }
  | { readonly s: 'delete_where'; readonly table: Expr; readonly where: readonly Where[] }
  | { readonly s: 'delete_seckey'; readonly table: Expr; readonly key: ResolvedKey; readonly values: readonly Expr[] }
  | { readonly s: 'delete_key'; readonly table: Expr; readonly key: string; readonly value: Expr }
  | { readonly s: 'delete_from'; readonly table: Expr; readonly value: Expr; readonly keys: readonly string[] }
  | { readonly s: 'delete_range'; readonly table: Expr; readonly from: Expr | null; readonly to: Expr | null }
  | { readonly s: 'delete_current'; readonly table: Expr; readonly token: LoopToken }
  | { readonly s: 'delete_index_data'; readonly table: Expr; readonly tokens: readonly LoopToken[]; readonly index: Expr }
  | { readonly s: 'delete_index'; readonly table: Expr; readonly tokens: readonly LoopToken[]; readonly index: Expr }
  | { readonly s: 'insert_lines_sorted'; readonly table: Expr; readonly src: Expr; readonly keys: readonly SortKey[] }
  | { readonly s: 'insert_data'; readonly table: Expr; readonly value: Expr }
  | { readonly s: 'insert_sorted'; readonly table: Expr; readonly value: Expr; readonly keys: readonly SortKey[]; readonly refInto: Expr | null }
  | { readonly s: 'insert_table'; readonly table: Expr; readonly value: Expr; readonly unique: boolean; readonly keys: readonly string[] | null }
  | { readonly s: 'insert_index'; readonly table: Expr; readonly value: Expr; readonly index: Expr }
  | { readonly s: 'translate'; readonly target: Expr; readonly upper: boolean }
  | { readonly s: 'amc_wait'; readonly cond: Condition; readonly seconds: Expr }
  | { readonly s: 'get_runtime'; readonly target: Expr }
  | { readonly s: 'get_timestamp'; readonly target: Expr; readonly dec: number }
  | { readonly s: 'raise_classic'; readonly name: string; readonly method: string }
  | { readonly s: 'call_dyn_static'; readonly cls: string; readonly method: string; readonly args: readonly Argument[] }
  | { readonly s: 'exit' }
  | { readonly s: 'continue' }
  | { readonly s: 'return' }
  | { readonly s: 'check'; readonly cond: Condition }
  | { readonly s: 'modify_index'; readonly table: Expr; readonly index: Expr; readonly value: Expr }
  | { readonly s: 'find_all'; readonly regex: boolean; readonly pcre: boolean; readonly pattern: Expr; readonly icase: Expr; readonly subject: Expr; readonly count: Expr }
  | { readonly s: 'find'; readonly subject?: Expr; readonly table?: Expr;
    // two absence values today: null at frontend.mjs:3226, omitted at 3214; phase 2 normalises
    readonly secOff?: Expr | null;
    // two absence values today: null at frontend.mjs:3227, omitted at 3214; phase 2 normalises
    readonly secLen?: Expr | null; readonly regex: boolean; readonly pcre: boolean; readonly pattern: Expr; readonly icase: boolean; readonly subs: readonly {readonly target: Expr; readonly value: Expr}[]; readonly off: Expr | null; readonly len: Expr | null; readonly line?: Expr }
  | { readonly s: 'clear_data'; readonly target: Expr }
  | { readonly s: 'split'; readonly table: Expr; readonly x: Expr; readonly sep: Expr }
  | { readonly s: 'split_into'; readonly x: Expr; readonly sep: Expr; readonly lens: readonly number[]; readonly targets: readonly { readonly target: Expr; readonly value: Expr }[] }
  | { readonly s: 'move_corr_data'; readonly from: Expr | null; readonly to: Expr }
  | { readonly s: 'select_loop'; readonly table: string; readonly cols: readonly SqlColumn[]; readonly assign: readonly (SqlAssignment | null)[]; readonly target: Expr; readonly sql: string; readonly args: readonly SqlArgument[]; readonly preds: readonly SqlPredicate[]; readonly body: readonly Stmt[] }
  | { readonly s: 'select_table'; readonly table: string; readonly cols: readonly SqlColumn[]; readonly assign: readonly (SqlAssignment | null)[]; readonly target: Expr; readonly sql: string; readonly args: readonly SqlArgument[]; readonly preds: readonly SqlPredicate[]; readonly fae?: {readonly n: number; readonly table: Expr; readonly sql: string; readonly args: readonly SqlArgument[]; readonly preds: readonly SqlPredicate[]}; readonly appending?: boolean }
  | { readonly s: 'select_aggregate'; readonly table: string; readonly cols: readonly SqlColumn[]; readonly assign: readonly (SqlAssignment | null)[]; readonly target: Expr; readonly sql: string; readonly args: readonly SqlArgument[]; readonly preds: readonly SqlPredicate[] }
  | { readonly s: 'select_dyn'; readonly table: Expr; readonly fields: Expr; readonly where: Expr; readonly groupBy: Expr | null; readonly orderBy: Expr | null; readonly primaryKey: boolean; readonly corresponding: boolean; readonly target: Expr; readonly text: string }
  | { readonly s: 'select_count'; readonly table: string; readonly target: Expr; readonly sql: string; readonly args: readonly SqlArgument[]; readonly preds: readonly SqlPredicate[] }
  | { readonly s: 'select_sum'; readonly table: string; readonly target: Expr; readonly sql: string; readonly args: readonly SqlArgument[]; readonly preds: readonly SqlPredicate[] }
  | { readonly s: 'db_write_sql'; readonly verb: string; readonly table: string; readonly sql: string; readonly args: readonly SqlArgument[]; readonly preds: readonly SqlPredicate[] }
  | { readonly s: 'db_write'; readonly op: string; readonly table: string; readonly value: Expr; readonly fromTable: boolean; readonly onDuplicate: 'ignore' | 'raise' | 'error' | undefined; readonly cols: readonly WriteColumn[]; readonly key: readonly string[] }
  | { readonly s: 'select_single'; readonly table: string; readonly cols: readonly SqlColumn[]; readonly assign: readonly (SqlAssignment | null)[]; readonly target: Expr; readonly sql: string; readonly args: readonly SqlArgument[]; readonly preds: readonly SqlPredicate[] }
  | { readonly s: 'assign_deref_typed'; readonly fs: Expr; readonly ref: Expr; readonly text: string }
  | { readonly s: 'assign_comp'; readonly fs: Expr; readonly name: Expr; readonly from: Expr }
  | { readonly s: 'assign_deref'; readonly fs: Expr; readonly ref: Expr }
  | { readonly s: 'assign_data'; readonly fs: Expr; readonly value: Expr }
  | { readonly s: 'create_data_line'; readonly target: Expr; readonly table: Expr }
  | { readonly s: 'create_data'; readonly target: Expr; readonly type: Type }
  | { readonly s: 'create_data_dyn'; readonly target: Expr; readonly name: Expr; readonly table: boolean }
  | { readonly s: 'create_dyn'; readonly target: Expr; readonly name: Expr }
  | { readonly s: 'set_handler'; readonly handlers: readonly EventHandler[]; readonly forObj: Expr | null; readonly all: boolean; readonly static: boolean; readonly activation: Expr | null }
  | { readonly s: 'raise_event'; readonly event: string; readonly static: boolean; readonly sender: Expr | null; readonly args: readonly Argument[] }
  | { readonly s: 'dataset_open'; readonly name: Expr; readonly mode: string; readonly binary: boolean; readonly message: Expr | null; readonly position: Expr | null }
  | { readonly s: 'dataset_close'; readonly name: Expr }
  | { readonly s: 'dataset_delete'; readonly name: Expr }
  | { readonly s: 'dataset_transfer'; readonly src: Expr; readonly name: Expr; readonly length: Expr | null; readonly noEndOfLine: boolean }
  | { readonly s: 'dataset_read'; readonly name: Expr; readonly target: Expr; readonly max: Expr | null; readonly actual: Expr | null }
  | { readonly s: 'dataset_get_position'; readonly name: Expr; readonly position: Expr }
  | { readonly s: 'dataset_set_position'; readonly name: Expr; readonly position: Expr | null }
  | { readonly s: 'replace_bytes'; readonly target: Expr; readonly with: Expr; readonly off: Expr | null; readonly len: Expr | null }
  | { readonly s: 'replace_chars'; readonly target: Expr; readonly with: Expr; readonly off: Expr | null; readonly len: Expr | null }
  | { readonly s: 'replace'; readonly target: Expr; readonly pattern: Expr; readonly with: Expr; readonly regex: boolean; readonly pcre: boolean; readonly all: boolean; readonly icase: boolean; readonly off: Expr | null; readonly len: Expr | null; readonly cLen: number }
  | { readonly s: 'find_bytes_all'; readonly pattern: Expr; readonly subject: Expr; readonly count: Expr | null }
  | { readonly s: 'find_bytes'; readonly pattern: Expr; readonly subject: Expr; readonly secOff: Expr | null; readonly secLen: Expr | null; readonly off: Expr | null; readonly len: Expr | null }
  | { readonly s: 'commit_work' }
  | { readonly s: 'rollback_work' }
  | { readonly s: 'find_results'; readonly all: boolean; readonly bytes: boolean; readonly mode: '' | 'P' | 'R'; readonly pattern: Expr; readonly subject: Expr; readonly icase: boolean; readonly target: Expr; readonly table: boolean; readonly row: Type; readonly sub: Type; readonly f: FindFields;
    // two absence values today: null at frontend-bytes.mjs:59, omitted at frontend-find-results.ts:67; phase 2 normalises
    readonly count?: Expr | null };

export type Condition =
  | { readonly c: 'cp' | 'ca' | 'cs' | 'co'; readonly l: Expr; readonly r: Expr; readonly cpat: boolean; readonly csubject: boolean }
  | { readonly c: 'cmp'; readonly op: string; readonly l: Expr; readonly r: Expr; readonly type: Type }
  | { readonly c: 'or'; readonly l: Condition; readonly r: Condition }
  | { readonly c: 'not'; readonly x: Condition }
  | { readonly c: 'and'; readonly l: Condition; readonly r: Condition }
  | { readonly c: 'instance_of'; readonly x: Expr; readonly type: Type; readonly initial: boolean }
  | { readonly c: 'initial'; readonly x: Expr }
  | { readonly c: 'assigned'; readonly fs: Expr }
  | { readonly c: 'data_bound'; readonly x: Expr }
  | { readonly c: 'in_range'; readonly value: Expr; readonly range: Expr }
  | { readonly c: 'line_exists'; readonly table: Expr; readonly keys: readonly TableKey[] }
  | { readonly c: 'tableeq'; readonly op: string; readonly l: Expr; readonly r: Expr; readonly a: Expr; readonly b: Expr; readonly rowEq: Condition }
  | { readonly c: 'true' }
  | { readonly c: 'refeq'; readonly op: string; readonly l: Expr; readonly r: Expr }
  | { readonly c: 'num_data_cmp'; readonly op: string; readonly l: Expr; readonly r: Expr };

export interface Position { readonly file: string; readonly row: number }
export interface Param extends Field {
  readonly dir?: 'importing' | 'exporting' | 'changing'; readonly byValue?: boolean;
  readonly default?: string; readonly optional?: boolean; readonly suppliedOf?: string; readonly tables?: boolean;
}
export interface Method {
  readonly name: string; readonly params: readonly Param[];
  // two absence values today: null at frontend.mjs:1542, omitted at 1546; phase 2 normalises
  readonly returning?: Field | null;
  readonly static?: boolean; readonly private?: boolean; readonly abstract?: boolean;
  readonly locals?: readonly Field[]; readonly fieldSymbols?: readonly Field[];
  readonly sinkUnsafe?: boolean; // dynamic names or opaque source: preserve method lifetime
  readonly body?: readonly Stmt[]; readonly calls?: readonly string[]; readonly pos?: Position;
  readonly unsupported?: string; readonly fm?: boolean; readonly dropped?: boolean; readonly amcProgram?: string;
}
export interface Attribute extends Field { readonly static?: boolean; readonly private?: boolean; readonly value?: Expr }
export interface Class {
  readonly name: string; readonly attributes: readonly Attribute[]; readonly methods: readonly Method[];
  readonly constructor: Method | null; readonly ctorParams?: readonly Param[]; readonly super: string | null;
  readonly interfaces?: readonly string[]; readonly abstract?: boolean; readonly hostReplaced?: boolean;
  readonly instanceEvents?: boolean; readonly abstracts?: readonly Method[];
  readonly signatures?: ReadonlyMap<string, Method>; readonly stubs?: readonly Method[];
}
export interface RoutineSymbol { readonly abap: string; readonly owner?: string; readonly kind: string; readonly pos: Position }
export interface TableColumn { readonly name: string; readonly kind: string; readonly len?: number; readonly dec?: number; readonly key: boolean; readonly type: WriteType | null }
export interface DatabaseTable { readonly name: string; readonly view?: boolean; readonly client?: boolean; readonly key: readonly string[]; readonly columns: readonly TableColumn[]; readonly sqlView?: string; readonly cds?: string }
export interface Program {
  readonly classes: readonly Class[]; readonly structs: Map<string, Extract<Type, {k: 'struct'}>>;
  readonly reg: abaplint.IRegistry; currentOwner?: string;
  routineSymbols?: Map<string, RoutineSymbol>; convertedClasses?: Set<string>;
  readonly tables?: readonly DatabaseTable[]; readonly consts?: Map<string, {readonly type: Type; readonly value: Expr}>;
  readonly interfaces?: Set<string>;
  readonly functionModules?: Map<string, FunctionModule>;
  readonly localInterfaces?: Map<string, {readonly def: ReturnType<abaplint.Objects.Interface['getDefinition']>; readonly source: string}>;
  readonly interfaceMethods?: Map<string, readonly Method[]>; readonly skipped?: readonly string[]; readonly missing?: Set<string>; readonly wanted?: Set<string>;
  readonly anonStructs?: Map<abaplint.AbstractType, string>; readonly badStructs?: Map<string, string>;
  readonly ddicOutputLen?: Map<string, number>; readonly excAttrs?: Set<string>; readonly dynStatics?: Set<string>;
  readonly intfOwnAttrs?: Map<string, readonly Attribute[]>; readonly interfaceAttrs?: Map<string, readonly Attribute[]>;
  readonly sigs?: Map<string, Method>; readonly broken?: readonly string[]; readonly partial?: readonly string[];
  readonly frontendCounts?: {readonly lowered: number; readonly reused: number; readonly loweredClasses: readonly string[]; readonly reusedClasses: readonly string[]};
  readonly diagnostics?: readonly Diagnostic[]; readonly events?: Map<string, Event>;
  currentClass?: string; currentTypes?: Set<string>;
  readonly supplied?: Map<string, Set<string>>; readonly locals?: Map<string, string>;
  readonly exceptionSupers?: Map<string, string>; readonly ddicNames?: readonly string[];
}
export interface FindFields { LINE: string; OFFSET: string; LENGTH: string; SUBMATCHES: string; SOFFSET: string; SLENGTH: string }
export type ArithmeticBranch = Expr | {readonly reason: string};
export interface ArithmeticBranches { readonly I: ArithmeticBranch; readonly '8': ArithmeticBranch; readonly P: ArithmeticBranch; readonly F: ArithmeticBranch }

interface TypeMetadata { readonly qname?: string; readonly ddic?: string }
interface ExprMetadata { readonly conv?: boolean; readonly fromP?: Extract<Type, {k: 'p'}> }
export type TypedExpr = Expr & {readonly type: Type};
export interface ResolvedKey { readonly name: string; readonly unique: boolean; readonly hashed?: boolean; readonly comps: readonly (Field & {readonly num: boolean})[] }
export interface TemplateOptions { readonly decimals?: number; readonly raw?: boolean; readonly width?: number; readonly align?: string; readonly pad?: string;
    // two absence values today: null at frontend.mjs:5998, omitted at 5968; phase 2 normalises
    readonly pdec?: number | null }
export type TemplatePart = {readonly text: string} | {readonly value: Expr; readonly opts: TemplateOptions};
export interface Catch { readonly classes: readonly string[]; readonly into: string | null; readonly intoPlace?: Expr; readonly intoKind: 'exc' | 'ref' | null; readonly intoType: Type | null; readonly covers: readonly string[]; readonly own: readonly string[]; readonly body: readonly Stmt[] }
export interface SqlColumn { readonly name: string; readonly type: Type; readonly sql?: string; readonly named?: boolean; readonly agg?: {readonly star: true} | {readonly fn: string; readonly col: string} }
export interface SqlAssignment { readonly line?: boolean; readonly field?: string; readonly type: Type }
export type SqlArgument = {readonly host: Expr; readonly fit?: number; readonly xstring?: boolean; readonly xhex?: number; readonly xexact?: number} | {readonly mandt: true} | {readonly value: string | number | null};
export interface SqlPredicate { readonly id: string; readonly column: string; readonly type: Type; readonly kind: string; readonly lowLen: number; readonly range: Expr; readonly after: number }

export interface Diagnostic { readonly object: string; readonly message: string }
export interface Event { readonly key: string; readonly decl: string; readonly name: string; readonly static: boolean; readonly params: readonly Field[] }

export interface FunctionModule {
  readonly owner: string; readonly group: abaplint.Objects.FunctionGroup;
  readonly module: ReturnType<abaplint.Objects.FunctionGroup['getModules']>[number] | Method;
  readonly sig: Method; readonly updateTask: boolean;
  readonly spaghetti?: ReturnType<abaplint.SyntaxLogic['run']>['spaghetti'];
  readonly top?: ReturnType<ReturnType<abaplint.SyntaxLogic['run']>['spaghetti']['getTop']>;
}

// These dictionaries are still constructed as objects by the unconverted frontend.
export interface Exceptions { readonly map: Readonly<Record<string, number>>; readonly others: number }
export interface EventHandler { readonly call: Extract<Expr, {e: 'call'}>; readonly obj: Expr | null; readonly me: boolean; readonly key: string; readonly event: string; readonly filter: string | null }
export type WriteType =
  | {readonly abap: 'C' | 'X'; readonly len: number}
  | {readonly abap: 'P'; readonly len: number; readonly dec: number}
  | {readonly abap: 'I' | 'INT8' | 'STRING' | 'D' | 'XSTRING'};
export interface WriteColumn { readonly name: string; readonly kind: string; readonly ir: WriteType; readonly client: boolean }
