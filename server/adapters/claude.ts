// Claude Code: `~/.claude/projects/<slug>/<session>.jsonl`.
//
// slug 는 세션을 시작한 cwd 로 만들어지는데 herdr 가 알려주는 cwd 와 어긋날 수 있다(워크트리로
// 들어간 세션 등). 그래서 slug 를 계산하지 않고 세션 id 로 파일을 찾는다.
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { LogReader } from "../tail.ts";
import {
  emptySummary,
  isRecord,
  num,
  pendingRequest,
  pushActivity,
  setPrompt,
  setReply,
  str,
  summarizeToolInput,
  type LogSummary,
} from "../summary.ts";
import type { Harness, LogFile } from "./types.ts";

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SUBAGENT_LIVE_MS = 20_000;

function root(): string {
  return join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects");
}

// `{"type":"…"` 로 시작하는 행은 대화가 아니라 부기 행이다. 그중 쓸 것만 파싱한다 —
// api-request-blob 같은 행은 수십~수백 KB 라서 JSON 으로 푸는 것 자체가 낭비다.
const BOOKKEEPING = '{"type":"';
const WANTED_BOOKKEEPING = ['{"type":"ai-title"', '{"type":"last-prompt"', '{"type":"permission-mode"'];

/** 사용자 행의 텍스트에서 하네스가 끼워 넣은 꼬리표를 걷어낸다. 사람이 친 말이 아니면 빈 문자열. */
function userText(raw: string): string {
  if (/^<(local-command-|command-name|command-message|task-notification|bash-input|bash-stdout)/.test(raw.trimStart())) return "";
  return raw
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .replace(/<\/?pasted_content[^>]*>/g, "")
    .trim();
}

function feedAssistant(s: LogSummary, row: Record<string, unknown>, at: string): void {
  const message = row.message;
  if (!isRecord(message)) return;
  s.sawAssistant = true;
  const model = str(message.model);
  if (model && model !== "<synthetic>") s.model = model;
  s.effort = str(row.effort) ?? s.effort;
  s.branch = str(row.gitBranch) ?? s.branch;
  s.cwd = str(row.cwd) ?? s.cwd;
  s.harnessVersion = str(row.version) ?? s.harnessVersion;

  const usage = message.usage;
  if (isRecord(usage)) {
    const total = (num(usage.input_tokens) ?? 0) + (num(usage.cache_read_input_tokens) ?? 0) + (num(usage.cache_creation_input_tokens) ?? 0);
    if (total > 0) s.contextTokens = total;
  }

  const content = Array.isArray(message.content) ? message.content : [];
  let calledTool = false;
  for (const part of content) {
    if (!isRecord(part)) continue;
    if (part.type === "text") {
      const text = str(part.text);
      if (text?.trim()) {
        setReply(s, text);
        pushActivity(s, "text", "", text, at);
      }
    } else if (part.type === "thinking") {
      pushActivity(s, "thinking", "", "", at);
    } else if (part.type === "tool_use") {
      calledTool = true;
      const name = str(part.name) ?? "tool";
      pushActivity(s, "tool", name, summarizeToolInput(part.input), at);
      const id = str(part.id);
      if (id) s.open.set(id, pendingRequest(name, part.input, at));
    }
  }
  const stop = str(message.stop_reason);
  if (calledTool || stop === "tool_use") s.turnOpen = true;
  else if (stop === "end_turn" || stop === "stop_sequence" || stop === "refusal") {
    s.turnOpen = false;
    s.open.clear();
  }
}

function feedUser(s: LogSummary, row: Record<string, unknown>, at: string): void {
  if (row.isMeta === true) return;
  const message = row.message;
  if (!isRecord(message)) return;
  const content = message.content;
  if (typeof content === "string") {
    const text = userText(content);
    if (text) {
      setPrompt(s, text);
      pushActivity(s, "user", "", text, at);
      s.turnOpen = true;
      s.open.clear();
    }
    return;
  }
  if (!Array.isArray(content)) return;
  const texts: string[] = [];
  for (const part of content) {
    if (!isRecord(part)) continue;
    if (part.type === "text") {
      const text = userText(str(part.text) ?? "");
      if (text) texts.push(text);
    } else if (part.type === "tool_result") {
      const id = str(part.tool_use_id);
      if (id) s.open.delete(id);
      if (part.is_error !== true) continue;
      // 방금 부른 도구가 실패했다 — 가장 최근 도구 활동에 표시한다.
      for (let i = s.recent.length - 1; i >= 0; i -= 1) {
        const a = s.recent[i]!;
        if (a.kind === "tool") {
          a.error = true;
          break;
        }
      }
    }
  }
  if (texts.length > 0) {
    const text = texts.join("\n\n");
    setPrompt(s, text);
    pushActivity(s, "user", "", text, at);
    s.turnOpen = true;
    s.open.clear();
  }
}

export const claudeReader: LogReader<LogSummary> = {
  init: emptySummary,
  want(line) {
    if (!line.startsWith(BOOKKEEPING)) return true;
    return WANTED_BOOKKEEPING.some((p) => line.startsWith(p));
  },
  feed(s, row) {
    if (!isRecord(row)) return;
    const at = str(row.timestamp) ?? "";
    switch (row.type) {
      case "assistant":
        if (row.isSidechain !== true) feedAssistant(s, row, at);
        break;
      case "user":
        if (row.isSidechain !== true) feedUser(s, row, at);
        break;
      case "ai-title":
        s.title = str(row.aiTitle) ?? s.title;
        break;
      case "permission-mode":
        s.permissionMode = str(row.permissionMode) ?? s.permissionMode;
        break;
      case "last-prompt": {
        // Claude Code 가 직접 적어 두는 마지막 프롬프트(잘린 형태). 사용자 행에서 읽은 원문이
        // 같은 프롬프트면 원문을 두고, 다르면(꼬리 창 밖이었다면) 이 값을 쓴다.
        const text = str(row.lastPrompt);
        if (!text) break;
        const head = text.replace(/…$/, "").slice(0, 40);
        if (!s.lastPrompt || !s.lastPrompt.replace(/\s+/g, " ").startsWith(head.replace(/\s+/g, " "))) setPrompt(s, text);
        break;
      }
    }
  },
  ready: (s) => s.sawAssistant,
};

const pathCache = new Map<string, string>();

async function findSessionFile(sessionId: string): Promise<string | null> {
  const cached = pathCache.get(sessionId);
  if (cached) return cached;
  let dirs: string[];
  try {
    dirs = await readdir(root());
  } catch {
    return null;
  }
  const hits = await Promise.all(
    dirs.map(async (dir) => {
      const path = join(root(), dir, `${sessionId}.jsonl`);
      try {
        await stat(path);
        return path;
      } catch {
        return null;
      }
    }),
  );
  const found = hits.find((h) => h !== null) ?? null;
  if (found) pathCache.set(sessionId, found);
  return found;
}

export const claude: Harness = {
  vendor: "claude",
  matches: (agent) => agent === "claude" || /^claude[-._]/.test(agent),
  reader: claudeReader,
  async resolve(sessionId) {
    if (!SESSION_ID.test(sessionId)) return null;
    return findSessionFile(sessionId);
  },
  async subagents(path) {
    // `<session>/subagents/agent-<id>.jsonl` — 최근에 움직인 로그를 돌고 있는 서브에이전트로 센다.
    const dir = join(path.replace(/\.jsonl$/, ""), "subagents");
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return 0;
    }
    const now = Date.now();
    const live = await Promise.all(
      names
        .filter((n) => n.endsWith(".jsonl"))
        .map(async (n) => {
          try {
            return now - (await stat(join(dir, n))).mtimeMs < SUBAGENT_LIVE_MS;
          } catch {
            return false;
          }
        }),
    );
    return live.filter(Boolean).length;
  },
  async discover(sinceMs) {
    let dirs: string[];
    try {
      dirs = await readdir(root());
    } catch {
      return [];
    }
    const found: LogFile[] = [];
    await Promise.all(
      dirs.map(async (dir) => {
        let names: string[];
        try {
          names = await readdir(join(root(), dir));
        } catch {
          return;
        }
        await Promise.all(
          names.map(async (name) => {
            if (!name.endsWith(".jsonl")) return;
            const sessionId = name.slice(0, -6);
            if (!SESSION_ID.test(sessionId)) return;
            const path = join(root(), dir, name);
            try {
              const info = await stat(path);
              if (info.mtimeMs >= sinceMs) found.push({ sessionId, path, mtimeMs: info.mtimeMs });
            } catch {
              // 사이에 지워진 파일.
            }
          }),
        );
      }),
    );
    return found;
  },
};
