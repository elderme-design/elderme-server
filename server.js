import express from "express";
import OpenAI from "openai";
import twilio from "twilio";

const app = express();

// Twilio posts form-encoded; keep both parsers
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Health check
app.get("/", (_req, res) => res.send("ElderMe server up ✅"));

// OpenAI client (DO NOT hard-code your key)
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// 1) Answer call → prompt caller (no static greeting first)
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

  // If no speech, ask again
  vr.redirect("/twilio-voice");

  res.type("text/xml").send(vr.toString());
});

// 2) Get Twilio's transcript → ask OpenAI → speak response → loop
app.post("/twilio-gather", async (req, res) => {
  const vr = new twilio.twiml.VoiceResponse();

  try {
    const userText = (req.body.SpeechResult || "").trim();

    if (!userText) {
      vr.say("Sorry, I didn’t catch that. Please say something.");
      vr.redirect("/twilio-voice");
      return res.type("text/xml").send(vr.toString());
    }

    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
            "You are ElderMe, a warm, concise phone companion. Speak naturally; keep replies under ~20 seconds.",
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

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Listening on ${port}`));
