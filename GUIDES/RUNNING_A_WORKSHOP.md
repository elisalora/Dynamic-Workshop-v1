# Running a workshop with Scribe Pilot

One page, for a facilitator who has never seen this before and is about to run it with a real group. You do not need to have opened the code.

**The shape:** one person facilitates from the console. Everyone else sits at a table with a laptop running a pod link. Participants do not sign in and do not need accounts.

> **Maintainers:** this file describes the console as it behaves in the app, not the code. If you change a button label, a form field, or where a link comes from, change it here in the same commit. There is a claim near the bottom marked **⏳ delete after the first real session** — it is true today and will not be true for long.

---

## Before the room arrives

- **One laptop per table**, with a working microphone, on the room's wifi.
- **Your own laptop or phone** for the console. It is phone-friendly.
- **A screen at the front** for the board, if you have one.
- Everything runs over HTTPS. Browsers refuse microphone access otherwise, so use the deployed URL, not an IP address.

## 1. Sign in

Open **`/api/console.html`** and sign in with Google. You are a facilitator: you see your own workshops and nobody else's, and nobody else sees yours.

## 2. Create a Session *before* you create Groups

Three levels, and the middle one is the one that matters:

| | What it is |
|---|---|
| **Workshop** | A folder. Optional. Use it if you are running several sessions across a day. |
| **Session** | One block of discussion. **This is the unit the board and the theme engine work on.** |
| **Group** | One table. Has a name, optional discussion questions, and its own pod link. |

Use **⊟ New Session** first. Give it a name (`Day 1 Morning`).

Then **＋ New Group**, once per table. In that form:

- **Group name** — the table's topic. This is what shows on the pod screen.
- **Discussion questions** — optional, shown to the table. `＋ Add a question` for each.
- **Session** — ⚠️ **pick the session you just made.** This dropdown defaults to *— No session —*, and a group with no session gets no board and never feeds a theme. It is the single easiest thing to get wrong, and it fails silently: you get a workshop where nothing ever happens.

Press **Create & generate link**.

## 3. Send each table its link

Each new group appears as a card marked **Waiting for pod**, showing its full URL and a **Copy link** button. Copy that and send it to *that table's* laptop — Slack, email, whatever.

The link carries a key. `pod.html?table=T1` on its own will not connect: it closes immediately with *Unknown table*. Always hand out the link the console gives you.

At the table: open the link, allow the microphone, done. The card in your console flips from *Waiting for pod* to a live table.

## 4. Put the board up

Use the **▦ Board** button on the session. Do not type the board URL — the button adds the session's board key, and the board is refused without it.

The board shows nothing until you reveal something. That is correct.

## 5. What happens, and when

| Every | What |
|---|---|
| 45s | Each table with new speech gets a scribe pass: clusters, ideas, quotes, flags, a one-line summary. |
| 60s | Metrics per table — words per minute, novelty, and a status: `quiet` · `circling` · `flowing` · `converging`. |
| 180s | The theme engine looks across the session for something two or more tables are circling. |

**The theme engine needs at least two tables live in the same session.** With one table it does not run at all.

## 6. Reveal

Theme candidates appear in the console with their evidence — real quotes from real tables. Read the evidence before you reveal; it is what tells you whether the theme is real.

- **Reveal on board** — flips it up on the split-flap display.
- **Edit + Reveal** — reword it first. Keep it short; the board is 6 rows of 22 characters, and a word longer than 22 characters gets truncated.
- **Dismiss** — it stays dismissed, including across a restart.

## 7. Afterwards

On the session, **✦** generates a Markdown write-up. Once it exists you get **✦ Summary**, and inside that **🔗 Copy share link** — a public link anyone can read with no account. It exposes the summary only: never transcripts, boards, or theme evidence.

---

## Looks broken, is not

- **"No cross-table themes detected yet."** — the normal answer, and the honest one. It needs two tables genuinely converging. Empty for the first ten minutes is expected.
- **The board is blank.** — it is meant to be, until you reveal.
- **A table shows `quiet`.** — that is a reading of the room, not an error.
- **Nothing for the first minute.** — the scribe runs on a 45-second cycle.

## Before you rely on it

Two limits shape how you plan the day. Both are covered in more detail under **Status** in the [README](../README.md):

- **One facilitator per workshop.** You cannot share a session with a co-facilitator; they would get their own empty console.
- **Links do not rotate.** Deleting the group or session is the only way to revoke one.

> **⏳ Delete after the first real session.** As of `81acf0e`, the scribe and the ASR have never been exercised end to end — no one has yet watched real speech become a real board. Everything around it is tested. If you are reading this after a workshop has actually run, this paragraph is out of date: remove it here and in the README's Status section.

---

## Dry run without a room (20 minutes, no microphones)

1. Create a session and **two** groups inside it. Both in the same session.
2. **Copy link** on each, and append `&demo=1` to the copied URL.
3. Open both in separate tabs, plus the console, plus the board from **▦ Board**.

Demo mode feeds a scripted transcript through the real pipeline — real scribe passes, real theme engine. Give it about four minutes: two scribe cycles per table before the first theme pass at 180s.

Worth doing once before you run it with people. It is cheap, and it is the difference between finding a problem at your desk and finding it in front of a room.
