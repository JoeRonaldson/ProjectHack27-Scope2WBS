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
};

type WorkflowGenerationResult = {
  outputText: string;
  skillsUsed: SkillUsage[];
};

export async function generateWorkflowOutput({
  input,
  instructions,
  model,
  enforceSkillCall = false
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

  let fallbackOutputText = firstPass.outputText;
  let requestedSkillCall = firstPass.toolCalls.find((toolCall) => toolCall.name === skillTool.name);
  if (!requestedSkillCall && enforceSkillCall) {
    const enforcedInstructions = `${instructions}

Mandatory step for this response:
- You must call get_skill_context exactly once before giving the final answer.
- First response must be a tool_call JSON object.`;
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
