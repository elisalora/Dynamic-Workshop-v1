/**
 * The geometry of the split-flap board the room reads, and the text rules that
 * fall out of it.
 *
 * Sized to the **Vestaboard Note** — the smaller board — which holds 45
 * characters as 3 rows of 15:
 *   https://www.vestaboard.com/help/dimensions-note
 *
 * Deliberately the smaller of the two boards. The flagship is 6x22 = 132, so
 * anything that lays out on the Note lays out on either; the reverse is not
 * true, and the board a workshop ends up in front of is not knowable here.
 */
export const BOARD_ROWS = 3;
export const BOARD_COLS = 15;

/**
 * The longest word the board can render at all. A longer one fills a row and
 * still has characters left over, and greedy wrapping has nowhere to break it —
 * so it is not "wraps badly", it is "cannot be displayed".
 */
export const MAX_WORD_CHARS = BOARD_COLS;

/**
 * The character budget for a topic headline.
 *
 * Not 45. The grid holds 45 characters but word wrapping never packs it that
 * tightly — every line break forfeits the rest of its row, and how much is
 * forfeited depends entirely on where the word boundaries land.
 *
 * 32 is not a guess or a round number: it is the exact boundary. Enumerating
 * every possible word-length composition (words of 1..15 characters) that
 * renders in 32 characters or fewer — 5,682,602 of them — every single one
 * greedy-wraps into 3 rows or fewer. At 33 characters that stops being true;
 * `1 1 1 1 1 1 1 2 13 2` is the shortest counterexample, and it needs 4 rows.
 *
 * So: at or under 32, a topic always fits the Note. Over it, sometimes.
 * `fitsOnBoard` is still what decides — see the note there.
 */
export const TOPIC_MAX_CHARS = 32;

/**
 * Greedy word wrap, matching what `public/board.html` does to a reveal:
 * uppercase, split on whitespace, fill each row until the next word would not
 * fit. Kept in step with that function on purpose — a check that wraps text
 * differently from the display is not a check.
 */
export function wrapForBoard(text: string): string[] {
  const words = text.toUpperCase().split(/\s+/).filter(Boolean);
  const rows: string[] = [];
  let current = "";

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= BOARD_COLS) {
      current = candidate;
    } else {
      if (current) rows.push(current);
      current = word;
    }
  }
  if (current) rows.push(current);

  return rows;
}

/**
 * Whether `text` lays out on the board without losing anything.
 *
 * This, rather than a character count, is the real gate. The count is what the
 * model is asked to write to; this is what confirms the result actually
 * renders. They agree at or under 32 characters by construction, but the count
 * alone cannot catch a single over-long word — "internationalisation" is 20
 * characters and unrenderable, well inside any 32-character budget.
 */
export function fitsOnBoard(text: string): boolean {
  const rows = wrapForBoard(text);
  if (rows.length === 0) return false;
  return rows.length <= BOARD_ROWS && rows.every((row) => row.length <= BOARD_COLS);
}
