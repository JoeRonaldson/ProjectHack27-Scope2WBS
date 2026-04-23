import OpenAI from "openai";
import type { ModelRuntimeConfig } from "./model-config.js";

// Note: Ensure 'openai' package is installed: npm install openai

export type GenerateTextInput = {
  input: string;
  instructions: string;
  model: string;
  config: ModelRuntimeConfig;
};

export type ToolDefinition = {
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required?: readonly string[];
    additionalProperties?: boolean;
  };
};

export type ToolCall = {
  name: string;
  argumentsJson: string;
  callId: string;
};

export type ToolResult = {
  name: string;
  callId: string;
  output: string;
};

export type GenerateTextWithToolsInput = GenerateTextInput & {
  tools: ToolDefinition[];
  toolResults?: ToolResult[];
};

export type GenerateTextResult = {
  outputText: string;
  toolCalls: ToolCall[];
};

export type ModelAdapter = {
  generateText: (request: GenerateTextInput) => Promise<string>;
  generateTextWithTools: (request: GenerateTextWithToolsInput) => Promise<GenerateTextResult>;
};

function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("```")) {
    return trimmed;
  }

  return trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
}

function parseProtocolObject(candidate: string): GenerateTextResult | null {
  try {
    const parsed = JSON.parse(candidate) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }

    const typeValue = "type" in parsed ? parsed.type : "";
    if (typeValue === "tool_call" && "tool" in parsed && parsed.tool && typeof parsed.tool === "object") {
      const tool = parsed.tool as { name?: unknown; arguments?: unknown; callId?: unknown };
      const name = typeof tool.name === "string" ? tool.name.trim() : "";
      if (!name) {
        return null;
      }

      const callId =
        typeof tool.callId === "string" && tool.callId.trim()
          ? tool.callId.trim()
          : `toolcall-${Date.now()}`;
      const argumentsJson = JSON.stringify(
        typeof tool.arguments === "object" && tool.arguments ? tool.arguments : {}
      );

      return {
        outputText: "",
        toolCalls: [{ name, argumentsJson, callId }]
      };
    }

    if (typeValue === "final") {
      const content = "content" in parsed ? parsed.content : "";
      return {
        outputText: typeof content === "string" ? content.trim() : "",
        toolCalls: []
      };
    }
  } catch {
    return null;
  }

  return null;
}

function extractTopLevelJsonObjects(text: string): string[] {
  const chunks: string[] = [];
  let depth = 0;
  let startIndex = -1;
  let inString = false;
  let isEscaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (isEscaped) {
        isEscaped = false;
      } else if (character === "\\") {
        isEscaped = true;
      } else if (character === "\"") {
        inString = false;
      }
      continue;
    }

    if (character === "\"") {
      inString = true;
      continue;
    }

    if (character === "{") {
      if (depth === 0) {
        startIndex = index;
      }
      depth += 1;
      continue;
    }

    if (character === "}") {
      if (depth === 0) {
        continue;
      }
      depth -= 1;
      if (depth === 0 && startIndex >= 0) {
        chunks.push(text.slice(startIndex, index + 1));
        startIndex = -1;
      }
    }
  }

  return chunks;
}

function parseToolProtocolResponse(rawOutputText: string): GenerateTextResult {
  const normalized = stripCodeFence(rawOutputText);
  const directParse = parseProtocolObject(normalized);
  if (directParse) {
    return directParse;
  }

  const chunks = extractTopLevelJsonObjects(normalized);
  const parsedChunks = chunks
    .map((chunk) => parseProtocolObject(chunk))
    .filter((value): value is GenerateTextResult => Boolean(value));
  const toolCallChunk = parsedChunks.find((chunk) => chunk.toolCalls.length);
  if (toolCallChunk) {
    return toolCallChunk;
  }

  const finalChunk = [...parsedChunks].reverse().find((chunk) => chunk.outputText);
  if (finalChunk) {
    return finalChunk;
  }

  return { outputText: rawOutputText.trim(), toolCalls: [] };
}

function buildToolProtocolInstructions(
  instructions: string,
  tools: ToolDefinition[],
  toolResults: ToolResult[]
): string {
  const toolList = tools
    .map(
      (tool) =>
        `- ${tool.name}: ${tool.description}\n  parameters: ${JSON.stringify(tool.parameters)}`
    )
    .join("\n");

  const toolResultBlock = toolResults.length
    ? [
        "Tool outputs already available:",
        ...toolResults.map(
          (result) =>
            `- callId=${result.callId}, tool=${result.name}\n${result.output}`
        )
      ].join("\n")
    : "No tool outputs yet.";

  const stepRule = toolResults.length
    ? "You already have tool output. Return final answer only."
    : "If extra specialist context is needed, return one tool_call. Otherwise return final.";

  return `${instructions}

Tool-calling protocol:
- Available tools:
${toolList}
- ${stepRule}
- Return valid JSON only (no markdown, no backticks).
- JSON shape for tool call:
  {"type":"tool_call","tool":{"name":"<tool_name>","callId":"<id>","arguments":{...}}}
- JSON shape for final answer:
  {"type":"final","content":"<assistant response text>"}

${toolResultBlock}`;
}

async function generateWithOpenAiResponses({
  input,
  instructions,
  model,
  config
}: GenerateTextInput): Promise<string> {
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

async function generateWithOpenAiCompatible({
  input,
  instructions,
  model,
  config
}: GenerateTextInput): Promise<string> {
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

const openAiResponsesAdapter: ModelAdapter = {
  async generateText({ input, instructions, model, config }) {
    return generateWithOpenAiResponses({ input, instructions, model, config });
  },
  async generateTextWithTools({ input, instructions, model, config, tools, toolResults = [] }) {
    const protocolInstructions = buildToolProtocolInstructions(instructions, tools, toolResults);
    const rawOutput = await generateWithOpenAiResponses({
      input,
      instructions: protocolInstructions,
      model,
      config
    });

    return parseToolProtocolResponse(rawOutput);
  }
};

const openAiCompatibleAdapter: ModelAdapter = {
  async generateText({ input, instructions, model, config }) {
    return generateWithOpenAiCompatible({ input, instructions, model, config });
  },
  async generateTextWithTools({ input, instructions, model, config, tools, toolResults = [] }) {
    const protocolInstructions = buildToolProtocolInstructions(instructions, tools, toolResults);
    const rawOutput = await generateWithOpenAiCompatible({
      input,
      instructions: protocolInstructions,
      model,
      config
    });

    return parseToolProtocolResponse(rawOutput);
  }
};

export function getModelAdapter(config: ModelRuntimeConfig): ModelAdapter {
  if (config.provider === "openai") {
    return openAiResponsesAdapter;
  }

  return openAiCompatibleAdapter;
}
