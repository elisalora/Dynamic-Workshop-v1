---
name: Clerk CDN in screenshot sandbox
description: The Replit screenshot tool's headless browser has no internet access, so Clerk's CDN (cdn.jsdelivr.net) always fails there. The console.html catch block shows "Auth unavailable — continuing…" and falls through after 1.5s. This is correct behavior — real browsers load the CDN fine.
---

The Replit screenshot/preview sandbox cannot reach external CDNs.
- `window.Clerk` CDN load always errors in screenshot tool
- `initAuth()` catch block → `showConsole(null)` after 1.5s
- Screenshot appears to show auth screen because capture happens before the 1.5s timeout
- **Real browsers work correctly** — cdn.jsdelivr.net/@clerk/clerk-js@4/dist/clerk.browser.js loads and `window.Clerk` is the class constructor

**How to apply:** Don't treat CDN errors in screenshot as bugs. Test auth flow in the actual preview URL in a real browser tab.
