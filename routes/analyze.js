const express = require("express");
const axios = require("axios");

const router = express.Router();

async function callGemini(prompt) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("Missing GEMINI_API_KEY env var");

  const model = "models/text-bison-001";
  const endpoint = `https://us-central1-aiplatform.googleapis.com/v1/${model}:predict`;
  const url = `${endpoint}?key=${encodeURIComponent(apiKey)}`;

  const body = {
    instances: [{ content: prompt }],
    parameters: { temperature: 0.2, maxOutputTokens: 800 },
  };

  const resp = await axios.post(url, body, {
    headers: { "Content-Type": "application/json" },
    timeout: 30000,
  });

  return resp.data;
}

router.post("/analyze", async (req, res) => {
  try {
    const { text } = req.body;
    if (!text || typeof text !== "string" || text.trim().length === 0) {
      return res.status(400).json({ error: "Missing resume text in request body" });
    }

    const prompt = `
You are an expert resume reviewer. Analyze the following resume text and return a JSON object with keys:
strengths: array of short strings
weaknesses: array of short strings
missingKeywords: array of suggested keywords
formattingSuggestions: array of short strings
score: integer 0-100
Return only valid JSON. Resume text:
"""${text.replace(/`/g, "'")}"""
`;

    const aiResponse = await callGemini(prompt);

    let generated = "";
    if (aiResponse && Array.isArray(aiResponse.predictions) && aiResponse.predictions.length > 0) {
      const p = aiResponse.predictions[0];
      generated = p.content || p.text || JSON.stringify(p);
    } else {
      generated = JSON.stringify(aiResponse);
    }

    let parsed = null;
    try {
      parsed = JSON.parse(generated);
    } catch (e) {
      const jsonMatch = generated.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          parsed = JSON.parse(jsonMatch[0]);
        } catch (e2) {
          parsed = null;
        }
      }
    }

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
    console.error("Analyze error:", err.response ? err.response.data : err.message || err);
    return res.status(500).json({ error: "AI analysis failed" });
  }
});

module.exports = router;
