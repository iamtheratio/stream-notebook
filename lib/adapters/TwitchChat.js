'use strict';

const WebSocket = require('ws');
const settings = require('../Settings');
const auth = require('../TwitchAuth');

const IRC_URL = 'wss://irc-ws.chat.twitch.tv:443';
const EMOTE_CDN = id => `https://static-cdn.jtvnw.net/emoticons/v2/${id}/default/dark/2.0`;

/**
 * Twitch chat adapter — connects straight to Twitch IRC.
 *
 * This is what lets the package work with no other software installed: no
 * Streamer.bot, no Mix It Up, no bot account. It joins the connected user's own
 * channel with their token and normalises PRIVMSG into the same `chat-message`
 * shape the notes service already expects, so NotesService needs no changes.
 */
class TwitchChat {
    constructor({ onMessage, onStatus } = {}) {
        this.onMessage = onMessage || (() => {});
        this.onStatus = onStatus || (() => {});
        this.ws = null;
        this.channel = null;
        this.connected = false;
        this.stopped = true;
        this.retry = 0;
        this.retryTimer = null;

        // Twitch allows 20 messages / 30s for a normal account. Stay well under it:
        // one message per 1.5s, dropping the overflow rather than queueing forever
        // (a stale "Note #3 added." 40 seconds late is worse than none).
        this.queue = [];
        this.sending = false;
    }

    async start() {
        this.stopped = false;
        clearTimeout(this.retryTimer);

        const token = await auth.getAccessToken();
        const login = settings.get().twitch.login;
        if (!token || !login) {
            this._status('disconnected', 'Twitch account not connected');
            return;
        }
        this.channel = `#${login.toLowerCase()}`;

        this._status('connecting', `Joining ${this.channel}`);
        this.ws = new WebSocket(IRC_URL);

        this.ws.on('open', () => {
            this.ws.send('CAP REQ :twitch.tv/tags twitch.tv/commands');
            this.ws.send(`PASS oauth:${token}`);
            this.ws.send(`NICK ${login.toLowerCase()}`);
            this.ws.send(`JOIN ${this.channel}`);
        });

        this.ws.on('message', raw => {
            for (const line of raw.toString().split('\r\n')) {
                if (line) this._line(line);
            }
        });

        this.ws.on('close', () => {
            this.connected = false;
            if (!this.stopped) this._scheduleReconnect();
            else this._status('disconnected', 'Stopped');
        });

        this.ws.on('error', err => {
            this._status('error', err.message);
        });
    }

    stop() {
        this.stopped = true;
        clearTimeout(this.retryTimer);
        try { this.ws && this.ws.close(); } catch (_) {}
        this.ws = null;
        this.connected = false;
    }

    /** Reconnect with capped exponential backoff — Twitch drops idle sockets routinely. */
    _scheduleReconnect() {
        const delay = Math.min(30000, 1000 * Math.pow(2, this.retry++));
        this._status('reconnecting', `Reconnecting in ${Math.round(delay / 1000)}s`);
        this.retryTimer = setTimeout(() => this.start(), delay);
    }

    _status(state, detail) {
        this.onStatus({ source: 'twitch', state, detail, channel: this.channel });
    }

    _line(line) {
        if (line.startsWith('PING')) { this.ws.send('PONG :tmi.twitch.tv'); return; }

        // Twitch asks us to reconnect before server maintenance.
        if (line.includes(' RECONNECT')) { try { this.ws.close(); } catch (_) {} return; }

        if (line.includes(' 001 ')) {
            this.connected = true;
            this.retry = 0;
            this._status('connected', `Listening in ${this.channel}`);
            return;
        }
        // Bad token — retrying would just spin, so surface it and stop.
        if (line.includes('Login authentication failed')) {
            this.stopped = true;
            this._status('error', 'Twitch rejected the login — reconnect your account.');
            return;
        }
        if (line.includes(' PRIVMSG ')) this._privmsg(line);
    }

    _privmsg(line) {
        const tags = line.startsWith('@') ? this._tags(line.slice(1, line.indexOf(' '))) : {};
        const rest = line.startsWith('@') ? line.slice(line.indexOf(' ') + 1) : line;

        const nick = (rest.match(/^:([^!]+)!/) || [])[1];
        const idx = rest.indexOf(' :', rest.indexOf(' PRIVMSG '));
        if (idx === -1 || !nick) return;
        const message = rest.slice(idx + 2);

        const badges = tags.badges || '';
        this.onMessage({
            message,
            platform: 'twitch',
            username: tags['display-name'] || nick,
            isBroadcaster: badges.includes('broadcaster/'),
            isModerator: tags.mod === '1' || badges.includes('moderator/'),
            isVip: badges.includes('vip/') || tags.vip === '1',
            // 'founder' is an early subscriber — same thing, different badge.
            isSubscriber: tags.subscriber === '1'
                || badges.includes('subscriber/') || badges.includes('founder/'),
            emotes: this._emotes(tags.emotes, message),
        });
    }

    /** IRCv3 tag string → object, unescaping the \s \: \\ escapes Twitch uses. */
    _tags(str) {
        const out = {};
        for (const pair of str.split(';')) {
            const eq = pair.indexOf('=');
            if (eq === -1) continue;
            out[pair.slice(0, eq)] = pair.slice(eq + 1)
                .replace(/\\s/g, ' ').replace(/\\:/g, ';').replace(/\\\\/g, '\\');
        }
        return out;
    }

    /**
     * `emotes` tag → [{ name, imageUrl }] in the shape NotesService expects.
     * Format: `25:0-4,12-16/1902:6-10` — an emote id, then the character ranges
     * where it appears. Positions are code-point indexed, so slice the message as
     * an array of code points or any emoji earlier in the line shifts the window.
     */
    _emotes(tag, message) {
        if (!tag) return [];
        const chars = Array.from(message);
        const out = [];
        for (const part of tag.split('/')) {
            const [id, ranges] = part.split(':');
            if (!id || !ranges) continue;
            const [start, end] = ranges.split(',')[0].split('-').map(Number);
            const name = chars.slice(start, end + 1).join('');
            if (name) out.push({ name, imageUrl: EMOTE_CDN(id) });
        }
        return out;
    }

    /** Public: post a message to chat (used for command confirmations). */
    say(text) {
        if (!this.connected || !text) return;
        if (this.queue.length > 5) return; // backed up — drop rather than spam late
        this.queue.push(text);
        this._drain();
    }

    _drain() {
        if (this.sending || !this.queue.length) return;
        this.sending = true;
        const text = this.queue.shift();
        try {
            this.ws.send(`PRIVMSG ${this.channel} :${text}`);
        } catch (_) { /* socket died mid-send; reconnect logic will handle it */ }
        setTimeout(() => { this.sending = false; this._drain(); }, 1500);
    }
}

module.exports = TwitchChat;
