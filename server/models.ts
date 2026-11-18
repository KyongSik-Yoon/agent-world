// 모델과 사고 수준(effort) 고르기: 하네스마다 고를 수 있는 목록, 띄울 때 넘길 실행 인자, 떠 있는 세션을 그 세션에만 바꾸기.
//
// 바꾼 값이 다음에 띄울 세션의 기본값까지 바꾸지 않게 한다. 월드는 에이전트 여럿을 함께 다루므로, 한 주민의 모델을 바꿨다고
// 다음에 들일 주민이 조용히 따라 바뀌면 안 된다. 하네스마다 그 길이 다르다(Claude 2.1.327, Codex 0.170, agy 1.5.10 에서 확인):
//   - Claude: `/model <별칭>`·`/effort <수준>` 은 settings.json 의 기본값까지 바꾼다. 인자 없는 `/model` 이 여는 선택 창에서
//     모델과 수준을 맞춘 뒤 `s` 를 누르면 그 세션에만 적용된다. 그래서 화면을 읽으며 그 창을 조작한다.
//   - Codex: `/model <slug> --reasoning=<수준>` 은 그 세션에만 적용된다(인자 없이 여는 선택 창은 config.toml 에 저장한다).
//   - agy: `/model`·`/effort`·선택 창 모두 settings.json 에 저장하고, 그 세션에만 바꾸는 길이 없다. 띄울 때만 고른다.
// 띄울 때 넘기는 실행 인자(--model·--effort, -m·-c)는 셋 다 그 세션에만 적용된다.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { LIVE_MODEL_KINDS, type ModelCatalog, type ModelChoice } from "../shared/types.ts";
import { claudeModelId } from "./adapters/claude.ts";
import { claudeComposer, squash } from "./composer.ts";
import { herdrInput, herdrRaw, herdrScreen } from "./herdr.ts";
import { L, type Text } from "./text.ts";

export class ModelError extends Error {
  constructor(
    readonly text: Text,
    readonly status: number,
    readonly code?: string,
  ) {
    super(text.en);
  }
}

/** 수준을 낮은 것부터 늘어놓는 차례. 모르는 이름은 뒤로 간다. */
const ORDER = ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
const rank = (effort: string): number => (ORDER.includes(effort) ? ORDER.indexOf(effort) : ORDER.length);
const byRank = (a: string, b: string): number => rank(a) - rank(b);

// ── 목록 ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Claude Code 는 모델 목록을 밖으로 내놓지 않는다. 별칭은 그 계열의 최신 모델을 가리키므로(`--model` 도움말) 별칭으로 둔다.
 * 수준은 선택 창이 모든 모델에 같은 다섯 칸을 보인다.
 */
const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const CLAUDE: ModelChoice[] = [
  { id: "opus", label: "Opus", efforts: CLAUDE_EFFORTS },
  { id: "fable", label: "Fable", efforts: CLAUDE_EFFORTS },
  { id: "sonnet", label: "Sonnet", efforts: CLAUDE_EFFORTS },
  { id: "haiku", label: "Haiku", efforts: CLAUDE_EFFORTS },
];

/** Codex 가 서버에서 받아 둔 모델 목록. 선택 창에 보이는 것(visibility: list)만 쓴다. */
async function codexModels(): Promise<ModelChoice[]> {
  const path = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "models_cache.json");
  let body: unknown;
  try {
    body = JSON.parse(await readFile(path, "utf8"));
  } catch {
    return [];
  }
  const models = (body as { models?: unknown }).models;
  if (!Array.isArray(models)) return [];
  const out: ModelChoice[] = [];
  for (const m of models as Array<Record<string, unknown>>) {
    if (m.visibility !== "list" || typeof m.slug !== "string") continue;
    const levels = Array.isArray(m.supported_reasoning_levels) ? m.supported_reasoning_levels : [];
    const efforts = levels.map((l: { effort?: unknown }) => l?.effort).filter((e): e is string => typeof e === "string");
    out.push({
      id: m.slug,
      label: typeof m.display_name === "string" ? m.display_name : m.slug,
      efforts: [...new Set(efforts)].sort(byRank),
      defaultEffort: typeof m.default_reasoning_level === "string" ? m.default_reasoning_level : undefined,
    });
  }
  return out;
}

/** `agy models` 를 묻는 데는 네트워크를 거쳐 1~2초가 걸린다. 한동안 기억해 둔다. */
const AGY_TTL_MS = 10 * 60_000;
const AGY_RETRY_MS = 30_000;
const AGY_TIMEOUT_MS = 20_000;
let agyCache: { at: number; ttl: number; models: ModelChoice[] } | undefined;
let agyLoading: Promise<ModelChoice[]> | undefined;

/**
 * agy 는 수준을 모델 id 에 붙여 둔다(`claude-opus-5-5-high` · "Claude Opus 5.5 (High)"). 수준을 뗀 것끼리 묶어 한 모델로 보인다.
 * 수준이 붙지 않은 모델("Orchestrator (Carbon)")은 그대로 둔다.
 */
export function groupAgyModels(output: string): ModelChoice[] {
  const families = new Map<string, ModelChoice>();
  for (const line of output.split("\n")) {
    const [id, label] = line.split("\t").map((s) => s.trim());
    if (!id || !label) continue;
    const idLevel = /^(.+)-(low|medium|high|xhigh|max)$/.exec(id);
    const labelLevel = / \((low|medium|high|xhigh|max)\)$/i.exec(label);
    if (idLevel && labelLevel && idLevel[2] === labelLevel[1]!.toLowerCase()) {
      const family = families.get(idLevel[1]!) ?? { id: idLevel[1]!, label: label.slice(0, labelLevel.index), efforts: [] };
      family.efforts.push(idLevel[2]!);
      families.set(family.id, family);
    } else if (!families.has(id)) families.set(id, { id, label, efforts: [] });
  }
  for (const f of families.values()) f.efforts.sort(byRank);
  return [...families.values()];
}

async function agyModels(): Promise<ModelChoice[]> {
  if (agyCache && Date.now() - agyCache.at < agyCache.ttl) return agyCache.models;
  agyLoading ??= (async () => {
    let models: ModelChoice[] = [];
    try {
      const bin = Bun.which("agy");
      if (bin) {
        const proc = Bun.spawn([bin, "models"], { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
        const timer = setTimeout(() => proc.kill(), AGY_TIMEOUT_MS);
        const text = await new Response(proc.stdout).text();
        clearTimeout(timer);
        if ((await proc.exited) === 0) models = groupAgyModels(text);
      }
    } catch {
      // 못 읽으면 빈 목록 — 화면은 모델 칸을 감추고 실행 인자 칸만 둔다.
    }
    agyCache = { at: Date.now(), ttl: models.length > 0 ? AGY_TTL_MS : AGY_RETRY_MS, models };
    return models;
  })().finally(() => {
    agyLoading = undefined;
  });
  return agyLoading;
}

/** 그 하네스에서 고를 수 있는 모델들. 모델을 고를 줄 모르는 하네스면 null. */
export async function modelCatalog(kind: string): Promise<ModelCatalog | null> {
  const models = kind === "claude" ? CLAUDE : kind === "codex" ? await codexModels() : kind === "agy" ? await agyModels() : null;
  return models ? { kind, models, efforts: anyEfforts(models), live: LIVE_MODEL_KINDS.includes(kind) } : null;
}

/** 모델을 고르지 않았을 때 고를 수 있는 수준 — 목록의 모델들이 받는 수준을 모두 모은다. */
function anyEfforts(models: ModelChoice[]): string[] {
  return [...new Set(models.flatMap((m) => m.efforts))].sort(byRank);
}

/** 고른 모델과 수준이 그 하네스의 목록에 있는지 본다. 고른 모델을 돌려준다. */
async function validate(kind: string, model: string, effort: string): Promise<{ catalog: ModelCatalog; choice?: ModelChoice }> {
  const catalog = await modelCatalog(kind);
  if (!catalog) throw new ModelError(L("이 하네스는 모델을 고를 수 없습니다.", "This harness has no model choice."), 400);
  const choice = model ? catalog.models.find((m) => m.id === model) : undefined;
  if (model && !choice) throw new ModelError(L(`목록에 없는 모델입니다: ${model}`, `Not a listed model: ${model}`), 400);
  if (effort && !(choice ? choice.efforts : catalog.efforts).includes(effort)) {
    throw new ModelError(L(`이 모델이 받지 않는 수준입니다: ${effort}`, `This model does not take that effort: ${effort}`), 400);
  }
  return { catalog, choice };
}

/** 띄울 때 넘길 실행 인자. 셋 다 그 세션에만 적용되고 설정 파일을 바꾸지 않는다. */
export async function startFlags(kind: string, model: string, effort: string): Promise<string[]> {
  if (!model && !effort) return [];
  const { choice } = await validate(kind, model, effort);
  switch (kind) {
    case "claude":
      return [...(model ? ["--model", model] : []), ...(effort ? ["--effort", effort] : [])];
    case "codex":
      // -c 의 값은 TOML 로 읽힌다. 따옴표를 쳐 문자열로 넘긴다.
      return [...(model ? ["-m", model] : []), ...(effort ? ["-c", `model_reasoning_effort="${effort}"`] : [])];
    case "agy":
      // 수준이 붙은 id 를 그대로 넘긴다 — 목록이 말하는 이름이라 agy 가 다르게 풀 일이 없다.
      if (choice && effort && choice.efforts.includes(effort)) return ["--model", `${choice.id}-${effort}`];
      return [...(model ? ["--model", model] : []), ...(effort ? ["--effort", effort] : [])];
    default:
      return [];
  }
}

// ── 떠 있는 세션 바꾸기 ──────────────────────────────────────────────────────────────────────

const POLL_MS = 100;

async function until<T>(read: () => Promise<T | undefined>, ms: number): Promise<T | undefined> {
  const end = Date.now() + ms;
  for (;;) {
    const got = await read();
    if (got !== undefined) return got;
    if (Date.now() > end) return undefined;
    await Bun.sleep(POLL_MS);
  }
}

/** 입력창에 넣은 글자를 그만큼 지운다 — 쓰던 글은 그대로 남는다. */
async function erase(paneId: string, chars: number): Promise<void> {
  for (let left = chars; left > 0; left -= 64) await herdrInput(paneId, undefined, Array<string>(Math.min(64, left)).fill("backspace"));
}

const DRAFT = L(
  "입력창에 쓰던 글이 있어 모델을 바꾸지 않았습니다. 그 글을 보내거나 지운 뒤 다시 해 주세요.",
  "There is unsent text in the agent's input, so the model was not changed. Send or clear it, then try again.",
);
const NO_INPUT = L("에이전트의 입력창이 보이지 않습니다. 대화상자가 떠 있는지 터미널 화면을 확인해 주세요.", "The agent's input is not on screen. Check the terminal for an open dialog.");
const unconfirmed = (what: Text): ModelError => new ModelError(what, 504, "model_unconfirmed");

export interface Switched {
  model?: string;
  effort?: string;
}

/** Claude 선택 창: `s to use this session only` 가 보이면 열려 있다. */
const PICKER = /s to use this session only/;
const PICKER_ROW = /^\s*(❯)?\s*\d+\.\s+(.+?)(\s+✔)?(?:\s{2,}|$)/;
/** "○ Low effort", "◐ Medium effort (default)", "◉ xHigh effort", "◈ Max effort". */
const PICKER_EFFORT = /^\s*\S\s+(Low|Medium|High|xHigh|Max) effort\b/;

interface Picker {
  rows: Array<{ name: string; cursor: boolean }>;
  effort?: string;
}

function readPicker(screen: string): Picker | undefined {
  if (!PICKER.test(screen)) return undefined;
  const lines = screen.split("\n");
  const head = lines.findLastIndex((l) => /^\s*Select model\s*$/.test(l));
  if (head < 0) return undefined;
  const picker: Picker = { rows: [] };
  for (const line of lines.slice(head + 1)) {
    const effort = PICKER_EFFORT.exec(line);
    if (effort) {
      picker.effort = effort[1]!.toLowerCase();
      break;
    }
    const row = PICKER_ROW.exec(line);
    if (row) picker.rows.push({ name: row[2]!, cursor: row[1] !== undefined });
  }
  return picker.rows.length > 0 ? picker : undefined;
}

/**
 * Claude: 인자 없는 `/model` 로 선택 창을 열고, 커서와 수준을 화면에서 읽어 가며 맞춘 뒤 `s`(이 세션에만)를 누른다.
 * 대화가 이어진 세션이면 "캐시를 다시 읽는다"는 확인창이 한 번 더 뜬다 — 바꾸기 전에 화면에서 알렸으므로 "예"를 고른다.
 * 중간에 어긋나면 Esc 로 창을 닫고 아무것도 바꾸지 않은 채 알린다.
 */
async function switchClaude(paneId: string, model: string, effort: string): Promise<Switched> {
  const screen = () => herdrScreen(paneId);
  if (claudeComposer(await screen()) === undefined) throw new ModelError(NO_INPUT, 409, "no_input");
  await herdrInput(paneId, "/model", undefined);
  const box = await until(async () => {
    const c = claudeComposer(await screen());
    return c !== undefined && squash(c).includes("/model") ? c : undefined;
  }, 3000);
  if (box === undefined) throw unconfirmed(L("입력창에 넣은 /model 이 보이지 않습니다. 터미널 화면을 확인해 주세요.", "The /model command did not show up in the input. Check the terminal."));
  if (squash(box) !== "❯/model") {
    await erase(paneId, "/model".length);
    throw new ModelError(DRAFT, 409, "draft");
  }
  await herdrInput(paneId, undefined, ["enter"]);
  let picker = await until(async () => readPicker(await screen()), 4000);
  if (!picker) {
    const left = claudeComposer(await screen());
    if (left !== undefined && squash(left) === "❯/model") await erase(paneId, "/model".length);
    throw unconfirmed(L("모델 선택 창이 열리지 않았습니다. 터미널 화면을 확인해 주세요.", "The model picker did not open. Check the terminal."));
  }
  const cancel = async (text: Text, status = 409): Promise<never> => {
    await herdrInput(paneId, undefined, ["esc"]);
    throw new ModelError(text, status, "picker");
  };

  if (model) {
    const target = picker.rows.findIndex((r) => r.name.toLowerCase().startsWith(`${model} `) || r.name.toLowerCase() === model);
    if (target < 0) return cancel(L(`선택 창에 ${model} 이 없습니다. 이 계정에서 쓸 수 없는 모델일 수 있습니다.`, `${model} is not in the picker. This account may not have it.`));
    const at = picker.rows.findIndex((r) => r.cursor);
    if (at < 0) return cancel(L("선택 창의 커서를 찾지 못했습니다.", "Could not find the cursor in the picker."), 504);
    if (target !== at) await herdrInput(paneId, undefined, Array<string>(Math.abs(target - at)).fill(target > at ? "down" : "up"));
    picker =
      (await until(async () => {
        const p = readPicker(await screen());
        return p?.rows[target]?.cursor ? p : undefined;
      }, 2000)) ?? (await cancel(L("선택 창에서 모델을 고르지 못했습니다.", "Could not select the model in the picker."), 504));
  }
  if (effort) {
    const have = CLAUDE_EFFORTS.indexOf(picker.effort ?? "");
    const want = CLAUDE_EFFORTS.indexOf(effort);
    if (have < 0) return cancel(L("이 모델은 선택 창에서 수준을 고를 수 없습니다.", "The picker offers no effort for this model."));
    if (want !== have) await herdrInput(paneId, undefined, Array<string>(Math.abs(want - have)).fill(want > have ? "right" : "left"));
    picker =
      (await until(async () => {
        const p = readPicker(await screen());
        return p?.effort === effort ? p : undefined;
      }, 2000)) ?? (await cancel(L("선택 창에서 수준을 맞추지 못했습니다.", "Could not set the effort in the picker."), 504));
  }

  const chosen = picker.rows.find((r) => r.cursor)!.name;
  const result: Switched = { model: claudeModelId(chosen), effort: picker.effort };
  // 글자 키는 raw 로 — 붙여넣기로 감싸면 선택 창이 키로 받지 않는다.
  await herdrRaw(paneId, "s");
  let agreed = false;
  const done = await until(async () => {
    const now = await screen();
    if (/Switch model\?/.test(now) && /Yes, switch/.test(now)) {
      if (!agreed) {
        agreed = true;
        await herdrInput(paneId, undefined, ["enter"]);
      }
      return undefined;
    }
    if (PICKER.test(now)) return undefined;
    const said = now.split("\n").findLast((l) => /Set model to .+ for this session only/.test(l));
    return said?.includes(chosen) ? said : undefined;
  }, 6000);
  if (!done) throw unconfirmed(L("모델을 바꿨는지 화면에서 확인하지 못했습니다. 터미널 화면을 확인해 주세요.", "Could not confirm the switch on screen. Check the terminal."));
  return result;
}

/** Codex: 입력창에 `/model <slug> --reasoning=<수준>` 을 넣고, 쓰던 글이 없는지 본 뒤 제출한다. */
async function switchCodex(paneId: string, model: string, effort: string): Promise<Switched> {
  if (!model) throw new ModelError(L("Codex 는 모델을 함께 골라야 합니다.", "Codex needs a model to switch to."), 400);
  const command = `/model ${model}${effort ? ` --reasoning=${effort}` : ""}`;
  const screen = async () => (await herdrScreen(paneId)).split("\n");
  if (!(await screen()).some((l) => /^\s*› /.test(l))) throw new ModelError(NO_INPUT, 409, "no_input");
  await herdrInput(paneId, command, undefined);
  const line = await until(async () => (await screen()).find((l) => l.trimEnd().endsWith(command)), 3000);
  if (line === undefined) throw unconfirmed(L("입력창에 넣은 명령이 보이지 않습니다. 터미널 화면을 확인해 주세요.", "The command did not show up in the input. Check the terminal."));
  if (line.trim() !== `› ${command}`) {
    await erase(paneId, command.length);
    throw new ModelError(DRAFT, 409, "draft");
  }
  await herdrInput(paneId, undefined, ["enter"]);
  const said = await until(async () => {
    const lines = await screen();
    if (lines.some((l) => l.trimEnd().endsWith(command))) return undefined;
    return lines.findLast((l) => /Model changed to \S+/.test(l) || /^\s*■ /.test(l));
  }, 5000);
  if (said === undefined) throw unconfirmed(L("모델을 바꿨는지 화면에서 확인하지 못했습니다. 터미널 화면을 확인해 주세요.", "Could not confirm the switch on screen. Check the terminal."));
  const changed = /Model changed to (\S+)(?: (\S+))? for this session only/.exec(said);
  if (!changed || changed[1] !== model) throw new ModelError(L(`Codex 가 거절했습니다: ${said.trim()}`, `Codex refused: ${said.trim()}`), 409, "refused");
  return { model, effort: changed[2] ?? effort };
}

/**
 * 떠 있는 세션의 모델·수준을 그 세션에만 바꾼다. 부르는 쪽이 그 pane 이 일하는 중이거나 질문에 막혀 있지 않은지 먼저 본다.
 * 비운 값은 그대로 둔다(Codex 는 모델을 늘 함께 보낸다).
 */
export async function switchModel(paneId: string, kind: string, model: string, effort: string): Promise<Switched> {
  if (!model && !effort) throw new ModelError(L("바꿀 모델이나 수준을 골라 주세요.", "Choose a model or an effort."), 400);
  const { catalog } = await validate(kind, model, effort);
  if (!catalog.live) {
    throw new ModelError(
      L("이 하네스는 바꾸면 다음 세션의 기본값까지 바뀌어, 월드에서는 띄울 때만 고릅니다.", "This harness saves a switch as the default for new sessions, so the world only picks it at start."),
      400,
      "not_live",
    );
  }
  return kind === "claude" ? switchClaude(paneId, model, effort) : switchCodex(paneId, model, effort);
}
