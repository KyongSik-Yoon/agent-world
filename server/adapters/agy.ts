// Antigravity CLI: `~/.gemini/antigravity-cli/brain/<id>/.system_generated/logs/transcript_full.jsonl`.
//
// 대화의 정본은 `conversations/<id>.db`(protobuf 스텝)지만, AGY 가 같은 내용을 평문 jsonl 로도
// 적어 둔다. 스텝 하나가 한 행이고 모델·토큰·도구 호출이 그대로 들어 있어 이쪽만 읽는다.
// 곁의 `transcript.jsonl` 은 같은 행들을 줄여 적은 사본이다(도구 호출 인자와 긴 글이 잘리고 `truncated_fields` 가 붙는다).
// 활동의 원문을 펼쳐 보려면 잘리지 않은 쪽을 읽어야 해서 `_full` 을 읽고, 없으면 줄인 쪽으로 물러난다.
// 꼬리만 읽고 이어서 읽으므로 파일이 두 배 커도 읽는 비용은 거의 같다(갱신 한 번 0.16ms 안팎으로 같았다).
// 제목과 서브에이전트의 부모 대화는 로그에 없어서 `conversation_summaries.db` 에서 읽는다.
import { Database } from "bun:sqlite";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { type LogReader, TailedLog } from "../tail.ts";
import { beginRow, clip, emptySummary, isRecord, num, pendingRequest, pushActivity, setPrompt, setReply, str, summarizeToolInput, type LogSummary } from "../summary.ts";
import { agyStatusPayload } from "../usage.ts";
import type { Harness, LogFile, Typed } from "./types.ts";

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TITLE_TTL_MS = 30_000;

function root(): string {
  return process.env.AGY_HOME || join(homedir(), ".gemini", "antigravity-cli");
}

const LOG_NAMES = ["transcript_full.jsonl", "transcript.jsonl"];

/** 이 대화의 로그와 그 상태. 잘리지 않은 쪽이 있으면 그것을 고른다. */
async function findLog(sessionId: string): Promise<{ path: string; mtimeMs: number } | null> {
  const dir = join(root(), "brain", sessionId, ".system_generated", "logs");
  for (const name of LOG_NAMES) {
    const path = join(dir, name);
    try {
      return { path, mtimeMs: (await stat(path)).mtimeMs };
    } catch {
      // 이 이름은 없다 — 다음 것.
    }
  }
  return null;
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

/** 여는 꼬리표와 닫는 꼬리표 사이를 걷어낸다. 닫는 꼬리표가 없으면 그대로 둔다. */
function withoutBlocks(text: string, open: string, close: string): string {
  let out = "";
  let from = 0;
  for (;;) {
    const a = text.indexOf(open, from);
    const b = a < 0 ? -1 : text.indexOf(close, a + open.length);
    if (b < 0) return out + text.slice(from);
    out += text.slice(from, a);
    from = b + close.length;
  }
}

// 로그의 글은 남이 쓴 것이고 길이도 제멋대로다. 꼬리표 사이를 정규식의 게으른 되짚기로 찾으면 닫는 꼬리표가 없는 긴 글에서
// 걸리는 시간이 길이의 세제곱으로 늘어 서버가 몇 초씩 멈춘다. 위치를 찾아 잘라 낸다.
function userRequest(content: string): string {
  const open = "<USER_REQUEST>";
  const a = content.indexOf(open);
  const b = a < 0 ? -1 : content.indexOf("</USER_REQUEST>", a + open.length);
  return (b >= 0 ? content.slice(a + open.length, b) : withoutBlocks(content, "<ADDITIONAL_METADATA>", "</ADDITIONAL_METADATA>")).trim();
}

// ── 문맥 창 크기 ─────────────────────────────────────────────────────────────────────────────
//
// 로그에는 쓴 토큰만 있고 창 크기는 없다. AGY 는 statusLine 스크립트에 `context_window.context_window_size` 를 넘겨 주는데,
// 사용량 칩이 읽는 그 스크립트의 마지막 입력(`/tmp/agy-statusline-<uid>/last-payload.json`)은 마지막으로 그린 대화 하나 것뿐이다.
// 창 크기는 대화가 아니라 모델에 딸려서, 읽을 때마다 모델별로 기억해 두고 로그의 모델이 같은 대화에 쓴다(1.5.14 에서
// Gemini 4 Neon 이 1048576). 대화가 시작되기 전의 입력은 크기가 0 이라 버린다.

/** 같은 모델을 로그는 `gemini-4-neon-high`, statusLine 은 `Gemini 4 Neon (High)` 로 적는다. 사고 수준은 창 크기와 상관없어 뗀다. */
const modelKey = (model: string): string =>
  model
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-(low|medium|high|xhigh|max)$/, "");

const seenWindows = new Map<string, number>();

async function contextWindow(_sessionId: string, model: string | undefined): Promise<number | undefined> {
  const got = await agyStatusPayload();
  if (got) {
    const m = got.body.model;
    const id = isRecord(m) ? (str(m.id) ?? str(m.display_name)) : str(m);
    const ctx = got.body.context_window;
    const size = isRecord(ctx) ? num(ctx.context_window_size) : undefined;
    if (id && size && Number.isSafeInteger(size) && size > 0) seenWindows.set(modelKey(id), size);
  }
  return model ? seenWindows.get(modelKey(model)) : undefined;
}

export const agyReader: LogReader<LogSummary> = {
  init: emptySummary,
  feed(s, row, pos) {
    beginRow(s, pos);
    if (!isRecord(row)) return;
    const at = str(row.created_at) ?? "";
    const content = str(row.content) ?? "";
    switch (row.type) {
      case "USER_INPUT": {
        const text = userRequest(content);
        if (text) {
          setPrompt(s, text);
          s.lastPromptAt = at;
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
          pushActivity(s, "tool", name, summary, at, args);
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

// ── 입력 기록(history.jsonl) ─────────────────────────────────────────────────────────────────
//
// 대화 로그만 봐서는 보낸 것이 닿았는지 알 수 없는 입력이 둘 있다(1.5.13 에서 확인):
//   - 슬래시 명령(`/clear`, `/rename …`)과 셸 명령은 대화 로그에 행을 남기지 않는다.
//   - 일하는 중에 보낸 지시는 AGY 가 줄을 세웠다가 그 턴이 끝난 뒤에야 USER_INPUT 으로 적는다(몇 초에서 몇 분 뒤).
// AGY 는 입력창에서 Enter 를 받은 것을 모두 `history.jsonl` 에 곧바로(0.3초 안) 한 줄씩 적는다. 줄에는 글과 시각, 폴더가 있고
// 대화가 이미 있으면 그 id 가 붙는다. 슬래시 명령은 `type: "slash_command"`, 셸 명령은 `"shell"`(글에 느낌표가 없다)인데,
// `/compact` 처럼 프롬프트로 풀리는 명령은 type 없이 글만 `/` 로 시작한다.

interface TypedRow {
  text: string;
  at: number;
  command: boolean;
  session?: string;
  cwd?: string;
}

/** 기억해 두는 입력 행 수. 닿았는지는 보낸 직후에만 묻는다 — 모든 pane 을 합쳐 최근 것만 있으면 된다. */
const MAX_TYPED = 300;
const MAX_TYPED_CHARS = 200;
/** 줄에 선 것으로 치는 동안. 그보다 오래된 글은 로그가 지시로 적었거나(꼬리 창 밖) 사람이 줄에서 뺀 것이다. */
const QUEUED_FOR_MS = 30 * 60_000;
/** 한 스냅샷 안에서 pane 마다 파일 상태를 다시 묻지 않게 한다. */
const TYPED_RECHECK_MS = 300;

const typedReader: LogReader<{ rows: TypedRow[] }> = {
  init: () => ({ rows: [] }),
  feed(s, row) {
    if (!isRecord(row)) return;
    const display = str(row.display);
    const at = num(row.timestamp);
    if (!display || at === undefined) return;
    const shell = row.type === "shell";
    s.rows.push({
      // 붙여 넣은 긴 글도 한 줄로 남는다. 닿았는지는 앞머리로만 견주므로 스냅샷에 통째로 싣지 않는다.
      text: clip(shell ? `!${display}` : display, MAX_TYPED_CHARS),
      at,
      command: shell || row.type === "slash_command" || display.startsWith("/"),
      session: str(row.conversationId),
      cwd: str(row.workspace),
    });
    if (s.rows.length > MAX_TYPED) s.rows.splice(0, s.rows.length - MAX_TYPED);
  },
  ready: () => true,
};

let typedLog: { tail: TailedLog<{ rows: TypedRow[] }>; checkedAt: number } | undefined;

async function typedRows(): Promise<TypedRow[]> {
  const path = join(root(), "history.jsonl");
  if (typedLog?.tail.path !== path) typedLog = { tail: new TailedLog(path, typedReader), checkedAt: 0 };
  const now = Date.now();
  if (now - typedLog.checkedAt >= TYPED_RECHECK_MS) {
    typedLog.checkedAt = now;
    await typedLog.tail.refresh().catch(() => false);
  }
  return typedLog.tail.state.rows;
}

/** 대화를 비우는 명령(`/clear`, 다른 이름 `/new`). */
const CLEARS = /^\/(clear|new)\s*$/;

/** 지난 대화로 옮겨 가는 명령(`/resume`, 다른 이름 `/switch`). */
const SWITCHES = /^\/(resume|switch)(\s|$)/;

const head = (text: string): string => text.replace(/\s+/g, " ").trim().slice(0, 64);

/** 이 대화(아직 대화가 없는 행은 이 폴더)의 마지막 명령과, 로그의 마지막 지시 뒤에 친 글들. */
async function typedFor(sessionId: string | undefined, cwd: string, last: { prompt?: string; at?: string }): Promise<Typed | undefined> {
  const rows = await typedRows();
  const loggedAt = last.at ? Date.parse(last.at) : NaN;
  const since = Math.max(Number.isFinite(loggedAt) ? loggedAt : 0, Date.now() - QUEUED_FOR_MS);
  const logged = last.prompt ? head(last.prompt) : undefined;
  let command: Typed["command"];
  let clearedAt: number | undefined;
  const queued: string[] = [];
  // `/clear` 는 곧바로 새 대화를 만들어 그 뒤의 명령에는 새 id 가 붙는데, herdr 는 첫 지시가 갈 때까지 비우기 전의 id 를 알려 준다.
  // 그래서 이 대화를 비운 뒤 같은 폴더에서 처음 나타난 id 를 이 pane 의 것으로 잇는다.
  const mine = new Set(sessionId ? [sessionId] : []);
  const seen = new Set<string>();
  let cleared = false;
  for (const r of rows) {
    if (r.session) {
      if (cleared && !seen.has(r.session) && r.cwd === cwd) {
        mine.add(r.session);
        cleared = false;
      }
      seen.add(r.session);
      if (!mine.has(r.session)) continue;
    } else if (r.cwd !== cwd) continue;
    // 대화를 비웠다고 보는 것은 이 대화의 id 가 붙은 행뿐이다. id 없는 행은 폴더로만 맞춘 것이라, 그것으로 비우면 같은 폴더의
    // 다른 pane 이 친 `/clear` 가 이 pane 을 비운다.
    if (r.session && r.command && CLEARS.test(r.text)) {
      cleared = true;
      clearedAt = r.at;
    }
    // 비운 뒤에 그 대화를 다시 열었으면(`/resume`, `agy -c`) 화면에는 그 대화가 있다 — herdr 가 알려 주는 id 로 다시 친 것이 있거나
    // 옮겨 가는 명령을 쳤으면 비운 것을 잊고, 무엇이 열려 있는지는 herdr 의 세션을 믿는다.
    else if (clearedAt !== undefined && (r.session === sessionId || (r.command && SWITCHES.test(r.text)))) {
      cleared = false;
      clearedAt = undefined;
    }
    if (r.command) command = { text: r.text, at: String(r.at) };
    // 로그의 시각은 초 단위라 같은 초에 보낸 지시가 "뒤"로 보인다 — 글이 같으면 이미 지시로 적힌 것이다.
    else if (r.at > since && head(r.text) !== logged) queued.push(r.text);
  }
  return command || queued.length ? { command, clearedAt, queued: queued.length ? queued : undefined } : undefined;
}

// 요약 DB 의 한 행. 제목과, 서브에이전트면 그것을 부른 대화.
interface SummaryRow {
  title?: string;
  parent?: string;
}

/** id → 행. null 은 "DB 에 아직 행이 없다", undefined 는 "DB 를 읽지 못했다". */
const rows = new Map<string, { at: number; row: SummaryRow | null | undefined }>();
/** 행이 없던 id 는 금방 다시 본다 — 갓 만든 대화는 행이 조금 늦게 적힐 수 있다. */
const MISSING_TTL_MS = 2_000;

function readRow(sessionId: string): SummaryRow | null | undefined {
  const hit = rows.get(sessionId);
  if (hit && Date.now() - hit.at < (hit.row === null ? MISSING_TTL_MS : TITLE_TTL_MS)) return hit.row;
  let row: SummaryRow | null | undefined;
  try {
    const db = new Database(join(root(), "conversation_summaries.db"), { readonly: true });
    try {
      const r = db
        .query("select title, parent_conversation_id as parent from conversation_summaries where conversation_id = ?")
        .get(sessionId) as { title?: string; parent?: string } | null;
      row = r ? { title: r.title?.trim() || undefined, parent: r.parent?.trim() || undefined } : null;
    } finally {
      db.close();
    }
  } catch {
    // DB 가 없거나 잠겨 있거나 열이 다르다 — 모르는 채로 간다.
  }
  rows.set(sessionId, { at: Date.now(), row });
  return row;
}

/** 서브에이전트가 몇 겹으로 부를 수 있는지의 상한. 행이 서로를 부모로 가리켜도 돌지 않게 한다. */
const MAX_NESTING = 8;

/**
 * 이 대화를 거슬러 올라간 맨 위 대화. 서브에이전트(invoke_subagent, 스웜)는 저마다 새 대화로 돌며 같은 pane 의 환경에서
 * herdr 훅을 불러, herdr 가 pane 의 세션을 그 대화로 바꿔 적는다. 그대로 읽으면 서브에이전트들이 돌아가며 카드를 덮어쓴다.
 * DB 에 행이 아직 없으면 null — 서브에이전트인지 아직 알 수 없다.
 */
function mainOf(sessionId: string): string | null {
  let id = sessionId;
  for (let depth = 0; depth < MAX_NESTING; depth += 1) {
    const row = readRow(id);
    if (row === undefined) return id;
    if (row === null) return depth === 0 ? null : id;
    if (!row.parent) return id;
    id = row.parent;
  }
  return id;
}

export const agy: Harness = {
  vendor: "agy",
  matches: (agent) => agent === "agy" || /^agy[-.]/.test(agent) || agent.startsWith("antigravity"),
  reader: agyReader,
  async resolve(sessionId) {
    if (!SESSION_ID.test(sessionId)) return null;
    return (await findLog(sessionId))?.path ?? null;
  },
  contextWindow,
  async title(sessionId) {
    return SESSION_ID.test(sessionId) ? (readRow(sessionId)?.title ?? undefined) : undefined;
  },
  async mainSession(sessionId) {
    return SESSION_ID.test(sessionId) ? mainOf(sessionId) : sessionId;
  },
  typed: typedFor,
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
        // 로그가 아직 없는 대화는 null 이다.
        const log = await findLog(sessionId);
        // 서브에이전트는 부른 대화의 일부다 — 따로 주민으로 세우지 않는다.
        if (log && log.mtimeMs >= sinceMs && !readRow(sessionId)?.parent) found.push({ sessionId, ...log });
      }),
    );
    return found;
  },
};
