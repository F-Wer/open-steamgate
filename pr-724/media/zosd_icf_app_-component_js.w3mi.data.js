sap.ui.define(["sap/suite/ui/generic/template/lib/AppComponent"], function (AppComponent) {
  "use strict";
  // Transaction SICF, as the application it would be if it were written
  // today: a Fiori Elements V2 list report over NodeSet and an object page
  // whose facets are the three things SICF shows on tabs -- the handler
  // chain, the descriptions per language, and (ours, not SAP's) who last
  // wrote the row.
  //
  // No annotation file beside this component, for the same reason the
  // status app has none: every HeaderInfo, LineItem and Facet comes out of
  // ZOSD_ICF_SRV's own $metadata, generated from src/icf/zosd_icf.stg.yaml.
  // The app is the thinnest thing that can render the service.
  //
  // Read-only, and that is the drift rule rather than a missing feature: a
  // write through OData would go round ZCL_OSD_SICF=>SET_ACTIVE, which
  // keeps the object's hash while flipping the origin, and without that
  // bookkeeping the edit is replaced, without a word, on the day its
  // object next changes -- not at the next build, which is quieter and
  // therefore worse
  // (docs/registry-drift.md). The writable cut waits until that rule lives
  // in what the dispatcher writes through.
  return AppComponent.extend("stg.icf.Component", {
    metadata: {manifest: "json"},
  });
});
