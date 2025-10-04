// server.js
import express from "express";
import OpenAI from "openai";
import twilio from "twilio";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import http from "http";
import { WebSocketServer } from "ws";
import { TextToSpeechClient } from "@google-cloud/text-to-speech";

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

/* ========= ENV + CLIENTS ========= */
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_NUMBER =
  process.env.TWILIO_FROM_NUMBER || process.env.TWILIO_PHONE_NUMBER;
const CALL_ME_SECRET = process.env.CALL_ME_SECRET || "changeme";

// Render public URL, e.g. https://elderme-server.onrender.com
const PUBLIC_URL = process.env.PUBLIC_URL || "https://elderme-server.onrender.com";
// If not provided, derive wss:// from PUBLIC_URL
const PUBLIC_WS = process.env.PUBLIC_WS || PUBLIC_URL.replace(/^http(s?):\/\//, "wss://");

// Google TTS voice (male)
const GOOGLE_TTS_VOICE = process.env.GOOGLE_TTS_VOICE || "en-US-Wavenet-D";

// Basic checks
if (!OPENAI_API_KEY) console.warn("⚠️ OPENAI_API_KEY is not set");
if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN)
  console.warn("⚠️ Twilio SID/TOKEN not set");
if (!TWILIO_NUMBER)
  console.warn("⚠️ TWILIO_FROM_NUMBER / TWILIO_PHONE_NUMBER not set");

// Resolve __dirname for ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// If GOOGLE_TTS_KEY is provided (full JSON), write to temp file for auth
let googleTtsReady = false;
try {
  if (process.env.GOOGLE_TTS_KEY) {
    const keyPath = path.join(__dirname, "google-tts.json");
    fs.writeFileSync(keyPath, process.env.GOOGLE_TTS_KEY);
    process.env.GOOGLE_APPLICATION_CREDENTIALS = keyPath;
    googleTtsReady = true;
  } else {
    console.warn("⚠️ GOOGLE_TTS_KEY not set; speak-on-start will be skipped.");
  }
} catch (e) {
  console.warn("⚠️ Failed to write GOOGLE_TTS_KEY file:", e);
}

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const googleTTS = new TextToSpeechClient();

/* ========= STATIC AUDIO (optional) ========= */
const AUDIO_DIR = path.join(__dirname, "audio");
if (!fs.existsSync(AUDIO_DIR)) fs.mkdirSync(AUDIO_DIR);
app.use("/audio", express.static(AUDIO_DIR));

/* ========= HELPERS ========= */
function toE164(num) {
  const s = String(num || "").replace(/[^\d+]/g, "");
  return s.startsWith("+") ? s : `+${s}`;
}

// --- μ-law utils ---
function pcm16ToMulawSample(sample) {
  const BIAS = 0x84;
  let sign = (sample >> 8) & 0x80;
  if (sign !== 0) sample = -sample;
  if (sample > 32635) sample = 32635;
  sample = sample + BIAS;

  let exponent = 7;
  for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; exponent--, expMask >>= 1) {}
  const mantissa = (sample >> ((exponent === 0) ? 4 : (exponent + 3))) & 0x0F;
  let ulaw = ~(sign | (exponent << 4) | mantissa);
  return ulaw & 0xff;
}

function encodePcm16ToMulaw(pcm16Buf) {
  const samples = pcm16Buf.length / 2;
  const out = Buffer.alloc(samples);
  for (let i = 0; i < samples; i++) {
    const sample = pcm16Buf.readInt16LE(i * 2);
    out[i] = pcm16ToMulawSample(sample);
  }
  return out;
}

// Send μ-law audio as 20ms frames (8kHz → 160 samples/frame)
async function sendMulawStream(ws, streamSid, mulawBuf) {
  const BYTES_PER_FRAME = 160; // 20ms at 8kHz, 1 byte/sample
  for (let offset = 0; offset < mulawBuf.length; offset += BYTES_PER_FRAME) {
    const frame = mulawBuf.subarray(offset, Math.min(offset + BYTES_PER_FRAME, mulawBuf.length));
    if (ws.readyState !== 1) break; // 1 = OPEN
    ws.send(
      JSON.stringify({
        event: "media",
        streamSid,
        media: { payload: frame.toString("base64") },
      })
    );
    await new Promise((r) => setTimeout(r, 20)); // pace frames
  }
}

// Google TTS → PCM16 (8kHz mono)
async function synthesizePcm16_8k(text, voiceName = GOOGLE_TTS_VOICE) {
  if (!googleTtsReady) throw new Error("Google TTS not configured");
  const [resp] = await googleTTS.synthesizeSpeech({
    input: { text },
    voice: {
      languageCode: voiceName.slice(0, 5),
      name: voiceName,
      ssmlGender: "MALE",
    },
    audioConfig: {
      audioEncoding: "LINEAR16",
      sampleRateHertz: 8000,
    },
  });
  return Buffer.from(resp.audioContent); // PCM16 LE @ 8kHz, mono
}

/* ========= HEALTH ========= */
app.get("/", (_req, res) => res.send("ElderMe server ✅ (Media Streams enabled)"));

/* ========= INBOUND CALL (Media Streams) ========= */
app.post("/voice", async (req, res) => {
  const vr = new twilio.twiml.VoiceResponse();

  // Tiny greeting so caller knows they’re connected (keep it short)
  vr.say({ voice: "Polly.Matthew", language: "en-US" }, "Hey, what's hope. Um hope you're goood, it's ElderMe. I wanted to give you a quick, um, call to check in. How are you?");

  // Start bidirectional media stream to our WebSocket
  const connect = vr.connect();
  connect.stream({
    url: `${PUBLIC_WS}/media`,
    parameter: [{ name: "callSid", value: req.body.CallSid || "" }],
  });

  res.type("text/xml").send(vr.toString());
});

/* ========= OUTBOUND CALL (unchanged; now points to /voice) ========= */
app.post("/call-me", async (req, res) => {
  try {
    if (CALL_ME_SECRET && req.body.secret !== CALL_ME_SECRET)
      return res.status(401).json({ error: "Unauthorized" });

    const to = toE164(req.body.to);
    if (!/^\+\d{10,15}$/.test(to))
      return res.status(400).json({ error: "Invalid phone number" });

    const call = await twilioClient.calls.create({
      to,
      from: TWILIO_NUMBER,
      url: `${PUBLIC_URL}/voice`,
      method: "POST",
    });

    res.json({ ok: true, sid: call.sid });
  } catch (e) {
    console.error("call-me error:", e);
    res.status(500).json({ error: "Failed to place call" });
  }
});

/* ========= WEBSOCKET: /media =========
   Receives {start}, {media}, {stop} events from Twilio.
   We also send audio back via 'media' events.
*/
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/media" });

// 🔧 Toggle: echo caller audio back (for testing)
const LOOPBACK_TEST = false;

wss.on("connection", (ws) => {
  let streamSid = null;
  let callSid = null;

  ws.on("message", async (msgBuf) => {
    try {
      const data = JSON.parse(msgBuf.toString());

      if (data.event === "start") {
        streamSid = data.start.streamSid;
        const params = (data.start.customParameters || []).reduce((acc, p) => {
          acc[p.name] = p.value;
          return acc;
        }, {});
        callSid = params.callSid || null;
        console.log("📞 Stream started:", { streamSid, callSid });

        // Speak a quick line over the stream so the caller hears something
        try {
          const pcm16 = await synthesizePcm16_8k(
            "I'm here and listening. Tell me about your day."
          );
          const mulaw = encodePcm16ToMulaw(pcm16);
          sendMulawStream(ws, streamSid, mulaw);
        } catch (e) {
          console.warn("TTS speak-on-start skipped:", e.message);
        }
      }

      else if (data.event === "media") {
        const base64PCMU = data.media.payload;

        // Optional echo test
        if (LOOPBACK_TEST && streamSid && ws.readyState === 1) {
          ws.send(
            JSON.stringify({
              event: "media",
              streamSid,
              media: { payload: base64PCMU },
            })
          );
        }

        // TODO:
        // 1) decode μ-law → PCM16
        // 2) feed PCM to OpenAI Realtime STT/LLM
        // 3) take reply PCM16, μ-law encode, send back via sendMulawStream(...)
      }

      else if (data.event === "stop") {
        console.log("🛑 Stream stopped:", { streamSid, callSid });
        streamSid = null;
      }
    } catch (err) {
      console.error("WS parse error:", err);
    }
  });

  ws.on("close", () => {
    console.log("WS closed", { streamSid, callSid });
  });
});

/* ========= START SERVER ========= */
const port = process.env.PORT || 3000;
server.listen(port, () =>
  console.log(`Listening on ${port} • WS ${PUBLIC_WS}/media`)
);
