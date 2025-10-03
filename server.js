// server.js
import express from "express";
import OpenAI from "openai";
import twilio from "twilio";

const app = express(); // <-- don't remove this

// Twilio posts form-encoded; keep both parsers enabled
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

/* -------------------- ENV + CLIENTS -------------------- */
// OpenAI (key comes from Render env var)
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Twilio REST client for outbound calls (/call-me)
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// Optional simple auth to protect /call-me
const CALL_ME_SECRET = process.env.CALL_ME_SECRET || "changeme";

// Helper: ensure +E.164 phone format
function toE164(num) {
  const s = String(num || "").replace(/[^\d+]/g, "");
  return s.startsWith("+") ? s : `+${s}`;
}

/* -------------------- BASIC HEALTH -------------------- */
app.get("/", (_req, res) => res.send("ElderMe server up ✅"));

/* -------------------- TWILIO INBOUND (AI VOICE) -------------------- */
// 1) Answer the call → ask caller to speak
app.post("/twilio-voice", (req, res) => {
  const vr = new twilio.twiml.VoiceResponse();

  const gather = vr.gather({
    input: "speech",
    language: "en-US",
    speechTimeout: "auto",
    action: "/twilio-gather",
    method: "POST",
  });

  // First line the caller hears
  gather.say(
    { voice: "Polly.Joanna", language: "en-US" },
    "Hi, I’m ElderMe. Tell me anything that’s on your mind, and I’ll talk with you."
  );

  // If they say nothing, re-prompt
  vr.redirect("/twilio-voice");

  res.type("text/xml").send(vr.toString());
});

// 2) Take Twilio’s transcript → ask OpenAI → speak reply → loop
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
            "You are ElderMe, a warm, concise phone companion. Speak naturally; keep replies under about 20 seconds.",
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

    // Offer another turn
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

/* -------------------- OUTBOUND CALL: /call-me -------------------- */
// POST /call-me  { "to": "+1YOURNUMBER", "secret": "YOUR_SECRET" }
app.post("/call-me", async (req, res) => {
  try {
    if (CALL_ME_SECRET && req.body.secret !== CALL_ME_SECRET) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const to = toE164(req.body.to);
    if (!/^\+\d{10,15}$/.test(to)) {
      return res.status(400).json({ error: "Invalid phone number" });
    }

    const twimlUrl = "https://elderme-server.onrender.com/twilio-voice";

    const call = await twilioClient.calls.create({
      to,
      from: process.env.TWILIO_FROM_NUMBER, // your purchased Twilio number (+1XXXXXXXXXX)
      url: twimlUrl, // kicks off the AI voice flow when you answer
      method: "POST",
    });

    res.json({ ok: true, sid: call.sid });
  } catch (e) {
    console.error("call-me error:", e);
    res.status(500).json({ error: "Failed to place call" });
  }
});

/* -------------------- START SERVER -------------------- */
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Listening on ${port}`));
