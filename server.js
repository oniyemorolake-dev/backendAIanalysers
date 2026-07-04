const express = require("express");
const cors = require("cors");
const multer = require("multer");
const mammoth = require("mammoth");
const { PDFParse } = require("pdf-parse");
const fs = require("fs");
const path = require("path");
const os = require("os");
const analyzeRoutes = require("./routes/analyze");
const paymentRoutes = require("./routes/payment");
const leadsRoutes = require("./routes/leads");
const app = express();

const uploadDir = path.join(os.tmpdir(), "uploads");
fs.mkdirSync(uploadDir, { recursive: true });

const upload = multer({
  dest: uploadDir,
  limits: { fileSize: 20 * 1024 * 1024 },
});

function safeUnlink(filePath) {
  if (!filePath) return;
  fs.unlink(filePath, () => {});
}

function normalizeExtractedText(text) {
  return String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function extractDocxText(filePath) {
  const result = await mammoth.extractRawText({ path: filePath });
  return normalizeExtractedText(result.value || "");
}

async function extractPdfText(filePath) {
  const data = fs.readFileSync(filePath);
  const parser = new PDFParse({ data });

  try {
    const result = await parser.getText();
    return normalizeExtractedText(result.text || "");
  } finally {
    await parser.destroy();
  }
}

app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use("/api/resume", analyzeRoutes);
app.use("/api/resume", paymentRoutes);
app.use("/api/resume", leadsRoutes);

app.post(
  "/api/resume/upload",
  upload.fields([
    { name: "file", maxCount: 1 },
    { name: "resume", maxCount: 1 },
  ]),
  async (req, res) => {
  try {
    const uploaded =
      (req.files && req.files.file && req.files.file[0]) ||
      (req.files && req.files.resume && req.files.resume[0]);

    if (!uploaded) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const uploadedPath = uploaded.path;
    const originalName = uploaded.originalname;
    const ext = path.extname(originalName).toLowerCase();
    let extractedText = "";

    if (ext === ".docx") {
      extractedText = await extractDocxText(uploadedPath);
    } else if (ext === ".pdf") {
      extractedText = await extractPdfText(uploadedPath);
    } else {
      safeUnlink(uploadedPath);
      return res
        .status(400)
        .json({ error: "Only .docx and .pdf files are supported for now" });
    }

    safeUnlink(uploadedPath);

    return res.json({
      filename: originalName,
      text: extractedText,
    });
  } catch (err) {
    console.error("Upload error:", err);
    const uploaded =
      (req.files && req.files.file && req.files.file[0]) ||
      (req.files && req.files.resume && req.files.resume[0]);
    safeUnlink(uploaded && uploaded.path);
    return res.status(500).json({ error: "Failed to extract text from uploaded file" });
  }
}
);

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  console.log(`Server running on port ${PORT}`);
  console.log("GEMINI_API_KEY present:", Boolean(apiKey));
  console.log("GEMINI_API_KEY prefix:", apiKey ? `${apiKey.slice(0, 7)}...` : "(not set)");
  console.log(
    "Vertex service account present:",
    Boolean(
      process.env.GOOGLE_SERVICE_ACCOUNT_JSON ||
        process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON ||
        process.env.GEMINI_API_KEY?.trim()?.startsWith("{")
    )
  );
  console.log("GOOGLE_CLOUD_PROJECT:", process.env.GOOGLE_CLOUD_PROJECT || "(not set)");
  console.log("Stripe configured:", Boolean(process.env.STRIPE_SECRET_KEY?.trim() && process.env.STRIPE_PRICE_ID));
  console.log("Premium free mode:", process.env.PREMIUM_FREE_MODE === "true");
});
