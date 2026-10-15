sap.ui.define([], function () {
  "use strict";
  // Started by flp.html once the core is up: the sandbox bootstrap
  // (test-resources/sap/ushell/bootstrap/sandbox.js) has created
  // sap.ushell.Container from window["sap-ushell-config"]; render the shell.
  // The sandbox mixes its own catalog (RTA Demo App, AppNavSample...) into
  // window["sap-ushell-config"]; only the open-steamgate group stays.
  var config = window["sap-ushell-config"] || {};
  var launchPage = config.services && config.services.LaunchPage && config.services.LaunchPage.adapter && config.services.LaunchPage.adapter.config;
  var dynamicTiles = {};
  // A served OSD lives at /, while a static preview lives below a Pages
  // directory such as /open-steamgate/main/.  Paths declared by packs are
  // system paths (/app, /sap), so resolve them from the app to the preview
  // mount rather than from the host name.  The latter silently asks
  // oisee.github.io/sap/... and turns a perfectly usable ANYDB tile red.
  function atMount(value) {
    return value && value.charAt(0) === "/" ? ".." + value : value;
  }
  // A tile's targetURL that is not a hash is followed as an outside link (the
  // launchpad opens it in a new window), so a pack tile written as this
  // page's own intent -- "/app/flp.html#Object-action", "flp.html#...",
  // "./flp.html#...", with or without a query -- becomes "#Object-action"
  // and navigates inside the shell like the built-in tiles.
  function tileTarget(value) {
    var intent = /^(?:\/app\/|\.\/)?flp\.html(?:\?[^#]*)?(#[^#]+)$/.exec(value || "");
    return intent ? intent[1] : atMount(value);
  }
  if (launchPage) {
    launchPage.groups = window["stg-launchpad-groups"] || [];
    launchPage.catalogs = [];
  }
  // The packs' own tiles, asked for at start: a content pack declares them in
  // its osd-pack.json and the server answers ./packs.json, so a pack reaches
  // the launchpad without this file or flp.html knowing its name (backlog
  // E.2). A tree with no packs answers an empty list, and a preview
  // deployment has no server at all, so a failure here is not an error.
  function withPackTiles() {
    return fetch("./packs.json").then(function (r) {
      return r.ok ? r.json() : {tiles: []};
    }).then(function (answer) {
      var tiles = (answer && answer.tiles) || [];
      if (tiles.length === 0 || !launchPage) {
        return;
      }
      var group = {id: "packs", title: "Content packs", isPreset: true, isVisible: true, isGroupLocked: false, tiles: []};
      tiles.forEach(function (tile) {
        // an intent added here, after the boot, answered "could not be
        // opened" (2026-09-17), so a tile's "#Object-action" works only for
        // an intent the pack's manifest declares: flp.html boots with those
        // (packs.json "applications"). A targetURL that is not a hash is
        // followed as is.
        var kinds = {static: "StaticTile", dynamic: "DynamicTile", image: "ImageTile"};
        var properties = {
          title: tile.title,
          subtitle: tile.subtitle || "",
          info: tile.info || tile.pack,
          icon: tile.icon,
          targetURL: tileTarget(tile.url)
        };
        if (tile.type === "dynamic") {
          properties.numberUnit = tile.numberUnit || "";
          properties.numberValue = "…";
          var refresh = Number(tile.serviceRefreshInterval || 60);
          dynamicTiles[tile.id] = {
            url: atMount(tile.serviceUrl),
            refresh: Number.isFinite(refresh) ? Math.max(10, refresh) : 60,
            numberUnit: tile.numberUnit || ""
          };
        }
        if (tile.type === "image") {
          properties.imageSource = atMount(tile.imageSource);
        }
        if (tile.enabled === false) {
          properties.subtitle = tile.disabledReason || properties.subtitle || "not available here";
          properties.info = tile.disabledReason || properties.info;
          delete properties.targetURL;
        }
        group.tiles.push({
          id: tile.id,
          tileType: "sap.ushell.ui.tile." + (kinds[tile.type] || kinds.static),
          stgRequires: tile.requires,
          stgDisabledReason: tile.disabledReason,
          properties: properties
        });
      });
      launchPage.groups = (launchPage.groups || []).concat([group]);
    }).catch(function () {
      // no server, or no packs: the built-in tiles are the whole launchpad
    });
  }

  // The AMDP tile is only useful where something can run SQLScript. Ask,
  // rather than read a configuration: a name in a config says what somebody
  // intended, and /engine says what happens -- it runs the smallest possible
  // body and reports. A tile that looks alive and then cannot do anything is
  // worse than a grey one, and this is the same screen that refuses to draw
  // a menu entry for a transaction it cannot start.
  function greyAmdpWithoutEngine() {
    return fetch(atMount("/sap/bc/osd/amdp/engine")).then(function (r) {
      return r.ok ? r.json() : {engine: "none"};
    }).then(function (answer) {
      if (!launchPage || (answer && answer.engine === "HDB")) {
        return;
      }
      (launchPage.groups || []).forEach(function (group) {
        (group.tiles || []).forEach(function (tile) {
          if (tile.id !== "amdp" && tile.stgRequires !== "HDB") {
            return;
          }
          tile.properties.info = tile.stgDisabledReason || "no SQLScript engine here";
          tile.properties.subtitle = tile.stgDisabledReason || "needs a database that speaks it";
          // no target: the sandbox would answer honestly, but a tile that
          // goes nowhere says so before the click rather than after
          delete tile.properties.targetURL;
        });
      });
    }).catch(function () {
      // no server (the browser preview) is the same answer as no engine
      greyAmdpWithoutEngine.failed = true;
    });
  }

  // The Workbench speaks ADT to the facade (/sap/bc/adt), which only the
  // Node host serves. OSGo and the browser preview have none, and there the
  // app opens and then fails on every call. So ask the way an ADT client
  // does -- HEAD on core/discovery -- and grey the tile unless it is a 200.
  // The Workbench itself stays: it is the editor meant for a real system
  // through the ADT proxy (host-tools review 2026-09-25, D1).
  function greyWorkbenchWithoutAdt() {
    function grey() {
      (launchPage && launchPage.groups || []).forEach(function (group) {
        (group.tiles || []).forEach(function (tile) {
          if (tile.id !== "workbench" && tile.stgRequires !== "ADT") {
            return;
          }
          tile.properties.info = tile.stgDisabledReason || "no ADT here";
          tile.properties.subtitle = tile.stgDisabledReason || "needs the ADT facade of the Node host";
          delete tile.properties.targetURL;
        });
      });
    }
    // The browser preview is a host that knows it has no ADT: the page is
    // controlled by its service worker (web/index.html registers sw.js),
    // and the facade is Node code that is never bundled into it. Asking
    // there would be a request whose only possible answer is a 404, so the
    // tile is greyed without one.
    var worker = navigator.serviceWorker && navigator.serviceWorker.controller;
    if (worker && /\/sw\.js$/.test(worker.scriptURL)) {
      grey();
      return Promise.resolve();
    }
    return fetch(atMount("/sap/bc/adt/core/discovery"), {method: "HEAD"}).then(function (r) {
      if (r.status !== 200) {
        grey();
      }
    }).catch(grey);
  }

  // A missing target makes the old sandbox tile non-clickable, but does not
  // make it look disabled. The rendered control is sap.m.GenericTile, whose
  // native Disabled state is the visual/accessibility contract we want.
  function installUnavailableTileState() {
    var root = document.getElementById("content");
    function update() {
      root.querySelectorAll(".sapUshellTile .sapMGT").forEach(function (element) {
        var tile = sap.ui.getCore().byId(element.id);
        if (!tile || typeof tile.getUrl !== "function" || tile.getUrl()) return;
        if (typeof tile.setState === "function" && tile.getState() !== "Disabled") {
          tile.setState("Disabled");
          return;
        }
        element.setAttribute("aria-disabled", "true");
        (tile.getTileContent ? tile.getTileContent() : []).forEach(function (content) {
          if (content.getFooter && content.getFooter() && content.setFooterColor) content.setFooterColor("Error");
        });
      });
    }
    new MutationObserver(update).observe(root, {childList: true, subtree: true});
    update();
  }

  // UI5 1.120's local LaunchPage adapter creates the NumericContent for a
  // DynamicTile, but its service timer discards the response. Bind the tiny
  // OSD live-value contract to that native control: a plain numeric response
  // (notably OData $count), or JSON with number/unit/info/state fields.
  function installDynamicTileData() {
    var root = document.getElementById("content");
    var started = {};
    function rendered(id) {
      var shells = root.querySelectorAll(".sapUshellTile");
      for (var i = 0; i < shells.length; i++) {
        var wrapper = sap.ui.getCore().byId(shells[i].id);
        var row = wrapper && wrapper.getBindingContext && wrapper.getBindingContext().getObject();
        if (row && row.originalTileId === id) {
          var element = shells[i].querySelector(".sapMGT");
          return element && sap.ui.getCore().byId(element.id);
        }
      }
    }
    function apply(id, data) {
      var tile = rendered(id);
      var content = tile && tile.getTileContent && tile.getTileContent()[0];
      var number = content && content.getContent && content.getContent();
      if (!number) return false;
      number.setValue(String(data.number));
      number.setScale(String(data.numberUnit ?? dynamicTiles[id].numberUnit));
      if (data.numberState && number.setValueColor) number.setValueColor(data.numberState);
      if (data.stateArrow && number.setIndicator) number.setIndicator(data.stateArrow);
      if (data.info !== undefined) content.setFooter(String(data.info));
      if (data.infoState && content.setFooterColor) content.setFooterColor(data.infoState);
      if (data.subtitle !== undefined) tile.setSubheader(String(data.subtitle));
      return true;
    }
    function refresh(id) {
      var spec = dynamicTiles[id];
      if (!spec.url) return;
      fetch(spec.url).then(function (response) {
        if (!response.ok) throw new Error("HTTP " + response.status);
        return response.text();
      }).then(function (text) {
        var value;
        try { value = JSON.parse(text); } catch (ignored) { value = {number: text.trim()}; }
        value = value && value.d !== undefined ? value.d : value;
        if (typeof value !== "object" || value.number === undefined) value = {number: value};
        if (!apply(id, value)) throw new Error("tile is not rendered");
      }).catch(function () {
        apply(id, {number: "—", info: "live data unavailable", infoState: "Error", numberState: "Error"});
      });
    }
    function start() {
      Object.keys(dynamicTiles).forEach(function (id) {
        if (started[id] || !rendered(id)) return;
        started[id] = true;
        refresh(id);
        window.setInterval(function () { refresh(id); }, dynamicTiles[id].refresh * 1000);
      });
    }
    new MutationObserver(start).observe(root, {childList: true, subtree: true});
    start();
  }

  // The 1.120 sandbox renders SAPLogo.svg even when shellLogo is configured.
  // Replace only that image, retaining UI5's home link and its fixed header
  // slot. Watch for shell re-renders when navigation switches applications.
  function installHeaderLogo() {
    var root = document.getElementById("content");
    var logo = new URL("./osd-airship.svg", document.baseURI).href;
    function update() {
      var icon = document.getElementById("shell-header-icon");
      if (icon && icon.getAttribute("src") !== logo) {
        icon.setAttribute("src", logo);
      }
      if (icon && icon.getAttribute("alt") !== "open-steamgate") {
        icon.setAttribute("alt", "open-steamgate");
      }
    }
    new MutationObserver(update).observe(root, {
      childList: true, subtree: true, attributes: true, attributeFilter: ["src", "alt"]
    });
    update();
  }

  installHeaderLogo();
  withPackTiles().then(greyAmdpWithoutEngine).then(greyWorkbenchWithoutAdt).then(function () {
    return sap.ushell.Container.createRenderer("fiori2", true);
  }).then(function (renderer) {
    renderer.placeAt("content");
    installUnavailableTileState();
    installDynamicTileData();
  });
});
