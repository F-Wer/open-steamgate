sap.ui.define([
  "sap/m/MessageStrip",
  "sap/m/MessageToast",
  "sap/m/Dialog",
  "sap/m/Button",
  "sap/m/Label",
  "sap/m/Text",
  "sap/m/Input",
  "sap/m/VBox"
], function (MessageStrip, MessageToast, Dialog, Button, Label, Text, Input, VBox) {
  "use strict";

  // The taxi page's sample data: which years are loaded, one more year, and
  // back to the four TLC sample rows. The rows are made by ZOSD_TAXI_SRV
  // (src/demo_data/zosd_taxi.stg.yaml); nothing is generated when the system
  // starts, so an empty page says so and offers the button instead.
  return {
    onInit: function () {
      this._years = [];
      this._strip = new MessageStrip({showIcon: true, type: "Information"});
      this._strip.addStyleClass("sapUiTinyMargin");
      var page = this.getView().byId("template::Page");
      if (page && page.addHeaderContent) {
        page.addHeaderContent(this._strip);
      } else if (page && page.getHeader && page.getHeader() && page.getHeader().addContent) {
        page.getHeader().addContent(this._strip);
      }
      this._loadYears();
    },

    // the view belongs to the template's component; the app's own models
    // (its texts, the data service) are on the application component
    _app: function () {
      var owner = this.getOwnerComponent();
      return owner.getAppComponent ? owner.getAppComponent() : owner;
    },

    _i18n: function (key, args) {
      return this._app().getModel("i18n").getResourceBundle().getText(key, args);
    },

    _data: function () {
      return this._app().getModel("taxiData");
    },

    _loadYears: function () {
      var that = this;
      this._data().read("/YearSet", {
        success: function (answer) {
          that._years = answer.results || [];
          that._showYears();
        },
        error: function () {
          // not "no data yet": the service did not answer
          that._years = [];
          that._strip.setType("Error");
          that._strip.setText(that._i18n("YearsFailed"));
        }
      });
    },

    _showYears: function () {
      this._strip.setType("Information");
      if (this._years.length === 0) {
        this._strip.setText(this._i18n("NoSampleData"));
      } else {
        this._strip.setText(this._i18n("LoadedYears", [this._years.map(function (y) { return y.Year; }).join(", ")]));
      }
    },

    // the most recent year that has no rows yet, the current one first
    _nextYear: function () {
      var loaded = this._years.map(function (y) { return y.Year; });
      var year = new Date().getFullYear();
      while (loaded.indexOf(year) >= 0 && year > 1900) {
        year -= 1;
      }
      return year;
    },

    _refresh: function (report) {
      MessageToast.show(report.replace(/^taxi: /, ""), {duration: 6000});
      this.getView().getModel().refresh(true);
      this._loadYears();
    },

    _call: function (name, parameters) {
      var that = this;
      var busy = this.getView();
      busy.setBusy(true);
      this._data().callFunction("/" + name, {
        method: "POST",
        urlParameters: parameters || {},
        success: function (answer) {
          busy.setBusy(false);
          that._refresh(String(answer[name] !== undefined ? answer[name] : ""));
        },
        error: function (error) {
          busy.setBusy(false);
          var text = error && error.responseText;
          try {
            text = JSON.parse(text).error.message.value;
          } catch (e) {
            // not an OData error body: show it as it came
          }
          MessageToast.show(String(text || error && error.message || name), {duration: 6000});
        }
      });
    },

    onGenerateData: function () {
      var that = this;
      // a plain number field: a year is not a quantity, so no grouping
      var input = new Input({type: "Number", value: String(this._nextYear()), width: "8rem", maxLength: 4});
      var dialog = new Dialog({
        title: this._i18n("GenerateTitle"),
        content: new VBox({items: [
          new Label({text: this._i18n("GenerateYear"), labelFor: input}),
          input,
          new Text({text: this._i18n("GenerateHint")})
        ]}).addStyleClass("sapUiSmallMargin"),
        beginButton: new Button({type: "Emphasized", text: this._i18n("Generate"), press: function () {
          dialog.close();
          that._call("GenerateYear", {Year: input.getValue()});
        }}),
        endButton: new Button({text: this._i18n("Cancel"), press: function () { dialog.close(); }}),
        afterClose: function () { dialog.destroy(); }
      });
      this.getView().addDependent(dialog);
      dialog.open();
    },

    onResetData: function () {
      var that = this;
      if (this._years.length === 0) {
        MessageToast.show(this._i18n("ResetNothing"));
        return;
      }
      var trips = this._years.reduce(function (n, y) { return n + y.Trips; }, 0);
      var rows = this._years.reduce(function (n, y) { return n + y.Rows; }, 0);
      var format = function (n) { return n.toLocaleString("en-US").replace(/,/g, " "); };
      var dialog = new Dialog({
        title: this._i18n("ResetTitle"),
        type: "Message",
        state: "Warning",
        content: new Text({text: this._i18n("ResetConfirm", [
          this._years.map(function (y) { return y.Year; }).join(", "), format(trips), format(rows)])}),
        beginButton: new Button({type: "Emphasized", text: this._i18n("Remove"), press: function () {
          dialog.close();
          that._call("ResetData");
        }}),
        endButton: new Button({text: this._i18n("Cancel"), press: function () { dialog.close(); }}),
        afterClose: function () { dialog.destroy(); }
      });
      this.getView().addDependent(dialog);
      dialog.open();
    }
  };
});
