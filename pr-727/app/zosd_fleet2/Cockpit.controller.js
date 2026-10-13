sap.ui.define(["sap/m/Button", "sap/m/Dialog", "sap/m/Input", "sap/m/Label", "sap/m/VBox", "sap/m/HBox", "sap/m/Text",
  "sap/m/MessageStrip", "sap/m/ObjectStatus", "sap/ui/model/json/JSONModel", "l3/fleet2/Series", "l3/fleet2/Live", "l3/fleet2/Words"],
function (Button, Dialog, Input, Label, VBox, HBox, Text, MessageStrip, ObjectStatus, JSONModel, Series, Live, Words) {
  "use strict";
  // a status in its criticality colour is no input: its screen-reader text must not say
  // "Invalid entry" (the value-state text of an Error); only this app's statuses
  // a control of this app: its owner component (a table row's clone has one too) is this app's
  var ours = function (control) {
    if (control.getId().indexOf("l3.fleet2::") >= 0) return true;
    try {
      var Component = sap.ui.require("sap/ui/core/Component"), owner = Component && Component.get(Component.getOwnerIdFor(control));
      var app = owner && (owner.getAppComponent ? owner.getAppComponent() : owner);
      return !!app && app.getMetadata().getComponentName() === "l3.fleet2";
    } catch (e) {
      return false;
    }
  };
  if (!ObjectStatus.prototype.l3Quiet) {
    var init = ObjectStatus.prototype.init;
    ObjectStatus.prototype.init = function () {
      if (init) init.apply(this, arguments);
      if (ours(this)) this.setStateAnnouncementText("");
    };
    ObjectStatus.prototype.l3Quiet = true;
  }
  var config = {
   "service": "ZL3C_FLEET2_SRV",
   "set": "fleet2",
   "actions": [
    {
     "name": "StartRun",
     "params": {
      "CheckDate": "String(8)",
      "Mode": "String(1)",
      "Work": "String(4)"
     },
     "reason": false
    },
    {
     "name": "ReleasePile",
     "params": {
      "RunId": "String(32)",
      "RuleName": "String(60)",
      "PileNo": "Int32",
      "PerPile": "Int32",
      "Reason": "String(80)"
     },
     "reason": true
    },
    {
     "name": "ContinueGlass",
     "params": {
      "RunId": "String(32)",
      "NewGlass": "Int32",
      "Reason": "String(80)"
     },
     "reason": true
    },
    {
     "name": "Resume",
     "params": {
      "RunId": "String(32)"
     },
     "reason": false
    },
    {
     "name": "Doctor",
     "params": {},
     "reason": false
    }
   ],
   "governor": true,
   "simulate": true
  };
  // a run that still holds its lock may change; a final one does not
  var settled = ["DONE", "PARTIAL", "FAILED", "NOT-RUN", "SKIPPED", "KILLED"];
  var action = function (name) {return config.actions.find(function (a) {return a.name === name;});};
  return {
    // the service says whether the run still holds its lock; without it, the status decides
    isOpen: function (run) {return !!run && (run.Open !== undefined ? run.Open === true : settled.indexOf(run.Status) < 0);},
    errorText: function (e) {
      var text = e && (e.responseText || e.message) || "";
      try {text = JSON.parse(text).error.message.value;} catch (ignored) {/* not a Gateway error body */}
      return text;
    },
    // the runner's answer in words: a known first word gets its sentence, the rest stays as said
    human: function (answer) {return Words(answer, this.app().getModel("cockpitI18n").getResourceBundle());},
    onInit: function () {
      this.initTexts();
      this.extensionAPI.attachPageDataLoaded(this.loaded.bind(this));
    },
    onExit: function () {if (this.live) this.live.destroy();},
    app: function () {var owner = this.getOwnerComponent(); return owner.getAppComponent ? owner.getAppComponent() : owner;},
    // what the start dialog was answered, kept on the app so the run's page shows it again
    memo: function () {
      var app = this.app();
      if (!app.getModel("cockpit")) app.setModel(new JSONModel({answers: {}}), "cockpit");
      return app.getModel("cockpit");
    },
    initTexts: function () {this.getView().setModel(this.app().getModel("cockpitI18n"), "cockpitI18n");},
    text: function (key) {return this.app().getModel("cockpitI18n").getResourceBundle().getText(key);},
    // the page's own refresh: the header and the cockpit read again, the section tables
    // rebound; Live repeats it every five seconds while the run is open
    attachLive: function () {
      var self = this, view = this.getView();
      this.live = new Live({id: function (name) {return view.createId(name);}, text: this.text.bind(this),
        refresh: function () {return self.refreshAll();}, final: function () {return !self.isOpen(self.run);}});
      var layouts = view.findAggregatedObjects(true, function (c) {return c.isA("sap.uxap.ObjectPageLayout");});
      var title = layouts.length && layouts[0].getHeaderTitle();
      if (title && title.insertAction) this.live.controls.slice().reverse().forEach(function (c) {title.insertAction(c, 0);});
      // "needs attention": only for a run at the glass, with held or failed piles, and with the one
      // action that moves it on
      this.attentionText = new MessageStrip(view.createId("attention"), {type: "Warning", showIcon: true});
      this.attentionGo = new Button(view.createId("attentionGo"), {type: "Emphasized"});
      this.attention = new HBox(view.createId("attentionBox"), {alignItems: "Center", visible: false, items: [this.attentionText, this.attentionGo]});
      this.attentionGo.addStyleClass("sapUiSmallMarginBegin");
      if (layouts.length) layouts[0].addHeaderContent(this.attention);
    },
    attend: function () {
      var run = this.run || {}, self = this, what = null;
      if (run.Status === "GLASS" && action("ContinueGlass")) what = ["attentionGlass", "ContinueGlass", "Error"];
      // a pile RUNNING in a job that is over: only the doctor fails it and sends it again
      else if (+run.PilesOrphaned > 0 && action("Doctor")) what = ["attentionOrphaned", "Doctor", "Error"];
      else if (+run.PilesHeld > 0 && action("ReleasePile")) what = ["attentionHeld", "ReleasePile", "Warning"];
      else if (+run.PilesFailed > 0 && run.CanResume && action("Resume")) what = ["attentionFailed", "Resume", "Error"];
      this.attention.setVisible(!!what);
      if (!what) return;
      this.attentionText.setType(what[2]).setText(this.text("attention") + ": " + this.text(what[0]).replace("{0}", run.PilesHeld).replace("{1}", run.PilesFailed).replace("{2}", run.PilesOrphaned));
      this.attentionGo.setText(this.text(what[1]));
      this.attentionGo.detachPress(this.attendPress, this);
      this.attendPress = function () {
        if (what[1] === "ReleasePile") self.byId("cockpitDurations").getParent().setExpanded(true);
        self["ask" + what[1]]();
      };
      this.attentionGo.attachPress(this.attendPress, this);
    },
    askContinueGlass: function () {var run = this.run || {}; this.ask(action("ContinueGlass"), {RunId: run.RunId, NewGlass: String(Math.max(+run.Glass * 2, +run.Glass + 1))});},
    askResume: function () {
      var run = this.run || {};
      this.ask(action("Resume"), {RunId: run.RunId}, {title: this.text("resumeTitle").replace("{0}", run.PilesFailed || 0).replace("{1}", run.Title),
        intro: this.text("resumeIntro")});
    },
    // the doctor of the set, asked from the run page that shows what it would heal
    askDoctor: function () {
      var run = this.run || {};
      this.ask(action("Doctor"), {}, {title: this.text("doctorTitle"), intro: this.text("doctorIntro").replace("{0}", run.PilesOrphaned || 0)});
    },
    // the selected pile of the pile table, or the first held one when the attention strip asks
    askReleasePile: function () {
      var run = this.run || {}, self = this, pile = null;
      var table = this.byId("Pile::Table");
      var selected = table ? this.extensionAPI.getSelectedContexts(table.getId()) : [];
      if (selected.length) pile = selected[0].getObject();
      var go = function (p) {self.ask(action("ReleasePile"), {RunId: run.RunId, RuleName: p.RuleName, PileNo: String(p.PileNo), PerPile: "0"});};
      if (pile) {go(pile); return;}
      this.read("PileSet", "RunId eq '" + run.RunId + "' and Status eq 'HELD'").then(function (rows) {if (rows.length) go(rows[0]);});
    },
    loaded: function () {
      var self = this;
      var context = this.getView().getBindingContext(), run = context && context.getObject();
      if (!run) return;
      if (!this.live) this.attachLive();
      this.run = run;
      // the page data comes again after every refresh; only another run starts over
      if (this.shown === run.RunId) return;
      this.shown = run.RunId;
      // the answer the start dialog got for this run, in words
      var said = this.memo().getProperty("/answers/" + run.RunId);
      if (said) this.answer(said);
      else this.byId("cockpitAnswer").setVisible(false);
      this.live.set(this.isOpen(run));
      this.attend();
      this.refresh().then(function () {self.live.mark();});
    },
    refreshAll: function () {
      var self = this, model = this.getView().getModel(), id = this.run && this.run.RunId;
      if (!id) return Promise.resolve();
      var header = new Promise(function (resolve) {
        model.read("/RunSet('" + id + "')", {success: function (r) {if (!self.live.destroyed && self.run && self.run.RunId === r.RunId) {self.run = r; self.attend();} resolve();}, error: resolve});
      });
      this.extensionAPI.refresh();
      return Promise.all([header, this.refresh()]);
    },
    read: function (set, filter) {
      var model = this.getView().getModel();
      return new Promise(function (resolve, reject) {model.read("/" + set, {urlParameters: {$filter: filter || "", $top: "100000"}, success: function (r) {resolve(r.results);}, error: reject});});
    },
    refresh: function () {
      var self = this, context = this.getView().getBindingContext();
      if (!context) return Promise.resolve();
      var run = context.getObject(), filter = "RunId eq '" + run.RunId + "'";
      var names = ["Pile", "Stage"].concat(config.governor ? ["Event", "Budget"] : []);
      var reads = [Promise.all(names.map(function (n) {return self.read(n + "Set", filter);})).then(function (rows) {
        // a plain table for now (the chart multiplied on a system); the canvas comes in 6b
        var progress = self.byId("cockpitProgress"), counts = {}, lines = [];
        rows[0].forEach(function (p) {counts[p.Status] = (counts[p.Status] || 0) + 1;});
        var line = function (what, value) {lines.push({what: what, value: String(value)});};
        line(self.text("planned"), rows[0].length);
        Object.keys(counts).sort().forEach(function (k) {line(k, counts[k]);});
        var budget = rows[3] && rows[3][0];
        if (budget) {
          line(self.text("reserved"), budget.Reserved); line(self.text("glass"), budget.Glass); line(self.text("budgetState"), budget.State);
        }
        if (!progress.getModel("prog")) progress.setModel(new JSONModel({rows: []}), "prog");
        progress.getModel("prog").setData({rows: lines});
        // every pile, the open ones first (running, or left RUNNING by a job that is gone: the doctor's case);
        // a pile without an end counts up to now
        var states = {DONE: "Success", FAILED: "Error", HELD: "Warning", RUNNING: "Information"};
        var list = rows[0].map(function (p) {
          var started = Series.time(p.Started), ended = Series.time(p.Ended);
          return {rule: p.RuleName, no: +p.PileNo, pile: p.RuleName + " #" + p.PileNo, status: p.Status, state: states[p.Status] || "None", attempt: p.Attempt, open: !ended,
            seconds: started ? Math.round(((ended || Date.now()) - started) / 1000) + (ended ? "" : " (open)") : ""};
        }).sort(function (a, b) {return (b.open - a.open) || (a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : a.no - b.no);});
        var table = self.byId("cockpitDurations");
        if (!table.getModel("dur")) table.setModel(new JSONModel({rows: []}), "dur");
        table.getModel("dur").setData({rows: list});
      }).catch(function (e) {self.answer(self.errorText(e));})];
      return Promise.all(reads);
    },
    answer: function (answer) {this.byId("cockpitAnswer").setText(this.human(answer)).setVisible(true);},
    // a function import's dialog: what the page already knows is shown as text, the rest is asked
    // the dialog's button says the action; the run is named by its title, never its ID
    ask: function (action, known, how) {
      var self = this, inputs = {}, fixed = known || {}, opts = how || {}, box = new VBox({width: "28rem"});
      box.addStyleClass("sapUiSmallMargin");
      if (opts.intro) box.addItem(new Text({text: opts.intro}).addStyleClass("sapUiSmallMarginBottom"));
      Object.keys(action.params).forEach(function (p) {
        if (p === "RunId" && fixed.RunId !== undefined) {
          inputs[p] = {getValue: function () {return fixed[p];}};
          if (!opts.title) box.addItem(new Label({text: self.text("run")})).addItem(new Text({text: (self.run || {}).Title || fixed[p]}));
          return;
        }
        box.addItem(new Label({text: self.text(p), required: p === "Reason" || p === "Note"}));
        if (fixed[p] !== undefined && p !== "PerPile" && p !== "NewGlass") {
          box.addItem(new Text({text: fixed[p]}));
          inputs[p] = {getValue: function () {return fixed[p];}};
          return;
        }
        inputs[p] = new Input({value: fixed[p] !== undefined ? fixed[p] : /Int32/.test(action.params[p]) ? "0" : ""});
        box.addItem(inputs[p]);
      });
      var dialog = new Dialog({title: opts.title || this.text(action.name), content: box, beginButton: new Button({text: this.text(action.name), type: "Emphasized", press: function () {
        var params = {};
        Object.keys(inputs).forEach(function (p) {params[p] = inputs[p].getValue();});
        if (action.reason && !(params.Reason || params.Note || "").trim()) {self.answer(self.text("reasonRequired")); return;}
        self.getView().getModel().callFunction("/" + action.name, {method: "POST", urlParameters: params,
          success: function (r) {self.answer(r); dialog.close(); if (self.live) self.live.now(); else self.refresh();},
          error: function (e) {self.answer(e.responseText || e.message); dialog.close();}});
      }}), endButton: new Button({text: this.text("cancel"), press: function () {dialog.close();}}), afterClose: function () {dialog.destroy();}});
      this.getView().addDependent(dialog); dialog.open();
    }
  };
});
