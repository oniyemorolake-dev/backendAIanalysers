const express = require("express");
const Stripe = require("stripe");

const router = express.Router();

const FRONTEND_URL = process.env.FRONTEND_URL || "https://resume.motechco.ca";
const STRIPE_PRICE_ID = process.env.STRIPE_PRICE_ID || "";
const PREMIUM_PRICE_LABEL = process.env.PREMIUM_PRICE_LABEL || "$6.99";
const COMPARE_AT_LABEL = process.env.COMPARE_AT_LABEL || "$29/mo elsewhere";

const verifiedSessions = new Map();
const verifiedReferrals = new Map();
const redeemedDevices = new Set();
const PAID_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY?.trim();
  if (!key) return null;
  return new Stripe(key);
}

function isSessionVerified(sessionId) {
  if (!sessionId) return false;
  const entry = verifiedSessions.get(sessionId);
  if (!entry) return false;
  if (Date.now() > entry.expiresAt) {
    verifiedSessions.delete(sessionId);
    return false;
  }
  return entry.paid === true;
}

async function verifyStripeSession(sessionId) {
  if (!sessionId) return { paid: false, error: "Missing session ID" };

  if (isSessionVerified(sessionId)) {
    return { paid: true, sessionId };
  }

  const stripe = getStripe();
  if (!stripe) {
    return { paid: false, error: "Stripe is not configured on the server" };
  }

  try {
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    const paid = session.payment_status === "paid";

    if (paid) {
      verifiedSessions.set(sessionId, {
        paid: true,
        expiresAt: Date.now() + PAID_SESSION_TTL_MS,
      });
    }

    return { paid, sessionId };
  } catch (err) {
    return { paid: false, error: err.message || "Unable to verify payment" };
  }
}

function isReferralTokenVerified(token) {
  if (!token || !String(token).startsWith("referral_")) return false;
  const entry = verifiedReferrals.get(token);
  if (!entry) return false;
  if (Date.now() > entry.expiresAt) {
    verifiedReferrals.delete(token);
    return false;
  }
  return true;
}

async function isPremiumUnlocked(req) {
  const unlockToken =
    req.body?.unlockToken ||
    req.headers["x-unlock-token"] ||
    req.query?.unlockToken;

  if (process.env.PREMIUM_FREE_MODE === "true") {
    return true;
  }

  if (!unlockToken) {
    return false;
  }

  if (isReferralTokenVerified(unlockToken)) {
    return true;
  }

  if (String(unlockToken).startsWith("cs_")) {
    const result = await verifyStripeSession(unlockToken);
    return result.paid === true;
  }

  return isSessionVerified(unlockToken);
}

router.get("/pricing", (_req, res) => {
  const stripeConfigured = Boolean(getStripe() && STRIPE_PRICE_ID);
  res.json({
    priceLabel: PREMIUM_PRICE_LABEL,
    compareAtLabel: COMPARE_AT_LABEL,
    launchNote: "One job. One payment. No monthly subscription.",
    stripeConfigured,
    freeIncludes: [
      "Overall resume score",
      "Top 3 strengths",
      "3 quick fixes to try first",
    ],
    premiumIncludes: [
      "Full strengths and weaknesses",
      "ATS keyword gaps",
      "Formatting suggestions",
      "Job description match score",
      "Job-tailored resume rewrite",
      "Job-tailored cover letter",
      "LinkedIn About optimizer",
      "Interview question prep",
      "Shareable score card",
    ],
  });
});

router.post("/create-checkout", async (req, res) => {
  const stripe = getStripe();

  if (!stripe || !STRIPE_PRICE_ID) {
    return res.status(503).json({
      error: "Payments are not configured yet",
      detail: "Add STRIPE_SECRET_KEY and STRIPE_PRICE_ID on Render.",
    });
  }

  const referralCode =
    typeof req.body?.referralCode === "string"
      ? req.body.referralCode.trim().slice(0, 40)
      : "";

  try {
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [{ price: STRIPE_PRICE_ID, quantity: 1 }],
      success_url: `${FRONTEND_URL}/index.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${FRONTEND_URL}/index.html?canceled=1`,
      allow_promotion_codes: true,
      metadata: {
        product: "motechco_resume_report",
        ...(referralCode ? { referral_code: referralCode } : {}),
      },
    });

    return res.json({ url: session.url, sessionId: session.id });
  } catch (err) {
    console.error("Stripe checkout error:", err.message || err);
    return res.status(500).json({
      error: "Could not start checkout",
      detail: err.message || String(err),
    });
  }
});

router.post("/verify-session", async (req, res) => {
  const { sessionId } = req.body;
  const result = await verifyStripeSession(sessionId);

  if (!result.paid) {
    return res.status(402).json({
      paid: false,
      error: result.error || "Payment not completed",
    });
  }

  return res.json({
    paid: true,
    unlockToken: result.sessionId,
    message: "Premium report unlocked for 30 days on this device.",
  });
});

router.post("/premium-status", async (req, res) => {
  const { unlockToken } = req.body;

  if (!unlockToken) {
    return res.json({ premium: false });
  }

  if (isReferralTokenVerified(unlockToken)) {
    return res.json({ premium: true, source: "referral" });
  }

  if (String(unlockToken).startsWith("cs_")) {
    const result = await verifyStripeSession(unlockToken);
    if (result.paid) {
      return res.json({ premium: true, source: "stripe", unlockToken: result.sessionId });
    }
  }

  return res.json({ premium: false });
});

router.post("/referral/redeem", (req, res) => {
  const { refCode, deviceId } = req.body;

  if (!refCode || String(refCode).trim().length < 6) {
    return res.status(400).json({ error: "Invalid referral code" });
  }

  const normalizedDevice = String(deviceId || "anonymous").slice(0, 120);
  if (redeemedDevices.has(normalizedDevice)) {
    return res.status(409).json({ error: "Referral already redeemed on this device" });
  }

  const unlockToken = `referral_${String(refCode).trim().toLowerCase()}_${Date.now()}`;
  verifiedReferrals.set(unlockToken, {
    expiresAt: Date.now() + 24 * 60 * 60 * 1000,
  });
  redeemedDevices.add(normalizedDevice);

  return res.json({
    ok: true,
    unlockToken,
    message: "Referral unlocked! Enjoy one premium report free for 24 hours.",
  });
});

router.get("/referral/link", (req, res) => {
  const ref = String(req.query.code || "").trim();
  if (ref.length < 6) {
    return res.status(400).json({ error: "Referral code required" });
  }

  return res.json({
    shareUrl: `${FRONTEND_URL}/index.html?ref=${encodeURIComponent(ref)}`,
    message: "Friends who use your link get one free premium report.",
  });
});

module.exports = router;
module.exports.isPremiumUnlocked = isPremiumUnlocked;
module.exports.verifyStripeSession = verifyStripeSession;
module.exports.PREMIUM_PRICE_LABEL = PREMIUM_PRICE_LABEL;
