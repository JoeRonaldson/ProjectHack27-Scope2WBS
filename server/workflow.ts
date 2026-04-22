import OpenAI from "openai";

export const DEFAULT_MODEL = "gpt-5-mini";
export const DEFAULT_SYSTEM_PROMPT = `You are a highly experienced Senior Planner in Project Controls.

The user will provide a text file containing a Scope of Works document. Your role is to convert that document into a Work Breakdown Structure (WBS).

Rules:
- Base the WBS only on the content of the document.
- Do not infer, assume, or add scope not explicitly stated or clearly supported.
- Create up to 4 WBS levels where sufficient detail exists (1.1.2.1).
- Use fewer levels where detail is limited. Do not make up information.
- Organise the WBS logically in a planner-friendly structure.
- Use concise, professional activity and deliverable names.

Output:
- Return only a Mermaid diagram in a code block.
- Use Mermaid syntax that clearly shows hierarchy.
- No prose before or after the diagram.
- Root node = project title if available, otherwise "Project WBS".`;

export type WbsRow = {
  level: number;
  code: string;
  name: string;
};

let openAiClient: OpenAI | null = null;

function getOpenAiClient(): OpenAI {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not set.");
  }

  if (!openAiClient) {
    openAiClient = new OpenAI({ apiKey });
  }

  return openAiClient;
}

export async function runWorkflow(
  input: string,
  systemPrompt: string = DEFAULT_SYSTEM_PROMPT,
  model: string = DEFAULT_MODEL
): Promise<{ outputText: string; mermaidCode: string | null; wbsRows: WbsRow[] }> {
  const trimmedInput = input.trim();
  if (!trimmedInput) {
    throw new Error("Input text cannot be empty.");
  }

  const response = await getOpenAiClient().responses.create({
    model,
    instructions: systemPrompt,
    input: trimmedInput
  });

  const outputText = response.output_text.trim();
  const mermaidCode = extractMermaidCode(outputText);
  const wbsRows = mermaidCode ? buildWbsRowsFromMermaid(mermaidCode) : [];

  return {
    outputText,
    mermaidCode,
    wbsRows
  };
}

export function extractMermaidCode(text: string): string | null {
  const codeBlockMatch = text.match(/```mermaid\s*([\s\S]*?)```/i);
  if (codeBlockMatch) {
    return codeBlockMatch[1].trim();
  }

  const rawText = text.trim();
  if (rawText.startsWith("graph ") || rawText.startsWith("flowchart ")) {
    return rawText;
  }

  return null;
}

function parseMermaidNodeFragment(fragment: string): { nodeId: string; label: string | null } | null {
  const cleaned = fragment.trim().replace(/;$/, "");
  const idMatch = cleaned.match(/^([A-Za-z][A-Za-z0-9_]*)/);
  if (!idMatch) {
    return null;
  }

  const nodeId = idMatch[1];
  const bracketMatch = cleaned.match(/\[(.*?)\]/);
  const parenMatch = cleaned.match(/\((.*?)\)/);
  const label = bracketMatch?.[1] ?? parenMatch?.[1] ?? null;

  return {
    nodeId,
    label: label ? label.replace(/^["']|["']$/g, "").trim() : null
  };
}

export function buildWbsRowsFromMermaid(mermaidCode: string): WbsRow[] {
  const nodeLabels = new Map<string, string>();
  const children = new Map<string, string[]>();
  const destinations = new Set<string>();
  const nodeOrder: string[] = [];

  const rememberNode = (nodeId: string) => {
    if (!children.has(nodeId)) {
      children.set(nodeId, []);
    }
    if (!nodeOrder.includes(nodeId)) {
      nodeOrder.push(nodeId);
    }
  };

  for (const rawLine of mermaidCode.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("%%")) {
      continue;
    }
    if (line.startsWith("graph ") || line.startsWith("flowchart ")) {
      continue;
    }

    if (line.includes("-->")) {
      const [left, rightRaw] = line.split("-->", 2);
      let right = rightRaw.trim();
      if (right.startsWith("|")) {
        const secondPipe = right.indexOf("|", 1);
        if (secondPipe > 0) {
          right = right.slice(secondPipe + 1).trim();
        }
      }

      const leftNode = parseMermaidNodeFragment(left);
      const rightNode = parseMermaidNodeFragment(right);
      if (!leftNode || !rightNode) {
        continue;
      }

      rememberNode(leftNode.nodeId);
      rememberNode(rightNode.nodeId);
      destinations.add(rightNode.nodeId);

      const srcChildren = children.get(leftNode.nodeId) ?? [];
      if (!srcChildren.includes(rightNode.nodeId)) {
        srcChildren.push(rightNode.nodeId);
      }
      children.set(leftNode.nodeId, srcChildren);

      if (leftNode.label) {
        nodeLabels.set(leftNode.nodeId, leftNode.label);
      }
      if (rightNode.label) {
        nodeLabels.set(rightNode.nodeId, rightNode.label);
      }
      continue;
    }

    const node = parseMermaidNodeFragment(line);
    if (!node) {
      continue;
    }
    rememberNode(node.nodeId);
    if (node.label) {
      nodeLabels.set(node.nodeId, node.label);
    }
  }

  if (!nodeOrder.length) {
    return [];
  }

  let roots = nodeOrder.filter((id) => !destinations.has(id));
  if (!roots.length) {
    roots = [nodeOrder[0]];
  }

  const visited = new Set<string>();
  const rows: WbsRow[] = [];

  const dfs = (nodeId: string, level: number, code: string) => {
    if (visited.has(nodeId)) {
      return;
    }
    visited.add(nodeId);
    rows.push({
      level,
      code,
      name: nodeLabels.get(nodeId) ?? nodeId
    });

    const childrenNodes = children.get(nodeId) ?? [];
    childrenNodes.forEach((childId, index) => {
      dfs(childId, level + 1, `${code}.${index + 1}`);
    });
  };

  let topLevel = 1;
  roots.forEach((root) => {
    if (!visited.has(root)) {
      dfs(root, 1, `${topLevel}`);
      topLevel += 1;
    }
  });

  nodeOrder.forEach((nodeId) => {
    if (!visited.has(nodeId)) {
      dfs(nodeId, 1, `${topLevel}`);
      topLevel += 1;
    }
  });

  return rows;
}
