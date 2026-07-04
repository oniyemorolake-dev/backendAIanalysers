const express = require("express");
const axios = require("axios");

const router = express.Router();

const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.0-flash";

function parseJsonFromModelOutput(text) {
  if (!text || typeof text !== "string") return null;

  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch (_) {
    /* fall through */
  }

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch (_) {
      /* fall through */
    }
  }

  const objectMatch = trimmed.match(/\{[\s\S]*\}/);
  if (objectMatch) {
    try {
      return JSON.parse(objectMatch[0]);
    } catch (_) {
      return null;
    }
  }

  return null;
}

async function callGemini(prompt) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("Missing GEMINI_API_KEY env var");

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 1024,
      responseMimeType: "application/json",
    },
  };

  const resp = await axios.post(url, body, {
    headers: { "Content-Type": "application/json" },
    timeout: 60000,
  });

  const text = resp.data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    const reason = resp.data?.candidates?.[0]?.finishReason || "unknown";
    throw new Error(`Gemini returned no text (finishReason: ${reason})`);
  }

  return text;
}

router.post("/analyze", async (req, res) => {
  try {
    const { text } = req.body;
    if (!text || typeof text !== "string" || text.trim().length === 0) {
      return res.status(400).json({ error: "Missing resume text in request body" });
    }

    const prompt = `You are an expert resume reviewer. Analyze the resume text below and respond with ONLY a JSON object (no markdown, no commentary) using exactly these keys:
- strengths: array of short strings
- weaknesses: array of short strings
- missingKeywords: array of suggested keywords for ATS and role fit
- formattingSuggestions: array of short strings
- score: integer from 0 to 100

Resume text:
"""${text.replace(/"/g, "'").slice(0, 12000)}"""`;

    const generated = await callGemini(prompt);
    const parsed = parseJsonFromModelOutput(generated);

    if (!parsed) {
      return res.json({ raw: generated, note: "AI output could not be parsed as JSON" });
    }

    return res.json({
      strengths: parsed.strengths || [],
      weaknesses: parsed.weaknesses || [],
      missingKeywords: parsed.missingKeywords || [],
      formattingSuggestions: parsed.formattingSuggestions || [],
      score: parsed.score ?? null,
    });
  } catch (err) {
    const detail =
      err.response?.data?.error?.message ||
      err.response?.data?.error ||
      err.message ||
      String(err);
    console.error("Analyze error:", detail);
    return res.status(500).json({ error: "AI analysis failed", detail });
  }
});

module.exports = router;
