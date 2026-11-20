"use strict";

var AIPaperReaderFit = (() => {
  const label = "适合内容宽度";
  const margin = 8;
  const cssUnits = 96 / 72;
  const verticalScroll = 0;
  const singlePages = 0;
  const fitEvents = ["scalechanging", "scrollmodechanged", "spreadmodechanged"];
  const contentEvents = ["rotationchanging", "optionalcontentconfigchanged"];
  const fitCSS = `
    #viewerContainer.aip-fit-width { overflow-x: hidden; }
    #viewerContainer.aip-fit-width .pdfViewer {
      align-items: flex-start;
      padding-inline: 0;
      overflow-x: clip;
    }
    #viewerContainer.aip-fit-width .pdfViewer .page {
      margin-left: calc(50% - var(--aip-fit-center, 0px) * var(--scale-factor));
    }
  `;

  function contentBounds(canvas, context, viewport, scale, pageWidth) {
    const { width, height } = canvas;
    const { data } = context.getImageData(0, 0, width, height);
    let left = width;
    let right = 0;
    for (let y = 0, i = 0; y < height; y++) {
      for (let x = 0; x < width; x++, i += 4) {
        if (data[i] >= 248 && data[i + 1] >= 248 && data[i + 2] >= 248) continue;
        left = Math.min(left, x);
        right = Math.max(right, x + 1);
      }
    }
    if (left >= right) return { width: 0, center: pageWidth / 2, pageWidth };
    // Expand by one sample pixel to allow for thin anti-aliased marks at the edge.
    left = Math.max(0, left - 1) / scale;
    right = Math.min(viewport.width, right + 1) / scale;
    return { width: right - left, center: (left + right) / 2, pageWidth };
  }

  async function measurePages(session, job, rotation, layers) {
    const { doc, win, pdf } = session;
    const canvas = doc.createElement("canvas");
    const context = canvas.getContext("2d", { alpha: false, willReadFrequently: true });
    const pages = [];
    try {
      for (let number = 1; number <= pdf.numPages; number++) {
        const page = Cu.waiveXrays(await pdf.getPage(number));
        if (job !== session.job) return null;
        const angle = (page.rotate + rotation) % 360;
        const base = page.getViewport(Cu.cloneInto({ scale: 1, rotation: angle }, win));
        const scale = 512 / Math.max(base.width, base.height);
        const viewport = page.getViewport(Cu.cloneInto({ scale, rotation: angle }, win));
        canvas.width = Math.max(1, Math.ceil(viewport.width));
        canvas.height = Math.max(1, Math.ceil(viewport.height));
        const options = Cu.waiveXrays(Cu.cloneInto({ background: "#ffffff", annotationMode: 0 }, win));
        options.canvas = canvas;
        options.canvasContext = context;
        options.viewport = viewport;
        options.optionalContentConfigPromise = layers;
        job.render = page.render(options);
        await job.render.promise;
        job.render = null;
        if (job !== session.job) return null;
        pages.push(contentBounds(canvas, context, viewport, scale, base.width));
      }
      const widest = pages.reduce((width, page) => Math.max(width, page.width), 0);
      return { pages, width: widest || pages.reduce((width, page) => Math.max(width, page.pageWidth), 0) };
    }
    finally {
      if (!Cu.isDeadWrapper(canvas)) canvas.width = canvas.height = 0;
    }
  }

  return class {
    constructor(reader, doc) {
      this.reader = reader;
      this.doc = doc;
      this.session = null;
      this.cache = null;
      this.button = doc.createElement("button");
      this.button.id = "aip-fit-content-width";
      this.button.className = "toolbar-button aip-fit-content";
      this.button.type = "button";
      this.button.setAttribute("aria-label", label);
      this.button.dataset.tabstop = "1";
      this.button.innerHTML = `<svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor"
        stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M1.75 3.5v9m12.5-9v9M4.5 8h7m-5-2L4.5 8l2 2m3-4 2 2-2 2"/>
      </svg>`;
      this.setPressed(false);
      this.click = () => this.toggle();
      this.button.addEventListener("click", this.click);
      const place = () => {
        const tools = doc.querySelector(".toolbar > .center.tools");
        if (!tools) return;
        const ink = tools.querySelector("button.ink");
        if (ink) {
          if (ink.nextElementSibling !== this.button) ink.after(this.button);
        }
        else if (this.button.parentNode !== tools) {
          tools.insertBefore(this.button, tools.querySelector(".divider, .toolbar-dropdown-button"));
        }
      };
      this.toolbarObserver = new doc.defaultView.MutationObserver(place);
      this.toolbarObserver.observe(doc.querySelector(".toolbar"), { childList: true, subtree: true });
      place();
    }

    setPressed(pressed) {
      if (Cu.isDeadWrapper(this.button)) return;
      this.button.setAttribute("aria-pressed", String(pressed));
      this.button.title = pressed ? "关闭适合内容宽度" : label;
      this.button.classList.toggle("active", pressed);
    }

    toggle() {
      if (this.session) {
        this.stop();
        return;
      }
      const primary = this.reader._internalReader?._primaryView;
      const view = primary?._iframeWindow
        || this.doc.querySelector('iframe[src*="pdf/web/viewer.html"]')?.contentWindow;
      if (!view) return;
      const win = Cu.unwaiveXrays(view);
      const doc = win.document;
      const container = doc.getElementById("viewerContainer");
      const app = Cu.waiveXrays(win).PDFViewerApplication;
      const viewer = app?.pdfViewer;
      const pdf = viewer?.pdfDocument;
      if (!container || !pdf || !viewer?.getPageView(0)) return;

      const session = this.session = { win, doc, container, viewer, pdf, initialized: primary?.initializedPromise,
        events: app.eventBus, positioned: new Set() };
      session.fit = () => this.queueFit(session);
      session.measure = () => this.measure(session);
      session.leave = () => this.stop(false);
      session.keepLeft = () => { if (session.prior && container.scrollLeft) container.scrollLeft = 0; };
      session.resize = new win.ResizeObserver(session.fit);
      session.resize.observe(container);
      win.addEventListener("pagehide", session.leave, { once: true });
      container.addEventListener("scroll", session.keepLeft, { passive: true });
      for (const event of fitEvents) session.events.on(event, session.fit);
      for (const event of contentEvents) session.events.on(event, session.measure);
      this.setPressed(true);
      void this.measure(session);
    }

    async measure(session) {
      const previousJob = session.job;
      const job = session.job = {};
      previousJob?.render?.cancel();
      this.button.setAttribute("aria-busy", "true");
      this.button.title = "正在计算 PDF 内容宽度";
      const { viewer, pdf, doc, container } = session;
      try {
        await session.initialized;
        if (job !== session.job) return;
        const rotation = viewer.pagesRotation;
        const layers = viewer.optionalContentConfigPromise;
        if (this.cache?.pdf !== pdf || this.cache.layers !== layers) this.cache = { pdf, layers, rotations: new Map() };
        const cache = this.cache.rotations;
        let bounds = cache.get(rotation);
        if (!bounds) {
          bounds = await measurePages(session, job, rotation, layers);
          if (job !== session.job) return;
          cache.set(rotation, bounds);
        }
        if (!session.prior) {
          session.prior = { zoom: viewer.currentScaleValue ?? "page-width", scroll: viewer.scrollMode, spread: viewer.spreadMode };
          session.style = doc.createElement("style");
          session.style.textContent = fitCSS;
          doc.head.append(session.style);
          container.classList.add("aip-fit-width");
        }
        session.width = bounds.width;
        bounds.pages.forEach((bounds, index) => {
          const page = viewer.getPageView(index)?.div;
          if (!page) return;
          page.style.setProperty("--aip-fit-center", `${bounds.center}px`);
          session.positioned.add(page);
        });
        this.queueFit(session);
        this.button.removeAttribute("aria-busy");
        this.setPressed(true);
      }
      catch (error) {
        if (job !== session.job) return;
        this.stop();
        Zotero.logError(error);
        this.button.title = "无法计算 PDF 内容宽度";
      }
    }

    queueFit(session) {
      if (this.session !== session || session.frame || !session.width) return;
      const { win, container, viewer } = session;
      session.frame = win.requestAnimationFrame(() => {
        session.frame = null;
        const width = container.clientWidth - margin * 2;
        if (width <= 0) return;
        if (viewer.scrollMode !== verticalScroll) viewer.scrollMode = verticalScroll;
        if (viewer.spreadMode !== singlePages) viewer.spreadMode = singlePages;
        const scale = width / (session.width * cssUnits);
        if (Math.abs(viewer.currentScale - scale) > 0.00001) viewer.currentScaleValue = String(scale);
        session.keepLeft();
      });
    }

    stop(restore = true) {
      const session = this.session;
      if (!session) return;
      this.session = null;
      const job = session.job;
      session.job = null;
      const { win, container, viewer, events, prior } = session;
      if (!Cu.isDeadWrapper(this.button)) this.button.removeAttribute("aria-busy");
      this.setPressed(false);
      if (Cu.isDeadWrapper(win)) return;
      job?.render?.cancel();
      session.resize.disconnect();
      if (session.frame) win.cancelAnimationFrame(session.frame);
      win.removeEventListener("pagehide", session.leave);
      container.removeEventListener("scroll", session.keepLeft);
      for (const event of fitEvents) events.off(event, session.fit);
      for (const event of contentEvents) events.off(event, session.measure);
      container.classList.remove("aip-fit-width");
      session.style?.remove();
      for (const page of session.positioned) page.style.removeProperty("--aip-fit-center");
      if (restore && prior && viewer.pdfDocument === session.pdf) {
        viewer.scrollMode = prior.scroll;
        viewer.spreadMode = prior.spread;
        viewer.currentScaleValue = prior.zoom;
      }
    }

    destroy(restore) {
      this.stop(restore);
      this.cache = null;
      if (!Cu.isDeadWrapper(this.toolbarObserver)) this.toolbarObserver.disconnect();
      if (!Cu.isDeadWrapper(this.button)) {
        this.button.removeEventListener("click", this.click);
        this.button.remove();
      }
    }
  };
})();
