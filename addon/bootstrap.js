"use strict";

var plugin;

async function startup({ id, rootURI, version }) {
  await Zotero.initializationPromise;
  const scope = {
    Zotero, Services, ChromeUtils, IOUtils, PathUtils, DOMParser, URL,
    Cc: Components.classes,
    Ci: Components.interfaces,
    Cu: Components.utils,
    setTimeout, clearTimeout
  };
  for (const file of ["vendor/markdown-it.js", "vendor/katex.js", "vendor/markdown-it-texmath.js",
    "markdown.js", "core.js", "history.js", "sidebar.js", "layout.js", "reader-capture.js", "reader-selection.js",
    "reader-fit.js", "runtime.js"]) {
    Services.scriptloader.loadSubScript(rootURI + "content/" + file + "?v=" + encodeURIComponent(version), scope, "UTF-8");
  }
  plugin = new scope.AIPaperRuntime(id, rootURI, version);
  Zotero.AIPaper = plugin;
  await plugin.startup();
}

async function shutdown() {
  if (plugin) await plugin.shutdown();
  if (Zotero.AIPaper === plugin) delete Zotero.AIPaper;
  plugin = null;
}

function install() {}
function uninstall() {}
