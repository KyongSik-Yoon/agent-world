// Antigravity CLI: `~/.gemini/antigravity-cli/brain/<id>/.system_generated/logs/transcript.jsonl`.
//
// 대화의 정본은 `conversations/<id>.db`(protobuf 스텝)지만, AGY 가 같은 내용을 평문 jsonl 로도
// 적어 둔다. 스텝 하나가 한 행이고 모델·토큰·도구 호출이 그대로 들어 있어 이쪽만 읽는다.
// 제목은 로그에 없어서 `conversation_summaries.db` 에서 읽는다.
import { Database } from "bun:sqlite";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { LogReader } from "../tail.ts";
import { emptySummary, isRecord, num, pendingRequest, pushActivity, setPrompt, setReply, str, summarizeToolInput, type LogSummary } from "../summary.ts";
import type { Harness, LogFile } from "./types.ts";

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TITLE_TTL_MS = 30_000;

function root(): string {
  return process.env.AGY_HOME || join(homedir(), ".gemini", "antigravity-cli");
}

function logPath(sessionId: string): string {
  return join(root(), "brain", sessionId, ".system_generated", "logs", "transcript.jsonl");
}

/** 도구 인자는 값마다 JSON 으로 한 번 더 싸여 있다(`"\"git status\""`). 풀 수 있으면 푼다. */
function decodeArgs(args: unknown): Record<string, unknown> {
  if (!isRecord(args)) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (typeof value !== "string") {
      out[key] = value;
      continue;
    }
    try {
      out[key] = JSON.parse(value);
    } catch {
      out[key] = value;
    }
  }
  return out;
}

function userRequest(content: string): string {
  const m = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/.exec(content);
  return (m ? m[1]! : content.replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/g, "")).trim();
}

export const agyReader: LogReader<LogSummary> = {
  init: emptySummary,
  feed(s, row) {
    if (!isRecord(row)) return;
    const at = str(row.created_at) ?? "";
    const content = str(row.content) ?? "";
    switch (row.type) {
      case "USER_INPUT": {
        const text = userRequest(content);
        if (text) {
          setPrompt(s, text);
          pushActivity(s, "user", "", text, at);
          s.turnOpen = true;
          s.open.clear();
        }
        break;
      }
      case "PLANNER_RESPONSE": {
        s.sawAssistant = true;
        s.model = str(row.model) ?? s.model;
        const total = (num(row.input_tokens) ?? 0) + (num(row.cache_read_tokens) ?? 0);
        if (total > 0) s.contextTokens = total;
        if (str(row.thinking)) pushActivity(s, "thinking", "", "", at);
        if (content.trim()) {
          setReply(s, content);
          pushActivity(s, "text", "", content, at);
        }
        const calls = Array.isArray(row.tool_calls) ? row.tool_calls : [];
        // 결과 행을 호출과 짝지을 id 가 없어서, 가장 최근 응답이 부른 도구들을 "지금 기다리는 것"으로 둔다.
        s.open.clear();
        calls.forEach((call, i) => {
          if (!isRecord(call)) return;
          const args = decodeArgs(call.args);
          const summary = str(args.toolSummary) ?? summarizeToolInput(args);
          const name = str(call.name) ?? "tool";
          pushActivity(s, "tool", name, summary, at);
          s.open.set(String(i), pendingRequest(name, args, at));
        });
        s.turnOpen = calls.length > 0;
        break;
      }
      case "GENERIC":
      case "ERROR_MESSAGE":
        if (row.status === "ERROR") {
          for (let i = s.recent.length - 1; i >= 0; i -= 1) {
            const a = s.recent[i]!;
            if (a.kind === "tool") {
              a.error = true;
              break;
            }
          }
        }
        break;
    }
  },
  ready: (s) => s.sawAssistant,
};

const titles = new Map<string, { at: number; title?: string }>();

function readTitle(sessionId: string): string | undefined {
  const hit = titles.get(sessionId);
  if (hit && Date.now() - hit.at < TITLE_TTL_MS) return hit.title;
  let title: string | undefined;
  try {
    const db = new Database(join(root(), "conversation_summaries.db"), { readonly: true });
    try {
      const row = db.query("select title from conversation_summaries where conversation_id = ?").get(sessionId) as { title?: string } | null;
      title = row?.title?.trim() || undefined;
    } finally {
      db.close();
    }
  } catch {
    // DB 가 없거나 잠겨 있다 — 제목 없이 간다.
  }
  titles.set(sessionId, { at: Date.now(), title });
  return title;
}

export const agy: Harness = {
  vendor: "agy",
  matches: (agent) => agent === "agy" || /^agy[-.]/.test(agent) || agent.startsWith("antigravity"),
  reader: agyReader,
  async resolve(sessionId) {
    if (!SESSION_ID.test(sessionId)) return null;
    const path = logPath(sessionId);
    try {
      await stat(path);
      return path;
    } catch {
      return null;
    }
  },
  async title(sessionId) {
    return SESSION_ID.test(sessionId) ? readTitle(sessionId) : undefined;
  },
  async discover(sinceMs) {
    let ids: string[];
    try {
      ids = await readdir(join(root(), "brain"));
    } catch {
      return [];
    }
    const found: LogFile[] = [];
    await Promise.all(
      ids.map(async (sessionId) => {
        if (!SESSION_ID.test(sessionId)) return;
        const path = logPath(sessionId);
        try {
          const info = await stat(path);
          if (info.mtimeMs >= sinceMs) found.push({ sessionId, path, mtimeMs: info.mtimeMs });
        } catch {
          // 로그가 아직 없는 대화.
        }
      }),
    );
    return found;
  },
};
