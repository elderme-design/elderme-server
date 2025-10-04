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
app.use(express.urlencoded({ extended: true })); // Twilio sends x-www-form-urlencoded
app.use(express.json());

/* ========= ENV + CLIENTS ========= */
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_NUMBER =
  process.env.TWILIO_FROM_NUMBER || process.env.TWILIO_PHONE_NUMBER;
const CALL_ME_SECRET = process.env.CALL_ME_SECRET || "changeme";

const PUBLIC_URL = process.env.PUBLIC_URL || "https://elderme-server.onrender.com";
const PUBLIC_WS = process.env.PUBLIC_WS || PUBLIC_URL.replace(/^http(s?):\/\//, "wss://");

// Google TTS voice (change if you like)
const GOOGLE_TTS_VOICE = process.env.GOOGLE_TTS_VOICE || "en-US-Wavenet-D";

// sanity logs
if (!OPENAI_API_KEY) console.warn("⚠️ OPENAI_API_KEY not set");
if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) console.warn("⚠️ TWILIO SID/TOKEN not set");
if (!TWILIO_NUMBER) console.warn("⚠️ TWILIO_PHONE_NUMBER not set");
if (!process.env.GOOGLE_TTS_KEY) console.warn("⚠️ GOOGLE_TTS_KEY not set — Google TTS will fail");

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

/* ========= STATIC ========= */
const AUDIO_DIR = path.join(__dirname, "audio");
if (!fs.existsSync(AUDIO_DIR)) fs.mkdirSync(AUDIO_DIR);
app.use("/audio", express.static(AUDIO_DIR));

/* ========= Google TTS setup ========= */
let googleReady = false;
try {
  if (process.env.GOOGLE_TTS_KEY) {
    const keyPath = path.join(__dirname, "google-tts.json");
    fs.writeFileSync(keyPath, process.env.GOOGLE_TTS_KEY);
    process.env.GOOGLE_APPLICATION_CREDENTIALS = keyPath;
    googleReady = true;
  }
} catch (e) {
  console.warn("⚠️ Failed to write GOOGLE_TTS_KEY file:", e);
}
const googleTTS = new TextToSpeechClient();

/* ========= HELPERS ========= */
function toE164(num) {
  const s = String(num || "").replace(/[^\d+]/g, "");
  return s.startsWith("+") ? s : `+${s}`;
}

// μ-law decode (G.711) -> PCM16 LE
function decodeMulawToPcm16(muBuf) {
  const out = Buffer.alloc(muBuf.length * 2);
  for (let i = 0; i < muBuf.length; i++) {
    let u = (~muBuf[i]) & 0xff;
    let t = ((u & 0x0f) << 3) + 0x84;
    t = t << ((u & 0x70) >> 4);
    let s = (u & 0x80) ? (0x84 - t) : (t - 0x84);
    out.writeInt16LE(s, i * 2);
  }
  return out;
}

// PCM16 LE -> μ-law byte
function pcm16ToMulawSample(sample) {
  const BIAS = 0x84;
  let sign = (sample >> 8) & 0x80;
  if (sign !== 0) sample = -sample;
  if (sample > 32635) sample = 32635;
  sample = sample + BIAS;
  let exponent = 7;
  for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; exponent--, expMask >>= 1) {}
  const mantissa = (sample >> ((exponent === 0) ? 4 : (exponent + 3))) & 0x0f;
  let ulaw = ~(sign | (exponent << 4) | mantissa);
  return ulaw & 0xff;
}

// PCM16 LE Buffer -> μ-law Buffer
function encodePcm16ToMulaw(pcm16Buf) {
  const samples = pcm16Buf.length / 2;
  const out = Buffer.alloc(samples);
  for (let i = 0; i < samples; i++) {
    const sample = pcm16Buf.readInt16LE(i * 2);
    out[i] = pcm16ToMulawSample(sample);
  }
  return out;
}

// Stream μ-law back to Twilio in 20ms frames (8kHz -> 160 bytes/frame)
async function sendMulawStream(ws, streamSid, mulawBuf) {
  const BYTES_PER_FRAME = 160;
  for (let off = 0; off < mulawBuf.length; off += BYTES_PER_FRAME) {
    if (ws.readyState !== 1) break;
    const frame = mulawBuf.subarray(off, Math.min(off + BYTES_PER_FRAME, mulawBuf.length));
    ws.send(JSON.stringify({
      event: "media",
      streamSid,
      media: { payload: frame.toString("base64") }
    }));
    await new Promise(r => setTimeout(r, 20));
  }
}

// Minimal WAV (8kHz mono, PCM16) — handy for temp files / /tts
function pcm16ToWav8kMono(pcm) {
  const sampleRate = 8000;
  const byteRate = sampleRate * 2; // 16-bit mono
  const blockAlign = 2;
  const bitsPerSample = 16;
  const dataSize = pcm.length;
  const riffSize = 36 + dataSize;

  const buf = Buffer.alloc(44 + dataSize);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(riffSize, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(bitsPerSample, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataSize, 40);
  pcm.copy(buf, 44);
  return buf;
}

/* ========= Google TTS (8kHz PCM16) ========= */
async function synthesizePcm16_8k(text) {
  if (!googleReady) throw new Error("Google TTS not configured (GOOGLE_TTS_KEY)");
  const [resp] = await googleTTS.synthesizeSpeech({
    input: { text },
    voice: {
      languageCode: GOOGLE_TTS_VOICE.slice(0, 5), // e.g., en-US
      name: GOOGLE_TTS_VOICE,
      ssmlGender: "NEUTRAL",
    },
    audioConfig: { audioEncoding: "LINEAR16", sampleRateHertz: 8000 },
  });
  return Buffer.from(resp.audioContent);
}

/* ========= /tts demo (returns WAV) ========= */
app.get("/tts", async (req, res) => {
  try {
    const text = req.query.text || "Hello, this is ElderMe using Google TTS.";
    const pcm = await synthesizePcm16_8k(text);
    const wav = pcm16ToWav8kMono(pcm);
    res.setHeader("Content-Type", "audio/wav");
    res.send(wav);
  } catch (e) {
    console.error("Google /tts error:", e);
    res.status(500).send(String(e));
  }
});

/* ========= OpenAI (Whisper) ========= */
async function transcribeWhisper(pcm16Buf) {
  const wav = pcm16ToWav8kMono(pcm16Buf);
  const tmp = path.join(AUDIO_DIR, `chunk_${Date.now()}.wav`);
  fs.writeFileSync(tmp, wav);
  try {
    const resp = await openai.audio.transcriptions.create({
      file: fs.createReadStream(tmp),
      model: "whisper-1",
    });
    return (resp.text || "").trim();
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

function buildSystemPrompt() {
  return `You are ElderMe — warm, breezy, and conversational.
Speak in short, natural sentences (8–14 words), with light humor and positivity.
Take initiative: if the user is quiet, offer a gentle, specific prompt.
Avoid corporate phrasing. Ask one question at a time. Keep replies under 12 seconds.`;
}

async function chatReply(contextMessages, userText) {
  const messages = [
    { role: "system", content: buildSystemPrompt() },
    ...contextMessages,
    { role: "user", content: userText },
  ];
  const r = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages,
    temperature: 0.7,
    max_tokens: 180,
  });
  return (
    (r.choices?.[0]?.message?.content || "").trim() ||
    "I’m here with you. Tell me more about that."
  );
}

/* ========= HEALTH ========= */
app.get("/", (_req, res) =>
  res.send("ElderMe ✅ Twilio Media Streams + Google TTS + Conversational loop")
);

/* ========= INBOUND CALL (Twilio Media Streams) ========= */
app.all("/voice", (req, res) => {
  console.log("✓ /voice hit. CallSid:", req.body.CallSid, "From:", req.body.From);
  const vr = new twilio.twiml.VoiceResponse();
  const connect = vr.connect();
  const stream = connect.stream({ url: `${PUBLIC_WS}/media` });
  // Pass CallSid properly
  stream.parameter({ name: "callSid", value: req.body.CallSid || "" });
  res.type("text/xml").send(vr.toString());
});

/* ========= OUTBOUND CALL (with StatusCallback) ========= */
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
      statusCallback: `${PUBLIC_URL}/twilio-status`,
      statusCallbackMethod: "POST",
      statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
      answerOnBridge: true,
    });

    res.json({ ok: true, sid: call.sid });
  } catch (e) {
    console.error("call-me error:", e);
    res.status(500).json({ error: "Failed to place call" });
  }
});

/* ========= Hangup helper ========= */
app.post("/hangup", async (req, res) => {
  try {
    const { callSid } = req.body || {};
    if (!callSid) return res.status(400).json({ error: "Missing callSid" });
    const updated = await twilioClient.calls(callSid).update({ status: "completed" });
    res.json({ ok: true, callSid: updated.sid, status: updated.status });
  } catch (e) {
    console.error("hangup error:", e);
    res.status(500).json({ error: "Failed to hang up" });
  }
});

/* ========= Twilio Status Callback (debug outbound results) ========= */
app.post("/twilio-status", (req, res) => {
  const {
    CallSid,
    CallStatus,
    To,
    From,
    SipResponseCode,
    ErrorCode,
    Timestamp,
    SequenceNumber,
    ApiVersion,
  } = req.body || {};
  console.log("Twilio status:", {
    CallSid,
    CallStatus,
    SipResponseCode,
    ErrorCode,
    To,
    From,
    Timestamp,
    SequenceNumber,
    ApiVersion,
  });
  res.sendStatus(204);
});

/* ========= WEBSOCKET /media ========= */
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/media" });

// Rotateable nudge lines — edit these to change the opening prompt.
const NUDGE_LINES = [
  "Hey Rashid, your daughter Cyma told me to call.",
  " Hey Rashid, your daughter Cyma told me to call . Do you still work with Haroon Shaikh?",
  " Hey Rashid, your daughter Cyma told me to call . What’s on your mind right now?",
];

function makeState(ws, streamSid, callSid) {
  return {
    ws, streamSid, callSid,
    listening: true,
    heardAnySpeech: false,
    pcmBuffer: [],
    silenceFrames: 0,
    context: [],
    nudgeTimer: null,
  };
}

function scheduleNudge(state) {
  if (state.nudgeTimer) clearTimeout(state.nudgeTimer);
  state.nudgeTimer = setTimeout(async () => {
    if (!state || !state.listening) return;
    const seed = NUDGE_LINES[Math.floor(Math.random() * NUDGE_LINES.length)];
    await speakText(state, seed);
    state.context.push({ role: "assistant", content: seed });
  }, 3000);
}

async function speakText(state, text) {
  try {
    state.listening = false;
    const pcm = await synthesizePcm16_8k(text);    // Google TTS PCM16 (8k)
    const mulaw = encodePcm16ToMulaw(pcm);         // Convert to μ-law for Twilio
    await sendMulawStream(state.ws, state.streamSid, mulaw);
  } catch (e) {
    console.warn("TTS/speak error:", e.stack || e.message);
  } finally {
    state.listening = true;
    scheduleNudge(state);
  }
}

async function finalizeTurn(state) {
  if (state.pcmBuffer.length === 0) return;

  const pcm = Buffer.concat(state.pcmBuffer);
  state.pcmBuffer = [];
  state.silenceFrames = 0;

  // STT
  let text = "";
  try {
    text = await transcribeWhisper(pcm);
  } catch (e) {
    console.error("STT error:", e);
  }
  if (!text) return;

  state.context.push({ role: "user", content: text });

  // LLM reply
  let reply = "";
  try {
    reply = await chatReply(state.context, text);
  } catch (e) {
    console.error("Chat error:", e);
    reply = "I’m here with you. Tell me more about that.";
  }
  state.context.push({ role: "assistant", content: reply });

  await speakText(state, reply);
}

wss.on("connection", (ws, req) => {
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
  console.log("WS connection from", ip);

  ws.on("error", (e) => console.error("WS client error:", e));

  // keepalive (optional)
  const ka = setInterval(() => {
    if (ws.readyState === 1) ws.ping();
  }, 15000);
  ws.on("close", () => clearInterval(ka));

  let streamSid = null;
  let callSid = null;
  let state = null;

  ws.on("message", async (buf) => {
    let data;
    try { data = JSON.parse(buf.toString()); } catch { return; }

    if (data.event === "start") {
      streamSid = data.start.streamSid;
      const params =
        (data.start && typeof data.start.customParameters === "object" && data.start.customParameters)
          ? data.start.customParameters
          : {};
      callSid = params.callSid || null;

      state = makeState(ws, streamSid, callSid);
      console.log("📞 Stream started:", { streamSid, callSid });
      scheduleNudge(state);
    }

    else if (data.event === "media") {
      if (!state) return;
      const mu = Buffer.from(data.media.payload, "base64");
      if (!state.listening) return;

      // decode incoming μ-law to PCM16 for VAD + STT buffer
      const pcm = decodeMulawToPcm16(mu);
      state.pcmBuffer.push(pcm);

      // simple VAD: RMS on PCM16
      let rms = 0;
      for (let i = 0; i < pcm.length; i += 2) {
        const s = pcm.readInt16LE(i) / 32768;
        rms += s * s;
      }
      rms = Math.sqrt(rms / (pcm.length / 2));
      const SPEECH_THRESH = 0.015;
      const isSpeech = rms > SPEECH_THRESH;

      if (isSpeech) {
        state.heardAnySpeech = true;
        state.silenceFrames = 0;
        if (state.nudgeTimer) { clearTimeout(state.nudgeTimer); state.nudgeTimer = null; }
      } else {
        state.silenceFrames++;
        if (state.heardAnySpeech && state.silenceFrames >= 12) {
          state.heardAnySpeech = false;
          await finalizeTurn(state);
        }
      }
    }

    else if (data.event === "stop") {
      console.log("🛑 Stream stopped:", { streamSid, callSid });
      if (state?.nudgeTimer) clearTimeout(state.nudgeTimer);
      state = null;
    }
  });
});

/* ========= START SERVER ========= */
const port = process.env.PORT || 3000;
server.listen(port, () => {
  console.log(`Listening on ${port} • WS ${PUBLIC_WS}/media`);
});
