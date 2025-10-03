import express from "express";
import OpenAI from "openai";
import twilio from "twilio";

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Twilio answers and immediately asks for speech
app.post("/twilio-voice", (req, res) => {
  const vr = new twilio.twiml.VoiceResponse();

  const gather = vr.gather({
    input: "speech",
    language: "en-US",
    speechTimeout: "auto",
    action: "/twilio-gather",
    method: "POST"
  });

  // Instead of static greeting, this line is the *first prompt* to kick off AI
  gather.say({ voice: "Polly.Joanna", language: "en-US" }, 
    "Hi, I’m ElderMe. Tell me anything that’s on your mind, and I’ll talk with you."
  );

  res.type("text/xml").send(vr.toString());
});

// Handle what caller says → forward to OpenAI → reply back
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
        { role: "system", content: "You are ElderMe, a warm, caring voice companion. Speak naturally and briefly, no more than 20 seconds." },
        { role: "user", content: userText }
      ],
      max_tokens: 150,
      temperature: 0.7
    });

    const reply = completion.choices?.[0]?.message?.content?.trim() || "I’m here with you.";

    vr.say({ voice: "Polly.Joanna", language: "en-US" }, reply);

    // Re-prompt for next turn
    const again = vr.gather({
      input: "speech",
      language: "en-US",
      speechTimeout: "auto",
      action: "/twilio-gather",
      method: "POST"
    });
    again.say("You can keep talking if you’d like.");

    res.type("text/xml").send(vr.toString());

  } catch (err) {
    console.error(err);
    vr.say("Something went wrong on my end. Let’s try again later.");
    vr.hangup();
    res.type("text/xml").send(vr.toString());
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Listening on ${port}`));
