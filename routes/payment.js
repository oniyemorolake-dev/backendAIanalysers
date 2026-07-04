const express = require("express");
const Stripe = require("stripe");

const router = express.Router();

const FRONTEND_URL = process.env.FRONTEND_URL || "https://resume.motechco.ca";
const STRIPE_PRICE_ID = process.env.STRIPE_PRICE_ID || "";
const PREMIUM_PRICE_LABEL = process.env.PREMIUM_PRICE_LABEL || "$4.99";

const verifiedSessions = new Map();

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
        expiresAt: Date.now() + 24 * 60 * 60 * 1000,
      });
    }

    return { paid, sessionId };
  } catch (err) {
    return { paid: false, error: err.message || "Unable to verify payment" };
  }
}

function isPremiumUnlocked(req) {
  const unlockToken =
    req.body?.unlockToken ||
    req.headers["x-unlock-token"] ||
    req.query?.unlockToken;

  if (unlockToken && isSessionVerified(unlockToken)) {
    return true;
  }

  if (process.env.PREMIUM_FREE_MODE === "true") {
    return true;
  }

  return false;
}

router.get("/pricing", (_req, res) => {
  const stripeConfigured = Boolean(getStripe() && STRIPE_PRICE_ID);
  res.json({
    priceLabel: PREMIUM_PRICE_LABEL,
    stripeConfigured,
    freeIncludes: ["Overall resume score", "Top 3 strengths preview"],
    premiumIncludes: [
      "Full strengths and weaknesses",
      "ATS keyword gaps",
      "Formatting suggestions",
      "Job description match score",
      "Shareable score card",
    ],
  });
});

router.post("/create-checkout", async (_req, res) => {
  const stripe = getStripe();

  if (!stripe || !STRIPE_PRICE_ID) {
    return res.status(503).json({
      error: "Payments are not configured yet",
      detail: "Add STRIPE_SECRET_KEY and STRIPE_PRICE_ID on Render.",
    });
  }

  try {
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [{ price: STRIPE_PRICE_ID, quantity: 1 }],
      success_url: `${FRONTEND_URL}/index.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${FRONTEND_URL}/index.html?canceled=1`,
      metadata: { product: "motechco_resume_report" },
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
    message: "Premium report unlocked for 24 hours on this device.",
  });
});

module.exports = router;
module.exports.isPremiumUnlocked = isPremiumUnlocked;
module.exports.verifyStripeSession = verifyStripeSession;
module.exports.PREMIUM_PRICE_LABEL = PREMIUM_PRICE_LABEL;
