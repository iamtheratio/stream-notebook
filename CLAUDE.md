# Stream Notebook — project notes for Claude

## What this is

A standalone, shareable extraction of the `notes` service from the user's larger
`D:\Websocket Server` project. Built 2026-07-21 so a friend (l337) — and anyone
else — can run the on-stream notebook without the rest of that server.

Repo: **https://github.com/iamtheratio/stream-notebook** (public).

**Audience is non-technical streamers** — entertainers, not IT people. That single
constraint drives most decisions here and is worth over-weighting: no config files,
no tokens to paste, no terminal knowledge assumed, no jargon in user-facing text.
When choosing between powerful and obvious, pick obvious.

## Hard rules

- **No user-facing config files.** Everything is set in the dashboard and stored in
  `data/settings.json`, which the user never opens. Do not add a `config.json` or
  ask the user to edit JSON.
- **No native browser dialogs.** No `alert()`, `confirm()`, `prompt()`. Use the
  in-page modal and toast already in `public/dashboard.html`.
- **Console output stays ASCII-only.** The Windows console code page renders emoji
  and box-drawing characters as mojibake (`📓` → `≡ƒôô`, `→` → `ΓåÆ`), and garbled
  text on first launch reads as "it's broken" to this audience. `chcp 65001` was
  tried and did not reliably fix it. `BaseService.toConsole()` transliterates log
  lines (`→` → `->`, `✔` → `v`) and strips anything left outside ASCII; the browser
  dashboard still receives the original, emoji and all. Note `server.js:_log()` only
  feeds the dashboard, never the console, so emoji is fine there.
- **Don't break `notebook-overlay.js`.** It is byte-identical to the upstream file
  and is a shared module in the user's own overlays. Changes must be portable back.
- **`data/` is gitignored** — it holds a Twitch OAuth token. Never commit it.

## Layout

```
start.bat                     the user's entry point; guards the common failures
server.js                     express + ws, REST API, port fallback, adapter wiring
lib/
  NotesService.js             the notebook (forked from upstream — see below)
  BaseService.js              minimal stub of upstream's base class
  Settings.js                 dashboard-managed settings store
  TwitchAuth.js               device-code OAuth + token refresh + category read
  Autostart.js                Startup-folder shortcut, as a dashboard toggle
  adapters/
    TwitchChat.js             raw Twitch IRC over WebSocket
public/
  dashboard.html              setup UI (the main surface for users)
  notes.html                  notes manager (verbatim from upstream)
  overlay.html                standalone OBS host page
  notebook-overlay.js         the notebook module (verbatim from upstream)
docs/README-images.md         shot list for the screenshots README.md links
```

## Twitch-only, deliberately (v1)

Streamer.bot support was **removed**, not hidden. Gone: `adapters/StreamerbotReply.js`,
the `streamerbot/` folder and its C# bridge, `GET /api/streamerbot-script`, the
`chatSource`/`streamerbot` settings, and the dashboard's chat-source picker.

**Why:** it was the only feature that could fail *silently and invisibly*. It needed
a C# script compiled inside another program, a trigger attached, and a second action
named exactly right for replies — and any mistake meant `!note` simply did nothing,
with no error anywhere. That is the worst possible support burden for this audience.
The cost is that v1 is Twitch-only: no YouTube, no TikTok.

**Don't re-add it casually.** If multi-platform comes back, `git log` has the whole
implementation. The seam that makes it cheap is still in place: the WebSocket still
accepts `chat-message` events from anything, which is how the service is driven in
testing. It is undocumented and unexposed on purpose.

`Settings._load()` and `.update()` both `delete` the old `chatSource`/`streamerbot`
keys, so an install upgrading from v1 can't end up pointed at a source that no
longer exists.

## Upstream fork relationship

`NotesService.js` is a fork of `D:\Websocket Server`'s `services/notes/NotesService.js`.
Three seams were opened deliberately:

1. **`gameResolver`** — upstream reached into sibling services (`gameLogoOverlay`,
   `hackInfo`) for the current game. Now an injected callback: Twitch category poll
   or a manual name.
2. **`replyTransport`** — upstream hard-coded an HTTP POST to Streamer.bot on
   `127.0.0.1:7474`. Now injected; since v1 the only transport wired is Twitch IRC.
3. **Paths + config** — `DB_PATH`/`STATE_PATH` moved under `data/`; the
   `config.json` read became `Settings.get()`.

**Anything touching `NotesService.js` outside those seams should be ported back to
`D:\Websocket Server`, or the two drift.** There is currently one such change
outstanding — see "Open items" below.

## Permissions

Roles are independent toggles, each granting a fixed level (`_permission()`):

| Role | Setting | Level |
|---|---|---|
| Broadcaster | none — always on | `full` |
| Moderators | `modsCanManage` (default **on**) | `full` |
| VIPs | `vipCanAdd` (default off) | `add` |
| Subscribers | `subsCanAdd` (default off) | `add` |
| Everyone | — | `view` (show/hide/list, rate-limited) |

Mods are hand-picked so they get everything; VIP/sub are cheaper to obtain so they
only ever get `add`. The broadcaster is intentionally not a setting — there is no
sane reason to let someone lock themselves out of their own notebook.

`modsCanManage` exists because mods aren't always trusted (the user's phrasing:
"mods are jerks sometimes"). Turning it off drops mods to `view`.

Fall-through is ordered, so a mod who is *also* a VIP still gets `add` when
`modsCanManage` is off. Left that way on purpose — it follows the toggles
literally — but it's arguably wrong if "mods off" should mean "no mod, regardless
of other badges." One-line change if the user ever asks.

New settings keys need no server whitelist: `POST /api/settings` passes the body
to `settings.update()`, and `Settings._load()` merges `DEFAULTS` over saved data so
existing installs pick up new keys at their defaults rather than `undefined`.

## Twitch integration

Device Code Flow, deliberately — no client secret, no redirect URI registration,
works on any port. `CLIENT_ID` in `lib/TwitchAuth.js` is filled in and shipped;
a public client ID is not a secret. Scopes: `chat:read`, `chat:edit`. Reading the
channel category needs no extra scope.

**Adding a scope invalidates every existing token** and forces everyone to
reconnect — treat that as a real cost. It's why follower-gating was rejected: there
is no follower badge in IRC tags, so it would need `moderator:read:followers`, a
Helix call per chatter, and a cache — to gate on something anyone can obtain
instantly anyway.

Chat is raw IRC over `wss://irc-ws.chat.twitch.tv:443` using the `ws` package — no
tmi.js dependency. Two gotchas:
- Emote positions in the IRC tag are code-point indexed, so `TwitchChat._emotes`
  slices `Array.from(message)`, not the string.
- Early subscribers carry a `founder/` badge instead of `subscriber/`. Miss it and
  the longest-tenured subs are the only ones locked out.

## Ports

`server.js` walks upward from the preferred port on `EADDRINUSE` (10 attempts) and
reports the port it actually bound. Consequences worth remembering:

- `this.port`, not a module constant, is the source of truth — `/api/status`'s
  `overlayUrl` uses it.
- `ws` re-emits the http server's `error` onto the `WebSocketServer`. Without a
  handler there, `EADDRINUSE` kills the process as an unhandled `error` before the
  retry runs. `this.wss.on('error', …)` in the constructor exists solely for that.
- The server opens the browser itself (`_openDashboard`), because `start.bat` can't
  know the port. Suppressed when `PORT` is set explicitly, so dev runs don't pop tabs.
- **`findExisting()` runs before the port walk.** Without it, a second double-click
  on `start.bat` starts a rival on 8766: OBS stays pointed at the first, but the
  dashboard that opens belongs to the second, so settings changes silently do
  nothing. It probes `/api/status` and, if that's us, opens the existing dashboard
  and exits 0.

## Game pin

`pinnedGameId` (in the **state file**, not settings — that keeps the change
identical in both repos instead of straddling the `Settings.get()` vs `config.json`
seam). Enforced in **`resolveGameName()`**, deliberately: that's the single choke
point every caller goes through, so the poll, chat commands and session start all
respect the pin without needing their own guards.

Without a pin, "show this game on stream" is impossible — the category poll would
silently drag the notebook back within 60s. `mgmtSwitchChapter` therefore auto-pins
when the target chapter belongs to another game, rather than refusing as it used to.

The notes manager shows `PINNED` vs `LIVE` with an inline Unpin. That label is
load-bearing: a pinned notebook that ignores your Twitch category looks like a bug
unless the UI says otherwise.

## Overlay size and position

`overlayScale` + `overlayCorner`, applied by **`overlay.html`**, never by
`notebook-overlay.js` — that file is byte-identical to upstream and must stay so.
The module renders at a fixed 400x570 bottom-left, which is small on 1440p and
badly placed on a vertical canvas.

Scaling uses **`zoom`, not `transform: scale`**. The module's own comment explains
why: a transform promotes it to a composited layer and CEF then bilinear-samples
the emote images and blurs the text. `zoom` re-lays-out and rasterizes at the new
size, staying crisp.

Settings changes broadcast `notebook:layout` over the WebSocket (`_pushLayout`), so
OBS updates live. `overlay.html` also fetches `/api/settings` on load, so it lays
out correctly before any socket traffic arrives.

## Starting and stopping

There is no tray app — considered and rejected 2026-07-21. A C# tray launcher would
have been ~20-50KB on the .NET Framework that ships with Windows, but an unsigned
`.exe` can be silently quarantined by antivirus, which is a worse failure than the
console window it replaces. Signing costs real money. Revisit only if the download
is signed. PowerShell tray scripts are worse still — `-ExecutionPolicy Bypass` is
itself an antivirus heuristic.

What exists instead:
- **Autostart toggle** (`lib/Autostart.js`) writes a `.lnk` into the Startup folder
  via PowerShell's `WScript.Shell`, `WindowStyle = 7` (minimized). Windows-only; the
  dashboard row hides itself elsewhere. The manual alternative is Win+R →
  `shell:startup`, which this audience will not do.
- **Stop button** on the dashboard → `POST /api/shutdown`. The only other off switch
  is closing an unlabelled black window.

## Testing

No test framework. Boot on a spare port and drive the WebSocket directly:

```powershell
$env:PORT="8799"; node server.js
```

Connect a `ws` client, send `{event:'subscribe-to-service',service:'notes'}`, inject
`{event:'chat-message',data:{message:'!note hi',isBroadcaster:true,...}}`, and assert
on the `note:render` payloads.

**`DB_PATH` does not vary with port** — tests write into the real `data/notes.db`.
Check what's in there before and clean up after, or you'll leave junk in the user's
notebook.

**Overlay animations can't be verified by reading the code.** A swipe was once
"fixed" by checking the CSS looked right; it still swapped the notes on screen,
because the service fires `note:notebook` and `note:render` back to back and the
render landed at ~30ms into a 500ms swipe. Drive it in a real browser instead —
Edge is present on this machine and takes virtual time:

```powershell
& "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --headless=new `
  --disable-gpu --virtual-time-budget=4000 --dump-dom "file:///<page>" > dump.html
```

Build a page that loads `notebook-overlay.js`, drives `NotesOverlay.handle()` with
a payload shaped like `buildState()`, samples class + rendered title every 30ms,
and writes the timeline into the DOM for `--dump-dom` to capture. **Then run it
against the previous commit** (`git show HEAD:public/notebook-overlay.js`) and
confirm it fails — an animation test that passes both ways is testing nothing.

Useful checks that have caught real bugs:
- Boot twice to exercise the port walk (the `wss` error bug surfaced this way).
- Extract the dashboard's inline `<script>`, `vm.Script` it for syntax, and confirm
  every `getElementById` id exists in the markup — the dashboard is one big HTML
  file with no build step, so nothing else catches a typo'd id.
- Run `start.bat` itself, not just `node server.js`. The console mojibake was only
  visible that way.

Verified working 2026-07-21: notes CRUD over chat (add, edit, done, scratch, chapter
switch, show), the full permission matrix across all four roles including
`modsCanManage` off, port fallback, already-running detection, autostart
enable/disable (shortcut created with the right target and removed cleanly), the
dashboard Stop button, ASCII console transliteration, and `start.bat` end to end.

Also now confirmed against **live** Twitch: the stored token works and the channel
category read succeeds — a `games` row with `type: 'twitch-category'` appears on
boot. Still unproven: approving a *fresh* device code, the refresh path once a token
expires, and IRC chat actually connecting.

## Style

Match the existing code: 4-space indent in `lib/`, `'use strict'`, section banner
comments (`// ─── Name ───`), comments that explain *why* rather than *what*.
The dashboard uses the same dark-glass aesthetic as the user's other dashboards,
with Twitch purple (`#9146FF`) as the accent instead of green.

User-facing text is its own discipline here. Prefer "a black window opens with white
text — that's normal" over "a console window will appear." Say what the user should
*do*, name the button they should click, and say what it looks like when it worked.

## Open items

- **Screenshots don't exist yet.** `README.md` links five images under `docs/img/`;
  GitHub shows broken-image icons until they're added. `docs/README-images.md` is
  the shot list. Only the user can take them.
- **Port the permission rework back to `D:\Websocket Server`.** `_permission()`,
  `modsCanManage`/`subsCanAdd`, and the `founder/` badge fix all touch shared code.
  The `TwitchChat.js` and dashboard changes are standalone-only.
- **Never end-to-end tested against live Twitch**: approving the device code on
  twitch.tv/activate, the token poll/refresh that follows, IRC chat connecting, and
  the overlay rendering in a real OBS browser source at 1920x1080.
