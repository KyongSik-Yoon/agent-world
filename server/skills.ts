// 입력창에서 고를 스킬 목록(Claude Code). 빗금(`/이름`)으로 부를 수 있는 스킬을 그 세션의 로그와 디스크에서 모은다.
//
// 바탕은 세션 로그의 `skill_listing` 첨부다 — Claude 가 그 세션의 모델에게 알린 스킬 목록이라, 그 세션에서 켜진 플러그인과
// 내장 스킬까지 정확하다. 첫 행이 전체이고 뒤의 행(isInitial false)은 더해진 것만 싣는다. 다만 모델의 목록이라 사람이 부를
// 수 있는 목록과 두 군데가 다르다:
//   - `user-invocable: false` 인 스킬은 실려 있지만, 빗금으로 부르면 "Claude 만 부를 수 있다"며 거절된다 → 뺀다.
//   - `disable-model-invocation: true` 인 스킬은 빗금으로만 부르는 것이라 실려 있지 않다 → 더한다.
// 둘 다 SKILL.md 머리말에만 있어서 개인(~/.claude/skills)·프로젝트(.claude/skills)·켜진 플러그인의 파일을 읽는다.
// 내장 스킬 가운데 사람이 못 부르는 것(keybindings-help 등)은 파일이 없어 가리지 못한다 — 고르면 Claude 가 거절 글을 띄운다.
// 내장 명령은 로그 어디에도 목록이 없어, 월드에서 보내도 되는 것만 손으로 적어 맨 앞에 싣는다(BUILTINS).
//
// Antigravity CLI 는 로그에 스킬 목록을 남기지 않아 디스크만 읽는다(파일 끝의 agySkills).
import { createReadStream } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";

import type { SkillView as Skill } from "../shared/types.ts";
import { L, say, type Lang, type Text } from "./text.ts";

const LISTING_MARK = '"type":"skill_listing"';
/** 디스크에서 읽은 머리말을 다시 쓰는 시간. 고르는 창을 열 때마다 수십 개 파일을 읽지 않게 한다. */
const DISK_TTL_MS = 30_000;
const MAX_DESCRIPTION = 300;

/**
 * 목록에 싣는 내장 명령(Claude Code 2.1.330 에서 확인). 싣는 조건은 셋이다:
 *   - 로그에 명령 행을 남긴다 — 월드가 받은 것을 확인할 수 있다.
 *   - 터미널에 창을 띄워 두지 않는다 — `/usage`·`/status`·`/rewind` 는 창이 떠서 다음 지시를 삼킨다.
 *   - 다른 세션의 기본값을 바꾸지 않는다 — `/model`·`/effort` 는 전역에 저장한다(월드에는 그 세션만 바꾸는 길이 따로 있다).
 * 그 밖의 내장 명령은 목록에 없어도 쳐서 보낼 수 있다.
 */
const BUILTINS: Array<{ name: string; description: Text; hint?: Text }> = [
  { name: "clear", description: L("대화를 비우고 새로 시작합니다. 지금까지의 맥락은 사라집니다.", "Clear the conversation and start fresh. The context so far is dropped.") },
  {
    name: "compact",
    description: L("대화를 요약해 맥락을 줄이고 이어서 일합니다. 뒤에 무엇을 남길지 적을 수 있습니다.", "Summarize the conversation to free up context and keep going. You can add what to keep."),
    hint: L("[남길 것]", "[what to keep]"),
  },
  { name: "context", description: L("맥락을 무엇이 얼마나 차지하는지 터미널 화면에 보여 줍니다.", "Show in the terminal what is using the context window.") },
];

function configDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}

// ── 로그의 skill_listing ─────────────────────────────────────────────────────────────────────

interface Listing {
  /** 다음에 읽을 바이트 자리 — 로그는 덧붙기만 하므로 거기서부터 이어 읽는다. */
  offset: number;
  skills: Map<string, string>;
}

const listings = new Map<string, Listing>();

/** 로그의 skill_listing 행들을 모은다. 처음엔 전체를, 그 뒤로는 덧붙은 바이트만 읽는다. */
async function listingOf(path: string): Promise<Map<string, string>> {
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch {
    return new Map();
  }
  let found = listings.get(path);
  if (!found || found.offset > size) {
    found = { offset: 0, skills: new Map() };
    listings.set(path, found);
  }
  if (found.offset === size) return found.skills;
  const stream = createReadStream(path, { start: found.offset, end: size - 1 });
  let at = found.offset;
  let done = found.offset;
  for await (const line of createInterface({ input: stream, crlfDelay: Infinity })) {
    at += Buffer.byteLength(line) + 1;
    // 마지막 줄이 아직 쓰는 중이면(줄바꿈 전) 다음에 다시 읽는다.
    if (at > size) break;
    done = at;
    if (!line.includes(LISTING_MARK)) continue;
    try {
      const a = (JSON.parse(line) as { attachment?: unknown }).attachment as { type?: unknown; names?: unknown; content?: unknown } | undefined;
      if (a?.type !== "skill_listing" || !Array.isArray(a.names) || typeof a.content !== "string") continue;
      for (const [name, description] of describe(a.names.filter((n): n is string => typeof n === "string"), a.content)) found.skills.set(name, description);
    } catch {
      // 깨진 행은 건너뛴다.
    }
  }
  found.offset = done;
  return found.skills;
}

/**
 * 목록 글(`- 이름: 설명` 줄들)에서 이름마다 설명을 떼어 낸다. 설명 안에도 줄바꿈과 `- ` 가 들어갈 수 있어 줄로 나누지 않고,
 * 함께 실린 이름 목록을 차례로 찾아 그 사이를 설명으로 삼는다.
 */
function describe(names: string[], content: string): Array<[string, string]> {
  const spots = names
    .map((name) => ({ name, at: content.indexOf(`- ${name}: `) }))
    .filter((s) => s.at >= 0)
    .sort((a, b) => a.at - b.at);
  const out: Array<[string, string]> = names.map((n) => [n, ""]);
  const index = new Map(names.map((n, i) => [n, i]));
  spots.forEach((s, i) => {
    const from = s.at + s.name.length + 4;
    const to = i + 1 < spots.length ? spots[i + 1]!.at : content.length;
    out[index.get(s.name)!] = [s.name, clean(content.slice(from, to))];
  });
  return out;
}

function clean(text: string): string {
  const flat = text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > MAX_DESCRIPTION ? `${flat.slice(0, MAX_DESCRIPTION - 1)}…` : flat;
}

// ── 디스크의 SKILL.md 머리말 ─────────────────────────────────────────────────────────────────

interface Front {
  name?: string;
  description?: string;
  hint?: string;
  userOnly: boolean;
  modelOnly: boolean;
  /** 빗금 목록에서 뺀 스킬(AGY 의 `disable-slash-command: true`). */
  noSlash: boolean;
}

/** 머리말(`---` 사이)의 몇 가지 값. YAML 전체를 풀지 않고 쓰는 키만 읽는다 — 접힌 글(`>`·`|`)은 들여 쓴 다음 줄들을 잇는다. */
export function frontMatter(text: string): Front | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return null;
  const values = new Map<string, string>();
  const lines = m[1]!.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(lines[i]!);
    if (!kv) continue;
    let value = kv[2]!.trim();
    if (value === "" || /^[>|][+-]?$/.test(value)) {
      const more: string[] = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1]!)) more.push(lines[++i]!.trim());
      value = more.join(" ");
    }
    // 큰따옴표 글은 \" 처럼 이스케이프가 들어 있다.
    const quoted = /^"([\s\S]*)"$/.exec(value)?.[1];
    values.set(kv[1]!.toLowerCase(), quoted !== undefined ? quoted.replace(/\\(["\\])/g, "$1") : value.replace(/^'([\s\S]*)'$/, "$1"));
  }
  const yes = (key: string) => values.get(key)?.toLowerCase() === "true";
  const no = (key: string) => values.get(key)?.toLowerCase() === "false";
  return {
    name: values.get("name") || undefined,
    description: values.get("description") || undefined,
    hint: values.get("argument-hint") || undefined,
    userOnly: yes("disable-model-invocation"),
    modelOnly: no("user-invocable"),
    noSlash: yes("disable-slash-command"),
  };
}

interface Disk {
  at: number;
  /** 빗금으로만 부르는 것(로그에 없다): 이름 → 설명·힌트. */
  userOnly: Map<string, Skill>;
  /** 사람이 부를 수 없는 것. */
  modelOnly: Set<string>;
  /** 머리말의 argument-hint. */
  hints: Map<string, string>;
}

const disks = new Map<string, Disk>();

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
}

/** 스킬 폴더(`<root>/skills/<이름>/SKILL.md`)와 명령 폴더(`<root>/commands/<이름>.md`)의 머리말을 모은다. */
async function scanRoot(root: string, prefix: string, into: Disk): Promise<void> {
  const add = (fallback: string, front: Front | null) => {
    if (!front) return;
    const name = prefix + (front.name && !prefix ? front.name : fallback);
    if (front.hint) into.hints.set(name, front.hint);
    if (front.modelOnly) into.modelOnly.add(name);
    else if (front.userOnly) into.userOnly.set(name, { name, description: clean(front.description ?? ""), hint: front.hint });
  };
  const skills = await readdir(join(root, "skills")).catch(() => [] as string[]);
  await Promise.all(skills.map(async (dir) => add(dir, frontMatter(await readFile(join(root, "skills", dir, "SKILL.md"), "utf8").catch(() => "")))));
  const commands = await readdir(join(root, "commands")).catch(() => [] as string[]);
  await Promise.all(
    commands.filter((f) => f.endsWith(".md")).map(async (f) => add(f.slice(0, -3), frontMatter(await readFile(join(root, "commands", f), "utf8").catch(() => "")))),
  );
}

/** cwd 에서 위로 올라가며 만나는 프로젝트 `.claude` 폴더들(홈의 것은 개인 설정이라 뺀다). */
function projectRoots(cwd: string | undefined): string[] {
  if (!cwd) return [];
  const home = homedir();
  const out: string[] = [];
  for (let dir = cwd; ; dir = dirname(dir)) {
    if (dir !== home) out.push(join(dir, ".claude"));
    if (dirname(dir) === dir) return out;
  }
}

/** 켜진 플러그인(이름@마켓 → 설치 폴더). 개인 설정 위에 프로젝트 설정이 덮는다. */
async function enabledPlugins(projects: string[]): Promise<Array<{ name: string; path: string }>> {
  const enabled = new Map<string, boolean>();
  const layers = [join(configDir(), "settings.json"), ...projects.toReversed().flatMap((p) => [join(p, "settings.json"), join(p, "settings.local.json")])];
  for (const file of layers) {
    const on = ((await readJson(file)) as { enabledPlugins?: unknown } | undefined)?.enabledPlugins;
    if (on && typeof on === "object") for (const [k, v] of Object.entries(on)) if (typeof v === "boolean") enabled.set(k, v);
  }
  const installed = ((await readJson(join(configDir(), "plugins", "installed_plugins.json"))) as { plugins?: Record<string, unknown> } | undefined)?.plugins ?? {};
  const out: Array<{ name: string; path: string }> = [];
  for (const [id, on] of enabled) {
    const entries = installed[id];
    const path = Array.isArray(entries) ? (entries.at(-1) as { installPath?: unknown } | undefined)?.installPath : undefined;
    if (on && typeof path === "string") out.push({ name: id.split("@")[0]!, path });
  }
  return out;
}

async function diskOf(cwd: string | undefined): Promise<Disk> {
  const key = cwd ?? "";
  const cached = disks.get(key);
  if (cached && Date.now() - cached.at < DISK_TTL_MS) return cached;
  const disk: Disk = { at: Date.now(), userOnly: new Map(), modelOnly: new Set(), hints: new Map() };
  const projects = projectRoots(cwd);
  await scanRoot(configDir(), "", disk);
  for (const p of projects) await scanRoot(p, "", disk);
  for (const plugin of await enabledPlugins(projects)) await scanRoot(plugin.path, `${plugin.name}:`, disk);
  disks.set(key, disk);
  return disk;
}

/**
 * 그 세션에서 빗금으로 부를 수 있는 것. 내장 명령이 맨 앞이고, 스킬은 로그의 차례(개인 → 플러그인 → 내장)를 따르며 빗금
 * 전용은 뒤에 붙인다. 같은 이름의 스킬이 있으면 내장 명령이 이긴다 — Claude 도 그 이름을 내장 명령으로 받는다.
 */
export async function claudeSkills(logPath: string, cwd: string | undefined, lang?: Lang): Promise<Skill[]> {
  const [listing, disk] = await Promise.all([listingOf(logPath), diskOf(cwd)]);
  const out: Skill[] = BUILTINS.map((b) => ({ name: b.name, description: say(b.description, lang), hint: b.hint && say(b.hint, lang) }));
  const taken = new Set(out.map((s) => s.name));
  for (const [name, description] of listing) {
    if (!disk.modelOnly.has(name) && !taken.has(name)) out.push({ name, description, hint: disk.hints.get(name) });
  }
  for (const [name, skill] of disk.userOnly) if (!listing.has(name) && !taken.has(name)) out.push(skill);
  return out;
}

// ── Antigravity CLI ─────────────────────────────────────────────────────────────────────────
//
// AGY 는 입력창에 `/` 를 치면 내장 명령, 프롬프트로 풀리는 명령(`/plan` 등), 스킬을 한 목록에 보인다(1.5.13 에서 확인).
// 그 목록을 터미널을 건드리지 않고 얻을 길은 없어서(CLI 에 스킬을 나열하는 명령이 없다) 명령은 손으로 적고 스킬은 디스크에서 모은다:
// 프로젝트(`.agents/skills`, cwd 에서 위로), 개인(`~/.gemini/config/skills`), 켜진 플러그인(`~/.gemini/config/plugins/<이름>/skills`,
// `<이름>:` 이 붙는다). 머리말에 `disable-slash-command: true` 가 있으면 뺀다.
// AGY 에 딸려 오는 스킬(`antigravity-cli/builtin/skills`)은 싣지 않는다 — 어느 것이 목록에 뜨는지가 머리말에 없다(`automation`·
// `plugin` 은 표시 없이도 안 뜬다). 목록에 없어도 쳐서 보낼 수는 있다.

/**
 * 목록에 싣는 AGY 명령. Claude 와 같은 잣대로 고른다 — 창을 띄워 두는 것(`/context`·`/usage`·`/codesearch` 는 창이 떠 있는 동안
 * 다음 지시를 삼킨다), 답이 터미널에만 뜨고 월드에 오지 않는 것(`/btw`), 저장되는 설정을 바꾸는 것(`/model`·`/effort`·`/statusline`)은
 * 뺀다. 받았는지는 AGY 의 입력 기록으로 확인한다. 실제로 보내 본 것은 `/clear`·`/compact`·`/rename`·`/plan` 이고, 나머지는 AGY 의
 * 목록에서 `/plan` 과 같은 묶음(프롬프트로 풀리는 명령)이라 실었다.
 */
const AGY_BUILTINS: Array<{ name: string; description: Text; hint?: Text }> = [
  { name: "clear", description: L("대화를 비우고 새 대화를 시작합니다. 지금까지의 맥락은 사라집니다.", "Clear the conversation and start a new one. The context so far is dropped.") },
  { name: "compact", description: L("대화를 요약해 맥락을 줄이고 이어서 일합니다.", "Summarize the conversation to free up context and keep going.") },
  { name: "rename", description: L("이 대화의 이름을 바꿉니다.", "Rename this conversation."), hint: L("[이름]", "[name]") },
  { name: "plan", description: L("실행하기 전에 꼼꼼히 계획부터 세웁니다.", "Plan carefully before executing a task."), hint: L("[할 일]", "[task]") },
  { name: "goal", description: L("적어 준 목표를 다 이룰 때까지 이어서 일합니다.", "Run until the specified goal is completely finished."), hint: L("[목표]", "[goal]") },
  { name: "grill-me", description: L("계획을 맞추기 위해 나에게 질문을 던집니다.", "Interview me to align on a plan."), hint: L("[주제]", "[topic]") },
  { name: "teamwork", description: L("에이전트 팀을 꾸려 큰 일을 스스로 나눠 맡습니다.", "Invoke a team of agents to autonomously tackle large projects."), hint: L("[할 일]", "[task]") },
  { name: "boost", description: L("복잡한 일을 Boost 멀티 에이전트 오케스트레이터에 맡깁니다.", "Invoke the Boost multi-agent orchestrator for complex tasks."), hint: L("[할 일]", "[task]") },
  { name: "browser", description: L("웹에서 하는 일을 브라우저 에이전트에게 맡깁니다.", "Invoke a browser agent for web tasks."), hint: L("[할 일]", "[task]") },
  { name: "schedule", description: L("지시를 주기적으로, 또는 정한 때에 한 번 돌립니다.", "Run an instruction on a recurring schedule or as a one-time timer."), hint: L("[언제 무엇을]", "[when and what]") },
  { name: "learn", description: L("최근의 성공과 교정을 돌아보고 다시 쓸 스킬·규칙으로 남깁니다.", "Reflect on recent successes or corrections to capture reusable skills or rules.") },
];

/** AGY 의 개인 설정 폴더. 로그 폴더(`AGY_HOME`)의 곁에 있다 — 로그 폴더를 임시 폴더로 돌리면 이쪽도 따라 비어, 그림에 실제 스킬이 실리지 않는다. */
function agyConfigDir(): string {
  return join(process.env.AGY_HOME || join(homedir(), ".gemini", "antigravity-cli"), "..", "config");
}

const AGY_PROJECT_DIRS = [".agents", ".agent", "_agents", "_agent"];

/** `<root>/skills/<폴더>/SKILL.md` 들을 into 에 보탠다. 먼저 들어온 이름이 이긴다(프로젝트 → 개인 → 플러그인). */
async function scanAgyRoot(root: string, prefix: string, into: Map<string, Skill>): Promise<void> {
  const dirs = (await readdir(join(root, "skills")).catch(() => [] as string[])).sort();
  const fronts = await Promise.all(dirs.map(async (dir) => ({ dir, front: frontMatter(await readFile(join(root, "skills", dir, "SKILL.md"), "utf8").catch(() => "")) })));
  for (const { dir, front } of fronts) {
    if (!front || front.noSlash) continue;
    const name = prefix + (front.name ?? dir);
    if (!into.has(name)) into.set(name, { name, description: clean(front.description ?? ""), hint: front.hint });
  }
}

const agyDisks = new Map<string, { at: number; skills: Skill[] }>();

async function agyDiskOf(cwd: string | undefined): Promise<Skill[]> {
  const key = cwd ?? "";
  const cached = agyDisks.get(key);
  if (cached && Date.now() - cached.at < DISK_TTL_MS) return cached.skills;
  const found = new Map<string, Skill>();
  const home = homedir();
  for (let dir = cwd; dir && dir !== home; dir = dirname(dir)) {
    for (const name of AGY_PROJECT_DIRS) await scanAgyRoot(join(dir, name), "", found);
    if (dirname(dir) === dir) break;
  }
  const config = agyConfigDir();
  await scanAgyRoot(config, "", found);
  const set = ((await readJson(join(config, "config.json"))) as { plugins?: Record<string, { enabled?: unknown }> } | undefined)?.plugins ?? {};
  for (const plugin of (await readdir(join(config, "plugins")).catch(() => [] as string[])).sort()) {
    if (set[plugin]?.enabled !== false) await scanAgyRoot(join(config, "plugins", plugin), `${plugin}:`, found);
  }
  const skills = [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
  if (agyDisks.size > 200) agyDisks.clear();
  agyDisks.set(key, { at: Date.now(), skills });
  return skills;
}

/** AGY 세션에서 빗금으로 부를 수 있는 것. 손으로 적은 명령이 맨 앞이고, 스킬은 AGY 의 목록처럼 이름순이다. */
export async function agySkills(cwd: string | undefined, lang?: Lang): Promise<Skill[]> {
  const out: Skill[] = AGY_BUILTINS.map((b) => ({ name: b.name, description: say(b.description, lang), hint: b.hint && say(b.hint, lang) }));
  const taken = new Set(out.map((s) => s.name));
  for (const skill of await agyDiskOf(cwd)) if (!taken.has(skill.name)) out.push(skill);
  return out;
}
