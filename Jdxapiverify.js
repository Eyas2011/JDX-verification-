// Free membership checker for the Mini App (Vercel free plan, no credit card).
// The bot token is stored as a Vercel environment variable named BOT_TOKEN, never in this file.
import crypto from "node:crypto";

const DB_URL = "https://jdxxxx-79ee6-default-rtdb.firebaseio.com"; // your Realtime Database URL

// Same format as the admin panel: one channel per line, "Name | https://t.me/channel"
function parseChannels(text) {
  return String(text || "")
    .split("\n")
    .map(l => l.trim())
    .filter(Boolean)
    .map(l => {
      const [name, link] = l.split("|").map(s => s.trim());
      return { name: link ? name : link || name, link: link || name };
    })
    .filter(c => /^https?:\/\//.test(c.link));
}

// https://t.me/channelname -> @channelname (public channels only)
function toChatId(link) {
  const m = link.match(/^https?:\/\/t\.me\/([A-Za-z0-9_]{5,})\/?$/);
  return m ? "@" + m[1] : null;
}

// Confirms the login data really came from Telegram, and returns the user's ID
function userIdFromInitData(initData, botToken) {
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return null;
  params.delete("hash");

  const dataCheck = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");

  const secret = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
  const calc = crypto.createHmac("sha256", secret).update(dataCheck).digest("hex");
  if (calc !== hash) return null;

  // Reject logins older than 24 hours
  const authDate = Number(params.get("auth_date") || 0);
  if (Date.now() / 1000 - authDate > 86400) return null;

  try {
    const user = JSON.parse(params.get("user") || "{}");
    return user.id ? String(user.id) : null;
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const botToken = process.env.BOT_TOKEN;
  if (!botToken) return res.status(500).json({ error: "Server is missing BOT_TOKEN" });

  let body = req.body || {};
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { body = {}; }
  }

  const userId = userIdFromInitData(String(body.initData || ""), botToken);
  if (!userId) return res.status(401).json({ error: "Invalid Telegram login" });

  // Read the channel list that the admin saved (settings are readable)
  const dbRes = await fetch(`${DB_URL}/settings/requiredChannels.json`);
  if (!dbRes.ok) return res.status(500).json({ error: "Could not read channel list" });
  const channels = parseChannels((await dbRes.json()) || "");
  if (channels.length === 0) return res.status(200).json({ ok: true, missing: [] });

  const missing = [];
  for (const c of channels) {
    const chat = toChatId(c.link);
    if (!chat) { missing.push(c); continue; } // private invite links can't be checked
    try {
      const r = await fetch(
        `https://api.telegram.org/bot${botToken}/getChatMember?chat_id=${encodeURIComponent(chat)}&user_id=${userId}`
      );
      const d = await r.json();
      const status = d && d.result && d.result.status;
      if (!d.ok || !["member", "administrator", "creator"].includes(status)) missing.push(c);
    } catch {
      missing.push(c);
    }
  }

  if (missing.length === 0) return res.status(200).json({ ok: true, missing: [] });
  return res.status(200).json({ ok: false, missing: missing.map(c => ({ name: c.name, link: c.link })) });
                                            }
