// server.js
import express from "express";
import OpenAI from "openai";
import twilio from "twilio";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import http from "http";
import { WebSocketServer } from "ws";
import fetch from "node-fetch";

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

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID;

const PUBLIC_URL =
  process.env.PUBLIC_URL || "https://elderme-server.onrender.com";
const PUBLIC_WS =
  process.env.PUBLIC_WS || PUBLIC_URL.replace(/^http(s?):\/\//, "wss://");

// sanity logs
if (!OPENAI_API_KEY) console.warn("⚠️ OPENAI_API_KEY not set");
if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN)
  console.warn("⚠️ TWILIO SID/TOKEN not set");
if (!TWILIO_NUMBER) console.warn("⚠️ TWILIO_PHONE_NUMBER not set");
if (!ELEVENLABS_API_KEY) console.warn("⚠️ ELEVENLABS_API_KEY not set");
if (!ELEVENLABS_VOICE_ID) console.warn("⚠️ ELEVENLABS_VOICE_ID not set");

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

/* ========= STATIC ========= */
const AUDIO_DIR = path.join(__dirname, "audio");
if (!fs.existsSync(AUDIO_DIR)) fs.mkdirSync(AUDIO_DIR);
app.use("/audio", express.static(AUDIO_DIR));

/* ========= HELPERS ========= */
function toE164(num) {
  const s = String(num || "").replace(/[^\d+]/g, "");
  return s.startsWith("+") ? s : `+${s}`;
}

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

async function sendMulawStream(ws, streamSid, mulawBuf) {
  const BYTES_PER_FRAME = 160; // 20ms at 8kHz μ-law
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

function pcm16ToWav8kMono(pcm) {
  const sampleRate = 8000;
  const byteRate = sampleRate * 2;
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
  buf.writeUInt32LE(8000, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(bitsPerSample, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataSize, 40);
  pcm.copy(buf, 44);
  return buf;
}

/* ========= ElevenLabs ========= */
app.get("/tts", async (req, res) => {
  try {
    const text = req.query.text || "Hello, this is ElderMe with ElevenLabs.";
    const r = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}/stream`,
      {
        method: "POST",
        headers: {
          "xi-api-key": ELEVENLABS_API_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          text,
          model_id: "eleven_multilingual_v2",
          output_format: "mp3_22050",
          voice_settings: { stability: 0.35, similarity_boost: 0.7 },
        }),
      }
    );
    if (!r.ok) {
      const msg = await r.text();
      return res.status(500).send(`ElevenLabs error: ${msg}`);
    }
    res.setHeader("Content-Type", "audio/mpeg");
    r.body.pipe(res);
  } catch (e) {
    res.status(500).send(`TTS failed: ${e.message}`);
  }
});

async function synthesizeMulaw8k(text) {
  const r = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}/stream`,
    {
      method: "POST",
      headers: {
        "xi-api-key": ELEVENLABS_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text,
        model_id: "eleven_multilingual_v2",
        output_format: "ulaw_8000",
        voice_settings: { stability: 0.35, similarity_boost: 0.7 },
      }),
    }
  );
  if (!r.ok) {
    const msg = await r.text();
    throw new Error(`ElevenLabs error: ${msg}`);
  }
  const chunks = [];
  for await (const chunk of r.body) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/* ========= OpenAI ========= */
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
    "Life is good—how are you feeling right now?"
  );
}

/* ========= HEALTH ========= */
app.get("/", (_req, res) =>
  res.send("ElderMe ✅ Twilio Media Streams + ElevenLabs TTS + Conversational loop")
);

/* ========= INBOUND CALL (fixed Parameter) ========= */
app.all("/voice", (req, res) => {
  console.log("✓ /voice hit. CallSid:", req.body.CallSid, "From:", req.body.From);
  const vr = new twilio.twiml.VoiceResponse();

  const connect = vr.connect();
  const stream = connect.stream({ url: `${PUBLIC_WS}/media` });

  // ✅ Correct way to add <Parameter> (avoid "[object Object]")
  stream.parameter({ name: "callSid", value: req.body.CallSid || "" });

  res.type("text/xml").send(vr.toString());
});

/* ========= OUTBOUND CALL (points to /voice) ========= */
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

/* ========= WEBSOCKET /media: full convo loop ========= */
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/media" });

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
    const seed = "Well, life's good. I just called to check in. What did you eat this morning?";
    await speakText(state, seed);
    state.context.push({ role: "assistant", content: seed });
  }, 3000);
}

async function speakText(state, text) {
  try {
    state.listening = false;
    const mulaw = await synthesizeMulaw8k(text);
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

  let text = "";
  try {
    text = await transcribeWhisper(pcm);
  } catch (e) {
    console.error("STT error:", e);
  }
  if (!text) return;

  state.context.push({ role: "user", content: text });

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

wss.on("connection", (ws) => {
  let streamSid = null;
  let callSid = null;
  let state = null;

  ws.on("message", async (buf) => {
    let data;
    try { data = JSON.parse(buf.toString()); } catch { return; }

    if (data.event === "start") {
      streamSid = data.start.streamSid;

      // ✅ FIX: Twilio sends customParameters as an object
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
