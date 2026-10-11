// Optional gauge section, rendered with the gauge's CSS and SVG path style.
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const COLORS = ['var(--accent)', 'var(--warn)', 'var(--crit)', 'var(--good)'];
const LAYERS = ['lexer', 'statements', 'structures', 'check'];
const stamp = row => row.date.slice(0, 16).replace('T', ' ') + ' UTC';
const ratio = (row, layer, host) => row.layers.find(l => l.layer === layer && l.host === host)?.vsVanilla;

function chart(rows, series, {log = false, bounds, title}) {
  const values = series.flatMap(s => rows.map(s.value)).filter(v => Number.isFinite(v) && (!log || v > 0));
  if (!values.length) return '<p class="empty">No measurements.</p>';
  const transform = v => log ? Math.log10(v) : v;
  const lo = bounds?.[0] ?? Math.min(...values.map(transform));
  const hi = bounds?.[1] ?? Math.max(...values.map(transform));
  const span = hi - lo || 1;
  const dates = rows.map(r => Date.parse(r.date)), start = dates[0], end = dates.at(-1);
  const x = i => 65 + (end === start ? (rows.length === 1 ? 0.5 : i / (rows.length - 1)) : (dates[i] - start) / (end - start)) * 620;
  const y = v => 165 - (transform(v) - lo) / span * 135;
  const paths = series.map(s => {
    let connected = false;
    const points = rows.map((r, i) => {
      const v = s.value(r);
      if (!Number.isFinite(v) || (log && v <= 0)) { connected = false; return ''; }
      const part = (connected ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(v).toFixed(1);
      connected = true;
      return part;
    }).join(' ');
    const dots = rows.map((r, i) => {
      const v = s.value(r);
      return Number.isFinite(v) && (!log || v > 0) ? `<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="2.2"><title>${esc(s.name)} · ${esc(stamp(r))}: ${esc(v)}${esc(s.detail?.(r) ?? '')}</title></circle>` : '';
    }).join('');
    return `<g stroke="${s.color}" fill="${s.color}"><path d="${points}" fill="none" stroke-width="1.5" ${s.dashed ? 'stroke-dasharray="5 3"' : ''}/>${dots}</g>`;
  }).join('');
  const divisions = bounds ? 4 : 3;
  const ticks = Array.from({length: divisions + 1}, (_, i) => {
    const v = lo + span * i / divisions, label = log ? (10 ** v).toPrecision(3) + '×' : Number(v.toFixed(1));
    const yy = 165 - i / divisions * 135;
    return `<line x1="65" x2="685" y1="${yy}" y2="${yy}" stroke="var(--line)"/><text x="57" y="${yy + 4}" text-anchor="end">${label}</text>`;
  }).join('');
  return `<svg viewBox="0 0 720 205" role="img" aria-label="${esc(title)}" style="display:block;width:100%;max-width:900px;font:11px 'IBM Plex Mono',monospace;color:var(--muted)"><title>${esc(title)}</title><g fill="currentColor">${ticks}<text x="65" y="193">${esc(stamp(rows[0]))}</text><text x="685" y="193" text-anchor="end">${esc(stamp(rows.at(-1)))}</text></g>${paths}</svg>
<p class="legend">${series.map(s => `<span style="color:${s.color}">${esc(s.name)}${s.dashed ? ' (dashed)' : ''}</span>`).join('')}</p>`;
}

function ratioTable(rows) {
  const body = rows.flatMap(row => row.layers.map(l => `<tr><td class="name">${esc(stamp(row))}</td><td class="name">${esc(l.layer)}</td><td>${esc(l.host)}</td><td>${esc(l.runs)}</td><td>${esc(l.medianUs)}</td><td>${Number.isFinite(l.vsVanilla) ? l.vsVanilla.toFixed(2) + '×' : '–'}</td><td>${l.pass ? 'PASS' : 'FAIL'}${l.source === 'doc' ? ' (doc)' : ''}</td></tr>`)).join('');
  return `<div class="scroll"><table><thead><tr><th class="name">Measured (UTC)</th><th class="name">Layer</th><th>Host</th><th>Runs</th><th>Median µs</th><th>÷ vanilla</th><th>Oracle</th></tr></thead><tbody>${body}</tbody></table></div>`;
}

export function irjsSection(history) {
  const rows = [...history].sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
  for (const row of rows) {
    if (row.schema !== 'irjs-progress/1' || !Array.isArray(row.layers) || !Number.isFinite(Date.parse(row.date))) throw new Error('invalid irjs-progress/1 row');
  }
  const gaps = LAYERS.flatMap((layer, i) => ['js', 'go'].map(host => ({name: `${layer} ${host}`, color: COLORS[i], dashed: host === 'go', value: row => ratio(row, layer, host), detail: row => {
    const l = row.layers.find(l => l.layer === layer && l.host === host);
    return ` · ${l.runs} run${l.runs === 1 ? ' (probe)' : 's'}${l.source === 'doc' ? ', doc hash evidence' : ''}`;
  }})))
    .filter(s => rows.some(r => Number.isFinite(s.value(r)) && s.value(r) > 0));
  const refusals = ['js', 'go', 'frontend', 'jsOnly'].map((key, i) => ({name: key === 'jsOnly' ? 'JS-only' : key, color: COLORS[i], value: row => row.refusals?.[key]}));
  return `<section class="panel" aria-labelledby="irjs-heading"><h2 id="irjs-heading">TS-HA on IR-JS</h2>
<p class="lede">Consecutive JS layers passing the count and SHA-256 oracle, timing gaps to vanilla Node, and static refusal sites. A single run is a probe; reference times are supplied measurements.</p>
<h3>Layers passed (0–4)</h3>${chart(rows, [{name: 'JS layers passed', color: COLORS[0], value: row => row.passed}], {bounds: [0, 4], title: 'Layers passed over time'})}
<h3>Median time ÷ vanilla Node${rows.length >= 3 ? ' (log scale)' : ''}</h3>${rows.length < 3 ? ratioTable(rows) : chart(rows, gaps, {log: true, title: 'Median time divided by vanilla Node, log scale'})}
<h3>Static refusal sites</h3>${chart(rows, refusals, {title: 'Refusal sites over time'})}
</section>`;
}
