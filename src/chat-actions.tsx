import { invoke } from "@tauri-apps/api/core";
import {
  Bot,
  Copy,
  ExternalLink,
  FileDown,
  FileText,
  FolderOpen,
  FolderTree,
  GitFork,
  Hash,
  Sparkles,
  Terminal,
  type LucideIcon,
} from "lucide-react";

export type Chat = {
  id: string;
  localId: string | null;
  title: string;
  account: string;
  project: string;
  cwd: string | null;
  createdMs: number | null;
  lastMs: number;
  archived: boolean;
  size: number;
  path: string;
  model: string | null;
  hasMetadata: boolean;
};
export type Msg = {
  role: "user" | "assistant";
  ts: string;
  text: string;
  kind: "text" | "tool" | "summary" | "image";
};

export const fmtDate = (ms: number) =>
  new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
export const fmtSize = (b: number) =>
  b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`;
export type AccountInfo = {
  id: string;
  orgs: number;
  desktopCurrent: boolean;
  cliCurrent: boolean;
  email: string | null;
  name: string | null;
  plan: string | null;
};
let accountNames: Record<string, string> = {};
export const setAccountNames = (list: AccountInfo[]) => {
  accountNames = Object.fromEntries(list.filter((a) => a.email).map((a) => [a.id, a.email as string]));
};
export const accountLabel = (a: string) =>
  a === "unknown" ? "No account info" : (accountNames[a] ?? `Account ${a.slice(0, 8)}`);

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

export function toMarkdown(chat: Chat, msgs: Msg[]) {
  const lines = [
    `# ${chat.title}`,
    "",
    `- Account: ${accountLabel(chat.account)}`,
    `- Project: ${chat.project}`,
    `- Last activity: ${fmtDate(chat.lastMs)}`,
    "",
  ];
  for (const m of msgs) {
    if (m.kind === "tool") continue;
    lines.push(`## ${m.role === "user" ? "You" : "Claude"} · ${m.ts ? fmtDate(Date.parse(m.ts)) : ""}`, "", m.text, "");
  }
  return lines.join("\n");
}

const HANDOFF_LIMIT = 200_000;

/** A single file an AI agent can read to pick the work up where the chat stopped. */
export function buildHandoff(chat: Chat, msgs: Msg[]) {
  const text = msgs.filter((m) => m.kind === "text" || m.kind === "summary");
  const line = (m: Msg, max: number) =>
    `### ${m.role === "user" ? "User" : "Assistant"}${m.kind === "summary" ? " (auto summary of earlier work)" : ""} · ${m.ts ? fmtDate(Date.parse(m.ts)) : ""}\n\n${clip(m.text, max)}\n`;

  const total = text.reduce((n, m) => n + m.text.length, 0);
  let body: string[];
  let note = "This is the full conversation.";
  if (total <= HANDOFF_LIMIT) {
    body = text.map((m) => line(m, 8000));
  } else {
    const head = text.slice(0, 3);
    const tail = text.slice(-80);
    const middle = text.slice(3, -80);
    note =
      "This chat was long. The first messages and the last 80 messages are complete. The middle part only lists what the user asked, one line each.";
    body = [
      ...head.map((m) => line(m, 8000)),
      "### Middle of the conversation (user requests only)\n",
      ...middle.filter((m) => m.role === "user").map((m) => `- ${clip(m.text.replace(/\s+/g, " "), 300)}`),
      "",
      ...tail.map((m) => line(m, 8000)),
    ];
  }

  return [
    `# Handoff: ${chat.title}`,
    "",
    "You are continuing work that was started in a Claude Code chat, possibly under a different account.",
    "Read everything below, keep the user's rules and conventions, and carry on from the last request at the bottom.",
    "Do not redo work that the transcript says is finished. Check the repository state before you change code.",
    "",
    `- Project folder: ${chat.cwd ?? "unknown"}`,
    `- Original chat id: ${chat.id}`,
    `- Last activity: ${fmtDate(chat.lastMs)}`,
    `- ${note}`,
    "",
    "## Conversation",
    "",
    ...body,
  ].join("\n");
}

export async function loadMsgs(chat: Chat) {
  return invoke<Msg[]>("read_chat", { path: chat.path });
}

async function prepareHandoff(chat: Chat) {
  const msgs = await loadMsgs(chat);
  return invoke<string>("save_handoff", { title: chat.title, content: buildHandoff(chat, msgs) });
}

const codexCommand = (path: string) =>
  `codex 'Read the file ${path} completely. It is the transcript of an earlier Claude Code session on this project. Continue the work from exactly where it stopped, and follow the project rules it mentions.'`;

export type ChatAction = {
  id: string;
  label: string;
  hint: string;
  icon: LucideIcon;
  group: "Continue" | "Open" | "Copy" | "Save";
  run: () => Promise<void>;
};

type Toast = (m: string) => void;

export function chatActions(chat: Chat, toast: Toast, msgs?: Msg[] | null): ChatAction[] {
  const msgsOrLoad = async () => msgs ?? (await loadMsgs(chat));
  const copy = async (text: string, what: string) => {
    await navigator.clipboard.writeText(text);
    toast(`${what} copied`);
  };
  const list: ChatAction[] = [
    {
      id: "claude",
      label: "Continue in Claude",
      hint: "Opens a terminal and resumes this chat with Claude Code, using the account signed in there.",
      icon: Sparkles,
      group: "Continue",
      run: async () => {
        await invoke("launch_agent", { agent: "claude", id: chat.id, cwd: chat.cwd });
        toast("Starting Claude Code in a terminal");
      },
    },
    {
      id: "claude-fork",
      label: "Continue in Claude (copy)",
      hint: "Resumes as a new copy, so the original chat file is left untouched. Good when the chat belongs to another account.",
      icon: GitFork,
      group: "Continue",
      run: async () => {
        await invoke("launch_agent", { agent: "claude-fork", id: chat.id, cwd: chat.cwd });
        toast("Starting a copy in Claude Code");
      },
    },
    {
      id: "codex",
      label: "Continue in Codex",
      hint: "Saves a handoff file with the whole chat and starts Codex with it, so Codex keeps the context.",
      icon: Bot,
      group: "Continue",
      run: async () => {
        const handoff = await prepareHandoff(chat);
        await invoke("launch_agent", { agent: "codex", id: chat.id, cwd: chat.cwd, handoff });
        toast("Starting Codex in a terminal");
      },
    },
  ];
  if (chat.localId) {
    list.push({
      id: "open",
      label: "Open in Claude app",
      hint: "Works only when the account that owns this chat is signed in to the Claude app.",
      icon: ExternalLink,
      group: "Open",
      run: () => invoke("open_in_claude", { localId: chat.localId }),
    });
  }
  list.push(
    {
      id: "reveal",
      label: "Show transcript file",
      hint: "Shows the transcript file in File Explorer.",
      icon: FolderOpen,
      group: "Open",
      run: () => invoke("reveal_in_folder", { path: chat.path }),
    },
    ...(chat.cwd
      ? [
          {
            id: "folder",
            label: "Open project folder",
            hint: "Opens the folder this chat worked in.",
            icon: FolderTree,
            group: "Open" as const,
            run: () => invoke<void>("open_folder", { path: chat.cwd }),
          },
        ]
      : []),
    {
      id: "copy-id",
      label: "Copy chat ID",
      hint: "Copies the session id, useful for scripts and support.",
      icon: Hash,
      group: "Copy",
      run: () => copy(chat.id, "Chat ID"),
    },
    {
      id: "copy-claude",
      label: "Copy Claude command",
      hint: "A PowerShell command that resumes this chat with Claude Code.",
      icon: Terminal,
      group: "Copy",
      run: () => copy(`${chat.cwd ? `cd "${chat.cwd}"; ` : ""}claude --resume ${chat.id}`, "Claude command"),
    },
    {
      id: "copy-codex",
      label: "Copy Codex command",
      hint: "Saves the handoff file and copies the command that starts Codex with it.",
      icon: Terminal,
      group: "Copy",
      run: async () => {
        const handoff = await prepareHandoff(chat);
        await copy(`${chat.cwd ? `cd "${chat.cwd}"; ` : ""}${codexCommand(handoff)}`, "Codex command");
      },
    },
    {
      id: "copy-md",
      label: "Copy as Markdown",
      hint: "Copies the readable conversation.",
      icon: Copy,
      group: "Copy",
      run: async () => copy(toMarkdown(chat, await msgsOrLoad()), "Chat"),
    },
    {
      id: "save-md",
      label: "Save as .md",
      hint: "Saves to Desktop / Claude Chats.",
      icon: FileDown,
      group: "Save",
      run: async () => {
        await invoke("save_markdown", { title: chat.title, markdown: toMarkdown(chat, await msgsOrLoad()) });
        toast("Saved to Desktop / Claude Chats");
      },
    },
    {
      id: "save-handoff",
      label: "Save handoff file",
      hint: "Saves the AI handoff file to Documents / ChatVault Handoffs.",
      icon: FileText,
      group: "Save",
      run: async () => {
        await prepareHandoff(chat);
        toast("Saved to Documents / ChatVault Handoffs");
      },
    },
  );
  return list;
}
