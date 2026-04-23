import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import multer from "multer";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractDocumentText } from "./document-upload.js";
import { getModelRuntimeConfig, getPublicModelRuntimeConfig } from "./model-config.js";
import { DEFAULT_SYSTEM_PROMPT } from "./prompts.js";
import { getAvailableSkills, getSkillDetailById } from "./skills.js";
import { runWorkflow, type WorkflowStage } from "./workflow.js";

dotenv.config();

const app = express();
const port = Number(process.env.API_PORT ?? process.env.PORT ?? 3000);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const clientDistPath = path.resolve(__dirname, "../dist-client");
const pythonChartServiceUrl =
  process.env.PYTHON_CHART_SERVICE_URL ?? "https://replace-with-python-chart-service-url";
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 20 * 1024 * 1024
  }
});

app.use(cors());
app.use(express.json({ limit: "50mb" }));
app.use(express.text({ limit: "50mb" }));

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    model: getPublicModelRuntimeConfig()
  });
});

app.get("/api/skills", (_req, res) => {
  res.json({
    skills: getAvailableSkills()
  });
});

app.get("/api/skills/:skillId", async (req, res) => {
  try {
    const skillId = typeof req.params.skillId === "string" ? req.params.skillId : "";
    const skill = await getSkillDetailById(skillId);
    if (!skill) {
      res.status(404).json({ error: "Skill not found." });
      return;
    }

    res.json({ skill });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected server error";
    res.status(500).json({ error: message });
  }
});

app.post("/api/upload-document", upload.single("document"), async (req, res) => {
  try {
    const uploadedFile = req.file;
    if (!uploadedFile) {
      res.status(400).json({ error: "No document was uploaded." });
      return;
    }

    const extractedText = await extractDocumentText({
      buffer: uploadedFile.buffer,
      fileName: uploadedFile.originalname || "uploaded-document",
      mimeType: uploadedFile.mimetype
    });

    res.json({
      fileName: uploadedFile.originalname || "uploaded-document",
      content: extractedText
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to process uploaded document.";
    res.status(400).json({ error: message });
  }
});

app.post("/api/python-chart", async (req, res) => {
  try {
    const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
    if (!text) {
      res.status(400).json({ error: "Input text is required." });
      return;
    }

    if (pythonChartServiceUrl.includes("replace-with-python-chart-service-url")) {
      res.status(501).json({
        error: "Python chart service URL is not configured yet. Set PYTHON_CHART_SERVICE_URL."
      });
      return;
    }

    const pythonResponse = await fetch(pythonChartServiceUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ text })
    });
    const payload = (await pythonResponse.json()) as Record<string, unknown>;
    if (!pythonResponse.ok) {
      const message =
        typeof payload.error === "string"
          ? payload.error
          : `Python chart service returned status ${pythonResponse.status}.`;
      throw new Error(message);
    }

    res.json(payload);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unable to generate chart data from Python service.";
    res.status(400).json({ error: message });
  }
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
        : getModelRuntimeConfig().model;
    const stage: WorkflowStage =
      req.body?.stage === "awaiting-clarification" || req.body?.stage === "wbs-ready"
        ? req.body.stage
        : "initial";
    const initialScope =
      typeof req.body?.initialScope === "string" && req.body.initialScope.trim()
        ? req.body.initialScope
        : null;
    const latestMermaid =
      typeof req.body?.latestMermaid === "string" && req.body.latestMermaid.trim()
        ? req.body.latestMermaid
        : null;

    console.log(`Workflow request: stage=${stage}, input length=${input.length}`);

    const result = await runWorkflow({
      input,
      systemPrompt,
      model,
      stage,
      initialScope,
      latestMermaid
    });

    console.log("Workflow completed successfully");
    res.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected server error";
    console.error("Workflow error:", error);
    res.status(400).json({ error: message });
  }
});

app.use(express.static(clientDistPath));

// Error handling middleware
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") {
      res.status(400).json({ error: "The uploaded document is too large. Maximum size is 20 MB." });
      return;
    }

    res.status(400).json({ error: `Upload error: ${err.message}` });
    return;
  }

  const message = err instanceof Error ? err.message : "Internal server error";
  console.error("Unhandled error:", err);
  res.status(500).json({ error: message });
});

// 404 handler - must be last
app.use((_req, res) => {
  res.sendFile(path.join(clientDistPath, "index.html"));
});

app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
