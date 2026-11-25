/**
 * Pure UI state helpers shared by the webview and Node tests.
 *
 * Keeping Esc priority, toolbar collapse thresholds, attachment dedupe and
 * the auto-follow state machine here means the interaction rules can be
 * unit-tested without a DOM (the webview only wires these to elements).
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.OcUiState = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  /**
   * Esc priority: an open popover/palette wins, then Stop, then nothing.
   * @returns {"close-overlay"|"stop"|"none"}
   */
  function escapeAction(state) {
    var value = state || {};
    if (value.overlayOpen) return "close-overlay";
    if (value.generating) return "stop";
    return "none";
  }

  /** Toolbar mode is driven by the composer width (not the window). */
  function toolbarMode(width) {
    var w = Number(width) || 0;
    return { compact: w < 340, tiny: w < 260 };
  }

  /** Deduplicate attachments by URI, preserving first-seen order. */
  function dedupeAttachments(list, additions) {
    var seen = Object.create(null);
    var out = [];
    function add(att) {
      if (!att || typeof att.uri !== "string" || !att.uri) return;
      if (seen[att.uri]) return;
      seen[att.uri] = true;
      out.push(att);
    }
    (Array.isArray(list) ? list : []).forEach(add);
    (Array.isArray(additions) ? additions : []).forEach(add);
    return out;
  }

  /**
   * stickToBottom changes only through user scrolls (or an explicit pin).
   * Content growth schedules at most one scroll per animation frame.
   */
  function createScrollFollow(options) {
    var opts = options || {};
    var threshold = typeof opts.threshold === "number" ? opts.threshold : 24;
    var requestFrame =
      typeof opts.requestFrame === "function"
        ? opts.requestFrame
        : function (callback) {
            callback();
          };
    var stick = true;
    var queued = false;

    function schedule() {
      if (queued) return false;
      queued = true;
      requestFrame(function () {
        queued = false;
        if (stick && typeof opts.scrollToBottom === "function") opts.scrollToBottom();
      });
      return true;
    }

    function pin() {
      var changed = !stick;
      stick = true;
      schedule();
      if (changed && typeof opts.onStickChange === "function") opts.onStickChange(stick);
    }

    /** User scroll: only this (or pin) flips the flag. */
    function onUserScroll(distance) {
      var next = Number(distance) <= threshold;
      var changed = next !== stick;
      stick = next;
      if (changed && typeof opts.onStickChange === "function") opts.onStickChange(stick);
      return stick;
    }

    /** Content grew (text, thinking, tools, permission cards, banners...). */
    function onContentResize() {
      if (!stick) return false;
      return schedule();
    }

    function setStuck(value) {
      stick = !!value;
    }

    return {
      pin: pin,
      onUserScroll: onUserScroll,
      onContentResize: onContentResize,
      isStuck: function () {
        return stick;
      },
      setStuck: setStuck,
    };
  }

  return {
    escapeAction: escapeAction,
    toolbarMode: toolbarMode,
    dedupeAttachments: dedupeAttachments,
    createScrollFollow: createScrollFollow,
  };
});
