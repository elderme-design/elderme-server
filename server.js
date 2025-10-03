// server.js
import express from "express";
import OpenAI from "openai";
import twilio from "twilio";

// ⬇️ extra imports for Google TTS + file handling (kept for optional use)
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { TextToSpeechClient } from "@google-cloud/text-to-speech";

// ⬇️ NEW: http server + WebSocket for Media Streams
import http from "http";
import { WebSocketServer } from "ws";

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

// Public base URL (Render env) — must be your public https URL
const PUBLIC_URL = process.env.PUBLIC_URL || "https://elderme-server.onrender.com";

// ✅ If you prefer, set PUBLIC_WS explicitly. Otherwise we derive it from PUBLIC_URL.
const PUBLIC_WS =
  process.env.PUBLIC_WS || PUBLIC_URL.replace(/^http(s?):\/\//, "wss://");

// ✅ Change this voice to male (Google Wavenet-D)
const GOOGLE_TTS_VOICE = process.env.GOOGLE_TTS_VOICE || "en-US-Wavenet-D";

// Basic checks
if (!OPENAI_API_KEY) console.warn("⚠️ OPENAI_API_KEY is not set");
if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN)
  console.warn("⚠️ Twilio SID/TOKEN not set");
if (!TWILIO_NUMBER)
  console.warn("⚠️ TWILIO_FROM_NUMBER / TWILIO_PHONE_NUMBER not set");

// ⬇️ Google TTS key comes from Render env GOOGLE_TTS_KEY (full JSON)
if (!process.env.GOOGLE_TTS_KEY) {
  console.error("⚠️ GOOGLE_TTS_KEY not set in environment");
}

// Clients
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const googleTTS = new TextToSpeechClient();

// where to drop audio files (for optional <Play> usage)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const AUDIO_DIR = path.join(__dirname, "audio");
if (!fs.existsSync(AUDIO_DIR)) fs.mkdirSync(AUDIO_DIR);
app.use("/audio", express.static(AUDIO_DIR));

/* ========= HELPERS ========= */
function toE164(num) {
  const s = String(num || "").replace(/[^\d+]/g, "");
  return s.startsWith("+") ? s : `+${s}`;
}

async function synthesizeToUrl(text, voiceName = GOOGLE_TTS_VOICE) {
  // Optional helper: still available if you want a pre-stream greeting via <Play>
  const [resp] = await googleTTS.synthesizeSpeech({
    input: { text },
    voice: {
      languageCode: voiceName.slice(0, 5),
      name: voiceName,
      ssmlGender: "MALE",
    },
    audioConfig: { audioEncoding: "MP3" },
  });
  const filename = `tts_${Date.now()}_${Math.random()
    .toString(36)
    .slice(2)}.mp3`;
  const filepath = path.join(AUDIO_DIR, filename);
  fs.writeFileSync(filepath, resp.audioContent, "binary");
  return `${PUBLIC_URL}/audio/${filename}`;
}

/* ========= HEALTH ========= */
app.get("/", (_req, res) => res.send("ElderMe server up ✅ (Media Streams)"));

/* ========= INBOUND CALL (Media Streams) =========
   This returns TwiML that:
   (1) Optionally says a very short greeting
   (2) Starts a bidirectional media stream to wss://.../media
*/
app.post("/voice", async (req, res) => {
  const vr = new twilio.twiml.VoiceResponse();

  // Optional: quick greeting BEFORE we connect the live stream.
  // Keep it <2s so the stream starts fast. Comment out if you want instant stream.
  vr.say({ voice: "Polly.Matthew", language: "en-US" }, "Hi, it's ElderMe.");
  // Alternatively, use your Google TTS file:
  // const url = await synthesizeToUrl("Hi, it's ElderMe.");
  // vr.play(url);

  // ⬇️ Start the live audio stream to your WebSocket endpoint
  const connect = vr.connect();
  connect.stream({
    url: `${PUBLIC_WS}/media`,
    // Optional params you can read on 'start' event:
    parameter: [{ name: "callSid", value: req.body.CallSid || "" }],
  });

  res.type("text/xml").send(vr.toString());
});

/* ========= OUTBOUND CALL (kept) =========
   This now points to /voice (the Media Streams route), not /twilio-voice.
*/
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

/* ========= WEB SOCKET: /media =========
   Twilio connects here and sends JSON messages:
   - {event:"start", start:{streamSid,...}}
   - {event:"media", media:{payload: base64(PCMU 8k)}}
   - {event:"stop", ...}

   If you want full duplex (bot talks back), send:
   ws.send(JSON.stringify({
     event: "media",
     streamSid,
     media: { payload: base64PCMU_8k }
   }));
*/
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/media" });

// 🔧 Toggle: simple loopback test (echo caller audio back to them). Beware of echo.
// Set to true for a quick “it works” test. Set false when wiring OpenAI.
const LOOPBACK_TEST = false;

wss.on("connection", (ws, req) => {
  let streamSid = null;
  let callSid = null;

  ws.on("message", async (msgBuf) => {
    try {
      const data = JSON.parse(msgBuf.toString());

      switch (data.event) {
        case "start":
          streamSid = data.start.streamSid;
          // If you passed parameters in <Connect><Stream>, they show here:
          const params = (data.start.customParameters || []).reduce((acc, p) => {
            acc[p.name] = p.value;
            return acc;
          }, {});
          callSid = params.callSid || null;
          console.log("📞 Stream started:", { streamSid, callSid });
          break;

        case "media": {
          // Inbound media from the caller (μ-law 8kHz as base64)
          const base64PCMU = data.media.payload;

          // TODO: decode PCMU → PCM16 → send into your STT/LLM (OpenAI Realtime, etc.)
          // TODO: take bot's PCM16 output → encode to PCMU 8kHz → send back as below.

          if (LOOPBACK_TEST && streamSid) {
            // ⚠️ This will echo the caller's voice back (proof WS send works).
            ws.send(
              JSON.stringify({
                event: "media",
                streamSid,
                media: { payload: base64PCMU },
              })
            );
          }
          break;
        }

        case "stop":
          console.log("🛑 Stream stopped:", { streamSid, callSid });
          streamSid = null;
          break;

        default:
          // ignore
          break;
      }
    } catch (err) {
      console.error("WS message parse error:", err);
    }
  });

  ws.on("close", () => {
    console.log("WS closed", { streamSid, callSid });
  });
});

/* ========= START SERVER ========= */
const port = process.env.PORT || 3000;
server.listen(port, () => console.log(`Listening on ${port} (WS ready at ${PUBLIC_WS}/media)`));

/* ========= NOTES =========
1) Twilio Console → Phone Number → Voice → A Call Comes In:
   POST  https://YOUR-RENDER-APP/voice

2) Ensure PUBLIC_URL is set in Render to your exact https base, e.g.:
   PUBLIC_URL = https://elderme-server.onrender.com
   (Optional) PUBLIC_WS if your WS host differs; otherwise we derive from PUBLIC_URL.

3) For full duplex with a talking bot:
   - Decode μ-law 8k to PCM16 (8k), stream into OpenAI Realtime/STT.
   - Get PCM16 output back, downsample to 8k if needed, encode μ-law,
     base64 it, and send as the 'media' event shown above.
   - Keep total buffering small (20–40ms frames) to avoid lag.

4) You can delete the old /twilio-voice and /twilio-gather routes.
   This file replaces them with /voice (Media Streams).
*/
