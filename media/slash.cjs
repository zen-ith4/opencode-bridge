/**
 * OpenCode Bridge - pure slash-command palette helpers.
 *
 * Shared by `media/webview.js` (global `OcSlash`) and the Node unit tests
 * (`require("../media/slash.cjs")`).
 *
 * The composer opens the palette only while the whole input is a single
 * `/name` token (no spaces). Filtering matches the command name or the
 * description, case-insensitively.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.OcSlash = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var QUERY_RE = /^\/([a-zA-Z0-9_-]*)$/;

  /** Returns the lowercase filter text for a composer value, or null. */
  function slashQuery(value) {
    var match = QUERY_RE.exec(String(value == null ? "" : value));
    return match ? match[1].toLowerCase() : null;
  }

  /** Filter candidates by name/description. An empty query keeps all. */
  function filterSlashItems(candidates, query) {
    var q = String(query == null ? "" : query).toLowerCase();
    var items = Array.isArray(candidates) ? candidates : [];
    return items.filter(function (item) {
      if (!item || typeof item.name !== "string") return false;
      var hay = (item.name + " " + (item.description || "")).toLowerCase();
      return !q || hay.indexOf(q) !== -1;
    });
  }

  return {
    slashQuery: slashQuery,
    filterSlashItems: filterSlashItems,
  };
});
