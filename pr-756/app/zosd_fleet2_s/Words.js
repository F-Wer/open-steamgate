/* The runner's answers in words, for both cockpit apps: a status answer (DONE,
 * SUBMITTED: ...) gets its sentence, the doctor's report (one CODE:REASON line
 * per thing it did, as Doctor and Resume answer) is counted and said, and
 * anything else stays as the runner said it. The words are the app's i18n:
 * answer<WORD>, doctor<CODE> with {0} for the count, reason<CODE>. */
sap.ui.define([], function () {
  "use strict";
  function has(bundle, key) {return bundle.hasText(key);}
  function doctor(text, bundle) {
    var lines = text.split("\n").map(function (l) {return l.trim();}).filter(Boolean);
    if (!lines.length || !lines.every(function (l) {return /^[A-Z][A-Z-]*:\S*$/.test(l) && has(bundle, "doctor" + l.split(":")[0]);})) return null;
    var groups = [], seen = {};
    lines.forEach(function (l) {
      var parts = l.split(":"), key = parts[0] + ":" + parts[1];
      if (!seen[key]) {seen[key] = {code: parts[0], reason: parts[1], count: 0}; groups.push(seen[key]);}
      seen[key].count++;
    });
    return groups.map(function (g) {
      var said = bundle.getText("doctor" + g.code, [g.count]);
      return said + (g.reason && has(bundle, "reason" + g.reason) && bundle.getText("reason" + g.reason) ? " (" + bundle.getText("reason" + g.reason) + ")" : "");
    }).join("; ") + ".";
  }
  return function (answer, bundle) {
    var text = typeof answer === "string" ? answer : answer && answer.Answer !== undefined ? answer.Answer : "";
    if (/^\s*$/.test(text)) return bundle.getText("answerNothing");
    var report = doctor(text, bundle);
    if (report) return report;
    var word = text.split(":")[0].trim();
    if (/^[A-Z][A-Z-]*$/.test(word) && has(bundle, "answer" + word)) {
      var rest = text.slice(word.length).replace(/^:\s*/, "");
      return bundle.getText("answer" + word) + (rest ? " " + rest : "");
    }
    return text;
  };
});
