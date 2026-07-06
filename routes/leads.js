const express = require("express");
const axios = require("axios");

const router = express.Router();

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const FRONTEND_URL = process.env.FRONTEND_URL || "https://resume.motechco.ca";
const PREMIUM_PRICE_LABEL = process.env.PREMIUM_PRICE_LABEL || "$4.99";
const savedScoreEmails = new Map();
const SAVE_SCORE_COOLDOWN_MS = 60 * 60 * 1000;

async function sendViaResend(to, subject, text) {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  if (!apiKey) return false;

  await axios.post(
    "https://api.resend.com/emails",
    {
      from: process.env.RESEND_FROM || "MoTechCo <onboarding@resend.dev>",
      to: [to],
      subject,
      text,
    },
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      timeout: 15000,
    }
  );

  return true;
}

router.get("/email-status", (_req, res) => {
  const configured = Boolean(process.env.RESEND_API_KEY?.trim());
  res.json({
    configured,
    message: configured
      ? "Email delivery is enabled."
      : "Email delivery is not configured yet. Users can still download or print their report.",
  });
});

router.get("/contact", (_req, res) => {
  const email = process.env.CONTACT_EMAIL || "mowebsiteco@gmail.com";
  res.json({
    email,
    label: "MoTechCo support",
    message: "Questions about your report, premium access, or a custom resume review? Email us.",
  });
});

function buildFreeScoreEmail({ email, score, strengths, issuesFound }) {
  const scoreLine = typeof score === "number" ? `${score}/100` : "ready";
  const strengthLines =
    Array.isArray(strengths) && strengths.length > 0
      ? strengths.map((item) => `  • ${item}`).join("\n")
      : "  • Upload again on the site to refresh your preview.";

  const issuesLine =
    typeof issuesFound === "number" && issuesFound > 0
      ? `\nWe also flagged ${issuesFound} improvement area${issuesFound === 1 ? "" : "s"} in the full report (weaknesses, keywords, or formatting).\n`
      : "\n";

  return {
    subject: `Your MoTechCo resume score${typeof score === "number" ? ` — ${score}/100` : ""}`,
    body: `Hi,

Thanks for trying MoTechCo Resume Analyzer.

Your resume score: ${scoreLine}

Top strengths from your preview:
${strengthLines}
${issuesLine}
Unlock the full application kit (${PREMIUM_PRICE_LABEL} one-time) for:
  • Full weaknesses + ATS keyword gaps
  • Job-tailored resume rewrite
  • Job-tailored cover letter
  • Download, print, and share tools

Continue here:
${FRONTEND_URL}/index.html

Questions? Reply to this email or contact ${process.env.CONTACT_EMAIL || "mowebsiteco@gmail.com"}.

— MoTechCo
${FRONTEND_URL}`,
  };
}

router.post("/save-score", async (req, res) => {
  try {
    const { email, score, strengths, issuesFound, referralCode } = req.body;

    if (!email || !EMAIL_REGEX.test(String(email).trim())) {
      return res.status(400).json({ error: "Valid email address required" });
    }

    const cleanEmail = String(email).trim().toLowerCase();
    const lastSent = savedScoreEmails.get(cleanEmail);
    if (lastSent && Date.now() - lastSent < SAVE_SCORE_COOLDOWN_MS) {
      return res.json({
        ok: true,
        emailed: false,
        message: "We already sent your score recently. Check your inbox or wait an hour to request again.",
      });
    }

    const mail = buildFreeScoreEmail({
      email: cleanEmail,
      score: typeof score === "number" ? score : null,
      strengths: Array.isArray(strengths) ? strengths.slice(0, 3) : [],
      issuesFound: typeof issuesFound === "number" ? issuesFound : null,
    });

    let emailed = false;
    try {
      emailed = await sendViaResend(cleanEmail, mail.subject, mail.body);
    } catch (err) {
      console.warn("Save-score email failed:", err.response?.data || err.message);
    }

    if (emailed) {
      savedScoreEmails.set(cleanEmail, Date.now());
    }

    if (process.env.LEADS_WEBHOOK_URL) {
      try {
        await axios.post(
          process.env.LEADS_WEBHOOK_URL,
          {
            email: cleanEmail,
            score: score ?? null,
            issuesFound: issuesFound ?? null,
            referralCode: referralCode || null,
            source: "free-score-capture",
            emailed,
          },
          { timeout: 10000 }
        );
      } catch (err) {
        console.warn("Lead webhook failed:", err.message);
      }
    }

    console.log("Free score captured:", cleanEmail, "score:", score ?? "n/a", "emailed:", emailed);

    return res.json({
      ok: true,
      emailed,
      message: emailed
        ? "Score sent! Check your inbox — we included a link to unlock the full application kit."
        : "Email delivery is not configured yet. You can still unlock premium on the site below.",
    });
  } catch (err) {
    console.error("Save score error:", err.message || err);
    return res.status(500).json({ error: "Could not save score" });
  }
});

router.post("/email-report", async (req, res) => {
  try {
    const { email, reportText, score } = req.body;

    if (!email || !EMAIL_REGEX.test(String(email).trim())) {
      return res.status(400).json({ error: "Valid email address required" });
    }

    if (!reportText || typeof reportText !== "string" || reportText.trim().length < 20) {
      return res.status(400).json({ error: "Report text required" });
    }

    const cleanEmail = String(email).trim().toLowerCase();
    const subject = `Your MoTechCo Resume Report${typeof score === "number" ? ` — ${score}/100` : ""}`;
    const body = `Thanks for using MoTechCo Resume Analyzer.\n\n${reportText}\n\n— MoTechCo\nhttps://resume.motechco.ca`;

    let emailed = false;
    try {
      emailed = await sendViaResend(cleanEmail, subject, body);
    } catch (err) {
      console.warn("Resend email failed:", err.response?.data || err.message);
    }

    if (process.env.LEADS_WEBHOOK_URL) {
      try {
        await axios.post(process.env.LEADS_WEBHOOK_URL, {
          email: cleanEmail,
          score: score ?? null,
          source: "resume-analyzer",
          emailed,
        }, { timeout: 10000 });
      } catch (err) {
        console.warn("Lead webhook failed:", err.message);
      }
    }

    console.log("Email report requested:", cleanEmail, "score:", score ?? "n/a", "emailed:", emailed);

    return res.json({
      ok: true,
      emailed,
      message: emailed
        ? "Report sent to your inbox. Check spam if you do not see it within a minute."
        : "Email delivery is not set up yet on the server. Use Download Report or Print / Save PDF below instead.",
    });
  } catch (err) {
    console.error("Email report error:", err.message || err);
    return res.status(500).json({ error: "Could not process email request" });
  }
});

module.exports = router;
