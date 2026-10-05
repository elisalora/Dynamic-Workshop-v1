#!/usr/bin/env python3
"""
Mutation suite for check_board_layout.py.

A check that cannot fail prints the same green as one that passes, and 45 ok
lines are the most convincing possible way to ship nothing. Each mutation here
reintroduces one real defect from the pass that produced the guard, and the
guard has to go red on it.

TWO ASSERTIONS THE SUITE MAKES ABOUT ITSELF, both because the obvious failure
mode is a mutation that quietly does nothing:

  1. Every mutation hashes the staged tree either side of its edit and refuses
     if nothing changed. A `.replace()` whose target has since been reworded is
     a no-op, and a no-op prints exactly like a guard that still works.
  2. The set of `mut_*` functions DEFINED must equal the set LISTED in MUTS.
     Adding a mutation and forgetting to register it leaves a dead function and
     an output indistinguishable from healthy.

Run from anywhere; paths resolve off this file.
  python3 tools/mutate_board_layout.py
Exit 0 every mutation caught, 1 one was not, 2 could not run.
"""

import hashlib
import pathlib
import shutil
import subprocess
import sys
import tempfile

HERE = pathlib.Path(__file__).resolve().parent
API = HERE.parent
PUBLIC = API / "public"
GUARD = HERE / "check_board_layout.py"


def tree_hash(root: pathlib.Path) -> str:
    h = hashlib.sha256()
    for p in sorted(root.rglob("*")):
        if p.is_file():
            h.update(str(p.relative_to(root)).encode())
            h.update(p.read_bytes())
    return h.hexdigest()


def sub(path: pathlib.Path, old: str, new: str):
    """Replace and insist the anchor was there. An anchor that has moved is
    the single most common way a mutation becomes a no-op."""
    txt = path.read_text()
    n = txt.count(old)
    if n != 1:
        raise AssertionError(f"anchor {old!r} appears {n} times in {path.name}, expected 1")
    path.write_text(txt.replace(old, new, 1))


# ---------- the mutations ----------
# Each reintroduces a defect this pass actually fixed.

def mut_rem_ceiling(pub):
    """The original bug: a rem cap that saturates above ~945px wide."""
    sub(pub / "board.html",
        "font-size: calc(var(--cell) * 0.62);",
        "font-size: clamp(0.7rem, 2.2vw, 1.3rem);")


def mut_fixed_board_width(pub):
    """The original bug: an absolute max-width, so the board shrinks
    relatively as the display grows."""
    # Anchored on the surrounding rule, not on `width: var(--board-w);`
    # alone: that string is in both #flip-board and #prompts-area, and the
    # suite's own one-match assertion caught it picking at random.
    sub(pub / "board.html",
        "    gap: var(--gap);\n    width: var(--board-w, 94vw);",
        "    gap: var(--gap);\n    width: 900px;")


def mut_overflow(pub):
    """The first fix's bug: a height budget that pushes the status line and
    the third prompt off a 1080p screen."""
    # The budget is derived now, so the way to break it is to understate
    # the furniture rather than to mistune a vh constant.
    sub(pub / "board.html", "--extras: 8.52;", "--extras: 3.0;")


def mut_low_contrast_prompts(pub):
    """The original bug: prompts at 3.37:1, hardcoded outside the tokens."""
    sub(pub / "board.html",
        "    color: var(--on-dark-75);\n    padding-left:",
        "    color: #666660;\n    padding-left:")


def mut_low_contrast_status(pub):
    """The original bug: the line that carries the connection errors at
    1.70:1 — the least legible thing on the board."""
    sub(pub / "board.html",
        "    color: var(--on-dark-50);\n  }\n  .ws-stage #board-status.alert",
        "    color: #3a3a36;\n  }\n  .ws-stage #board-status.alert")


def mut_theme_toggle_back(pub):
    """The original bug: an unstyled browser button on a projection."""
    sub(pub / "board.html",
        '<header class="masthead">',
        '<button id="theme-toggle">Dark</button>\n<header class="masthead">')


def mut_font_cdn(pub):
    """The original bug: a Google Fonts request from a display standing in a
    private workshop."""
    sub(pub / "board.html",
        '<link rel="stylesheet" href="./workshop.css"/>',
        '<link href="https://fonts.googleapis.com/css2?family=Space+Mono" rel="stylesheet"/>\n'
        '<link rel="stylesheet" href="./workshop.css"/>')


def mut_drop_token_layer(pub):
    """Reverts the integration: a page carrying its own private token block
    again, which is how --accent came to mean five things."""
    sub(pub / "board.html",
        '<link rel="stylesheet" href="./workshop.css"/>',
        '<style>/* local tokens */</style>')


def mut_missing_font_file(pub):
    """A render is evidence only about what it loaded. Remove the face and the
    page still renders, in the fallback, and every measurement is about a
    different typeface than the one that ships."""
    for f in pub.glob("fonts/GeneralSans-*.woff2"):
        f.unlink()
    (pub / "fonts" / "_removed").write_text("mutation")


def mut_drop_a_prompt(pub):
    """A prompt silently not rendering. Catches a guard that photographs the
    plate and never counts what is under it."""
    sub(pub / "board.html",
        "      area.appendChild(div);",
        "      if (i < 2) area.appendChild(div);")


def mut_noop_control(pub):
    """DELIBERATE NO-OP. Proves the did-anything-change assertion fires: this
    mutation must be reported as a BROKEN MUTATION, not as an uncaught defect
    and not as a pass."""
    (pub / "board.html").read_text()


MUTS = [
    ("rem ceiling on the glyph",      mut_rem_ceiling),
    ("absolute max-width on plate",   mut_fixed_board_width),
    ("height budget overflows 1080p", mut_overflow),
    ("prompts back to 3.37:1",        mut_low_contrast_prompts),
    ("status line back to 1.70:1",    mut_low_contrast_status),
    ("theme toggle back on board",    mut_theme_toggle_back),
    ("font CDN back",                 mut_font_cdn),
    ("shared token layer dropped",    mut_drop_token_layer),
    ("a self-hosted face removed",    mut_missing_font_file),
    ("a prompt silently not shown",   mut_drop_a_prompt),
    ("deliberate no-op (control)",    mut_noop_control),
]

# Expected outcome per mutation. The control is the only one that must be
# reported BROKEN rather than CAUGHT.
EXPECT_BROKEN = {"deliberate no-op (control)"}


def registered_matches_defined():
    defined = {k for k in globals() if k.startswith("mut_")}
    listed = {fn.__name__ for _, fn in MUTS}
    missing = defined - listed
    extra = listed - defined
    return missing, extra


def run_guard(api_dir: pathlib.Path):
    """Run the guard with its paths resolving. A harness in the wrong working
    directory exits non-zero on a failed import, which reads exactly like
    'the guard fired' — so the guard is copied into the mutant tree and run
    from there."""
    p = subprocess.run([sys.executable, str(api_dir / "tools" / "check_board_layout.py")],
                       capture_output=True, text=True, cwd=str(api_dir), timeout=900)
    return p.returncode, p.stdout + p.stderr


def main():
    missing, extra = registered_matches_defined()
    if missing or extra:
        print("FATAL: MUTS is out of step with the functions defined here.")
        if missing:
            print(f"  defined but never run: {sorted(missing)}")
        if extra:
            print(f"  listed but not defined: {sorted(extra)}")
        sys.exit(2)

    print(f"{len(MUTS)} mutations ({len(EXPECT_BROKEN)} deliberate control)\n")
    problems = []

    for name, fn in MUTS:
        tmp = pathlib.Path(tempfile.mkdtemp(prefix="ws-mut-"))
        try:
            api = tmp / "api-server"
            (api / "tools").mkdir(parents=True)
            shutil.copytree(PUBLIC, api / "public")
            shutil.copy(GUARD, api / "tools" / GUARD.name)

            before = tree_hash(api / "public")
            try:
                fn(api / "public")
            except AssertionError as e:
                problems.append((name, f"anchor gone: {e}"))
                print(f"  BROKEN MUTATION  {name}\n                   {e}")
                continue
            after = tree_hash(api / "public")

            if before == after:
                if name in EXPECT_BROKEN:
                    print(f"  control ok       {name} — changed nothing, as intended")
                else:
                    problems.append((name, "changed nothing — the mutation is a no-op"))
                    print(f"  BROKEN MUTATION  {name}: changed nothing")
                continue
            if name in EXPECT_BROKEN:
                problems.append((name, "control was supposed to change nothing but did"))
                print(f"  BROKEN CONTROL   {name}")
                continue

            code, out = run_guard(api)
            if code == 2:
                problems.append((name, f"guard could not run (exit 2):\n{out[-600:]}"))
                print(f"  COULD NOT RUN    {name}")
            elif code == 1:
                fails = [l.strip() for l in out.splitlines() if l.strip().startswith("FAIL")]
                print(f"  caught           {name}   ({len(fails)} failing check"
                      f"{'' if len(fails) == 1 else 's'})")
                if fails:
                    print(f"                   first: {fails[0][6:]}")
            else:
                problems.append((name, "guard exited 0 — the defect is invisible to it"))
                print(f"  NOT CAUGHT       {name}")
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    print()
    if problems:
        print(f"{len(problems)} problem(s):")
        for n, why in problems:
            print(f"  - {n}: {why}")
        sys.exit(1)
    print("every mutation caught; the control was correctly reported as a no-op")
    sys.exit(0)


if __name__ == "__main__":
    main()
