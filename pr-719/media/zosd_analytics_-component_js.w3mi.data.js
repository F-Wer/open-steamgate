sap.ui.define(["sap/suite/ui/generic/template/lib/AppComponent"], function (AppComponent) {
  "use strict";
  // The analytical app of the demo: a Fiori Elements V2 Analytical List Page
  // over the flight cube (ZC_STG_FLIGHTCUBE through the SADL service). Every
  // chart and table request is a $select on dimensions and measures that the
  // SADL runtime turns into GROUP BY; on DuckDB that is a columnar scan.
  return AppComponent.extend("stg.analytics.Component", {
    metadata: {manifest: "json"},
  });
});
