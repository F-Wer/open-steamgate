/* Shared row-to-series calculation, loaded by UI5 and by the row oracle. */
(function (factory) {
  if (typeof sap !== "undefined") sap.ui.define([], factory);
  else if (typeof module !== "undefined") module.exports = factory();
}(function () {
  "use strict";
  function time(v) {
    if (!v || +v === 0) return 0;
    if (v instanceof Date) return v.getTime();
    if (String(v).indexOf("/Date(") === 0) return +String(v).slice(6).split(")")[0];
    var s = String(v).replace(/\..*$/, "").padStart(14, "0");
    return Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(8, 10), +s.slice(10, 12), +s.slice(12, 14));
  }
  function compute(piles, events, stages, budget, now) {
    var stamps = stages.map(function (s) {return time(s.Opened);}).concat(piles.map(function (p) {return time(p.Started);}), events.map(function (e) {return time(e.Acted);})).filter(Boolean);
    var start = stamps.length ? Math.min.apply(null, stamps) : now;
    var closed = stages.length && stages.every(function (s) {return ["DONE", "PARTIAL", "FAILED", "NOT-RUN", "SKIPPED"].indexOf(s.Status) >= 0;});
    var end = Math.max.apply(null, [start, closed ? start : now].concat(piles.map(function (p) {return time(p.Ended);}), stages.map(function (s) {return time(s.Ended);}), stamps));
    var observedAt = end;
    end = Math.max(start + 1000, end);
    var points = [start, end].concat(piles.map(function (p) {return time(p.Ended);}).filter(Boolean), stages.map(function (s) {return time(s.Opened);}).filter(Boolean));
    points = Array.from(new Set(points)).sort(function (a, b) {return a - b;});
    var plan = points.map(function (at) {
      return {at: at, planned: piles.filter(function (p) {
        var stage = stages.find(function (s) {return +s.StageNo === +p.StageNo;});
        return (stage ? time(stage.Opened) : start) <= at;
      }).length, done: piles.filter(function (p) {return p.Status === "DONE" && time(p.Ended) > 0 && time(p.Ended) <= at;}).length};
    });
    var ordered = events.slice().sort(function (a, b) {return +a.Seq - +b.Seq;});
    var capacity = ordered.map(function (e) {
      return {at: time(e.Acted), reserved: +e.Reserved, glass: +e.Glass,
        warn: +e.Glass * +(budget && budget.WarnAt || 0) / 10000,
        narrow: +e.Glass * +(budget && budget.NarrowAt || 0) / 10000};
    });
    if (budget && !capacity.length) capacity.push({at: observedAt, reserved: +budget.Reserved, glass: +budget.Glass,
      warn: +budget.Glass * +budget.WarnAt / 10000, narrow: +budget.Glass * +budget.NarrowAt / 10000});
    // Events record state transitions, not every reservation. The budget
    // row supplies the latest observation after those event snapshots.
    if (ordered.length && capacity.length) capacity.push(budget && budget.Reserved !== undefined ? {at: observedAt, reserved: +budget.Reserved, glass: +budget.Glass,
      warn: +budget.Glass * +budget.WarnAt / 10000, narrow: +budget.Glass * +budget.NarrowAt / 10000} : Object.assign({}, capacity[capacity.length - 1], {at: end}));
    return {start: start, end: end, plan: plan, capacity: capacity};
  }
  function svg(series, rows, keys, labels) {
    var escape = function (s) {return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");};
    var width = 720, height = 230, left = 55, top = 15, bottom = 190, right = 705;
    var maximum = Math.max.apply(null, [1].concat(rows.flatMap(function (r) {return keys.map(function (k) {return +r[k];});})));
    var x = function (at) {return left + (at - series.start) / (series.end - series.start) * (right - left);};
    var y = function (v) {return bottom - v / maximum * (bottom - top);};
    var colors = ["#0070f2", "#188918", "#bb0000", "#925ace"];
    var paths = keys.map(function (key, index) {
      var d = rows.map(function (r, i) {return (i ? "H" + x(r.at) + "V" : "M" + x(r.at) + ",") + y(r[key]);}).join(" ");
      if (rows.length === 1 && ["glass", "warn", "narrow"].indexOf(key) >= 0) d = "M" + left + "," + y(rows[0][key]) + "H" + right;
      var last = rows[rows.length - 1], marker = last ? '<circle r="3" fill="' + colors[index] + '" cx="' + x(last.at) + '" cy="' + y(last[key]) + '"/>' : '';
      return '<path fill="none" stroke="' + colors[index] + '" stroke-width="2" d="' + d + '"/>' + marker + '<text x="' + (left + index * 150) + '" y="225" fill="' + colors[index] + '">' + escape(labels[index]) + '</text>';
    }).join("");
    var axes = [0, maximum / 2, maximum].map(function (v) {return '<text x="3" y="' + y(v) + '">' + +v.toFixed(2) + '</text><path stroke="#ddd" d="M55,' + y(v) + 'H705"/>';}).join("");
    return '<svg xmlns="http://www.w3.org/2000/svg" role="img" viewBox="0 0 ' + width + ' ' + height + '">' + axes + paths +
      '<text x="55" y="208" font-size="11">' + new Date(series.start).toISOString().slice(0, 19).replace("T", " ") + '</text>' +
      '<text x="705" y="208" text-anchor="end" font-size="11">' + new Date(series.end).toISOString().slice(0, 19).replace("T", " ") +
      '</text></svg>';
  }
  return {compute: compute, time: time, svg: svg};
}));
