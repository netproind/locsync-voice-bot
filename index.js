// LocSync Multi-Tenant Voice Bot with ElevenLabs
// Natural voice conversations using ElevenLabs TTS

require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ===== CONFIGURATION LOADER =====
function loadTenantConfig(tenantId) {
  try {
    const configPath = path.join(__dirname, 'config', 'tenants', `${tenantId}.json`);
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    console.log(`✅ Loaded config for tenant: ${config.salon_info.salon_name}`);
    return config;
  } catch (error) {
    console.error(`❌ Failed to load config for tenant: ${tenantId}`, error);
    return null;
  }
}

// ===== ELEVENLABS TEXT-TO-SPEECH =====
async function generateSpeech(text, voiceId = '21m00Tcm4TlvDq8ikWAM') {
  const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
  
  if (!ELEVENLABS_API_KEY) {
    console.error('❌ ELEVENLABS_API_KEY not set!');
    return null;
  }
  
  try {
    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
      {
        method: 'POST',
        headers: {
          'Accept': 'audio/mpeg',
          'xi-api-key': ELEVENLABS_API_KEY,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          text: text,
          model_id: 'eleven_turbo_v2',
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.75,
            style: 0.0,
            use_speaker_boost: true
          }
        })
      }
    );
    
    if (!response.ok) {
      const error = await response.text();
      console.error('❌ ElevenLabs API error:', error);
      return null;
    }
    
    const audioBuffer = await response.arrayBuffer();
    return Buffer.from(audioBuffer);
    
  } catch (error) {
    console.error('❌ Error generating speech:', error);
    return null;
  }
}

// ===== TEMP AUDIO STORAGE =====
const audioCache = new Map();

app.get('/audio/:cacheKey', (req, res) => {
  const { cacheKey } = req.params;
  const audioBuffer = audioCache.get(cacheKey);
  
  if (!audioBuffer) {
    return res.status(404).send('Audio not found');
  }
  
  res.set('Content-Type', 'audio/mpeg');
  res.send(audioBuffer);
  
  // Clean up after 1 minute
  setTimeout(() => audioCache.delete(cacheKey), 60000);
});

// ===== VOICE WEBHOOK =====
app.post('/voice/:tenantId', async (req, res) => {
  const { tenantId } = req.params;
  const config = loadTenantConfig(tenantId);
  
  if (!config) {
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna">Sorry, this number is not configured. Please contact support.</Say>
</Response>`;
    return res.type('text/xml').send(twiml);
  }
  
  console.log(`📞 Incoming call for: ${config.salon_info.salon_name}`);
  
  const greeting = config.voice_config?.greeting_tts || 
                   `Thanks for calling ${config.salon_info.salon_name}. How can I help you today?`;
  
  const voiceId = config.voice_config?.voice_id || '21m00Tcm4TlvDq8ikWAM';
  
  // Generate greeting with ElevenLabs
  const audioBuffer = await generateSpeech(greeting, voiceId);
  
  if (audioBuffer) {
    // Store audio temporarily
    const cacheKey = `greeting-${tenantId}-${Date.now()}`;
    audioCache.set(cacheKey, audioBuffer);
    
    const audioUrl = `https://${req.headers.host}/audio/${cacheKey}`;
    
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${audioUrl}</Play>
  <Gather input="speech" timeout="5" speechTimeout="auto" action="https://${req.headers.host}/voice-response/${tenantId}" method="POST">
    <Pause length="1"/>
  </Gather>
  <Say voice="Polly.Joanna">Sorry, I didn't catch that. Please call back or text us.</Say>
</Response>`;
    
    res.type('text/xml');
    res.send(twiml);
  } else {
    // Fallback to Polly if ElevenLabs fails
    console.log('⚠️ Falling back to Polly voice');
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna">${greeting}</Say>
  <Gather input="speech" timeout="5" speechTimeout="auto" action="https://${req.headers.host}/voice-response/${tenantId}" method="POST">
    <Pause length="1"/>
  </Gather>
  <Say voice="Polly.Joanna">Sorry, I didn't catch that. Please call back or text us.</Say>
</Response>`;
    
    res.type('text/xml');
    res.send(twiml);
  }
});

// ===== VOICE RESPONSE HANDLER =====
app.post('/voice-response/:tenantId', async (req, res) => {
  const { tenantId } = req.params;
  const config = loadTenantConfig(tenantId);
  const userSpeech = req.body.SpeechResult || '';
  const callerNumber = req.body.From;
  
  console.log(`🎤 User said: "${userSpeech}"`);
  
  if (!userSpeech) {
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna">I didn't hear anything. Please call back if you need help. Goodbye!</Say>
</Response>`;
    return res.type('text/xml').send(twiml);
  }
  
  // Generate response based on intent
  const response = await generateResponse(userSpeech, config, callerNumber);
  const voiceId = config.voice_config?.voice_id || '21m00Tcm4TlvDq8ikWAM';
  
  // Generate response with ElevenLabs
  const audioBuffer = await generateSpeech(response, voiceId);
  
  if (audioBuffer) {
    const cacheKey = `response-${tenantId}-${Date.now()}`;
    audioCache.set(cacheKey, audioBuffer);
    const audioUrl = `https://${req.headers.host}/audio/${cacheKey}`;
    
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${audioUrl}</Play>
  <Gather input="speech" timeout="5" speechTimeout="auto" action="https://${req.headers.host}/voice-response/${tenantId}" method="POST">
    <Pause length="1"/>
  </Gather>
  <Say voice="Polly.Joanna">Thanks for calling. Goodbye!</Say>
</Response>`;
    
    res.type('text/xml');
    res.send(twiml);
  } else {
    // Fallback
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna">${response}</Say>
  <Gather input="speech" timeout="5" speechTimeout="auto" action="https://${req.headers.host}/voice-response/${tenantId}" method="POST">
    <Pause length="1"/>
  </Gather>
  <Say voice="Polly.Joanna">Thanks for calling. Goodbye!</Say>
</Response>`;
    
    res.type('text/xml');
    res.send(twiml);
  }
});

// ===== INTENT DETECTION & RESPONSE =====
async function generateResponse(userMessage, config, callerNumber) {
  const message = userMessage.toLowerCase();
  
  // HOURS
  if (message.includes('hour') || message.includes('open') || message.includes('close')) {
    return `We're open ${config.hours.schedule}. We're closed on ${config.hours.closed_days.join(' and ')}. What else can I help you with?`;
  }
  
  // APPOINTMENT
  if (message.includes('appointment') || message.includes('book') || message.includes('schedule')) {
    // Send SMS with booking link
    await sendSMS(callerNumber, `Book your appointment here: ${config.booking.main_booking_url}`, config);
    return `I'm texting you our booking link now. You'll receive it in just a moment. Is there anything else I can help you with?`;
  }
  
  // PRICING
  if (message.includes('price') || message.includes('cost') || message.includes('how much')) {
    return `Our pricing is ${config.pricing.details}. Would you like to book an appointment?`;
  }
  
  // LOCATION
  if (message.includes('location') || message.includes('address') || message.includes('where')) {
    const response = `We're located at ${config.salon_info.location.address}.`;
    if (config.salon_info.location.parking_info) {
      return response + ` ${config.salon_info.location.parking_info}. Would you like me to text you directions?`;
    }
    return response + ` Would you like me to text you directions?`;
  }
  
  // SERVICES
  if (message.includes('service') || message.includes('what do you do') || message.includes('what do you offer')) {
    return `We specialize in ${config.services.primary.join(', ')}. What service are you interested in?`;
  }
  
  // DEFAULT
  return `I can help you with information about our hours, pricing, booking appointments, or our location. What would you like to know?`;
}

// ===== SMS HELPER =====
async function sendSMS(to, body, config) {
  if (!config.sms_config?.send_links) return;
  
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  
  if (!accountSid || !authToken) {
    console.error('❌ Twilio credentials not set');
    return;
  }
  
  const client = require('twilio')(accountSid, authToken);
  
  try {
    await client.messages.create({
      body: body,
      from: config.contact.phone,
      to: to
    });
    console.log(`📱 SMS sent to ${to}`);
  } catch (error) {
    console.error('❌ SMS send failed:', error.message);
  }
}

// ===== SMS ENDPOINT =====
app.post('/sms/:tenantId', async (req, res) => {
  const { tenantId } = req.params;
  const config = loadTenantConfig(tenantId);
  
  if (!config) {
    return res.status(404).send('Tenant not found');
  }
  
  const { Body, From } = req.body;
  console.log(`💬 SMS from ${From}: ${Body}`);
  
  let response = '';
  const message = Body.toLowerCase();
  
  if (message.includes('hour')) {
    response = `We're open ${config.hours.schedule}. Text BOOK for our appointment link!`;
  } else if (message.includes('book') || message.includes('appointment')) {
    response = `Book your appointment: ${config.booking.main_booking_url}`;
  } else if (message.includes('price')) {
    response = `Pricing: ${config.pricing.details}. Text BOOK to schedule!`;
  } else if (message.includes('location') || message.includes('where')) {
    response = `We're at ${config.salon_info.location.address}`;
  } else {
    response = `Thanks for texting ${config.salon_info.salon_name}! Reply HOURS, BOOK, PRICE, or LOCATION for quick info.`;
  }
  
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Message>${response}</Message>
</Response>`;
  
  res.type('text/xml');
  res.send(twiml);
});

// ===== HEALTH CHECK =====
app.get('/', (req, res) => {
  res.send('LocSync Voice Bot is running! 🚀');
});

// ===== SERVER START =====
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 LocSync Voice Bot running on port ${PORT}`);
  console.log(`✅ ElevenLabs: ${process.env.ELEVENLABS_API_KEY ? 'Configured' : '❌ NOT CONFIGURED'}`);
  console.log(`✅ Twilio: ${process.env.TWILIO_ACCOUNT_SID ? 'Configured' : '❌ NOT CONFIGURED'}`);
});

module.exports = app;
