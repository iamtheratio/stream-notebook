'use strict';

/**
 * Stream Notebook — standalone server.
 *
 * Boots three things and wires them together:
 *   1. NotesService  — the notebook itself (SQLite, chat commands, overlay state)
 *   2. A chat adapter — Twitch IRC, connected directly with no bot software
 *   3. A web server  — setup dashboard, notes manager, and the OBS overlay page
 *
 * There is no config file. Everything is set from the dashboard (port 8765 by
 * default) and stored in data/settings.json.
 */

const express = require('express');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const { WebSocketServer } = require('ws');

const settings = require('./lib/Settings');
const auth = require('./lib/TwitchAuth');
const NotesService = require('./lib/NotesService');
const TwitchChat = require('./lib/adapters/TwitchChat');

// A developer setting PORT explicitly wants that port and no browser popped at
// them; anyone else gets 8765 and whatever it takes to actually come up.
const PORT_FROM_ENV = !!process.env.PORT;
const PREFERRED_PORT = Number(process.env.PORT) || settings.get().port || 8765;
const PORT_ATTEMPTS = 10;

/** Open a URL in the default browser. Never throws — the URL is printed anyway. */
function openUrl(url) {
    try {
        if (process.platform === 'win32') {
            spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
        } else if (process.platform === 'darwin') {
            spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
        } else {
            spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
        }
    } catch (_) { /* nothing worth failing a boot over */ }
}

class StreamNotebookServer {
    constructor() {
        this.app = express();
        this.server = http.createServer(this.app);
        this.wss = new WebSocketServer({ server: this.server });

        // ws forwards the http server's errors onto itself, and an unhandled
        // 'error' on an EventEmitter kills the process — which would defeat the
        // port walk in _listen() before it ever retried.
        this.wss.on('error', err => {
            if (err.code === 'EADDRINUSE') return;   // _listen owns this one
            this._log('error', `WebSocket server error: ${err.message}`);
        });

        this.logs = [];              // rolling buffer shown in the dashboard
        this.chat = null;            // active TwitchChat instance, if any
        this.chatStatus = { source: null, state: 'idle', detail: 'Not started' };
        this.port = PREFERRED_PORT;  // real bound port, set once listen succeeds
        this.currentCategory = null; // last category seen on the Twitch channel
        this.categoryTimer = null;

        this.notes = new NotesService(this.wss, {
            settings,
            gameResolver: () => this._resolveGame(),
            replyTransport: msg => this._reply(msg),
        });
        this.notes.onLog = (level, line, data) => this._log(level, line, data);
    }

    async start() {
        await this.notes.initialize();
        this._routes();
        this._sockets();

        auth.onChange = () => this._applySources();
        this._applySources();

        this.port = await this._listen();

        // Deliberately ASCII-only: the Windows console code page mangles emoji
        // and box-drawing characters, and garbled text on first launch reads as
        // "it's broken" to the non-technical people this is built for.
        console.log('');
        console.log('  Stream Notebook is running');
        console.log('  ---------------------------------------------');
        console.log(`  Dashboard   http://localhost:${this.port}`);
        console.log(`  OBS overlay http://localhost:${this.port}/overlay.html`);
        if (this.port !== PREFERRED_PORT) {
            console.log('');
            console.log(`  Note: port ${PREFERRED_PORT} was busy, so this moved to ${this.port}.`);
            console.log('  Use the addresses above - the older ones will not work.');
        }
        console.log('');
        console.log('  Keep this window open. Closing it turns the notebook off.');
        console.log('');

        if (!PORT_FROM_ENV) this._openDashboard();
    }

    /**
     * Is a Stream Notebook already running on this port? Distinguishes "some
     * other program has 8765" (walk to 8766) from "the user double-clicked
     * start.bat twice" (do NOT start a second one).
     *
     * Two notebooks is far worse than it sounds: OBS stays pointed at the first,
     * but the dashboard that opens belongs to the second, so every setting the
     * user changes silently fails to affect what's on screen.
     */
    static async findExisting(port) {
        try {
            const res = await fetch(`http://localhost:${port}/api/status`, {
                signal: AbortSignal.timeout(1500),
            });
            if (!res.ok) return false;
            const body = await res.json();
            // Must be OUR marker. Another app on this port answering 200 is not us.
            return !!body && body.app === 'stream-notebook';
        } catch (_) {
            return false; // nothing there, or something that isn't us
        }
    }

    /**
     * Bind the preferred port, walking upward if it's taken. Something else
     * holding 8765 is the one failure a non-technical user hits and cannot
     * diagnose, so we route around it rather than reporting it.
     */
    _listen() {
        return new Promise((resolve, reject) => {
            let port = PREFERRED_PORT;

            const attempt = () => {
                const onError = err => {
                    if (err.code !== 'EADDRINUSE' || port >= PREFERRED_PORT + PORT_ATTEMPTS) {
                        return reject(err);
                    }
                    port += 1;
                    attempt();
                };

                this.server.once('error', onError);
                this.server.listen(port, () => {
                    this.server.removeListener('error', onError);
                    resolve(port);
                });
            };

            attempt();
        });
    }

    /** Pop the dashboard in the default browser — the bat file can't, it doesn't know the port. */
    _openDashboard() {
        openUrl(`http://localhost:${this.port}`);
    }

    // ─── Game resolution ────────────────────────────────────────────────────

    _resolveGame() {
        const s = settings.get();
        if (s.gameSource === 'twitch' && this.currentCategory) {
            return { name: this.currentCategory, type: 'twitch-category' };
        }
        return { name: s.manualGame || 'Stream Notes', type: 'manual' };
    }

    /**
     * Poll the connected channel's category. Twitch has no push for this, and a
     * 60s poll is far below any rate limit while still catching a game change
     * within a break.
     */
    _startCategoryWatch() {
        clearInterval(this.categoryTimer);
        if (settings.get().gameSource !== 'twitch') return;

        const tick = async () => {
            const cat = await auth.getCurrentCategory();
            if (cat && cat !== this.currentCategory) {
                this.currentCategory = cat;
                // Still tracked while pinned, so unpinning lands on the right game —
                // just don't move the notebook out from under a deliberate pin.
                if (this.notes.pinnedGameId != null) {
                    this._log('info', `🎮 Category changed → ${cat} (notebook stays pinned)`);
                    return;
                }
                this._log('info', `🎮 Category changed → ${cat}`);
                this.notes.handleEvent({ event: 'game-changed', data: {} });
            }
        };
        tick();
        this.categoryTimer = setInterval(tick, 60000);
    }

    // ─── Chat wiring ────────────────────────────────────────────────────────

    /** (Re)start chat + category watching to match current settings. */
    _applySources() {
        const s = settings.get();

        if (this.chat) { this.chat.stop(); this.chat = null; }

        this.chat = new TwitchChat({
            onMessage: msg => this.notes.handleEvent({ event: 'chat-message', data: msg }),
            onStatus: st => {
                this.chatStatus = st;
                this._log(st.state === 'error' ? 'error' : 'info', `💬 Twitch chat: ${st.detail}`);
            },
        });
        this.chat.start();

        this._startCategoryWatch();
        this.notes._loadConfig();  // pick up permission changes without a restart
        this.notes._refreshGame('settings');
    }

    _reply(message) {
        if (!settings.get().chatReplies) return;
        if (this.chat) this.chat.say(message);
    }

    /** Tell any open overlay to re-apply its size/position. */
    _pushLayout() {
        const s = settings.get();
        const payload = JSON.stringify({
            event: 'notebook:layout',
            data: {
                overlayScale: s.overlayScale, overlayCorner: s.overlayCorner,
                verticalScale: s.verticalScale, verticalCorner: s.verticalCorner,
            },
        });
        this.wss.clients.forEach(c => { if (c.readyState === 1) { try { c.send(payload); } catch (_) {} } });
    }

    // ─── HTTP ───────────────────────────────────────────────────────────────

    _routes() {
        this.app.use(express.json());
        this.app.use(express.static(path.join(__dirname, 'public')));
        // Friendly aliases. People type the name of the thing they want rather
        // than remembering that the dashboard lives at the bare root.
        const page = f => (req, res) => res.sendFile(path.join(__dirname, 'public', f));
        this.app.get('/', page('dashboard.html'));
        this.app.get('/dashboard', page('dashboard.html'));
        this.app.get('/settings', page('dashboard.html'));
        this.app.get('/notes', page('notes.html'));
        this.app.get('/overlay', page('overlay.html'));

        // ── Notes management API (backs public/notes.html) ──
        // Every mutation goes THROUGH NotesService so it persists to SQLite and
        // broadcasts note:render — the on-stream overlay stays in sync live.
        const withNotes = (res, fn) => {
            try { return res.json({ ok: true, ...fn(this.notes) }); }
            catch (e) { return res.status(400).json({ ok: false, error: e.message }); }
        };
        this.app.get('/api/notes', (req, res) => withNotes(res, s => ({ tree: s.mgmtTree(), state: s.mgmtState() })));
        this.app.post('/api/notes/note', (req, res) => withNotes(res, s => ({ note: s.mgmtAddNote(req.body.chapterId, req.body.text) })));
        this.app.put('/api/notes/note/:id', (req, res) => withNotes(res, s => ({ note: s.mgmtUpdateNote(+req.params.id, req.body.text) })));
        this.app.post('/api/notes/note/:id/toggle', (req, res) => withNotes(res, s => ({ note: s.mgmtToggle(+req.params.id, req.body.field, req.body.value) })));
        this.app.delete('/api/notes/note/:id', (req, res) => withNotes(res, s => s.mgmtDeleteNote(+req.params.id)));
        this.app.post('/api/notes/chapter', (req, res) => withNotes(res, s => ({ chapter: s.mgmtAddChapter(req.body.gameId, req.body.title) })));
        this.app.put('/api/notes/chapter/:id', (req, res) => withNotes(res, s => ({ chapter: s.mgmtRenameChapter(+req.params.id, req.body.title) })));
        this.app.delete('/api/notes/chapter/:id', (req, res) => withNotes(res, s => s.mgmtDeleteChapter(+req.params.id)));
        this.app.delete('/api/notes/game/:id', (req, res) => withNotes(res, s => s.mgmtDeleteGame(+req.params.id)));
        this.app.post('/api/notes/chapter/:id/switch', (req, res) => withNotes(res, s => s.mgmtSwitchChapter(+req.params.id)));
        this.app.post('/api/notes/game/:id/pin', (req, res) => withNotes(res, s => ({ state: s.mgmtPinGame(+req.params.id) })));
        this.app.post('/api/notes/unpin', (req, res) => withNotes(res, s => ({ state: s.mgmtUnpinGame() })));
        this.app.post('/api/notes/chapter/:id/archive-done', (req, res) => withNotes(res, s => s.mgmtArchiveDone(+req.params.id)));
        this.app.post('/api/notes/note/:id/archive', (req, res) => withNotes(res, s => s.mgmtArchiveNote(+req.params.id)));
        this.app.post('/api/notes/note/:id/unarchive', (req, res) => withNotes(res, s => s.mgmtUnarchiveNote(+req.params.id)));
        this.app.post('/api/notes/chapter/:id/unarchive-all', (req, res) => withNotes(res, s => s.mgmtUnarchiveAll(+req.params.id)));
        this.app.post('/api/notes/overlay', (req, res) => withNotes(res, s => ({ state: s.mgmtOverlay(req.body.action) })));

        // ── Stop the notebook from the dashboard ──
        // Otherwise the only way to stop it is closing a black console window,
        // which nobody has been told is the off switch.
        this.app.post('/api/shutdown', (req, res) => {
            res.json({ ok: true });
            this._log('info', 'Shutdown requested from the dashboard');
            // Let the response flush before the process goes away.
            setTimeout(() => {
                console.log('');
                console.log('  Notebook stopped from the dashboard.');
                console.log('  Double-click start.bat to start it again.');
                console.log('');
                process.exit(0);
            }, 250);
        });

        // ── Settings (dashboard-managed; never hand-edited) ──
        this.app.get('/api/settings', (req, res) => res.json({ ok: true, settings: settings.publicView() }));
        this.app.post('/api/settings', (req, res) => {
            settings.update(req.body || {});
            this._applySources();
            this._pushLayout();   // overlay resizes live, no OBS refresh needed
            res.json({ ok: true, settings: settings.publicView() });
        });

        // ── Twitch account ──
        this.app.get('/api/twitch/status', (req, res) => res.json({ ok: true, ...auth.status() }));
        this.app.post('/api/twitch/connect', async (req, res) => {
            try { res.json({ ok: true, ...(await auth.startDeviceFlow()) }); }
            catch (e) { res.status(400).json({ ok: false, error: e.message }); }
        });
        this.app.post('/api/twitch/disconnect', (req, res) => {
            auth.disconnect();
            res.json({ ok: true });
        });

        // ── Live status for the dashboard header ──
        this.app.get('/api/status', (req, res) => res.json({
            ok: true,
            // Identifies us to findExisting(). Port 8765 is shared with the user's
            // own Websocket Server, so "something answered" is NOT proof it's us —
            // without this marker a second app on the port could make Stream
            // Notebook refuse to start and open the wrong dashboard.
            app: 'stream-notebook',
            chat: this.chatStatus,
            twitch: auth.status(),
            game: this.notes.currentGame ? this.notes.currentGame.name : null,
            persists: !!this.notes.db,
            overlayUrl: `http://localhost:${this.port}/overlay.html`,
            logs: this.logs.slice(-60),
        }));
    }

    // ─── WebSocket ──────────────────────────────────────────────────────────

    _sockets() {
        this.wss.on('connection', socket => {
            socket.serviceSubscriptions = new Set();

            socket.on('message', raw => {
                let msg;
                try { msg = JSON.parse(raw.toString()); } catch (_) { return; }

                // Overlay / manager handshake — mirrors the upstream server so the
                // overlay module works here byte-for-byte unmodified.
                if (msg.event === 'subscribe-to-service' || msg.type === 'subscribe-to-service') {
                    const name = msg.service || (msg.data && msg.data.service);
                    if (name) {
                        socket.serviceSubscriptions.add(name);
                        if (name === 'notes') this.notes.onClientConnect(socket);
                    }
                    return;
                }

                // Everything else. `chat-message` is still accepted here, which is
                // how the service is driven in testing; nothing user-facing sends it.
                try { this.notes.handleEvent(msg, socket); }
                catch (err) { this._log('error', `Event failed: ${err.message}`); }
            });

            socket.on('close', () => this.notes.onClientDisconnect(socket));
        });
    }

    _log(level, message, data) {
        this.logs.push({ level, message, at: new Date().toISOString() });
        if (this.logs.length > 200) this.logs.shift();
    }
}

(async () => {
    // Already running? Show them that one instead of quietly starting a rival.
    if (await StreamNotebookServer.findExisting(PREFERRED_PORT)) {
        console.log('');
        console.log('  Stream Notebook is already running.');
        console.log('  ---------------------------------------------');
        console.log(`  Opening the dashboard at http://localhost:${PREFERRED_PORT}`);
        console.log('');
        console.log('  You only need one copy running. To stop it, use the');
        console.log('  Stop button on the dashboard, or close its window.');
        console.log('');
        if (!PORT_FROM_ENV) openUrl(`http://localhost:${PREFERRED_PORT}`);
        // Give the browser a moment to launch before this window disappears.
        setTimeout(() => process.exit(0), 2000);
        return;
    }

    await new StreamNotebookServer().start();
})().catch(err => {
    console.error('Failed to start:', err);
    process.exit(1);
});
