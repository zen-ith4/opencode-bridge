/**
 * Cheap, tail-only runaway-output detection.
 *
 * Long model streams occasionally collapse into a degenerate loop: one
 * character repeated forever ("茫茫茫…") or a short pattern repeated for
 * hundreds of characters ("ababab…", "| 1 | 2 |\n| 1 | 2 |…").
 *
 * We only ever inspect the last few hundred characters so this stays O(1)
 * with respect to the total response size. Legitimate short repeats such as
 * a Markdown rule ("----") or a couple of identical code lines are ignored;
 * the pattern branch needs many contiguous repeats *and* a lot of coverage.
 */

export type RepetitionKind = "char-run" | "pattern";

export interface RepetitionHit {
  kind: RepetitionKind;
  /** Number of characters in the repeated region. */
  length: number;
  /** The repeated unit (or the character, for a char run). */
  pattern: string;
  /** How many times the unit repeats (characters for a char run). */
  repeats: number;
}

/** Only the tail is inspected; the rest of the response is irrelevant. */
export const REPETITION_WINDOW = 400;

/** More than 200 copies of the same character (regex below encodes the bound). */
/** Shortest unit considered for the repeated-pattern branch. */
const MIN_PATTERN_LENGTH = 2;
const MAX_PATTERN_LENGTH = 24;

/** A pattern must repeat at least this many times and cover this much text. */
const MIN_PATTERN_REPEATS = 8;
const MIN_PATTERN_COVERAGE = 160;

/**
 * Returns a repetition hit, or null for normal prose/code/tables.
 * Safe to call on every streamed chunk; it only looks at the trailing window.
 */
export function detectRepetition(text: string): RepetitionHit | null {
  const source = String(text ?? "");
  if (source.length < MIN_PATTERN_COVERAGE) return null;

  const windowText = source.slice(-REPETITION_WINDOW);

  // 1. One character repeated more than 200 times. This catches the
  //    reported "茫" runaway and single-character loops in general.
  const run = /([\s\S])\1{200,}/.exec(windowText);
  if (run) {
    return {
      kind: "char-run",
      length: run[0].length,
      pattern: run[1],
      repeats: run[0].length,
    };
  }

  // 2. A short unit repeated contiguously at the very end of the stream.
  //    Requiring both a repeat count and total coverage avoids flagging
  //    ordinary emphasis ("----", "***") or a handful of repeated lines.
  const maxPattern = Math.min(
    MAX_PATTERN_LENGTH,
    Math.floor(windowText.length / MIN_PATTERN_REPEATS)
  );
  for (let size = MIN_PATTERN_LENGTH; size <= maxPattern; size += 1) {
    const unit = windowText.slice(windowText.length - size);
    if (!/\S/.test(unit)) continue; // all-whitespace tail is not a "loop"
    if (/^(.)\1*$/s.test(unit)) continue; // single-character runs are handled above
    let repeats = 1;
    let index = windowText.length - size;
    while (index - size >= 0 && windowText.slice(index - size, index) === unit) {
      repeats += 1;
      index -= size;
    }
    const coverage = repeats * size;
    if (repeats >= MIN_PATTERN_REPEATS && coverage >= MIN_PATTERN_COVERAGE) {
      return {
        kind: "pattern",
        length: coverage,
        pattern: unit,
        repeats,
      };
    }
  }

  return null;
}

/** Human-readable detail for the banner, e.g. `"茫" × 250`. */
export function describeRepetition(hit: RepetitionHit): string {
  const pattern = hit.kind === "char-run" ? `"${hit.pattern}"` : JSON.stringify(hit.pattern);
  if (hit.kind === "char-run") return `${pattern} repeated ${hit.repeats} times`;
  return `${pattern} repeated ${hit.repeats} times (${hit.length} characters)`;
}
