using System;
using System.Net.WebSockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Newtonsoft.Json.Linq;

/*
 * Stream Notebook — Streamer.bot chat bridge (OPTIONAL)
 * ─────────────────────────────────────────────────────
 * Only needed if you set "Where chat comes from" to Streamer.bot in the
 * dashboard. If you're on the default (Twitch), ignore this file entirely.
 *
 * Why bother: Streamer.bot already normalises Twitch, YouTube and TikTok chat,
 * so this gets !note working on all three at once.
 *
 * SETUP
 *  1. Streamer.bot → Actions → right-click → Add → name it "Notebook Chat Relay"
 *  2. Sub-Actions → Add → Core → C# → Execute C# Code → paste this whole file
 *  3. Compile. If it errors, References tab → add Newtonsoft.Json.dll
 *  4. Triggers → Add:
 *       Twitch  → Chat Message
 *       YouTube → Message           (optional)
 *       Command → your TikTok relay (optional)
 *  5. In the Stream Notebook dashboard, set chat source to Streamer.bot.
 *
 * CHAT REPLIES
 * The notebook posts confirmations by calling a Streamer.bot action named
 * "Send All Chats to Platforms" with a "replyMessage" argument. Create that
 * action with a Send Message sub-action using %replyMessage%, or turn
 * "Reply in chat" off in the dashboard.
 */
public class CPHInline
{
    // Change this only if you edited the port in the dashboard.
    private const string NotebookUrl = "ws://localhost:8765";

    public bool Execute()
    {
        string platform, username, message;
        var data = new JObject();

        // ── Twitch / YouTube: a real chat message event ──
        if (CPH.TryGetArg("message", out message) && !string.IsNullOrWhiteSpace(message))
        {
            CPH.TryGetArg("user", out username);
            CPH.TryGetArg("eventSource", out string source);

            platform = (source ?? "").ToLower().Contains("youtube") ? "youtube" : "twitch";

            CPH.TryGetArg("isModerator", out bool isMod);
            CPH.TryGetArg("isBroadcaster", out bool isBroadcaster);
            CPH.TryGetArg("isVip", out bool isVip);

            data["username"]      = username ?? "someone";
            data["message"]       = message;
            data["platform"]      = platform;
            data["isModerator"]   = isMod;
            data["isBroadcaster"] = isBroadcaster;
            data["isVip"]         = isVip;
            data["emotes"]        = BuildEmotes();
        }
        // ── TikTok (relayed as a command with parameters) ──
        else if (CPH.TryGetArg("rawInput", out string raw) && !string.IsNullOrWhiteSpace(raw))
        {
            CPH.TryGetArg("nickname", out string nickname);
            CPH.TryGetArg("username", out string handle);

            data["username"]      = nickname ?? handle ?? "Anonymous";
            data["message"]       = raw;
            data["platform"]      = "tiktok";
            data["isModerator"]   = false;
            data["isBroadcaster"] = false;
            data["isVip"]         = false;
            data["emotes"]        = new JArray();
        }
        else
        {
            return false;
        }

        // Cheap early-out: the notebook only cares about !note / !notes / !help note.
        string text = (data["message"] ?? "").ToString().TrimStart();
        if (!text.StartsWith("!note", StringComparison.OrdinalIgnoreCase) &&
            !text.StartsWith("!help note", StringComparison.OrdinalIgnoreCase))
            return true;

        var payload = new JObject
        {
            ["event"]         = "chat-message",
            ["eventDateTime"] = DateTime.Now.ToString("yyyy-MM-ddTHH:mm:ss.fffZ"),
            ["data"]          = data
        };

        try { SendMessage(NotebookUrl, payload.ToString()).Wait(3000); }
        catch (Exception e) { CPH.LogWarn("[notebook] send failed: " + e.Message); }

        return true;
    }

    /// Emote names + image URLs, so notes can render emotes instead of raw text.
    private JArray BuildEmotes()
    {
        var arr = new JArray();
        try
        {
            if (CPH.TryGetArg("emotes", out string emoteJson) && !string.IsNullOrWhiteSpace(emoteJson))
            {
                foreach (var e in JArray.Parse(emoteJson))
                {
                    var name = (string)e["name"];
                    var url  = (string)e["imageUrl"];
                    if (!string.IsNullOrEmpty(name) && !string.IsNullOrEmpty(url))
                        arr.Add(new JObject { ["name"] = name, ["imageUrl"] = url });
                }
            }
        }
        catch { /* emotes are a nice-to-have; never fail the message over them */ }
        return arr;
    }

    private async Task SendMessage(string url, string json)
    {
        using (var ws = new ClientWebSocket())
        {
            await ws.ConnectAsync(new Uri(url), CancellationToken.None);
            var bytes = Encoding.UTF8.GetBytes(json);
            await ws.SendAsync(new ArraySegment<byte>(bytes), WebSocketMessageType.Text, true, CancellationToken.None);
            await ws.CloseAsync(WebSocketCloseStatus.NormalClosure, "done", CancellationToken.None);
        }
    }
}
