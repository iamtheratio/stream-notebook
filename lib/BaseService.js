'use strict';

/**
 * Minimal BaseService — the standalone build's stand-in for the multi-service
 * base class this notebook was extracted from.
 *
 * Only what NotesService actually touches: canonical message shape, a
 * subscription-filtered broadcast, single-client send, and logging that also
 * mirrors to the dashboard's live log panel.
 */

/**
 * Flatten a log line to ASCII for the Windows console, which renders anything
 * else as mojibake ("→" becomes "ΓåÆ") and reads as a broken app to the
 * non-technical people this is built for. The browser dashboard gets the
 * original untouched, so its log panel keeps the emoji and typography.
 *
 * Done here rather than in NotesService because that file is a fork of
 * D:\Websocket Server and every edit to it has to be ported back.
 */
const ASCII = [
    [/[→➡]/g, '->'], [/[←]/g, '<-'],
    [/[—–]/g, '-'],  [/[…]/g, '...'],
    [/[“”]/g, '"'],  [/[‘’]/g, "'"],
    [/[✓✔]/g, 'v'],  [/[✗✘]/g, 'x'],
    [/[•]/g, '*'],
];

function toConsole(text) {
    let out = String(text);
    for (const [re, sub] of ASCII) out = out.replace(re, sub);
    // Anything still outside ASCII (emoji, box drawing) goes rather than garbles.
    return out.replace(/[^\x00-\x7F]/g, '').replace(/\s{2,}/g, ' ').trim();
}

class BaseService {
    constructor(name, wss) {
        this.name = name;
        this.wss = wss;
        this.clients = new Set();
        this.logEmoji = '📋';
        this.onLog = null; // set by server.js → streams lines to the dashboard
    }

    createMessage(event, data, metadata = {}) {
        return {
            event,
            eventDateTime: new Date().toISOString().replace('T', ' ').substring(0, 19),
            service: this.name,
            data,
            ...metadata,
        };
    }

    /**
     * Send to every client that subscribed to this service. The overlay and the
     * notes manager both subscribe on connect; anything else stays quiet.
     */
    broadcast(event, data, metadata = {}) {
        const payload = JSON.stringify(this.createMessage(event, data, metadata));
        this.wss.clients.forEach(client => {
            if (client.readyState === 1 && client.serviceSubscriptions?.has(this.name)) {
                client.send(payload);
            }
        });
    }

    sendToClient(client, event, data, metadata = {}) {
        if (client && client.readyState === 1) {
            client.send(JSON.stringify(this.createMessage(event, data, metadata)));
        }
    }

    logToDashboard(level, message, data = {}) {
        const line = `${this.logEmoji} [${this.name}] ${message}`;
        console.log(toConsole(`[${this.name}] ${message}`));
        if (this.onLog) this.onLog(level, line, data);
    }

    logFailure(context, err, extra = {}) {
        const detail = (err && err.message) || String(err || 'unknown');
        console.error(toConsole(`[${this.name}] ${context} failed:`), detail);
        this.logToDashboard('error', `${context} failed: ${detail}`, { ...extra, stack: err && err.stack });
    }

    handleEvent(event, client) { return false; }

    onClientConnect(client) { this.clients.add(client); }
    onClientDisconnect(client) { this.clients.delete(client); }

    async initialize() {}
}

module.exports = BaseService;
