import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SKILLS_DIR = path.resolve(__dirname, "skills");
const FALLBACK_SKILLS_DIR = path.resolve(__dirname, "../server/skills");

export type ProjectType = "demolition" | "it-upgrade";

export type SkillDefinition = {
  id: string;
  label: string;
  projectType: ProjectType;
  description: string;
  fileName: string;
};

export type SkillUsage = {
  skillId: string;
  label: string;
  projectType: ProjectType;
};

type SkillToolCallArgs = {
  skillId: string;
  reason?: string;
};

export const BUILT_IN_SKILLS: SkillDefinition[] = [
  {
    id: "demolition-works",
    label: "Demolition works",
    projectType: "demolition",
    description: "Use for demolition, strip-out, decommissioning, and enabling removal scopes.",
    fileName: "demolition-works.txt"
  },
  {
    id: "it-upgrades",
    label: "IT upgrades",
    projectType: "it-upgrade",
    description: "Use for IT upgrades, migrations, infrastructure refreshes, and platform changes.",
    fileName: "it-upgrades.txt"
  }
];

export function getAvailableSkills(): SkillDefinition[] {
  return BUILT_IN_SKILLS;
}

export async function getSkillDetailById(
  skillId: string
): Promise<(SkillDefinition & { content: string }) | null> {
  const skill = findSkill(skillId);
  if (!skill) {
    return null;
  }

  const filePath = await resolveSkillFilePath(skill.fileName);
  const content = (await readFile(filePath, "utf8")).trim();

  return {
    ...skill,
    content
  };
}

export function getSkillToolDefinition() {
  return {
    name: "get_skill_context",
    description:
      "Load detailed planning guidance for a specific project type skill when extra context is required.",
    parameters: {
      type: "object",
      properties: {
        skillId: {
          type: "string",
          enum: BUILT_IN_SKILLS.map((skill) => skill.id),
          description: "The skill ID to load."
        },
        reason: {
          type: "string",
          description: "Short reason this skill is needed for the current task."
        }
      },
      required: ["skillId"],
      additionalProperties: false
    }
  } as const;
}

function findSkill(skillId: string): SkillDefinition | null {
  const normalized = skillId.trim().toLowerCase();
  return BUILT_IN_SKILLS.find((skill) => skill.id === normalized) ?? null;
}

function parseToolCallArgs(rawArgumentsJson: string): SkillToolCallArgs | null {
  try {
    const parsed = JSON.parse(rawArgumentsJson) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }

    const skillId = "skillId" in parsed ? parsed.skillId : "";
    const reason = "reason" in parsed ? parsed.reason : undefined;
    if (typeof skillId !== "string" || !skillId.trim()) {
      return null;
    }

    return {
      skillId: skillId.trim(),
      reason: typeof reason === "string" && reason.trim() ? reason.trim() : undefined
    };
  } catch {
    return null;
  }
}

export async function resolveSkillToolCall(
  rawArgumentsJson: string
): Promise<{ usage: SkillUsage; toolOutput: string } | null> {
  const args = parseToolCallArgs(rawArgumentsJson);
  if (!args) {
    return null;
  }

  const skill = findSkill(args.skillId);
  if (!skill) {
    return null;
  }

  const filePath = await resolveSkillFilePath(skill.fileName);
  const content = (await readFile(filePath, "utf8")).trim();

  const usage: SkillUsage = {
    skillId: skill.id,
    label: skill.label,
    projectType: skill.projectType
  };

  const toolOutputSections = [
    `skillId: ${skill.id}`,
    `skillLabel: ${skill.label}`,
    `projectType: ${skill.projectType}`,
    args.reason ? `reason: ${args.reason}` : null,
    "",
    "skillContext:",
    content
  ].filter((line): line is string => Boolean(line));

  return {
    usage,
    toolOutput: toolOutputSections.join("\n")
  };
}

async function resolveSkillFilePath(fileName: string): Promise<string> {
  const primaryPath = path.resolve(SKILLS_DIR, fileName);
  try {
    await access(primaryPath);
    return primaryPath;
  } catch {
    const fallbackPath = path.resolve(FALLBACK_SKILLS_DIR, fileName);
    await access(fallbackPath);
    return fallbackPath;
  }
}
