const express = require("express");
const cors = require("cors");
const multer = require("multer");
const mammoth = require("mammoth");
const pdfParse = require("pdf-parse");
const fs = require("fs");
const path = require("path");
const os = require("os");
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

async function extractDocxText(filePath) {
  const result = await mammoth.extractRawText({ path: filePath });
  return result.value || "";
}

async function extractPdfText(filePath) {
  const data = fs.readFileSync(filePath);
  const result = await pdfParse(data);
  return result.text || "";
}

app.use(cors());
app.use(express.json());

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

app.post("/api/resume/analyze", (req, res) => {
  const { content } = req.body;
  const text = typeof content === "string" ? content : "";
  res.json({ analysis: `Your resume has ${text.length} characters.` });
});

app.listen(5000, () => console.log("Server running on port 5000"));
