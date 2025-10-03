import express from "express";
import OpenAI from "openai";

const app = express();
app.use(express.json());

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.get("/", (req, res) => res.send("ElderMe server up"));

app.post("/chat", async (req, res) => {
  try {
    const { messages = [{ role: "user", content: "Hello" }] } = req.body;
    const chat = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages
    });
    res.json(chat.choices[0].message);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "OpenAI call failed" });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Listening on ${port}`));
