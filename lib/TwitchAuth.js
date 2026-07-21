'use strict';

const settings = require('./Settings');

/**
 * Twitch OAuth via Device Code Flow.
 *
 * Chosen over the usual redirect flows because it needs no client secret and no
 * registered redirect URI — the user clicks "Connect with Twitch", gets a short
 * code, approves it on twitch.tv/activate, and we poll until it lands. Nothing to
 * paste, nothing to configure, and it works no matter what port the server is on.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PACKAGE MAINTAINER: set CLIENT_ID below once, before sharing the repo.
 *   1. https://dev.twitch.tv/console/apps  →  Register Your Application
 *   2. OAuth Redirect URL: http://localhost   (unused by device flow, but required)
 *   3. Category: Chat Bot   •   Client Type: Public
 *   4. Paste the Client ID here. It is NOT a secret — public clients are meant to
 *      ship it, which is exactly why this flow needs no secret at all.
 * Every downstream user then has nothing to configure.
 * ─────────────────────────────────────────────────────────────────────────────
 */
const CLIENT_ID = process.env.TWITCH_CLIENT_ID || 'REPLACE_WITH_YOUR_TWITCH_CLIENT_ID';

// chat:read + chat:edit cover reading commands and posting confirmations.
// Reading the channel's current category needs no additional scope.
const SCOPES = ['chat:read', 'chat:edit'];

const DEVICE_URL = 'https://id.twitch.tv/oauth2/device';
const TOKEN_URL = 'https://id.twitch.tv/oauth2/token';
const HELIX = 'https://api.twitch.tv/helix';

const isConfigured = () => CLIENT_ID && !CLIENT_ID.startsWith('REPLACE_WITH');

class TwitchAuth {
    constructor() {
        this.pending = null;   // in-flight device authorisation
        this.onChange = null;  // server.js hook — fires when a connect/disconnect lands
    }

    get clientId() { return CLIENT_ID; }
    get configured() { return isConfigured(); }

    /** Step 1 — ask Twitch for a user code. Returns what the dashboard displays. */
    async startDeviceFlow() {
        if (!isConfigured()) {
            throw new Error('This copy has no Twitch Client ID baked in. See lib/TwitchAuth.js.');
        }
        const res = await fetch(DEVICE_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ client_id: CLIENT_ID, scopes: SCOPES.join(' ') }),
        });
        if (!res.ok) throw new Error(`Twitch device request failed (${res.status})`);
        const d = await res.json();

        this.pending = {
            deviceCode: d.device_code,
            interval: (d.interval || 5) * 1000,
            expiresAt: Date.now() + (d.expires_in || 1800) * 1000,
        };
        this._poll(); // fire-and-forget; dashboard polls /api/twitch/status for the result

        return {
            userCode: d.user_code,
            verificationUri: d.verification_uri || 'https://www.twitch.tv/activate',
            expiresIn: d.expires_in || 1800,
        };
    }

    /** Step 2 — poll until the user approves, expires, or cancels. */
    async _poll() {
        const job = this.pending;
        while (this.pending === job && Date.now() < job.expiresAt) {
            await new Promise(r => setTimeout(r, job.interval));
            if (this.pending !== job) return; // superseded or cancelled

            let d;
            try {
                const res = await fetch(TOKEN_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: new URLSearchParams({
                        client_id: CLIENT_ID,
                        device_code: job.deviceCode,
                        scopes: SCOPES.join(' '),
                        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
                    }),
                });
                d = await res.json();
            } catch (_) {
                continue; // transient network blip — keep waiting
            }

            if (d.access_token) {
                this.pending = null;
                await this._storeToken(d);
                return;
            }
            // Anything other than "still waiting" is terminal (denied / expired).
            const msg = String(d.message || '').toLowerCase();
            if (msg && !msg.includes('pending') && !msg.includes('slow')) {
                this.pending = null;
                return;
            }
        }
        if (this.pending === job) this.pending = null; // timed out
    }

    async _storeToken(d) {
        const who = await this._validate(d.access_token);
        settings.update({
            twitch: {
                login: who.login,
                userId: who.user_id,
                displayName: who.login,
                accessToken: d.access_token,
                refreshToken: d.refresh_token,
                expiresAt: Date.now() + (d.expires_in || 14400) * 1000,
                scopes: d.scope || SCOPES,
            },
        });
        console.log(`✅ [twitch] Connected as ${who.login}`);
        if (this.onChange) this.onChange();
    }

    async _validate(token) {
        const res = await fetch('https://id.twitch.tv/oauth2/validate', {
            headers: { Authorization: `OAuth ${token}` },
        });
        if (!res.ok) throw new Error('Token validation failed');
        return res.json(); // { login, user_id, scopes, expires_in }
    }

    /**
     * Return a usable access token, refreshing if it's within 5 minutes of expiry.
     * Returns null when the account isn't connected or the refresh was rejected
     * (revoked access / password change) — callers should treat that as
     * "disconnected" and surface it, not retry in a loop.
     */
    async getAccessToken() {
        const t = settings.get().twitch;
        if (!t.accessToken) return null;
        if (Date.now() < t.expiresAt - 5 * 60 * 1000) return t.accessToken;

        if (!t.refreshToken) return null;
        try {
            const res = await fetch(TOKEN_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    client_id: CLIENT_ID,
                    grant_type: 'refresh_token',
                    refresh_token: t.refreshToken,
                }),
            });
            const d = await res.json();
            if (!d.access_token) throw new Error(d.message || 'refresh rejected');

            settings.update({
                twitch: {
                    accessToken: d.access_token,
                    refreshToken: d.refresh_token || t.refreshToken,
                    expiresAt: Date.now() + (d.expires_in || 14400) * 1000,
                },
            });
            return d.access_token;
        } catch (err) {
            console.warn(`⚠️  [twitch] Token refresh failed: ${err.message} — reconnect in the dashboard.`);
            this.disconnect();
            return null;
        }
    }

    disconnect() {
        this.pending = null;
        settings.update({
            twitch: { login: null, userId: null, displayName: null, accessToken: null, refreshToken: null, expiresAt: 0, scopes: [] },
        });
        if (this.onChange) this.onChange();
    }

    /** Current stream category for the connected channel, or null. */
    async getCurrentCategory() {
        const token = await this.getAccessToken();
        const { userId } = settings.get().twitch;
        if (!token || !userId) return null;
        try {
            const res = await fetch(`${HELIX}/channels?broadcaster_id=${userId}`, {
                headers: { Authorization: `Bearer ${token}`, 'Client-Id': CLIENT_ID },
            });
            if (!res.ok) return null;
            const d = await res.json();
            return (d.data && d.data[0] && d.data[0].game_name) || null;
        } catch (_) {
            return null;
        }
    }

    status() {
        const t = settings.get().twitch;
        return {
            configured: isConfigured(),
            connected: !!t.accessToken,
            login: t.login,
            awaitingApproval: !!this.pending,
        };
    }
}

module.exports = new TwitchAuth();
