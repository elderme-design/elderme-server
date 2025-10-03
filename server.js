// put near the top with other imports
import twilio from "twilio";

// Twilio REST client (for outbound calls)
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

// OPTIONAL: simple auth so randos can’t trigger calls
const CALL_ME_SECRET = process.env.CALL_ME_SECRET || "changeme";

// Helper to ensure +E.164 numbers
function toE164(num) {
  const s = String(num).replace(/[^\d+]/g, "");
  return s.startsWith("+") ? s : `+${s}`;
}

// POST /call-me  { "to": "+1YOURNUMBER", "secret": "..." }
app.post("/call-me", async (req, res) => {
  try {
    if (CALL_ME_SECRET && req.body.secret !== CALL_ME_SECRET) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const to = toE164(req.body.to);
    if (!/^\+\d{10,15}$/.test(to)) {
      return res.status(400).json({ error: "Invalid phone number" });
    }

    // When the call is answered, Twilio will fetch /twilio-voice
    const twimlUrl = "https://elderme-server.onrender.com/twilio-voice";

    const call = await twilioClient.calls.create({
      to,
      from: process.env.TWILIO_FROM_NUMBER,
      url: twimlUrl,        // this kicks off your AI voice flow
      method: "POST"
    });

    res.json({ ok: true, sid: call.sid });
  } catch (e) {
    console.error("call-me error:", e);
    res.status(500).json({ error: "Failed to place call" });
  }
});
