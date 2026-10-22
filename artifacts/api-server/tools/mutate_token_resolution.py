#!/usr/bin/env python3
"""
Mutation suite for check_token_resolution.py.

Each mutation reintroduces one defect this pass actually produced, so the
guard has to go red on it. The suite also asserts about itself: every
mutation must change the staged tree (a .replace() whose anchor has moved is
a no-op that prints like a pass), and the set of m_* functions defined must
equal the set listed in MUTS.

The --text entry is here because the first version of the guard did NOT catch
it: the check asked what the token resolved to, when the symptom is what the
token BREAKS. It is caught now by two independent things -- the rendered body
font, and a static kind-clash scan -- and this is what proves that.

  python3 tools/mutate_token_resolution.py
Exit 0 every mutation caught, 1 one was not.
"""
import hashlib, pathlib, shutil, subprocess, sys, tempfile
API = pathlib.Path(__file__).resolve().parent.parent
PUBLIC, TOOLS = API/"public", API/"tools"

def th(root):
    h = hashlib.sha256()
    for p in sorted(root.rglob("*")):
        if p.is_file(): h.update(str(p.relative_to(root)).encode()); h.update(p.read_bytes())
    return h.hexdigest()

def sub(path, old, new):
    t = path.read_text(); n = t.count(old)
    if n != 1: raise AssertionError(f"anchor {old!r} x{n} in {path.name}")
    path.write_text(t.replace(old, new, 1))

def m_root_scope(pub):
    """The real bug: adapter on :root while the source tokens live on .ws."""
    sub(pub/"console.html", "  .ws.console {\n", "  :root {\n")

def m_text_collision(pub):
    """The real bug: a colour token named --text, colliding with the font stack."""
    t = (pub/"console.html").read_text()
    assert t.count("var(--ink)") > 5
    (pub/"console.html").write_text(t.replace("var(--ink)", "var(--text)")
                                     .replace("--ink:", "--text:"))

def m_private_colour(pub):
    """A page forking the palette with its own copy of a shared literal."""
    sub(pub/"admin.html", "--danger:  var(--cardinal-lift);", "--danger:  #c4584a;")

def m_unlink_shared(pub):
    sub(pub/"board.html", '<link rel="stylesheet" href="./workshop.css"/>', "")

def m_base_layer_specificity(pub):
    """The real bug: the base layer as `.ws` (0,1,0) instead of :where(.ws)
    (0,0,0), so it out-ranks each page's own body rules. Symptom was a dark
    theme whose cards darkened and whose page did not."""
    sub(pub/"workshop.css", ":where(.ws) {\n  background: var(--page);",
        ".ws {\n  background: var(--page);")


def m_noop(pub):
    (pub/"board.html").read_text()

MUTS = [("base layer out-specifies pages", m_base_layer_specificity),
        ("adapter back on :root", m_root_scope),
        ("--text colour collision", m_text_collision),
        ("private copy of a shared colour", m_private_colour),
        ("shared layer unlinked", m_unlink_shared),
        ("deliberate no-op (control)", m_noop)]
CONTROL = {"deliberate no-op (control)"}
defined = {k for k in dict(globals()) if k.startswith("m_")}
listed = {f.__name__ for _, f in MUTS}
assert defined == listed, f"MUTS out of step: {defined ^ listed}"

bad = []
for name, fn in MUTS:
    tmp = pathlib.Path(tempfile.mkdtemp(prefix="tokmut-"))
    try:
        api = tmp/"api-server"; (api/"tools").mkdir(parents=True)
        shutil.copytree(PUBLIC, api/"public")
        shutil.copy(TOOLS/"check_token_resolution.py", api/"tools"/"check_token_resolution.py")
        before = th(api/"public")
        try: fn(api/"public")
        except AssertionError as e: bad.append((name, f"anchor gone: {e}")); print("BROKEN", name, e); continue
        if th(api/"public") == before:
            if name in CONTROL: print("control ok      ", name); continue
            bad.append((name, "no-op")); print("BROKEN MUTATION ", name, "changed nothing"); continue
        if name in CONTROL: bad.append((name, "control changed something")); print("BROKEN CONTROL  ", name); continue
        r = subprocess.run([sys.executable, str(api/"tools"/"check_token_resolution.py")],
                           capture_output=True, text=True, cwd=str(api))
        if r.returncode == 1:
            f = [l.strip() for l in r.stdout.splitlines() if l.strip().startswith("FAIL")]
            print(f"caught          {name}  ({len(f)} fail)  {f[0][6:][:72] if f else ''}")
        elif r.returncode == 2: bad.append((name,"guard could not run")); print("COULD NOT RUN   ", name)
        else: bad.append((name,"exit 0")); print("NOT CAUGHT      ", name)
    finally: shutil.rmtree(tmp, ignore_errors=True)
print()
if bad:
    for n,w in bad: print(" -", n, ":", w)
    sys.exit(1)
print("every mutation caught; control correct"); sys.exit(0)
