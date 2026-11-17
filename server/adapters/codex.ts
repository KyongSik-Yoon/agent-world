// Codex: `~/.codex/sessions/YYYY/MM/DD/rollout-<시각>-<session>.jsonl`.
//
// 행은 `{timestamp, type, payload}` 이고 모델·effort 는 `turn_context` 행에, 턴의 시작과 끝은
// `event_msg` 의 task_started / task_complete 에 있다.
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { LogReader } from "../tail.ts";
import { emptySummary, isRecord, num, pushActivity, setPrompt, setReply, str, summarizeToolInput, type LogSummary } from "../summary.ts";
import type { Harness, LogFile } from "./types.ts";

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function root(): string {
  return join(process.env.CODEX_HOME || join(homedir(), ".codex"), "sessions");
}

function partsText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((p) => (isRecord(p) ? (str(p.text) ?? "") : ""))
    .filter(Boolean)
    .join("\n");
}

function toolInput(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function feedEvent(s: LogSummary, p: Record<string, unknown>, at: string): void {
  switch (p.type) {
    case "task_started":
      s.turnOpen = true;
      s.contextWindow = num(p.model_context_window) ?? s.contextWindow;
      break;
    case "task_complete": {
      s.turnOpen = false;
      const text = str(p.last_agent_message);
      if (text) setReply(s, text);
      break;
    }
    case "turn_aborted":
      s.turnOpen = false;
      break;
    case "thread_settings_applied": {
      const settings = p.thread_settings;
      if (isRecord(settings)) s.model = str(settings.model) ?? s.model;
      break;
    }
    case "token_count": {
      const info = p.info;
      if (!isRecord(info)) break;
      s.contextWindow = num(info.model_context_window) ?? s.contextWindow;
      const last = info.last_token_usage;
      if (isRecord(last)) s.contextTokens = num(last.input_tokens) ?? s.contextTokens;
      break;
    }
    case "item_completed": {
      const item = p.item;
      if (!isRecord(item) || item.type !== "UserMessage") break;
      const text = partsText(item.content).trim();
      if (text) {
        setPrompt(s, text);
        pushActivity(s, "user", "", text, at);
      }
      break;
    }
    case "agent_message": {
      const text = str(p.message);
      if (text) {
        s.sawAssistant = true;
        setReply(s, text);
        pushActivity(s, "text", "", text, at);
      }
      break;
    }
  }
}

function feedItem(s: LogSummary, p: Record<string, unknown>, at: string): void {
  switch (p.type) {
    case "message": {
      if (p.role !== "assistant") break;
      const text = partsText(p.content).trim();
      if (text) {
        s.sawAssistant = true;
        setReply(s, text);
        pushActivity(s, "text", "", text, at);
      }
      break;
    }
    case "reasoning":
      s.sawAssistant = true;
      pushActivity(s, "thinking", "", "", at);
      break;
    case "function_call":
    case "custom_tool_call":
    case "local_shell_call": {
      s.sawAssistant = true;
      const input = toolInput(p.arguments ?? p.input ?? p.action);
      pushActivity(s, "tool", str(p.name) ?? "shell", summarizeToolInput(input), at);
      break;
    }
  }
}

export const codexReader: LogReader<LogSummary> = {
  init: emptySummary,
  // world_state 와 developer 메시지는 지침 전문을 통째로 싣고 다녀서 크다 — 파싱하지 않는다.
  want: (line) => line.length < 4096 || !line.slice(0, 160).includes('"type":"world_state"'),
  feed(s, row) {
    if (!isRecord(row) || !isRecord(row.payload)) return;
    const at = str(row.timestamp) ?? "";
    const p = row.payload;
    switch (row.type) {
      case "session_meta": {
        s.cwd = str(p.cwd) ?? s.cwd;
        s.harnessVersion = str(p.cli_version) ?? s.harnessVersion;
        const git = p.git;
        if (isRecord(git)) s.branch = str(git.branch) ?? s.branch;
        break;
      }
      case "turn_context":
        s.model = str(p.model) ?? s.model;
        s.effort = str(p.effort) ?? s.effort;
        s.cwd = str(p.cwd) ?? s.cwd;
        if (typeof p.approval_policy === "string") s.permissionMode = p.approval_policy;
        break;
      case "event_msg":
        feedEvent(s, p, at);
        break;
      case "response_item":
        feedItem(s, p, at);
        break;
    }
  },
  ready: (s) => s.sawAssistant && s.model !== undefined,
};

async function walk(sinceMs: number, wantId?: string): Promise<LogFile[]> {
  const found: LogFile[] = [];
  const list = async (dir: string): Promise<string[]> => {
    try {
      return await readdir(dir);
    } catch {
      return [];
    }
  };
  for (const year of await list(root())) {
    for (const month of await list(join(root(), year))) {
      for (const day of await list(join(root(), year, month))) {
        const dir = join(root(), year, month, day);
        for (const name of await list(dir)) {
          const m = /^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(name);
          if (!m) continue;
          const sessionId = m[1]!;
          if (wantId && sessionId !== wantId) continue;
          try {
            const info = await stat(join(dir, name));
            if (info.mtimeMs >= sinceMs) found.push({ sessionId, path: join(dir, name), mtimeMs: info.mtimeMs });
          } catch {
            // 사이에 지워진 파일.
          }
        }
      }
    }
  }
  return found;
}

const pathCache = new Map<string, string>();

export const codex: Harness = {
  vendor: "codex",
  matches: (agent) => agent === "codex" || /^codex[-._]/.test(agent),
  reader: codexReader,
  async resolve(sessionId) {
    if (!SESSION_ID.test(sessionId)) return null;
    const cached = pathCache.get(sessionId);
    if (cached) return cached;
    const hit = (await walk(0, sessionId))[0];
    if (hit) pathCache.set(sessionId, hit.path);
    return hit?.path ?? null;
  },
  discover: (sinceMs) => walk(sinceMs),
};
