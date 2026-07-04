const express = require("express");
const axios = require("axios");
const { GoogleAuth } = require("google-auth-library");

const router = express.Router();

const DEFAULT_MODELS = [
  "gemini-2.0-flash-lite",
  "gemini-2.0-flash",
  "gemini-1.5-flash-8b",
  "gemini-2.5-flash-lite",
  "gemini-2.5-flash",
  "gemini-1.5-flash-latest",
];

const MODEL_FALLBACKS = (
  process.env.GEMINI_MODEL
    ? [process.env.GEMINI_MODEL, ...DEFAULT_MODELS]
    : DEFAULT_MODELS
).filter((model, index, list) => model && list.indexOf(model) === index);

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

function getApiErrorDetail(err) {
  return (
    err.response?.data?.error?.message ||
    err.response?.data?.error ||
    err.message ||
    String(err)
  );
}

function isRetryableModelError(detail) {
  const message = String(detail).toLowerCase();
  return (
    message.includes("quota") ||
    message.includes("rate limit") ||
    message.includes("not found") ||
    message.includes("not supported") ||
    message.includes("limit: 0")
  );
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

async function callGeminiModelWithApiKey(apiKey, model, prompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const resp = await axios.post(url, buildGeminiBody(prompt), {
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey,
    },
    timeout: 60000,
  });

  return extractGeneratedText(resp.data);
}

async function callGeminiWithApiKey(prompt) {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey || apiKey.startsWith("{")) {
    throw new Error("Missing GEMINI_API_KEY env var");
  }

  let lastError = null;

  for (const model of MODEL_FALLBACKS) {
    try {
      const text = await callGeminiModelWithApiKey(apiKey, model, prompt);
      console.log(`Gemini analysis succeeded with model: ${model}`);
      return text;
    } catch (err) {
      lastError = err;
      const detail = getApiErrorDetail(err);
      console.warn(`Gemini model ${model} failed:`, detail);
      if (!isRetryableModelError(detail)) {
        throw err;
      }
    }
  }

  throw lastError || new Error("All Gemini models failed");
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

  let lastError = null;

  for (const model of MODEL_FALLBACKS) {
    try {
      const url = `https://${VERTEX_LOCATION}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${VERTEX_LOCATION}/publishers/google/models/${model}:generateContent`;
      const resp = await axios.post(url, buildGeminiBody(prompt), {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        timeout: 60000,
      });

      console.log(`Vertex analysis succeeded with model: ${model}`);
      return extractGeneratedText(resp.data);
    } catch (err) {
      lastError = err;
      const detail = getApiErrorDetail(err);
      console.warn(`Vertex model ${model} failed:`, detail);
      if (!isRetryableModelError(detail)) {
        throw err;
      }
    }
  }

  throw lastError || new Error("All Vertex models failed");
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
    const detail = getApiErrorDetail(err);
    console.error("Analyze error:", detail);
    return res.status(500).json({ error: "AI analysis failed", detail });
  }
});

module.exports = router;
