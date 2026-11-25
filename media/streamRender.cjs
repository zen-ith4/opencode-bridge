/**
 * Incremental streaming-render helpers for the webview.
 *
 * The old renderer re-parsed the entire answer and replaced `innerHTML` on
 * every `session.text.delta` event, which is O(n^2) and freezes the UI on a
 * long story. This module keeps the expensive work bounded:
 *
 *  - `splitStableBlocks()` finds completed top-level Markdown blocks (a blank
 *    line outside a fenced code block). The webview renders those once and
 *    appends the HTML.
 *  - Only the still-open tail is re-rendered on each animation frame.
 *  - `createRenderScheduler()` coalesces any number of deltas into at most
 *    one render per frame.
 *  - Above a configurable cap the live Markdown renderer stops entirely and
 *    the caller can show a plain-text tail instead.
 *
 * No DOM APIs are used here, so Node tests can exercise the exact same code
 * the webview loads (global `OcStream`).
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.OcStream = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  /** Stop live Markdown rendering beyond this many characters. */
  var DEFAULT_CAP = 200000;
  /** How much plain text the capped view keeps visible. */
  var DEFAULT_TAIL_CHARS = 20000;

  /**
   * Split text into completed top-level blocks and the open tail.
   * A blank line inside a fenced code block is NOT a boundary.
   */
  function splitStableBlocks(input) {
    var text = String(input == null ? "" : input);
    var fenceOpen = false;
    var lastBoundary = 0;
    var index = 0;

    while (index < text.length) {
      var newline = text.indexOf("\n", index);
      var lineEnd = newline === -1 ? text.length : newline;
      var line = text.slice(index, lineEnd);

      if (!fenceOpen && /^\s*```/.test(line)) {
        fenceOpen = true;
      } else if (fenceOpen && /^\s*```\s*$/.test(line)) {
        fenceOpen = false;
      } else if (!fenceOpen && /^\s*$/.test(line)) {
        lastBoundary = newline === -1 ? text.length : newline + 1;
      }

      if (newline === -1) break;
      index = newline + 1;
    }

    return {
      stable: text.slice(0, lastBoundary),
      open: text.slice(lastBoundary),
    };
  }

  function tailOf(input, maxChars) {
    var text = String(input == null ? "" : input);
    var max = maxChars > 0 ? maxChars : DEFAULT_TAIL_CHARS;
    if (text.length <= max) return text;
    return text.slice(text.length - max);
  }

  /**
   * Tracks accumulated stream text plus what has already been rendered.
   * `snapshot()` is pure; call `commit(snapshot)` only after the DOM update.
   */
  function createAccumulator(options) {
    options = options || {};
    var cap = options.cap > 0 ? options.cap : DEFAULT_CAP;
    var tailChars = options.tailChars > 0 ? options.tailChars : DEFAULT_TAIL_CHARS;
    var state = {
      text: "",
      open: "",
      renderedStableLength: 0,
      capped: false,
      reset: false,
    };

    function reset() {
      state.text = "";
      state.open = "";
      state.renderedStableLength = 0;
      state.capped = false;
      state.reset = true;
    }

    function resync(fullText) {
      state.text = String(fullText == null ? "" : fullText);
      state.open = "";
      state.renderedStableLength = 0;
      state.capped = false;
      state.reset = true;
    }

    function append(delta) {
      if (delta == null) return;
      state.text += String(delta);
      state.reset = false;
    }

    function snapshot() {
      var text = state.text;
      if (text.length > cap) {
        return {
          capped: true,
          enteredCap: !state.capped,
          length: text.length,
          text: text,
          tail: tailOf(text, tailChars),
          stableDelta: "",
          stableTotal: state.renderedStableLength,
          open: "",
          openChanged: false,
          reset: state.reset,
        };
      }

      var split = splitStableBlocks(text);
      var stableDelta = "";
      var reset = state.reset;
      if (reset || split.stable.length < state.renderedStableLength) {
        stableDelta = split.stable;
        reset = true;
      } else if (split.stable.length > state.renderedStableLength) {
        stableDelta = split.stable.slice(state.renderedStableLength);
      }

      return {
        capped: false,
        enteredCap: state.capped,
        length: text.length,
        text: text,
        tail: "",
        stableDelta: stableDelta,
        stableTotal: split.stable.length,
        open: split.open,
        openChanged: split.open !== state.open,
        reset: reset,
      };
    }

    function commit(snapshotValue) {
      if (!snapshotValue) return;
      if (snapshotValue.capped) {
        state.capped = true;
        state.reset = false;
        return;
      }
      state.renderedStableLength = Math.max(
        state.renderedStableLength,
        snapshotValue.stableTotal || 0
      );
      state.open = snapshotValue.open || "";
      state.capped = false;
      state.reset = false;
    }

    return {
      append: append,
      resync: resync,
      reset: reset,
      snapshot: snapshot,
      commit: commit,
      length: function () {
        return state.text.length;
      },
      text: function () {
        return state.text;
      },
      isCapped: function () {
        return state.capped;
      },
      cap: cap,
      tailChars: tailChars,
    };
  }

  /**
   * Coalesce schedule() calls into at most one flush per animation frame.
   * `flushNow()` supersedes any pending frame (used for the final render).
   */
  function createRenderScheduler(options) {
    options = options || {};
    var flush = options.flush;
    var requestFrame =
      options.requestFrame ||
      function (callback) {
        return setTimeout(callback, 16);
      };
    var scheduled = false;
    var generation = 0;
    var flushes = 0;

    function schedule() {
      if (scheduled) return false;
      scheduled = true;
      var token = generation;
      requestFrame(function () {
        if (token !== generation) return;
        scheduled = false;
        flushes += 1;
        flush(false);
      });
      return true;
    }

    function flushNow() {
      generation += 1;
      scheduled = false;
      flushes += 1;
      flush(true);
    }

    return {
      schedule: schedule,
      flushNow: flushNow,
      isScheduled: function () {
        return scheduled;
      },
      flushes: function () {
        return flushes;
      },
    };
  }

  return {
    DEFAULT_CAP: DEFAULT_CAP,
    DEFAULT_TAIL_CHARS: DEFAULT_TAIL_CHARS,
    splitStableBlocks: splitStableBlocks,
    tailOf: tailOf,
    createAccumulator: createAccumulator,
    createRenderScheduler: createRenderScheduler,
  };
});
