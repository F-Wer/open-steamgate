sap.ui.define(["sap/suite/ui/generic/template/lib/AppComponent"], function (AppComponent) {
  "use strict";
  // A Fiori Elements V2 list report: no controller code, everything comes from
  // manifest.json and the annotations file. The OData service behind it is a
  // SEGW-shaped DPC transpiled by open-steamgate and served by the same
  // Express process.
  return AppComponent.extend("stg.travel.Component", {
    metadata: {manifest: "json"},
  });
});
