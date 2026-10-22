#!/usr/bin/env python3
"""
Guard for the design system's one structural promise: that every page's tokens
actually resolve, and that they resolve to the shared values.

WHY IT EXISTS
Moving the four pages onto workshop.css introduced two failures that no amount
of reading the diff would have found, and that look fine in a screenshot until
you know what to look for:

  1. The console and pod adapters were written on `:root`, while workshop.css
     declares --cardinal and the charcoal ramp on `.ws` (the body). Custom
     properties inherit downward only, so `--accent: var(--cardinal)` on :root
     resolved to the guaranteed-invalid value. Every mapped token went invalid
     and `background: var(--accent)` rendered transparent -- white text on a
     white page, with no error anywhere.
  2. console.html used --text for a COLOUR and workshop.css uses --text for a
     font stack. Both in scope, nearer wins, so every `color: var(--text)`
     would have resolved to a font-family string and been dropped.

Both are the same shape: a name that exists, in the wrong place, resolving to
nothing. A page keeps rendering and says nothing.

WHAT IT CHECKS
  * every `var(--x)` referenced by a page is declared and resolves non-empty
  * a declared token never resolves to a font stack where a colour is meant
  * no page re-declares a shared colour literal privately -- the whole point
    of the shared layer is that there is one definition

SECOND SOURCE
The expected values come from workshop.css, parsed independently of the pages
that consume them, and the resolved values come from a live render. Neither
side is the other's definition.

  python3 tools/check_token_resolution.py
Exit 0 all resolved, 1 something did not, 2 could not run.
"""

import json
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile

HERE = pathlib.Path(__file__).resolve().parent
PUBLIC = HERE.parent / "public"
SHARED = PUBLIC / "workshop.css"
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

PAGES = ["board.html", "console.html", "pod.html", "admin.html"]

# Tokens whose value is deliberately a font stack rather than a colour.
FONT_TOKENS = {"--display", "--text"}

# Tokens a page may legitimately leave unresolved on <body> because they are
# declared on a descendant. Empty on purpose: if this ever needs an entry, the
# entry has to carry the reason, because "it is allow-listed" is how a real
# defect gets permanently hidden.
ALLOW_UNRESOLVED: dict[str, str] = {}

# Pages with a stored light/dark preference, and the expression to pin.
# board.html is deliberately absent: a projected display has one lighting
# condition and its toggle was removed in this pass.
THEMEABLE = {
    "console.html": "localStorage.getItem('scribe-theme')||'light'",
    "pod.html":     "localStorage.getItem('scribe-theme')||'light'",
}


def luminance(css_colour):
    """Relative luminance of an rgb()/rgba() string, or None if unparseable."""
    if not css_colour or "(" not in css_colour:
        return None
    inner = css_colour[css_colour.index("(") + 1:css_colour.rindex(")")]
    parts = [p.strip() for p in inner.replace("/", " ").replace(",", " ").split()]
    try:
        r, g, b = (float(parts[i]) for i in range(3))
    except (ValueError, IndexError):
        return None

    def lin(c):
        c /= 255.0
        return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4

    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)


PROBE = """
<script>
window.addEventListener('load', function(){
  setTimeout(function(){
    var cs = getComputedStyle(document.body);
    var out = {};
    (window.__NAMES__ || []).forEach(function(n){
      out[n] = cs.getPropertyValue(n).trim();
    });
    document.title = 'TOK' + JSON.stringify({
      bodyClass: document.body.className,
      values: out,
      // What a token resolves to is not the same question as what it
      // BREAKS. A page that redefines --text as a colour leaves the token
      // looking perfectly healthy and silently kills `font-family:
      // var(--text)` on the body, which falls back to a serif nobody chose.
      bodyFont: cs.fontFamily,
      bodyBg: cs.backgroundColor,
      cardBg: (function(){
        var el = document.querySelector('.card, .search-card, .collapsible-form, header');
        return el ? getComputedStyle(el).backgroundColor : null;
      })(),
      // Which FAMILIES actually downloaded, not which weight. A browser
      // fetches a face only when something draws it, so board.html never
      // requests General Sans 400 -- it sets its masthead at 500 and its
      // flaps at 600. Asking about one weight answered a different question
      // and reported a healthy page as broken.
      facesLoaded: Array.from(document.fonts)
        .filter(function(f){ return f.status === 'loaded'; })
        .map(function(f){ return f.family + ' ' + f.weight; })
    });
  }, 1200);
});
</script>
"""


def shared_colour_literals():
    """The hex values workshop.css owns, read out of workshop.css itself.

    A page repeating one of these has quietly forked the palette: the shared
    file can then change and the page will not follow, which is the exact
    drift the shared file exists to prevent.
    """
    txt = SHARED.read_text()
    # Only the declarations, never the prose. A comment that mentions a hex
    # would otherwise be collected as if it were a definition.
    txt = re.sub(r"/\*.*?\*/", "", txt, flags=re.S)
    return {m.group(1).lower() for m in re.finditer(r":\s*(#[0-9a-fA-F]{6})\s*;", txt)}


def strip_comments(text):
    """Remove CSS and HTML comments before looking for token references.

    Not tidiness -- correctness. The adapters in these pages explain
    themselves by writing things like "every var(--x) call site", and the
    first version of this guard collected --x as a real token and reported
    two pages failing. A scanner that reads comments cannot tell a
    description of code from code, which is the same mistake the comments
    themselves are warned about.
    """
    text = re.sub(r"/\*.*?\*/", "", text, flags=re.S)
    text = re.sub(r"<!--.*?-->", "", text, flags=re.S)
    return text


FONT_WORDS = re.compile(r"(sans-serif|serif|monospace|-apple-system|Sentient|General Sans)")
COLOUR_WORDS = re.compile(r"(#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(|color-mix\()")


def declared_kinds(text):
    """{token: {"a colour", "a font stack", ...}} from real declarations only."""
    kinds = {}
    for m in re.finditer(r"(?m)^\s*(--[a-zA-Z0-9-]+)\s*:\s*([^;]+);", strip_comments(text)):
        tok, val = m.group(1), m.group(2)
        if "var(" in val and not COLOUR_WORDS.search(val) and not FONT_WORDS.search(val):
            continue                      # an alias; its kind is the target's
        k = set()
        if FONT_WORDS.search(val):
            k.add("a font stack")
        if COLOUR_WORDS.search(val):
            k.add("a colour")
        if k:
            kinds.setdefault(tok, set()).update(k)
    return kinds


def kind_clashes(page_text, shared_text):
    """Tokens the page and the shared layer disagree about the KIND of.

    console.html used --text for a colour while workshop.css uses it for the
    font stack. Both were in scope on the same element, the nearer one won,
    and every declaration using the loser was dropped without a word. Which
    side wins is a cascade accident; the clash is the defect.
    """
    page, shared = declared_kinds(page_text), declared_kinds(shared_text)
    out = []
    for tok, sk in shared.items():
        pk = page.get(tok)
        if pk and pk != sk:
            out.append((tok, sk | pk))
    return sorted(out)


def referenced_names(page_text, shared_text):
    page, shared = strip_comments(page_text), strip_comments(shared_text)
    names = set(re.findall(r"var\(\s*(--[a-zA-Z0-9-]+)", page))
    names |= set(re.findall(r"var\(\s*(--[a-zA-Z0-9-]+)", shared))
    names |= set(re.findall(r"(?m)^\s*(--[a-zA-Z0-9-]+)\s*:", page))
    return sorted(names)


def render(page, names, w=1400, h=1000):
    html = page.read_text()
    inject = f"<script>window.__NAMES__={json.dumps(names)};</script>" + PROBE
    page.write_text(html.replace("</body>", inject + "</body>", 1))
    out = subprocess.run(
        [CHROME, "--headless", "--disable-gpu", "--allow-file-access-from-files",
         f"--window-size={w},{h}", "--virtual-time-budget=9000", "--dump-dom",
         f"file://{page}?session=guard&key=guard"],
        capture_output=True, text=True, timeout=120).stdout
    if "<title>TOK" not in out:
        return None
    frag = out[out.index("<title>TOK") + len("<title>TOK"):]
    return json.loads(frag[:frag.index("</title>")])


def main():
    if not pathlib.Path(CHROME).exists():
        print(f"FATAL: Chrome not at {CHROME}. This run proves nothing, which "
              f"is not the same as the pages being fine.", file=sys.stderr)
        sys.exit(2)
    if not SHARED.exists():
        print(f"FATAL: {SHARED} missing", file=sys.stderr)
        sys.exit(2)

    shared_text = SHARED.read_text()
    owned = shared_colour_literals()
    print(f"workshop.css owns {len(owned)} colour literals\n")

    failures = 0
    checks = 0
    tmp = pathlib.Path(tempfile.mkdtemp(prefix="ws-tok-"))
    try:
        staged = tmp / "public"
        shutil.copytree(PUBLIC, staged)

        for name in PAGES:
            src = PUBLIC / name
            if not src.exists():
                print(f"{name}: MISSING"); failures += 1; continue
            page_text = src.read_text()
            print(name)

            # -- the page must use the shared layer at all ------------------
            checks += 1
            if "workshop.css" not in page_text:
                print("  FAIL  does not link the shared token layer"); failures += 1
            else:
                print("  ok    links workshop.css")

            # -- no private copies of a shared colour ----------------------
            body_css = re.sub(r"/\*.*?\*/", "", page_text, flags=re.S)
            dupes = sorted({h.lower() for h in re.findall(r"#[0-9a-fA-F]{6}", body_css)} & owned)
            checks += 1
            if dupes:
                print(f"  FAIL  re-declares shared colour literals: {dupes}")
                failures += 1
            else:
                print("  ok    no private copy of a shared colour")

            # -- every referenced token resolves ---------------------------
            names = referenced_names(page_text, shared_text)
            m = render(staged / name, names)
            checks += 1
            if m is None:
                print("  FAIL  page did not render"); failures += 1; continue
            print(f"  ok    rendered (body class {m['bodyClass']!r})")

            empty = [n for n, v in m["values"].items()
                     if not v and n not in ALLOW_UNRESOLVED]
            checks += 1
            if empty:
                print(f"  FAIL  {len(empty)} token(s) resolve to nothing: {empty}")
                print("        a token that resolves to nothing drops its whole "
                      "declaration, silently")
                failures += 1
            else:
                print(f"  ok    all {len(names)} tokens resolve")

            # -- the shared faces survived whatever the page did -----------
            checks += 1
            if "General Sans" not in m["bodyFont"]:
                print(f"  FAIL  body font is {m['bodyFont']!r}, not General Sans")
                print("        a page redefining a font token as a colour leaves "
                      "the token healthy and drops the declaration")
                failures += 1
            else:
                print("  ok    body renders in General Sans")

            checks += 1
            fams = {f.rsplit(" ", 1)[0] for f in m["facesLoaded"]}
            want = {"General Sans", "Sentient"}
            missing = want - fams
            if missing:
                print(f"  FAIL  self-hosted families never loaded: {sorted(missing)}")
                print(f"        loaded: {m['facesLoaded'] or 'nothing'}")
                failures += 1
            else:
                print(f"  ok    both self-hosted families loaded "
                      f"({len(m['facesLoaded'])} faces: {', '.join(sorted(m['facesLoaded']))})")

            # -- dark actually goes dark, ground included -------------------
            # A page whose cards darken while the body behind them stays light
            # is the exact failure a base layer with class specificity causes,
            # and it is invisible in every file involved. The only way to see
            # it is to paint the page and read the pixels back.
            if THEMEABLE.get(name):
                dark_page = staged / f"dark_{name}"
                dark_page.write_text(
                    src.read_text().replace(THEMEABLE[name], "'dark'", 1))
                dm = render(dark_page, names)
                checks += 1
                if dm is None:
                    print("  FAIL  dark variant did not render"); failures += 1
                else:
                    lum = luminance(dm["bodyBg"])
                    card = luminance(dm["cardBg"]) if dm["cardBg"] else None
                    if lum is None:
                        print(f"  FAIL  dark body background unreadable: {dm['bodyBg']}")
                        failures += 1
                    elif lum > 0.18:
                        print(f"  FAIL  dark theme leaves the page light: body "
                              f"{dm['bodyBg']} (luminance {lum:.3f})"
                              + (f", cards {dm['cardBg']} (luminance {card:.3f})"
                                 if card is not None else ""))
                        print("        cards darken, the ground behind them does not, "
                              "and the text is light")
                        failures += 1
                    else:
                        print(f"  ok    dark theme darkens the ground "
                              f"({dm['bodyBg']}, luminance {lum:.3f})")

            # -- no token name means two different kinds of thing -----------
            # A static check, deliberately independent of the render: the
            # render only shows which side currently WINS the cascade, and the
            # hazard exists either way round.
            checks += 1
            clashes = kind_clashes(page_text, shared_text)
            if clashes:
                for tok, kinds in clashes:
                    print(f"  FAIL  {tok} is declared as {' and '.join(sorted(kinds))} "
                          f"across the page and the shared layer")
                failures += 1
            else:
                print("  ok    no token name used for two kinds of value")

            # -- a colour token is not a font stack ------------------------
            wrong = [n for n, v in m["values"].items()
                     if n not in FONT_TOKENS and v and
                     re.search(r"(sans-serif|serif|monospace|-apple-system)", v)]
            checks += 1
            if wrong:
                print(f"  FAIL  resolve to a font stack but are used as values "
                      f"elsewhere: {wrong}")
                failures += 1
            else:
                print("  ok    no colour token resolving to a font stack")
            print()
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    print(f"{checks} checks, {failures} failed")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
