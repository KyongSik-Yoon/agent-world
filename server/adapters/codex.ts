// Codex: `~/.codex/sessions/YYYY/MM/DD/rollout-<시각>-<session>.jsonl`.
//
// 행은 `{timestamp, type, payload}` 이고 모델·effort 는 `turn_context` 행에, 턴의 시작과 끝은
// `event_msg` 의 task_started / task_complete 에 있다.
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { LogReader } from "../tail.ts";
import { emptySummary, isRecord, num, pendingRequest, pushActivity, setPrompt, setReply, str, summarizeToolInput, type LogSummary } from "../summary.ts";
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
      s.open.clear();
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
      const name = str(p.name) ?? "shell";
      pushActivity(s, "tool", name, summarizeToolInput(input), at);
      const id = str(p.call_id);
      if (id) s.open.set(id, pendingRequest(name, input, at));
      break;
    }
    case "function_call_output":
    case "custom_tool_call_output":
    case "local_shell_call_output": {
      const id = str(p.call_id);
      if (id) s.open.delete(id);
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

const ROLLOUT = /^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
/** 매번 빠짐없이 살펴보는 날짜 폴더의 수(최근 것부터). 새 세션의 로그는 여기에 생긴다. */
const RECENT_DAYS = 2;
/** 그보다 오래된 날짜 폴더를 전부 다시 살펴보는 간격. 그 사이에는 움직이던 로그만 본다. */
const OLD_SCAN_MS = 5 * 60_000;

async function list(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

/** 날짜 폴더들(`YYYY/MM/DD`)을 최근 것부터. 오래 쓴 사람은 수백 개가 된다. */
async function dayDirs(): Promise<string[]> {
  const newestFirst = (names: string[]) => names.filter((n) => /^\d+$/.test(n)).sort((x, y) => Number(y) - Number(x));
  const out: string[] = [];
  for (const year of newestFirst(await list(root()))) {
    for (const month of newestFirst(await list(join(root(), year)))) {
      for (const day of newestFirst(await list(join(root(), year, month)))) out.push(join(root(), year, month, day));
    }
  }
  return out;
}

/** 그 로그가 sinceMs 뒤에 움직였으면 돌려준다. */
async function active(path: string, sessionId: string, sinceMs: number): Promise<LogFile | undefined> {
  try {
    const info = await stat(path);
    return info.mtimeMs >= sinceMs ? { sessionId, path, mtimeMs: info.mtimeMs } : undefined;
  } catch {
    // 사이에 지워진 파일.
    return undefined;
  }
}

async function activeIn(dir: string, sinceMs: number): Promise<LogFile[]> {
  const found: LogFile[] = [];
  for (const name of await list(dir)) {
    const m = ROLLOUT.exec(name);
    const hit = m && (await active(join(dir, name), m[1]!, sinceMs));
    if (hit) found.push(hit);
  }
  return found;
}

/** 오래된 날짜 폴더에서 마지막으로 전부 살폈을 때 움직이고 있던 로그들(경로 → 세션 id)과 그 시각. */
let oldActive = new Map<string, string>();
let oldScannedAt = 0;

/**
 * 최근에 움직인 로그를 찾는다.
 *
 * 파일의 수정 시각을 보려면 하나하나 stat 해야 하는데, 여러 달 쓴 사람은 로그가 수천 개다. 10초마다 전부 보면
 * 그것만으로 스냅샷이 늦어진다. 며칠째 이어지는 세션은 오래된 폴더에 있으므로 날짜로 잘라 버릴 수는 없다 —
 * 그래서 최근 폴더는 매번, 오래된 폴더는 가끔 전부 보고 그 사이에는 움직이던 것만 다시 본다.
 */
async function discover(sinceMs: number): Promise<LogFile[]> {
  const days = await dayDirs();
  const found: LogFile[] = [];
  for (const dir of days.slice(0, RECENT_DAYS)) found.push(...(await activeIn(dir, sinceMs)));
  if (Date.now() - oldScannedAt >= OLD_SCAN_MS) {
    const next = new Map<string, string>();
    for (const dir of days.slice(RECENT_DAYS)) {
      for (const file of await activeIn(dir, sinceMs)) {
        next.set(file.path, file.sessionId);
        found.push(file);
      }
    }
    oldActive = next;
    oldScannedAt = Date.now();
  } else {
    for (const [path, sessionId] of oldActive) {
      const hit = await active(path, sessionId, sinceMs);
      if (hit) found.push(hit);
    }
  }
  return found;
}

const pathCache = new Map<string, string>();
/** 날짜 폴더를 전부 뒤졌는데 로그가 없던 세션. 아직 첫 줄을 쓰지 않은 것이라, 그 뒤로는 최근 폴더만 본다. */
const missed = new Set<string>();

export const codex: Harness = {
  vendor: "codex",
  matches: (agent) => agent === "codex" || /^codex[-._]/.test(agent),
  reader: codexReader,
  async resolve(sessionId) {
    if (!SESSION_ID.test(sessionId)) return null;
    const cached = pathCache.get(sessionId);
    if (cached) return cached;
    // 이름에 세션 id 가 들어 있어 stat 없이 찾는다. 대개 최근 세션이라 최근 폴더부터 보고, 찾으면 멈춘다.
    const days = await dayDirs();
    for (const dir of missed.has(sessionId) ? days.slice(0, RECENT_DAYS) : days) {
      const name = (await list(dir)).find((n) => ROLLOUT.exec(n)?.[1] === sessionId);
      if (!name) continue;
      const path = join(dir, name);
      pathCache.set(sessionId, path);
      missed.delete(sessionId);
      return path;
    }
    missed.add(sessionId);
    return null;
  },
  discover,
};
