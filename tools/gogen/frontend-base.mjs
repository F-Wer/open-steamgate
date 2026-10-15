import {createRequire} from "node:module";

const require = createRequire(import.meta.url);
// The transpiler's database setup and rearranger use its own @abaplint/core.
// Keep registry objects from that same copy so instanceof checks find tables.
const transpilerRequire = createRequire(require.resolve("@abaplint/transpiler/package.json"));
/** @type {typeof import("@abaplint/core")} */ const abaplint = transpilerRequire("@abaplint/core");
/** @type {typeof import("@abaplint/transpiler/build/src/rearranger.js")} */ const {Rearranger} = require("@abaplint/transpiler/build/src/rearranger");
const {Nodes, Statements, Structures, Expressions, BasicTypes} = abaplint;

export class Unsupported extends Error {}
// A class outside the program is named, so a closure can add it and retry
// instead of refusing the caller for good.
/** @param {import("./frontend-types.ts").CompilationContext} ctx @param {string} cls @param {string} message @returns {Unsupported} */ function notInProgram(ctx, cls, message) {
  ctx.program.missing.add(cls);
  return new Unsupported(message);
}

/** @type {Extract<import("./ir.ts").Type, {k: "i"}>} */ export const I = {k: "i"};
/** @type {Extract<import("./ir.ts").Type, {k: "f"}>} */ export const F = {k: "f"};
/** @type {Extract<import("./ir.ts").Type, {k: "int8"}>} */ export const INT8 = {k: "int8"};
// calculation type p: an exact intermediate value (go/abap packed.go),
// rounded only when it lands in a field; len 16 is the 31 digits a p
// literal may have
/** @type {Extract<import("./ir.ts").Type, {k: "p"}>} */ const P31 = {k: "p", len: 16, dec: 0, calc: true};
/** @type {Extract<import("./ir.ts").Type, {k: "string"}>} */ export const S = {k: "string"};
/** @param {number} len @returns {Extract<import("./ir.ts").Type, {k: "c"}>} */ const C = (len) => ({k: "c", len});
/** @param {number} len @returns {Extract<import("./ir.ts").Type, {k: "x"}>} */ const X = (len) => ({k: "x", len});
/** @type {Extract<import("./ir.ts").Type, {k: "xstring"}>} */ const XS = {k: "xstring"};
/** @type {Extract<import("./ir.ts").Type, {k: "exc"}>} */ const EXC = {k: "exc"};

/** @param {unknown} n @param {import("./frontend-types.ts").NodeClass} cls @returns {n is import("@abaplint/core").Nodes.ExpressionNode} */ const isExpr = (n, cls) => n instanceof Nodes.ExpressionNode && n.get() instanceof cls;
/** @param {unknown} n @param {import("./frontend-types.ts").NodeClass} cls @returns {n is import("@abaplint/core").Nodes.StatementNode} */ const isStmt = (n, cls) => n instanceof Nodes.StatementNode && n.get() instanceof cls;
/** @param {unknown} n @param {import("./frontend-types.ts").NodeClass} cls @returns {n is import("@abaplint/core").Nodes.StructureNode} */ const isStruct = (n, cls) => n instanceof Nodes.StructureNode && n.get() instanceof cls;
/** @param {unknown} n @param {string} [s] @returns {n is import("@abaplint/core").Nodes.TokenNode} */ const isTok = (n, s) => n instanceof Nodes.TokenNode && (s === undefined || upper(n.getFirstToken().getStr()) === s);
/** @param {import("@abaplint/core").INode} n @returns {string} */ const tokenStr = (n) => n.getFirstToken().getStr();
/** @param {unknown} s @returns {string} */ const upper = (s) => String(s).toUpperCase();
/** @param {string} s @returns {string} */ const goName = (s) => {
  const name = upper(s).replace(/=>|~|-/g, "__").replace(/[^A-Z0-9_]/g, "_");
  return name.startsWith("_") ? `N${name}` : name;
};

// ultra/events: a SORTED table keeps its rows in key order, which only
// INSERT INTO TABLE knows how to do; every other statement that would place
// rows (APPEND, INSERT INDEX, MODIFY INDEX, SORT, SELECT / SPLIT INTO TABLE)
// refuses one, and a move between a SORTED and another table is not the
// same type (it would have to sort)
/** @param {{type: import("./ir.ts").Type} | undefined} t @param {string} what @returns {void} */ const refuseSorted = (t, what) => { if (t?.type?.sorted) throw new Unsupported(`${what} a SORTED table`); };
/** @param {import("./frontend-types.ts").TableType} a @param {import("./frontend-types.ts").TableType} b @returns {boolean} */ const sameSort = (a, b) => (a.sorted ?? null) === null ? (b.sorted ?? null) === null : (b.sorted !== undefined && a.sorted.join() === b.sorted.join() && a.unique === b.unique);
/** @param {import("./ir.ts").Type} a @param {import("./ir.ts").Type} b @returns {boolean} */ export const sameType = (a, b) => a.k === b.k && (a.k !== "table" || (sameType(a.row, b.row) && sameSort(a, b)))
  && (a.k !== "struct" || a.go === b.go) && (a.k !== "c" && a.k !== "x" || a.len === b.len)
  && (a.k !== "ref" || a.name === b.name)
  && (a.k !== "p" || (!!a.calc === !!b.calc && (a.calc || (a.len === b.len && a.dec === b.dec))));
/*
 * An IMPORTING table or structure passed by reference is the caller's own
 * data: measured on A4H, it sees what a CHANGING of the same table did,
 * APPEND included. VALUE( ) is a copy. So a composite IMPORTING by
 * reference is a pointer in Go, and a VALUE( ) one is cloned at the call.
 */
/** @param {import("./ir.ts").Type | null | undefined} t @returns {t is Extract<import("./ir.ts").Type, {k: "table" | "struct"}>} */ export const composite = (t) => t?.k === "table" || t?.k === "struct";
/** @param {import("./ir.ts").Param} p @returns {boolean} */ export const byRef = (p) => p.dir === "importing" && composite(p.type) && !p.byValue;
/** @param {import("./ir.ts").Type} t @returns {t is Extract<import("./ir.ts").Type, {k: "i" | "f" | "int8"}>} */ const numeric = (t) => t.k === "i" || t.k === "f" || t.k === "int8";
/** @param {import("./ir.ts").Type} t @returns {t is Extract<import("./ir.ts").Type, {k: "c" | "string"}>} */ const charlike = (t) => t.k === "c" || t.k === "string";
export {require, abaplint, Rearranger, Nodes, Statements, Structures, Expressions, BasicTypes,
  notInProgram, P31, C, X, XS, EXC, isExpr, isStmt, isStruct, isTok, tokenStr, upper, goName,
  refuseSorted, sameSort, numeric, charlike};
