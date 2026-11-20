"use strict";

var AIPaperMarkdown = (() => {
  const MarkdownIt = typeof markdownit === "function" ? markdownit : require("./vendor/markdown-it.js");
  const math = typeof katex === "object" ? katex : require("./vendor/katex.js");
  const tex = typeof texmath === "function" ? texmath : require("./vendor/markdown-it-texmath.js");
  // Zotero inserts the rendered answer into an XHTML document.
  const parser = new MarkdownIt({ html: false, xhtmlOut: true, linkify: true, typographer: false });
  const invalidXMLCharacters = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ud800-\udfff\ufffe\uffff]/gu;
  parser.validateLink = url => /^(https?:|mailto:|#)/i.test(url);
  parser.renderer.rules.image = (tokens, index) => parser.utils.escapeHtml(tokens[index].content);
  parser.use(tex, { engine: math, delimiters: ["dollars", "brackets", "beg_end"] });
  parser.inline.ruler.before("escape", "math_inline_display", tex.inline({
    name: "math_inline_display", tag: "\\[", rex: /\\\[([\s\S]+?)\\\]/gy
  }));

  function renderMath(source, display, environment, inline = false) {
    const escape = parser.utils.escapeHtml;
    if (environment.note) {
      return display ? `<pre class="math">$$${escape(source)}$$</pre>\n`
        : `<span class="math">$${escape(source)}$</span>`;
    }
    const className = display ? "aip-math-block" : "aip-math-inline";
    const tag = display && !inline ? "div" : "span";
    try {
      const rendered = math.renderToString(source, {
        displayMode: display, output: "mathml", throwOnError: true,
        trust: false, strict: false, maxExpand: 1000, maxSize: 30,
        macros: environment.mathMacros
      });
      return `<${tag} class="${className}">${rendered}</${tag}>`;
    }
    catch (_) {
      const original = display ? `\\[${source}\\]` : `\\(${source}\\)`;
      return `<${tag} class="${className} aip-math-source" title="公式暂无法渲染，已保留原始 LaTeX">${escape(original)}</${tag}>`;
    }
  }

  function renderToken(tokens, index, options, environment) {
    const token = tokens[index];
    const display = token.block || ["math_inline_double", "math_inline_display"].includes(token.type);
    const source = token.type === "math_block_eqno" ? `${token.content}\\tag{${token.info}}` : token.content;
    return renderMath(source, display, environment, !token.block);
  }

  for (const name of ["math_inline", "math_inline_double", "math_inline_display", "math_block", "math_block_eqno"]) {
    parser.renderer.rules[name] = renderToken;
  }
  const codeFence = parser.renderer.rules.fence;
  parser.renderer.rules.fence = (tokens, index, options, environment, renderer) => {
    if (tokens[index].info.trim() === "math") return renderMath(tokens[index].content.trim(), true, environment);
    return codeFence(tokens, index, options, environment, renderer);
  };
  parser.renderer.rules.table_open = (tokens, index, options, environment) =>
    environment.note ? "<table>\n" : '<div class="aip-table-scroll"><table>\n';
  parser.renderer.rules.table_close = (tokens, index, options, environment) =>
    environment.note ? "</table>\n" : "</table></div>\n";

  return {
    render(text, options = {}) {
      const rendered = parser.render(String(text), { note: !!options.note, mathMacros: {} });
      return rendered.replace(invalidXMLCharacters, "\ufffd");
    }
  };
})();

if (typeof module !== "undefined") module.exports = AIPaperMarkdown;
