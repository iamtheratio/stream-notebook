'use strict';

const http = require('http');
const settings = require('../Settings');

/**
 * Streamer.bot reply transport.
 *
 * For users who already run Streamer.bot: inbound chat arrives over the WebSocket
 * as `chat-message` events (see streamerbot/ChatMessageScript.cs) and replies go
 * back out through a Streamer.bot action, which fans them to Twitch, YouTube and
 * TikTok at once. That multi-platform reach is the reason to pick this over the
 * direct Twitch adapter.
 */
function sendViaStreamerbot(message, platform = 'twitch') {
    const sb = settings.get().streamerbot;
    const body = JSON.stringify({
        action: { name: sb.action },
        args: { replyMessage: message, platform },
    });

    const req = http.request({
        hostname: sb.host,
        port: sb.port,
        path: '/DoAction',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    });
    req.on('error', err => console.warn(`⚠️  [streamerbot] Reply failed: ${err.message}`));
    req.write(body);
    req.end();
}

module.exports = { sendViaStreamerbot };
