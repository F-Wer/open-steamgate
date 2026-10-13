# Caught exception references (inbox 048)

The fixture combines the supplied two-level repro with kernel and compiled
class exceptions, three levels, class-name and object-reference RTTI,
GET_TEXT before and after widening, IS BOUND, IS INSTANCE OF, checked casts,
reference identity, RETURNING and a table of REF TO cx_root.

SAP behavior of this expanded probe is **unmeasured; measure on A4H**. The
supplied oracle is `CX_SY_CONVERSION_NO_NUMBER <- CX_SY_ZERODIVIDE`. Kernel
GET_TEXT remains the host's class/operation text; localized SAP texts are
unmeasured; measure on A4H. Compiled exceptions keep their compiled GET_TEXT.

The source fixture and ABAP Unit include live in testdata. The registered
`test/osgo-exc-previous.mjs` copies only these inputs into a temporary fixture
and stages the expected-refusal/dump methods locally before running unit.mjs and unit-js.mjs. The generic testdata runner sees only successful ABAP Unit methods. semantics.mjs runs RUN on both hosts.
For a focused semantics run, select both ZCL_GOGEN_T_EXCPREV and its helper
ZCX_GOGEN_T_PREVIOUS with repeated --class options.

EXC widens implicitly only to REF TO cx_root and REF TO object. Direct EXC
casts and other methods/attributes keep their named refusals. Kernel long
texts remain refused by name even through a widened reference. Cast the widened
reference instead. Kernel widening creates the actual registered CX class
once; a missing kernel class or missing CX_ROOT seam refuses by name. No
surrogate type is reported to casts or RTTI. RAISE TYPE's ordinary compiled
constructor stores PREVIOUS, including a widened kernel exception.

Object-reference RTTI supplies class kind and names on both hosts; class
member enumeration is refused at runtime only for widened kernel exception descriptors; ordinary descriptor reads retain their existing behavior. Member-type lookup remains refused by name.

Critic round 1: kernel TEXTID, KERNEL_ERRID and other unpopulated attributes
are refused by member name after materialisation, including implicit and
by-reference reads. Their SAP values are **unmeasured; measure on A4H**.
Compiled objects retain constructor-populated attributes. Initial EXC
GET_TEXT, class-name and PREVIOUS reads dump OBJECTS_OBJREF_NOT_ASSIGNED,
as initial object references do; the dump is not caught by CX_SY_REF_IS_INITIAL
on these hosts. Unit fixtures pin both paths and the named metadata refusals.

Critic round 2 audit (Go and IR-JS; the loaded open-abap-core shims):

| Path | Disposition and ABAP coverage |
| --- | --- |
| CL_MESSAGE_HELPER=>GET_TEXT_FOR_MESSAGE native shim | Kernel objects return their carried text, exactly as kernel GET_TEXT does; ordinary TEXTID reads use the guard; ordinary T100/OTR lookup stays refused. HELPER_TEXT contains the supplied division/widening reproducer. Synthetic T100 TEXT also checks the kernel branch precedes metadata classification. |
| Explicit CX field reads and implicit exception-class attribute reads | Guarded TEXTID/KERNEL_ERRID; KERNEL_METADATA, KERNEL_ERRID and synthetic IMPLICIT. Constructor writes occur before kernel attachment; POPULATED_TEXTID pins ordinary constructor values. |
| Interface fields and Go generated pointer accessors | Runtime guard also applies through interface references, independent of their declared class. Synthetic DIRECT, COMPONENT and EXPLICIT cover IF_T100_MESSAGE~T100KEY, its MSGID component and the class-qualified interface path. |
| Generic/by-reference binding and field-symbol access | Go addresses pass through guarded places; JS bind captures a guarded receiver. KERNEL_BYREF and synthetic BYREF pin refusal before a metadata slot is exposed. |
| PREVIOUS host seams and compiled CX_ROOT reads | Go ExceptionPrevious's generated seam and JS exceptionPrevious use the guard; PREVIOUS remains populated and readable. CHAIN covers direct EXC, widened references, constructor chains, identity and initial dereferences. |
| CL_MESSAGE_HELPER=>GET_LATEST_T100_EXCEPTION | Its compiled ABAP loop reads PREVIOUS through guarded refattr; HELPER_PREVIOUS exercises a widened kernel leaf. |
| IF_MESSAGE~GET_TEXT and CX_ROOT/derived GET_TEXT aliases; runtime TextOf/excText | Kernel method prologues return carried text; compiled objects dispatch their compiled method. CHAIN and INTERFACE_TEXT pin both forms. These read the internal kernel carrier, not guessed ABAP metadata. |
| IF_MESSAGE~GET_LONGTEXT and alias | Kernel long text is refused by method name. INTERFACE_LONGTEXT and the separate widened GET_LONGTEXT fixture pin both dispatch paths. |
| CL_MESSAGE_HELPER=>SET_MSG_VARS_FOR_IF_MSG | Delegates to the corrected helper and interface GET_TEXT; HELPER_VARS compares with carried text. SET_MSG_VARS_FOR_CLIKE handles only a supplied string and reads no CX fields. |
| CL_MESSAGE_HELPER=>CHECK_MSG_KIND | Compiled interface T100KEY read is guarded (synthetic HELPER); its non-T100 @KERNEL branch is refused with the method's name (HELPER_KIND). |
| CL_MESSAGE_HELPER=>GET_TEXT_PARAMS / REPLACE_TEXT_PARAMS / GET_OTR_TEXT_RAW | Core has ASSERT-todo placeholders; lowered as named NOT_COMPILED stubs instead of executing them. HELPER_PARAMS, HELPER_REPLACE and HELPER_OTR exercise each. |
| CX_ROOT=>GET_SOURCE_POSITION | Core's EXTRA_CX @KERNEL reads are already refused with the owning method name; SOURCE_POSITION pins this. |
| Object-reference RTTI and class-name lookup | Registered class identity/kind/name only; no CX field inspection. CHAIN covers DESCRIBE_BY_OBJECT_REF and GET_CLASS_NAME before/after widening, for kernel and compiled exceptions. |
| Object RTTI enumeration | ATTRIBUTES, METHODS, INTERFACES, TYPES and EVENTS are refused by member name at runtime only on descriptors of widened kernel exceptions. ORDINARY_INTERFACES checks an ordinary class descriptor on both hosts. RTTI_MEMBERS/METHODS/INTERFACES/TYPES/EVENTS cover each. |
| Object RTTI member-type lookup | GET_ATTRIBUTE_TYPE, GET_METHOD_PARAMETER_TYPE, GET_INTERFACE_TYPE and GET_SUPER_CLASS_TYPE remain refused by method name. RTTI_ATTRIBUTE_TYPE/PARAMETER/INTERFACE/SUPER cover each. |
| /UI2/CL_JSON=>SERIALIZE over a CX object | Its object branch uses object RTTI/member enumeration and dynamic ASSIGN, which cannot expose CX metadata on these hosts; JSON_OBJECT pins named refusal on both. |
| IS_RESUMABLE | Absent from the loaded CX_ROOT declaration; there is no reachable read. The frontend test pins its named syntax refusal. No value is invented. |

The T100/implicit probes copy core into temporary storage and add an interface
and reader to the compiled division class. This exposes paths that the loaded
kernel classes do not normally implement; it makes no SAP metadata claim and
never changes the library checkout. All probes run on both hosts. No raw
open-abap @KERNEL field-read code is executed by either IR host: implemented
native shims replace it, and other kernel lines produce named refusals.

Critic round 3: Go RAISE retains the caught Exception carrier on the panic
value, and subsequent CATCHes reuse it. Lazy materialisation belongs to that
carrier, so widening before or after any rethrow shares the compiled CX object.
RETHROW_LAZY is the supplied reproducer; RETHROW_WIDENED widens before raising;
RETHROW_TWICE raises twice and widens the last catch first. All run on both hosts.
