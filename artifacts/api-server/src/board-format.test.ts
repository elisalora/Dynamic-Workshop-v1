import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BOARD_COLS,
  BOARD_ROWS,
  MAX_WORD_CHARS,
  TOPIC_MAX_CHARS,
  fitsOnBoard,
  wrapForBoard,
} from "./board-format.js";

test("geometry is the Vestaboard Note's 3x15", () => {
  assert.equal(BOARD_ROWS, 3);
  assert.equal(BOARD_COLS, 15);
  assert.equal(BOARD_ROWS * BOARD_COLS, 45);
});

test("wraps greedily and uppercases, like the board does", () => {
  assert.deepEqual(wrapForBoard("Nobody wants to own the hand-off"), [
    "NOBODY WANTS TO",
    "OWN THE",
    "HAND-OFF",
  ]);
});

test("collapses runs of whitespace rather than emitting an empty row", () => {
  assert.deepEqual(wrapForBoard("  speed   vs\n\ntrust  "), ["SPEED VS TRUST"]);
});

test("empty and whitespace-only text does not fit", () => {
  assert.equal(fitsOnBoard(""), false);
  assert.equal(fitsOnBoard("   "), false);
});

test("accepts topics at the budget and rejects the ones that overflow", () => {
  const atBudget = "Nobody wants to own the hand-off";
  assert.equal(atBudget.length, TOPIC_MAX_CHARS);
  assert.equal(fitsOnBoard(atBudget), true);

  // Four rows' worth. Over budget, and it genuinely will not lay out.
  assert.equal(fitsOnBoard("Accountability governance requires clear ownership"), false);
});

test("rejects a word too long for a row even when the topic is short", () => {
  const longWord = "x".repeat(MAX_WORD_CHARS + 1);
  assert.ok(longWord.length < TOPIC_MAX_CHARS, "the guard must be word length, not total length");
  assert.equal(fitsOnBoard(longWord), false);
  assert.equal(fitsOnBoard(`the ${longWord}`), false);
});

test("a word exactly MAX_WORD_CHARS long still fits", () => {
  assert.equal(fitsOnBoard("x".repeat(MAX_WORD_CHARS)), true);
});

/**
 * Wrapping depends only on the sequence of word lengths, never on the letters,
 * so the whole space of phrases can be enumerated as integer compositions. This
 * mirrors wrapForBoard on numbers; `wrap model matches wrapForBoard` below
 * checks the two agree before the proof leans on it.
 */
function rowsForWordLengths(words: readonly number[]): number {
  let rows = 0;
  let current = -1; // -1 = no row started
  for (const w of words) {
    const candidate = current < 0 ? w : current + 1 + w;
    if (candidate <= BOARD_COLS) {
      current = candidate;
    } else {
      if (current >= 0) rows++;
      current = w;
    }
  }
  return current >= 0 ? rows + 1 : rows;
}

/** Walks every word-length composition that renders in `limit` characters or fewer. */
function eachComposition(limit: number, visit: (words: readonly number[], rendered: number) => void): number {
  let seen = 0;
  const words: number[] = [];
  const walk = (rendered: number): void => {
    if (words.length) {
      seen++;
      visit(words, rendered);
    }
    for (let w = 1; w <= MAX_WORD_CHARS; w++) {
      const next = words.length ? rendered + 1 + w : w;
      if (next > limit) break;
      words.push(w);
      walk(next);
      words.pop();
    }
  };
  walk(0);
  return seen;
}

test("wrap model matches wrapForBoard", () => {
  // Exhaustive over short phrases — enough to pin the model to the real
  // function, including the ties at exactly BOARD_COLS where greedy wrapping
  // is easiest to get wrong.
  const seen = eachComposition(18, (words) => {
    const text = words.map((n) => "x".repeat(n)).join(" ");
    assert.equal(
      rowsForWordLengths(words),
      wrapForBoard(text).length,
      `model and wrapForBoard disagree on [${words}]`,
    );
  });
  assert.ok(seen > 1000, `expected a broad sample, walked ${seen}`);
});

/**
 * The claim TOPIC_MAX_CHARS rests on: at or under the budget, *every* phrase
 * lays out — not just the ones we happened to think of.
 *
 * This is what would catch someone raising the budget. At 33 characters the
 * composition `1 1 1 1 1 1 1 2 13 2` needs four rows; at 32 nothing does.
 */
test("every phrase within the budget fits in BOARD_ROWS", () => {
  const seen = eachComposition(TOPIC_MAX_CHARS, (words, rendered) => {
    assert.ok(
      rowsForWordLengths(words) <= BOARD_ROWS,
      `[${words}] renders in ${rendered} chars but needs ${rowsForWordLengths(words)} rows`,
    );
  });

  // Guards the guard: if the walk stopped early, the assertions above would
  // have passed vacuously.
  assert.ok(seen > 5_000_000, `expected millions of compositions, walked ${seen}`);
});

test("one character past the budget, a phrase exists that does not fit", () => {
  const counterexample = [1, 1, 1, 1, 1, 1, 1, 2, 13, 2];
  const rendered = counterexample.reduce((n, w) => n + w, counterexample.length - 1);
  assert.equal(rendered, TOPIC_MAX_CHARS + 1);
  assert.equal(rowsForWordLengths(counterexample), BOARD_ROWS + 1);
});
