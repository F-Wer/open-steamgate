sap.ui.define(["sap/ui/core/UIComponent"], function (UIComponent) {
  "use strict";
  // SEGW as an application: the project tree of ZSTG_SEGW_SRV (one entity
  // set per /IWBEP/I_SB* table, served from the ZSTG_SB* tables) shown as the
  // tree the transaction shows, every node an OData entity edited in place.
  // Freestyle SAPUI5, not Fiori Elements: the tree spans twenty entity sets
  // that have no navigation properties between them.
  return UIComponent.extend("stg.segw.Component", {
    metadata: {manifest: "json"},
  });
});
