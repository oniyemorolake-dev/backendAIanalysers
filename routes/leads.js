const express = require("express");
const axios = require("axios");

const router = express.Router();

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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
  const email = process.env.CONTACT_EMAIL || "hello@motechco.ca";
  res.json({
    email,
    label: "MoTechCo support",
    message: "Questions about your report, premium access, or a custom resume review? Email us.",
  });
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
