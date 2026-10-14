sap.ui.define([
  "sap/ui/core/UIComponent", "sap/ui/model/json/JSONModel", "sap/ui/core/Item", "sap/ui/core/HTML",
  "sap/m/App", "sap/m/Page", "sap/m/Toolbar", "sap/m/ToolbarSpacer", "sap/m/Label", "sap/m/Select",
  "sap/m/MessageStrip", "sap/m/FlexBox", "sap/m/GenericTile", "sap/m/TileContent",
  "sap/m/NumericContent", "sap/m/Title", "sap/m/Text", "sap/m/ObjectStatus", "sap/m/VBox",
  "sap/viz/ui5/controls/VizFrame", "sap/viz/ui5/data/FlattenedDataset",
  "sap/viz/ui5/data/DimensionDefinition", "sap/viz/ui5/data/MeasureDefinition", "sap/viz/ui5/controls/common/feeds/FeedItem"
], function (UIComponent, JSONModel, Item, HTML, App, Page, Toolbar, ToolbarSpacer, Label, Select,
             MessageStrip, FlexBox, GenericTile, TileContent, NumericContent, Title, Text, ObjectStatus, VBox,
             VizFrame, FlattenedDataset, DimensionDefinition, MeasureDefinition, FeedItem) {
  "use strict";

  var percent = function (value) { return (100 * Number(value || 0)).toFixed(1); };
  var escape = function (value) { return String(value).replace(/[&<>"']/g, function (character) {
    return ({"&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"})[character];
  }); };

  function matrixSvg(classifier) {
    var labels = classifier.labels;
    var matrix = classifier.matrix;
    var cell = 13;
    var left = 190;
    var top = 18;
    var maximum = Math.max(1, ...matrix.flat());
    var width = left + labels.length * cell + 8;
    var height = top + labels.length * cell + 8;
    var svg = [`<div style="overflow:auto"><svg role="img" aria-label="Intent confusion matrix" width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">`];
    for (var row = 0; row < labels.length; row++) {
      svg.push(`<text x="${left - 5}" y="${top + row * cell + 10}" text-anchor="end" font-size="10">${escape(labels[row])}</text>`);
      for (var column = 0; column < labels.length; column++) {
        var count = matrix[row][column];
        var opacity = count === 0 ? 0.04 : 0.18 + 0.82 * count / maximum;
        var color = row === column ? "38,145,80" : "d0,43,43";
        svg.push(`<rect x="${left + column * cell}" y="${top + row * cell}" width="12" height="12" fill="rgb(${color})" fill-opacity="${opacity.toFixed(3)}"><title>${escape(labels[row])} → ${escape(labels[column])}: ${count}</title></rect>`);
      }
    }
    svg.push("</svg></div>");
    return svg.join("");
  }

  function tile(header, valuePath, footer, scale) {
    return new GenericTile({header: header, frameType: "OneByHalf", tileContent: [new TileContent({
      footer: footer, content: new NumericContent({value: valuePath, scale: scale || "%", valueColor: "Good"})
    })]});
  }

  return UIComponent.extend("osd.zvdb.quality.Component", {
    metadata: {manifest: "json"},

    createContent: function () {
      var quality = new JSONModel({models: []});
      var state = new JSONModel({message: "Loading benchmark report …", precision: "", accuracy: "", auc: "", f1: "", threshold: ""});
      var chart = new JSONModel({rows: []});
      this.setModel(quality, "quality");
      this.setModel(state, "state");
      this.setModel(chart, "chart");

      var matrix = new HTML({sanitizeContent: false});
      var viz = new VizFrame({height: "28rem", width: "100%", vizType: "bar", uiConfig: {applicationSet: "fiori"}});
      viz.setDataset(new FlattenedDataset({dimensions: [new DimensionDefinition({name: "Collision", value: "{chart>label}"})],
        measures: [new MeasureDefinition({name: "Queries", value: "{chart>count}"})], data: {path: "chart>/rows"}}));
      viz.setModel(chart, "chart");
      viz.addFeed(new FeedItem({uid: "categoryAxis", type: "Dimension", values: ["Collision"]}));
      viz.addFeed(new FeedItem({uid: "valueAxis", type: "Measure", values: ["Queries"]}));
      viz.setVizProperties({title: {visible: false}, legend: {visible: false}, plotArea: {dataLabel: {visible: true}},
        valueAxis: {title: {text: "Misclassified benchmark queries"}}});

      var select = new Select(this.createId("bucketSelect"), {width: "22rem", change: function (event) { render(event.getSource().getSelectedKey()); }});
      select.bindItems({path: "quality>/models", template: new Item({key: "{quality>bucket}", text: "{quality>bucket} · {quality>dimensions} bit"})});

      var render = function (bucket) {
        var model = quality.getProperty("/models").find(function (candidate) { return candidate.bucket === bucket; });
        if (!model) return;
        var threshold = model.binaryThreshold.bestF1;
        state.setData({
          message: model.queries + " stratified queries; direct translations of the same source are excluded from classification and threshold metrics.",
          precision: percent(model.binaryTop10Confusion.precision), accuracy: percent(model.binaryIntentClassifier.accuracy),
          auc: percent(model.binaryThreshold.rocAuc), f1: percent(threshold.f1),
          threshold: threshold.matchingBits + " / " + model.dimensions + " matching bits (" + percent(threshold.similarity) + "%)",
        });
        chart.setProperty("/rows", model.binaryIntentClassifier.topCollisions.slice(0, 12).reverse().map(function (row) {
          return {label: row.actual + " → " + row.predicted, count: row.count};
        }));
        matrix.setContent(matrixSvg(model.binaryIntentClassifier));
      };

      fetch("../quality.json").then(function (response) {
        if (!response.ok) throw new Error("HTTP " + response.status);
        return response.json();
      }).then(function (report) {
        quality.setData(report);
        select.setSelectedKey(report.models[0].bucket);
        render(report.models[0].bucket);
      }).catch(function (error) { state.setProperty("/message", "Cannot load quality report: " + error.message); });

      var page = new Page({title: "Vector quality", subHeader: new Toolbar({content: [
        new Label({text: "Bucket"}), select, new ToolbarSpacer(), new Label({text: "Mode"}),
        new ObjectStatus({text: "Published", state: "Success", tooltip: "Committed reproducible report; Live benchmarking is reserved for future asynchronous execution"}),
        new Text({text: "MASSIVE 1.1 · sign-bit quantization"})
      ]}), content: [new VBox({items: [
        new MessageStrip({text: "{state>/message}", showIcon: true}),
        new MessageStrip({text: "Published reads the committed reproducible report. Live benchmarking is intentionally not implemented in this experiment.", type: "Information", showIcon: true}),
        new FlexBox({wrap: "Wrap", items: [
          tile("Precision@10", "{state>/precision}", "same-intent results"),
          tile("Top-1 accuracy", "{state>/accuracy}", "without direct translations"),
          tile("ROC AUC", "{state>/auc}", "all labeled pairs"),
          tile("Best threshold F1", "{state>/f1}", "all labeled pairs")
        ]}),
        new Title({text: "Best binary threshold", level: "H2"}), new Text({text: "{state>/threshold}"}),
        new Title({text: "Largest intent collisions", level: "H2"}), viz,
        new Title({text: "Intent confusion matrix", level: "H2"}),
        new Text({text: "Rows are actual intents; columns are nearest-neighbour predictions. Green is correct, red is a collision; hover a cell for its count."}), matrix
      ]})]});
      // A bare Page gets a zero-height scrolling area when this component is
      // opened directly. App supplies the UI5 navigation/content sizing
      // contract; the viewport height also works inside the launchpad iframe.
      return new App({height: "100vh", pages: [page]});
    }
  });
});
