import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_MODEL, DEFAULT_SYSTEM_PROMPT, runWorkflow } from "./workflow.js";

dotenv.config();

const app = express();
const port = Number(process.env.API_PORT ?? process.env.PORT ?? 3000);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const clientDistPath = path.resolve(__dirname, "../dist-client");

app.use(cors());
app.use(express.json({ limit: "2mb" }));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/api/workflow", async (req, res) => {
  try {
    const input = typeof req.body?.input === "string" ? req.body.input : "";
    const systemPrompt =
      typeof req.body?.systemPrompt === "string" && req.body.systemPrompt.trim()
        ? req.body.systemPrompt
        : DEFAULT_SYSTEM_PROMPT;
    const model =
      typeof req.body?.model === "string" && req.body.model.trim()
        ? req.body.model
        : DEFAULT_MODEL;

    const result = await runWorkflow(input, systemPrompt, model);
    res.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected server error";
    res.status(400).json({ error: message });
  }
});

app.use(express.static(clientDistPath));
app.use((_req, res) => {
  res.sendFile(path.join(clientDistPath, "index.html"));
});

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
