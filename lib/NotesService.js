'use strict';

/**
 * NotesService — Game-Aware Composition Notebook Note System
 * ----------------------------------------------------------
 * Lets mods + broadcaster create / update / delete / display on-stream notes via
 * chat commands. Notes are auto-organized by game → chapter, where the "current
 * game" is resolved from existing in-memory state on sibling services (no extra
 * Twitch / SMWC lookups):
 *
 *   - Twitch category  → game-logo-overlay service (`currentGame`)
 *   - SMW hack name    → hack-info service (`hackInfo.game`)
 *
 * Both refs are injected by ServiceRegistry after all services register.
 *
 * Persistence: own SQLite DB at data/notes.db (better-sqlite3, WAL).
 * Front-end:   services/notes/notebook.html (OBS browser source) subscribes to
 *              service "notes" and renders a composition notebook with animations.
 *
 * This service is fully isolated — it only READS sibling state and never mutates
 * other services or core code.
 */

const path = require('path');
const fs = require('fs');
const BaseService = require('./BaseService');

let Database;
try { Database = require('better-sqlite3'); } catch (_) { Database = null; }

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'notes.db');
const STATE_PATH = path.join(DATA_DIR, 'notes-state.json');

const DEFAULT_CHAPTER = 'General Notes';
const COMPLETED_CHAPTER = 'Completed Notes';

class NotesService extends BaseService {
    constructor(wss, opts = {}) {
        super('notes', wss);
        this.logEmoji = '📓';

        this.db = null;

        /**
         * Pluggable seams (standalone build). Both are swapped in by server.js.
         *
         *  gameResolver()  → { name, type } for the game currently being played.
         *                    Default: a static name the user sets in the dashboard.
         *  replyTransport(message, platform) → deliver a chat reply, or no-op.
         *
         * The upstream server resolved the game by reaching into sibling services
         * and replied via a hard-coded Streamer.bot HTTP call; here both are
         * injected so the package works with Twitch directly, with Streamer.bot,
         * or with neither.
         */
        this.gameResolver = opts.gameResolver || (() => ({ name: 'Stream Notes', type: 'manual' }));
        this.replyTransport = opts.replyTransport || (() => {});
        this.settings = opts.settings || null;

        // Resolved-game session cache (fallback when sibling state is empty)
        this.currentGame = null;     // { id, name, type }
        this.currentChapterId = null;

        // Overlay state
        this.enabled = true;   // master on/off (!note on / !note off)
        this.visible = false;  // pinned-visible flag (!note show pins, !note hide unpins);
                               // default hidden — new notes reveal it transiently (~20s)

        // Game pin. When set, this game is shown on stream regardless of what the
        // gameResolver says, and the category poll stops moving the notebook. Lets
        // you put last week's boss notes up while the channel still says Just
        // Chatting. Persisted in the state file so it survives a restart.
        this.pinnedGameId = null;

        // Permissions. Broadcaster is always 'full' and intentionally not a flag.
        this.modsCanManage = true;
        this.vipCanAdd = false;
        this.subsCanAdd = false;

        // Anti-spam: per-user cooldown on the PUBLIC commands (show/hide/list) so
        // non-privileged chatters can't flicker the overlay. Mods/broadcaster exempt.
        this.publicCooldownMs = 10000; // overridable via config.json -> notes.publicCooldownSec
        this._publicCooldowns = new Map(); // lowercase username → last-use epoch ms
    }

    // ─── Lifecycle ──────────────────────────────────────────────────────────

    async initialize() {
        this._loadConfig();
        this._loadState();
        this._initDb();
        this._refreshGame('init'); // resolve game now so DB rows exist on first connect
        this.logToDashboard('info', `Service initialized (game: ${this.currentGame?.name || 'none'})`);
    }

    /**
     * Permissions come from the dashboard-managed settings store, not a file the
     * user edits. Called again by server.js whenever settings are saved, so
     * revoking a role mid-stream takes effect immediately — which is the whole
     * point of being able to turn mods off.
     */
    _loadConfig() {
        if (!this.settings) return;
        const s = this.settings.get();
        this.modsCanManage = s.modsCanManage !== false; // default on, as before
        this.vipCanAdd = s.vipCanAdd === true;
        this.subsCanAdd = s.subsCanAdd === true;
        const cd = Number(s.publicCooldownSec);
        if (Number.isFinite(cd) && cd >= 0) this.publicCooldownMs = cd * 1000;
    }

    _loadState() {
        try {
            const s = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
            if (typeof s.enabled === 'boolean') this.enabled = s.enabled;
            if (typeof s.visible === 'boolean') this.visible = s.visible;
            if (Number.isInteger(s.pinnedGameId)) this.pinnedGameId = s.pinnedGameId;
        } catch (_) { /* first run */ }
    }

    _saveState() {
        try {
            fs.writeFileSync(STATE_PATH, JSON.stringify({
                enabled: this.enabled, visible: this.visible, pinnedGameId: this.pinnedGameId,
            }, null, 2));
        } catch (err) {
            this.logToDashboard('warn', `Failed to persist state: ${err.message}`);
        }
    }

    // ─── Database ───────────────────────────────────────────────────────────

    _initDb() {
        if (!Database) {
            this.logToDashboard('error', 'better-sqlite3 not installed — notes will not persist. Run: npm install');
            return;
        }
        if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

        this.db = new Database(DB_PATH);
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('foreign_keys = ON');

        this.db.exec(`
            CREATE TABLE IF NOT EXISTS games (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                name        TEXT NOT NULL,
                type        TEXT,
                created_at  TEXT NOT NULL,
                UNIQUE(name)
            );

            CREATE TABLE IF NOT EXISTS chapters (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                game_id     INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
                title       TEXT NOT NULL,
                created_at  TEXT NOT NULL,
                UNIQUE(game_id, title)
            );

            CREATE TABLE IF NOT EXISTS sessions (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                game_id     INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
                started_at  TEXT NOT NULL,
                ended_at    TEXT
            );

            CREATE TABLE IF NOT EXISTS notes (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                chapter_id  INTEGER NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
                note_number INTEGER NOT NULL,
                text        TEXT NOT NULL,
                emotes      TEXT,
                done        INTEGER NOT NULL DEFAULT 0,
                scratched   INTEGER NOT NULL DEFAULT 0,
                created_at  TEXT NOT NULL,
                updated_at  TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_notes_chapter_number ON notes(chapter_id, note_number);
            CREATE INDEX IF NOT EXISTS idx_chapters_game ON chapters(game_id);
            CREATE INDEX IF NOT EXISTS idx_sessions_game ON sessions(game_id);
        `);

        // Migration: add emotes column to a notes table created before this feature.
        try { this.db.exec('ALTER TABLE notes ADD COLUMN emotes TEXT'); } catch (_) { /* already exists */ }

        // Prepared statements (compiled once)
        // COLLATE NOCASE on both lookups: Twitch hands back category names whose
        // casing varies between listings ("SILENT HILL 2" the remake vs "Silent
        // Hill 2"), and a case-only difference used to silently start a second
        // notebook for the same game mid-stream. The UNIQUE constraints are still
        // BINARY, but findOrCreate* always looks up first, so this is what decides.
        this._stmt = {
            getGame: this.db.prepare('SELECT * FROM games WHERE name = ? COLLATE NOCASE'),
            insGame: this.db.prepare('INSERT INTO games (name, type, created_at) VALUES (?, ?, ?)'),
            getChapter: this.db.prepare('SELECT * FROM chapters WHERE game_id = ? AND title = ? COLLATE NOCASE'),
            insChapter: this.db.prepare('INSERT INTO chapters (game_id, title, created_at) VALUES (?, ?, ?)'),
            listChapters: this.db.prepare(`
                SELECT c.id, c.title,
                       (SELECT COUNT(*) FROM notes n WHERE n.chapter_id = c.id) AS note_count
                FROM chapters c WHERE c.game_id = ? ORDER BY c.id ASC`),
            maxNum: this.db.prepare('SELECT MAX(note_number) AS m FROM notes WHERE chapter_id = ?'),
            insNote: this.db.prepare(`INSERT INTO notes (chapter_id, note_number, text, emotes, created_at, updated_at)
                                      VALUES (?, ?, ?, ?, ?, ?)`),
            getNote: this.db.prepare('SELECT * FROM notes WHERE chapter_id = ? AND note_number = ?'),
            updText: this.db.prepare('UPDATE notes SET text = ?, emotes = ?, updated_at = ? WHERE id = ?'),
            updDone: this.db.prepare('UPDATE notes SET done = ?, updated_at = ? WHERE id = ?'),
            updScratch: this.db.prepare('UPDATE notes SET scratched = ?, updated_at = ? WHERE id = ?'),
            delNote: this.db.prepare('DELETE FROM notes WHERE id = ?'),
            clearChapter: this.db.prepare('DELETE FROM notes WHERE chapter_id = ?'),
            listNotes: this.db.prepare('SELECT * FROM notes WHERE chapter_id = ? ORDER BY note_number ASC'),
            openSession: this.db.prepare('INSERT INTO sessions (game_id, started_at) VALUES (?, ?)'),
            closeSession: this.db.prepare('UPDATE sessions SET ended_at = ? WHERE game_id = ? AND ended_at IS NULL'),
        };
    }

    _now() { return new Date().toISOString(); }

    findOrCreateGame(name, type) {
        let row = this._stmt.getGame.get(name);
        if (!row) {
            const info = this._stmt.insGame.run(name, type, this._now());
            row = { id: info.lastInsertRowid, name, type };
        } else if (type && row.type !== type) {
            // keep type fresh without disturbing notes
            this.db.prepare('UPDATE games SET type = ? WHERE id = ?').run(type, row.id);
        }
        return row;
    }

    findOrCreateChapter(gameId, title) {
        let row = this._stmt.getChapter.get(gameId, title);
        if (!row) {
            const info = this._stmt.insChapter.run(gameId, title, this._now());
            row = { id: info.lastInsertRowid, game_id: gameId, title };
        }
        return row;
    }

    findOrCreateDefaultChapter(gameId) {
        return this.findOrCreateChapter(gameId, DEFAULT_CHAPTER);
    }

    /**
     * Pick the chapter the cursor should land on for a game: the FIRST existing
     * chapter (oldest by id), or — only if the game has none at all — create the
     * default "General Notes" tab. This stops "General Notes" from being silently
     * recreated every time the game re-resolves after the user deleted it.
     */
    firstOrDefaultChapter(gameId) {
        const existing = this.db
            .prepare('SELECT * FROM chapters WHERE game_id = ? ORDER BY id ASC LIMIT 1')
            .get(gameId);
        return existing || this.findOrCreateDefaultChapter(gameId);
    }

    /**
     * Re-pack a chapter's note numbers to a gapless 1..N sequence (preserving the
     * current order). Called after a delete so numbering never shows holes like
     * 2, 5, 8, 9, 10.
     */
    _renumberChapter(chapterId) {
        if (!this.db) return;
        const ids = this.db
            .prepare('SELECT id FROM notes WHERE chapter_id = ? ORDER BY note_number ASC, id ASC')
            .all(chapterId);
        const upd = this.db.prepare('UPDATE notes SET note_number = ? WHERE id = ?');
        const tx = this.db.transaction(rows => {
            rows.forEach((row, i) => upd.run(i + 1, row.id));
        });
        tx(ids);
    }

    /**
     * Move every DONE note out of a chapter into a sibling "Completed Notes"
     * chapter (created on demand within the same game) so the working chapter
     * stays uncluttered. Preserves each note's text/emotes/done flag, appends
     * them — in order — after whatever is already in the target, and re-packs the
     * source to a gapless 1..N. Returns { moved, targetChapterId, targetTitle }.
     */
    _archiveDoneNotes(sourceChapterId, targetTitle = COMPLETED_CHAPTER) {
        if (!this.db) throw new Error('Notes DB unavailable');
        const src = this._getChapterById(sourceChapterId);
        if (!src) throw new Error('Chapter not found');

        // Nothing to do if we'd be archiving the completed chapter into itself.
        if (src.title === targetTitle) return { moved: 0, targetChapterId: src.id, targetTitle };

        const done = this.db
            .prepare('SELECT id FROM notes WHERE chapter_id = ? AND done = 1 ORDER BY note_number ASC, id ASC')
            .all(sourceChapterId);
        if (!done.length) return { moved: 0, targetChapterId: null, targetTitle };

        const target = this.findOrCreateChapter(src.game_id, targetTitle);
        const move = this.db.prepare('UPDATE notes SET chapter_id = ?, note_number = ?, updated_at = ? WHERE id = ?');
        const tx = this.db.transaction(rows => {
            let next = (this._stmt.maxNum.get(target.id).m || 0) + 1;
            const ts = this._now();
            for (const n of rows) move.run(target.id, next++, ts, n.id);
        });
        tx(done);
        this._renumberChapter(sourceChapterId);

        return { moved: done.length, targetChapterId: target.id, targetTitle };
    }

    /**
     * Move a single note into another chapter (any game). Appends it after the
     * target's existing notes, re-packs the source to a gapless 1..N, and
     * optionally clears the done flag (used by un-archive so the note re-enters
     * the active list). Returns { id, fromChapterId, toChapterId }.
     */
    _moveNote(noteId, targetChapterId, { done } = {}) {
        if (!this.db) throw new Error('Notes DB unavailable');
        const n = this._getNoteById(noteId);
        if (!n) throw new Error('Note not found');
        const target = this._getChapterById(targetChapterId);
        if (!target) throw new Error('Target chapter not found');
        const fromChapterId = n.chapter_id;
        const ts = this._now();

        // Optional done override (0/1). Completing a note also clears any scratch,
        // since done + scratched are mutually exclusive in the UI. Omit to preserve.
        const setDone = done === 0 || done === 1;
        const newDone = setDone ? done : n.done;
        const newScratched = (setDone && done === 1) ? 0 : n.scratched;

        if (fromChapterId === targetChapterId) {
            if (setDone && (n.done !== newDone || n.scratched !== newScratched)) {
                this.db.prepare('UPDATE notes SET done = ?, scratched = ?, updated_at = ? WHERE id = ?')
                    .run(newDone, newScratched, ts, n.id);
            }
            return { id: noteId, fromChapterId, toChapterId: targetChapterId };
        }

        const number = (this._stmt.maxNum.get(targetChapterId).m || 0) + 1;
        this.db.prepare('UPDATE notes SET chapter_id = ?, note_number = ?, done = ?, scratched = ?, updated_at = ? WHERE id = ?')
            .run(targetChapterId, number, newDone, newScratched, ts, noteId);
        this._renumberChapter(fromChapterId);
        return { id: noteId, fromChapterId, toChapterId: targetChapterId };
    }

    // ─── Game / chapter resolution (reuses sibling state — no API calls) ─────

    /**
     * Resolve the current game via the injected resolver (Twitch category when the
     * account is connected, otherwise the manual name from the dashboard), falling
     * back to the last-known game so a transient Twitch API hiccup can't orphan the
     * cursor onto a junk row.
     */
    resolveGameName() {
        // A pin outranks everything. Without this the category poll would yank the
        // notebook back within a minute, which is why pinning had to exist before
        // the notes manager could offer "show this game on stream".
        if (this.pinnedGameId != null && this.db) {
            const g = this.db.prepare('SELECT * FROM games WHERE id = ?').get(this.pinnedGameId);
            if (g) return { name: g.name, type: g.type || 'manual' };
            this.pinnedGameId = null;   // pinned game was deleted; fall through
            this._saveState();
        }

        let resolved = null;
        try { resolved = this.gameResolver(); } catch (_) { resolved = null; }

        const name = (resolved && resolved.name || '').trim();
        if (name) return { name, type: resolved.type || 'manual' };

        if (this.currentGame) return { name: this.currentGame.name, type: this.currentGame.type };
        return { name: 'Unknown Game', type: 'unknown' };
    }

    /**
     * Re-resolve the current game. If it changed (or first run), point the DB
     * cursor at the right game + default chapter and animate the notebook.
     * @returns {boolean} true if the game changed
     */
    _refreshGame(trigger) {
        if (!this.db) return false;
        const { name, type } = this.resolveGameName();

        // Before the first successful resolve we can't know the real game — don't
        // create a junk "Unknown Game" row; wait for a category poll or a command.
        if (type === 'unknown' && !this.currentGame) return false;

        const changed = !this.currentGame || this.currentGame.name !== name;

        const game = this.findOrCreateGame(name, type);
        const chapter = this.firstOrDefaultChapter(game.id);

        this.currentGame = { id: game.id, name, type };

        if (changed) {
            this.currentChapterId = chapter.id; // reset to default tab on game change
            if (trigger !== 'init') {
                this.logToDashboard('info', `Game changed → "${name}" (${trigger})`);
                // Notebook close → open animation, then full render of new game's notes
                this.broadcast('note:notebook', { game: name, type });
                this.broadcastRender();
            }
        } else if (this.currentChapterId == null) {
            this.currentChapterId = chapter.id;
        }
        return changed;
    }

    // ─── State payloads ─────────────────────────────────────────────────────

    buildState() {
        if (!this.db || !this.currentGame) {
            return { game: null, type: null, enabled: this.enabled, visible: this.visible, chapters: [], currentChapterId: null, notes: [] };
        }
        const chapters = this._stmt.listChapters.all(this.currentGame.id);
        const notes = this.currentChapterId ? this._stmt.listNotes.all(this.currentChapterId) : [];
        return {
            game: this.currentGame.name,
            type: this.currentGame.type,
            enabled: this.enabled,
            visible: this.visible,
            chapters: chapters.map(c => ({ id: c.id, title: c.title, noteCount: c.note_count })),
            currentChapterId: this.currentChapterId,
            notes: notes.map(this._noteDto),
        };
    }

    _noteDto(n) {
        let emotes = null;
        if (n.emotes) { try { emotes = JSON.parse(n.emotes); } catch (_) {} }
        return {
            id: n.id,
            number: n.note_number,
            text: n.text,
            emotes,                 // { "EmoteName": "https://...png", ... } or null
            done: !!n.done,
            scratched: !!n.scratched,
        };
    }

    /** Build { emoteName: imageUrl } from a chat-message emotes array. */
    _buildEmoteMap(emotes) {
        const map = {};
        if (Array.isArray(emotes)) {
            for (const e of emotes) {
                if (e && e.name && e.imageUrl) map[e.name] = e.imageUrl;
            }
        }
        return map;
    }

    /** Keep only emotes whose name actually appears as a token in the text. */
    _emotesForText(text, emoteMap) {
        if (!emoteMap) return null;
        const tokens = new Set(String(text).split(/\s+/));
        const out = {};
        for (const name of Object.keys(emoteMap)) {
            if (tokens.has(name)) out[name] = emoteMap[name];
        }
        return Object.keys(out).length ? JSON.stringify(out) : null;
    }

    broadcastRender() {
        this.broadcast('note:render', this.buildState());
    }

    // ─── Event routing ──────────────────────────────────────────────────────

    handleEvent(event, client) {
        const type = event && event.event;
        const data = (event && event.data) || {};

        switch (type) {
            case 'chat-message':
                return this._onChatMessage(data);

            case 'game-changed':
                // The category watcher saw a new game — re-point the DB cursor.
                this._refreshGame('category');
                return true;

            case 'stream-session-start':
                this._refreshGame('session-start');
                if (this.currentGame) {
                    try { this._stmt.openSession.run(this.currentGame.id, this._now()); } catch (_) {}
                }
                return false;

            case 'stream-session-end':
                if (this.currentGame) {
                    try { this._stmt.closeSession.run(this._now(), this.currentGame.id); } catch (_) {}
                }
                return false;

            case 'note:state-request':
                this.sendToClient(client, 'note:render', this.buildState());
                return true;

            case 'note:test':
                this._refreshGame('test');
                this.broadcastRender();
                return true;

            default:
                return false;
        }
    }

    onClientConnect(client) {
        super.onClientConnect(client);
        // Push full state so a freshly-loaded overlay renders immediately.
        this.sendToClient(client, 'note:render', this.buildState());
    }

    // ─── Chat command handling ──────────────────────────────────────────────

    _onChatMessage(data) {
        const raw = (data.message || '').trim();
        // !note and !notes are interchangeable for every command.
        const isNoteCmd = /^!notes?\b/i.test(raw);
        // Help is also reachable as !help note / !help notes.
        const isHelpNote = /^!help\s+notes?\b/i.test(raw);
        if (!isNoteCmd && !isHelpNote) return false; // not for us — cheap early out

        const platform = data.platform || 'twitch';

        // Help is open to everyone: !note help, !notes help, !help note, !help notes.
        if (isHelpNote || /^!notes?\s+help\b/i.test(raw)) {
            this._sendChatReply(this._usage(), platform);
            return true;
        }

        // Everyone can view/hide the notebook; only mods/broadcaster (VIP: add) mutate.
        // Gating happens per-command in _dispatch — regular chatters' mutation attempts
        // are silently ignored there.
        const perm = this._permission(data);

        const user = data.username || 'someone';
        const rest = raw.replace(/^!notes?\b/i, '').trim();
        const emoteMap = this._buildEmoteMap(data.emotes); // { name: imageUrl } from this message

        // Make sure DB cursor matches the live game before we touch notes.
        this._refreshGame('command');

        try {
            const reply = this._dispatch(rest, perm, user, emoteMap);
            if (reply) this._sendChatReply(reply, platform);
        } catch (err) {
            this.logToDashboard('error', `Command failed: ${err.message}`);
            this._sendChatReply(`📓 Something went wrong with that note command.`, platform);
        }
        return true;
    }

    /**
     * Roles are independent toggles, each granting a fixed level — mods are a
     * hand-picked trust role so they get everything, while VIP/sub are cheaper to
     * obtain and only ever get 'add'. Highest matching role wins, so a mod who is
     * also a VIP isn't demoted when mods are switched off... except that's the
     * case the toggle exists for, so it isn't special-cased: turning mods off and
     * leaving VIPs on genuinely leaves a VIP-badged mod with 'add'.
     */
    _permission(data) {
        if (data.isBroadcaster === true) return 'full';
        if (this.modsCanManage && data.isModerator === true) return 'full';
        if (this.vipCanAdd && data.isVip === true) return 'add';
        if (this.subsCanAdd && data.isSubscriber === true) return 'add';
        return 'view'; // everyone else: read-only (show / hide / list)
    }

    /**
     * Per-user rate limit for the public show/hide/list commands. Returns true (and
     * records the hit) if the user is clear to run one, false if still cooling down.
     * A cooldown of 0 disables the limit entirely.
     */
    _passesPublicCooldown(user) {
        if (this.publicCooldownMs <= 0) return true;
        const now = Date.now();
        const key = String(user || '').toLowerCase();
        const last = this._publicCooldowns.get(key) || 0;
        if (now - last < this.publicCooldownMs) return false;
        this._publicCooldowns.set(key, now);
        // Opportunistic cleanup so the map can't grow without bound.
        if (this._publicCooldowns.size > 500) {
            for (const [k, t] of this._publicCooldowns) {
                if (now - t >= this.publicCooldownMs) this._publicCooldowns.delete(k);
            }
        }
        return true;
    }

    /**
     * Parse + execute a !note command. Returns a chat-reply string (or null).
     * Grammar:
     *   on | off | hide | list
     *   show all | show <n>
     *   clear all
     *   chapter <name>                 (extension — switch/create tab)
     *   <n> done|undone|scratch|unscratch|delete
     *   <n> archive|tidy|cleanup       (move note <n> → Completed Notes, marks done)
     *   <n> unarchive                  (move note <n> → General Notes, re-opened)
     *   <n> <text...>                  (update note <n>)
     *   <text...>                      (add new note)
     */
    _dispatch(rest, perm, user, emoteMap) {
        if (!rest) return this._usage();

        const tokens = rest.split(/\s+/);
        const head = tokens[0].toLowerCase();

        // ── Public commands — ANY chatter may view / hide the notebook ──
        if (['show', 'hide', 'list'].includes(head)) {
            // Rate-limit non-privileged users so viewers can't spam-toggle the overlay.
            if (perm !== 'full' && !this._passesPublicCooldown(user)) return null; // silently drop
            switch (head) {
                case 'show': return this._show(tokens[1]);
                case 'hide': return this._hide();
                case 'list': return this._list();
            }
        }
        if (head === 'help') return this._usage();

        // ── Everything below MUTATES notes → 'full' only; 'add' gets add alone ──
        const addOnly = perm === 'add';
        if (perm !== 'full' && !addOnly) return null; // regular chatter: silently ignore

        switch (head) {
            case 'on':    if (addOnly) return null; return this._setEnabled(true);
            case 'off':   if (addOnly) return null; return this._setEnabled(false);
            case 'clear': if (addOnly) return null; return this._clear(tokens[1]);
            case 'archive':
            case 'tidy':
            case 'cleanup': if (addOnly) return null; return this._archiveDone();
            case 'chapter':
            case 'tab':   if (addOnly) return null; return this._switchChapter(tokens.slice(1).join(' '));
            case 'page':  if (addOnly) return null; return this._page(tokens[1]);
            case 'next':  if (addOnly) return null; this.broadcast('note:page', { dir: 'next' }); return null;
            case 'prev':
            case 'back':  if (addOnly) return null; this.broadcast('note:page', { dir: 'prev' }); return null;
        }

        // ── Numeric command: "<n> <keyword|text>" ──
        if (/^\d+$/.test(head)) {
            const num = parseInt(head, 10);
            const sub = (tokens[1] || '').toLowerCase();

            if (tokens.length === 2 && ['done', 'undone', 'scratch', 'unscratch', 'delete', 'archive', 'tidy', 'cleanup', 'unarchive'].includes(sub)) {
                if (addOnly) return null;
                return this._noteAction(num, sub);
            }

            // "<n> <text...>" → update text (full perms only)
            const text = tokens.slice(1).join(' ').trim();
            if (!text) return `📓 Usage: !note ${num} <new text>  •  or  !note ${num} done|scratch|archive|delete`;
            if (addOnly) return null;
            return this._updateNote(num, text, user, emoteMap);
        }

        // ── Plain text → add new note ──
        return this._addNote(rest, user, emoteMap);
    }

    // Page navigation is resolved on the overlay (it knows the measured page
    // layout); the service just forwards the intent.
    _page(arg) {
        const a = (arg || '').toLowerCase();
        if (a === 'next' || a === '+') { this.broadcast('note:page', { dir: 'next' }); return null; }
        if (a === 'prev' || a === 'back' || a === '-') { this.broadcast('note:page', { dir: 'prev' }); return null; }
        if (/^\d+$/.test(a)) { this.broadcast('note:page', { page: parseInt(a, 10) }); return null; }
        return '📓 Usage: !note page next|prev|<number>';
    }

    _usage() {
        return '📓 Notes — !note <text> (add) • !note <n> <text> (edit) • !note <n> done|undone|scratch|unscratch|archive|delete • !note archive (all done → Completed Notes) • !note list • !note clear all • !note page next|prev|<n> • !note chapter <name> (tab) • !note show <n>|all • !note hide • !note on|off';
    }

    // ─── Command implementations ────────────────────────────────────────────

    _addNote(text, user, emoteMap) {
        const chapterId = this.currentChapterId;
        const max = this._stmt.maxNum.get(chapterId).m || 0;
        const number = max + 1;
        const ts = this._now();
        const emotes = this._emotesForText(text, emoteMap);
        const info = this._stmt.insNote.run(chapterId, number, text, emotes, ts, ts);

        const dto = { id: info.lastInsertRowid, number, text, emotes: emotes ? JSON.parse(emotes) : null, done: false, scratched: false };
        this.broadcast('note:animate:add', { note: dto, chapterId });
        this.broadcastRender();
        return `📓 Note #${number} added.`;
    }

    _updateNote(num, text, user, emoteMap) {
        const note = this._stmt.getNote.get(this.currentChapterId, num);
        if (!note) return this._notFound(num);
        const emotes = this._emotesForText(text, emoteMap);
        this._stmt.updText.run(text, emotes, this._now(), note.id);
        this.broadcast('note:animate:add', { note: { ...this._noteDto(note), text, emotes: emotes ? JSON.parse(emotes) : null }, chapterId: this.currentChapterId, edited: true });
        this.broadcastRender();
        return `📓 Note #${num} updated.`;
    }

    _noteAction(num, action) {
        const note = this._stmt.getNote.get(this.currentChapterId, num);
        if (!note) return this._notFound(num);
        const ts = this._now();

        switch (action) {
            case 'done':
                this._stmt.updDone.run(1, ts, note.id);
                this.broadcast('note:animate:done', { id: note.id, number: num });
                this.broadcastRender();
                return `📓 Note #${num} marked done. ✔`;
            case 'undone':
                this._stmt.updDone.run(0, ts, note.id);
                this.broadcast('note:animate:undone', { id: note.id, number: num });
                this.broadcastRender();
                return `📓 Note #${num} reopened.`;
            case 'scratch':
                this._stmt.updScratch.run(1, ts, note.id);
                this.broadcast('note:animate:scratch', { id: note.id, number: num });
                this.broadcastRender();
                return `📓 Note #${num} scratched out.`;
            case 'unscratch':
                this._stmt.updScratch.run(0, ts, note.id);
                this.broadcast('note:animate:undone', { id: note.id, number: num });
                this.broadcastRender();
                return `📓 Note #${num} restored.`;
            case 'delete':
                // Animate first, then delete + re-pack numbers to a gapless 1..N.
                this.broadcast('note:animate:delete', { id: note.id, number: num });
                this._stmt.delNote.run(note.id);
                this._renumberChapter(this.currentChapterId);
                this.broadcastRender();
                return `📓 Note #${num} deleted.`;
            case 'archive':
            case 'tidy':
            case 'cleanup': {
                // Move this single note into the game's Completed Notes chapter (marks done).
                if (this._currentChapterTitle() === COMPLETED_CHAPTER)
                    return `📓 Note #${num} is already in "${COMPLETED_CHAPTER}".`;
                const target = this.findOrCreateChapter(this.currentGame.id, COMPLETED_CHAPTER);
                this.broadcast('note:animate:delete', { id: note.id, number: num }); // it leaves this page
                this._moveNote(note.id, target.id, { done: 1 });
                this.broadcastRender();
                return `📓 Note #${num} archived to "${COMPLETED_CHAPTER}". ✔`;
            }
            case 'unarchive': {
                // Move this single note back into General Notes and re-open it.
                const target = this.findOrCreateChapter(this.currentGame.id, DEFAULT_CHAPTER);
                if (target.id === this.currentChapterId)
                    return `📓 Note #${num} is already in "${DEFAULT_CHAPTER}".`;
                this.broadcast('note:animate:delete', { id: note.id, number: num }); // it leaves this page
                this._moveNote(note.id, target.id, { done: 0 });
                this.broadcastRender();
                return `📓 Note #${num} moved back to "${DEFAULT_CHAPTER}".`;
            }
        }
    }

    _archiveDone() {
        const title = this._currentChapterTitle();
        const res = this._archiveDoneNotes(this.currentChapterId);
        if (!res.moved) return `📓 No completed notes to archive in "${title}".`;
        // Flip the notebook so the on-stream overlay clearly reflects the tidy-up.
        this.broadcast('note:notebook', { game: this.currentGame.name, type: this.currentGame.type, chapter: title });
        this.broadcastRender();
        return `📓 Moved ${res.moved} completed note${res.moved === 1 ? '' : 's'} to "${res.targetTitle}". ✨`;
    }

    _clear(arg) {
        if ((arg || '').toLowerCase() !== 'all') return '📓 Use "!note clear all" to clear every note in this chapter.';
        const chapterId = this.currentChapterId;
        this.broadcast('note:animate:clear', { chapterId });
        this._stmt.clearChapter.run(chapterId);
        this.broadcastRender();
        return '📓 All notes cleared. 🔥';
    }

    _show(arg) {
        this.visible = true;
        this._saveState();
        if (arg && /^\d+$/.test(arg)) {
            const num = parseInt(arg, 10);
            const note = this._stmt.getNote.get(this.currentChapterId, num);
            if (!note) return this._notFound(num);
            this.broadcast('note:animate:show', { focus: num });
            this.broadcastRender();
            return `📓 Showing note #${num}.`;
        }
        this.broadcast('note:animate:show', { focus: null });
        this.broadcastRender();
        return '📓 Notebook shown.';
    }

    _hide() {
        this.visible = false;
        this._saveState();
        this.broadcast('note:animate:hide', {});
        this.broadcastRender();              // let the overlay's visibility logic hide it
        return '📓 Notebook hidden.';
    }

    _setEnabled(on) {
        // master on/off only — does NOT pin visibility (that's !note show/hide).
        // When ON, the notebook stays hidden until a note is added (transient reveal)
        // or !note show is used.
        this.enabled = on;
        this._saveState();
        this.broadcast(on ? 'note:animate:show' : 'note:animate:hide', {});
        this.broadcastRender();
        return on ? '📓 Notes are ON.' : '📓 Notes are OFF.';
    }

    _list() {
        const notes = this._stmt.listNotes.all(this.currentChapterId);
        if (!notes.length) return `📓 No notes in "${this._currentChapterTitle()}" yet.`;
        const items = notes.map(n => {
            const mark = n.done ? '✔' : n.scratched ? '✗' : '•';
            return `${mark}${n.note_number}: ${n.text}`;
        });
        // Keep chat-friendly; cap length.
        let out = `📓 ${this._currentChapterTitle()} — ` + items.join('  |  ');
        if (out.length > 480) out = out.slice(0, 477) + '...';
        return out;
    }

    _switchChapter(title) {
        const name = (title || '').trim();
        if (!name) return '📓 Usage: !note chapter <name>';
        const chapter = this.findOrCreateChapter(this.currentGame.id, name);
        this.currentChapterId = chapter.id;
        this.broadcast('note:notebook', { game: this.currentGame.name, type: this.currentGame.type, chapter: name });
        this.broadcastRender();
        return `📓 Switched to chapter "${name}".`;
    }

    _currentChapterTitle() {
        const chapters = this._stmt.listChapters.all(this.currentGame.id);
        const c = chapters.find(x => x.id === this.currentChapterId);
        return c ? c.title : DEFAULT_CHAPTER;
    }

    _notFound(num) {
        return `📓 No note #${num} in "${this._currentChapterTitle()}". Try !note list.`;
    }

    // ─── Chat reply bridge (transport injected by server.js) ────────────────

    _sendChatReply(message, platform = 'twitch') {
        try {
            this.replyTransport(message, platform);
        } catch (err) {
            console.warn(`⚠️  [notes] Chat reply failed (${platform}): ${err.message}`);
        }
    }

    // ─── Management API (dashboard notes page /notes.html) ───────────────────
    // Operate on EXPLICIT ids (not just the live chapter). When an edit touches the
    // currently-displayed game/chapter we broadcast a fresh note:render so the on-stream
    // overlay reconciles live; edits to other games just persist to SQLite.

    _getNoteById(id) { return this.db.prepare('SELECT * FROM notes WHERE id = ?').get(id); }
    _getChapterById(id) { return this.db.prepare('SELECT * FROM chapters WHERE id = ?').get(id); }
    _renderIfCurrentChapter(chapterId) { if (this.db && chapterId === this.currentChapterId) this.broadcastRender(); }
    _renderIfCurrentGame(gameId) { if (this.db && this.currentGame && gameId === this.currentGame.id) this.broadcastRender(); }

    /** Full tree of every game → chapter → note (for the management page). */
    mgmtTree() {
        if (!this.db) return [];
        const games = this.db.prepare('SELECT * FROM games ORDER BY name COLLATE NOCASE ASC').all();
        return games.map(g => ({
            id: g.id, name: g.name, type: g.type,
            chapters: this._stmt.listChapters.all(g.id).map(c => ({
                id: c.id, title: c.title, noteCount: c.note_count,
                notes: this._stmt.listNotes.all(c.id).map(n => this._noteDto(n)),
            })),
        }));
    }

    /** Live-overlay state (so the page can highlight what's on stream right now). */
    mgmtState() {
        return {
            game: this.currentGame ? this.currentGame.name : null,
            gameId: this.currentGame ? this.currentGame.id : null,
            currentChapterId: this.currentChapterId,
            enabled: this.enabled, visible: this.visible,
            pinnedGameId: this.pinnedGameId,
            persists: !!this.db,
        };
    }

    mgmtAddNote(chapterId, text) {
        text = String(text || '').trim();
        if (!text) throw new Error('Note text is empty');
        const ch = this._getChapterById(chapterId);
        if (!ch) throw new Error('Chapter not found');
        const number = (this._stmt.maxNum.get(chapterId).m || 0) + 1;
        const ts = this._now();
        const info = this._stmt.insNote.run(chapterId, number, text, null, ts, ts);
        this._renderIfCurrentChapter(chapterId);
        return this._noteDto(this._getNoteById(info.lastInsertRowid));
    }

    mgmtUpdateNote(noteId, text) {
        const n = this._getNoteById(noteId);
        if (!n) throw new Error('Note not found');
        this._stmt.updText.run(String(text || '').trim(), n.emotes || null, this._now(), n.id);
        this._renderIfCurrentChapter(n.chapter_id);
        return this._noteDto(this._getNoteById(noteId));
    }

    mgmtToggle(noteId, field, value) {
        const n = this._getNoteById(noteId);
        if (!n) throw new Error('Note not found');
        const ts = this._now(), v = value ? 1 : 0;
        if (field === 'done') this._stmt.updDone.run(v, ts, n.id);
        else if (field === 'scratched') this._stmt.updScratch.run(v, ts, n.id);
        else throw new Error('Invalid field (done|scratched)');
        this._renderIfCurrentChapter(n.chapter_id);
        return this._noteDto(this._getNoteById(noteId));
    }

    mgmtDeleteNote(noteId) {
        const n = this._getNoteById(noteId);
        if (!n) throw new Error('Note not found');
        this._stmt.delNote.run(n.id);
        this._renumberChapter(n.chapter_id);
        this._renderIfCurrentChapter(n.chapter_id);
        return { id: noteId, deleted: true };
    }

    /** Move a chapter's DONE notes into its game's "Completed Notes" chapter. */
    mgmtArchiveDone(chapterId) {
        const res = this._archiveDoneNotes(chapterId);
        this._renderIfCurrentChapter(chapterId);
        if (res.targetChapterId) this._renderIfCurrentChapter(res.targetChapterId);
        return res;
    }

    /**
     * Archive ONE note: move it into the game's "Completed Notes" chapter and
     * mark it done. No-ops if it's already in Completed Notes.
     */
    mgmtArchiveNote(noteId) {
        const n = this._getNoteById(noteId);
        if (!n) throw new Error('Note not found');
        const src = this._getChapterById(n.chapter_id);
        if (src.title === COMPLETED_CHAPTER) {
            return { id: noteId, fromChapterId: n.chapter_id, toChapterId: n.chapter_id, toTitle: COMPLETED_CHAPTER, noop: true };
        }
        const target = this.findOrCreateChapter(src.game_id, COMPLETED_CHAPTER);
        const res = this._moveNote(noteId, target.id, { done: 1 });
        this._renderIfCurrentChapter(res.fromChapterId);
        this._renderIfCurrentChapter(res.toChapterId);
        return { ...res, toTitle: COMPLETED_CHAPTER };
    }

    /**
     * Un-archive ONE note: move it out of its chapter (typically "Completed
     * Notes") back into the game's General Notes and re-open it (done=0).
     */
    mgmtUnarchiveNote(noteId) {
        const n = this._getNoteById(noteId);
        if (!n) throw new Error('Note not found');
        const src = this._getChapterById(n.chapter_id);
        const target = this.findOrCreateChapter(src.game_id, DEFAULT_CHAPTER);
        const res = this._moveNote(noteId, target.id, { done: 0 });
        this._renderIfCurrentChapter(res.fromChapterId);
        this._renderIfCurrentChapter(res.toChapterId);
        return { ...res, toTitle: DEFAULT_CHAPTER };
    }

    /**
     * Un-archive an ENTIRE chapter: move every note back into the game's General
     * Notes, re-opened (done=0), then re-pack the source. Returns { moved, ... }.
     */
    mgmtUnarchiveAll(chapterId) {
        const ch = this._getChapterById(chapterId);
        if (!ch) throw new Error('Chapter not found');
        const target = this.findOrCreateChapter(ch.game_id, DEFAULT_CHAPTER);
        if (target.id === chapterId) return { moved: 0, toChapterId: chapterId, toTitle: DEFAULT_CHAPTER };

        const notes = this.db
            .prepare('SELECT id FROM notes WHERE chapter_id = ? ORDER BY note_number ASC, id ASC')
            .all(chapterId);
        if (!notes.length) return { moved: 0, toChapterId: target.id, toTitle: DEFAULT_CHAPTER };

        const move = this.db.prepare('UPDATE notes SET chapter_id = ?, note_number = ?, done = 0, updated_at = ? WHERE id = ?');
        const tx = this.db.transaction(rows => {
            let next = (this._stmt.maxNum.get(target.id).m || 0) + 1;
            const ts = this._now();
            for (const r of rows) move.run(target.id, next++, ts, r.id);
        });
        tx(notes);
        this._renumberChapter(chapterId);
        this._renderIfCurrentChapter(chapterId);
        this._renderIfCurrentChapter(target.id);
        return { moved: notes.length, toChapterId: target.id, toTitle: DEFAULT_CHAPTER };
    }

    mgmtAddChapter(gameId, title) {
        title = String(title || '').trim();
        if (!title) throw new Error('Chapter title is empty');
        if (!this.db.prepare('SELECT 1 FROM games WHERE id = ?').get(gameId)) throw new Error('Game not found');
        const ch = this.findOrCreateChapter(gameId, title);
        this._renderIfCurrentGame(gameId);
        return { id: ch.id, title, gameId, noteCount: 0, notes: [] };
    }

    mgmtRenameChapter(chapterId, title) {
        title = String(title || '').trim();
        if (!title) throw new Error('Chapter title is empty');
        const ch = this._getChapterById(chapterId);
        if (!ch) throw new Error('Chapter not found');
        this.db.prepare('UPDATE chapters SET title = ? WHERE id = ?').run(title, chapterId);
        this._renderIfCurrentGame(ch.game_id);
        return { id: chapterId, title };
    }

    mgmtDeleteChapter(chapterId) {
        const ch = this._getChapterById(chapterId);
        if (!ch) throw new Error('Chapter not found');
        this.db.prepare('DELETE FROM chapters WHERE id = ?').run(chapterId); // cascades notes
        if (this.currentChapterId === chapterId && this.currentGame) {
            // Land on a remaining chapter; only fall back to (re)creating the
            // default if this was the game's last chapter.
            this.currentChapterId = this.firstOrDefaultChapter(this.currentGame.id).id;
        }
        this._renderIfCurrentGame(ch.game_id);
        return { id: chapterId, deleted: true };
    }

    /** Delete a whole game and ALL its chapters/notes (cascades). Refuses the live game. */
    mgmtDeleteGame(gameId) {
        const g = this.db.prepare('SELECT * FROM games WHERE id = ?').get(gameId);
        if (!g) throw new Error('Game not found');
        if (this.currentGame && this.currentGame.id === gameId) {
            throw new Error(this.pinnedGameId === gameId
                ? 'That game is pinned on stream right now. Unpin it first, then delete it.'
                : 'That game is live on stream right now — it would just be recreated. Switch to a different game first.');
        }
        this.db.prepare('DELETE FROM games WHERE id = ?').run(gameId); // FK cascade → chapters → notes → sessions
        if (this.pinnedGameId === gameId) { this.pinnedGameId = null; this._saveState(); }
        return { id: gameId, deleted: true };
    }

    /**
     * Show a chapter on stream. If it belongs to a different game, that game is
     * pinned automatically — otherwise the next category poll would undo this
     * within 60s and look like a bug.
     */
    mgmtSwitchChapter(chapterId) {
        const ch = this._getChapterById(chapterId);
        if (!ch) throw new Error('Chapter not found');

        let pinned = false;
        if (!this.currentGame || ch.game_id !== this.currentGame.id) {
            this.pinnedGameId = ch.game_id;
            this._saveState();
            this._refreshGame('pin');
            pinned = true;
        }

        this.currentChapterId = chapterId;
        this.broadcast('note:notebook', { game: this.currentGame.name, type: this.currentGame.type, chapter: ch.title });
        this.broadcastRender();
        return { switched: true, currentChapterId: chapterId, pinned, pinnedGameId: this.pinnedGameId };
    }

    /** Pin a game on stream, overriding the game resolver until unpinned. */
    mgmtPinGame(gameId) {
        const g = this.db.prepare('SELECT * FROM games WHERE id = ?').get(gameId);
        if (!g) throw new Error('Game not found');
        this.pinnedGameId = gameId;
        this._saveState();
        this._refreshGame('pin');
        this.logToDashboard('info', `Pinned "${g.name}" on stream`);
        return this.mgmtState();
    }

    /** Release the pin and let the resolver (Twitch category / manual) take over. */
    mgmtUnpinGame() {
        this.pinnedGameId = null;
        this._saveState();
        this._refreshGame('unpin');
        this.logToDashboard('info', 'Unpinned — following the game again');
        return this.mgmtState();
    }

    mgmtOverlay(action) {
        switch (action) {
            case 'show': this._show(null); break;
            case 'hide': this._hide(); break;
            case 'on': this._setEnabled(true); break;
            case 'off': this._setEnabled(false); break;
            default: throw new Error('Invalid action (show|hide|on|off)');
        }
        return this.mgmtState();
    }
}

module.exports = NotesService;
