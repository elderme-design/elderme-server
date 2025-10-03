// server.js
import express from "express";
import OpenAI from "openai";
import twilio from "twilio";

// ⬇️ extra imports for Google TTS + file handling
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { TextToSpeechClient } from "@google-cloud/text-to-speech";

const app = express(); // required

// Twilio posts x-www-form-urlencoded; keep both parsers
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

/* ========= ENV + CLIENTS ========= */
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_NUMBER =
  process.env.TWILIO_FROM_NUMBER || process.env.TWILIO_PHONE_NUMBER;
const CALL_ME_SECRET = process.env.CALL_ME_SECRET || "changeme";

// Public base URL of THIS server (Render env var)
const PUBLIC_URL =
  process.env.PUBLIC_URL || "https://elderme-server.onrender.com";

// Default Google voice (change if you want)
const GOOGLE_TTS_VOICE = process.env.GOOGLE_TTS_VOICE || "en-US-Neural2-F";

// Basic checks
if (!OPENAI_API_KEY) console.warn("⚠️ OPENAI_API_KEY is not set");
if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN)
  console.warn("⚠️ Twilio SID/TOKEN not set");
if (!TWILIO_NUMBER)
  console.warn("⚠️ TWILIO_FROM_NUMBER / TWILIO_PHONE_NUMBER not set");

// ⬇️ Google TTS key comes from Render env GOOGLE_TTS_KEY (full JSON)
if (!process.env.GOOGLE_TTS_KEY) {
  console.error("⚠️ GOOGLE_TTS_KEY not set in environment");
} else {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const keyPath = path.join(__dirname, "google-tts.json");
  fs.writeFileSync(keyPath, process.env.GOOGLE_TTS_KEY);
  process.env.GOOGLE_APPLICATION_CREDENTIALS = keyPath;
}

// Clients
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const googleTTS = new TextToSpeechClient();

/* ========= HELPERS ========= */
function toE164(num) {
  const s = String(num || "").replace(/[^\d+]/g, "");
  return s.startsWith("+") ? s : `+${s}`;
}

// where to drop audio files
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const AUDIO_DIR = path.join(__dirname, "audio");
if (!fs.existsSync(AUDIO_DIR)) fs.mkdirSync(AUDIO_DIR);
// serve them so Twilio can fetch
app.use("/audio", express.static(AUDIO_DIR));

async function synthesizeToUrl(text, voiceName = GOOGLE_TTS_VOICE) {
  const [resp] = await googleTTS.synthesizeSpeech({
    input: { text },
    voice: { languageCode: voiceName.slice(0, 5), name: voiceName },
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
app.get("/", (_req, res) => res.send("ElderMe server up ✅"));

/* ========= INBOUND CALL: Twilio -> (your webhook) -> OpenAI -> Google TTS ========= */

// 1) Twilio hits this when the call arrives. We prompt & start speech recognition.
app.post("/twilio-voice", async (req, res) => {
  const vr = new twilio.twiml.VoiceResponse();

  const gather = vr.gather({
    input: "speech",
    language: "en-US",
    speechTimeout: "auto",
    action: "/twilio-gather", // Twilio will POST transcript here
    method: "POST",
  });

  // New greeting script (Google voice)
  const greeting =
    "Hey what's up, it's ElderMe, hope you're good today. Just calling to catch up, got time to chat for a bit?";

  try {
    const url = await synthesizeToUrl(greeting);
    gather.play(url);
  } catch (e) {
    console.error("Google TTS greeting failed, fallback to Twilio <Say>:", e);
    gather.say({ voice: "Polly.Joanna", language: "en-US" }, greeting);
  }

  // If nothing was said, ask again
  vr.redirect("/twilio-voice");

  res.type("text/xml").send(vr.toString());
});

// 2) Twilio posts the transcript here. We call OpenAI and speak the reply, then loop.
app.post("/twilio-gather", async (req, res) => {
  const vr = new twilio.twiml.VoiceResponse();

  try {
    const userText = (req.body.SpeechResult || "").trim();

    if (!userText) {
      const url = await synthesizeToUrl(
        "Sorry, I didn’t catch that. Please say something."
      );
      vr.play(url);
      vr.redirect("/twilio-voice");
      return res.type("text/xml").send(vr.toString());
    }

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
            "You are ElderMe, a warm, concise phone companion. Speak naturally and keep replies under about 20 seconds.",
        },
        { role: "user", content: userText },
      ],
      max_tokens: 150,
      temperature: 0.7,
    });

    const reply =
      completion.choices?.[0]?.message?.content?.trim() ||
      "I’m here with you. Tell me more.";

    // Speak reply with Google TTS
    const replyUrl = await synthesizeToUrl(reply);
    vr.play(replyUrl);

    // Offer another turn (keeps the conversation going)
    const again = vr.gather({
      input: "speech",
      language: "en-US",
      speechTimeout: "auto",
      action: "/twilio-gather",
      method: "POST",
    });
    // Keep this short; using Twilio here avoids another TTS call. Swap to Google if you prefer.
    again.say("You can keep talking if you’d like.");

    res.type("text/xml").send(vr.toString());
  } catch (e) {
    console.error("OpenAI/Google TTS error:", e);
    try {
      const url = await synthesizeToUrl(
        "Sorry, something went wrong on my end. Let's try again later."
      );
      vr.play(url);
    } catch {
      vr.say("Sorry, something went wrong on my end. Let's try again later.");
    }
    vr.hangup();
    res.type("text/xml").send(vr.toString());
  }
});

/* ========= OUTBOUND CALL: trigger a call to your phone and enter the AI flow =========
   POST /call-me  { "to": "+1YOURCELLPHONE", "secret": "YOUR_SECRET" }
*/
app.post("/call-me", async (req, res) => {
  try {
    if (CALL_ME_SECRET && req.body.secret !== CALL_ME_SECRET) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    if (!TWILIO_NUMBER) {
      return res
        .status(500)
        .json({ error: "Missing TWILIO_PHONE_NUMBER / TWILIO_FROM_NUMBER" });
    }

    const to = toE164(req.body.to);
    if (!/^\+\d{10,15}$/.test(to)) {
      return res.status(400).json({ error: "Invalid phone number" });
    }

    // When you answer, Twilio requests /twilio-voice, which starts the OpenAI loop
    const call = await twilioClient.calls.create({
      to,
      from: TWILIO_NUMBER,
      url: `${PUBLIC_URL}/twilio-voice`,
      method: "POST",
    });

    res.json({ ok: true, sid: call.sid });
  } catch (e) {
    console.error("call-me error:", e);
    res.status(500).json({ error: "Failed to place call" });
  }
});

/* ========= START SERVER ========= */
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Listening on ${port}`));
