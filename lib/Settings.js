'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'settings.json');

/**
 * Dashboard-managed settings.
 *
 * Deliberately NOT a hand-edited config file — everything here is written by the
 * setup dashboard. It lives under data/ (gitignored) so tokens never end up in a
 * clone, and so a `git pull` can never clobber someone's setup.
 */
const DEFAULTS = {
    // Twitch account (populated by the Connect with Twitch device-code flow)
    twitch: {
        login: null,          // channel to join, from the connected account
        userId: null,
        displayName: null,
        accessToken: null,
        refreshToken: null,
        expiresAt: 0,
        scopes: [],
    },

    chatSource: 'twitch',     // 'twitch' (direct IRC) | 'streamerbot'
    chatReplies: true,        // post "Note #3 added." confirmations back to chat

    // Streamer.bot bridge (only used when chatSource === 'streamerbot')
    streamerbot: { host: '127.0.0.1', port: 7474, action: 'Send All Chats to Platforms' },

    // Game / chapter organisation
    gameSource: 'twitch',     // 'twitch' (poll the channel's category) | 'manual'
    manualGame: 'Stream Notes',

    // Permissions
    vipCanAdd: false,
    publicCooldownSec: 10,

    port: 8765,
    setupComplete: false,
};

class Settings {
    constructor() {
        this.data = this._load();
    }

    _load() {
        try {
            const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
            // Merge one level deep so new keys in a future release get defaults
            // rather than coming back undefined on an existing install.
            const merged = { ...DEFAULTS, ...raw };
            merged.twitch = { ...DEFAULTS.twitch, ...(raw.twitch || {}) };
            merged.streamerbot = { ...DEFAULTS.streamerbot, ...(raw.streamerbot || {}) };
            return merged;
        } catch (_) {
            return JSON.parse(JSON.stringify(DEFAULTS)); // first run
        }
    }

    get() { return this.data; }

    /** Shallow-merge a patch and persist. Returns the new settings. */
    update(patch = {}) {
        const next = { ...this.data, ...patch };
        if (patch.twitch) next.twitch = { ...this.data.twitch, ...patch.twitch };
        if (patch.streamerbot) next.streamerbot = { ...this.data.streamerbot, ...patch.streamerbot };
        this.data = next;
        this.save();
        return this.data;
    }

    save() {
        if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.writeFileSync(FILE, JSON.stringify(this.data, null, 2));
    }

    /** Settings safe to hand to the browser — tokens stripped, status flags only. */
    publicView() {
        const s = this.data;
        return {
            ...s,
            twitch: {
                login: s.twitch.login,
                displayName: s.twitch.displayName,
                connected: !!s.twitch.accessToken,
                scopes: s.twitch.scopes,
            },
        };
    }
}

module.exports = new Settings();
