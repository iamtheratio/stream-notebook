'use strict';

/**
 * Stream Notebook — standalone server.
 *
 * Boots three things and wires them together:
 *   1. NotesService  — the notebook itself (SQLite, chat commands, overlay state)
 *   2. A chat adapter — Twitch IRC directly, or Streamer.bot feeding us events
 *   3. A web server  — setup dashboard, notes manager, and the OBS overlay page
 *
 * There is no config file. Everything is set from the dashboard at
 * http://localhost:8765 and stored in data/settings.json.
 */

const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');

const settings = require('./lib/Settings');
const auth = require('./lib/TwitchAuth');
const NotesService = require('./lib/NotesService');
const TwitchChat = require('./lib/adapters/TwitchChat');
const { sendViaStreamerbot } = require('./lib/adapters/StreamerbotReply');

const PORT = Number(process.env.PORT) || settings.get().port || 8765;

class StreamNotebookServer {
    constructor() {
        this.app = express();
        this.server = http.createServer(this.app);
        this.wss = new WebSocketServer({ server: this.server });

        this.logs = [];              // rolling buffer shown in the dashboard
        this.chat = null;            // active TwitchChat instance, if any
        this.chatStatus = { source: null, state: 'idle', detail: 'Not started' };
        this.currentCategory = null; // last category seen on the Twitch channel
        this.categoryTimer = null;

        this.notes = new NotesService(this.wss, {
            settings,
            gameResolver: () => this._resolveGame(),
            replyTransport: (msg, platform) => this._reply(msg, platform),
        });
        this.notes.onLog = (level, line, data) => this._log(level, line, data);
    }

    async start() {
        await this.notes.initialize();
        this._routes();
        this._sockets();

        auth.onChange = () => this._applySources();
        this._applySources();

        this.server.listen(PORT, () => {
            console.log('');
            console.log('  📓  Stream Notebook is running');
            console.log('  ─────────────────────────────────────────────');
            console.log(`  Dashboard   http://localhost:${PORT}`);
            console.log(`  OBS overlay http://localhost:${PORT}/overlay.html`);
            console.log('');
        });
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

        if (s.chatSource === 'twitch') {
            this.chat = new TwitchChat({
                onMessage: msg => this.notes.handleEvent({ event: 'chat-message', data: msg }),
                onStatus: st => {
                    this.chatStatus = st;
                    this._log(st.state === 'error' ? 'error' : 'info', `💬 Twitch chat: ${st.detail}`);
                },
            });
            this.chat.start();
        } else {
            this.chatStatus = { source: 'streamerbot', state: 'listening', detail: 'Waiting for Streamer.bot events' };
        }

        this._startCategoryWatch();
        this.notes._loadConfig();  // pick up permission changes without a restart
        this.notes._refreshGame('settings');
    }

    _reply(message, platform) {
        const s = settings.get();
        if (!s.chatReplies) return;
        if (s.chatSource === 'streamerbot') return sendViaStreamerbot(message, platform);
        if (this.chat) this.chat.say(message);
    }

    // ─── HTTP ───────────────────────────────────────────────────────────────

    _routes() {
        this.app.use(express.json());
        this.app.use(express.static(path.join(__dirname, 'public')));
        this.app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));

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
        this.app.post('/api/notes/chapter/:id/archive-done', (req, res) => withNotes(res, s => s.mgmtArchiveDone(+req.params.id)));
        this.app.post('/api/notes/note/:id/archive', (req, res) => withNotes(res, s => s.mgmtArchiveNote(+req.params.id)));
        this.app.post('/api/notes/note/:id/unarchive', (req, res) => withNotes(res, s => s.mgmtUnarchiveNote(+req.params.id)));
        this.app.post('/api/notes/chapter/:id/unarchive-all', (req, res) => withNotes(res, s => s.mgmtUnarchiveAll(+req.params.id)));
        this.app.post('/api/notes/overlay', (req, res) => withNotes(res, s => ({ state: s.mgmtOverlay(req.body.action) })));

        // ── Settings (dashboard-managed; never hand-edited) ──
        this.app.get('/api/settings', (req, res) => res.json({ ok: true, settings: settings.publicView() }));
        this.app.post('/api/settings', (req, res) => {
            settings.update(req.body || {});
            this._applySources();
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
            chat: this.chatStatus,
            twitch: auth.status(),
            game: this.notes.currentGame ? this.notes.currentGame.name : null,
            persists: !!this.notes.db,
            overlayUrl: `http://localhost:${PORT}/overlay.html`,
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

                // Everything else (including chat-message from Streamer.bot).
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

new StreamNotebookServer().start().catch(err => {
    console.error('Failed to start:', err);
    process.exit(1);
});
