sap.ui.define(["sap/suite/ui/generic/template/lib/AppComponent"], function (AppComponent) {
  "use strict";
  // The system telling you about itself: a Fiori Elements V2 list report over
  // SystemSet (one row) and an object page whose facets are the processes,
  // the ports, the services and the content packs of the running tree. There
  // is no annotation file beside this component on purpose - every HeaderInfo,
  // LineItem and Facet comes out of ZOSD_STATUS_SRV's own $metadata, so the
  // app is the thinnest thing that can render the service.
  return AppComponent.extend("stg.status.Component", {
    metadata: {manifest: "json"},
  });
});
