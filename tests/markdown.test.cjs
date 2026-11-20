const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("../addon/content/core.js");

test("Markdown renders nested lists, tables, quotes and safe links", () => {
  const output = core.markdownHTML("# 研究结果\n\n**重点**与*说明*\n\n- 一级\n  - 二级\n\n> 引文\n\n| 指标 | 结果 |\n| --- | --- |\n| 样本 | 40 |\n\n[论文](https://example.com/paper)\n");
  assert.ok(output.includes("<strong>重点</strong>"));
  assert.ok(output.includes("<em>说明</em>"));
  assert.equal((output.match(/<ul>/g) || []).length, 2);
  assert.ok(output.includes("<blockquote>"));
  assert.ok(output.includes('<div class="aip-table-scroll"><table>'));
  assert.ok(output.includes('<a href="https://example.com/paper">论文</a>'));
});

test("Markdown separators and hard breaks use XML-compatible tags for answers and notes", () => {
  const source = "第一行  \n下一行\n\n---\n\n公式 $E=mc^2$";
  for (const note of [false, true]) {
    const output = core.markdownHTML(source, { note });
    assert.match(output, /<br\s*\/>/);
    assert.match(output, /<hr\s*\/>/);
    assert.doesNotMatch(output, /<(?:br|hr)>/);
    assert.match(output, note ? /<span class="math">/ : /<math\b/);
  }
});

test("the renderer replaces XML-forbidden characters and preserves Unicode text", () => {
  const output = core.markdownHTML("论文📖\u000b样本\ud800数量\ufffe\n\n下一节");
  assert.ok(output.includes("论文📖\ufffd样本\ufffd数量\ufffd"));
  assert.ok(output.includes("<p>下一节</p>"));
});

test("all four common math delimiters preserve TeX and produce native MathML", () => {
  const source = String.raw`行内 \(\alpha_i\) 与 $x_1^2$。

\[
\frac{a}{b}+\sqrt{x}
\]

$$\sum_{i=1}^{N}x_i$$`;
  const output = core.markdownHTML(source);
  assert.equal((output.match(/<math /g) || []).length, 4);
  assert.ok(output.includes("<mfrac>"));
  assert.ok(output.includes("<msqrt>"));
  assert.ok(output.includes("<msubsup>"));
  assert.ok(output.includes(String.raw`<annotation encoding="application/x-tex">\alpha_i</annotation>`));
  assert.ok(!output.includes("aip-math-source"));
});

test("numbered equations, matrices, aligned expressions and math fences render", () => {
  const source = String.raw`\[
\mathbf{X}=\begin{bmatrix}a&b\\c&d\end{bmatrix}\tag{3}
\]

\begin{aligned}a&=b+c\\d&=e\end{aligned}

$$E=mc^2$$ (4)

` + "```math\n\\int_0^1 x^2\\,dx\n```";
  const output = core.markdownHTML(source);
  assert.equal((output.match(/<math /g) || []).length, 4);
  assert.ok(output.includes("<mtable"));
  assert.ok(output.includes(String.raw`\tag{3}`));
  assert.ok(output.includes(String.raw`\tag{4}`));
  assert.ok(!output.includes("aip-math-source"));
});

test("math inside inline code and code fences stays literal and currency stays text", () => {
  const output = core.markdownHTML('`$x_1$`\n\n```latex\n\\[x^2\\]\n```\n\n价格 $5 和 $10，转义符号 \\$。');
  assert.ok(!output.includes("<math"));
  assert.ok(output.includes("<code>$x_1$</code>"));
  assert.ok(output.includes('class="language-latex"'));
  assert.ok(output.includes("价格 $5 和 $10"));
});

test("invalid math remains readable and rendered Markdown cannot introduce active HTML", () => {
  const source = String.raw`\(\notARealCommand{x}\)

\(\href{javascript:alert(1)}{x}\)

[bad](javascript:alert(1))

![external](https://example.com/image.png)

<script>alert(1)</script>`;
  const output = core.markdownHTML(source);
  assert.ok(output.includes("aip-math-source"));
  assert.ok(output.includes(String.raw`\notARealCommand{x}`));
  assert.ok(!/<(?:script|img|iframe)\b/i.test(output));
  assert.ok(!/<a\b[^>]*href="javascript:/i.test(output));
});

test("note exports preserve formulas in Zotero native editable math nodes", () => {
  const output = core.markdownHTML(String.raw`变量 \(\alpha_i\)。

\[\frac{a}{b}\]`, { note: true });
  assert.ok(output.includes(String.raw`<span class="math">$\alpha_i$</span>`));
  assert.ok(output.includes(String.raw`<pre class="math">$$\frac{a}{b}$$</pre>`));
  assert.ok(!output.includes("<math"));
});

test("math macros are shared within one answer and isolated from later answers", () => {
  const first = core.markdownHTML(String.raw`\(\gdef\paperVector{\mathbf{x}}\paperVector\) 与 \(\paperVector\)`);
  assert.ok(!first.includes("aip-math-source"));
  assert.ok(core.markdownHTML(String.raw`\(\paperVector\)`).includes("aip-math-source"));
});

test("every question requests Markdown and the paper's original mathematical notation", () => {
  const messages = core.chatMessages({ source: "PDF", metadata: "Paper", text: "x" }, { prompt: "总结" }, [], "分析", 20000);
  assert.ok(messages[0].content.includes("Markdown"));
  assert.ok(messages[0].content.includes("上下标"));
  assert.ok(messages[0].content.includes("公式提取不完整"));
  assert.ok(messages[0].content.includes(String.raw`\tag{}`));
});
