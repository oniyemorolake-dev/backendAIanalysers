const express = require("express");
const cors = require("cors");
const multer = require("multer");
const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(cors());
app.use(express.json());

app.post("/api/resume/upload", upload.single("resume"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ message: "No file uploaded" });
  }

  const fallbackContent = `Uploaded file: ${req.file.originalname}`;
  res.json({ message: "File uploaded successfully", content: fallbackContent });
});

app.post("/api/resume/analyze", (req, res) => {
  const { content } = req.body;
  const text = typeof content === "string" ? content : "";
  res.json({ analysis: `Your resume has ${text.length} characters.` });
});

app.listen(5000, () => console.log("Server running on port 5000"));
