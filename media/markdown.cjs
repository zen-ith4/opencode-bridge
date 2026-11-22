/**
 * OpenCode Bridge - dependency-free Markdown renderer for the webview.
 *
 * Used by `media/webview.js` (global `OcMarkdown`) and by the Node unit tests
 * (`require("../media/markdown.cjs")`).
 *
 * Rules:
 *  - Everything is HTML-escaped first, then a small, explicit set of block
 *    and inline constructs is rendered. Raw HTML is never passed through.
 *  - Only http(s):// and mailto: links are turned into anchors.
 *  - Code fences are parsed as real fenced blocks (language + body). The
 *    optional `renderCodeBlock(lang, code)` callback receives the RAW code so
 *    callers can store it for a lossless Copy button.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.OcMarkdown = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function escapeAttr(value) {
    return escapeHtml(value).replace(/`/g, "&#96;");
  }

  function isSafeUrl(url) {
    return /^(https?:\/\/|mailto:)/i.test(String(url || "").trim());
  }

  function defaultCodeBlock(lang, code) {
    var cls = lang ? ' class="language-' + escapeAttr(lang) + '"' : "";
    return "<pre><code" + cls + ">" + escapeHtml(code) + "</code></pre>";
  }

  var TOKEN_PREFIX = "\u0000OCT";
  var TOKEN_SUFFIX = "\u0000";

  function renderInline(raw) {
    var text = escapeHtml(raw);
    var tokens = [];

    function stash(html) {
      var key = TOKEN_PREFIX + tokens.length + TOKEN_SUFFIX;
      tokens.push(html);
      return key;
    }

    // Inline code first (so * and _ inside it are literal).
    text = text.replace(/`([^`\n]+)`/g, function (_match, code) {
      return stash("<code>" + code + "</code>");
    });

    // Links. href is checked against the whitelist after un-escaping &amp;.
    text = text.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, function (match, label, url) {
      var decoded = url.replace(/&amp;/g, "&");
      if (!isSafeUrl(decoded)) return match;
      return stash(
        '<a href="' +
          escapeAttr(decoded) +
          '" data-external="1" rel="noopener noreferrer">' +
          label +
          "</a>"
      );
    });

    // Bold, then italic.
    text = text.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
    text = text.replace(/__([^_\n]+)__/g, "<strong>$1</strong>");
    text = text.replace(/\*([^*\n]+)\*/g, "<em>$1</em>");
    text = text.replace(/(^|[^_\w])_([^_\n]+)_(?!_)/g, "$1<em>$2</em>");

    return text.replace(/\u0000OCT(\d+)\u0000/g, function (_match, index) {
      return tokens[Number(index)] || "";
    });
  }

  function splitTableRow(line) {
    var trimmed = String(line).trim();
    if (trimmed.charAt(0) === "|") trimmed = trimmed.slice(1);
    if (trimmed.charAt(trimmed.length - 1) === "|") trimmed = trimmed.slice(0, -1);
    return trimmed.split("|").map(function (cell) {
      return cell.trim();
    });
  }

  function isTableSeparator(line) {
    return /^\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(line);
  }

  function isFenceStart(line) {
    return /^\s*```/.test(line);
  }

  function startsBlock(lines, index) {
    var line = lines[index];
    if (line === undefined) return false;
    if (/^\s*$/.test(line)) return true;
    if (isFenceStart(line)) return true;
    if (/^#{1,6}\s+/.test(line)) return true;
    if (/^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) return true;
    if (/^\s*>\s?/.test(line)) return true;
    if (/^\s*[-*+]\s+/.test(line)) return true;
    if (/^\s*\d+[.)]\s+/.test(line)) return true;
    if (/\|/.test(line) && index + 1 < lines.length && isTableSeparator(lines[index + 1])) return true;
    return false;
  }

  function renderMarkdown(input, options) {
    options = options || {};
    var codeRenderer = options.renderCodeBlock || defaultCodeBlock;
    var source = String(input == null ? "" : input).replace(/\r\n?/g, "\n");
    var lines = source.split("\n");
    var out = [];
    var paragraph = [];
    var i = 0;

    function flushParagraph() {
      if (!paragraph.length) return;
      out.push("<p>" + paragraph.map(renderInline).join("<br>") + "</p>");
      paragraph = [];
    }

    while (i < lines.length) {
      var line = lines[i];

      // Fenced code block.
      var fence = /^\s*```([^\s`]*)\s*$/.exec(line);
      if (fence) {
        flushParagraph();
        var lang = fence[1] || "";
        i += 1;
        var body = [];
        while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
          body.push(lines[i]);
          i += 1;
        }
        if (i < lines.length) i += 1; // consume closing fence
        out.push(codeRenderer(lang, body.join("\n")));
        continue;
      }

      if (/^\s*$/.test(line)) {
        flushParagraph();
        i += 1;
        continue;
      }

      // Headings.
      var heading = /^(#{1,6})\s+(.*)$/.exec(line);
      if (heading) {
        flushParagraph();
        var level = heading[1].length;
        out.push("<h" + level + ">" + renderInline(heading[2].trim()) + "</h" + level + ">");
        i += 1;
        continue;
      }

      // Horizontal rule.
      if (/^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
        flushParagraph();
        out.push("<hr>");
        i += 1;
        continue;
      }

      // Blockquote.
      if (/^\s*>\s?/.test(line)) {
        flushParagraph();
        var quote = [];
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
          quote.push(lines[i].replace(/^\s*>\s?/, ""));
          i += 1;
        }
        out.push("<blockquote>" + renderMarkdown(quote.join("\n"), options) + "</blockquote>");
        continue;
      }

      // Simple table: header row + separator row.
      if (/\|/.test(line) && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
        flushParagraph();
        var header = splitTableRow(line);
        i += 2;
        var rows = [];
        while (i < lines.length && /\|/.test(lines[i]) && !/^\s*$/.test(lines[i])) {
          rows.push(splitTableRow(lines[i]));
          i += 1;
        }
        var html = '<div class="table-wrap"><table><thead><tr>';
        for (var h = 0; h < header.length; h += 1) {
          html += "<th>" + renderInline(header[h]) + "</th>";
        }
        html += "</tr></thead><tbody>";
        for (var r = 0; r < rows.length; r += 1) {
          html += "<tr>";
          for (var c = 0; c < header.length; c += 1) {
            html += "<td>" + renderInline(rows[r][c] || "") + "</td>";
          }
          html += "</tr>";
        }
        html += "</tbody></table></div>";
        out.push(html);
        continue;
      }

      // Unordered list.
      if (/^\s*[-*+]\s+/.test(line)) {
        flushParagraph();
        var ul = [];
        while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
          ul.push(lines[i].replace(/^\s*[-*+]\s+/, ""));
          i += 1;
        }
        out.push(
          "<ul>" +
            ul
              .map(function (item) {
                return "<li>" + renderInline(item) + "</li>";
              })
              .join("") +
            "</ul>"
        );
        continue;
      }

      // Ordered list.
      if (/^\s*\d+[.)]\s+/.test(line)) {
        flushParagraph();
        var ol = [];
        while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
          ol.push(lines[i].replace(/^\s*\d+[.)]\s+/, ""));
          i += 1;
        }
        out.push(
          "<ol>" +
            ol
              .map(function (item) {
                return "<li>" + renderInline(item) + "</li>";
              })
              .join("") +
            "</ol>"
        );
        continue;
      }

      // Paragraph text (stop at the next block start or blank line).
      paragraph.push(line);
      i += 1;
      while (i < lines.length && !startsBlock(lines, i)) {
        paragraph.push(lines[i]);
        i += 1;
      }
      flushParagraph();
    }

    flushParagraph();
    return out.join("\n");
  }

  return {
    escapeHtml: escapeHtml,
    escapeAttr: escapeAttr,
    isSafeUrl: isSafeUrl,
    renderInline: renderInline,
    renderMarkdown: renderMarkdown,
    defaultCodeBlock: defaultCodeBlock,
  };
});
