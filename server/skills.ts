// 입력창에서 고를 스킬 목록(Claude Code). 빗금(`/이름`)으로 부를 수 있는 스킬을 그 세션의 로그와 디스크에서 모은다.
//
// 바탕은 세션 로그의 `skill_listing` 첨부다 — Claude 가 그 세션의 모델에게 알린 스킬 목록이라, 그 세션에서 켜진 플러그인과
// 내장 스킬까지 정확하다. 첫 행이 전체이고 뒤의 행(isInitial false)은 더해진 것만 싣는다. 다만 모델의 목록이라 사람이 부를
// 수 있는 목록과 두 군데가 다르다:
//   - `user-invocable: false` 인 스킬은 실려 있지만, 빗금으로 부르면 "Claude 만 부를 수 있다"며 거절된다 → 뺀다.
//   - `disable-model-invocation: true` 인 스킬은 빗금으로만 부르는 것이라 실려 있지 않다 → 더한다.
// 둘 다 SKILL.md 머리말에만 있어서 개인(~/.claude/skills)·프로젝트(.claude/skills)·켜진 플러그인의 파일을 읽는다.
// 내장 스킬 가운데 사람이 못 부르는 것(keybindings-help 등)은 파일이 없어 가리지 못한다 — 고르면 Claude 가 거절 글을 띄운다.
// 내장 명령(/compact, /model …)은 싣지 않는다. 스킬이 아니고, 월드에는 모델 바꾸기가 따로 있다.
import { createReadStream } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";

import type { SkillView as Skill } from "../shared/types.ts";

const LISTING_MARK = '"type":"skill_listing"';
/** 디스크에서 읽은 머리말을 다시 쓰는 시간. 고르는 창을 열 때마다 수십 개 파일을 읽지 않게 한다. */
const DISK_TTL_MS = 30_000;
const MAX_DESCRIPTION = 300;

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

/** 그 세션에서 빗금으로 부를 수 있는 스킬. 로그의 차례(개인 → 플러그인 → 내장)를 따르고, 빗금 전용은 뒤에 붙인다. */
export async function claudeSkills(logPath: string, cwd: string | undefined): Promise<Skill[]> {
  const [listing, disk] = await Promise.all([listingOf(logPath), diskOf(cwd)]);
  const out: Skill[] = [];
  for (const [name, description] of listing) {
    if (!disk.modelOnly.has(name)) out.push({ name, description, hint: disk.hints.get(name) });
  }
  for (const [name, skill] of disk.userOnly) if (!listing.has(name)) out.push(skill);
  return out;
}
