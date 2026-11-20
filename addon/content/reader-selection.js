"use strict";

var AIPaperReaderSelection = class {
  constructor(runtime) {
    this.runtime = runtime;
    this.outlines = new Map();
    this.onPopup = event => this.renderMenu(event);
  }

  pages(reader) {
    const native = reader._internalReader;
    return [...(native?._primaryView?._pages || []), ...(native?._secondaryView?._pages || [])];
  }

  redrawOutlines(reader) {
    for (const page of this.pages(reader)) {
      if (page._layer?._getPageAnnotations(page.pageIndex).some(annotation => annotation.position?.aipOutlinedHighlight)) page.render();
    }
  }

  installOutline(reader) {
    const win = reader._iframeWindow;
    const doc = win && Cu.unwaiveXrays(win.document);
    if (!doc) return false;
    if (this.outlines.has(doc)) return true;
    const page = this.pages(reader).find(entry => entry._pushHighlight && entry._createVectorElement);
    if (!page) return false;
    const prototype = Cu.waiveXrays(Object.getPrototypeOf(page));
    const original = prototype._pushHighlight;
    // Keep Zotero's highlight positions and text. Only change how marked highlights are drawn.
    const outline = Cu.exportFunction(function (items, annotation) {
      const list = Cu.waiveXrays(items);
      const start = list.length;
      Reflect.apply(original, this, [items, annotation]);
      const entry = Cu.waiveXrays(annotation);
      if (!entry.position?.aipOutlinedHighlight) return;
      for (let i = start; i < list.length; i++) {
        const item = list[i];
        if (item.kind !== "rect") continue;
        item.kind = "strokedRect";
        item.stroke = entry.color;
        item.strokeWidth = 1.75;
        item.rx = 1.5;
        item.opacity = 1;
      }
    }, win);
    prototype._pushHighlight = outline;
    this.outlines.set(doc, redraw => {
      if (Cu.isDeadWrapper(prototype) || prototype._pushHighlight !== outline) return;
      prototype._pushHighlight = original;
      if (redraw) this.redrawOutlines(reader);
    });
    this.redrawOutlines(reader);
    return true;
  }

  renderMenu({ reader, doc, params, append }) {
    const selection = params?.annotation;
    if (reader?.type !== "pdf" || !selection?.text?.trim() || !Number.isInteger(selection.position?.pageIndex)) return;
    const menu = doc.createElement("div");
    menu.className = "aip-selection-menu";
    append(menu);
    const popup = menu.closest(".selection-popup");
    const palette = popup?.querySelector(":scope > .colors")?.cloneNode(true);
    if (!palette) { menu.parentElement?.remove(); return; }
    const colors = [...palette.querySelectorAll(".color-button")].map(button => ({
      button, color: button.querySelector("svg [fill^='#']")?.getAttribute("fill")
    })).filter(entry => entry.color);
    if (!colors.length) { menu.parentElement?.remove(); return; }
    const native = reader._internalReader;
    const primary = !popup.closest(".secondary-view");
    const view = native._getActiveView?.(primary) || (primary ? native._primaryView : native._secondaryView);
    const win = doc.defaultView;
    const annotation = JSON.parse(JSON.stringify(Cu.waiveXrays(selection)));
    const excerpt = [...(view?._selectionRanges || [])].filter(range => !range.collapsed && range.text)
      .sort((a, b) => a.position.pageIndex - b.position.pageIndex).map(range => range.text).join("\n\n") || annotation.text;
    let color = [this.color, native?._tools?.highlight?.color, colors[0].color].find(value => colors.some(entry => entry.color === value));
    const updateColors = () => {
      for (const entry of colors) entry.button.setAttribute("aria-pressed", String(color === entry.color));
    };
    palette.setAttribute("role", "group");
    palette.setAttribute("aria-label", "批注颜色");
    for (const entry of colors) {
      entry.button.type = "button";
      entry.button.setAttribute("aria-label", entry.button.title || "批注颜色");
      entry.button.addEventListener("click", () => { this.color = color = entry.color; updateColors(); });
    }
    updateColors();

    const actions = doc.createElement("div");
    actions.className = "aip-selection-actions";
    actions.setAttribute("data-tabstop", "1");
    actions.setAttribute("role", "group");
    actions.setAttribute("aria-label", "选中文字的操作");
    const closeSelection = () => {
      view?.clearSelection?.();
      view?._iframeWindow?.getSelection()?.removeAllRanges();
      if (!view?.clearSelection) view?._setSelectionRanges?.();
      view?._render?.();
    };
    for (const [action, label] of [["highlight", "高亮文本"], ["underline", "下划线文本"], ["quote", "引用文本"]]) {
      const button = doc.createElement("button");
      button.type = "button";
      button.tabIndex = -1;
      button.className = "toolbar-button";
      button.dataset.action = action;
      button.title = label;
      button.setAttribute("aria-label", label);
      const icon = popup.querySelector(`:scope > .tool-toggle .${action} svg`)?.cloneNode(true) || doc.createElement("span");
      if (!icon.childNodes.length) icon.textContent = action === "quote" ? "@" : "A";
      icon.setAttribute("aria-hidden", "true");
      button.append(icon);
      button.addEventListener("click", () => {
        try {
          if (action === "quote") {
            closeSelection();
            this.runtime.addReaderQuote(reader, annotation, excerpt).catch(error => Zotero.logError(error));
          }
          else {
            this.annotate(reader, view, win, annotation, action, color);
            closeSelection();
          }
        }
        catch (error) { Zotero.logError(error); }
      });
      actions.append(button);
    }
    menu.append(palette, actions);
    menu.parentElement.classList.add("aip-selection-section");
    popup.classList.add("aip-selection-popup");
  }

  annotate(reader, view, win, selection, type, color) {
    const native = reader._internalReader;
    const add = annotation => native._annotationManager.addAnnotation(Cu.cloneInto(annotation, win));
    if (type === "underline" || this.installOutline(reader)) {
      const position = { ...selection.position };
      if (type === "highlight") position.aipOutlinedHighlight = true;
      add({ ...selection, type, color, position });
      return;
    }
    // Older PDF readers draw highlights on a canvas. Use their native rectangle annotation there.
    const { pageIndex, rects, nextPageRects } = selection.position;
    for (const [index, lines] of [[pageIndex, rects], [pageIndex + 1, nextPageRects]]) {
      if (!lines?.length) continue;
      const rect = lines.reduce(([left, bottom, right, top], [x1, y1, x2, y2]) =>
        [Math.min(left, x1), Math.min(bottom, y1), Math.max(right, x2), Math.max(top, y2)]);
      const range = view?._selectionRanges?.find(entry => entry.position.pageIndex === index);
      add({ type: "image", color, position: { pageIndex: index, rects: [rect] },
        pageLabel: view?._getPageLabel?.(index, true) || String(index + 1), sortIndex: range?.sortIndex || selection.sortIndex });
    }
  }

  detach(doc, redraw) {
    doc = Cu.unwaiveXrays(doc);
    const restore = this.outlines.get(doc);
    this.outlines.delete(doc);
    restore?.(redraw);
    if (Cu.isDeadWrapper(doc)) return;
    for (const popup of doc.querySelectorAll(".aip-selection-popup")) popup.classList.remove("aip-selection-popup");
    for (const section of doc.querySelectorAll(".aip-selection-section")) section.remove();
  }
};
