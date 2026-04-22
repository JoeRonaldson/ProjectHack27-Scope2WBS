import { getModelAdapter } from "./model-adapters.js";
import { getModelRuntimeConfig } from "./model-config.js";

type WorkflowGenerationInput = {
  input: string;
  instructions: string;
  model: string;
};

export async function generateWorkflowOutput({
  input,
  instructions,
  model
}: WorkflowGenerationInput): Promise<string> {
  const config = getModelRuntimeConfig();
  const effectiveModel = model.trim() || config.model;
  const adapter = getModelAdapter(config);

  return adapter.generateText({
    input,
    instructions,
    model: effectiveModel,
    config
  });
}
