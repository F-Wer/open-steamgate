sap.ui.define(["sap/ui/core/mvc/Controller", "sap/ui/model/json/JSONModel", "sap/ui/core/format/DateFormat", "sap/m/Dialog", "sap/m/Button",
  "sap/m/Input", "sap/m/Label", "sap/m/Text", "sap/m/VBox", "sap/m/MessageBox", "sap/m/MessageToast", "sap/m/Select", "sap/ui/core/Item",
  "l3/fleet2/set/Live", "l3/fleet2/set/Words"],
function (Controller, JSONModel, DateFormat, Dialog, Button, Input, Label, Text, VBox, MessageBox, MessageToast, Select, Item, Live, Words) {
  "use strict";
  // what the set can do, from its DSL (actions, settings with bounds)
  var config = {
   "service": "ZL3C_FLEET2_SRV",
   "actions": [
    {
     "name": "Doctor",
     "params": {},
     "reason": false
    },
    {
     "name": "SetKill",
     "params": {
      "Reason": "String(80)"
     },
     "reason": true
    },
    {
     "name": "ClearKill",
     "params": {
      "Reason": "String(80)"
     },
     "reason": true
    },
    {
     "name": "SetSetting",
     "params": {
      "Param": "String(30)",
      "Value": "String(40)",
      "Note": "String(80)"
     },
     "reason": true
    },
    {
     "name": "ResetSetting",
     "params": {
      "Param": "String(30)",
      "Note": "String(80)"
     },
     "reason": true
    },
    {
     "name": "Schedule",
     "params": {},
     "reason": false
    },
    {
     "name": "Unschedule",
     "params": {},
     "reason": false
    }
   ],
   "settings": [
    {
     "name": "budget.glass",
     "default": "10",
     "min": "1",
     "max": "2147483647",
     "about": "alerts the budget allows before the run stops at the glass"
    },
    {
     "name": "budget.warn",
     "default": "7000",
     "min": "1",
     "max": "10000",
     "about": "share of the glass in basis points at which the budget warns, 7000 = 70 %"
    },
    {
     "name": "budget.narrow_at",
     "default": "8000",
     "min": "1",
     "max": "10000",
     "about": "share of the glass in basis points from which piles are narrowed, 8000 = 80 %"
    },
    {
     "name": "budget.per_pile",
     "default": "50",
     "min": "0",
     "max": "2147483647",
     "about": "alerts one pile may reserve; a pile that needs more is held"
    },
    {
     "name": "retry.max",
     "default": "2",
     "min": "0",
     "max": "99",
     "about": "how often a failed pile is sent again"
    },
    {
     "name": "retry.backoff",
     "default": "60",
     "min": "0",
     "max": "86400",
     "about": "seconds before the first retry, doubled per attempt"
    },
    {
     "name": "stale",
     "default": "900",
     "min": "60",
     "max": "356400",
     "about": "seconds after which the doctor takes over a lock, a pile or a gate"
    },
    {
     "name": "fuses.max_alerts",
     "default": "500",
     "min": "1",
     "max": "100000",
     "about": "alerts a rule may write in one run before it stops writing"
    },
    {
     "name": "keep.days",
     "default": "30",
     "min": "1",
     "max": "9999",
     "about": "days the plans of a final run are kept"
    },
    {
     "name": "simulate.seed",
     "default": "42",
     "min": "1",
     "max": "2147483646",
     "about": "seed of the twin's draws: the same seed, the same night"
    },
    {
     "name": "simulate.time_scale",
     "default": "10000",
     "min": "0",
     "max": "1000000",
     "about": "wall time per simulated time in millionths, 10000 = 0.01 (40 s take 0.4 s)"
    },
    {
     "name": "simulate.profile",
     "default": "default",
     "min": "1",
     "max": "20",
     "values": [
      "default",
      "calm",
      "squall",
      "storm",
      "flood",
      "stuck",
      "random"
     ],
     "about": "chaos profile of the twin"
    },
    {
     "name": "simulate.dump",
     "default": "-1",
     "min": "-1",
     "max": "1000",
     "about": "share of piles that dump, per mille; -1 = from the profile"
    },
    {
     "name": "simulate.hang",
     "default": "-1",
     "min": "-1",
     "max": "1000",
     "about": "share of piles that hang, per mille; -1 = from the profile"
    },
    {
     "name": "simulate.slow",
     "default": "-1",
     "min": "-1",
     "max": "1000",
     "about": "share of piles that run slow, per mille; -1 = from the profile"
    },
    {
     "name": "simulate.hits_mean",
     "default": "-1",
     "min": "-1",
     "max": "100",
     "about": "mean alerts of a pile; -1 = from the profile"
    },
    {
     "name": "simulate.autoclose",
     "default": "-1",
     "min": "-1",
     "max": "1000",
     "about": "chance an alert is closed by the chance autoclose, per mille; -1 = from the profile"
    },
    {
     "name": "piles.checks.size",
     "default": "2",
     "min": "1",
     "max": "2147483647",
     "about": "keys per pile in stage checks"
    },
    {
     "name": "piles.lanes",
     "default": "0",
     "min": "0",
     "max": "9999",
     "about": "most pile jobs released at once; 0 = no cap, the lanes computed from the free background processes"
    }
   ]
  };
  var has = function (name) {return config.actions.some(function (a) {return a.name === name;});};
  var stamp = DateFormat.getDateTimeInstance({style: "medium"});
  var when = function (v) {return v instanceof Date && v.getTime() > 0 ? stamp.format(v) : "";};
  return Controller.extend("l3.fleet2.set.Set", {
    onInit: function () {
      var view = this.getView(), self = this;
      var cfg = {hasSettings: config.settings.length > 0 && has("SetSetting"), hasSchedule: has("Schedule"), hasKill: has("SetKill"), hasDoctor: has("Doctor")};
      cfg.first = cfg.hasSettings ? "settings" : cfg.hasSchedule ? "schedule" : cfg.hasKill ? "kill" : "doctor";
      view.setModel(new JSONModel(cfg), "cfg");
      view.setModel(new JSONModel({settings: [], changes: [], doctor: [], schedule: "", scheduled: false, kill: {set: false, text: "", since: ""}}), "set");
      this.live = new Live({id: function (name) {return view.createId(name);}, text: this.text.bind(this), live: false,
        refresh: function () {return self.refresh();}});
      this.live.controls.forEach(function (c) {self.byId("liveBox").addItem(c);});
      this.live.now();
    },
    onExit: function () {this.live.destroy();},
    text: function (key) {return this.getOwnerComponent().getModel("i18n").getResourceBundle().getText(key);},
    read: function (set, params) {
      var model = this.getOwnerComponent().getModel();
      return new Promise(function (resolve, reject) {
        model.read("/" + set, {urlParameters: params || {}, success: function (r) {resolve(r.results);}, error: reject});
      });
    },
    call: function (name, params, method) {
      var model = this.getOwnerComponent().getModel();
      return new Promise(function (resolve, reject) {
        model.callFunction("/" + name, {method: method || "POST", urlParameters: params || {}, success: resolve, error: reject});
      });
    },
    refresh: function () {
      var self = this, data = this.getView().getModel("set"), cfg = this.getView().getModel("cfg").getData(), reads = [];
      if (cfg.hasSettings) {
        reads.push(this.read("SettingSet").then(function (rows) {
          data.setProperty("/settings", rows.map(function (r) {
            var def = config.settings.find(function (s) {return s.name === r.ParamName;}) || {};
            return Object.assign({}, r, {values: def.values, about: def.about, bounds: def.values ? def.values.join(", ") : def.min + " .. " + def.max, changed: r.Origin === "DSL" ? self.text("fromDsl") : r.ChangedBy + ", " + when(r.ChangedAt)});
          }));
        }));
        reads.push(this.read("ChangeSet").then(function (rows) {
          rows.sort(function (a, b) {return (b.ChangedAt || 0) - (a.ChangedAt || 0);});
          data.setProperty("/changes", rows.map(function (r) {
            return Object.assign({}, r, {change: (r.OldValue || "-") + " -> " + r.NewValue, changed: r.ChangedBy + ", " + when(r.ChangedAt)});
          }));
        }));
      }
      if (cfg.hasSchedule) {
        reads.push(this.call("ScheduleStatus", {}, "GET").then(function (r) {
          data.setProperty("/schedule", r.Answer);
          data.setProperty("/scheduled", /SCHEDULED \d/.test(r.Answer));
        }));
      }
      if (cfg.hasDoctor || cfg.hasKill) {
        reads.push(this.read("DoctorSet").then(function (rows) {
          rows.sort(function (a, b) {return ((b.Acted || 0) - (a.Acted || 0)) || (+b.Seq - +a.Seq);});
          data.setProperty("/doctor", rows.map(function (r) {
            return Object.assign({}, r, {when: when(r.Acted), where: r.RunId === "SET" ? self.text("wholeSet") : r.RunId + (r.RuleName ? " / " + r.RuleName + " #" + r.PileNo : "")});
          }));
          // the switch's state is its last audited change
          var last = rows.filter(function (r) {return r.RunId === "SET" && /^(SET|CLEAR)-KILL$/.test(r.DocAction);})[0];
          var on = !!last && last.DocAction === "SET-KILL";
          data.setProperty("/kill", {set: on, text: self.text(on ? "killOn" : "killOff"),
            since: last ? self.text("killSince") + " " + when(last.Acted) + ": " + last.Reason : ""});
        }));
      }
      return Promise.all(reads).catch(function (e) {self.say("REFUSED: " + (e.message || e.responseText));});
    },
    // the runner's answer: OK is a toast, a refusal a message box with its text
    say: function (answer) {
      var strip = this.byId("answer");
      if (/^REFUSED:/.test(answer)) {
        strip.setVisible(false);
        MessageBox.error(answer.replace(/^REFUSED:\s*/, ""), {title: this.text("refused")});
        return false;
      }
      if (answer === "OK") MessageToast.show(this.text("done"));
      else strip.setType("Information").setText(Words(answer, this.getOwnerComponent().getModel("i18n").getResourceBundle())).setVisible(true);
      return true;
    },
    run: function (name, params) {
      var self = this;
      return this.call(name, params).then(function (r) {self.say(r.Answer); return self.live.now();},
        function (e) {self.say("REFUSED: " + (e.responseText || e.message));});
    },
    // a dialog for the fields a person types; a note or a reason is required and audited
    ask: function (title, fields, go) {
      var self = this, inputs = {}, box = new VBox({width: "26rem"});
      box.addStyleClass("sapUiSmallMargin");
      fields.forEach(function (f) {
        box.addItem(new Label({text: self.text(f.label), required: !!f.required}));
        if (f.fixed !== undefined) {box.addItem(new Text({text: f.fixed})); return;}
        inputs[f.name] = f.values ? new Select({width: "100%", selectedKey: f.value, items: f.values.map(function (v) {return new Item({key: v, text: v});})})
          : new Input({value: f.value || "", placeholder: f.hint ? self.text(f.hint) : ""});
        box.addItem(inputs[f.name]);
      });
      var dialog = new Dialog({title: title, content: box, beginButton: new Button({text: this.text("confirm"), type: "Emphasized", press: function () {
        var values = {}, missing = false;
        fields.forEach(function (f) {
          values[f.name] = f.fixed !== undefined ? f.fixed : inputs[f.name] instanceof Select ? inputs[f.name].getSelectedKey() : inputs[f.name].getValue();
          if (inputs[f.name]) inputs[f.name].setValueState("None");
          if (f.required && !values[f.name].trim()) {inputs[f.name].setValueState("Error").setValueStateText(self.text("required")); missing = true;}
        });
        if (missing) return;
        dialog.close();
        go(values);
      }}), endButton: new Button({text: this.text("cancel"), press: function () {dialog.close();}}), afterClose: function () {dialog.destroy();}});
      this.getView().addDependent(dialog);
      dialog.open();
      return dialog;
    },
    askChange: function (e) {
      var row = e.getSource().getBindingContext("set").getObject(), self = this;
      this.ask(this.text("SetSetting") + ": " + row.ParamName, [{name: "Param", label: "Param", fixed: row.ParamName},
        {name: "Value", label: "Value", value: row.ParamVal, values: row.values, required: true}, {name: "Note", label: "Note", hint: "noteHint", required: true}],
      function (v) {self.run("SetSetting", v);});
    },
    askReset: function (e) {
      var row = e.getSource().getBindingContext("set").getObject(), self = this;
      this.ask(this.text("ResetSetting") + ": " + row.ParamName, [{name: "Param", label: "Param", fixed: row.ParamName},
        {name: "Default", label: "colDefault", fixed: row.DslValue}, {name: "Note", label: "Note", hint: "noteHint", required: true}],
      function (v) {self.run("ResetSetting", {Param: v.Param, Note: v.Note});});
    },
    askSetKill: function () {
      var self = this;
      this.ask(this.text("SetKill"), [{name: "Reason", label: "Reason", required: true}], function (v) {self.run("SetKill", v);});
    },
    askClearKill: function () {
      var self = this;
      this.ask(this.text("ClearKill"), [{name: "Reason", label: "Reason", required: true}], function (v) {self.run("ClearKill", v);});
    },
    doSchedule: function () {this.run("Schedule");},
    doUnschedule: function () {this.run("Unschedule");},
    doDoctor: function () {this.run("Doctor");}
  });
});
