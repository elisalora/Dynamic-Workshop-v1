#!/usr/bin/env python3
"""render_console.py — screenshot the facilitator console POPULATED.

The real console builds its whole workshop/session/table tree in JS from a
WebSocket snapshot that only arrives behind a Clerk sign-in, so every render of
it before this tool was its empty state. This stages a copy of public/ and
injects a harness ahead of the page's own scripts that:

  - answers GET  auth/config  with no publishable key (so the page skips Clerk
    and calls showConsole(null), its own documented no-auth path),
  - answers POST ws-ticket    with a ticket and isAdmin,
  - replaces WebSocket with a stub that, on open, delivers
    tools/console_fixture.json as the `state` message.

Nothing in console.html is edited to make this work; it runs the shipped page.

Usage:  python3 tools/render_console.py OUT.png [--width 1440] [--height 1800]
                                       [--theme light|dark] [--expand t1]
                                       [--fixture tools/console_fixture.json]
Exit 0 wrote the png, 2 could not run.
"""
import argparse
import json
import pathlib
import shutil
import subprocess
import sys
import tempfile

HERE = pathlib.Path(__file__).resolve().parent
PUBLIC = HERE.parent / "public"
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

# Headless Chrome does not advance CSS animations under --virtual-time-budget:
# measured 2026-10-22, every .candidate-card still at opacity 0 with fadeIn
# "running" 2.5s after load, so a screenshot shows the entrance frame, washed
# out. This finishes them. Harness-only; the shipped page keeps its motion.
HARNESS = """<style>*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;transition:none!important}</style><script>
(function(){
  localStorage.setItem('scribe-theme', %(theme)s);
  var STATE = %(state)s, EXPAND = %(expand)s;
  var realFetch = window.fetch;
  window.fetch = function(url, opts){
    var u = String(url);
    function ok(body){ return Promise.resolve(new Response(JSON.stringify(body),
      {status:200, headers:{'Content-Type':'application/json'}})); }
    if (/auth\\/config$/.test(u)) return ok({});
    if (/ws-ticket$/.test(u))     return ok({ticket:'harness', isAdmin:true});
    if (/^(file:|\\/)/.test(u) || u.indexOf('://') < 0) return ok({});
    return realFetch.apply(this, arguments);
  };
  function FakeWS(){ var self = this; this.readyState = 0; this._l = {};
    setTimeout(function(){ self.readyState = 1; self._emit('open', {});
      self._emit('message', {data: JSON.stringify(STATE)});
      if (EXPAND) setTimeout(function(){
        EXPAND.forEach(function(id){
          var c = document.querySelector('.table-card[data-id="'+id+'"]');
          if (c) (c.querySelector('.table-card-summary') || c).click();
        });
      }, 50);
    }, 30); }
  FakeWS.OPEN = 1;
  FakeWS.prototype.addEventListener = function(t, f){ (this._l[t] = this._l[t] || []).push(f); };
  FakeWS.prototype._emit = function(t, e){ (this._l[t] || []).forEach(function(f){ f(e); }); };
  FakeWS.prototype.send = function(){};
  FakeWS.prototype.close = function(){};
  window.WebSocket = FakeWS;
})();
</script>"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("out")
    ap.add_argument("--width", type=int, default=1440)
    ap.add_argument("--height", type=int, default=1800)
    ap.add_argument("--theme", default="light", choices=["light", "dark"])
    ap.add_argument("--expand", action="append", default=[])
    ap.add_argument("--fixture", default=str(HERE / "console_fixture.json"))
    ap.add_argument("--page", default="console.html")
    a = ap.parse_args()

    if not pathlib.Path(CHROME).exists():
        print(f"FATAL: Chrome not at {CHROME}", file=sys.stderr)
        return 2
    state = json.loads(pathlib.Path(a.fixture).read_text())
    out = pathlib.Path(a.out).resolve()

    with tempfile.TemporaryDirectory() as tmp:
        dst = pathlib.Path(tmp) / "public"
        shutil.copytree(PUBLIC, dst)
        page = dst / a.page
        html = page.read_text()
        if "<head>" not in html:
            print("FATAL: no <head> to inject into", file=sys.stderr)
            return 2
        harness = HARNESS % {"theme": json.dumps(a.theme), "state": json.dumps(state),
                             "expand": json.dumps(a.expand or None)}
        page.write_text(html.replace("<head>", "<head>" + harness, 1))
        target = page
        # Headless Chrome will not make a window narrower than 500px: asked
        # for 390 it lays out at 500 and crops, so a "phone" screenshot is a
        # small-tablet layout with its right edge cut off (measured
        # 2026-10-22: clientWidth 500 at --window-size=390). Below 500 the
        # page goes in an iframe of the true width, which IS its viewport.
        if a.width < 500:
            target = dst / "_frame.html"
            target.write_text(
                f'<!doctype html><body style="margin:0;background:#888">'
                f'<iframe src="{a.page}" style="border:0;width:{a.width}px;'
                f'height:{a.height}px;display:block"></iframe>')
        proc = subprocess.run(
            [CHROME, "--headless", "--disable-gpu", "--hide-scrollbars",
             "--allow-file-access-from-files", f"--window-size={max(a.width, 500)},{a.height}",
             "--virtual-time-budget=4000", f"--screenshot={out}", f"file://{target}"],
            capture_output=True, text=True, timeout=120)
    if not out.exists():
        print(f"FATAL: Chrome wrote no screenshot\n{proc.stderr[-800:]}", file=sys.stderr)
        return 2
    print(out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
