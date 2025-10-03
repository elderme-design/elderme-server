// server.js
import express from "express";
import OpenAI from "openai";
import twilio from "twilio";

const app = express(); // required

// Twilio posts x-www-form-urlencoded; keep both parsers
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

/* ========= ENV + CLIENTS ========= */
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_NUMBER = process.env.TWILIO_FROM_NUMBER || process.env.TWILIO_PHONE_NUMBER;
const CALL_ME_SECRET = process.env.CALL_ME_SECRET || "changeme";

if (!OPENAI_API_KEY) console.warn("⚠️ OPENAI_API_KEY is not set");
if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) console.warn("⚠️ Twilio SID/TOKEN not set");
if (!TWILIO_NUMBER) console.warn("⚠️ TWILIO_FROM_NUMBER / TWILIO_PHONE_NUMBER not set");

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

/* ========= HELPERS ========= */
function toE164(num) {
  const s = String(num || "").replace(/[^\d+]/g, "");
  return s.startsWith("+") ? s : `+${s}`;
}

/* ========= HEALTH ========= */
app.get("/", (_req, res) => res.send("ElderMe server up ✅"));

/* ========= INBOUND CALL: Twilio -> (your webhook) -> OpenAI -> speak back ========= */

// 1) Twilio hits this when the call arrives. We prompt & start speech recognition.
app.post("/twilio-voice", (req, res) => {
  const vr = new twilio.twiml.VoiceResponse();

  const gather = vr.gather({
    input: "speech",
    language: "en-US",
    speechTimeout: "auto",
    action: "/twilio-gather", // Twilio will POST transcript here
    method: "POST",
  });

  // First line the caller hears (short and friendly)
  gather.say(
    { voice: "Polly.Joanna", language: "en-US" },
    "Hi, I’m ElderMe. Tell me anything that’s on your mind, and I’ll talk with you."
  );

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
      vr.say("Sorry, I didn’t catch that. Please say something.");
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

    vr.say({ voice: "Polly.Joanna", language: "en-US" }, reply);

    // Offer another turn (keeps the conversation going)
    const again = vr.gather({
      input: "speech",
      language: "en-US",
      speechTimeout: "auto",
      action: "/twilio-gather",
      method: "POST",
    });
    again.say("You can keep talking if you’d like.");

    res.type("text/xml").send(vr.toString());
  } catch (e) {
    console.error("OpenAI/Twilio error:", e);
    vr.say("Sorry, something went wrong on my end. Let's try again later.");
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
      return res.status(500).json({ error: "Missing TWILIO_PHONE_NUMBER / TWILIO_FROM_NUMBER" });
    }

    const to = toE164(req.body.to);
    if (!/^\+\d{10,15}$/.test(to)) {
      return res.status(400).json({ error: "Invalid phone number" });
    }

    // When you answer, Twilio requests /twilio-voice, which starts the OpenAI loop
    const call = await twilioClient.calls.create({
      to,
      from: TWILIO_NUMBER,
      url: "https://elderme-server.onrender.com/twilio-voice",
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
