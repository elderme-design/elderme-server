import express from "express";
import twilio from "twilio";

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// Root route to test in browser
app.get("/", (req, res) => {
  res.send("ElderMe server up ✅");
});

// Twilio Voice webhook
app.post("/twilio-voice", (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  twiml.say("Hello, this is ElderMe. Your server is connected to Twilio.");
  res.type("text/xml");
  res.send(twiml.toString());
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`Listening on ${PORT}`);
});
