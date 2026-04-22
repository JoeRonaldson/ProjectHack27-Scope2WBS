import OpenAI from "openai";
import type { ModelRuntimeConfig } from "./model-config.js";

type GenerateTextInput = {
  input: string;
  instructions: string;
  model: string;
  config: ModelRuntimeConfig;
};

type ModelAdapter = {
  generateText: (request: GenerateTextInput) => Promise<string>;
};

const openAiResponsesAdapter: ModelAdapter = {
  async generateText({ input, instructions, model, config }) {
    if (!config.apiKey) {
      throw new Error("Missing API key. Set MODEL_API_KEY (or OPENAI_API_KEY) for OpenAI.");
    }

    const client = new OpenAI({ apiKey: config.apiKey });
    const response = await client.responses.create({
      model,
      instructions,
      input
    });

    return response.output_text.trim();
  }
};

function buildAuthHeaders(apiKey: string | null): Record<string, string> {
  if (!apiKey) {
    return {};
  }

  return {
    Authorization: `Bearer ${apiKey}`
  };
}

function parseChatCompletionsContent(content: unknown): string {
  if (typeof content === "string") {
    return content.trim();
  }

  if (Array.isArray(content)) {
    const parts = content
      .map((item) => {
        if (!item || typeof item !== "object") {
          return "";
        }
        const maybeText = "text" in item ? item.text : "";
        return typeof maybeText === "string" ? maybeText : "";
      })
      .filter(Boolean);

    return parts.join("\n").trim();
  }

  return "";
}

const openAiCompatibleAdapter: ModelAdapter = {
  async generateText({ input, instructions, model, config }) {
    if (!config.baseURL) {
      throw new Error(
        "Missing MODEL_BASE_URL for openai-compatible provider. Example: https://your-server.example.com/v1"
      );
    }

    if (config.apiStyle === "responses") {
      const response = await fetch(`${config.baseURL}/responses`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...buildAuthHeaders(config.apiKey)
        },
        body: JSON.stringify({
          model,
          instructions,
          input
        })
      });

      const payload = (await response.json()) as { output_text?: string; error?: { message?: string } };
      if (!response.ok) {
        throw new Error(payload.error?.message ?? `Provider request failed with status ${response.status}.`);
      }

      const outputText = typeof payload.output_text === "string" ? payload.output_text.trim() : "";
      if (!outputText) {
        throw new Error(
          "OpenAI-compatible /responses response did not contain output_text. Set MODEL_API_STYLE=chat-completions for broader compatibility."
        );
      }

      return outputText;
    }

    const response = await fetch(`${config.baseURL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...buildAuthHeaders(config.apiKey)
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "system",
            content: instructions
          },
          {
            role: "user",
            content: input
          }
        ]
      })
    });

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: unknown } }>;
      error?: { message?: string };
    };
    if (!response.ok) {
      throw new Error(payload.error?.message ?? `Provider request failed with status ${response.status}.`);
    }

    const content = payload.choices?.[0]?.message?.content;
    const outputText = parseChatCompletionsContent(content);
    if (!outputText) {
      throw new Error(
        "OpenAI-compatible /chat/completions response did not contain assistant text in choices[0].message.content."
      );
    }

    return outputText;
  }
};

export function getModelAdapter(config: ModelRuntimeConfig): ModelAdapter {
  if (config.provider === "openai") {
    return openAiResponsesAdapter;
  }

  return openAiCompatibleAdapter;
}
