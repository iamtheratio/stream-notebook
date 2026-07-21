# 📓 Stream Notebook

A handwritten-looking notebook that lives on your stream and fills itself from chat.

Your mods type `!note dont forget the blue key`, and it appears on screen in a
composition notebook — numbered, checkable, and automatically filed under whatever
game you're playing. Switch games and you get a fresh notebook; switch back and
your old notes are still there.

Runs on your own PC. Nothing to sign up for, no monthly anything.

![commands](https://img.shields.io/badge/chat-!note-9146FF) ![obs](https://img.shields.io/badge/OBS-browser%20source-000) ![node](https://img.shields.io/badge/node-18%2B-3c873a)

---

## What you need

- **Windows PC** (macOS and Linux work too — run `npm install && npm start` instead of the .bat)
- **[Node.js](https://nodejs.org)** — grab the LTS installer, click through the defaults
- **OBS** (or Streamlabs, or anything that supports browser sources)
- A **Twitch account**

You do *not* need Streamer.bot, Mix It Up, a bot account, or an API key.

---

## Setup

### 1. Download and start it

Download this repo (green **Code** button → **Download ZIP**), unzip it somewhere
sensible like `C:\StreamNotebook`, then **double-click `start.bat`**.

The first run installs a few things and takes a minute or two. After that it's instant.

Your browser opens to the dashboard at **http://localhost:8765**. Leave the black
console window open — that's the server. Closing it stops the notebook.

### 2. Connect Twitch

Click **Connect with Twitch**. You'll get a 6-character code and a link to
`twitch.tv/activate`. Enter the code there, approve, and the dashboard turns green
on its own.

That's the whole authentication step. No tokens to copy, no app to register.

> **What it can do:** read your chat, post short confirmations, and see which game
> your channel is set to. It cannot change your stream, run ads, or see anything else.

### 3. Add the overlay to OBS

In OBS: **Sources → + → Browser**, then:

| Field | Value |
|---|---|
| URL | `http://localhost:8765/overlay.html` |
| Width | `1920` |
| Height | `1080` |
| Shutdown source when not visible | ✅ ticked |
| Refresh browser when scene becomes active | ✅ ticked |

The dashboard has a **Copy** button for that URL.

The notebook sits in the **bottom-left** and stays hidden until someone adds a note
(it appears for ~20 seconds) or you run `!note show` to pin it. Drag the source to
reposition it.

### 4. Try it

Type this in your own chat:

```
!note this is my first note
```

It should appear on the overlay within a second. If it doesn't, see
[Troubleshooting](#troubleshooting).

---

## Commands

By default **you and your moderators** can use everything. **Anyone** can use the
view-only commands. `!note` and `!notes` are interchangeable.

### Adding and editing

| Command | What it does |
|---|---|
| `!note <text>` | Add a note |
| `!note 3 <text>` | Replace the text of note 3 |
| `!note 3 done` | Tick note 3 off ✔ |
| `!note 3 undone` | Un-tick it |
| `!note 3 scratch` | Cross it out ✗ |
| `!note 3 unscratch` | Un-cross it |
| `!note 3 delete` | Delete it (remaining notes renumber) |

### Tidying up

| Command | What it does |
|---|---|
| `!note archive` | Move every ticked note to a "Completed Notes" page |
| `!note 3 archive` | Move just note 3 there, marking it done |
| `!note 3 unarchive` | Bring note 3 back to the active list |
| `!note clear all` | Wipe the current page 🔥 |

### Pages and chapters

| Command | What it does |
|---|---|
| `!note chapter <name>` | Switch to a named chapter, creating it if new |
| `!note page next` / `prev` | Flip the notebook page |
| `!note page 2` | Jump to page 2 |

Chapters are tabs within the current game — handy for `!note chapter Boss Fight`
versus your general run notes.

### Showing and hiding

| Command | Who | What it does |
|---|---|---|
| `!note show` | anyone | Pin the notebook open |
| `!note show 3` | anyone | Pin it open, highlighting note 3 |
| `!note hide` | anyone | Unpin it |
| `!note list` | anyone | Print the current notes into chat |
| `!note on` / `off` | mods | Master switch for the whole system |
| `!note help` | anyone | Print the command list into chat |

Viewers get a cooldown (10s by default) on the public commands so nobody can
spam-flicker your overlay. You and your mods are exempt.

---

## The dashboard

**http://localhost:8765** — everything is configured here. There are no config
files to edit.

- **Status** — Twitch, chat, current game, and whether notes are saving
- **Options** — chat source, chat replies, game organisation, VIP permissions, cooldown
- **Overlay Controls** — show/hide/on/off buttons, if you'd rather click than type
- **Activity** — a live log, useful when something isn't working

### Manage Notes

**http://localhost:8765/notes.html** — a full editor for every note you've ever
taken, across every game. Add, edit, reorder, rename chapters, delete old games.
Edits to the game you're currently playing show up on stream instantly.

Useful for prepping a run in advance, or cleaning up after a long stream.

---

## Options explained

**Where chat comes from**
- **Twitch** (default) — connects straight to Twitch. Nothing else to install.
- **Streamer.bot** — uses your existing Streamer.bot setup, which also gets you
  **YouTube and TikTok**. Requires the extra step in [`streamerbot/`](streamerbot/).

**Reply in chat** — posts short confirmations like `📓 Note #3 added.` Turn it off
for a quieter chat; the overlay still updates either way.

**Organise notes by game**
- **Auto** (default) — follows your Twitch category, so every game keeps a separate
  notebook. Checked once a minute.
- **Manual** — files everything under one name you choose. Good for Just Chatting
  or if you don't change categories.

**VIPs can add notes** — off by default. Lets VIPs add notes, but not delete or clear.

**Viewer cooldown** — seconds a regular viewer waits between `show`/`hide`/`list`.
Set to 0 to disable.

---

## Troubleshooting

**Nothing appears in OBS**
Right-click the browser source → **Refresh**. Check the console window is still
open and the dashboard shows Twitch as connected.

**The notebook is blurry**
Your OBS canvas resolution probably doesn't match your monitor. Set the browser
source to exactly 1920×1080 and don't scale it — the notebook renders at native
size on purpose, because scaling blurs text in OBS.

**Commands do nothing**
Check the dashboard's **Activity** log. If chat shows red, reconnect Twitch. Also
make sure you're typing in the chat of the account you connected.

**"Twitch rejected the login"**
Your token expired or access was revoked. Click **Disconnect**, then
**Connect with Twitch** again.

**Port 8765 is already in use**
Something else has the port. Close it, or set a different one:
`set PORT=8790 && node server.js` — then update the OBS browser source URL to match.

**Notes aren't saving**
The dashboard will say so. Usually means `better-sqlite3` failed to install —
delete the `node_modules` folder and run `start.bat` again.

---

## For the person sharing this repo

Before handing out the link, register a Twitch application once so nobody
downstream has to:

1. Go to [dev.twitch.tv/console/apps](https://dev.twitch.tv/console/apps) → **Register Your Application**
2. **OAuth Redirect URL:** `http://localhost` (unused by device flow, but the form requires it)
3. **Category:** Chat Bot · **Client Type:** Public
4. Copy the Client ID into `CLIENT_ID` in [`lib/TwitchAuth.js`](lib/TwitchAuth.js)

A public client ID isn't a secret — it's meant to ship in the app, which is exactly
why this flow needs no client secret at all. Users who download the repo then have
genuinely zero configuration.

---

## Where your data lives

Everything user-specific is in `data/` (gitignored, never committed):

| File | Contents |
|---|---|
| `notes.db` | Every note, chapter and game — SQLite, back it up if you care about it |
| `settings.json` | Your options and Twitch token |
| `notes-state.json` | Whether the overlay is currently on/visible |

To move to a new PC, copy the `data/` folder across.

---

## How it works

```
Twitch chat ──┐
              ├──► chat adapter ──► NotesService ──► SQLite (data/notes.db)
Streamer.bot ─┘                          │
                                         └──► WebSocket ──► overlay in OBS
                                                        └──► notes manager page
```

The overlay never holds authoritative state — the server sends a full render on
every change and the overlay diffs it to drive the animations. A dropped message
can't desync the display; it just resolves on the next update.

Adapted from the notes service in a larger multi-service streaming server.
The notebook module (`public/notebook-overlay.js`) is self-contained and can be
dropped into any existing overlay page: include it, call `NotesOverlay.attach(ws)`
on connect, and route `note:*` events to `NotesOverlay.handle(event, data)`.

---

## License

MIT — do what you like with it.
