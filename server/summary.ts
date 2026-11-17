// 어댑터들이 공통으로 채우는 로그 요약과, 그 요약을 다루는 작은 도구들.
import { basename } from "node:path";

import type { Activity, ActivityKind, PendingRequest } from "../shared/types.ts";

export const MAX_RECENT = 16;
const MAX_ACTIVITY_CHARS = 220;
const MAX_PROMPT_CHARS = 4000;
const MAX_REPLY_CHARS = 8000;

export interface LogSummary {
  title?: string;
  model?: string;
  effort?: string;
  permissionMode?: string;
  harnessVersion?: string;
  branch?: string;
  cwd?: string;
  contextTokens?: number;
  contextWindow?: number;
  recent: Activity[];
  lastPrompt?: string;
  lastReply?: string;
  /** 모델이 아직 일하는 중으로 보이는지(사용자 입력 직후이거나 도구 호출이 열려 있음). */
  turnOpen: boolean;
  /** 모델 응답 행을 하나라도 봤는지 — 꼬리 창을 더 키울지 판단한다. */
  sawAssistant: boolean;
  /** 결과를 기다리는 도구 호출들(호출 id → 요청). 결과 행이 오면 지운다. */
  open: Map<string, PendingRequest>;
}

export function emptySummary(): LogSummary {
  return { recent: [], turnOpen: false, sawAssistant: false, open: new Map() };
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

export function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

export function clip(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join("")}…`;
}

/** 여러 줄 텍스트를 말풍선용 한 줄로 줄인다. */
export function oneLine(text: string, max = MAX_ACTIVITY_CHARS): string {
  return clip(text.replace(/\s+/g, " ").trim(), max);
}

export function pushActivity(s: LogSummary, kind: ActivityKind, name: string, text: string, at: string): Activity {
  const last = s.recent[s.recent.length - 1];
  if (kind === "thinking" && last?.kind === "thinking") {
    // 연달아 이어지는 생각은 한 줄로 접는다 — 로그가 "생각 중"으로만 차지 않게.
    last.at = at;
    return last;
  }
  const activity: Activity = { kind, name, text: oneLine(text), at };
  s.recent.push(activity);
  if (s.recent.length > MAX_RECENT) s.recent.splice(0, s.recent.length - MAX_RECENT);
  return activity;
}

export function setPrompt(s: LogSummary, text: string): void {
  s.lastPrompt = clip(text.trim(), MAX_PROMPT_CHARS);
}

export function setReply(s: LogSummary, text: string): void {
  s.lastReply = clip(text.trim(), MAX_REPLY_CHARS);
}

const FILE_KEYS = ["file_path", "path", "notebook_path", "AbsolutePath", "TargetFile", "DirectoryPath", "SearchPath"];
const TEXT_KEYS = ["description", "command", "cmd", "pattern", "query", "url", "prompt", "skill", "subject", "CommandLine", "Query", "Url"];

/** 도구 입력에서 사람이 읽을 한 줄을 고른다 — 파일이면 이름만, 명령이면 설명이나 명령 자체. */
export function summarizeToolInput(input: unknown): string {
  if (typeof input === "string") return oneLine(input);
  if (!isRecord(input)) return "";
  for (const key of TEXT_KEYS) {
    const v = input[key];
    if (typeof v === "string" && v.trim()) return oneLine(v);
    if (Array.isArray(v) && v.every((x) => typeof x === "string")) return oneLine(v.join(" "));
  }
  for (const key of FILE_KEYS) {
    const v = str(input[key]);
    if (v) return basename(v);
  }
  for (const v of Object.values(input)) {
    if (typeof v === "string" && v.trim()) return oneLine(v);
  }
  return "";
}

const MAX_PENDING_CHARS = 2000;
/** 사용자에게 직접 묻는 도구 — 답이 올 때까지 에이전트는 반드시 멈춰 있다. */
const ASKS_USER = /^(AskUserQuestion|ExitPlanMode|ask_user|request_user_input)$/;

/** 도구 입력을 줄이지 않고 보여 줄 글로 만든다(승인 전에 무엇을 하려는지 읽을 수 있게). */
function describeToolInput(input: unknown): string {
  if (typeof input === "string") return clip(input, MAX_PENDING_CHARS);
  if (!isRecord(input)) return "";
  const lines: string[] = [];
  const command = input.command ?? input.cmd ?? input.CommandLine;
  if (typeof command === "string") lines.push(command);
  else if (Array.isArray(command)) lines.push(command.join(" "));
  for (const key of FILE_KEYS) {
    const v = str(input[key]);
    if (v) lines.push(v);
  }
  if (typeof input.plan === "string") lines.push(input.plan);
  if (lines.length === 0) {
    for (const [key, v] of Object.entries(input)) if (typeof v === "string" && v.trim()) lines.push(`${key}: ${v}`);
  } else if (typeof input.description === "string") lines.unshift(`# ${input.description}`);
  return clip(lines.join("\n"), MAX_PENDING_CHARS);
}

export function pendingRequest(tool: string, input: unknown, at: string): PendingRequest {
  const request: PendingRequest = { tool, detail: describeToolInput(input), asksUser: ASKS_USER.test(tool), at };
  if (isRecord(input) && Array.isArray(input.questions)) {
    request.questions = input.questions.filter(isRecord).map((q) => ({
      question: str(q.question) ?? "",
      options: (Array.isArray(q.options) ? q.options : []).filter(isRecord).map((o) => ({ label: str(o.label) ?? "", description: str(o.description) })),
    }));
    request.detail = request.questions.map((q) => q.question).join("\n");
  }
  return request;
}

/** 지금 답을 기다리는 요청 — 사용자에게 묻는 것이 있으면 그것, 아니면 가장 최근에 연 도구 호출. */
export function currentPending(s: LogSummary): PendingRequest | undefined {
  if (!s.turnOpen || s.open.size === 0) return undefined;
  const all = [...s.open.values()];
  return all.findLast((r) => r.asksUser) ?? all[all.length - 1];
}
