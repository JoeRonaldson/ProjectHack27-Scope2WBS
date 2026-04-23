import { ChangeEvent, FormEvent, KeyboardEvent, MouseEvent, useEffect, useRef, useState } from "react";
import mermaid from "mermaid";
import scope2wbsLogo from "./assets/scope2wbs-full-logo.svg";
import teamsTopbarLogo from "../Microsoft_Teams-Logo.wine.png";

type WbsRow = {
  level: number;
  code: string;
  name: string;
};

type ProjectNode = {
  id: string;
  label: string;
  children: ProjectNode[];
};

type ProjectTree = {
  nodes: ProjectNode[];
};

type WorkflowStage = "initial" | "awaiting-clarification" | "wbs-ready";
type WorkflowMode = "clarification" | "wbs" | "chat";
type ProjectType = "demolition" | "it-upgrade" | "wbs-framework";

type SkillUsage = {
  skillId: string;
  label: string;
  projectType: ProjectType;
};

type SkillDefinition = {
  id: string;
  label: string;
  projectType: ProjectType;
  description: string;
  fileName: string;
};

type SkillDetail = SkillDefinition & {
  content: string;
};

type WorkflowResponse = {
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

type ChatMessage =
  | {
      id: string;
      role: "user";
      text: string;
    }
  | {
      id: string;
      role: "assistant";
      result?: WorkflowResponse;
      toolCallSkill?: SkillUsage;
      toolCallEvent?: boolean;
      text?: string;
      pending?: boolean;
      error?: boolean;
    };

const DEFAULT_PROMPT = `You are a highly experienced Senior Planner in Project Controls.

The user will provide a text document. Your role is to convert that document into a Work Breakdown Structure (WBS).

Rules:
- Base the WBS only on the content of the document.
- Do not infer, assume, or add scope not explicitly stated or clearly supported.
- Create up to 4 WBS levels where sufficient detail exists (1.1.2.1).
- Use fewer levels where detail is limited. Do not make up information.
- Organise the WBS logically in a planner-friendly structure.
- Use concise, professional activity and deliverable names. Use the scope document as naming inspirations
- Follow the conversation-stage instructions exactly for whether to ask questions, chat, or output Mermaid.
- During clarification stage, ask 2 short questions in one message and provide 3 short answer choices (A/B/C) for each. The questions should be about the scope of the project not the type of output.
- When outputting Mermaid, use syntax that clearly shows hierarchy and set root node to project title if available, otherwise "Project WBS".`;


const ASSISTANT_NAME = "Scope2WBS";
const PYTHON_BACKEND_URL = import.meta.env.VITE_PYTHON_BACKEND_URL ?? "http://localhost:8000";

function AssistantAvatar() {
  return (
    <div className="avatar assistantAvatar">
      <img src={scope2wbsLogo} alt="Scope2WBS full logo" />
    </div>
  );
}

function buildProjectFromWbsRows(rows: WbsRow[]): ProjectTree {
  const sortedRows = [...rows].sort((left, right) => left.code.localeCompare(right.code));
  const nodeMap = new Map<string, ProjectNode>();
  const rootNodes: ProjectNode[] = [];

  for (const row of sortedRows) {
    nodeMap.set(row.code, {
      id: row.code,
      label: row.name,
      children: []
    });
  }

  for (const row of sortedRows) {
    const node = nodeMap.get(row.code);
    if (!node) {
      continue;
    }
    const parentCode = row.code.includes(".") ? row.code.split(".").slice(0, -1).join(".") : "";
    const parentNode = parentCode ? nodeMap.get(parentCode) : undefined;
    if (parentNode) {
      parentNode.children.push(node);
    } else {
      rootNodes.push(node);
    }
  }

  return { nodes: rootNodes };
}

function buildMermaidDefinition(project: ProjectTree): string {
  let mermaidText = "graph TD\nRoot[\"WBS\"]\n";
  let counter = 0;

  const walk = (nodes: ProjectNode[], parent = "Root") => {
    nodes.forEach((node) => {
      counter += 1;
      const id = `N${counter}`;
      const safeLabel = node.label.replace(/"/g, '\\"');
      mermaidText += `${parent} --> ${id}["${safeLabel}"]\n`;
      if (node.children.length) {
        walk(node.children, id);
      }
    });
  };

  walk(project.nodes);
  return mermaidText;
}

function MermaidChart({ project }: { project: ProjectTree }) {
  const chartRef = useRef<HTMLDivElement | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const chartElement = chartRef.current;
    if (!chartElement) {
      return;
    }

    const chartId = `generatedChart-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const mermaidDefinition = buildMermaidDefinition(project);
    let cancelled = false;

    mermaid
      .render(chartId, mermaidDefinition)
      .then(({ svg }) => {
        if (!cancelled && chartRef.current) {
          chartRef.current.innerHTML = svg;
          setError(null);
        }
      })
      .catch((renderError) => {
        console.error(renderError);
        if (!cancelled) {
          setError("Chart error");
        }
      });

    return () => {
      cancelled = true;
    };
  }, [project]);

  const downloadChart = () => {
    const svgElement = chartRef.current?.querySelector("svg");
    if (!svgElement) {
      return;
    }

    const svgBlob = new Blob([svgElement.outerHTML], { type: "image/svg+xml;charset=utf-8" });
    const downloadUrl = URL.createObjectURL(svgBlob);
    const anchor = document.createElement("a");
    anchor.href = downloadUrl;
    anchor.download = "wbs-chart.svg";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(downloadUrl);
  };

  return (
    <div className="bg-white p-4 rounded shadow">
      <div ref={chartRef} />
      {error ? <p className="error">{error}</p> : null}
      <div className="mt-4">
        <button type="button" onClick={downloadChart} className="placeholderSkillButton">
          Download Chart
        </button>
      </div>
    </div>
  );
}

function App() {
  const [input, setInput] = useState("");
  const [systemPrompt, setSystemPrompt] = useState(DEFAULT_PROMPT);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<"systemPrompt" | "skills" | "rag">("systemPrompt");
  const [loading, setLoading] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [workflowStage, setWorkflowStage] = useState<WorkflowStage>("initial");
  const [initialScope, setInitialScope] = useState("");
  const [latestMermaid, setLatestMermaid] = useState<string | null>(null);
  const [availableSkills, setAvailableSkills] = useState<SkillDefinition[]>([]);
  const [selectedSkill, setSelectedSkill] = useState<SkillDetail | null>(null);
  const [skillDetailError, setSkillDetailError] = useState<string | null>(null);
  const [loadingSkillId, setLoadingSkillId] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadedFileName, setUploadedFileName] = useState<string | null>(null);
  const messageStreamRef = useRef<HTMLDivElement | null>(null);
  const composerInputRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const messageStream = messageStreamRef.current;
    if (!messageStream) {
      return;
    }
    messageStream.scrollTop = messageStream.scrollHeight;
  }, [messages]);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const response = await fetch("/api/skills");
        if (!response.ok) {
          return;
        }

        const payload = (await response.json()) as { skills?: SkillDefinition[] };
        if (!cancelled && Array.isArray(payload.skills)) {
          setAvailableSkills(payload.skills);
        }
      } catch {
        // Keep chat functional if skills endpoint is unavailable.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "loose"
    });
  }, []);


  const createCsvData = (rows: WbsRow[]) => {
    if (!rows.length) {
      return "WBS Level,WBS Code,WBS Name\n";
    }
    const csvRows = rows.map((row) => {
      const escapedName = row.name.includes(",") ? `"${row.name.replace(/"/g, "\"\"")}"` : row.name;
      return `${row.level},${row.code},${escapedName}`;
    });
    return ["WBS Level,WBS Code,WBS Name", ...csvRows].join("\n");
  };

  const submitInput = async (text: string, userMessageText?: string) => {
    const trimmedInput = text.trim();
    if (!trimmedInput) {
      return;
    }

    setLoading(true);
    const userMessageId = `user-${Date.now()}`;
    const assistantMessageId = `assistant-${Date.now()}`;
    const pendingText =
      workflowStage === "initial"
        ? "Reviewing scope and drafting clarifying questions..."
        : workflowStage === "awaiting-clarification"
          ? "Generating WBS from your clarifications..."
          : "Working on your follow-up...";
    setMessages((previous) => [
      ...previous,
      {
        id: userMessageId,
        role: "user",
        text: userMessageText ?? trimmedInput
      },
      {
        id: assistantMessageId,
        role: "assistant",
        pending: true,
        text: pendingText
      }
    ]);
    setInput("");
    setUploadError(null);

    try {
      const response = await fetch("/api/workflow", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          input: trimmedInput,
          systemPrompt,
          stage: workflowStage,
          initialScope: initialScope || null,
          latestMermaid
        })
      });

      const data = (await response.json()) as WorkflowResponse | { error: string };
      if (!response.ok) {
        const apiError = "error" in data ? data.error : "Request failed.";
        throw new Error(apiError);
      }

      const workflowResult = data as WorkflowResponse;
      setWorkflowStage(workflowResult.nextStage);
      setInitialScope(workflowResult.initialScope);
      setLatestMermaid(workflowResult.latestMermaid);
      if (!workflowResult.skillsUsed.length) {
        setMessages((previous) =>
          previous.map((message) =>
            message.id === assistantMessageId
              ? {
                  id: assistantMessageId,
                  role: "assistant",
                  result: workflowResult
                }
              : message
          )
        );
      } else {
        const toolCallMessageId = `${assistantMessageId}-tool-call`;
        const delayedResponseMessageId = `${assistantMessageId}-response`;

        setMessages((previous) => {
          const nextMessages: ChatMessage[] = [];
          previous.forEach((message) => {
            if (message.id !== assistantMessageId) {
              nextMessages.push(message);
              return;
            }

            workflowResult.skillsUsed.forEach((skill, skillIndex) => {
              nextMessages.push({
                id: `${toolCallMessageId}-${skillIndex}`,
                role: "assistant",
                toolCallEvent: true,
                toolCallSkill: skill
              });
            });

            nextMessages.push({
              id: delayedResponseMessageId,
              role: "assistant",
              pending: true,
              text: "Using skill context to draft response..."
            });
          });
          return nextMessages;
        });

        window.setTimeout(() => {
          setMessages((previous) =>
            previous.map((message) =>
              message.id === delayedResponseMessageId
                ? {
                    id: delayedResponseMessageId,
                    role: "assistant",
                    result: workflowResult
                  }
                : message
            )
          );
        }, 450);
      }
    } catch (submitError) {
      const message = submitError instanceof Error ? submitError.message : "Unexpected error";
      setMessages((previous) =>
        previous.map((chatMessage) =>
          chatMessage.id === assistantMessageId
            ? {
                id: assistantMessageId,
                role: "assistant",
                text: message,
                error: true
              }
            : chatMessage
        )
      );
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    await submitInput(input);
  };

  const handleFileUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    setUploadError(null);
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    const allowedTypes = [
      "text/plain",
      "text/markdown",
      "text/csv",
      "application/json",
      "application/pdf",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    ];
    const allowedExtensions = [".txt", ".md", ".markdown", ".csv", ".json", ".pdf", ".docx"];
    const fileName = file.name || "uploaded document";
    const hasValidType = allowedTypes.includes(file.type);
    const hasValidExtension = allowedExtensions.some((ext) => fileName.toLowerCase().endsWith(ext));

    if (!hasValidType && !hasValidExtension) {
      setUploadError("Please upload a supported document (.txt, .md, .csv, .json, .pdf, .docx).");
      event.target.value = "";
      return;
    }

    try {
      const formData = new FormData();
      formData.append("document", file);
      const response = await fetch(`${PYTHON_BACKEND_URL}/generate-wbs-from-upload`, {
        method: "POST",
        body: formData
      });
      const payload = (await response.json()) as {
        scopeText?: string;
        fileName?: string;
        wbs?: WbsRow[];
        error?: string;
        detail?: string;
      };
      if (!response.ok || !Array.isArray(payload.wbs)) {
        throw new Error(payload.detail ?? payload.error ?? "Unable to generate WBS from uploaded document.");
      }
      setUploadedFileName(fileName);
      const userMessageId = `user-${Date.now()}`;
      const assistantMessageId = `assistant-${Date.now()}`;
      setMessages((previous) => [
        ...previous,
        {
          id: userMessageId,
          role: "user",
          text: `Uploaded document: ${payload.fileName ?? fileName}`
        },
        {
          id: assistantMessageId,
          role: "assistant",
          result: {
            mode: "wbs",
            assistantText: "WBS generated from uploaded document via Python backend.",
            outputText: "",
            mermaidCode: null,
            wbsRows: payload.wbs ?? [],
            skillsUsed: [],
            nextStage: "wbs-ready",
            initialScope: payload.scopeText ?? "",
            latestMermaid: null
          }
        }
      ]);
      setWorkflowStage("wbs-ready");
      setInitialScope(payload.scopeText ?? "");
      setLatestMermaid(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to upload the selected file.";
      setUploadError(`Upload failed: ${message}`);
    } finally {
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
  };

  const closeSettings = () => {
    setSettingsOpen(false);
  };

  const closeSkillDetail = () => {
    setSelectedSkill(null);
    setSkillDetailError(null);
  };

  const openSettings = (tab: "systemPrompt" | "skills" | "rag" = "systemPrompt") => {
    setSettingsTab(tab);
    setSettingsOpen(true);
  };

  const stopSettingsClose = (event: MouseEvent<HTMLElement>) => {
    event.stopPropagation();
  };

  const openSkillDetail = async (skillId: string) => {
    setSkillDetailError(null);
    setLoadingSkillId(skillId);
    try {
      const response = await fetch(`/api/skills/${encodeURIComponent(skillId)}`);
      const payload = (await response.json()) as { skill?: SkillDetail; error?: string };
      if (!response.ok || !payload.skill) {
        throw new Error(payload.error ?? "Could not load skill details.");
      }
      setSelectedSkill(payload.skill);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not load skill details.";
      setSelectedSkill(null);
      setSkillDetailError(message);
    } finally {
      setLoadingSkillId(null);
    }
  };

  const resizeComposerInput = () => {
    const textarea = composerInputRef.current;
    if (!textarea) {
      return;
    }
    textarea.style.height = "auto";
    const computedLineHeight = Number.parseFloat(window.getComputedStyle(textarea).lineHeight) || 21;
    const maxHeight = computedLineHeight * 5;
    const nextHeight = Math.min(textarea.scrollHeight, maxHeight);
    textarea.style.height = `${nextHeight}px`;
    textarea.style.overflowY = textarea.scrollHeight > maxHeight ? "auto" : "hidden";
  };

  const handleComposerKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || loading || event.nativeEvent.isComposing) {
      return;
    }
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  };

  useEffect(() => {
    resizeComposerInput();
  }, [input]);

  return (
    <main className="teamsShell">
      <header className="globalTopbar" aria-label="Global app bar">
        <button type="button" className="topbarTeamsButton" aria-label="Microsoft Teams home">
          <img src={teamsTopbarLogo} alt="Microsoft Teams logo" className="topbarTeamsLogo" />
        </button>

        <button type="button" className="topbarSearch" aria-label="Search">
          <span className="topbarSearchIcon" aria-hidden="true">
            <svg viewBox="0 0 24 24">
              <path d="M10.2 4a6.2 6.2 0 1 0 3.84 11.06l4 4a1 1 0 1 0 1.42-1.42l-4-4A6.2 6.2 0 0 0 10.2 4zm0 2a4.2 4.2 0 1 1 0 8.4 4.2 4.2 0 0 1 0-8.4z" />
            </svg>
          </span>
          <span className="topbarSearchText">Search</span>
          <span className="topbarSearchShortcut">(&#8997; &#8984; E)</span>
        </button>

        <div className="topbarRight">
          <button type="button" className="topbarIconButton" aria-label="More options">
            ...
          </button>
          <span className="topbarStatusText">Projecting Success</span>
          <span className="topbarOnlineDot" aria-label="Online" />
        </div>
      </header>

      <div className="teamsApp">
        <aside className="teamsRail" aria-label="Primary navigation">
        <button type="button" className="railItem">
          <span className="railGlyph" aria-hidden="true">
            <svg viewBox="0 0 24 24">
              <path d="M12 3a6.5 6.5 0 0 0-6.5 6.5v3.36L3.7 15v1.25h16.6V15l-1.8-2.14V9.5A6.5 6.5 0 0 0 12 3zm0 18.3a2.6 2.6 0 0 0 2.54-2h-5.08a2.6 2.6 0 0 0 2.54 2z" />
            </svg>
          </span>
          <span>Activity</span>
        </button>
        <button type="button" className="railItem active">
          <span className="railGlyph" aria-hidden="true">
            <svg viewBox="0 0 24 24">
              <path d="M5 5.5h14a1.5 1.5 0 0 1 1.5 1.5v8A1.5 1.5 0 0 1 19 16.5h-7l-4.5 3v-3H5A1.5 1.5 0 0 1 3.5 15V7A1.5 1.5 0 0 1 5 5.5z" />
            </svg>
          </span>
          <span>Chat</span>
        </button>
        <button
          type="button"
          className="railItem railItemBottom"
          aria-label="Open settings"
          onClick={() => openSettings("systemPrompt")}
        >
          <span className="railGlyph" aria-hidden="true">
            <svg viewBox="0 0 24 24">
              <path d="M19.14 12.94c.03-.3.05-.62.05-.94s-.02-.64-.05-.94l2.03-1.58a.49.49 0 0 0 .12-.63l-1.92-3.32a.49.49 0 0 0-.59-.22l-2.39.96a7.22 7.22 0 0 0-1.63-.94l-.36-2.54a.48.48 0 0 0-.48-.4h-3.84a.48.48 0 0 0-.48.4l-.36 2.54a7.7 7.7 0 0 0-1.63.94l-2.39-.96a.48.48 0 0 0-.59.22L2.34 8.85a.48.48 0 0 0 .12.63l2.03 1.58a7.73 7.73 0 0 0-.05.94c0 .32.02.64.05.94l-2.03 1.58a.49.49 0 0 0-.12.63l1.92 3.32a.49.49 0 0 0 .59.22l2.39-.96c.5.39 1.05.71 1.63.94l.36 2.54a.48.48 0 0 0 .48.4h3.84a.48.48 0 0 0 .48-.4l.36-2.54c.58-.23 1.13-.55 1.63-.94l2.39.96a.49.49 0 0 0 .59-.22l1.92-3.32a.49.49 0 0 0-.12-.63l-2.03-1.58zM12 15.5A3.5 3.5 0 1 1 12 8.5a3.5 3.5 0 0 1 0 7z" />
            </svg>
          </span>
          <span>Settings</span>
        </button>
        </aside>

        <aside className="teamsSidebar">
        <header className="sidebarHeader">
          <h2>Chat</h2>
          <div className="sidebarIcons">
            <button type="button" aria-label="More options">
              <span aria-hidden="true">...</span>
            </button>
            <button type="button" aria-label="Search">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M10.2 4a6.2 6.2 0 1 0 3.84 11.06l4 4a1 1 0 1 0 1.42-1.42l-4-4A6.2 6.2 0 0 0 10.2 4zm0 2a4.2 4.2 0 1 1 0 8.4 4.2 4.2 0 0 1 0-8.4z" />
              </svg>
            </button>
            <button type="button" aria-label="New message">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M4 4.75A1.75 1.75 0 0 1 5.75 3h8.5A1.75 1.75 0 0 1 16 4.75v3.5h-1.5v-3.5a.25.25 0 0 0-.25-.25h-8.5a.25.25 0 0 0-.25.25v12.5c0 .14.11.25.25.25h6.5V19h-6.5A1.75 1.75 0 0 1 4 17.25V4.75zm15.74 5.2a1.5 1.5 0 0 0-2.12 0l-4.9 4.9a1 1 0 0 0-.27.5l-.45 2.63a.5.5 0 0 0 .58.58l2.63-.45a1 1 0 0 0 .5-.27l4.9-4.9a1.5 1.5 0 0 0 0-2.12l-.87-.87z" />
              </svg>
            </button>
            <button type="button" aria-label="Expand">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M7.4 9.2L12 13.8l4.6-4.6 1.4 1.4-6 6-6-6z" />
              </svg>
            </button>
          </div>
        </header>

        <div className="sidebarFilterRow">
          <button type="button" className="sidebarChip active">
            Unread
          </button>
          <button type="button" className="sidebarChip">
            Channels
          </button>
          <button type="button" className="sidebarChip">
            Chats
          </button>
          <button type="button" className="sidebarFilterToggle" aria-label="Filter menu">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M7.4 9.2L12 13.8l4.6-4.6 1.4 1.4-6 6-6-6z" />
            </svg>
          </button>
        </div>

        <div className="sidebarBody">
          <section className="sidebarSection">
            <button type="button" className="sectionTitle">
              <span className="chevron" aria-hidden="true">
                <svg viewBox="0 0 24 24">
                  <path d="M8.2 6.8L13.4 12l-5.2 5.2 1.4 1.4 6.6-6.6-6.6-6.6z" />
                </svg>
              </span>
              <span>Chats</span>
            </button>
          </section>

          <section className="sidebarSection">
            <button type="button" className="sectionTitle">
              <span className="chevron down" aria-hidden="true">
                <svg viewBox="0 0 24 24">
                  <path d="M7.4 9.2L12 13.8l4.6-4.6 1.4 1.4-6 6-6-6z" />
                </svg>
              </span>
              <span>Teams and channels</span>
            </button>

            <div className="treeNode root">
              <span className="chevron" aria-hidden="true">
                <svg viewBox="0 0 24 24">
                  <path d="M7.4 9.2L12 13.8l4.6-4.6 1.4 1.4-6 6-6-6z" />
                </svg>
              </span>
              <span className="teamBadge">PH27</span>
              <span>Projet! Hack 27</span>
            </div>

            <button type="button" className="treeLeaf">
              Event General
            </button>

            <button type="button" className="treeLeaf active">
              Team 2A - Scope2WBS
            </button>
          </section>
        </div>
        </aside>

        <section className="teamsMain">
        <header className="channelTopbar">
          <div className="channelTitleWrap">
            <div className="channelTitleGroup">
              <span className="channelMiniBadge">PH27</span>
              <h1>Team 2A - Scope2WBS</h1>
            </div>
            <nav className="channelTabs" aria-label="Channel tabs">
              <button type="button" className="tab active">
                Conversation
              </button>
              <button type="button" className="tab">
                Shared
              </button>
              <button type="button" className="tab">
                Notes
              </button>
              <button type="button" className="tab">
                Miro Board
              </button>
            </nav>
          </div>

          <div className="channelActions">
            <button type="button" className="meetNowButton">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M3.5 7.5A1.5 1.5 0 0 1 5 6h9a1.5 1.5 0 0 1 1.5 1.5v1.2l3-1.8a1 1 0 0 1 1.5.86v8.5a1 1 0 0 1-1.5.86l-3-1.8v1.2A1.5 1.5 0 0 1 14 18h-9a1.5 1.5 0 0 1-1.5-1.5v-9zM5 7.5v9h9v-9H5z" />
              </svg>
              Meet now
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M7.4 9.2L12 13.8l4.6-4.6 1.4 1.4-6 6-6-6z" />
              </svg>
            </button>
            <span className="channelActionsDivider" aria-hidden="true" />
            <button
              type="button"
              className="channelActionIcon"
              aria-label="Open chat details"
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M4.5 5.5A1.5 1.5 0 0 1 6 4h12a1.5 1.5 0 0 1 1.5 1.5v9A1.5 1.5 0 0 1 18 16h-6l-4.5 3V16H6a1.5 1.5 0 0 1-1.5-1.5v-9zM6 5.5v9h3v1.7l2.6-1.7H18v-9H6z" />
              </svg>
            </button>
            <button type="button" className="channelActionIcon" aria-label="Search channel">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M10.2 4a6.2 6.2 0 1 0 3.84 11.06l4 4a1 1 0 1 0 1.42-1.42l-4-4A6.2 6.2 0 0 0 10.2 4zm0 2a4.2 4.2 0 1 1 0 8.4 4.2 4.2 0 0 1 0-8.4z" />
              </svg>
            </button>
            <button type="button" className="channelActionIcon" aria-label="Open panel">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5v-13zM5.5 5.5v13h13v-13h-13zm3 1.5h1.5v10H8.5V7zm5 0h1.5v10h-1.5V7z" />
              </svg>
            </button>
            <button type="button" className="channelActionMore" aria-label="More options">
              ...
            </button>
          </div>
        </header>

        <section className="channelBody">
          <div className="messageStream" ref={messageStreamRef}>
            <article className="chatMessage left">
              <AssistantAvatar />
              <div className="bubble">
                <p className="authorLine">{ASSISTANT_NAME}</p>
                <p>
                  Send me the Project Scope documents and I will create a WBS for you.
                </p>
              </div>
            </article>

            {messages.map((message) => {
                if (message.role === "user") {
                  return (
                    <article key={message.id} className="chatMessage right">
                      <div className="bubble">
                        <p>{message.text}</p>
                      </div>
                    </article>
                  );
                }

                if (message.pending) {
                  return (
                    <article key={message.id} className="chatMessage left">
                      <AssistantAvatar />
                      <div className="bubble">
                        <p className="authorLine">{ASSISTANT_NAME}</p>
                        <p>{message.text}</p>
                      </div>
                    </article>
                  );
                }

                if (message.error) {
                  return (
                    <article key={message.id} className="chatMessage left">
                      <AssistantAvatar />
                      <div className="bubble">
                        <p className="authorLine">{ASSISTANT_NAME}</p>
                        <p className="error">{message.text}</p>
                      </div>
                    </article>
                  );
                }

                if (message.toolCallEvent && message.toolCallSkill) {
                  const toolCallSkill = message.toolCallSkill;
                  return (
                    <article key={message.id} className="chatMessage left">
                      <AssistantAvatar />
                      <div className="bubble toolCallBubble">
                        <p className="authorLine">{ASSISTANT_NAME}</p>
                        <div className="skillUsageLine">
                          <span>Skill:</span>
                          <button
                            type="button"
                            className="skillLinkButton"
                            onClick={() => void openSkillDetail(toolCallSkill.skillId)}
                            disabled={loadingSkillId === toolCallSkill.skillId}
                          >
                            {toolCallSkill.label}
                            {loadingSkillId === toolCallSkill.skillId ? "..." : ""}
                          </button>
                        </div>
                      </div>
                    </article>
                  );
                }

                const result = message.result;
                if (!result) {
                  return null;
                }
                const csvData = createCsvData(result.wbsRows);
                const project = result.wbsRows.length ? buildProjectFromWbsRows(result.wbsRows) : null;
                const hasWbsOutput = Boolean(project);
                return (
                  <article key={message.id} className="chatMessage left">
                    <AssistantAvatar />
                    <div className="bubble">
                      <p className="authorLine">{ASSISTANT_NAME}</p>
                      {result.assistantText ? <p>{result.assistantText}</p> : null}
                      {project ? (
                        <>
                          <MermaidChart project={project} />
                          <a
                            href={`data:text/csv;charset=utf-8,${encodeURIComponent(csvData)}`}
                            download="output.csv"
                          >
                            Export CSV
                          </a>
                        </>
                      ) : null}
                      {!hasWbsOutput && result.mode === "wbs" ? <p>No Mermaid diagram detected.</p> : null}
                    </div>
                  </article>
                );
              })}
          </div>

          <form className="teamsComposer" onSubmit={handleSubmit}>
            <div className="composerShell">
              <textarea
                id="input"
                ref={composerInputRef}
                value={input}
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={handleComposerKeyDown}
                rows={1}
                placeholder="Message in Team 2A - Scope2WBS"
              />
              {uploadedFileName ? (
                <p className="uploadInfo">Uploaded document: {uploadedFileName}</p>
              ) : null}
              {uploadError ? <p className="error uploadError">{uploadError}</p> : null}
              <div className="composerActions">
                <button
                  type="button"
                  className="composerIconButton"
                  aria-label="Upload document"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M12 3v10m0 0l-4-4m4 4l4-4M4 17h16" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".txt,.md,.markdown,.csv,.json,.pdf,.docx,text/plain,text/markdown,text/csv,application/json,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                  onChange={handleFileUpload}
                  style={{ display: "none" }}
                />
                <button type="button" className="composerIconButton" aria-label="Format">
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M14.5 3l6.5 6.5-8.8 8.8H5.7v-6.5L14.5 3zm.1 2.8l-7.4 7.4v2.3h2.3l7.4-7.4-2.3-2.3zm-7.2 12h11v1.9h-11v-1.9z" />
                  </svg>
                </button>
                <button type="button" className="composerIconButton" aria-label="Emoji">
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M12 2.9A9.1 9.1 0 1 0 12 21a9.1 9.1 0 0 0 0-18.2zm0 1.8a7.3 7.3 0 1 1 0 14.6 7.3 7.3 0 0 1 0-14.6zm-2.9 4.7a1.2 1.2 0 1 0 0 2.4 1.2 1.2 0 0 0 0-2.4zm5.8 0a1.2 1.2 0 1 0 0 2.4 1.2 1.2 0 0 0 0-2.4zm-6.2 5c.7 1.3 2 2.1 3.3 2.1s2.6-.8 3.3-2.1l1.6.9c-1 1.8-2.9 3-4.9 3s-3.9-1.2-4.9-3l1.6-.9z" />
                  </svg>
                </button>
                <button type="button" className="composerIconButton" aria-label="Add content">
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M11 4h2v7h7v2h-7v7h-2v-7H4v-2h7V4z" />
                  </svg>
                </button>
                <div className="composerDivider" aria-hidden="true" />
                <button type="submit" disabled={loading} className="composerSendButton" aria-label="Send message">
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M3.2 4.8L21 12 3.2 19.2 4 13.8 14.2 12 4 10.2l-.8-5.4z" />
                  </svg>
                </button>
              </div>
            </div>
          </form>
        </section>
        </section>
      </div>

      {settingsOpen && (
        <div className="settingsOverlay" onClick={closeSettings}>
          <section className="settingsPanel" onClick={stopSettingsClose} aria-label="Settings panel">
            <header className="settingsHeader">
              <h2>Settings</h2>
              <button type="button" className="closeButton" onClick={closeSettings}>
                Close
              </button>
            </header>
            <div className="settingsLayout">
              <nav className="settingsNav" aria-label="Settings sections">
                <button
                  type="button"
                  className={`settingsNavButton ${settingsTab === "systemPrompt" ? "active" : ""}`}
                  onClick={() => setSettingsTab("systemPrompt")}
                >
                  Prompt
                </button>
                <button
                  type="button"
                  className={`settingsNavButton ${settingsTab === "skills" ? "active" : ""}`}
                  onClick={() => setSettingsTab("skills")}
                >
                  Skills
                </button>
                <button
                  type="button"
                  className={`settingsNavButton ${settingsTab === "rag" ? "active" : ""}`}
                  onClick={() => setSettingsTab("rag")}
                >
                  RAG
                </button>
              </nav>

              <section className="settingsContent">
                {settingsTab === "systemPrompt" ? (
                  <>
                    <p className="settingsHint">
                      Configure workflow defaults used for every run. This prompt will be used for each request.
                    </p>
                    <label htmlFor="settings-prompt">Prompt</label>
                    <textarea
                      id="settings-prompt"
                      value={systemPrompt}
                      onChange={(event) => setSystemPrompt(event.target.value)}
                      rows={14}
                    />
                  </>
                ) : settingsTab === "skills" ? (
                  <div className="settingsSection">
                    <p className="settingsHint">
                      Create a skill that captures the SOP for developing Work Break Down Structures for each project type.
                    </p>
                    <button type="button" className="placeholderSkillButton">
                      Create Skill
                    </button>
                    {availableSkills.length ? (
                      <ul className="skillsList">
                        {availableSkills.map((skill) => (
                          <li key={skill.id} className="skillsListItem">
                            <button
                              type="button"
                              className="skillsListTitleButton"
                              onClick={() => void openSkillDetail(skill.id)}
                              disabled={loadingSkillId === skill.id}
                            >
                              {skill.label}
                              {loadingSkillId === skill.id ? "..." : ""}
                            </button>
                            <p className="skillsListMeta">
                              ID: <code>{skill.id}</code> | Type: {skill.projectType}
                            </p>
                            <p className="skillsListDescription">{skill.description}</p>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="settingsHint">No skills loaded yet.</p>
                    )}
                  </div>
                ) : (
                  <div className="settingsSection">
                    <p className="settingsHint">Future feature: connect to the company RAG database.</p>
                    <button type="button" className="placeholderSkillButton">Connect</button>
                  </div>
                )}
              </section>
            </div>
            <div className="settingsActions">
              {settingsTab === "systemPrompt" ? (
                <button type="button" className="secondaryButton" onClick={() => setSystemPrompt(DEFAULT_PROMPT)}>
                  Reset prompt
                </button>
              ) : null}
              <button type="button" className="primaryButton" onClick={closeSettings}>
                Save and close
              </button>
            </div>
          </section>
        </div>
      )}

      {(selectedSkill || skillDetailError) && (
        <div className="skillDetailOverlay" onClick={closeSkillDetail}>
          <section className="skillDetailPanel" onClick={stopSettingsClose} aria-label="Skill details">
            <header className="skillDetailHeader">
              <h2>{selectedSkill ? selectedSkill.label : "Skill details"}</h2>
              <button type="button" className="closeButton" onClick={closeSkillDetail}>
                Close
              </button>
            </header>
            {skillDetailError ? <p className="error">{skillDetailError}</p> : null}
            {selectedSkill ? (
              <>
                <p className="skillDetailMeta">
                  ID: <code>{selectedSkill.id}</code> | Type: {selectedSkill.projectType}
                </p>
                <p className="skillDetailDescription">{selectedSkill.description}</p>
                <pre className="skillDetailContent">{selectedSkill.content}</pre>
              </>
            ) : null}
          </section>
        </div>
      )}
    </main>
  );
}

export default App;
