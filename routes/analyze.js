const express = require("express");
const axios = require("axios");
const { GoogleAuth } = require("google-auth-library");
const { isPremiumUnlocked, PREMIUM_PRICE_LABEL } = require("./payment");

const router = express.Router();

const DEFAULT_MODELS = [
  "gemini-2.0-flash",
  "gemini-2.0-flash-lite",
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
];

const MODEL_FALLBACKS = (
  process.env.GEMINI_MODEL
    ? [process.env.GEMINI_MODEL, ...DEFAULT_MODELS]
    : DEFAULT_MODELS
).filter((model, index, list) => model && list.indexOf(model) === index);

const VERTEX_LOCATION = process.env.GOOGLE_CLOUD_LOCATION || "us-central1";
const FREE_STRENGTHS_PREVIEW = 3;

function repairPartialJson(text) {
  if (!text) return null;

  let candidate = text.trim();
  candidate = candidate.replace(/,\s*"[^"]*$/u, "");
  candidate = candidate.replace(/,\s*$/u, "");

  const openBraces = (candidate.match(/\{/g) || []).length - (candidate.match(/\}/g) || []).length;
  const openBrackets = (candidate.match(/\[/g) || []).length - (candidate.match(/\]/g) || []).length;

  for (let i = 0; i < openBrackets; i += 1) candidate += "]";
  for (let i = 0; i < openBraces; i += 1) candidate += "}";

  try {
    return JSON.parse(candidate);
  } catch (_) {
    return null;
  }
}

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
      const repaired = repairPartialJson(fenced[1]);
      if (repaired) return repaired;
    }
  }

  const objectMatch = trimmed.match(/\{[\s\S]*/);
  if (objectMatch) {
    try {
      return JSON.parse(objectMatch[0]);
    } catch (_) {
      const repaired = repairPartialJson(objectMatch[0]);
      if (repaired) return repaired;
    }
  }

  return repairPartialJson(trimmed);
}

function extractPartialFields(text) {
  if (!text || typeof text !== "string") return null;

  const scoreMatch = text.match(/"score"\s*:\s*(\d{1,3})/);
  const strengths = [];
  const strengthsBlock = text.match(/"strengths"\s*:\s*\[([\s\S]*)/);

  if (strengthsBlock) {
    const itemRegex = /"((?:\\.|[^"\\])*)"/g;
    let match = itemRegex.exec(strengthsBlock[1]);
    while (match) {
      strengths.push(match[1].replace(/\\"/g, '"').replace(/\\n/g, "\n"));
      match = itemRegex.exec(strengthsBlock[1]);
    }
  }

  if (!scoreMatch && strengths.length === 0) return null;

  return {
    score: scoreMatch ? Number(scoreMatch[1]) : null,
    strengths,
    weaknesses: [],
    missingKeywords: [],
    formattingSuggestions: [],
    jobMatchScore: null,
    jobMatchedKeywords: [],
    jobMissingKeywords: [],
    jobFitSummary: "",
  };
}

function buildGeminiBody(prompt) {
  return {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 2500,
      responseMimeType: "application/json",
    },
  };
}

function extractGeneratedText(data) {
  const candidate = data?.candidates?.[0];
  const text = candidate?.content?.parts?.[0]?.text;
  const finishReason = candidate?.finishReason || "unknown";

  if (!text) {
    throw new Error(`Gemini returned no text (finishReason: ${finishReason})`);
  }

  return { text, finishReason };
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
    message.includes("high demand") ||
    message.includes("not found") ||
    message.includes("not supported") ||
    message.includes("limit: 0") ||
    message.includes("try again")
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

  const { text, finishReason } = extractGeneratedText(resp.data);
  if (finishReason === "MAX_TOKENS") {
    console.warn(`Gemini output truncated (MAX_TOKENS) for model ${model}`);
  }
  return { text, finishReason };
}

async function callGeminiWithApiKey(prompt) {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey || apiKey.startsWith("{")) {
    throw new Error("Missing GEMINI_API_KEY env var");
  }

  let lastError = null;

  for (const model of MODEL_FALLBACKS) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const result = await callGeminiModelWithApiKey(apiKey, model, prompt);
        console.log(`Gemini analysis succeeded with model: ${model}`);
        return result.text;
      } catch (err) {
        lastError = err;
        const detail = getApiErrorDetail(err);
        console.warn(`Gemini model ${model} attempt ${attempt + 1} failed:`, detail);
        if (!isRetryableModelError(detail)) {
          throw err;
        }
        if (attempt === 0 && /high demand|try again|rate limit/i.test(String(detail))) {
          await sleep(3000);
          continue;
        }
        break;
      }
    }
  }

  throw lastError || new Error("All Gemini models failed. Check GEMINI_API_KEY and try again.");
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
      const { text, finishReason } = extractGeneratedText(resp.data);
      if (finishReason === "MAX_TOKENS") {
        console.warn(`Vertex output truncated (MAX_TOKENS) for model ${model}`);
      }
      return text;
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

function buildAnalysisPrompt(text, jobDescription) {
  const safeText = text.replace(/"/g, "'").slice(0, 12000);
  const safeJob = jobDescription
    ? jobDescription.replace(/"/g, "'").slice(0, 6000)
    : "";

  const jobSection = safeJob
    ? `
Also compare the resume against this target job description and include:
- jobMatchScore: integer 0-100 for fit to this specific role
- jobMatchedKeywords: array of important keywords/phrases from the job description that ARE present in the resume
- jobMissingKeywords: array of important keywords/phrases from the job description that are MISSING from the resume
- jobFitSummary: one short paragraph explaining fit for this role

Target job description:
"""${safeJob}"""`
    : `
No job description was provided. Set jobMatchScore to null, jobMatchedKeywords to [], jobMissingKeywords to [], and jobFitSummary to ""`;

  return `You are an expert resume reviewer and ATS specialist. Analyze ONLY what is explicitly present in the resume text. Do not invent employers, dates, skills, degrees, or achievements that are not supported by the text.

Rules:
- Base every point on evidence from the resume.
- If information is missing or unclear, say so in weaknesses instead of guessing.
- Keep feedback practical and specific, not generic filler.
- Score conservatively: 90+ only for exceptional, well-evidenced resumes.
- Limit each array to at most 4 concise items (max 100 characters each).
- Put "score" first in the JSON object, then strengths, then the other fields.
- Keep the entire JSON response compact so it fits in one short object.

Respond with ONLY a JSON object (no markdown, no commentary) using exactly these keys in this order:
- score: integer from 0 to 100 for overall resume quality
- strengths: array of short strings
- weaknesses: array of short strings
- missingKeywords: array of suggested ATS keywords for general job search fit
- formattingSuggestions: array of short strings
${jobSection}

Resume text:
"""${safeText}"""`;
}

function buildFullResponse(parsed) {
  return {
    score: parsed.score ?? null,
    strengths: parsed.strengths || [],
    weaknesses: parsed.weaknesses || [],
    missingKeywords: parsed.missingKeywords || [],
    formattingSuggestions: parsed.formattingSuggestions || [],
    jobMatchScore: parsed.jobMatchScore ?? null,
    jobMatchedKeywords: parsed.jobMatchedKeywords || [],
    jobMissingKeywords: parsed.jobMissingKeywords || [],
    jobFitSummary: parsed.jobFitSummary || "",
  };
}

function buildFreeResponse(parsed) {
  const strengths = parsed.strengths || [];

  return {
    tier: "free",
    locked: true,
    priceLabel: PREMIUM_PRICE_LABEL,
    score: parsed.score ?? null,
    strengthsPreview: strengths.slice(0, FREE_STRENGTHS_PREVIEW),
    lockedSections: [
      "Full weaknesses breakdown",
      "Complete ATS keyword list",
      "Formatting suggestions",
      "Job description match score",
    ],
    upgradeMessage: `Unlock your full AI report for ${PREMIUM_PRICE_LABEL}.`,
  };
}

router.post("/analyze", async (req, res) => {
  try {
    const { text, jobDescription } = req.body;
    if (!text || typeof text !== "string" || text.trim().length === 0) {
      return res.status(400).json({ error: "Missing resume text in request body" });
    }

    const jobText =
      typeof jobDescription === "string" && jobDescription.trim().length > 0
        ? jobDescription.trim()
        : "";

    const premium = isPremiumUnlocked(req);
    const prompt = buildAnalysisPrompt(text, jobText);
    const generated = await callGemini(prompt);
    let parsed = parseJsonFromModelOutput(generated);

    if (!parsed) {
      parsed = extractPartialFields(generated);
    }

    if (!parsed) {
      return res.json({ raw: generated, note: "AI output could not be parsed as JSON" });
    }

    if (premium) {
      return res.json({
        tier: "premium",
        locked: false,
        ...buildFullResponse(parsed),
      });
    }

    return res.json(buildFreeResponse(parsed));
  } catch (err) {
    const detail = getApiErrorDetail(err);
    console.error("Analyze error:", detail);
    return res.status(500).json({ error: "AI analysis failed", detail });
  }
});

module.exports = router;
