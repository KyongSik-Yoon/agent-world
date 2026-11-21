// Claude Code: `~/.claude/projects/<slug>/<session>.jsonl`.
//
// slug 는 세션을 시작한 cwd 로 만들어지는데 herdr 가 알려주는 cwd 와 어긋날 수 있다(워크트리로
// 들어간 세션 등). 그래서 slug 를 계산하지 않고 세션 id 로 파일을 찾는다.
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { LogReader } from "../tail.ts";
import {
  beginRow,
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
import { REVIEW_FIX_PROMPT } from "../../shared/types.ts";
import { REVIEW_TOOL } from "../review.ts";
import type { Harness, LogFile } from "./types.ts";

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SUBAGENT_LIVE_MS = 20_000;

function root(): string {
  return join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects");
}

// `{"type":"…"` 로 시작하는 행은 대화가 아니라 부기 행이다. 그중 쓸 것만 파싱한다 —
// api-request-blob 같은 행은 수십~수백 KB 라서 JSON 으로 푸는 것 자체가 낭비다.
const BOOKKEEPING = '{"type":"';
const WANTED_BOOKKEEPING = ['{"type":"ai-title"', '{"type":"last-prompt"', '{"type":"permission-mode"', '{"type":"queue-operation"'];

/** 사용자 행의 텍스트에서 하네스가 끼워 넣은 꼬리표를 걷어낸다. 사람이 친 말이 아니면 빈 문자열. */
function userText(raw: string): string {
  const command = skillCommand(raw);
  if (command) return command;
  if (/^<(local-command-|command-name|command-message|task-notification|bash-input|bash-stdout)/.test(raw.trimStart())) return "";
  // Esc 로 턴을 끊으면 Claude 가 사용자 행으로 남기는 표시. 사람이 친 지시가 아니다.
  if (/^\[Request interrupted by user[^\]]*\]$/.test(raw.trim())) return "";
  return withoutBlocks(raw, "<system-reminder>", "</system-reminder>")
    .replace(/<\/?pasted_content[^>]*>/g, "")
    .trim();
}

/**
 * 빗금으로 부른 스킬(`/herdr 할 일`)은 사용자 행에 친 글 대신 꼬리표로 남는다 — 이름표가 앞이다:
 *   <command-message>herdr</command-message>\n<command-name>/herdr</command-name>\n<command-args>할 일</command-args>
 * 친 그대로(`/herdr 할 일`) 되살린다. `/model`·`/compact` 같은 내장 명령은 `<command-name>` 이 앞에 오고, 월드가 모델을
 * 바꿀 때도 보내므로 지시로 치지 않는다.
 */
function skillCommand(raw: string): string | undefined {
  const text = raw.trimStart();
  if (!text.startsWith("<command-message>")) return undefined;
  const name = /<command-name>(\/[^<\s]+)<\/command-name>/.exec(text)?.[1];
  if (!name) return undefined;
  const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1]?.trim();
  return args ? `${name} ${args}` : name;
}

/** 내장 명령(`/clear`, `/model sonnet`)의 사용자 행 — `<command-name>` 이 앞이다. 친 그대로 되살린다. 스킬 꼬리표는 skillCommand. */
function builtinCommand(raw: string): string | undefined {
  const text = raw.trimStart();
  if (!text.startsWith("<command-name>")) return undefined;
  const name = /^<command-name>(\/[^<\s]+)<\/command-name>/.exec(text)?.[1];
  if (!name) return undefined;
  const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1]?.trim();
  return args ? `${name} ${args}` : name;
}

/**
 * 느낌표로 돌린 셸 명령(`!git pull`)의 사용자 행 — 친 글 대신 `<bash-input>git pull</bash-input>` 로 남는다. 친 그대로 되살린다.
 * 지시가 아니어서 내장 명령처럼 다룬다. 결과 행(`<bash-stdout>`)은 따로 오고 여기서 걸리지 않는다.
 */
function bashCommand(raw: string): string | undefined {
  const inner = /^<bash-input>([\s\S]*?)<\/bash-input>/.exec(raw.trimStart())?.[1]?.trim();
  return inner ? `!${inner}` : undefined;
}

/**
 * 여는 꼬리표와 닫는 꼬리표 사이를 걷어낸다. 닫는 꼬리표가 없으면 그대로 둔다.
 * 정규식의 게으른 되짚기로 하면 닫히지 않은 꼬리표가 많은 긴 글에서 걸리는 시간이 길이의 제곱으로 는다.
 */
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

/** 선택 창의 모델 이름("Sonnet 5.5")을 로그가 쓰는 모델 id("claude-sonnet-5-5")로. 모양이 다르면 이름 그대로 둔다. */
export function claudeModelId(name: string): string {
  return /^[A-Za-z]+ \d+(\.\d+)*$/.test(name) ? `claude-${name.toLowerCase().replace(/[ .]/g, "-")}` : name;
}

/**
 * `/model`·`/effort` 가 남긴 결과 줄. 응답 행은 다음 응답이 와야 새 모델을 적으므로, 바꾼 순간을 여기서 읽는다 —
 * 월드에서 바꿨든 터미널에서 직접 바꿨든.
 *   Set model to `Sonnet 5.5` for this session only with `low` effort
 *   Set model to `Opus 5.5` and saved as your default for new sessions
 *   Set effort level to low (saved as your default for new sessions): …
 */
function feedCommandOutput(s: LogSummary, raw: string): void {
  // 결과 행은 이 꼬리표로 시작한다. 지시나 응답 안에 인용된 같은 글이 모델을 바꾸지 않게 맨 앞만 본다.
  const out = /^\s*<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/.exec(raw)?.[1];
  if (!out) return;
  const model = /^Set model to `?([^`\n]+?)`?(?= for | and |$)(?:[^\n]*? with `?(\w+)`? effort)?/m.exec(out);
  if (model) {
    s.model = claudeModelId(model[1]!.trim());
    if (model[2]) s.effort = model[2].toLowerCase();
  }
  const effort = /^Set effort level to `?(\w+)`?/m.exec(out);
  if (effort) s.effort = effort[1]!.toLowerCase();
}

function feedAssistant(s: LogSummary, row: Record<string, unknown>, at: string): void {
  const message = row.message;
  if (!isRecord(message)) return;
  s.sawAssistant = true;
  s.compacted = false;
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
      pushActivity(s, "tool", name, summarizeToolInput(part.input), at, part.input);
      const id = str(part.id);
      if (id) s.open.set(id, pendingRequest(name, part.input, at));
      if (id && name === REVIEW_TOOL && s.row) s.reviewCall = { pos: s.row.pos, id, at };
    }
  }
  const stop = str(message.stop_reason);
  if (calledTool || stop === "tool_use") s.turnOpen = true;
  else if (stop === "end_turn" || stop === "stop_sequence" || stop === "refusal") {
    s.turnOpen = false;
    s.open.clear();
  }
}

/** 사람이 보낸 지시가 월드 리뷰 창의 '고치게 하기'면 그 보고에 답한 것으로 적는다. 보고 자체는 남긴다. */
function noteReviewReply(s: LogSummary, text: string): void {
  s.reviewCall = undefined;
  if (s.review && REVIEW_FIX_PROMPT.test(text)) s.review = { ...s.review, sent: true };
}

function feedUser(s: LogSummary, row: Record<string, unknown>, at: string): void {
  if (row.isMeta === true) return;
  // 컴팩션이 남긴 요약문은 사용자 행 모양이지만 사람이 보낸 지시가 아니다.
  if (row.isCompactSummary === true) {
    s.compacted = true;
    return;
  }
  const message = row.message;
  if (!isRecord(message)) return;
  // 백그라운드 일의 알림처럼 Claude 가 넣은 사용자 행에는 출처가 붙는다(origin.kind: task-notification·plugin·auto-continuation).
  // 지시로 치는 것은 사람(human)과 다른 세션이 보낸 것(peer)뿐이다.
  const kind = isRecord(row.origin) ? row.origin.kind : undefined;
  const human = kind === undefined || kind === "human" || kind === "peer";
  const content = message.content;
  if (typeof content === "string") {
    feedCommandOutput(s, content);
    if (!human) return;
    const command = builtinCommand(content) ?? bashCommand(content);
    if (command) {
      s.lastCommand = { text: command, at };
      return;
    }
    const text = userText(content);
    if (text) {
      setPrompt(s, text);
      s.promptQueued = false;
      noteReviewReply(s, text);
      s.sawPromptRow = true;
      pushActivity(s, "user", "", text, at);
      s.compacted = false;
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
      if (id && id === s.reviewCall?.id) {
        if (part.is_error !== true) s.review = s.reviewCall;
        s.reviewCall = undefined;
      }
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
  if (texts.length > 0 && human) {
    const text = texts.join("\n\n");
    setPrompt(s, text);
    s.promptQueued = false;
    noteReviewReply(s, text);
    s.sawPromptRow = true;
    pushActivity(s, "user", "", text, at);
    s.compacted = false;
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
  feed(s, row, pos) {
    beginRow(s, pos);
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
      case "queue-operation": {
        // 일하는 중에 보낸 지시는 줄에 선다. 받은 그 순간 남는 것은 이 행뿐이다 — 턴 사이에 끼워 넣어지면(absorbed_mid_turn)
        // 사용자 행 없이 첨부(queued_command)로만, 턴이 끝나거나 끊긴 뒤에 나가면(dequeue) 그때 사용자 행으로 남는다.
        // 줄 행에는 보낸 이가 없어(백그라운드 일의 알림도 같은 줄에 선다) 마지막 지시로 삼지 않고 줄로만 들고 있는다.
        const q = (s.queued ??= []);
        const content = str(row.content) ?? "";
        if (row.operation === "enqueue") q.push(content);
        else if (row.operation === "dequeue") q.shift();
        else if (row.operation === "popAll") q.length = 0;
        else if (row.operation === "remove") {
          const i = q.indexOf(content);
          if (i >= 0) q.splice(i, 1);
        }
        // 줄이 끝없이 늘지 않게 — 실제로는 몇 개를 넘지 않는다.
        if (q.length > 20) q.splice(0, q.length - 20);
        break;
      }
      case "attachment": {
        const a = row.attachment;
        if (row.isSidechain === true || !isRecord(a) || a.type !== "queued_command" || !isRecord(a.origin) || a.origin.kind !== "human") break;
        // 이미지를 붙인 지시는 글 하나가 아니라 사용자 행처럼 조각 배열([{type:"text"}, {type:"image"}])로 남는다.
        const parts = Array.isArray(a.prompt) ? a.prompt.filter((p) => isRecord(p) && p.type === "text").map((p) => str(p.text) ?? "") : [str(a.prompt) ?? ""];
        const text = parts
          .map(userText)
          .filter(Boolean)
          .join("\n\n");
        if (!text) break;
        setPrompt(s, text);
        s.promptQueued = true;
        noteReviewReply(s, text);
        pushActivity(s, "user", "", text, at);
        break;
      }
      case "last-prompt": {
        // Claude Code 가 직접 적어 두는 마지막 프롬프트(줄바꿈을 지운 한 줄로 잘린 형태). 사용자 행에서 읽은 원문이
        // 같은 프롬프트면 원문을 두고, 다르면(꼬리 창 밖이었다면) 이 값을 쓴다. 공백은 아예 빼고 견준다 — 한 줄로 접을 때
        // 줄바꿈이 사라지기도 해서("[Image #4]\n\n글" → "[Image #4]글") 한 칸으로 접어 견주면 원문이 잘린 한 줄에 덮인다.
        const text = str(row.lastPrompt);
        // 줄 선 지시는 이 행에 적히지 않는다 — 그 앞의 지시가 다시 적혀 방금 받은 지시를 덮는다.
        if (!text || s.promptQueued) break;
        const bare = (v: string) => v.replace(/\s+/g, "");
        const head = bare(text.replace(/…$/, "")).slice(0, 40);
        if (!s.lastPrompt || !bare(s.lastPrompt).startsWith(head)) setPrompt(s, text);
        break;
      }
    }
  },
  // last-prompt 는 줄바꿈을 지우고 잘라 둔 한 줄이라, 지시 원문이 담긴 사용자 행까지 닿아야 준비된 것으로 본다. 로그가
  // 길면 몇 MB 를 더 읽지만 세션마다 처음 한 번뿐이다(그 뒤로는 덧붙은 바이트만 읽는다).
  ready: (s) => s.sawAssistant && s.sawPromptRow === true,
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

/**
 * 문맥 창 크기. 로그에는 쓴 토큰만 있고 창 크기(20만·100만)는 없다. herdr 웹 UI 의 statusLine tee 를 깔아 두었으면,
 * Claude Code 가 statusLine 에 넘기는 창 크기를 세션마다 `~/.herdr/statusline-context/<프로필>-<세션>.json` 에 남긴다
 * (프로필은 Claude 설정 폴더 실경로의 sha256 앞 16자리). 없으면 모르는 채로 둔다 — 토큰 수만 보인다.
 * 이 파일은 세션의 첫 statusLine 때 한 번 쓰이고 덮어쓰이지 않는다. 세션 중에 /model 로 바꾸면 낡으므로, 적힌 모델이
 * 지금 모델과 다르면 믿지 않는다. 파일은 바뀌었을 때만(mtime) 다시 읽는다.
 */
const WINDOW_FILE_MAX = 4096;
const windows = new Map<string, { mtimeMs: number; model: string; window: number } | null>();
let profile: string | null | undefined;

function claudeProfile(): string | null {
  if (profile !== undefined) return profile;
  try {
    const dir = realpathSync(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"));
    profile = createHash("sha256").update(dir).digest("hex").slice(0, 16);
  } catch {
    profile = null;
  }
  return profile;
}

/** `claude-opus-5-5[1m]` 와 `claude-opus-5-5` 를 같은 모델로 본다. */
const baseModel = (model: string): string => model.replace(/\[[^\]]*\]$/, "");

async function contextWindow(sessionId: string, model: string | undefined): Promise<number | undefined> {
  const prefix = SESSION_ID.test(sessionId) ? claudeProfile() : null;
  if (!prefix) return undefined;
  const path = join(homedir(), ".herdr", "statusline-context", `${prefix}-${sessionId}.json`);
  let mtimeMs: number;
  try {
    const st = await stat(path);
    if (!st.isFile() || st.size > WINDOW_FILE_MAX) return undefined;
    mtimeMs = st.mtimeMs;
  } catch {
    return undefined;
  }
  let got = windows.get(path);
  if (got === undefined || (got && got.mtimeMs !== mtimeMs)) {
    got = null;
    try {
      const body: unknown = JSON.parse(await readFile(path, "utf8"));
      const w = isRecord(body) ? num(body.window) : undefined;
      const m = isRecord(body) ? str(body.model) : undefined;
      if (w && Number.isSafeInteger(w) && w > 0 && m) got = { mtimeMs, model: m, window: w };
    } catch {
      // 쓰는 중이거나 깨진 파일이면 모르는 것으로 둔다.
    }
    windows.set(path, got);
  }
  if (!got || (model && baseModel(model) !== baseModel(got.model))) return undefined;
  return got.window;
}

export const claude: Harness = {
  vendor: "claude",
  matches: (agent) => agent === "claude" || /^claude[-._]/.test(agent),
  reader: claudeReader,
  async resolve(sessionId) {
    if (!SESSION_ID.test(sessionId)) return null;
    return findSessionFile(sessionId);
  },
  contextWindow,
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
