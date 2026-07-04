const express = require("express");
const axios = require("axios");
const { GoogleAuth } = require("google-auth-library");

const router = express.Router();

const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.0-flash";
const VERTEX_LOCATION = process.env.GOOGLE_CLOUD_LOCATION || "us-central1";

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

function buildGeminiBody(prompt) {
  return {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 1024,
      responseMimeType: "application/json",
    },
  };
}

function extractGeneratedText(data) {
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    const reason = data?.candidates?.[0]?.finishReason || "unknown";
    throw new Error(`Gemini returned no text (finishReason: ${reason})`);
  }
  return text;
}

function readServiceAccountCredentials() {
  const candidates = [
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON,
    process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON,
  ];

  for (const value of candidates) {
    if (value && value.trim().startsWith("{")) {
      return JSON.parse(value);
    }
  }

  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (apiKey && apiKey.startsWith("{")) {
    return JSON.parse(apiKey);
  }

  return null;
}

async function callGeminiWithApiKey(prompt) {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey || apiKey.startsWith("{")) {
    throw new Error("Missing GEMINI_API_KEY env var");
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
  const resp = await axios.post(url, buildGeminiBody(prompt), {
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey,
    },
    timeout: 60000,
  });

  return extractGeneratedText(resp.data);
}

async function callGeminiWithServiceAccount(prompt) {
  const credentials = readServiceAccountCredentials();
  if (!credentials) {
    throw new Error("Missing GOOGLE_SERVICE_ACCOUNT_JSON env var");
  }

  const projectId =
    process.env.GOOGLE_CLOUD_PROJECT ||
    process.env.GCP_PROJECT_ID ||
    credentials.project_id;

  if (!projectId) {
    throw new Error("Missing GOOGLE_CLOUD_PROJECT env var for Vertex AI");
  }

  const auth = new GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/cloud-platform"],
  });
  const client = await auth.getClient();
  const tokenResponse = await client.getAccessToken();
  const accessToken = tokenResponse?.token || tokenResponse;

  if (!accessToken) {
    throw new Error("Failed to obtain Google Cloud access token");
  }

  const url = `https://${VERTEX_LOCATION}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${VERTEX_LOCATION}/publishers/google/models/${GEMINI_MODEL}:generateContent`;
  const resp = await axios.post(url, buildGeminiBody(prompt), {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    timeout: 60000,
  });

  return extractGeneratedText(resp.data);
}

async function callGemini(prompt) {
  if (readServiceAccountCredentials()) {
    return callGeminiWithServiceAccount(prompt);
  }
  return callGeminiWithApiKey(prompt);
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
