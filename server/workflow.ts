import { buildWbsRowsFromMermaid, extractMermaidCode } from "./mermaid.js";
import { generateWorkflowOutput } from "./model-client.js";
import { DEFAULT_MODEL, DEFAULT_SYSTEM_PROMPT } from "./prompts.js";
import type { WbsRow } from "./types.js";
export type { WbsRow } from "./types.js";

export async function runWorkflow(
  input: string,
  systemPrompt: string = DEFAULT_SYSTEM_PROMPT,
  model: string = DEFAULT_MODEL
): Promise<{ outputText: string; mermaidCode: string | null; wbsRows: WbsRow[] }> {
  const trimmedInput = input.trim();
  if (!trimmedInput) {
    throw new Error("Input text cannot be empty.");
  }

  const outputText = await generateWorkflowOutput({
    input: trimmedInput,
    instructions: systemPrompt,
    model
  });
  const mermaidCode = extractMermaidCode(outputText);
  const wbsRows = mermaidCode ? buildWbsRowsFromMermaid(mermaidCode) : [];

  return {
    outputText,
    mermaidCode,
    wbsRows
  };
}
