"use strict";

var AIPaperLayout = class {
  constructor(runtime, win) {
    this.runtime = runtime;
    this.win = win;
    this.doc = win.document;
    this.hosts = [];
    this.observers = [];
    this.panels = new Map();
    this.onSelect = () => this.update();
    this.onUnload = () => runtime.detachWindow(win);
    win.addEventListener("unload", this.onUnload, { once: true });
    this.doc.documentElement.classList.add("aip-layout");
    this.link = this.doc.createElementNS("http://www.w3.org/1999/xhtml", "link");
    this.link.rel = "stylesheet";
    this.link.href = runtime.rootURI + "content/sidebar.css?v=" + encodeURIComponent(runtime.version);
    this.doc.documentElement.append(this.link);
    this.screen = win.screen;
    this.widthTargets = [
      { pane: this.doc.getElementById("zotero-item-pane"), splitter: this.doc.getElementById("zotero-items-splitter") },
      { pane: this.doc.getElementById("zotero-context-pane"), splitter: this.doc.getElementById("zotero-context-splitter") }
    ].filter(target => target.pane && target.splitter);
    this.onResize = () => this.updateSizing();
    win.addEventListener("resize", this.onResize);
    win.addEventListener("sizemodechange", this.onResize);
    this.screen.addEventListener?.("change", this.onResize);
    const sizingObserver = new win.MutationObserver(this.onResize);
    for (const { pane, splitter } of this.widthTargets) {
      sizingObserver.observe(pane, { attributes: true, attributeFilter: ["class"] });
      sizingObserver.observe(splitter, { attributes: true, attributeFilter: ["orient"] });
    }
    this.observers.push(sizingObserver);
    this.updateSizing();
    this.mount("library", "zotero-item-pane");
    this.mount("reader", "zotero-context-pane-inner");
    this.bindSelection();
    this.update();
  }

  mount(type, id) {
    const host = this.doc.getElementById(id);
    if (!host) return;
    const body = this.doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
    body.className = "aip-chat-host";
    host.append(body);
    host.classList.add("aip-chat-replaced");
    this.hosts.push(host);
    const panel = new AIPaperSidebar(this.runtime, { body, doc: this.doc, tabType: type, layout: this });
    this.panels.set(type, panel);
    this.runtime.panels.set(body, panel);
    const observer = new this.win.MutationObserver(() => {
      this.bindSelection();
      this.scheduleUpdate();
    });
    observer.observe(host, { attributes: true, attributeFilter: ["view-type", "collapsed"] });
    this.observers.push(observer);
  }

  bindSelection() {
    const view = this.win.ZoteroPane?.itemsView;
    if (!view?.onSelect || this.view === view) return;
    this.view?.onSelect.removeListener(this.onSelect);
    this.view = view;
    view.onSelect.addListener(this.onSelect);
  }

  updateSizing() {
    if (this.destroyed || this.win.closed) return;
    const width = this.screen.availWidth || this.win.innerWidth;
    const root = this.doc.documentElement;
    const limits = { "--aip-pane-min-width": Math.ceil(width / 4), "--aip-pane-max-width": Math.floor(width / 2) };
    for (const [name, value] of Object.entries(limits)) {
      const pixels = value + "px";
      if (root.style.getPropertyValue(name) !== pixels) root.style.setProperty(name, pixels);
    }
    for (const { pane, splitter } of this.widthTargets) {
      const horizontal = splitter.getAttribute("orient") === "horizontal" && !pane.classList.contains("stacked");
      pane.classList.toggle("aip-resizable-pane", horizontal);
    }
  }

  scheduleUpdate() {
    if (this.timer || this.destroyed) return;
    this.timer = setTimeout(() => { this.timer = null; this.update(); }, 0);
  }

  update() {
    if (this.destroyed || this.win.closed) return;
    this.bindSelection();
    this.updateSizing();
    const items = this.win.ZoteroPane?.itemsView ? this.win.ZoteroPane.getSelectedItems() : [];
    this.panels.get("library")?.update(this.runtime.contextForItem(items.length === 1 ? items[0] : null));
    const tabID = this.win.Zotero_Tabs?.selectedID;
    const reader = tabID && Zotero.Reader.getByTabID(tabID);
    this.panels.get("reader")?.update(this.runtime.contextForItem(reader ? Zotero.Items.get(reader.itemID) : null));
  }

  collapse(type) {
    if (type === "library") this.win.ZoteroPane.toggleItemPane();
    else this.win.ZoteroContextPane.togglePane();
  }

  expand(type) {
    if (type === "library") {
      const host = this.doc.getElementById("zotero-item-pane");
      if (host?.collapsed) this.win.ZoteroPane.toggleItemPane();
    }
    else this.win.ZoteroContextPane.collapsed = false;
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.win.removeEventListener("unload", this.onUnload);
    this.win.removeEventListener("resize", this.onResize);
    this.win.removeEventListener("sizemodechange", this.onResize);
    this.screen.removeEventListener?.("change", this.onResize);
    clearTimeout(this.timer);
    this.view?.onSelect.removeListener(this.onSelect);
    for (const observer of this.observers) observer.disconnect();
    for (const panel of this.panels.values()) {
      panel.destroy();
      this.runtime.panels.delete(panel.body);
      panel.body.remove();
    }
    for (const host of this.hosts) host.classList.remove("aip-chat-replaced");
    for (const { pane } of this.widthTargets) pane.classList.remove("aip-resizable-pane");
    this.doc.documentElement.style.removeProperty("--aip-pane-min-width");
    this.doc.documentElement.style.removeProperty("--aip-pane-max-width");
    this.doc.documentElement.classList.remove("aip-layout");
    this.link.remove();
  }
};
