// LocSync Multi-Tenant Voice + Web Chat Bot
// Voice: Twilio + ElevenLabs
// Web Chat: Twilio Conversations

require("dotenv").config();
const express = require("express");
const fetch = require("node-fetch");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const twilio = require("twilio");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

/* =========================
   ENV + TWILIO
========================= */
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

const CONV_SERVICE_SID = process.env.TWILIO_CONVERSATIONS_SERVICE_SID;
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL;

/* =========================
   WEB CHAT SESSION STORE
========================= */
const WEBCHAT_SESSIONS = new Map();

function makeToken() {
  return crypto.randomBytes(16).toString("hex");
}

function safeJsonParse(str, fallback = {}) {
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

/* =========================
   TENANT CONFIG LOADER
========================= */
function loadTenantConfig(tenantId) {
  try {
    const filePath = path.join(__dirname, "config", "tenants", `${tenantId}.json`);
     console.log("🔍 Looking for tenant at:", filePath); // ADD THIS
    console.log("📁 File exists?", fs.existsSync(filePath)); // ADD THIS
    const config = JSON.parse(fs.readFileSync(filePath, "utf8"));
    console.log(`✅ Loaded tenant: ${config.salon_info.salon_name}`);
    return config;
  } catch (err) {
    console.error("❌ Tenant config load failed:", tenantId);
    return null;
  }
}

/* =========================
   ELEVENLABS TTS
========================= */
async function generateSpeech(text, voiceId) {
  if (!process.env.ELEVENLABS_API_KEY) return null;

  try {
    const res = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
      {
        method: "POST",
        headers: {
          "Accept": "audio/mpeg",
          "Content-Type": "application/json",
          "xi-api-key": process.env.ELEVENLABS_API_KEY
        },
        body: JSON.stringify({
          text,
          model_id: "eleven_turbo_v2",
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.75
          }
        })
      }
    );

    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
}

/* =========================
   TEMP AUDIO CACHE
========================= */
const audioCache = new Map();

app.get("/audio/:key", (req, res) => {
  const audio = audioCache.get(req.params.key);
  if (!audio) return res.sendStatus(404);
  res.set("Content-Type", "audio/mpeg");
  res.send(audio);
  setTimeout(() => audioCache.delete(req.params.key), 60000);
});

/* =========================
   VOICE WEBHOOKS
========================= */
app.post("/voice/:tenantId", async (req, res) => {
  const config = loadTenantConfig(req.params.tenantId);
  if (!config) return res.type("text/xml").send(`<Response><Say>Not configured</Say></Response>`);

  const greeting =
    config.voice_config?.greeting_tts ||
    `Thanks for calling ${config.salon_info.salon_name}. How can I help?`;

  const audio = await generateSpeech(
    greeting,
    config.voice_config?.voice_id
  );

  if (audio) {
    const key = `greet-${Date.now()}`;
    audioCache.set(key, audio);

    return res.type("text/xml").send(`
      <Response>
        <Play>${PUBLIC_BASE_URL}/audio/${key}</Play>
        <Gather input="speech" action="${PUBLIC_BASE_URL}/voice-response/${req.params.tenantId}" />
      </Response>
    `);
  }

  res.type("text/xml").send(`<Response><Say>${greeting}</Say></Response>`);
});

app.post("/voice-response/:tenantId", async (req, res) => {
  const config = loadTenantConfig(req.params.tenantId);
  if (!config) return res.type("text/xml").send(`<Response><Say>Error</Say></Response>`);

  const speech = req.body.SpeechResult || "";
  const reply = await generateChatResponse(speech, config);

  const audio = await generateSpeech(reply, config.voice_config?.voice_id);
  if (!audio) return res.type("text/xml").send(`<Response><Say>${reply}</Say></Response>`);

  const key = `reply-${Date.now()}`;
  audioCache.set(key, audio);

  res.type("text/xml").send(`
    <Response>
      <Play>${PUBLIC_BASE_URL}/audio/${key}</Play>
      <Gather input="speech" action="${PUBLIC_BASE_URL}/voice-response/${req.params.tenantId}" />
    </Response>
  `);
});

/* =========================
   WEB CHAT START
========================= */
// ADD THIS BEFORE THE /webchat/:tenantId/start ROUTE
app.get("/test-config/:tenantId", (req, res) => {
  const config = loadTenantConfig(req.params.tenantId);
  res.json({
    loaded: !!config,
    salon_name: config?.salon_info?.salon_name,
    chat_enabled: config?.chat_config?.enabled
  });
});

app.post("/webchat/:tenantId/start", async (req, res) => {
  try {
    const config = loadTenantConfig(req.params.tenantId);
    console.log("🔍 Config loaded:", !!config);
    console.log("🔍 Chat enabled:", config?.chat_config?.enabled);
    
    if (!config || !config.chat_config?.enabled) {
      return res.status(403).json({ error: "Chat disabled" });
    }

    console.log("✅ Creating Twilio conversation...");
    
    const convo = await twilioClient.conversations.v1.conversations.create({
      friendlyName: `${config.salon_info.salon_name} Web Chat`,
      attributes: JSON.stringify({ tenant_id: req.params.tenantId })
    });

    console.log("✅ Conversation created:", convo.sid);

    const token = makeToken();
    WEBCHAT_SESSIONS.set(token, { conversationSid: convo.sid, tenantId: req.params.tenantId });

    await twilioClient.conversations.v1
      .conversations(convo.sid)
      .messages.create({
        author: "locsync_ai",
        body: `Hi! Welcome to ${config.salon_info.salon_name}. How can I help?`
      });

    console.log("✅ Session created");
    
    res.json({ sessionToken: token, conversationSid: convo.sid });
    
  } catch (error) {
    console.error("❌ Webchat start error:", error.message);
    console.error("❌ Full error:", error);
    res.status(500).json({ error: error.message });
  }
});

/* =========================
   WEB CHAT SEND
========================= */
app.post("/webchat/:tenantId/send", async (req, res) => {
  const { sessionToken, message } = req.body;
  const sess = WEBCHAT_SESSIONS.get(sessionToken);
  if (!sess) return res.sendStatus(403);

  await twilioClient.conversations.v1
    .conversations(sess.conversationSid)
    .messages.create({
      author: "web_visitor",
      body: message
    });

  res.json({ ok: true });
});

/* =========================
   CHAT WEBHOOK (FIXED LOOP)
========================= */
app.post("/chat/webhook", async (req, res) => {
  if (req.body.EventType !== "onMessageAdded") return res.json({ ok: true });

  const author = req.body.Author;
  const body = (req.body.Body || "").trim();

  if (!body) return res.json({ ok: true });
  if (author === "locsync_ai") return res.json({ ok: true });
  if (author === "web_visitor") return res.json({ ok: true });

  const convo = await twilioClient.conversations.v1
    .conversations(req.body.ConversationSid)
    .fetch();

  const tenantId = safeJsonParse(convo.attributes).tenant_id;
  const config = loadTenantConfig(tenantId);
  if (!config) return res.json({ ok: true });

  const reply = await generateChatResponse(body, config);

  await twilioClient.conversations.v1
    .conversations(convo.sid)
    .messages.create({
      author: "locsync_ai",
      body: reply
    });

  res.json({ ok: true });
});

/* =========================
   CHAT LOGIC
========================= */
async function generateChatResponse(text, config) {
  const msg = text.toLowerCase();

  if (msg.includes("hour"))
    return `Hours: ${config.hours.schedule}`;

  if (msg.includes("book"))
    return `Book here: ${config.booking.main_booking_url}`;

  if (msg.includes("price"))
    return `Pricing: ${config.pricing.details}`;

  if (msg.includes("location"))
    return `Address: ${config.salon_info.location.address}`;

  return `I can help with HOURS, BOOKING, PRICING, or LOCATION.`;
}
app.get("/webchat/:tenantId/messages", async (req, res) => {
  const { conversationSid, sessionToken } = req.query;
  const sess = WEBCHAT_SESSIONS.get(sessionToken);
  
  if (!sess) return res.sendStatus(403);
  
  try {
    const messages = await twilioClient.conversations.v1
      .conversations(conversationSid)
      .messages.list({ limit: 50 });
    
    res.json({
      messages: messages.map(m => ({
        author: m.author,
        body: m.body,
        index: m.index
      }))
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


/* =========================
   HEALTH CHECK
========================= */
app.get("/", (_, res) => res.send("LocSync running 🚀"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server live on ${PORT}`));
