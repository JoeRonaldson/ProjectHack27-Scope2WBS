import { buildWbsRowsFromMermaid, extractMermaidCode } from "./mermaid.js";
import { generateWorkflowOutput } from "./model-client.js";
import { DEFAULT_MODEL, DEFAULT_SYSTEM_PROMPT } from "./prompts.js";
import type { SkillUsage } from "./skills.js";
import type { WbsRow } from "./types.js";
export type { WbsRow } from "./types.js";

export type WorkflowStage = "initial" | "awaiting-clarification" | "wbs-ready";
export type WorkflowMode = "clarification" | "wbs" | "chat";

type RunWorkflowInput = {
  input: string;
  systemPrompt?: string;
  model?: string;
  stage?: WorkflowStage;
  initialScope?: string | null;
  latestMermaid?: string | null;
};

type WorkflowResult = {
  mode: WorkflowMode;
  assistantText: string;
  outputText: string;
  mermaidCode: string | null;
  wbsRows: WbsRow[];
  skillsUsed: SkillUsage[];
  nextStage: WorkflowStage;
  initialScope: string;
  latestMermaid: string | null;
};

function buildClarificationInstructions(basePrompt: string): string {
  return `${basePrompt}

Conversation protocol:
- Analyse the user's first scope message.
- Immediately after receiving the scope document, call get_skill_context exactly once with skillId "how-to-create-wbs-pmi" before asking any clarifying questions.
- Ask exactly 2 high-impact clarifying questions that are required to improve WBS quality.
- Keep both questions short and numbered as Q1 and Q2.
- For each question, provide 3 short options labelled A, B, and C.
- Present both questions in the same message.
- Do not generate a WBS yet.
- Do not include Mermaid output in this step.`;
}

function buildWbsGenerationInstructions(basePrompt: string): string {
  return `${basePrompt}

Conversation protocol:
- You now have the original scope message and the user's clarifications.
- Generate the WBS now.
- Return only a Mermaid diagram in a code block, with no extra prose.`;
}

function buildFollowUpLoopInstructions(basePrompt: string): string {
  return `${basePrompt}

Conversation protocol for ongoing chat:
- Continue the conversation as a WBS copilot.
- If the user requests a new or revised WBS, return only Mermaid in a code block.
- If the user asks a general question, answer briefly in plain text (no Mermaid).`;
}

export async function runWorkflow(
  request: RunWorkflowInput
): Promise<WorkflowResult> {
  const trimmedInput = request.input.trim();
  if (!trimmedInput) {
    throw new Error("Input text cannot be empty.");
  }

  const systemPrompt = request.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
  const model = request.model ?? DEFAULT_MODEL;
  const stage = request.stage ?? "initial";
  const persistedInitialScope = request.initialScope?.trim() ?? "";
  const initialScope = persistedInitialScope || trimmedInput;
  const latestMermaid = request.latestMermaid?.trim() || null;

  if (stage === "initial") {
    const { outputText, skillsUsed } = await generateWorkflowOutput({
      input: trimmedInput,
      instructions: buildClarificationInstructions(systemPrompt),
      model,
      enforceSkillCall: true,
      requiredSkillId: "how-to-create-wbs-pmi",
      requireSecondScopeSkillCall: true
    });

    return {
      mode: "clarification",
      assistantText: outputText,
      outputText,
      mermaidCode: null,
      wbsRows: [],
      skillsUsed,
      nextStage: "awaiting-clarification",
      initialScope,
      latestMermaid: null
    };
  }

  if (stage === "awaiting-clarification") {
    const generationInput = [
      "Original scope message:",
      initialScope,
      "",
      "Clarification answers:",
      trimmedInput
    ].join("\n");

    const { outputText, skillsUsed } = await generateWorkflowOutput({
      input: generationInput,
      instructions: buildWbsGenerationInstructions(systemPrompt),
      model
    });
    const mermaidCode = extractMermaidCode(outputText);
    const wbsRows = mermaidCode ? buildWbsRowsFromMermaid(mermaidCode) : [];

    return {
      mode: "wbs",
      assistantText: mermaidCode ? "WBS generated from your scope and clarifications." : outputText,
      outputText,
      mermaidCode,
      wbsRows,
      skillsUsed,
      nextStage: "wbs-ready",
      initialScope,
      latestMermaid: mermaidCode
    };
  }

  const followUpInput = [
    "Original scope message:",
    initialScope,
    "",
    "Current WBS Mermaid (if available):",
    latestMermaid ?? "None",
    "",
    "Latest user message:",
    trimmedInput
  ].join("\n");

  const { outputText, skillsUsed } = await generateWorkflowOutput({
    input: followUpInput,
    instructions: buildFollowUpLoopInstructions(systemPrompt),
    model
  });
  const mermaidCode = extractMermaidCode(outputText);
  const wbsRows = mermaidCode ? buildWbsRowsFromMermaid(mermaidCode) : [];

  return {
    mode: mermaidCode ? "wbs" : "chat",
    assistantText: mermaidCode ? "Updated WBS generated." : outputText,
    outputText,
    mermaidCode,
    wbsRows,
    skillsUsed,
    nextStage: "wbs-ready",
    initialScope,
    latestMermaid: mermaidCode ?? latestMermaid
  };
}
