const RATE_WINDOW_MS = 60 * 1000;
const MAX_REQUESTS_PER_MINUTE = Number(process.env.AI_REQUESTS_PER_MINUTE || 6);
const CACHE_TTL_MS = Number(process.env.AI_CACHE_TTL_MS || 15 * 60 * 1000);

const rateBuckets = new Map();
const responseCache = new Map();

function getClientKey(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length > 0) {
    return forwarded.split(",")[0].trim();
  }
  return req.ip || "anonymous";
}

function aiRateLimit(req, res, next) {
  const key = getClientKey(req);
  const now = Date.now();
  let bucket = rateBuckets.get(key);

  if (!bucket || now - bucket.start > RATE_WINDOW_MS) {
    bucket = { start: now, count: 0 };
  }

  bucket.count += 1;
  rateBuckets.set(key, bucket);

  if (bucket.count > MAX_REQUESTS_PER_MINUTE) {
    return res.status(429).json({
      error: "Too many AI requests",
      detail: "Please wait about 1 minute before trying again. This protects the shared AI quota.",
    });
  }

  return next();
}

function buildCacheKey(body, suffix) {
  const text = String(body?.text || "").slice(0, 5000);
  const job = String(body?.jobDescription || "").slice(0, 2000);
  const premium = Boolean(body?.unlockToken);
  return `${suffix}:${premium}:${text.length}:${job.length}:${text.slice(0, 200)}:${job.slice(0, 100)}`;
}

function getCachedResponse(key) {
  const entry = responseCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    responseCache.delete(key);
    return null;
  }
  return entry.payload;
}

function setCachedResponse(key, payload) {
  responseCache.set(key, {
    payload,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });
}

function withAiCache(suffix) {
  return (req, res, next) => {
    const key = buildCacheKey(req.body, suffix);
    const cached = getCachedResponse(key);
    if (cached) {
      res.setHeader("X-MoTechCo-Cache", "HIT");
      return res.json(cached);
    }

    const originalJson = res.json.bind(res);
    res.json = (payload) => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        setCachedResponse(key, payload);
      }
      res.setHeader("X-MoTechCo-Cache", "MISS");
      return originalJson(payload);
    };

    return next();
  };
}

module.exports = {
  aiRateLimit,
  withAiCache,
};
