import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const md = require("../media/markdown.cjs");

test("renders every fenced block with its language and keeps surrounding text", () => {
  const input = [
    "before",
    "```js",
    "const a = 1 < 2;",
    "```",
    "middle",
    "```python",
    "print('hi')",
    "```",
    "after",
  ].join("\n");

  const raw = [];
  const html = md.renderMarkdown(input, {
    renderCodeBlock(lang, code) {
      raw.push({ lang, code });
      return `<pre data-lang="${lang}">${md.escapeHtml(code)}</pre>`;
    },
  });

  assert.deepEqual(raw, [
    { lang: "js", code: "const a = 1 < 2;" },
    { lang: "python", code: "print('hi')" },
  ]);
  assert.match(html, /<p>before<\/p>/);
  assert.match(html, /<p>middle<\/p>/);
  assert.match(html, /<p>after<\/p>/);
  assert.ok(!html.includes("<p>const a"), "code must not leak into a paragraph");
  assert.ok(!html.includes("<p>print"), "second code block must not leak into a paragraph");
});

test("default code renderer escapes HTML and marks the language", () => {
  const html = md.renderMarkdown("```html\n<script>alert(1)</script>\n```");
  assert.match(html, /<pre><code class="language-html">/);
  assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
  assert.ok(!html.includes("<script>"));
});

test("handles an unclosed fence", () => {
  const html = md.renderMarkdown("```js\nconst x = 1;");
  assert.match(html, /<pre><code class="language-js">const x = 1;<\/code><\/pre>/);
});

test("renders headings, lists and blockquotes", () => {
  const html = md.renderMarkdown(
    ["# Title", "", "## Sub", "", "- one", "- two", "", "1. first", "2. second", "", "> quoted"].join(
      "\n"
    )
  );
  assert.match(html, /<h1>Title<\/h1>/);
  assert.match(html, /<h2>Sub<\/h2>/);
  assert.match(html, /<ul><li>one<\/li><li>two<\/li><\/ul>/);
  assert.match(html, /<ol><li>first<\/li><li>second<\/li><\/ol>/);
  assert.match(html, /<blockquote><p>quoted<\/p><\/blockquote>/);
});

test("renders bold, italic and inline code", () => {
  const html = md.renderMarkdown("This is **bold**, *italic* and `a < b`.");
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<em>italic<\/em>/);
  assert.match(html, /<code>a &lt; b<\/code>/);
});

test("renders a simple table", () => {
  const html = md.renderMarkdown("| Name | Value |\n| --- | --- |\n| a | 1 |\n| b | 2 |");
  assert.match(html, /<table>/);
  assert.match(html, /<th>Name<\/th>/);
  assert.match(html, /<td>a<\/td>/);
  assert.match(html, /<td>2<\/td>/);
});

test("only allows http, https and mailto links", () => {
  const html = md.renderMarkdown(
    "[ok](https://example.com) [mail](mailto:a@b.c) [bad](javascript:alert(1)) [rel](/local)"
  );
  assert.match(html, /<a href="https:\/\/example\.com"/);
  assert.match(html, /<a href="mailto:a@b\.c"/);
  assert.ok(!html.includes('href="javascript:'));
  assert.ok(!html.includes('href="/local"'));
  assert.match(html, /\[bad\]\(javascript:alert\(1\)\)/);
});

test("escapes raw HTML everywhere", () => {
  const html = md.renderMarkdown('Hello <img src=x onerror="alert(1)"> & bye');
  assert.ok(!html.includes("<img"));
  assert.ok(html.includes("&lt;img"));
  assert.ok(html.includes("&amp;"));
});

test("angle-bracket autolinks are not converted to anchors", () => {
  const html = md.renderMarkdown("<https://example.com>");
  assert.ok(!html.includes("<a "));
  assert.ok(html.includes("&lt;https://example.com&gt;"));
});
