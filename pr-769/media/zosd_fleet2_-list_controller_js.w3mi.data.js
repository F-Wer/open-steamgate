sap.ui.define(["sap/ui/core/Fragment", "sap/m/MessageToast", "sap/m/MessageBox", "sap/m/MessageStrip", "sap/ui/model/json/JSONModel",
  "l3/fleet2/Cockpit.controller", "l3/fleet2/Live"],
function (Fragment, MessageToast, MessageBox, MessageStrip, JSONModel, Cockpit, Live) {
  "use strict";
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
  var pad = function (n) {return (n < 10 ? "0" : "") + n;};
  var today = function () {var d = new Date(); return "" + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate());};
  var methods = {
    onInit: function () {
      this.initTexts();
      this.strip = new MessageStrip(this.getView().createId("listCockpitAnswer"), {showIcon: true, visible: false});
      // the table's own variant ("Standard") goes with the page's: the page is titled by its set
      this.getView().findAggregatedObjects(true, function (c) {return c.isA("sap.ui.comp.smarttable.SmartTable");})
        .forEach(function (t) {t.setUseVariantManagement(false);});
    },
    onAfterRendering: function () {
      if (this.strip.getParent()) return;
      var pages = this.getView().findAggregatedObjects(true, function (c) {return c.isA("sap.f.DynamicPage");});
      if (pages.length) {this.page = pages[0]; this.page.getHeader().addContent(this.strip);}
      // the list's refresh button is the object page's, without the Live switch
      var self = this, view = this.getView(), title = this.page && this.page.getTitle();
      this.live = new Live({id: function (name) {return view.createId(name);}, text: this.text.bind(this), live: false,
        refresh: function () {return self.refresh();}});
      if (title && title.insertAction) this.live.controls.slice().reverse().forEach(function (c) {title.insertAction(c, 0);});
    },
    onExit: function () {if (this.live) this.live.destroy();},
    // the runs of today first: the date filter starts at today's check date
    onInitSmartFilterBarExtension: function (event) {
      var bar = event.getSource(), d = new Date(), day = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
      bar.setFilterData({CheckDate: {items: [], ranges: [{exclude: false, operation: "EQ", value1: day, keyField: "CheckDate"}]}}, true);
    },
    app: Cockpit.app,
    memo: Cockpit.memo,
    initTexts: Cockpit.initTexts,
    text: Cockpit.text,
    human: Cockpit.human,
    answer: function (answer) {
      this.strip.setText(this.human(answer)).setVisible(true);
      if (this.page) this.page.setHeaderExpanded(true);
    },
    refresh: function () {
      var table = this.getView().findAggregatedObjects(true, function (c) {return c.isA("sap.ui.comp.smarttable.SmartTable");})[0];
      if (table) table.rebindTable(true);
      return Promise.resolve();
    },
    // the start dialog: a date, how the piles run, the twin when the set has one
    askStartRun: function () {
      var self = this, view = this.getView();
      var data = {date: today(), mode: "P", simulate: !!config.simulate, sim: false, open: "", busy: false};
      if (!this.startModel) {this.startModel = new JSONModel(); view.setModel(this.startModel, "start");}
      this.startModel.setData(data);
      var opened = this.startDialog ? Promise.resolve(this.startDialog)
        : Fragment.load({id: view.getId(), name: "l3.fleet2.StartRun", controller: this}).then(function (dialog) {
          self.startDialog = dialog; view.addDependent(dialog); return dialog;
        });
      data.twinText = this.text("twin");
      return opened.then(function (dialog) {dialog.open(); self.startDateChanged(); self.twinProfile();});
    },
    // the twin runs under the set's chaos profile: the switch says which, and where it is changed
    twinProfile: function () {
      var self = this, model = this.startModel;
      if (!config.simulate) return Promise.resolve();
      return new Promise(function (resolve) {
        self.getView().getModel().read("/SettingSet", {urlParameters: {$filter: "ParamName eq 'simulate.profile'"},
          success: function (r) {
            if (r.results.length) model.setProperty("/twinText", self.text("twinProfile").replace("{0}", r.results[0].ParamVal).replace("{1}", config.set));
            resolve();
          }, error: function () {resolve();}});
      });
    },
    // a run for that date that still holds its lock is named before the start, not after
    startDateChanged: function () {
      var self = this, model = this.startModel, date = model.getProperty("/date");
      model.setProperty("/open", "");
      if (!/^\d{8}$/.test(date || "")) return Promise.resolve();
      var iso = date.slice(0, 4) + "-" + date.slice(4, 6) + "-" + date.slice(6, 8);
      return new Promise(function (resolve) {
        self.getView().getModel().read("/RunSet", {urlParameters: {$filter: "CheckDate eq datetime'" + iso + "T00:00:00'"},
          success: function (r) {
            var open = r.results.filter(Cockpit.isOpen);
            if (model.getProperty("/date") === date && open.length) {
              model.setProperty("/open", self.text("startOpen").replace("{0}", open[0].Status));
            }
            resolve();
          }, error: function () {resolve();}});
      });
    },
    startCancel: function () {this.startDialog.close();},
    startClosed: function () {this.startModel.setProperty("/busy", false);},
    startGo: function () {
      var self = this, model = this.startModel, data = model.getData();
      if (!/^\d{8}$/.test(data.date || "")) {MessageBox.error(this.text("startNoDate")); return;}
      var params = {CheckDate: data.date, Mode: data.mode};
      if (config.simulate) params.Work = data.sim ? "sim" : "";
      model.setProperty("/busy", true);
      this.getView().getModel().callFunction("/StartRun", {method: "POST", urlParameters: params,
        success: function (r) {
          model.setProperty("/busy", false);
          var answer = r && r.Answer !== undefined ? r.Answer : "";
          if (/^REFUSED:/.test(answer)) {
            MessageBox.error(answer.replace(/^REFUSED:\s*/, ""), {title: self.text("startRefused")});
            return;
          }
          self.startDialog.close();
          self.memo().setProperty("/answers/" + r.RunId, answer);
          MessageToast.show(self.text("runStarted"));
          if (!r.RunId) {self.answer(answer); return;}
          self.open(r.RunId);
        },
        error: function (e) {
          model.setProperty("/busy", false);
          MessageBox.error(Cockpit.errorText(e), {title: self.text("startRefused")});
        }});
    },
    // the new run's object page, after the list knows the run
    open: function (runId) {
      var self = this, model = this.getView().getModel();
      model.createBindingContext("/RunSet('" + runId + "')", null, {}, function (context) {
        if (context) self.extensionAPI.getNavigationController().navigateInternal(context);
        else self.refresh();
      });
    }
  };
  return methods;
});
