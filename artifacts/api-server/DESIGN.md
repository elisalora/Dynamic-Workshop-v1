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
python3 tools/check_board_layout.py       # 58 checks: the projected display
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

**`--extras` is the height budget and it does not depend on the grid.** It is the sum
of everything outside the plate, in multiples of `--cell`. The first version of this
fix was a flat `vh` constant tuned by hand against the 6x22 grid; correct, and a trap,
because the 3x15 geometry `board-format.ts` targets pushed the prompts straight back
off the bottom. The guard re-measures it at three geometries and four prompt counts.

**Name a retired literal, do not quote it.** Three times in this pass a comment
explaining a defect reproduced its hex or token name, and the guard that greps for that
literal read the comment as the defect. The guards strip comments before scanning now,
and the comments say what the old value was without writing it.

## Open: the board geometry seam

`board.html` renders 6 rows x 22 columns, the flagship Vestaboard, which is what `main`
ships. `artifacts/api-server/src/board-format.ts` on branch `honey/board-topic-fit`
declares `BOARD_ROWS = 3`, `BOARD_COLS = 15` — the smaller Note — and wraps topic text
to it, so that a topic fits either board. That reasoning is sound and the two files
still disagree, and neither knows it.

Left at 6x22 here so this pass changes no behaviour. It is raised, not decided, because
the choice is a product one: at 3x15 the same vertical budget gives a headline roughly
twice the size, and the four permanently-empty rows go away. The layout is already
proved at both.

## Known, not changed

- `pod.html`'s Chatham House notice contains an em dash. Product copy, not mine to
  rewrite in a visual pass.
- `console.html` still uses several emoji glyphs as button furniture. They render in
  whatever face the OS supplies, which is a typeface nobody chose. Removed from
  `admin.html`; left in the console because it is 2,468 lines and worth one pass of its
  own.
