sap.ui.define(["sap/suite/ui/generic/template/lib/AppComponent"], function (AppComponent) {
  "use strict";
  // The second app of the demo: a Fiori Elements V2 list report over
  // BookingSet of the same transpiled service. It exists so that the Travels
  // app has an intent to navigate to (Booking-display) and back
  // (Travel-manage); see flp.html.
  return AppComponent.extend("stg.booking.Component", {
    metadata: {manifest: "json"},
  });
});
