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
    console.log("🔍 Looking for tenant at:", filePath);
    console.log("📁 File exists?", fs.existsSync(filePath));
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
   WEB CHAT ROUTES
========================= */
app.get("/test-config/:tenantId", (req, res) => {
  const config = loadTenantConfig(req.params.tenantId);
  res.json({
    loaded: !!config,
    salon_name: config?.salon_info?.salon_name,
    chat_enabled: config?.chat_config?.enabled
  });
});

app.post("/webchat/:tenantId/token", async (req, res) => {
  try {
    const config = loadTenantConfig(req.params.tenantId);
    if (!config || !config.chat_config?.enabled) {
      return res.status(403).json({ error: "Chat disabled" });
    }

    const AccessToken = twilio.jwt.AccessToken;
    const ChatGrant = AccessToken.ChatGrant;

    const identity = `user_${Date.now()}`;
    const token = new AccessToken(
      process.env.TWILIO_ACCOUNT_SID,
      process.env.TWILIO_API_KEY,
      process.env.TWILIO_API_SECRET,
      { identity }
    );

    const chatGrant = new ChatGrant({
      serviceSid: process.env.TWILIO_CONVERSATIONS_SERVICE_SID
    });

    token.addGrant(chatGrant);

    // CREATE IN THE CORRECT SERVICE
    const convo = await twilioClient.conversations.v1
      .services(process.env.TWILIO_CONVERSATIONS_SERVICE_SID)
      .conversations.create({
        friendlyName: `${config.salon_info.salon_name} Web Chat`,
        attributes: JSON.stringify({ tenant_id: req.params.tenantId })
      });

    await twilioClient.conversations.v1
      .services(process.env.TWILIO_CONVERSATIONS_SERVICE_SID)
      .conversations(convo.sid)
      .participants.create({ identity });

    await twilioClient.conversations.v1
      .services(process.env.TWILIO_CONVERSATIONS_SERVICE_SID)
      .conversations(convo.sid)
      .messages.create({
        author: "locsync_ai",
        body: `Hi! Welcome to ${config.salon_info.salon_name}. How can I help?`
      });

    res.json({ 
      token: token.toJwt(), 
      conversationSid: convo.sid 
    });
  } catch (error) {
    console.error("Token error:", error);
    res.status(500).json({ error: error.message });
  }
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

app.post("/webchat/:tenantId/send", async (req, res) => {
  const { sessionToken, message } = req.body;
  const sess = WEBCHAT_SESSIONS.get(sessionToken);
  if (!sess) return res.sendStatus(403);

  await twilioClient.conversations.v1
    .conversations(sess.conversationSid)
    .messages.create({
      author: "website_user",
      body: message
    });

  res.json({ ok: true });
});

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
   CHAT WEBHOOK
========================= */
app.post("/chat/webhook", async (req, res) => {
  console.log("🔔 Webhook received:", req.body.EventType);
  console.log("👤 Author:", req.body.Author);
  console.log("💬 Body:", req.body.Body);
  
  if (req.body.EventType !== "onMessageAdded") {
    console.log("⏭️ Skipping non-message event");
    return res.json({ ok: true });
  }

  const author = req.body.Author;
  const body = (req.body.Body || "").trim();

  if (!body) {
    console.log("⏭️ Empty message");
    return res.json({ ok: true });
  }
  
  if (author === "locsync_ai") {
    console.log("⏭️ Skipping own message");
    return res.json({ ok: true });
  }

  console.log("✅ Processing message from:", author);

  const convo = await twilioClient.conversations.v1
  .services(CONV_SERVICE_SID)
  .conversations(req.body.ConversationSid)
  .fetch();

  const tenantId = safeJsonParse(convo.attributes).tenant_id;
  const config = loadTenantConfig(tenantId);
  
  if (!config) {
    console.log("❌ No config found");
    return res.json({ ok: true });
  }

  const reply = await generateChatResponse(body, config);
  console.log("🤖 Sending reply:", reply);

  await twilioClient.conversations.v1
  .services(CONV_SERVICE_SID)
  .conversations(convo.sid)
  .messages.create({
    author: "locsync_ai",
    body: reply
  });

  console.log("✅ Reply sent");
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
    return `Pricing varies by service. Visit our booking link for details.`;

  if (msg.includes("location"))
    return `Address: ${config.salon_info.location.address}`;

  return `I can help with HOURS, BOOKING, PRICING, or LOCATION.`;
}

/* =========================
   HEALTH CHECK
========================= */
app.get("/", (_, res) => res.send("LocSync running 🚀"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server live on ${PORT}`));
