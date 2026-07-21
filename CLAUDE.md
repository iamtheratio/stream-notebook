# Stream Notebook — project notes for Claude

## Where we left off (2026-07-21)

Built, tested end to end, and pushed to
**https://github.com/iamtheratio/stream-notebook** (public, one commit).

**Blocker before anyone can use it:** `CLIENT_ID` in `lib/TwitchAuth.js` is still
the placeholder. Register a Twitch app (dev.twitch.tv/console/apps → redirect URL
`http://localhost`, category Chat Bot, client type **Public**), paste the ID in,
commit and push. It is not a secret — public clients are meant to ship it.

Then: run `start.bat`, walk the real Connect-with-Twitch flow (never exercised
against live Twitch yet), and confirm the overlay renders in an OBS browser
source at 1920x1080. After that it's ready to hand to l337.

Known loose end: `public/notes.html` silently swallows API errors — deleting the
live game returns a clear 400 that the page never shows. Same flaw upstream.

## What this is

A standalone, shareable extraction of the `notes` service from the user's larger
`D:\Websocket Server` project. Built 2026-07-21 so a friend (l337) — and anyone
else — can run the on-stream notebook without the rest of that server.

**Audience is non-technical streamers.** That constraint drives most decisions
here: no config files, no tokens to paste, no terminal knowledge assumed.

## Hard rules

- **No user-facing config files.** Everything is set in the dashboard and stored in
  `data/settings.json`, which the user never opens. Do not add a `config.json` or
  ask the user to edit JSON.
- **No native browser dialogs.** No `alert()`, `confirm()`, `prompt()`. Use the
  in-page modal and toast already in `public/dashboard.html`.
- **Don't break `notebook-overlay.js`.** It is byte-identical to the upstream file
  and is a shared module in the user's own overlays. Changes must be portable back.
- **`data/` is gitignored** — it holds a Twitch OAuth token. Never commit it.

## Layout

```
server.js                     express + ws, REST API, adapter wiring
lib/
  NotesService.js             the notebook (adapted from upstream)
  BaseService.js              minimal stub of upstream's base class
  Settings.js                 dashboard-managed settings store
  TwitchAuth.js               device-code OAuth + token refresh + category read
  adapters/
    TwitchChat.js             raw Twitch IRC over WebSocket
    StreamerbotReply.js       HTTP POST to Streamer.bot /DoAction
public/
  dashboard.html              setup UI (the main surface for users)
  notes.html                  notes manager (verbatim from upstream)
  overlay.html                standalone OBS host page
  notebook-overlay.js         the notebook module (verbatim from upstream)
streamerbot/ChatMessageScript.cs   optional multi-platform chat bridge
```

## What changed vs. upstream `services/notes/NotesService.js`

Three seams were opened; everything else is unchanged:

1. **`gameResolver`** — upstream reached into sibling services (`gameLogoOverlay`,
   `hackInfo`) for the current game. Now an injected callback: Twitch category poll
   or a manual name.
2. **`replyTransport`** — upstream hard-coded an HTTP POST to Streamer.bot on
   `127.0.0.1:7474`. Now injected: Twitch IRC, Streamer.bot, or nothing.
3. **Paths + config** — `DB_PATH`/`STATE_PATH` moved under `data/`; the
   `config.json` read became `Settings.get()`.

Bug fixes or features that touch anything *else* in `NotesService.js` should
probably be ported back to `D:\Websocket Server` too.

## Twitch integration

Device Code Flow, deliberately — no client secret, no redirect URI registration,
works on any port. `CLIENT_ID` in `lib/TwitchAuth.js` must be filled in by the
repo owner before sharing (see README's maintainer section). Scopes: `chat:read`,
`chat:edit`. Reading the channel category needs no extra scope.

Chat is raw IRC over `wss://irc-ws.chat.twitch.tv:443` using the `ws` package — no
tmi.js dependency. Emote positions in the IRC tag are code-point indexed, so
`TwitchChat._emotes` slices `Array.from(message)`, not the string.

## Testing

No test framework. Verify end to end by booting on a spare port and driving the
WebSocket directly:

```powershell
$env:PORT="8799"; node server.js
```

Then connect a `ws` client, send `{event:'subscribe-to-service',service:'notes'}`,
inject `{event:'chat-message',data:{message:'!note hi',isBroadcaster:true,...}}`,
and assert on the `note:render` payloads. This path was verified working on
2026-07-21 (add, edit, done, scratch, chapter switch, permission rejection, show).

## Style

Match the existing code: 4-space indent in `lib/`, `'use strict'`, section banner
comments (`// ─── Name ───`), comments that explain *why* rather than *what*.
The dashboard uses the same dark-glass aesthetic as the user's other dashboards,
with Twitch purple (`#9146FF`) as the accent instead of green.
