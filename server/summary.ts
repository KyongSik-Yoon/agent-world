// 어댑터들이 공통으로 채우는 로그 요약과, 그 요약을 다루는 작은 도구들.
import { basename } from "node:path";

import type { Activity, ActivityKind, PendingRequest } from "../shared/types.ts";
import type { ReviewMark } from "./review.ts";
import { type LogReader, readLineAt } from "./tail.ts";

export const MAX_RECENT = 16;
const MAX_ACTIVITY_CHARS = 220;
const MAX_PROMPT_CHARS = 4000;
const MAX_REPLY_CHARS = 8000;
/** 활동 하나의 원문을 보여 줄 때의 상한. */
const MAX_DETAIL_CHARS = 64 * 1024;

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
  /** 그 지시가 로그에 적힌 시각. 로그 밖의 입력 기록과 앞뒤를 견줄 때 쓴다(AGY). */
  lastPromptAt?: string;
  /**
   * 사람이 친 마지막 내장 명령(`/clear`, `/model sonnet`)이나 셸 명령(`!git pull`)과 그 행의 시각. 이런 명령은 지시가 아니라 lastPrompt 를 바꾸지 않으므로,
   * 월드에서 보낸 명령이 닿았는지는 이것으로 확인한다. `/clear` 는 새 로그의 첫 행으로 남는다.
   */
  lastCommand?: { text: string; at: string };
  lastReply?: string;
  /** 아직 끝나지 않은 응답의 앞부분(AGY). 다음 응답 글이 여기에 이어 붙는다. */
  replyHead?: string;
  /** 모델이 아직 일하는 중으로 보이는지(사용자 입력 직후이거나 도구 호출이 열려 있음). */
  turnOpen: boolean;
  /** 모델 응답 행을 하나라도 봤는지 — 꼬리 창을 더 키울지 판단한다. */
  sawAssistant: boolean;
  /** 사용자 행에서 지시 원문을 읽었는지. 하네스가 따로 적어 두는 한 줄 요약(Claude 의 last-prompt)만 봤으면 꼬리 창을 키운다. */
  sawPromptRow?: boolean;
  /** 마지막 지시가 일하는 중에 끼워 넣어진 지시(Claude 의 queued_command 첨부)에서 왔다. Claude 가 적는 last-prompt 행은 이것을 모른다. */
  promptQueued?: boolean;
  /**
   * 일하는 중에 보내 줄에 선 것들(Claude 의 queue-operation, 들어온 차례대로). 사람이 보낸 지시 말고도 백그라운드 일의 알림
   * 같은 것이 섞이고, 줄 행에는 누가 보냈는지가 없다 — 그래서 마지막 지시로 삼지 않고, 보낸 지시가 닿았는지 확인하는 데만 쓴다.
   */
  queued?: string[];
  /** 결과를 기다리는 도구 호출들(호출 id → 요청). 결과 행이 오면 지운다. */
  open: Map<string, PendingRequest>;
  /**
   * 이 세션에서 desk-review 가 마지막으로 남긴 리뷰 보고의 자리. 새 보고가 오면 바뀌고, 그 사이의 지시로는 지우지 않는다 —
   * 보고 뒤에 "한글로 요약" 같은 되묻기를 하고 나서 무엇을 고칠지 정하는 일이 흔하다.
   */
  review?: ReviewMark;
  /** 리뷰 보고 호출을 봤지만 아직 결과 행이 오지 않았다. 훅이 거절한(is_error) 호출은 보고가 아니다. */
  reviewCall?: ReviewMark;
  /** 로그의 마지막 사건이 컴팩션(대화 요약)이다 — 그 뒤로 지시도 응답도 없었다. */
  compacted?: boolean;
  /** 사람이 친 `/compact` 를 받았고 그 요약이 아직 적히지 않았다(agy). */
  compactAsked?: boolean;
  /** 사람이 친 `/compact` 가 마지막으로 끝난 로그 행의 자리(agy 의 CHECKPOINT, Claude 의 manual compact_boundary). AgentView.compaction 으로 간다. */
  compaction?: string;
  /** 지금 읽고 있는 행의 자리와, 그 행에서 지금까지 나온 활동 수. 활동의 ref 를 짓는다. */
  row?: { pos: number; nth: number };
  /** 원문을 다시 읽을 때만: 이 행의 nth 번째 활동의 원문을 여기에 받는다. */
  capture?: { nth: number; text?: string; at?: string };
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

/**
 * 제목이 지시의 앞머리를 그대로 자른 것이면 말줄임표를 붙인다. Claude Code 는 제목을 짓기 전까지 터미널 제목에 지시의 앞
 * 50칸을 표시 없이 잘라 넣는다 — 그대로 보이면 알림과 목록에서 말이 중간에 끊긴 것처럼 읽힌다. 공백은 빼고 견준다
 * (한 줄로 접을 때 줄바꿈이 사라지기도 한다).
 */
export function markCut(title: string, prompt: string | undefined): string {
  if (!prompt || title.endsWith("…")) return title;
  const bare = (v: string) => v.replace(/\s+/g, "");
  const head = bare(title);
  const whole = bare(prompt);
  return head.length >= 8 && whole.length > head.length && whole.startsWith(head) ? `${title}…` : title;
}

/** 여러 줄 텍스트를 말풍선용 한 줄로 줄인다. */
export function oneLine(text: string, max = MAX_ACTIVITY_CHARS): string {
  return clip(text.replace(/\s+/g, " ").trim(), max);
}

/**
 * 활동이 로그에 적힌 자리("줄의 바이트 위치.그 줄의 몇 번째 활동"). 원문은 이 자리로 다시 읽는다.
 * 활동 객체에 필드로 달지 않는다 — 스냅샷에 실려 매초 휴대폰으로 가는 patch 가 행마다 커진다(주민 하나에 약 290바이트).
 */
const refs = new WeakMap<Activity, string>();

export function refOf(activity: Activity): string | undefined {
  return refs.get(activity);
}

/** 리더가 행을 하나 읽기 시작할 때 부른다 — 그 행에서 나오는 활동들이 이 자리를 ref 로 단다. */
export function beginRow(s: LogSummary, pos: number): void {
  s.row = { pos, nth: 0 };
}

/** input: 도구 호출의 입력 그대로. 평소에는 쓰지 않고, 원문을 다시 읽을 때만 풀어 쓴다. */
export function pushActivity(s: LogSummary, kind: ActivityKind, name: string, text: string, at: string, input?: unknown): Activity {
  const row = s.row;
  const nth = row ? row.nth++ : 0;
  if (s.capture?.nth === nth) {
    s.capture.text = kind === "tool" ? fullToolInput(input ?? text) : clip(text, MAX_DETAIL_CHARS);
    s.capture.at = at;
  }
  // 생각은 내용이 로그에 남지 않아 "지금 생각 중"이라는 현재 상태(말풍선)로만 쓸모가 있다. 다음 활동이 오면
  // 자리를 넘겨, 활동 로그의 칸을 내용 없는 "생각 중…"이 차지하지 않게 한다.
  if (s.recent[s.recent.length - 1]?.kind === "thinking") s.recent.pop();
  const activity: Activity = { kind, name, text: oneLine(text), at };
  // 생각은 원문이 로그에 남지 않으니 펼칠 것이 없다.
  if (row && kind !== "thinking") refs.set(activity, `${row.pos}.${nth}`);
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

const DETAIL_ORDER = ["description", "command", "cmd", "CommandLine", ...FILE_KEYS];

/** 도구 입력 전부를 읽을 글로 — 설명을 앞에 두고, 값마다 "키: 값"(여러 줄이면 다음 줄부터). */
export function fullToolInput(input: unknown): string {
  if (typeof input === "string") return clip(input, MAX_DETAIL_CHARS);
  if (!isRecord(input)) return input === undefined || input === null ? "" : clip(JSON.stringify(input, null, 2), MAX_DETAIL_CHARS);
  const entries = Object.entries(input).filter(([, v]) => v !== undefined && v !== null && v !== "");
  // 무엇을 하려는지(설명) → 무엇을 돌리는지(명령) → 어디에(파일) → 나머지 순.
  const rank = (key: string) => {
    const at = DETAIL_ORDER.indexOf(key);
    return at === -1 ? DETAIL_ORDER.length : at;
  };
  entries.sort(([a], [b]) => rank(a) - rank(b));
  const blocks = entries.map(([key, v]) => {
    const value = typeof v === "string" ? v : JSON.stringify(v, null, 2);
    return value.includes("\n") ? `${key}:\n${value}` : `${key}: ${value}`;
  });
  return clip(blocks.join("\n\n"), MAX_DETAIL_CHARS);
}

/**
 * ref 자리에 적힌 활동의 원문. 그 한 줄만 다시 읽어, 같은 리더로 풀어서 그 활동을 찾는다 — 서버는 원문을 들고 있지 않는다.
 * 그 자리의 행이 이제 다른 것이면(파일이 다시 쓰였다) 시각이 어긋나므로 undefined.
 */
export async function activityText(path: string, reader: LogReader<LogSummary>, ref: string, at: string): Promise<string | undefined> {
  const m = /^(\d+)\.(\d+)$/.exec(ref);
  if (!m) return undefined;
  const pos = Number(m[1]);
  const line = await readLineAt(path, pos);
  if (line === undefined) return undefined;
  let row: unknown;
  try {
    row = JSON.parse(line);
  } catch {
    return undefined;
  }
  const s = reader.init();
  s.capture = { nth: Number(m[2]) };
  reader.feed(s, row, pos);
  return s.capture.text !== undefined && s.capture.at === at ? s.capture.text : undefined;
}

const MAX_PENDING_CHARS = 2000;
/** 사용자에게 직접 묻는 도구 — 답이 올 때까지 에이전트는 반드시 멈춰 있다. */
const ASKS_USER = /^(AskUserQuestion|ExitPlanMode|ask_user|ask_question|request_user_input)$/;

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
      options: (Array.isArray(q.options) ? q.options : [])
        // 선택지는 하네스마다 모양이 다르다 — Claude 는 { label, description }, agy 의 ask_question 은 글 한 줄이다.
        .map((o) => (typeof o === "string" ? { label: o } : isRecord(o) ? { label: str(o.label) ?? "", description: str(o.description) } : undefined))
        .filter((o) => o !== undefined),
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
