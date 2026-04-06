const express = require("express");
const router = express.Router();
const multer = require("multer");

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB max
});

// POST /api/transcribe
// Body: multipart/form-data, field "audio" = audio blob
// Returns: { text: "..." }
router.post("/", upload.single("audio"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Keine Audiodatei" });
  if (!process.env.GROQ_API_KEY) return res.status(500).json({ error: "GROQ_API_KEY nicht gesetzt" });

  const mime = req.file.mimetype || "audio/webm";
  const ext  = mime.includes("mp4") || mime.includes("m4a") ? "mp4"
             : mime.includes("ogg") ? "ogg"
             : mime.includes("wav") ? "wav"
             : "webm";

  // Node 18 built-in FormData + Blob
  const form = new FormData();
  form.append("file", new Blob([req.file.buffer], { type: mime }), `audio.${ext}`);
  form.append("model", "whisper-large-v3-turbo");
  form.append("language", "de");
  form.append("response_format", "json");

  try {
    const response = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${process.env.GROQ_API_KEY}` },
      body: form,
    });
    const data = await response.json();
    if (!response.ok) {
      console.error("Groq Whisper error:", data);
      return res.status(500).json({ error: data.error?.message || "Transkription fehlgeschlagen" });
    }
    const text = (data.text || "").trim();
    console.log(`🎤 Whisper: "${text}"`);
    res.json({ text });
  } catch (err) {
    console.error("transcribe error:", err);
    res.status(500).json({ error: "Transkription fehlgeschlagen: " + err.message });
  }
});

module.exports = router;
