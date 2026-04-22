import { DEFAULT_MODEL } from "./prompts.js";

type SupportedProvider = "openai" | "openai-compatible";
type ModelApiStyle = "responses" | "chat-completions";

export type ModelRuntimeConfig = {
  provider: SupportedProvider;
  apiStyle: ModelApiStyle;
  model: string;
  apiKey: string | null;
  baseURL: string | null;
};

const OPENAI_API_URL = "https://api.openai.com/v1";

function parseProvider(value: string | undefined): SupportedProvider {
  if (!value) {
    return "openai";
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "openai" || normalized === "openai-compatible") {
    return normalized;
  }

  throw new Error(
    `Unsupported MODEL_PROVIDER "${value}". Use "openai" or "openai-compatible".`
  );
}

function parseApiStyle(value: string | undefined, provider: SupportedProvider): ModelApiStyle {
  if (!value) {
    return provider === "openai" ? "responses" : "chat-completions";
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "responses" || normalized === "chat-completions") {
    return normalized;
  }

  throw new Error(
    `Unsupported MODEL_API_STYLE "${value}". Use "responses" or "chat-completions".`
  );
}

function cleanValue(value: string | undefined): string | null {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function normalizeBaseURL(baseURL: string | null): string | null {
  if (!baseURL) {
    return null;
  }

  return baseURL.replace(/\/+$/, "");
}

export function getModelRuntimeConfig(): ModelRuntimeConfig {
  const provider = parseProvider(process.env.MODEL_PROVIDER);
  const apiStyle = parseApiStyle(process.env.MODEL_API_STYLE, provider);
  const model = cleanValue(process.env.MODEL_NAME) ?? cleanValue(process.env.OPENAI_MODEL) ?? DEFAULT_MODEL;
  const apiKey = cleanValue(process.env.MODEL_API_KEY) ?? cleanValue(process.env.OPENAI_API_KEY);
  const baseURL = normalizeBaseURL(cleanValue(process.env.MODEL_BASE_URL));

  if (provider === "openai" && !apiKey) {
    throw new Error("Missing API key. Set MODEL_API_KEY (or OPENAI_API_KEY) for OpenAI.");
  }

  if (provider === "openai-compatible" && !baseURL) {
    throw new Error(
      "Missing MODEL_BASE_URL for openai-compatible provider. Example: https://your-server.example.com/v1"
    );
  }

  return {
    provider,
    apiStyle,
    model,
    apiKey,
    baseURL
  };
}

export function getPublicModelRuntimeConfig() {
  const config = getModelRuntimeConfig();
  return {
    provider: config.provider,
    apiStyle: config.apiStyle,
    model: config.model,
    baseURL: config.provider === "openai" ? OPENAI_API_URL : config.baseURL
  };
}
