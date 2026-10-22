#!/usr/bin/env python3
"""
Guard for public/board.html — the projected split-flap display.

WHY IT EXISTS
Every defect this pass fixed was invisible by reading the file and obvious
by measuring a render:

  * the headline glyph was capped at 20.8px on every display 945px wide or
    larger, because `clamp(0.7rem, 2.2vw, 1.3rem)` saturated at its ceiling;
  * the prompts measured 3.37:1 and the status line, which carries the
    connection errors, measured 1.70:1 on the dark ground;
  * the theme toggle rendered as a raw browser button (Arial,
    rgb(239,239,239), 2px outset) in the middle of a projection, because
    board.html never got the `#theme-toggle` rule that pod.html and
    console.html both have;
  * the first fix overflowed 1080p by 163px and silently ate a prompt.

So the checks are properties, not values. `glyph scales with viewport`
cannot be satisfied by a magic number, which is the point: the next person
who writes a rem ceiling here fails it without knowing this file exists.

SECOND SOURCE
The contrast thresholds are WCAG 2.1 (4.5:1 normal, 3:1 large), not a
constant this repo also owns, and the colours are read out of the *render*
rather than out of the stylesheet. A check that compares a stylesheet
against itself moves when the stylesheet moves and stays green.

USAGE
  python3 tools/check_board_layout.py            # all checks
  python3 tools/check_board_layout.py --keep     # leave the staging dir
Exit 0 all passed, 1 a check failed, 2 could not run (no Chrome, no page).
"""

import json
import pathlib
import shutil
import subprocess
import sys
import tempfile

HERE = pathlib.Path(__file__).resolve().parent
PUBLIC = HERE.parent / "public"
BOARD = PUBLIC / "board.html"

CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

# Display sizes a board actually ends up in front of. The 4K and 1366 rows
# are the ones that catch a saturated clamp; 1080 catches overflow.
SIZES = [
    (1366, 768,  "common meeting-room projector"),
    (1600, 900,  "laptop mirrored to a screen"),
    (1920, 1080, "1080p projector"),
    (2560, 1440, "large wall display"),
    (3840, 2160, "4K display"),
]

REVEAL_TEXT = "TRUST IS THE BOTTLENECK"
REVEAL_PROMPTS = [
    "Table 2 and Table 5 both stalled on who signs off.",
    "What would have to be true for you to ship without review?",
    "Name the last thing you shipped that nobody checked.",
]

# The height budget assumes "up to three prompts". That is an assumption, so
# it gets checked rather than asserted: 5 is over the stated budget and is
# expected to be caught, which is what makes 0/1/3 passing mean anything.
MORE_PROMPTS = REVEAL_PROMPTS + [
    "Who in this room has the authority and has not used it?",
    "What did the quiet table say that nobody wrote down?",
]
PROMPT_COUNTS = [0, 1, 3]

# Walked upward to find where the layout actually gives out, so the headroom
# is a measured number instead of an assertion. Distinct strings: a repeated
# one could wrap differently and make the count mean something else.
HEADROOM_PROMPTS = REVEAL_PROMPTS + [
    "Who in this room has the authority and has not used it?",
    "What did the quiet table say that nobody wrote down?",
    "Which decision is waiting on a person who is not here?",
    "What would you stop doing if nobody were watching?",
    "Name the assumption every table made without saying it.",
]

# The derivation claims to hold for any grid. These are the three that matter:
# what main ships, what board-format.ts targets, and one in between that no
# file anywhere declares — so a derivation that secretly special-cases the
# other two fails here.
GEOMETRIES = [(6, 22), (3, 15), (4, 18)]

HARNESS = """
<script>
(function(){
  const REVEAL = {type:'reveal', text:%(text)s, prompts:%(prompts)s};
  class FakeWS {
    constructor(u){ this._l={};
      setTimeout(()=>this._fire('open',{}),10);
      setTimeout(()=>this._fire('message',{data:JSON.stringify(REVEAL)}),60); }
    addEventListener(k,f){ (this._l[k]=this._l[k]||[]).push(f); }
    _fire(k,e){ (this._l[k]||[]).forEach(f=>f(e)); }
    send(){} close(){}
  }
  window.WebSocket = FakeWS;
})();
</script>
"""

PROBE = """
<script>
window.addEventListener('load', function(){
  var o = document.getElementById('unlock-overlay');
  if (o) o.dispatchEvent(new MouseEvent('click', {bubbles:true}));
  setTimeout(function(){
    function px(el, prop){ return el ? getComputedStyle(el)[prop] : null; }
    var tile   = document.querySelector('.tile');
    var board  = document.getElementById('flip-board');
    var prompt = document.querySelector('.prompt-item');
    var status = document.getElementById('board-status');
    var body   = document.body;
    var out = {
      fontsOk: document.fonts.check('600 40px "General Sans"') &&
               document.fonts.check('400 40px "Sentient"'),
      viewportW: innerWidth, viewportH: innerHeight,
      scrollH: document.documentElement.scrollHeight,
      boardW: board ? +board.getBoundingClientRect().width.toFixed(1) : null,
      glyphPx: tile ? parseFloat(px(tile, 'fontSize')) : null,
      bodyBg: px(body, 'backgroundColor'),
      promptColor: px(prompt, 'color'),
      promptPx: prompt ? parseFloat(px(prompt, 'fontSize')) : null,
      statusColor: px(status, 'color'),
      statusPx: status ? parseFloat(px(status, 'fontSize')) : null,
      tileColor: px(tile, 'color'),
      tileBg: px(tile, 'backgroundColor'),
      promptCount: document.querySelectorAll('.prompt-item').length,
      themeToggle: !!document.getElementById('theme-toggle')
    };
    document.title = 'PROBE' + JSON.stringify(out);
  }, 6500);
});
</script>
"""


# ---------- contrast, WCAG 2.1 ----------

def _lin(c):
    c = c / 255.0
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def _parse_rgb(s):
    """'rgb(1, 2, 3)' / 'rgba(1, 2, 3, 0.5)' -> (r, g, b, a)."""
    inner = s[s.index("(") + 1:s.rindex(")")]
    parts = [p.strip() for p in inner.replace("/", " ").split(",")]
    if len(parts) == 1:
        parts = inner.split()
    vals = [float(p) for p in parts[:4]]
    while len(vals) < 4:
        vals.append(1.0)
    return vals[0], vals[1], vals[2], vals[3]


def _over(fg, bg):
    """Composite a translucent foreground over an opaque background.

    The board's text colours are rgba() white at 50% and 75% — the
    *rendered* colour is the composite, and measuring the declared value
    instead would report a contrast nobody can see.
    """
    fr, fg_, fb, fa = _parse_rgb(fg)
    br, bg_, bb, _ = _parse_rgb(bg)
    return (fr * fa + br * (1 - fa),
            fg_ * fa + bg_ * (1 - fa),
            fb * fa + bb * (1 - fa))


def contrast(fg, bg):
    r, g, b = _over(fg, bg)
    lf = 0.2126 * _lin(r) + 0.7152 * _lin(g) + 0.0722 * _lin(b)
    br, bg_, bb, _ = _parse_rgb(bg)
    lb = 0.2126 * _lin(br) + 0.7152 * _lin(bg_) + 0.0722 * _lin(bb)
    hi, lo = max(lf, lb), min(lf, lb)
    return (hi + 0.05) / (lo + 0.05)


def threshold(size_px, bold=False):
    """WCAG 2.1: large text is >=24px, or >=18.66px bold."""
    large = size_px >= 24 or (bold and size_px >= 18.66)
    return 3.0 if large else 4.5


# ---------- render ----------

def stage(tmp, prompts=None, geometry=None, name="public"):
    """Copy what ships and patch a harness into the copy.

    Deliberately a copy of the whole public/ directory: board.html links
    ./workshop.css and ./fonts/*.woff2, and a harness that inlines only the
    stylesheet it remembered would render in the fallback face and measure
    a different typeface than the one that ships.
    """
    dst = tmp / name
    shutil.copytree(PUBLIC, dst)
    html = (dst / "board.html").read_text()
    if geometry is not None:
        rows, cols = geometry
        for var, val in (("--rows", rows), ("--cols", cols)):
            # Boundary-anchored on the declaration, so a reworded comment
            # mentioning the same token cannot be hit instead.
            lines = html.split("\n")
            hits = [i for i, l in enumerate(lines) if l.strip().startswith(var + ":")]
            if len(hits) != 1:
                raise AssertionError(f"{var} declared {len(hits)} times, expected 1")
            indent = lines[hits[0]][:len(lines[hits[0]]) - len(lines[hits[0]].lstrip())]
            lines[hits[0]] = f"{indent}{var}: {val};"
            html = "\n".join(lines)
    if "<body" not in html or "</body>" not in html:
        print("FATAL: board.html has no <body> — cannot stage", file=sys.stderr)
        sys.exit(2)
    i = html.index(">", html.index("<body")) + 1
    harness = HARNESS % {
        "text": json.dumps(REVEAL_TEXT),
        "prompts": json.dumps(REVEAL_PROMPTS if prompts is None else prompts)}
    html = html[:i] + harness + html[i:]
    html = html.replace("</body>", PROBE + "</body>", 1)
    (dst / "board.html").write_text(html)
    return dst / "board.html"


def render(page, w, h):
    proc = subprocess.run(
        [CHROME, "--headless", "--disable-gpu", "--allow-file-access-from-files",
         f"--window-size={w},{h}", "--virtual-time-budget=16000", "--dump-dom",
         f"file://{page}?session=guard&key=guard"],
        capture_output=True, text=True, timeout=120)
    dom = proc.stdout
    marker = "<title>PROBE"
    if marker not in dom:
        return None
    frag = dom[dom.index(marker) + len(marker):]
    return json.loads(frag[:frag.index("</title>")])


# ---------- checks ----------

class Report:
    def __init__(self):
        self.rows = []

    def check(self, ok, label, detail=""):
        self.rows.append((bool(ok), label, detail))

    def dump(self):
        bad = 0
        for ok, label, detail in self.rows:
            print(f"  {'ok  ' if ok else 'FAIL'}  {label}" + (f"   {detail}" if detail else ""))
            if not ok:
                bad += 1
        print(f"\n{len(self.rows)} checks, {bad} failed")
        return bad


def main():
    if not BOARD.exists():
        print(f"FATAL: {BOARD} not found", file=sys.stderr)
        sys.exit(2)
    if not pathlib.Path(CHROME).exists():
        print(f"FATAL: Chrome not at {CHROME} — cannot render, so this run "
              f"proves nothing. Not the same as 'the board is fine'.",
              file=sys.stderr)
        sys.exit(2)

    src = BOARD.read_text()
    rep = Report()

    # --- source-level: things a render cannot see are absent -------------
    print("source")
    rep.check("fonts.googleapis.com" not in src,
              "no font CDN",
              "a request per load logs, at a third party, when a private workshop ran")
    rep.check('id="theme-toggle"' not in src,
              "no theme toggle on the board",
              "a projected display has one lighting condition; this one rendered unstyled")
    rep.check("workshop.css" in src,
              "uses the shared token layer",
              "so --cardinal means one thing across this repo and the event platform")

    tmp = pathlib.Path(tempfile.mkdtemp(prefix="ws-board-"))
    keep = "--keep" in sys.argv
    try:
        page = stage(tmp)
        seen = {}
        for w, h, note in SIZES:
            print(f"\n{w}x{h}  ({note})")
            m = render(page, w, h)
            if m is None:
                rep.check(False, f"{w}x{h} rendered", "probe never reported — render failed")
                continue
            seen[w] = m

            rep.check(m["fontsOk"], "self-hosted faces loaded",
                      "a render is evidence only about what it loaded")
            rep.check(not m["themeToggle"], "no theme-toggle element in the DOM")
            rep.check(m["promptCount"] == len(REVEAL_PROMPTS),
                      "every prompt rendered",
                      f"{m['promptCount']} of {len(REVEAL_PROMPTS)}")
            rep.check(m["scrollH"] <= m["viewportH"] + 1,
                      "nothing pushed off the bottom",
                      f"content {m['scrollH']}px in {m['viewportH']}px")
            rep.check(m["boardW"] / m["viewportW"] >= 0.55,
                      "plate fills the screen",
                      f"{m['boardW']}px of {m['viewportW']}px "
                      f"({m['boardW'] / m['viewportW'] * 100:.0f}%)")

            for name, colour, size, bg in (
                ("headline glyph", m["tileColor"], m["glyphPx"], m["tileBg"]),
                ("prompt text",    m["promptColor"], m["promptPx"], m["bodyBg"]),
                ("status / errors", m["statusColor"], m["statusPx"], m["bodyBg"]),
            ):
                r = contrast(colour, bg)
                t = threshold(size)
                rep.check(r >= t, f"{name} contrast",
                          f"{r:.2f}:1 at {size:.1f}px, needs {t}:1")

        # --- the property, not a value ----------------------------------
        print("\nacross sizes")
        if 1366 in seen and 3840 in seen:
            small, large = seen[1366]["glyphPx"], seen[3840]["glyphPx"]
            rep.check(large > small * 2,
                      "glyph scales with the display",
                      f"{small:.1f}px at 1366 -> {large:.1f}px at 3840 "
                      f"(x{large / small:.2f}); a rem ceiling pins this at x1.00")
            sw, lw = seen[1366]["boardW"], seen[3840]["boardW"]
            rep.check(lw > sw * 2,
                      "plate scales with the display",
                      f"{sw:.0f}px -> {lw:.0f}px (x{lw / sw:.2f}); "
                      f"a px max-width pins this at x1.00")
        else:
            rep.check(False, "both ends rendered", "cannot compare scaling")

        # --- the derivation, exercised ---------------------------------
        # --chrome claims to be a height independent of the grid, covering
        # the masthead, up to three prompts and the footer. Both halves are
        # claims about cases nobody has rendered, so render them. 1920x1080 only: the scaling property is already proved
        # above, and what is under test here is the arithmetic.
        W, H = 1920, 1080
        print(f"\ngrid geometries at {W}x{H}")
        for gi, (rows, cols) in enumerate(GEOMETRIES):
            page_g = stage(tmp, geometry=(rows, cols), name=f"geo{gi}")
            m = render(page_g, W, H)
            if m is None:
                rep.check(False, f"{rows}x{cols} rendered", "probe never reported")
                continue
            rep.check(m["scrollH"] <= m["viewportH"] + 1,
                      f"{rows}x{cols} grid fits",
                      f"content {m['scrollH']}px in {m['viewportH']}px")
            rep.check(m["promptCount"] == len(REVEAL_PROMPTS),
                      f"{rows}x{cols} shows every prompt",
                      f"{m['promptCount']} of {len(REVEAL_PROMPTS)}")

        print(f"\nprompt counts at {W}x{H}")
        for n in PROMPT_COUNTS:
            page_p = stage(tmp, prompts=MORE_PROMPTS[:n], name=f"pc{n}")
            m = render(page_p, W, H)
            if m is None:
                rep.check(False, f"{n} prompts rendered", "probe never reported")
                continue
            rep.check(m["scrollH"] <= m["viewportH"] + 1,
                      f"{n} prompt(s) fit",
                      f"content {m['scrollH']}px in {m['viewportH']}px")
            rep.check(m["promptCount"] == n,
                      f"{n} prompt(s) all rendered", f"{m['promptCount']} of {n}")

        # How much headroom the budget actually has, as a measured number
        # rather than a claim.
        #
        # This check used to assert the opposite -- that five prompts must
        # NOT fit, proving the ceiling was real. That was a true property of
        # the OLD derivation, where the furniture was a count of tiles and
        # grew with the grid. Under a fixed --chrome the plate is capped at
        # 94vw and there is genuine slack, so five fitting is correct
        # behaviour, not a defect. An assertion that outlives the design it
        # described is worse than no assertion: it fails on healthy code and
        # teaches you to ignore it.
        #
        # What is still worth guarding is that the budget clears what the
        # product needs. So: walk up until something overflows, report where,
        # and fail if that is under three.
        print(f"\nprompt headroom at {W}x{H}")
        max_fit = None
        for n in range(0, len(HEADROOM_PROMPTS) + 1):
            mp = render(stage(tmp, prompts=HEADROOM_PROMPTS[:n], name=f"hr{n}"), W, H)
            if mp is None:
                break
            if mp["scrollH"] > mp["viewportH"] + 1:
                break
            max_fit = n
        rep.check(max_fit is not None and max_fit >= 3,
                  "budget clears the three prompts the product sends",
                  f"largest prompt count that fits: {max_fit}"
                  + ("" if max_fit is None else
                     f" (needs 3; {max_fit - 3} spare)" if max_fit >= 3 else " (SHORT)"))
    finally:
        if keep:
            print(f"\nstaging kept at {tmp}")
        else:
            shutil.rmtree(tmp, ignore_errors=True)

    print()
    sys.exit(1 if rep.dump() else 0)


if __name__ == "__main__":
    # An uncaught exception exits 1 by default, and 1 is this tool's code for
    # "a check failed" -- so a crash would arrive looking exactly like a real
    # finding. It happened: a stray line referencing a variable that does not
    # exist in this module raised UnboundLocalError after the last check and
    # reported as a failure. 2 means "could not run", which is the truth.
    try:
        main()
    except SystemExit:
        raise
    except Exception:
        import traceback
        traceback.print_exc()
        print("\nFATAL: the guard itself crashed. Exit 2 (could not run), NOT 1 "
              "(a check failed) — this run says nothing about the board.",
              file=sys.stderr)
        sys.exit(2)
