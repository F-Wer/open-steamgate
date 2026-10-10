// SPDX-License-Identifier: MIT
const cell = v => String(v ?? "—").replaceAll("|", "\\|").replace(/[\r\n]/g, " ");
const pct = n => n.toFixed(2);
const signed = n => n == null ? "—" : `${n >= 0 ? "+" : ""}${Number.isInteger(n) ? n : pct(n)}`;
const header = m => `${cell(m.host)}; build ${cell(m.commit)}; duration ${m.durationSeconds}s; ${cell(m.metric?.type)}/${cell(m.metric?.unit)}`;
export function markdown(r) {
  if (r.kind === "diff") return [
    `ABAP hit-list diff: ${header(r.metadata.before)} → ${header(r.metadata.after)}`,
    "Deltas are after − before; percentages are percentage points. Samples are statistical, calls are exact when supplied.",
    "", "| Rank | ABAP class=>method:line | Before flat % | After flat % | Δ flat pp | Before cum % | After cum % | Δ cum pp | Δ samples | Δ calls |",
    "| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...r.rows.map(x => `| ${x.rank} | ${cell(x.key)} | ${pct(x.before?.flatPercent ?? 0)} | ${pct(x.after?.flatPercent ?? 0)} | ${signed(x.deltaFlatPercent)} | ${pct(x.before?.cumPercent ?? 0)} | ${pct(x.after?.cumPercent ?? 0)} | ${signed(x.deltaCumPercent)} | ${signed(x.deltaSamples)} | ${signed(x.deltaCalls)} |`),
  ].join("\n") + "\n";
  return [
    `ABAP hit list: ${header(r.metadata)}`,
    `Selected samples: ${r.metadata.totalSamples ?? "unknown"}; runtime-only/unattributed: ${pct(r.metadata.unattributedPercent)}%; tags: ${cell(r.metadata.tags.join(", ") || "all")}.`,
    "Flat includes native work beneath the nearest ABAP line; cumulative includes nested ABAP lines. Samples are statistical; calls require exact counts.",
    "", "| Rank | ABAP class=>method:line | TS name | TS file:line | Flat % | Cum % | Samples | Top runtime callee | Calls |",
    "| ---: | --- | --- | --- | ---: | ---: | ---: | --- | ---: |",
    ...r.rows.map(x => `| ${x.rank} | ${cell(x.key)} | ${cell(x.ts?.name)} | ${cell(x.ts?.file ? `${x.ts.file}:${x.ts.line ?? "?"}` : null)} | ${pct(x.flatPercent)} | ${pct(x.cumPercent)} | ${x.samples ?? "—"} | ${cell(x.topCallee?.name)} | ${x.calls ?? "—"} |`),
  ].join("\n") + "\n";
}
