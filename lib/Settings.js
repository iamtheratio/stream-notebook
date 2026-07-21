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

    chatReplies: true,        // post "Note #3 added." confirmations back to chat

    // Game / chapter organisation
    gameSource: 'twitch',     // 'twitch' (poll the channel's category) | 'manual'
    manualGame: 'Stream Notes',

    // Permissions. The broadcaster always has full control and is not a setting —
    // there is no sane reason to lock yourself out of your own notebook.
    modsCanManage: true,      // mods get everything: delete, clear, chapters
    vipCanAdd: false,         // VIPs may add notes only
    subsCanAdd: false,        // subscribers may add notes only
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
            // Streamer.bot support was removed after v1. An install still carrying
            // those keys would otherwise sit there with chat silently doing nothing.
            delete merged.chatSource;
            delete merged.streamerbot;
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
        delete next.chatSource;      // removed with Streamer.bot; never resurrect it
        delete next.streamerbot;
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
