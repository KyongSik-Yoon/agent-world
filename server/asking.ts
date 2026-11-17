// herdr 가 "일하는 중"으로 보지만 실제로는 사용자의 답을 기다리는 pane 을 찾는다.
//
// desk-look(AskUserQuestion)·desk-plan(ExitPlanMode) 은 엔진의 대화상자 대신 입력창 위에 카드를 띄우고,
// 도구 호출 안에서 `cat <임시 폴더>/answer`(FIFO)로 카드 버튼의 답을 기다린다. 엔진에게는 도구가 도는 중이라
// 터미널 제목의 스피너가 멈추지 않고, herdr 는 그 제목 규칙(우선순위 1100)으로 working 이라 판정한다.
// `pane.report_agent` 로 blocked 를 보고해도 herdr 는 Claude pane 에서 그것을 쓰지 않는다(0.9.5 실측).
// 로그에도 도구 호출은 답한 뒤에야 적힌다.
//
// 그래서 두 가지를 본다.
// - 표식 파일(desk-look 0.81.5~): 카드가 뜰 때 `<런타임 폴더>/desk-look/waiting/<세션 id>.json` 에 pane·fifo·pid 를
//   적고 닫힐 때 지운다. 강제로 죽은 세션의 표식은 남으므로 pid 가 살아 있고 fifo 가 남아 있을 때만 믿는다.
// - 기다리는 프로세스: 표식이 없는 예전 판이나 표식을 못 적은 경우. `cat …/answer` 의 환경변수로 pane 을 가린다.
//   Linux 의 /proc 에서만 읽는다.
import { existsSync } from "node:fs";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import { herdrSocketPath } from "./herdr.ts";

const HAS_PROC = existsSync("/proc/self/environ");

/** cat 은 9분마다 시간이 다 돼 끊기고 곧바로 다시 뜬다. 그 틈에 상태가 working 으로 떨어지지 않게 이만큼 기다린다. */
const ROUND_GAP_MS = 5_000;

interface Waiting {
  fifo: string;
  seenAt: number;
}

async function isFifo(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isFIFO();
  } catch {
    return false;
  }
}

function envOf(raw: string): Map<string, string> {
  const env = new Map<string, string>();
  for (const pair of raw.split("\0")) {
    const eq = pair.indexOf("=");
    if (eq > 0) env.set(pair.slice(0, eq), pair.slice(eq + 1));
  }
  return env;
}

/** 지금 답 파이프를 기다리는 프로세스들 — pane id → FIFO 경로. 이 서버가 붙은 herdr 세션의 pane 만. */
async function scanProcs(socket: string): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  let pids: string[];
  try {
    pids = (await readdir("/proc")).filter((name) => /^\d+$/.test(name));
  } catch {
    return found;
  }
  await Promise.all(
    pids.map(async (pid) => {
      try {
        if ((await readFile(`/proc/${pid}/comm`, "utf8")).trim() !== "cat") return;
        const argv = (await readFile(`/proc/${pid}/cmdline`, "utf8")).split("\0").filter(Boolean);
        const fifo = argv.length === 2 ? argv[1]! : "";
        if (!fifo.endsWith("/answer") || !(await isFifo(fifo))) return;
        const env = envOf(await readFile(`/proc/${pid}/environ`, "utf8"));
        const pane = env.get("HERDR_PANE_ID");
        const sock = env.get("HERDR_SOCKET_PATH");
        // pane id 는 herdr 세션마다 따로 매기므로 소켓으로 세션을 가린다.
        if (!pane || !sock || resolve(sock) !== socket) return;
        // 에이전트가 강제로 죽으면 cat 은 FIFO 를 연 채 남아 init 등에 입양된다. 그 고아가 pane 을 계속 잠그지 않게,
        // 부모가 같은 pane 의 프로세스(카드를 띄운 에이전트)일 때만 인정한다.
        const ppid = /^\d+ \(.*\) \S (\d+)/s.exec(await readFile(`/proc/${pid}/stat`, "utf8"))?.[1];
        if (!ppid || ppid === "1") return;
        if (envOf(await readFile(`/proc/${ppid}/environ`, "utf8")).get("HERDR_PANE_ID") === pane) found.set(pane, fifo);
      } catch {
        // 그 사이에 끝났거나 남의 프로세스다.
      }
    }),
  );
  return found;
}

/**
 * 표식을 적는 쪽은 $XDG_RUNTIME_DIR, 없으면 $TMPDIR 를 쓴다. 이 서버와 에이전트의 환경이 어긋날 수 있어 둘 다 본다.
 */
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
    return envOf(await readFile(`/proc/${pid}/environ`, "utf8")).get("HERDR_PANE_ID") === pane;
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

/** 표식 파일이 가리키는 대기 — pane id → FIFO 경로. 이 서버가 붙은 herdr 세션의 pane 만. */
async function scanMarkers(socket: string): Promise<Map<string, string>> {
  const found = new Map<string, string>();
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
            const m = JSON.parse(await readFile(join(dir, name), "utf8")) as { pane?: unknown; socket?: unknown; fifo?: unknown; pid?: unknown };
            if (typeof m.pane !== "string" || typeof m.socket !== "string" || typeof m.fifo !== "string" || typeof m.pid !== "number") return;
            if (resolve(m.socket) !== socket || !(await holdsPane(m.pid, m.pane)) || !(await isFifo(m.fifo))) return;
            found.set(m.pane, m.fifo);
          } catch {
            // 쓰는 중이거나 그 사이에 지워졌다.
          }
        }),
      );
    }),
  );
  return found;
}

async function scan(socket: string): Promise<Map<string, string>> {
  const [markers, procs] = await Promise.all([scanMarkers(socket), scanProcs(socket)]);
  return new Map([...procs, ...markers]);
}

export class AskingPanes {
  private readonly waiting = new Map<string, Waiting>();
  private running: Promise<ReadonlySet<string>> | undefined;

  /** 카드를 띄워 놓고 답을 기다리는 pane 들. 동시에 부르면 한 번만 읽는다. */
  check(): Promise<ReadonlySet<string>> {
    this.running ??= this.refresh().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async refresh(): Promise<ReadonlySet<string>> {
    const now = Date.now();
    const found = await scan(resolve(herdrSocketPath()));
    for (const [pane, fifo] of found) this.waiting.set(pane, { fifo, seenAt: now });
    for (const [pane, w] of this.waiting) {
      if (found.has(pane)) continue;
      // 답하면 카드가 폴더째 지운다 — 파이프가 없으면 곧바로 놓는다. 남아 있어도 기다리는 프로세스가 오래 없으면
      // (세션이 죽어 폴더만 남았다) 놓는다.
      if (now - w.seenAt > ROUND_GAP_MS || !(await isFifo(w.fifo))) this.waiting.delete(pane);
    }
    return new Set(this.waiting.keys());
  }
}
