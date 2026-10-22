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
const OpenAI = require("openai");
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

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

function loadKnowledgeFor(config) {
  try {
    // Load ONLY the universal loc care knowledge from root
    if (fs.existsSync("./knowledge.md")) {
      return fs.readFileSync("./knowledge.md", "utf8");
    }
    return "";
  } catch (err) {
    console.error("Knowledge load error:", err);
    return "";
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
            similarity_boost: 0.75,\n            speed: 1.07\n          }
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
const pendingVoiceRequests = new Map();

function needsThinkingCue(text = "") {
  const t = String(text).trim().toLowerCase();
  if (!t) return false;
  if (/^(hi|hello|hey|thanks|thank you|bye|goodbye)[.!?]*$/.test(t)) return false;
  if (/\b(hours?|open|close|closing|address|location|where are you|phone number|email|website|instagram|parking)\b/.test(t)) return false;
  return true;
}

app.get("/audio/:key", (req, res) => {
  const audio = audioCache.get(req.params.key);
  if (!audio) return res.sendStatus(404);
  res.set("Content-Type", "audio/mpeg");
  res.send(audio);
  setTimeout(() => audioCache.delete(req.params.key), 60000);
});


// LOCSYNC_RECEPTIONIST_V1

/* =========================
   LOCSYNC RECEPTIONIST V1
========================= */
const SERVICE_INTELLIGENCE = `
Universal LocSync service intelligence:
- Treat the client's service words as clues, not final classification.
- Never invent a service, price, policy, availability, booking rule, or capability that is not in the tenant config.
- If a tenant field is blank, say it is not listed and offer consultation/human follow-up when useful.
- Never read long URLs aloud on voice calls. For voice, put the correct URL in sms_url and say you can text/send the link.
- A client saying "retwist" may mean palm-roll retwist, interlocking, crochet maintenance, wick maintenance, microloc/Sisterlock retightening, or repair. Verify technique when it materially changes time or price.
- Standard retwist: routine root maintenance for otherwise healthy locs. Screen for thinning, weak spots, hanging/broken locs, overdue maintenance, or hidden repairs before releasing a retwist booking path.
- Interlocking: root maintenance using an interlocking/latch-hook method. Clients may call it retwist with a tool or crochet hook. For return clients, known maintenance history is stronger evidence than vague wording.
- Crochet maintenance: root and sometimes shaft maintenance, often chosen for stronger/longer-lasting control. It usually takes more time and costs more than a standard retwist; do not recommend it unless the tenant offers it.
- Loc repair: any corrective work for thinning, broken, weak, hanging, fallen, or structurally compromised locs. One damaged loc may contain multiple repair points. Larger or unclear repair needs should go to consultation/photo review rather than a blind booking.
- Reattachment: client still has original locs and wants them attached back. A few reattachments may be repair; a large section/full head is a reattachment service. If original locs are missing and new locs must be made, that is new attachment/extension work, not true reattachment.
- Loc extensions: clarify permanent human-hair extensions versus temporary/faux/boho/goddess/gypsy/synthetic loc styles. Permanent extensions may be attached to loose hair or existing locs. Thickness, count, length, density, grip, and prep can materially change time/price, so consultation is usually appropriate.
- Starter locs: traditional starters may use comb coils, two-strand twists, or braidlocs depending on texture, length, density, and provider. "Starter locs" is the goal, not automatically the technique.
- Instant locs: formed immediately from the client's existing hair, often useful when traditional starters are unsuitable or the client wants loc structure right away. If they want added length beyond their own hair, that points toward extensions instead.
- Microlocs/Sisterlocks: tiny-loc services need their own installation and retightening logic. Sisterlocks are a specific certified method. Tiny-loc maintenance should not default to a normal retwist. First-time/transfer/overdue maintenance may need consultation.
- Loc combining: clarify whether the goal is cosmetic thickness, moving from tiny locs to larger traditional locs, creating wicks, or strengthening thin locs as repair. Consultation is usually appropriate.
- Wick creation may involve combining existing locs, forming wicks from loose hair, or adding wick extensions. Ask desired number/thickness, hair density/texture, length, and whether extensions are needed. Consultation is usually appropriate.
- Wick maintenance: ask how long since last maintenance and whether the need is roots only, fuzziness along the shaft, separation, repair, or added length. Overdue maintenance may turn into repair work.
- When technique, damage, thickness, density, count, length, or hair texture can substantially change chair time or price, qualify before sending a booking link.
- Consultation-first when the need is unclear, structurally complex, highly variable, provider-specific, or the tenant requires consultation.
- Keep spoken answers short: usually one or two sentences, then the next useful question.
`;

function xmlEscape(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function stripUrlsFromSpeech(value = "") {
  return String(value)
    .replace(new RegExp("https?://\\S+", "gi"), "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function cleanDecision(raw) {
  const d = raw && typeof raw === "object" ? raw : {};
  const allowed = new Set(["answer", "handoff", "message"]);
  return {
    speech: stripUrlsFromSpeech(d.speech || "I can help you figure out the right next step."),
    action: allowed.has(d.action) ? d.action : "answer",
    sms_url: typeof d.sms_url === "string" && /^https?:\/\//i.test(d.sms_url) ? d.sms_url : "",
    sms_label: typeof d.sms_label === "string" ? d.sms_label.slice(0, 80) : ""
  };
}

async function sendSmsLink(to, config, url, label) {
  if (!to || !url) return false;
  const from = config.phone_assignment?.bot_phone || config.phone_assignment?.assigned_phone_number;
  if (!from) return false;
  try {
    await twilioClient.messages.create({
      to,
      from,
      body: `${label || "Here is the link we discussed"}: ${url}`
    });
    return true;
  } catch (err) {
    console.error("SMS link failed:", err.message);
    return false;
  }
}

async function generateAssistantDecision(text, config, channel = "voice") {
  try {
    const universalKnowledge = loadKnowledgeFor(config);
    const tenantData = JSON.stringify(config, null, 2);
    const now = new Date().toISOString();

    const systemPrompt = `You are LocSync, the AI receptionist for ${config.salon_info?.salon_name || "this loc business"}.

Your job is to understand what the caller actually needs, protect the loctician's schedule, prevent wrong-service bookings, answer concise business questions from tenant data, and route to consultation or a human when appropriate.

CURRENT TIME (UTC): ${now}
CHANNEL: ${channel}

AUTHORITATIVE TENANT CONFIG:
${tenantData}

UNIVERSAL LOC CARE KNOWLEDGE:
${universalKnowledge}

SERVICE DECISION RULES:
${SERVICE_INTELLIGENCE}

Critical behavior:
1. Tenant-specific data overrides general knowledge for this business.
2. Never make up missing tenant facts. If the config is blank, say it is not listed.
3. Do not promise that the tenant offers a service unless a tenant field/link/policy supports it.
4. Do not quote a universal price. Use only tenant-specific pricing if actually present.
5. For ambiguous service requests, ask one useful qualifying question at a time or at most two closely related questions.
6. For new/uncertain clients, do not release a generic maintenance booking link just because they said "retwist."
7. If repair risk or a major time/price mismatch is possible, clarify first.
8. If consultation is required by tenant policy, route there.
9. On voice calls, NEVER put a URL in speech. If a link is appropriate, set sms_url to the exact tenant-config URL and tell the caller you can text/send it.
10. Prefer the most specific service URL that actually matches the classified need. Use the main booking URL only when no specific route is available and direct booking is appropriate.
11. action="handoff" only when the caller explicitly wants a person/team, a handoff phone exists, and business hours are listed strongly enough to support live transfer. If hours are blank/unclear, use action="message" instead.
12. action="message" when human review/consultation is needed but a live transfer should not be assumed.
13. Keep speech natural and usually under two sentences.

Return ONLY valid JSON in this exact shape:
{"speech":"short spoken response","action":"answer|handoff|message","sms_url":"","sms_label":""}`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.25,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: text }
      ],
      max_tokens: 260
    });

    const parsed = safeJsonParse(completion.choices?.[0]?.message?.content || "{}", {});
    return cleanDecision(parsed);
  } catch (err) {
    console.error("OpenAI decision error:", err);
    return {
      speech: "I can help with services, booking, policies, or getting a message to the team.",
      action: "answer",
      sms_url: "",
      sms_label: ""
    };
  }
}

async function generateChatResponse(text, config) {
  const d = await generateAssistantDecision(text, config, "web");
  return d.sms_url ? `${d.speech}\n${d.sms_url}` : d.speech;
}

/* =========================
   VOICE WEBHOOKS
========================= */
app.post("/voice/:tenantId", async (req, res) => {
  const config = loadTenantConfig(req.params.tenantId);
  if (!config) return res.type("text/xml").send(`<Response><Say>Not configured</Say></Response>`);

  const callSid = req.body?.CallSid;
  console.log("📞 CallSid received:", callSid);

  // Start recording via REST API after short delay
  if (callSid) {
    setTimeout(async () => {
      try {
        const auth = Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64');
        const recordResponse = await fetch(
          `https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Calls/${callSid}/Recordings.json`,
          {
            method: 'POST',
            headers: {
              'Authorization': `Basic ${auth}`,
              'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: new URLSearchParams({
              RecordingStatusCallback: `${PUBLIC_BASE_URL}/recording-status`,
              RecordingStatusCallbackMethod: 'POST',
            }).toString()
          }
        );
        const data = await recordResponse.json();
        console.log("📼 Recording API response:", JSON.stringify(data));
      } catch (err) {
        console.error("Recording start failed:", err);
      }
    }, 1500);
  }

  const greeting =
    config.voice_config?.greeting_tts ||
    `Thanks for calling ${config.salon_info.salon_name}. This call may be recorded for quality purposes. How can I help?`;

  const thinkingCue = "Got it, one moment while I check that for you.";
  const [audio, thinkingAudio] = await Promise.all([
    generateSpeech(greeting, config.voice_config?.voice_id),
    generateSpeech(thinkingCue, config.voice_config?.voice_id)
  ]);

  if (thinkingAudio) {
    audioCache.set(`thinking-${req.params.tenantId}`, thinkingAudio);
  }

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

  res.type("text/xml").send(`<Response><Say>${greeting}</Say><Gather input="speech" action="${PUBLIC_BASE_URL}/voice-response/${req.params.tenantId}" timeout="5" /></Response>`);
});

app.post("/voice-response/:tenantId", async (req, res) => {
  const config = loadTenantConfig(req.params.tenantId);
  if (!config) return res.type("text/xml").send(`<Response><Say>Error</Say></Response>`);

  const speech = req.body.SpeechResult || "";
  const callerPhone = req.body.From || "";
  const callSid = req.body.CallSid || `call-${Date.now()}`;

  if (needsThinkingCue(speech)) {
    const token = `${callSid}-${Date.now()}`;
    pendingVoiceRequests.set(token, { speech, callerPhone, tenantId: req.params.tenantId });
    setTimeout(() => pendingVoiceRequests.delete(token), 120000);

    const cueKey = `thinking-${req.params.tenantId}`;
    const cue = audioCache.has(cueKey)
      ? `<Play>${PUBLIC_BASE_URL}/audio/${cueKey}</Play>`
      : `<Say>Got it, one moment while I check that for you.</Say>`;

    return res.type("text/xml").send(
      `<Response>${cue}<Redirect method="POST">${PUBLIC_BASE_URL}/voice-process/${req.params.tenantId}?token=${encodeURIComponent(token)}</Redirect></Response>`
    );
  }

  return processVoiceTurn(req, res, config, speech, callerPhone);
});

app.post("/voice-process/:tenantId", async (req, res) => {
  const config = loadTenantConfig(req.params.tenantId);
  if (!config) return res.type("text/xml").send(`<Response><Say>Error</Say></Response>`);

  const token = req.query.token || "";
  const pending = pendingVoiceRequests.get(token);
  if (!pending) {
    return res.type("text/xml").send(
      `<Response><Say>Sorry, I lost that request. Please tell me again.</Say><Gather input="speech" action="${PUBLIC_BASE_URL}/voice-response/${req.params.tenantId}" timeout="7" /></Response>`
    );
  }

  pendingVoiceRequests.delete(token);
  return processVoiceTurn(req, res, config, pending.speech, pending.callerPhone);
});

async function processVoiceTurn(req, res, config, speech, callerPhone) {
  const decision = await generateAssistantDecision(speech, config, "voice");

  if (decision.sms_url) {
    const sent = await sendSmsLink(callerPhone, config, decision.sms_url, decision.sms_label);
    if (sent && !/text|send/i.test(decision.speech)) {
      decision.speech = `${decision.speech} I sent the link by text.`;
    }
  }

  const spoken = decision.speech || "How else can I help?";
  const audio = await generateSpeech(spoken, config.voice_config?.voice_id);
  let lead;

  if (audio) {
    const key = `reply-${Date.now()}`;
    audioCache.set(key, audio);
    lead = `<Play>${PUBLIC_BASE_URL}/audio/${key}</Play>`;
  } else {
    lead = `<Say>${xmlEscape(spoken)}</Say>`;
  }

  const asksAQuestion = /\?\s*$/.test(spoken.trim());
  const explicitlyWantsHuman = /\b(human|person|someone|staff|team|loctician|owner|speak to|talk to|leave (a )?message|voicemail|call me back|callback)\b/i.test(speech);

  if (decision.action === "handoff" && config.contact?.handoff_phone && explicitlyWantsHuman) {
    return res.type("text/xml").send(
      `<Response>${lead}<Dial>${xmlEscape(config.contact.handoff_phone)}</Dial></Response>`
    );
  }

  if (decision.action === "message" && explicitlyWantsHuman && !asksAQuestion) {
    return res.type("text/xml").send(
      `<Response>${lead}<Say>Please leave your name, number, and a short message after the tone.</Say><Record maxLength="120" playBeep="true" recordingStatusCallback="${PUBLIC_BASE_URL}/recording-status" /><Hangup /></Response>`
    );
  }

  return res.type("text/xml").send(
    `<Response>${lead}<Gather input="speech" action="${PUBLIC_BASE_URL}/voice-response/${config.tenant_id}" timeout="7" /></Response>`
  );
}

app.post("/recording-status", (req, res) => {
  const { CallSid, RecordingSid, RecordingUrl, RecordingDuration, RecordingStatus } = req.body;
  console.log("📼 Recording update:", { CallSid, RecordingSid, RecordingStatus, RecordingDuration: `${RecordingDuration}s`, RecordingUrl });
  if (RecordingStatus === 'completed') {
    console.log("✅ Recording saved:", RecordingUrl);
    // Future: save to Airtable or admin dashboard
  }
  res.json({ received: true });
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

  try {
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
  } catch (err) {
    console.error("❌ Webhook error:", err);
    res.json({ ok: true });
  }
});

/* =========================
   CHAT LOGIC
========================= */
// generateChatResponse is provided by LOCSYNC_RECEPTIONIST_V1 above.

/* =========================
   HEALTH CHECK
========================= */
app.get("/", (_, res) => res.send("LocSync running 🚀"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => console.log(`🚀 Server live on ${PORT}`));
