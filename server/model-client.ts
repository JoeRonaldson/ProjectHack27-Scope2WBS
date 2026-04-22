import { getModelAdapter, type ToolResult } from "./model-adapters.js";
import { getModelRuntimeConfig } from "./model-config.js";
import {
  getSkillToolDefinition,
  resolveSkillToolCall,
  type SkillUsage
} from "./skills.js";

type WorkflowGenerationInput = {
  input: string;
  instructions: string;
  model: string;
  enforceSkillCall?: boolean;
  requiredSkillId?: string;
  requireSecondScopeSkillCall?: boolean;
};

type WorkflowGenerationResult = {
  outputText: string;
  skillsUsed: SkillUsage[];
};

export async function generateWorkflowOutput({
  input,
  instructions,
  model,
  enforceSkillCall = false,
  requiredSkillId,
  requireSecondScopeSkillCall = false
}: WorkflowGenerationInput): Promise<WorkflowGenerationResult> {
  const config = getModelRuntimeConfig();
  const effectiveModel = model.trim() || config.model;
  const adapter = getModelAdapter(config);
  const skillTool = getSkillToolDefinition();

  const firstPass = await adapter.generateTextWithTools({
    input,
    instructions,
    model: effectiveModel,
    config,
    tools: [skillTool]
  });

  const normalizedRequiredSkillId = requiredSkillId?.trim() || null;
  let fallbackOutputText = firstPass.outputText;
  let requestedSkillCall = firstPass.toolCalls.find((toolCall) => toolCall.name === skillTool.name);
  const requestedSkillId = getRequestedSkillId(requestedSkillCall?.argumentsJson);
  const requiresRetry =
    enforceSkillCall &&
    (!requestedSkillCall ||
      (normalizedRequiredSkillId ? requestedSkillId !== normalizedRequiredSkillId : false));
  if (requiresRetry) {
    const requiredSkillInstruction = normalizedRequiredSkillId
      ? `- The tool call must use skillId "${normalizedRequiredSkillId}".`
      : "";
    const enforcedInstructions = `${instructions}

Mandatory step for this response:
- You must call get_skill_context exactly once before giving the final answer.
- Your first response must be a tool_call JSON object.
- Do not return a final answer until the tool has been called.
- The tool call arguments must be valid JSON.
${requiredSkillInstruction}`;
    const enforcedPass = await adapter.generateTextWithTools({
      input,
      instructions: enforcedInstructions,
      model: effectiveModel,
      config,
      tools: [skillTool]
    });
    fallbackOutputText = enforcedPass.outputText;
    requestedSkillCall = enforcedPass.toolCalls.find((toolCall) => toolCall.name === skillTool.name);
  }

  if (!requestedSkillCall) {
    return {
      outputText: fallbackOutputText,
      skillsUsed: []
    };
  }

  const resolvedSkill = await resolveSkillToolCall(requestedSkillCall.argumentsJson);
  if (!resolvedSkill) {
    const fallbackText = await adapter.generateText({
      input,
      instructions: `${instructions}

The skill tool call request could not be resolved. Continue without any skill context and provide your best response.`,
      model: effectiveModel,
      config
    });
    return {
      outputText: fallbackText,
      skillsUsed: []
    };
  }

  const toolResults: ToolResult[] = [
    {
      name: skillTool.name,
      callId: requestedSkillCall.callId,
      output: resolvedSkill.toolOutput
    }
  ];
  const skillsUsed: SkillUsage[] = [resolvedSkill.usage];

  if (requireSecondScopeSkillCall && normalizedRequiredSkillId) {
    const secondSkillRequestInstructions = `${instructions}

Mandatory second skill step:
- A first skill context is already loaded.
- Call get_skill_context exactly once for a second skill based on the project scope.
- Do not use skillId "${normalizedRequiredSkillId}" for this second call.
- Return only a tool_call JSON response.`;

    let secondPassToolCall = (
      await adapter.generateTextWithTools({
        input,
        instructions: secondSkillRequestInstructions,
        model: effectiveModel,
        config,
        tools: [skillTool],
        toolResults
      })
    ).toolCalls.find((toolCall) => toolCall.name === skillTool.name);

    const secondSkillId = getRequestedSkillId(secondPassToolCall?.argumentsJson);
    const needsSecondRetry =
      !secondPassToolCall || !secondSkillId || secondSkillId === normalizedRequiredSkillId;

    if (needsSecondRetry) {
      const retrySecondInstructions = `${secondSkillRequestInstructions}

Hard requirement:
- The second tool call must use a different skillId than "${normalizedRequiredSkillId}".
- Use valid JSON arguments and include skillId.
- Do not return final content yet.`;
      secondPassToolCall = (
        await adapter.generateTextWithTools({
          input,
          instructions: retrySecondInstructions,
          model: effectiveModel,
          config,
          tools: [skillTool],
          toolResults
        })
      ).toolCalls.find((toolCall) => toolCall.name === skillTool.name);
    }

    const hasValidSecondCall =
      Boolean(secondPassToolCall) &&
      getRequestedSkillId(secondPassToolCall?.argumentsJson) !== normalizedRequiredSkillId;
    const resolvedSecondSkill =
      hasValidSecondCall && secondPassToolCall
        ? await resolveSkillToolCall(secondPassToolCall.argumentsJson)
        : null;

    if (resolvedSecondSkill) {
      const secondCallId = secondPassToolCall ? secondPassToolCall.callId : `fallback-${Date.now()}`;
      toolResults.push({
        name: skillTool.name,
        callId: secondCallId,
        output: resolvedSecondSkill.toolOutput
      });
      skillsUsed.push(resolvedSecondSkill.usage);
    } else {
      const inferredScopeSkillId = inferScopeSkillId(input, normalizedRequiredSkillId);
      if (inferredScopeSkillId) {
        const inferredResolvedSkill = await resolveSkillToolCall(
          JSON.stringify({
            skillId: inferredScopeSkillId,
            reason: "Fallback scope-based selection after invalid second tool call."
          })
        );

        if (inferredResolvedSkill) {
          toolResults.push({
            name: skillTool.name,
            callId: `fallback-${Date.now()}`,
            output: inferredResolvedSkill.toolOutput
          });
          skillsUsed.push(inferredResolvedSkill.usage);
        }
      }
    }
  }

  const secondPass = await adapter.generateTextWithTools({
    input,
    instructions,
    model: effectiveModel,
    config,
    tools: [skillTool],
    toolResults
  });

  const mergedSkillContext = toolResults.map((toolResult) => toolResult.output).join("\n\n");
  const finalText =
    secondPass.outputText ||
    (await adapter.generateText({
      input,
      instructions: `${instructions}

Use this loaded skill context directly:
${mergedSkillContext}`,
      model: effectiveModel,
      config
    }));

  return {
    outputText: finalText,
    skillsUsed
  };
}

function getRequestedSkillId(rawArgumentsJson: string | undefined): string | null {
  if (!rawArgumentsJson) {
    return null;
  }

  try {
    const parsed = JSON.parse(rawArgumentsJson) as unknown;
    if (!parsed || typeof parsed !== "object" || !("skillId" in parsed)) {
      return null;
    }
    const skillId = parsed.skillId;
    return typeof skillId === "string" && skillId.trim() ? skillId.trim() : null;
  } catch {
    return null;
  }
}

function inferScopeSkillId(input: string, forbiddenSkillId: string): string | null {
  const normalized = input.toLowerCase();
  const demolitionSignals = [
    "demolition",
    "decommission",
    "strip-out",
    "strip out",
    "excavation",
    "asbestos",
    "reinstatement"
  ];
  const itSignals = [
    "server",
    "network",
    "software",
    "system",
    "infrastructure",
    "cloud",
    "migration",
    "it upgrade"
  ];

  if (demolitionSignals.some((signal) => normalized.includes(signal)) && forbiddenSkillId !== "demolition-works") {
    return "demolition-works";
  }

  if (itSignals.some((signal) => normalized.includes(signal)) && forbiddenSkillId !== "it-upgrades") {
    return "it-upgrades";
  }

  return forbiddenSkillId === "demolition-works" ? "it-upgrades" : "demolition-works";
}
