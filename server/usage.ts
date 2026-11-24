// 하네스별 요금제와 한도 사용량. 위 막대의 사용량 칩이 쓴다.
//
// 하네스에 훅을 걸지 않는다 — 각 하네스가 이 PC 에 남겨 둔 것을 읽고, Claude Code 만 사용량 API 에 한 번 묻는다.
//  - Claude Code: Claude Code 가 남긴 로그인 토큰으로 사용량 API(`/api/oauth/usage`)를 3분마다 부른다(5시간·7일·모델별 창).
//    토큰은 읽기만 하고 갱신하지 않는다. herdr 웹 UI 의 statusLine tee 가 남기는 `~/.herdr/statusline-last.json` 이
//    있으면 그 값도 섞는다. 요금제 이름은 Claude 설정(`.claude.json`)의 계정 정보에서.
//  - Codex: 세션 로그의 token_count 행에 실려 오는 rate_limits(창과 요금제).
//  - Antigravity: statusLine 스크립트가 받은 것을 `/tmp/agy-statusline-<uid>/last-payload.json` 에 남겨 두었을 때만.
// 읽을 것이 없는 하네스는 칩이 없다. 계정 메일·id·토큰은 읽어도 화면으로 내보내지 않는다.
//
// 값은 드물게 바뀐다(퍼센트 한 칸). 스냅샷마다 읽지 않고 CHECK_MS 마다 파일 시각만 보고, 바뀐 파일만 다시 읽는다.
import { lstat, open, readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { UsageView, UsageWindow } from "../shared/types.ts";
import { isRecord, num, str } from "./summary.ts";

const CHECK_MS = 30_000;
/** 읽은 값이 이보다 묵었으면 언제 것인지 함께 내보낸다. 그 안이면 방금 것으로 본다. */
const FRESH_MS = 15 * 60_000;
/** Claude 설정 파일은 크고(수백 KB) 자주 고쳐진다. 계정이 그대로면 이만큼은 다시 읽지 않는다. */
const ACCOUNT_EVERY_MS = 10 * 60_000;
/** 가장 새 Codex 세션 로그를 다시 찾는 간격. */
const CODEX_FIND_MS = 5 * 60_000;
/** rate_limits 행을 찾으려고 로그 끝에서 읽는 양. 턴마다 한 번씩 적히므로 보통 맨 끝 몇 줄 안에 있다. */
const CODEX_TAIL_BYTES = 512 * 1024;
const SMALL_FILE_MAX = 256 * 1024;

interface Reading {
  plan?: string;
  windows: UsageWindow[];
  /** 이 값을 읽은(적힌) 시각. */
  at: number;
}

const pct = (v: number): number => Math.max(0, Math.min(100, Math.round(v)));

function window(usedPct: number | undefined, resetsAt: number | undefined, minutes?: number, group?: string): UsageWindow | undefined {
  if (usedPct === undefined) return undefined;
  // 초기화 시각은 분까지만 — 읽을 때마다 몇 초씩 흔들리는 하네스가 있어, 그대로 두면 스냅샷이 매번 달라진다.
  return { usedPct: pct(usedPct), ...(resetsAt !== undefined && resetsAt > 0 ? { resetsAt: Math.round(resetsAt / 60_000) * 60_000 } : {}), ...(minutes ? { minutes } : {}), ...(group ? { group } : {}) };
}

type SmallJson = { body: Record<string, unknown>; mtimeMs: number; size: number };
const smallRead = new Map<string, SmallJson>();

/** 작은 JSON 파일. 일반 파일이 아니거나 크거나 깨졌으면 없는 것으로 본다. 시각과 크기가 그대로면 다시 읽지 않는다. */
async function smallJson(path: string): Promise<SmallJson | undefined> {
  try {
    const st = await stat(path);
    if (!st.isFile() || st.size > SMALL_FILE_MAX) return undefined;
    const kept = smallRead.get(path);
    if (kept && kept.mtimeMs === st.mtimeMs && kept.size === st.size) return kept;
    const body: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!isRecord(body)) return undefined;
    const got = { body, mtimeMs: st.mtimeMs, size: st.size };
    smallRead.set(path, got);
    return got;
  } catch {
    return undefined;
  }
}

// ── Claude Code ─────────────────────────────────────────────────────────────────────────────

const claudeLimitsPath = (): string => process.env.AGENT_WORLD_CLAUDE_LIMITS || join(homedir(), ".herdr", "statusline-last.json");
const claudeConfigPath = (): string => (process.env.CLAUDE_CONFIG_DIR ? join(process.env.CLAUDE_CONFIG_DIR, ".claude.json") : join(homedir(), ".claude.json"));

let claudeAccount: { id?: string; plan?: string; readAt: number } | undefined;

/** 이 서버가 보는 Claude 설정에 로그인한 계정. want 와 다른 계정을 기억하고 있으면 주기를 기다리지 않고 다시 읽는다. */
async function claudeSignedIn(want?: string): Promise<{ id?: string; plan?: string }> {
  const now = Date.now();
  if (claudeAccount && (want === undefined || claudeAccount.id === want ? now - claudeAccount.readAt < ACCOUNT_EVERY_MS : now - claudeAccount.readAt < CHECK_MS)) return claudeAccount;
  let id: string | undefined;
  let plan: string | undefined;
  try {
    const config: unknown = JSON.parse(await readFile(claudeConfigPath(), "utf8"));
    const oauth = isRecord(config) && isRecord(config.oauthAccount) ? config.oauthAccount : undefined;
    id = str(oauth?.accountUuid)?.trim() || undefined;
    plan = str(oauth?.planDisplayName)?.trim() || undefined;
  } catch {
    // 설정이 없거나 읽지 못하면 누구의 한도인지 모른다 — 보이지 않는다.
  }
  claudeAccount = { id, plan, readAt: now };
  return claudeAccount;
}

/**
 * 그 파일은 떠 있는 Claude 세션마다 statusLine 을 그릴 때(10초마다) 덮어쓴다. 그런데 세션의 한도 값은 그 세션이 마지막으로
 * 답을 받은 때의 것이라, 쉬고 있는 세션은 며칠 묵은 숫자를 계속 적는다 — 파일이 1초 사이에도 45%·65% 를 오간다.
 * 한 창(같은 초기화 시각) 안에서 사용량은 줄지 않으므로, 같은 창이면 가장 큰 값이 지금 값이고 더 늦은 초기화 시각이 새 창이다.
 */
let claudeHeld: { owner: string; windows: Map<string, UsageWindow> } | undefined;

function newerWindow(held: UsageWindow | undefined, seen: UsageWindow): UsageWindow {
  if (!held) return seen;
  const was = held.resetsAt ?? 0;
  const now = seen.resetsAt ?? 0;
  if (now !== was) return now > was ? seen : held;
  return seen.usedPct >= held.usedPct ? seen : held;
}

const heldKey = (w: UsageWindow): string => `${w.group ?? ""}:${w.minutes ?? 0}`;

function hold(w: UsageWindow): void {
  const key = heldKey(w);
  claudeHeld!.windows.set(key, newerWindow(claudeHeld!.windows.get(key), w));
}

/**
 * 모델별 주간 한도(Fable 등)는 statusLine 에 실려 오지 않는다. 사용자의 statusLine 스크립트가 60초마다 usage API 를 불러
 * 남겨 두는 응답이 있으면 함께 읽는다 — 이 서버가 3분마다 묻는 사이의 값을 채운다.
 * 설정 폴더나 한도 파일을 돌려 띄운 서버(시험·그림 찍기)는 이 PC 의 실제 응답을 읽지 않는다.
 */
function claudeUsageCachePath(): string | undefined {
  if (process.env.AGENT_WORLD_CLAUDE_USAGE) return process.env.AGENT_WORLD_CLAUDE_USAGE;
  if (process.env.AGENT_WORLD_CLAUDE_LIMITS || process.env.CLAUDE_CONFIG_DIR) return undefined;
  return join(process.env.XDG_RUNTIME_DIR || join(homedir(), ".cache"), "claude-statusline", "statusline-usage-cache.json");
}

/** usage API 응답의 창들. 모델별 한도는 모델 이름을 묶음으로 단다. */
function usageWindows(body: Record<string, unknown>): UsageWindow[] {
  const at = (v: unknown): number | undefined => {
    const t = Date.parse(str(v) ?? "");
    return Number.isFinite(t) ? t : undefined;
  };
  const windows: UsageWindow[] = [];
  for (const [key, minutes] of [["five_hour", 300], ["seven_day", 7 * 1440]] as const) {
    const w = isRecord(body[key]) ? body[key] : undefined;
    const made = window(num(w?.utilization), at(w?.resets_at), minutes);
    if (made) windows.push(made);
  }
  for (const limit of Array.isArray(body.limits) ? body.limits : []) {
    if (!isRecord(limit) || limit.kind !== "weekly_scoped") continue;
    const model = isRecord(limit.scope) && isRecord(limit.scope.model) ? str(limit.scope.model.display_name)?.trim() : undefined;
    const made = model ? window(num(limit.percent), at(limit.resets_at), 7 * 1440, model) : undefined;
    if (made) windows.push(made);
  }
  return windows;
}

async function claudeUsageCache(): Promise<{ windows: UsageWindow[]; at: number } | undefined> {
  const path = claudeUsageCachePath();
  if (!path) return undefined;
  if (!process.env.AGENT_WORLD_CLAUDE_USAGE) {
    const dir = await lstat(join(path, "..")).catch(() => undefined);
    if (!dir?.isDirectory() || dir.uid !== process.getuid?.()) return undefined;
  }
  const got = await smallJson(path);
  return got ? { windows: usageWindows(got.body), at: got.mtimeMs } : undefined;
}

/** 계정이 적혀 있지 않은 응답(cache)이 계정을 아는 창들(known)과 같은 창인가 — 모델 묶음 없는 창의 초기화 시각이 같으면 그렇다. */
function sameWindows(cache: UsageWindow[], known: (w: UsageWindow) => UsageWindow | undefined): boolean {
  return cache.some((w) => !w.group && w.resetsAt !== undefined && known(w)?.resetsAt === w.resetsAt);
}

/** 사용량 API 를 다시 부르는 간격. 같은 API 를 부르는 statusLine 스크립트를 쓰는 PC 도 있어, 잦으면 둘 다 429 를 받는다. */
const CLAUDE_API_EVERY_MS = 3 * 60_000;
/** 거절(429·5xx)이나 망 끊김 뒤에 쉬는 간격. 서버가 Retry-After 로 더 길게 말하면 그만큼(1시간까지) 쉰다. */
const CLAUDE_API_BACKOFF_MS = 10 * 60_000;
const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
/** Claude Code 가 기본 설정 폴더의 로그인을 키체인(macOS)·Secret Service(Linux)에 둘 때의 이름. */
const CLAUDE_CRED_SERVICE = "Claude Code-credentials";

/** 가상 값으로 시험하는 서버와 끄라고 한 서버는 API 에 묻지 않는다. */
const claudeApiOn = (): boolean => process.env.AGENT_WORLD_CLAUDE_USAGE_API !== "0" && !process.env.AGENT_WORLD_CLAUDE_LIMITS && !process.env.AGENT_WORLD_CLAUDE_USAGE;

/** 로그인 정보에서 접근 토큰. 사용량을 물을 권한(user:profile)이 없는 토큰(추론 전용 setup-token)은 쓰지 않는다. */
function tokenFrom(text: string): { token: string; expiresAt?: number } | undefined {
  try {
    const body: unknown = JSON.parse(text);
    const oauth = isRecord(body) && isRecord(body.claudeAiOauth) ? body.claudeAiOauth : undefined;
    const token = str(oauth?.accessToken)?.trim();
    if (!token) return undefined;
    if (Array.isArray(oauth?.scopes) && !oauth.scopes.includes("user:profile")) return undefined;
    return { token, expiresAt: num(oauth?.expiresAt) };
  } catch {
    return undefined;
  }
}

async function secretStore(cmd: string[]): Promise<string | undefined> {
  try {
    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore", stdin: "ignore", timeout: 2000 });
    const out = await new Response(proc.stdout).text();
    return (await proc.exited) === 0 ? out : undefined;
  } catch {
    return undefined; // 그 도구가 없다.
  }
}

/** Claude Code 가 남긴 로그인 토큰. 설정 폴더의 파일을 먼저 보고, 기본 폴더면 OS 의 비밀 저장소도 본다. */
async function claudeToken(): Promise<{ token: string; expiresAt?: number } | undefined> {
  const dir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  const file = await readFile(join(dir, ".credentials.json"), "utf8").catch(() => undefined);
  const fromFile = file ? tokenFrom(file) : undefined;
  // 설정 폴더를 돌린 Claude Code 는 비밀 저장소에 다른 이름으로 둔다 — 그 이름은 모르니 파일만 본다.
  if (fromFile || process.env.CLAUDE_CONFIG_DIR) return fromFile;
  const cmd =
    process.platform === "darwin" ? ["security", "find-generic-password", "-s", CLAUDE_CRED_SERVICE, "-w"]
    : process.platform === "linux" ? ["secret-tool", "lookup", "service", CLAUDE_CRED_SERVICE]
    : undefined;
  const blob = cmd ? await secretStore(cmd) : undefined;
  return blob ? tokenFrom(blob) : undefined;
}

/** 마지막으로 받은 API 값과, 그때 이 설정 폴더에 로그인해 있던 계정. */
let claudeApi: { owner: string; windows: UsageWindow[]; at: number } | undefined;
let claudeApiNextAt = 0;

/**
 * statusLine 을 거치지 않고 사용량 API 에 직접 묻는다 — statusLine 에 아무것도 깔지 않은 PC 에서도 사용량이 보인다.
 * 토큰을 새로 받는 것은 Claude Code 몫이다. 여기서 갱신하면 Claude Code 가 쥔 refresh token 이 바뀌어 로그인이 풀리므로,
 * 만료됐으면 Claude Code 가 새로 받아 둘 때까지 앞서 받은 값을 둔다.
 * cacheFresh: statusLine 스크립트가 같은 계정의 응답을 방금 남겨 두었다 — 같은 API 를 두 번 부르지 않고 그것을 쓴다.
 */
async function claudeUsageApi(owner: string, cacheFresh: boolean): Promise<{ windows: UsageWindow[]; at: number } | undefined> {
  if (!claudeApiOn()) return undefined;
  if (claudeApi && claudeApi.owner !== owner) {
    // 계정이 바뀌었다. 앞 계정의 숫자는 버리고 곧바로 다시 묻는다.
    claudeApi = undefined;
    claudeApiNextAt = 0;
  }
  const now = Date.now();
  if (now < claudeApiNextAt) return claudeApi;
  claudeApiNextAt = now + CLAUDE_API_EVERY_MS;
  if (cacheFresh && claudeApi) return claudeApi;
  const cred = await claudeToken();
  if (!cred) return (claudeApi = undefined); // 로그아웃했다 — 앞 계정의 값을 두지 않는다.
  if (cred.expiresAt !== undefined && cred.expiresAt <= now) return claudeApi;
  try {
    const res = await fetch(CLAUDE_USAGE_URL, {
      headers: { Authorization: `Bearer ${cred.token}`, "anthropic-beta": "oauth-2025-04-20", Accept: "application/json" },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      if (res.status === 429 || res.status >= 500) {
        const retry = Number(res.headers.get("retry-after")) * 1000;
        claudeApiNextAt = now + Math.min(60 * 60_000, Math.max(CLAUDE_API_BACKOFF_MS, Number.isFinite(retry) ? retry : 0));
      }
      return claudeApi; // 401·403 은 토큰이 바뀌어야 풀린다 — 보통 간격으로 다시 본다.
    }
    const body: unknown = await res.json();
    const windows = isRecord(body) ? usageWindows(body) : [];
    if (windows.length > 0) claudeApi = { owner, windows, at: Date.now() };
  } catch {
    claudeApiNextAt = now + CLAUDE_API_BACKOFF_MS;
  }
  return claudeApi;
}

async function readClaude(): Promise<Reading | undefined> {
  const [got, cache] = await Promise.all([smallJson(claudeLimitsPath()), claudeUsageCache().catch(() => undefined)]);
  const herdr = got && isRecord(got.body._herdr) ? got.body._herdr : {};
  const teeOwner = isRecord(herdr.account) ? str(herdr.account.id) : undefined;
  const account = await claudeSignedIn(teeOwner);
  const owner = account.id ?? "";
  // statusLine 스크립트의 응답이 3분 안의 것이고 앞서 API 로 받은 이 계정의 창과 같으면 API 를 다시 부르지 않는다.
  const lastApi = claudeApi?.owner === owner ? claudeApi : undefined;
  const cacheFresh =
    !!cache && !!lastApi && Date.now() - cache.at < CLAUDE_API_EVERY_MS && sameWindows(cache.windows, (w) => lastApi.windows.find((a) => !a.group && a.minutes === w.minutes));
  const api = await claudeUsageApi(owner, cacheFresh).catch(() => undefined);
  // statusLine 기록은 그것을 그린 CLI 의 계정 것이다. 지금 설정의 계정과 다르면(다른 프로필, 시험용 빈 설정 폴더) 남의 숫자다.
  // API 값은 이 설정 폴더의 로그인 토큰으로 물은 것이라 이 계정 것이다.
  const tee = got && teeOwner !== undefined && account.id === teeOwner ? got : undefined;
  if (!tee && !api) return undefined;
  if (claudeHeld?.owner !== owner) claudeHeld = { owner, windows: new Map() };
  let at = 0;
  if (tee) {
    const limits = isRecord(tee.body.rate_limits) ? tee.body.rate_limits : {};
    for (const [key, minutes] of [["five_hour", 300], ["seven_day", 7 * 1440]] as const) {
      const w = isRecord(limits[key]) ? limits[key] : undefined;
      const resets = num(w?.resets_at);
      const made = window(num(w?.used_percentage), resets === undefined ? undefined : resets * 1000, minutes);
      if (made) hold(made);
    }
    at = tee.mtimeMs;
  }
  if (api) {
    for (const w of api.windows) hold(w);
    at = Math.max(at, api.at);
  }
  // statusLine 스크립트가 남긴 응답에는 계정이 적혀 있지 않다. 계정을 확인한 창과 초기화 시각이 같을 때만 같은 계정·같은 창의 것으로 본다.
  if (cache && sameWindows(cache.windows, (w) => claudeHeld?.windows.get(heldKey(w)))) {
    for (const w of cache.windows) hold(w);
    at = Math.max(at, cache.at);
  }
  // 모델 묶음이 없는 창(5시간·7일)이 먼저, 그 안에서는 짧은 창부터.
  const windows = [...claudeHeld.windows.values()].sort((a, b) => (a.group ? 1 : 0) - (b.group ? 1 : 0) || (a.minutes ?? 0) - (b.minutes ?? 0));
  return windows.length > 0 ? { plan: account.plan, windows, at } : undefined;
}

// ── Codex ───────────────────────────────────────────────────────────────────────────────────

const codexSessions = (): string => join(process.env.CODEX_HOME || join(homedir(), ".codex"), "sessions");

let codexNewest: { path?: string; foundAt: number } | undefined;
let codexRead: { path: string; mtimeMs: number; size: number } | undefined;
let codexLast: Reading | undefined;

/** sessions/YYYY/MM/DD 의 가장 새 날짜 폴더에서 마지막으로 고쳐진 로그. */
async function newestCodexLog(): Promise<string | undefined> {
  if (codexNewest && Date.now() - codexNewest.foundAt < CODEX_FIND_MS) return codexNewest.path;
  let path: string | undefined;
  try {
    let dir = codexSessions();
    for (let depth = 0; depth < 3; depth++) {
      const last = (await readdir(dir)).filter((name) => /^\d+$/.test(name)).sort().at(-1);
      if (!last) throw new Error("empty");
      dir = join(dir, last);
    }
    let newest = 0;
    for (const name of await readdir(dir)) {
      if (!name.endsWith(".jsonl")) continue;
      const st = await stat(join(dir, name)).catch(() => undefined);
      if (st && st.mtimeMs > newest) {
        newest = st.mtimeMs;
        path = join(dir, name);
      }
    }
  } catch {
    // Codex 를 쓴 적이 없다.
  }
  codexNewest = { path, foundAt: Date.now() };
  return path;
}

/** 로그 끝쪽에서 마지막 rate_limits 행을 찾는다. */
async function codexLimits(path: string, size: number): Promise<Reading | undefined> {
  const file = await open(path, "r");
  try {
    const length = Math.min(size, CODEX_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    await file.read(buffer, 0, length, size - length);
    const lines = buffer.toString("utf8").split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]!;
      if (!line.includes('"rate_limits"')) continue;
      let row: unknown;
      try {
        row = JSON.parse(line);
      } catch {
        continue; // 읽기 시작한 자리에서 잘린 첫 줄
      }
      const payload = isRecord(row) && isRecord(row.payload) ? row.payload : undefined;
      const limits = payload && isRecord(payload.rate_limits) ? payload.rate_limits : undefined;
      if (!limits) continue;
      const windows: UsageWindow[] = [];
      for (const key of ["primary", "secondary"] as const) {
        const w = isRecord(limits[key]) ? limits[key] : undefined;
        const resets = num(w?.resets_at);
        const made = window(num(w?.used_percent), resets === undefined ? undefined : resets * 1000, num(w?.window_minutes));
        if (made) windows.push(made);
      }
      if (windows.length === 0) continue;
      const at = Date.parse(str(isRecord(row) ? row.timestamp : undefined) ?? "");
      return { plan: str(limits.plan_type)?.trim() || undefined, windows, at: Number.isFinite(at) ? at : Date.now() };
    }
    return undefined;
  } finally {
    await file.close();
  }
}

/** live: 지금 월드가 읽고 있는 Codex 세션들의 로그 — 옛 날짜 폴더에 있는 이어 하는 세션도 놓치지 않는다. */
async function readCodex(live: string[]): Promise<Reading | undefined> {
  const newest = await newestCodexLog();
  let pick: { path: string; mtimeMs: number; size: number } | undefined;
  for (const path of new Set([...live, ...(newest ? [newest] : [])])) {
    const st = await stat(path).catch(() => undefined);
    if (st?.isFile() && (!pick || st.mtimeMs > pick.mtimeMs)) pick = { path, mtimeMs: st.mtimeMs, size: st.size };
  }
  if (!pick) return codexLast;
  if (codexRead && codexRead.path === pick.path && codexRead.mtimeMs === pick.mtimeMs && codexRead.size === pick.size) return codexLast;
  codexRead = pick;
  try {
    // 막 시작한 세션의 로그에는 아직 한도가 없다. 그동안은 앞서 읽은 값을 둔다.
    const got = await codexLimits(pick.path, pick.size);
    if (got && (!codexLast || got.at >= codexLast.at)) codexLast = got;
  } catch {
    // 읽는 사이에 지워졌다.
  }
  return codexLast;
}

// ── Antigravity ─────────────────────────────────────────────────────────────────────────────

/** AGY_HOME 을 다른 곳으로 돌려 띄운 서버(시험·그림 찍기)는 이 PC 의 실제 사용량을 읽지 않는다. */
function agyPayloadPath(): string | undefined {
  if (process.env.AGENT_WORLD_AGY_PAYLOAD) return process.env.AGENT_WORLD_AGY_PAYLOAD;
  if (process.env.AGY_HOME || process.getuid === undefined) return undefined;
  return join("/tmp", `agy-statusline-${process.getuid()}`, "last-payload.json");
}

/** `gemini-5h`, `3p-weekly` 같은 이름을 묶음과 창 길이로 가른다. 모르는 꼴이면 이름째 묶음으로 둔다. */
function agyWindowName(key: string): { group?: string; minutes?: number } {
  const m = /^(.*?)[-_]?(weekly|daily|\d+[hd])$/i.exec(key);
  if (!m) return { group: key };
  const span = m[2]!.toLowerCase();
  const minutes = span === "weekly" ? 7 * 1440 : span === "daily" ? 1440 : Number.parseInt(span, 10) * (span.endsWith("d") ? 1440 : 60);
  return { group: m[1] || undefined, minutes };
}

/** statusLine 스크립트가 받은 마지막 입력. 사용량과 함께 문맥 창 크기(`context_window`)도 여기서 읽는다(adapters/agy.ts). */
export async function agyStatusPayload(): Promise<SmallJson | undefined> {
  const path = agyPayloadPath();
  if (!path) return undefined;
  if (!process.env.AGENT_WORLD_AGY_PAYLOAD) {
    // /tmp 아래다. 폴더가 내 것이고 링크가 아닐 때만 믿는다.
    const dir = await lstat(join(path, "..")).catch(() => undefined);
    if (!dir?.isDirectory() || dir.uid !== process.getuid?.()) return undefined;
  }
  return smallJson(path);
}

async function readAgy(): Promise<Reading | undefined> {
  const got = await agyStatusPayload();
  if (!got || !isRecord(got.body.quota)) return undefined;
  const windows: UsageWindow[] = [];
  for (const [key, value] of Object.entries(got.body.quota)) {
    const remaining = isRecord(value) ? num(value.remaining_fraction) : undefined;
    if (remaining === undefined) continue;
    const resets = Date.parse(str(isRecord(value) ? value.reset_time : undefined) ?? "");
    const name = agyWindowName(key);
    const made = window((1 - remaining) * 100, Number.isFinite(resets) ? resets : undefined, name.minutes, name.group);
    if (made) windows.push(made);
  }
  // 묶음끼리 모으고(외부 모델 묶음은 뒤로), 그 안에서는 짧은 창부터.
  const rank = (w: UsageWindow): string => `${/^3p/i.test(w.group ?? "") ? 1 : 0}${w.group ?? ""}`;
  windows.sort((a, b) => rank(a).localeCompare(rank(b)) || (a.minutes ?? Infinity) - (b.minutes ?? Infinity));
  return windows.length > 0 ? { plan: str(got.body.plan_tier)?.trim() || undefined, windows, at: got.mtimeMs } : undefined;
}

// ── 합치기 ──────────────────────────────────────────────────────────────────────────────────

/**
 * 읽은 뒤로 초기화 시각이 지난 창은 다시 0 에서 시작했다 — 그 뒤에 썼다면 새 값이 적혔을 것이다.
 * 적힐 때 이미 지나 있던 시각은 하네스가 그렇게 말한 것이라, 값은 두고 시각만 뗀다.
 */
function settle(w: UsageWindow, readAt: number, now: number): UsageWindow {
  if (w.resetsAt === undefined || w.resetsAt > now) return w;
  const { resetsAt, ...rest } = w;
  return resetsAt > readAt ? { ...rest, usedPct: 0, reset: true } : rest;
}

function view(vendor: string, reading: Reading | undefined, now: number): UsageView[] {
  if (!reading) return [];
  return [
    {
      vendor,
      ...(reading.plan ? { plan: reading.plan } : {}),
      windows: reading.windows.map((w) => settle(w, reading.at, now)),
      ...(now - reading.at > FRESH_MS ? { asOf: Math.round(reading.at) } : {}),
    },
  ];
}

export class UsageWatch {
  private views: UsageView[] = [];
  private checkedAt = 0;
  private busy = false;

  /** 지금 아는 값. 볼 때가 됐으면 뒤에서 다시 읽는다 — 스냅샷을 기다리게 하지 않는다. */
  current(codexLogs: () => string[]): UsageView[] {
    if (!this.busy && Date.now() - this.checkedAt >= CHECK_MS) {
      this.busy = true;
      void this.refresh(codexLogs()).finally(() => {
        this.checkedAt = Date.now();
        this.busy = false;
      });
    }
    return this.views;
  }

  private async refresh(codexLogs: string[]): Promise<void> {
    const [c, x, a] = await Promise.all([readClaude().catch(() => undefined), readCodex(codexLogs).catch(() => undefined), readAgy().catch(() => undefined)]);
    const now = Date.now();
    this.views = [...view("claude", c, now), ...view("codex", x, now), ...view("agy", a, now)];
  }
}
