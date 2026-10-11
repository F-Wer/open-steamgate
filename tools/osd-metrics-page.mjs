// The trend page of tools/osd-metrics.mjs: every snapshot in a history
// (one JSON object per line, oldest first) as one HTML page, data embedded.
//
//   node tools/osd-metrics-page.mjs history.ndjson > metrics.html
//
// The page is an artifact page (no doctype/head/body of its own): the jumps
// since the previous snapshot at the top, then per Go package and per JS
// module the size against its budget, the complexity with its change, the
// coverage and a sparkline of the complexity over the history.
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {compare} from "./osd-metrics.mjs";
import {irjsSection} from "./osd-irjs-progress-page.mjs";

export function page(history, irjs = []) {
  const latest = history.at(-1);
  const previous = history.length > 1 ? history.at(-2) : undefined;
  const jumps = previous ? compare(previous, latest).filter((r) => !r.new).slice(0, 12) : [];
  const data = {history: history.map((s) => ({commit: s.commit, date: s.date,
    go: Object.fromEntries(Object.entries(s.go).map(([k, v]) => [k, {sum: v.sum, max: v.max, coverage: v.coverage}])),
    js: Object.fromEntries(Object.entries(s.js).map(([k, v]) => [k, {sum: v.sum, max: v.max}]))})), latest, previous: previous ?? null, jumps};
  const html = TEMPLATE.replace("__DATA__", JSON.stringify(data).replaceAll("<", "\\u003c"));
  return irjs.length ? html.replace('<p class="legend">', irjsSection(irjs) + '\n<p class="legend">') : html;
}

const TEMPLATE = `<title>OSD Code Gauge</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600&display=swap">
<style>
:root{--ground:#F6F7F5;--surface:#FFFFFF;--ink:#1C2321;--muted:#5F6B66;--line:#D9DEDB;--accent:#2F6F62;--warn:#B7791F;--crit:#B42318;--good:#2E7D32;--bar:#E3E8E5}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){color-scheme:dark;--ground:#121615;--surface:#1A201E;--ink:#E6EBE8;--muted:#9AA6A1;--line:#2C3532;--accent:#5FB3A1;--warn:#E0A84A;--crit:#F07167;--good:#7CC48A;--bar:#26302D}}
:root[data-theme="dark"]{color-scheme:dark;--ground:#121615;--surface:#1A201E;--ink:#E6EBE8;--muted:#9AA6A1;--line:#2C3532;--accent:#5FB3A1;--warn:#E0A84A;--crit:#F07167;--good:#7CC48A;--bar:#26302D}
body{background:var(--ground);color:var(--ink);font:14px/1.5 "IBM Plex Sans",system-ui,sans-serif;padding-inline:16px;padding-block:24px 48px}
main{max-width:1180px;margin:0 auto;display:grid;gap:28px}
h1{font-size:22px;font-weight:600;margin:0;text-wrap:balance}
h2{font-size:15px;font-weight:600;margin:0 0 8px}
.meta{color:var(--muted);font:12px/1.4 "IBM Plex Mono",ui-monospace,monospace;display:flex;flex-wrap:wrap;gap:6px 18px;margin-top:6px}
.lede{color:var(--muted);max-width:68ch;margin:6px 0 0}
.panel{background:var(--surface);border:1px solid var(--line);border-radius:8px;padding:14px 16px}
.jumps{display:grid;gap:6px}
.jump{display:grid;grid-template-columns:auto 1fr auto;gap:10px;align-items:baseline;font:13px "IBM Plex Mono",ui-monospace,monospace}
.pill{font:11px "IBM Plex Sans",sans-serif;padding:1px 7px;border-radius:999px;border:1px solid currentColor;white-space:nowrap}
.pill.crit{color:var(--crit)}.pill.warn{color:var(--warn)}.pill.good{color:var(--good)}
.empty{color:var(--muted);margin:0}
.scroll{overflow-x:auto}
table{border-collapse:collapse;width:100%;min-width:860px;font-variant-numeric:tabular-nums}
th,td{padding:6px 8px;border-bottom:1px solid var(--line);text-align:right;white-space:nowrap}
th{font:500 11px "IBM Plex Sans",sans-serif;letter-spacing:.04em;text-transform:uppercase;color:var(--muted);position:sticky;top:0;background:var(--surface);cursor:pointer}
th:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}
td{font:12.5px "IBM Plex Mono",ui-monospace,monospace}
td.name,th.name{text-align:left}
td.name{font-weight:500}
td.top{text-align:left;color:var(--muted);max-width:260px;overflow:hidden;text-overflow:ellipsis}
.d{font-size:11px;margin-left:4px}.d.up{color:var(--crit)}.d.down{color:var(--good)}
.head{display:flex;align-items:center;gap:6px;justify-content:flex-end}
.meter{width:70px;height:6px;background:var(--bar);border-radius:3px;overflow:hidden}
.meter i{display:block;height:100%;background:var(--muted);opacity:.55}
.meter i.warn{background:var(--warn)}.meter i.crit{background:var(--crit)}
.max.warn{color:var(--warn)}.max.crit{color:var(--crit);font-weight:500}
svg.spark{display:block}
.legend{color:var(--muted);font-size:12px;display:flex;flex-wrap:wrap;gap:6px 16px;margin:0}
</style>
<main>
<header>
<h1>OSD Code Gauge</h1>
<p class="lede">Size, complexity and coverage of open-steamgate's Go packages and JS modules, one snapshot per main commit. It is for watching, not a gate: the size budget is the gate. A package whose complexity jumps is a candidate to split, simplify or fix.</p>
<div class="meta" id="meta"></div>
</header>
<section class="panel" aria-labelledby="jh"><h2 id="jh">Since the previous snapshot</h2><div class="jumps" id="jumps"></div></section>
<section aria-labelledby="gh"><h2 id="gh">Go packages</h2><div class="panel scroll"><table id="go"></table></div></section>
<section aria-labelledby="sh"><h2 id="sh">JS modules (300 lines or more)</h2><div class="panel scroll"><table id="js"></table></div></section>
<p class="legend"><span>Complexity: McCabe per function (1 + each branch).</span><span>Max over 50 is red, over 15 amber.</span><span>Budget: lines left under the size budget's ceiling; the ceiling follows the code down, so "at ceiling" is normal.</span><span>Coverage: go test -cover, statements.</span></p>
</main>
<script>
const DATA = __DATA__;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"})[c]);
const L = DATA.latest, P = DATA.previous;
$("meta").innerHTML = [
  "snapshot " + esc((L.commit || "").slice(0, 8)),
  esc(new Date(L.date).toISOString().slice(0, 16).replace("T", " ")) + " UTC",
  DATA.history.length + (DATA.history.length === 1 ? " snapshot" : " snapshots"),
  Object.keys(L.go).length + " Go packages", Object.keys(L.js).length + " JS modules"].map((t) => "<span>" + t + "</span>").join("");
if (!P) $("jumps").innerHTML = '<p class="empty">This is the first snapshot. Changes show from the next commit on main.</p>';
else if (DATA.jumps.length === 0) $("jumps").innerHTML = '<p class="empty">Nothing got markedly more complex.</p>';
else $("jumps").innerHTML = DATA.jumps.map((r) => {
  const sev = r.max > 50 || (r.dMax ?? 0) > 10 ? "crit" : "warn";
  const what = (r.dMax > 0 ? "max +" + r.dMax + " to " + r.max : "max " + r.max) + ", sum " + (r.dSum >= 0 ? "+" : "") + r.dSum + " (" + r.rel + "%)" + (r.dCoverage !== undefined && r.dCoverage < 0 ? ", coverage " + r.dCoverage + " pt" : "");
  return '<div class="jump"><span class="pill ' + sev + '">' + (r.kind === "go" ? "Go" : "JS") + '</span><span>' + esc(r.name) + '</span><span>' + esc(what) + '</span></div>';
}).join("");
function spark(series) {
  const w = 90, h = 22, vals = series.filter((v) => v !== undefined);
  if (vals.length < 2) return '<svg class="spark" width="' + w + '" height="' + h + '" aria-hidden="true"><line x1="0" y1="' + (h - 3) + '" x2="' + w + '" y2="' + (h - 3) + '" stroke="var(--line)" stroke-width="1"/></svg>';
  const min = Math.min(...vals), max = Math.max(...vals), span = max - min || 1;
  const pts = vals.map((v, i) => [(i / (vals.length - 1)) * (w - 4) + 2, h - 3 - ((v - min) / span) * (h - 6)]);
  const d = pts.map((p, i) => (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1)).join(" ");
  const last = pts.at(-1);
  return '<svg class="spark" width="' + w + '" height="' + h + '" aria-hidden="true"><path d="' + d + ' L' + last[0].toFixed(1) + ' ' + (h - 2) + ' L2 ' + (h - 2) + ' Z" fill="var(--bar)"/><path d="' + d + '" fill="none" stroke="var(--accent)" stroke-width="1.5"/><circle cx="' + last[0].toFixed(1) + '" cy="' + last[1].toFixed(1) + '" r="2.2" fill="var(--accent)"/></svg>';
}
function delta(now, was, lowerIsBetter = true) {
  if (was === undefined || now === undefined || now === was) return "";
  const d = now - was, up = d > 0;
  return '<span class="d ' + ((up === lowerIsBetter) ? "up" : "down") + '">' + (up ? "+" : "") + (Number.isInteger(d) ? d : d.toFixed(1)) + '</span>';
}
const COLS = [
  ["name", "Name"], ["lines", "Lines"], ["headroom", "Budget"], ["functions", "Funcs"], ["sum", "Sum"], ["max", "Max"], ["over15", ">15"], ["coverage", "Cover"], ["trend", "Sum trend"], ["top", "Most complex"]];
function render(kind, sortKey = "max", desc = true) {
  const rows = Object.entries(L[kind]).map(([name, v]) => ({name, ...v, headroom: v.budget ? v.budget - v.lines : null}));
  rows.sort((a, b) => { const x = a[sortKey] ?? -1, y = b[sortKey] ?? -1; return typeof x === "string" ? (desc ? y.localeCompare(x) : x.localeCompare(y)) : (desc ? y - x : x - y); });
  const was = P ? P[kind] : {};
  const head = "<thead><tr>" + COLS.filter(([k]) => kind === "go" || k !== "coverage").map(([k, t]) => '<th tabindex="0" class="' + (k === "name" || k === "top" ? "name" : "") + '" data-k="' + k + '" aria-sort="' + (k === sortKey ? (desc ? "descending" : "ascending") : "none") + '">' + t + "</th>").join("") + "</tr></thead>";
  const body = rows.map((r) => {
    const p = was[r.name] ?? {};
    const used = r.budget ? r.lines / r.budget : null;
    // the size budget is a ratchet: a ceiling at today's size is the normal
    // state, so only a breach is coloured
    const meter = r.budget ? '<span class="head"><span>' + (r.budget - r.lines === 0 ? "at ceiling" : (r.budget - r.lines) + " left") + '</span><span class="meter" title="' + r.lines + ' of ' + r.budget + ' lines"><i class="' + (used > 1 ? "crit" : "") + '" style="width:' + Math.min(100, Math.round(used * 100)) + '%"></i></span></span>' : "–";
    const sev = r.max > 50 ? "crit" : r.max > 15 ? "warn" : "";
    const series = DATA.history.map((s) => s[kind][r.name]?.sum);
    const top = r.top?.[0];
    const cells = [
      '<td class="name">' + esc(r.name) + "</td>",
      "<td>" + r.lines + delta(r.lines, p.lines) + "</td>",
      "<td>" + meter + "</td>",
      "<td>" + r.functions + "</td>",
      "<td>" + r.sum + delta(r.sum, p.sum) + "</td>",
      '<td class="max ' + sev + '">' + r.max + delta(r.max, p.max) + "</td>",
      "<td>" + r.over15 + delta(r.over15, p.over15) + "</td>",
      ...(kind === "go" ? ["<td>" + (r.coverage === undefined ? "–" : r.coverage.toFixed(1) + "%") + delta(r.coverage, p.coverage, false) + "</td>"] : []),
      "<td>" + spark(series) + "</td>",
      '<td class="top" title="' + esc(top ? top.name + " " + top.complexity : "") + '">' + esc(top ? top.name + " · " + top.complexity : "") + "</td>"];
    return "<tr>" + cells.join("") + "</tr>";
  }).join("");
  const t = $(kind);
  t.innerHTML = head + "<tbody>" + body + "</tbody>";
  t.querySelectorAll("th").forEach((th) => {
    const go = () => render(kind, th.dataset.k, th.dataset.k === sortKey ? !desc : th.dataset.k !== "name");
    th.addEventListener("click", go);
    th.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } });
  });
}
render("go"); render("js");
</script>`;

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const history = readFileSync(process.argv[2], "utf8").split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l));
  const args = process.argv.slice(3);
  if (args.length && (args.length !== 2 || args[0] !== '--irjs')) throw new Error('usage: osd-metrics-page.mjs history.ndjson [--irjs file.ndjson]');
  const irjs = args.length ? readFileSync(args[1], 'utf8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l)) : [];
  process.stdout.write(page(history, irjs));
}
