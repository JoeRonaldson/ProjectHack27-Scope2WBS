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
};

type WorkflowGenerationResult = {
  outputText: string;
  skillsUsed: SkillUsage[];
};

export async function generateWorkflowOutput({
  input,
  instructions,
  model
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

  const requestedSkillCall = firstPass.toolCalls.find((toolCall) => toolCall.name === skillTool.name);
  if (!requestedSkillCall) {
    return {
      outputText: firstPass.outputText,
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

  const secondPass = await adapter.generateTextWithTools({
    input,
    instructions,
    model: effectiveModel,
    config,
    tools: [skillTool],
    toolResults
  });

  const finalText =
    secondPass.outputText ||
    (await adapter.generateText({
      input,
      instructions: `${instructions}

Use this loaded skill context directly:
${resolvedSkill.toolOutput}`,
      model: effectiveModel,
      config
    }));

  return {
    outputText: finalText,
    skillsUsed: [resolvedSkill.usage]
  };
}
