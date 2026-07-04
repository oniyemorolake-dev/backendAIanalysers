const express = require("express");
const cors = require("cors");
const app = express();

app.use(cors());
app.use(express.json());

app.post("/api/resume/analyze", (req, res) => {
  const { content } = req.body;
  const text = typeof content === "string" ? content : "";
  res.json({ analysis: `Your resume has ${text.length} characters.` });
});

app.listen(5000, () => console.log("Server running on port 5000"));
