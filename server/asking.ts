// herdr 가 "일하는 중"으로 보지만 실제로는 사용자의 답을 기다리는 pane 을 찾는다.
//
// desk-look(AskUserQuestion)·desk-plan(ExitPlanMode) 은 엔진의 대화상자 대신 입력창 위에 카드를 띄우고, 도구 호출
// 안에서 답을 기다린다. 엔진에게는 도구가 도는 중이라 터미널 제목의 스피너가 멈추지 않고, herdr 는 그 제목 규칙
// (우선순위 1100)으로 working 이라 판정한다. `pane.report_agent` 로 blocked 를 보고해도 herdr 는 Claude pane 에서
// 그것을 쓰지 않는다(0.9.5 실측). 로그에도 도구 호출은 답한 뒤에야 적힌다.
//
// 그래서 desk-look(0.81.5~)이 카드가 떠 있는 동안 두는 표식 파일을 읽는다: `<런타임 폴더>/desk-look/waiting/<세션 id>.json`
// 에 pane·소켓·fifo·pid 를 적고, 답·닫기·중단 때 지운다. 창을 닫거나 강제로 죽은 세션의 표식은 남으므로, 적은
// 에이전트가 살아 있고 답 파이프(fifo)가 남아 있을 때만 믿는다.
//
// 플랜 카드에는 답도 그 파이프로 보낸다(answerPlan). 카드의 글 칸은 터미널 안의 그림이라 키를 흉내 내 채우면 붙여넣기
// 타이밍에 글을 잃는다 — 카드 단추가 하는 것처럼 답(JSON 한 덩어리)을 파이프에 써 넣는다.
import { constants, existsSync } from "node:fs";
import { lstat, open, readFile, readdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import { herdrSocketPath } from "./herdr.ts";

const HAS_PROC = existsSync("/proc/self/environ");

interface Marker {
  v?: unknown;
  kind?: unknown;
  sessionId?: unknown;
  since?: unknown;
  pane?: unknown;
  socket?: unknown;
  fifo?: unknown;
  pid?: unknown;
}

async function isFifo(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isFIFO();
  } catch {
    return false;
  }
}

/** 표식을 적는 쪽은 $XDG_RUNTIME_DIR, 없으면 $TMPDIR 를 쓴다. 이 서버와 에이전트의 환경이 어긋날 수 있어 둘 다 본다. */
function markerDirs(): string[] {
  const dirs = [process.env.XDG_RUNTIME_DIR, process.env.TMPDIR].filter((d): d is string => !!d).map((d) => resolve(d, "desk-look/waiting"));
  return [...new Set(dirs)];
}

/**
 * 표식을 적은 에이전트가 아직 그 pane 에서 살아 있는지. 남은 표식의 pid 가 다른 프로세스에 다시 쓰일 수 있어서,
 * /proc 이 있으면 그 프로세스의 HERDR_PANE_ID 까지 맞춰 본다. 없으면(macOS) 살아 있는지만 본다.
 */
async function holdsPane(pid: number, pane: string): Promise<boolean> {
  try {
    return (await readFile(`/proc/${pid}/environ`, "utf8")).split("\0").includes(`HERDR_PANE_ID=${pane}`);
  } catch {
    if (HAS_PROC) return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** 떠 있는 카드 하나. */
export interface Card {
  /** 플랜 승인 카드인지(desk-plan) — 아니면 질문 카드다. */
  plan: boolean;
  /** 카드를 띄운 세션. */
  sessionId?: string;
  /** 카드가 뜬 시각(ms) — 같은 pane 에 뜬 카드들을 가린다. */
  since?: number;
  /** 답을 써 넣는 파이프. 서버 안에서만 쓴다 — 스냅샷에 싣지 않는다. */
  fifo: string;
  /** 표식 형식 판. 답의 모양이 이 판에 매여 있다. */
  v?: number;
}

/** 지금 카드를 띄워 답을 기다리는 pane 들. 이 서버가 붙은 herdr 세션의 pane 만 — pane id 는 세션마다 따로 매긴다. */
async function scan(socket: string): Promise<Map<string, Card>> {
  const found = new Map<string, Card>();
  await Promise.all(
    markerDirs().map(async (dir) => {
      let names: string[];
      try {
        names = (await readdir(dir)).filter((n) => n.endsWith(".json"));
      } catch {
        return;
      }
      await Promise.all(
        names.map(async (name) => {
          try {
            const m = JSON.parse(await readFile(join(dir, name), "utf8")) as Marker;
            if (typeof m.pane !== "string" || typeof m.socket !== "string" || typeof m.fifo !== "string" || typeof m.pid !== "number") return;
            if (resolve(m.socket) !== socket || !(await holdsPane(m.pid, m.pane)) || !(await isFifo(m.fifo))) return;
            found.set(m.pane, {
              plan: m.kind === "plan",
              sessionId: typeof m.sessionId === "string" ? m.sessionId : undefined,
              since: typeof m.since === "number" ? m.since : undefined,
              fifo: m.fifo,
              v: typeof m.v === "number" ? m.v : undefined,
            });
          } catch {
            // 쓰는 중이거나 그 사이에 지워졌다.
          }
        }),
      );
    }),
  );
  return found;
}

export class AskingPanes {
  private running: Promise<ReadonlyMap<string, Card>> | undefined;

  /** 카드를 띄워 놓고 답을 기다리는 pane 들. 동시에 부르면 한 번만 읽는다. */
  check(): Promise<ReadonlyMap<string, Card>> {
    this.running ??= scan(resolve(herdrSocketPath())).finally(() => {
      this.running = undefined;
    });
    return this.running;
  }
}

/** 플랜 카드의 답(desk-plan hooks/plan.ts 의 PlanReply). 글을 빼면 승인·닫기도 같은 길로 갈 수 있지만, 지금은 고칠 점만 보낸다. */
export type PlanAnswer = { kind: "revise"; text: string };

/** 파이프 한 번에 다 들어가는 크기(리눅스 기본 64KB)보다 넉넉히 작게 — 나눠 쓰면 읽는 쪽이 앞 조각만 받고 끝날 수 있다. */
export const MAX_ANSWER_BYTES = 48 * 1024;
/** 읽는 쪽(cat)은 9분마다 다시 연다. 그 틈에 걸리면 잠깐 다시 해 본다. */
const OPEN_RETRY_MS = 1500;

export class AnswerError extends Error {
  constructor(readonly reason: "gone" | "too_long" | "short") {
    super(reason);
  }
}

/**
 * 플랜 카드의 파이프에 답을 써 넣는다. 카드를 띄운 훅이 파이프를 cat 으로 읽으며 기다리고, 받은 JSON 으로 도구 호출에 답한다.
 * 읽는 쪽이 없는 파이프(강제로 죽은 세션이 남긴 것)를 그냥 열면 영영 멈추므로 기다리지 않고 열고, 못 열면 카드가 없는 것으로 본다.
 */
export async function answerPlan(card: Card, answer: PlanAnswer): Promise<void> {
  // 표식 1판의 답 모양만 안다. 파이프는 desk-plan 이 mktemp 폴더에 만드는 answer 하나뿐이고, 이 사용자의 것이어야 한다.
  if (!card.plan || card.v !== 1 || basename(card.fifo) !== "answer") throw new AnswerError("gone");
  const info = await lstat(card.fifo).catch(() => undefined);
  if (!info?.isFIFO() || info.uid !== process.getuid?.()) throw new AnswerError("gone");
  const bytes = Buffer.from(JSON.stringify(answer));
  if (bytes.length > MAX_ANSWER_BYTES) throw new AnswerError("too_long");
  let file;
  for (const until = Date.now() + OPEN_RETRY_MS; !file; await Bun.sleep(100)) {
    try {
      file = await open(card.fifo, constants.O_WRONLY | constants.O_NONBLOCK);
    } catch (e) {
      // ENXIO: 지금 읽는 쪽이 없다. ENOENT: 그 사이 답을 받고 폴더를 지웠다.
      if ((e as NodeJS.ErrnoException).code !== "ENXIO" || Date.now() > until) throw new AnswerError("gone");
    }
  }
  try {
    const { bytesWritten } = await file.write(bytes);
    if (bytesWritten !== bytes.length) throw new AnswerError("short");
  } finally {
    await file.close();
  }
}
