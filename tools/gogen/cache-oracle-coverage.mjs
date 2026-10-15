// Every exception is explicit and surfaced in reports; no inferred omissions.
export const expectedNoChange = {
  "pool-constant": "Unsupported: variable() cannot lower type-pool constants; both consumers retain the same refusal.",
};
export const expectedNoChangeWithoutLines = {
  "comment-only": "Comments only move source lines; GOGEN_NOLINE suppresses that artifact.",
  whitespace: "Whitespace only moves source lines; GOGEN_NOLINE suppresses that artifact.",
};
export const uncacheableFeatures = {
  ZCL_FUNCTION: "CALL FUNCTION reads a functionModules descriptor containing circular registry/syntax graphs; recordLowering cannot fingerprint that input and refuses replay.",
  ZORACLE_GROUP: "Function-group IR is rebuilt outside compileDiskClass; it has no reusable class entry.",
};
export function sensitivityFault(kind) {
  if (["comment-only", "whitespace", "method-body", "signature", "remove-object", "rename"].includes(kind)) return "drop:^CLAS ZCL_CONTROL_0001$";
  if (["class-constant", "parameter-default"].includes(kind)) return "drop:^CLAS ZCL_DEFAULTS$";
  if (kind === "superclass") return "drop:^CLAS ZCL_(PARENT|CHILD)";
  if (kind === "exception-superclass") return "drop:^CLAS ZCX_";
  if (kind === "interface") return "drop:^INTF";
  if (kind === "alias") return "drop:^CLAS ZCL_INTERFACE$";
  if (kind === "event") return "drop:^CLAS ZCL_EVENTS$";
  if (kind === "add-object") return "drop:^CLAS ZCL_ADDED$";
  if (kind.startsWith("ddic-")) return "drop:^(TABL|DTEL|DOMA)";
  if (kind === "class-macro") return "drop:^CLAS ZCL_LOCAL_MACRO$";
  if (kind === "include-macro") return "drop:^PROG";
  if (kind.startsWith("pool-")) return "drop:^TYPE";
  if (kind === "fugr-signature") return "drop:^FUGR";
  if (kind === "same-object-local-definition") return "no-version";
  if (kind === "cross-object-same-position-definition") return "no-version,fingerprint-location-only";
  if (kind === "global-definition-passes") return "drop:^INTF ZIF_PASS_";
  if (kind === "file-order") return "sorted-files";
  throw new Error(`mutation kind has no sensitivity row: ${kind}`);
}
export const notCovered = {
  "comment-only": "Only the edited owner's source lines change; call consumers do not inline provider text. Owner source hashes remain guarded.",
  whitespace: "Only the edited owner's source lines change; call consumers do not inline provider text. Owner source hashes remain guarded.",
  "method-body": "Calls do not inline method bodies; the changed owner is protected by its own source hash.",
  "exception-superclass": "ZCL_CATCH reuses unchanged IR: CATCH checks the hierarchy at runtime. Only the edited leaf owner IR and exceptionSupers (rebuilt outside replay) change.",
  "ddic-key": "Cold coverage via final tables metadata only; ZCL_DDIC IR is unchanged, and tables metadata is rebuilt outside replay, so the fault stays equal.",
  alias: "Removing the used alias makes the edited class syntax-broken before class replay; no stale cached lowering is reached.",
  event: "The event declaration and its consumers are in the same owner, whose source hash is retained.",
  "remove-object": "The dependent becomes syntax-broken and is excluded before replay; cold dependent output does change.",
  rename: "The dependent becomes syntax-broken and is excluded before replay; cold dependent output does change.",
  "class-macro": "The macro is owned by the reader; its source hash forces a miss even with dependency edges dropped.",
  "pool-constant": expectedNoChange["pool-constant"],
  "fugr-signature": uncacheableFeatures.ZCL_FUNCTION,
  "same-object-local-definition": "The local definition is in its reader's own object. The owner source hash invalidates it even under no-version; cross-object fingerprints are not covered.",
};
