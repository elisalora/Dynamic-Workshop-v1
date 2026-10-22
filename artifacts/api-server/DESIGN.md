# Dynamic Workshop — design system

Pom Pom, 5 October 2026. Branch `pompom/design-system`.

## Start here

**One stylesheet is the system: `workshop.css`.** It carries the tokens and three
primitives (`.plate`, `.display`, `.label`), everything scoped under `.ws`, fonts
self-hosted in `fonts/`. No build step, no CDN.

**Two registers, one palette.**

| | where | what it is |
|---|---|---|
| `.ws` | console, pod, admin | the instruments. Light page, charcoal plates, cardinal used sparingly. Read under pressure by one person who is also walking a room. |
| `.ws.ws-stage` | `board.html` only | the stage. One surface a whole room looks at, in the dark, from the back wall. Same tokens, inverted ground, and the only place in the product allowed to be theatre. |

**Before you change anything, run the guards** from `artifacts/api-server`:

```
python3 tools/check_board_layout.py       # the projected display
python3 tools/check_token_resolution.py   # 34 checks: the system holds together
```

Each has a mutation suite beside it (`tools/mutate_*.py`) that reintroduces a real
defect from this pass and insists the guard goes red. Run those if you change a guard.

## Where the values come from

Lifted, not eyeballed, from `event-platform/src/app/portal.css`, which was itself read
off dafaistudio.com's own stylesheet. The token names are identical on both sides on
purpose: a value change is a copy, and a reader can see at a glance that the Dynamic
Workshop and the event platform are one product rather than two that resemble each other.

| | |
|---|---|
| Canvas | charcoal `--xdark` / `--dark` / `--mdark` |
| Page | `--page`, `--light`, `--white` |
| The only colour | cardinal `--cardinal`, lifted to `--cardinal-lift` on dark |
| Display | **Sentient** 400, `-0.015em`, line-height 1.02 |
| Text and labels | **General Sans** 400/500/600 |

The amber that each page used to carry privately is gone. It was five different
definitions of `--accent` across two repos that are meant to become one thing.

## Rules that are load-bearing

**The base layer is `:where(.ws)`, not `.ws`.** Zero specificity, so any page rule wins
by default. As `.ws` it silently broke two things: `margin: 0` beat the console's
`body { margin: 0 auto }` so the page stopped centring, and `background: var(--page)`
beat `body { background: var(--bg) }` so dark mode darkened every card and left the
page behind them light. Neither was visible in a diff.

**Page adapters go on `.ws` (the body), never on `:root`.** The shared tokens are
declared on `.ws`; custom properties inherit downward only, so an adapter on `:root`
referencing `--cardinal` resolves to the guaranteed-invalid value and every mapped
token dies at once. `background: var(--accent)` then renders transparent — white text
on a white page, no error anywhere.

**Never name a token the same thing in two kinds.** `console.html` used `--text` for a
colour; `workshop.css` uses it for the font stack. Both in scope, nearer wins, loser's
declarations dropped in silence. It is `--ink` now, matching what `pod.html` already
called it. `check_token_resolution.py` fails on any new clash.

**Nothing on the board is sized in `rem`.** Every dimension derives from `--board-w`,
which derives from the viewport. The old headline was `clamp(0.7rem, 2.2vw, 1.3rem)`,
which saturates at its ceiling above ~945px wide, so every projector at every
resolution drew 20.8px letters.

**`--chrome` is a height, and the furniture does not scale with the tile.** Everything
outside the plate is set in viewport units, so the plate gets whatever is left and the
grid can change without the furniture moving. Three versions of this were needed:

1. a flat `vh` constant tuned by hand against 6x22 — pushed the prompts off the bottom
   the moment the geometry changed;
2. the furniture expressed as a count of `--cell` — fixed that, and introduced the
   opposite problem: at 3x15 the tile is bigger, so the furniture grew with it and
   squeezed the plate from 64% of the screen to 59%. The grid change made the headline
   bigger and the board smaller at the same time;
3. a height that does not mention the grid at all. The plate is now **94% of the screen
   at every size tested**, and the guard re-measures the budget at five display sizes,
   three geometries and four prompt counts.

`--chrome: 32vh` is measured, not chosen. 28vh was the first measurement and was 2vh
short: the furniture's clamps hit their minimums on a small viewport, so the chrome is
proportionally *taller* in `vh` there. A height budget has to clear its worst case —
the smallest display and the tallest grid — not the one in front of you.

**Name a retired literal, do not quote it.** Three times in this pass a comment
explaining a defect reproduced its hex or token name, and the guard that greps for that
literal read the comment as the defect. The guards strip comments before scanning now,
and the comments say what the old value was without writing it.

## The board geometry — settled 5 Oct 2026

**3 rows x 15 columns**, the Vestaboard Note. Elisabeth's call, and it closes the seam:
`artifacts/api-server/src/board-format.ts` declares the same numbers, so the module that
formats a topic and the display that draws it now agree rather than each being right on
its own.

The 6x22 in the original came from an intention to drive a **physical** Vestaboard, whose
flagship is that size. No board has been bought. What decided it in software: that module
asks the model for 32 characters or fewer, verifies with `fitsOnBoard()`, allows one
rewrite, and then **drops** a topic that still will not fit rather than cutting it down —
so nothing longer than 3x15 can ever arrive, and 87 of a 6x22 board's 132 tiles could
never light up.

**If a physical board is ever bought:** `--cols` and `--rows` in `board.html` are one
declaration, read by both the CSS and the script, and the guard proves the layout at
3x15, 4x18 and 6x22. `BOARD_ROWS` / `BOARD_COLS` in `board-format.ts` must change in the
same commit, or the generator and the board disagree again — which is the exact state
this pass found them in.

## The console, Rev. B — 22 Oct 2026

**Look at it populated before changing it.** The console builds everything from a
WebSocket snapshot behind Clerk, so every earlier pass only ever saw the empty state.

    python3 tools/render_console.py OUT.png [--theme dark] [--expand t1] [--width 390]

stages `public/`, stubs `auth/config`, `ws-ticket` and the socket, and feeds
`tools/console_fixture.json` (the exact shape `consoleSnapshot()` emits) to the shipped page.
Two harness facts, both measured: headless Chrome does not advance CSS animations (cards
sat at opacity 0, mid-`fadeIn`, 2.5s in), so the harness finishes them; and it will not make
a window narrower than 500px, so below that the page goes in an iframe of the true width.

What the populated render showed, and what changed:

- **The reveal was ~1,700px down the page**, under search. It is now a sticky rail on the
  right (first, on a phone): `Themes for the board`, then search.
- **Purple meant both "session" and "converging".** Sessions are neutral now; the four
  statuses own the four state colours through one token, `--st`, set by `.is-<status>`.
- **Tables are tiles whose edge is the status.** Quiet is also hollow and hatched, so it
  does not depend on hue. Each session header carries a tally, quiet and circling first,
  because those are the tables to walk over to.
- **Rename / Logo / Delete sit behind one More menu.** `▦ Board` is the filled button.

Bugs fixed in the same pass, each reproduced in the harness first:

- **Every session and workshop header button was dead** — Rename, Delete, ✦ Summary, ↺,
  ＋ Session, Logo, and the "Summary available" bar. An inline
  `onclick="event.stopPropagation()"` on the button row stopped the click before the
  delegated handler on the folder could see it. In the code since July.
- On a phone those same buttons ran off the right edge (measured: 9 elements past 390px).
- `No cross-table themes detected yet.` stayed on screen above the first real theme.
- `Edit + Reveal` pre-filled the prompt with the candidate ID, `<sessionId>::<topic>`.
- The search placeholder rendered as `e.g.` — raw `"` inside a `"`-quoted attribute.

Every label `GUIDES/RUNNING_A_WORKSHOP.md` names is unchanged, so the guide still matches.

## Known, not changed

- `pod.html`'s Chatham House notice contains an em dash. Product copy, not mine to
  rewrite in a visual pass.
- `console.html` still uses several emoji glyphs as button furniture. They render in
  whatever face the OS supplies, which is a typeface nobody chose. Removed from
  `admin.html`; left in the console because it is 2,468 lines and worth one pass of its
  own.
