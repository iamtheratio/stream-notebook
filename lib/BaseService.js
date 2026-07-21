'use strict';

/**
 * Minimal BaseService — the standalone build's stand-in for the multi-service
 * base class this notebook was extracted from.
 *
 * Only what NotesService actually touches: canonical message shape, a
 * subscription-filtered broadcast, single-client send, and logging that also
 * mirrors to the dashboard's live log panel.
 */
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
        console.log(line);
        if (this.onLog) this.onLog(level, line, data);
    }

    logFailure(context, err, extra = {}) {
        const detail = (err && err.message) || String(err || 'unknown');
        console.error(`${this.logEmoji} [${this.name}] ${context} failed:`, detail);
        this.logToDashboard('error', `${context} failed: ${detail}`, { ...extra, stack: err && err.stack });
    }

    handleEvent(event, client) { return false; }

    onClientConnect(client) { this.clients.add(client); }
    onClientDisconnect(client) { this.clients.delete(client); }

    async initialize() {}
}

module.exports = BaseService;
