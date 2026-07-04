const express = require("express");
const cors = require("cors");
const multer = require("multer");
const mammoth = require("mammoth");
const fs = require("fs");
const path = require("path");
const app = express();

const uploadDir = path.join(__dirname, "tmp", "uploads");
fs.mkdirSync(uploadDir, { recursive: true });

const upload = multer({
  dest: uploadDir,
  limits: { fileSize: 10 * 1024 * 1024 },
});

app.use(cors());
app.use(express.json());

app.post("/api/resume/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const uploadedPath = req.file.path;
    const originalName = req.file.originalname;
    const ext = path.extname(originalName).toLowerCase();

    if (ext !== ".docx") {
      fs.unlink(uploadedPath, () => {});
      return res
        .status(400)
        .json({ error: "Only .docx files are supported for now" });
    }

    const result = await mammoth.extractRawText({ path: uploadedPath });
    const extractedText = result.value || "";

    fs.unlink(uploadedPath, () => {});

    return res.json({
      filename: originalName,
      text: extractedText,
    });
  } catch (err) {
    console.error("Upload error:", err);
    if (req.file && req.file.path) {
      fs.unlink(req.file.path, () => {});
    }
    return res.status(500).json({ error: "Failed to extract text from .docx" });
  }
});

app.post("/api/resume/analyze", (req, res) => {
  const { content } = req.body;
  const text = typeof content === "string" ? content : "";
  res.json({ analysis: `Your resume has ${text.length} characters.` });
});

app.listen(5000, () => console.log("Server running on port 5000"));
