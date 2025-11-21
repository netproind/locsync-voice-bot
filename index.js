// LocSync Multi-Tenant Voice Bot
// Cleaned version for loctician cloning

require('dotenv').config();
const express = require('express');
const WebSocket = require('ws');
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

// ===== ELEVENLABS VOICE CONFIGURATION =====
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;

function getElevenLabsVoiceConfig(config) {
  return {
    voiceId: config.voice_config.voice_id,
    model: config.voice_config.model || 'eleven_turbo_v2_5',
    stability: config.voice_config.stability || 0.5,
    similarityBoost: config.voice_config.similarity_boost || 0.75
  };
}

// ===== TWILIO SMS HELPER =====
async function sendSMS(to, body, config) {
  if (!config.sms_config.send_links) return;
  
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const client = require('twilio')(accountSid, authToken);
  
  try {
    await client.messages.create({
      body: body,
      from: config.contact.phone, // Their assigned LocSync number
      to: to
    });
    console.log(`📱 SMS sent to ${to}: ${body}`);
  } catch (error) {
    console.error('❌ SMS send failed:', error);
  }
}

// ===== WEBSOCKET VOICE HANDLER =====
app.post('/voice/:tenantId', async (req, res) => {
  const { tenantId } = req.params;
  const config = loadTenantConfig(tenantId);
  
  if (!config) {
    return res.status(404).send('Tenant not found');
  }
  
  console.log(`📞 Incoming call for: ${config.salon_info.salon_name}`);
  
  const greeting = config.voice_config?.greeting_tts || 
                   `Thanks for calling ${config.salon_info.salon_name}. How can I help you today?`;
  
  // Generate speech with ElevenLabs
  const voiceId = config.voice_config?.voice_id || '21m00Tcm4TlvDq8ikWAM'; // Rachel default
  
  try {
    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
      {
        method: 'POST',
        headers: {
          'Accept': 'audio/mpeg',
          'xi-api-key': process.env.ELEVENLABS_API_KEY,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          text: greeting,
          model_id: 'eleven_turbo_v2',
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.75
          }
        })
      }
    );
    
    if (!response.ok) {
      throw new Error('ElevenLabs API error');
    }
    
    // Get audio URL from ElevenLabs
    const audioBuffer = await response.arrayBuffer();
    const base64Audio = Buffer.from(audioBuffer).toString('base64');
    
    // For now, use Twilio's Say as fallback
    // (Proper implementation would save audio to S3 or temp storage)
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna">Thanks for calling ${config.salon_info.salon_name}. How can I help you today?</Say>
  <Gather input="speech" timeout="3" action="/voice-response/${tenantId}" method="POST">
    <Say voice="Polly.Joanna">Please tell me what you need.</Say>
  </Gather>
</Response>`;
    
    res.type('text/xml');
    res.send(twiml);
    
  } catch (error) {
    console.error('ElevenLabs error:', error);
    // Fallback to Twilio voice
    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="Polly.Joanna">${greeting}</Say>
</Response>`;
    res.type('text/xml');
    res.send(twiml);
  }
});
// ===== WEBSOCKET SERVER =====
const wss = new WebSocket.Server({ noServer: true });

wss.on('connection', (ws, req) => {
  const tenantId = req.url.split('/').pop();
  const config = loadTenantConfig(tenantId);
  
  if (!config) {
    ws.close();
    return;
  }
  
  console.log(`🎙️ Media stream connected for ${config.salon_info.salon_name}`);
  
  let streamSid = null;
  let callSid = null;
  let conversationHistory = [];
  let userPhoneNumber = null;
  
  ws.on('message', async (message) => {
    try {
      const msg = JSON.parse(message);
      
      if (msg.event === 'start') {
        streamSid = msg.start.streamSid;
        callSid = msg.start.callSid;
        userPhoneNumber = msg.start.customParameters?.From || null;
        console.log(`📞 Call started: ${callSid}`);
        
        // Send greeting
        await speakText(config.voice_config.greeting_tts, ws, config);
      }
      
      if (msg.event === 'media') {
        // Handle incoming audio - process with speech-to-text
        // Then generate response with GPT-4
        // Then convert to speech with ElevenLabs
        // Implementation depends on your STT provider
      }
      
      if (msg.event === 'stop') {
        console.log(`📴 Call ended: ${callSid}`);
      }
      
    } catch (error) {
      console.error('Error processing message:', error);
    }
  });
  
  async function speakText(text, ws, config) {
    try {
      const voiceConfig = getElevenLabsVoiceConfig(config);
      
      const response = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${voiceConfig.voiceId}/stream`,
        {
          method: 'POST',
          headers: {
            'Accept': 'audio/mpeg',
            'xi-api-key': ELEVENLABS_API_KEY,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            text: text,
            model_id: voiceConfig.model,
            voice_settings: {
              stability: voiceConfig.stability,
              similarity_boost: voiceConfig.similarityBoost
            }
          })
        }
      );
      
      if (!response.ok) throw new Error('ElevenLabs API error');
      
      const audioBuffer = await response.arrayBuffer();
      const base64Audio = Buffer.from(audioBuffer).toString('base64');
      
      ws.send(JSON.stringify({
        event: 'media',
        streamSid: streamSid,
        media: {
          payload: base64Audio
        }
      }));
      
    } catch (error) {
      console.error('Error in speakText:', error);
    }
  }
  
  // ===== INTENT DETECTION & RESPONSE =====
  async function generateResponse(userMessage, config) {
    const message = userMessage.toLowerCase();
    
    // PRIORITY 1: HOURS INQUIRY
    if (message.includes('hour') || message.includes('open') || message.includes('close')) {
      return `We're open ${config.hours.schedule}. We're closed on ${config.hours.closed_days.join(' and ')}. What service are you interested in?`;
    }
    
    // PRIORITY 2: APPOINTMENT REQUEST
    if (message.includes('appointment') || message.includes('book') || message.includes('schedule')) {
      if (config.booking.requires_consultation) {
        return `We recommend starting with a consultation. I can text you the booking link for a ${config.booking.consultation_fee} dollar consultation that goes toward your service.`;
      } else {
        return `I'd be happy to help you book an appointment. I'm texting you our booking link now where you can see available times.`;
      }
    }
    
    // PRIORITY 3: PRICING INQUIRY
    if (message.includes('price') || message.includes('cost') || message.includes('how much')) {
      switch(config.pricing.type) {
        case 'flat_rate':
          return `Our pricing is: ${config.pricing.details}. Would you like to book an appointment?`;
        case 'hourly':
          return `We charge ${config.pricing.details}. Would you like to book a consultation to discuss your specific needs?`;
        case 'consultation':
          return `We provide pricing during our consultation. The consultation fee is ${config.booking.consultation_fee} dollars and goes toward your service.`;
        default:
          return `For pricing information, please visit our booking page where you can see service details.`;
      }
    }
    
    // PRIORITY 4: LOCATION/DIRECTIONS
    if (message.includes('location') || message.includes('address') || message.includes('where')) {
      let response = `We're located at ${config.salon_info.location.address}.`;
      if (config.salon_info.location.parking_info) {
        response += ` ${config.salon_info.location.parking_info}.`;
      }
      if (config.salon_info.location.directions_url) {
        response += ` I can text you directions if needed.`;
      }
      return response;
    }
    
    // PRIORITY 5: SERVICES INQUIRY
    if (message.includes('service') || message.includes('what do you do') || message.includes('what do you offer')) {
      return `We specialize in ${config.services.primary.join(', ')}. ${config.services.specialties.length > 0 ? 'Our specialties include ' + config.services.specialties.join(', ') + '.' : ''} What service are you interested in?`;
    }
    
    // PRIORITY 6: LOCTICIAN EXPERIENCE
    if (message.includes(config.salon_info.loctician_name.toLowerCase()) || message.includes('experience') || message.includes('how long')) {
      return `${config.salon_info.loctician_name} has ${config.salon_info.experience_years} years of experience in loc care and maintenance. Would you like to book an appointment?`;
    }
    
    // PRIORITY 7: INSTAGRAM
    if (message.includes('instagram') || message.includes('social media') || message.includes('pictures')) {
      return `You can find us on Instagram at ${config.contact.instagram_handle}. I can text you the link if you'd like to see our work.`;
    }
    
    // PRIORITY 8: WEBSITE
    if (message.includes('website') || message.includes('online')) {
      return `Our website is ${config.contact.website}. I'm texting you the link now.`;
    }
    
    // PRIORITY 9: RUNNING LATE
    if (message.includes('late') || message.includes('running behind')) {
      return `Thanks for letting us know! ${config.salon_info.loctician_name} has been informed you're running a bit behind.`;
    }
    
    // DEFAULT: LOC CARE KNOWLEDGE
    return `I can help you with information about loc care, booking appointments, pricing, or our services. What would you like to know?`;
  }
});

// ===== SMS ENDPOINT =====
app.post('/sms/:tenantId', async (req, res) => {
  const { tenantId } = req.params;
  const config = loadTenantConfig(tenantId);
  
  if (!config) {
    return res.status(404).send('Tenant not found');
  }
  
  const { Body, From } = req.body;
  console.log(`💬 SMS from ${From}: ${Body}`);
  
  // Simple SMS auto-responder
  let response = '';
  const message = Body.toLowerCase();
  
  if (message.includes('hour')) {
    response = `We're open ${config.hours.schedule}. Text BOOK to get our appointment link!`;
  } else if (message.includes('book') || message.includes('appointment')) {
    response = `Book your appointment here: ${config.booking.main_booking_url}`;
  } else if (message.includes('price')) {
    response = `For pricing info, visit: ${config.booking.main_booking_url}`;
  } else {
    response = `Thanks for texting ${config.salon_info.salon_name}! Reply HOURS, BOOK, or PRICE for quick info, or call us at ${config.contact.phone}.`;
  }
  
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Message>${response}</Message>
</Response>`;
  
  res.type('text/xml');
  res.send(twiml);
});

// ===== SERVER SETUP =====
const PORT = process.env.PORT || 3000;

const server = app.listen(PORT, () => {
  console.log(`🚀 LocSync Voice Bot running on port ${PORT}`);
});

server.on('upgrade', (request, socket, head) => {
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request);
  });
});

module.exports = app;
