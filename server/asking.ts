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
import { existsSync } from "node:fs";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

import { herdrSocketPath } from "./herdr.ts";

const HAS_PROC = existsSync("/proc/self/environ");

interface Marker {
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

/** 지금 카드를 띄워 답을 기다리는 pane 들. 이 서버가 붙은 herdr 세션의 pane 만 — pane id 는 세션마다 따로 매긴다. */
async function scan(socket: string): Promise<Set<string>> {
  const found = new Set<string>();
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
            found.add(m.pane);
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
  private running: Promise<ReadonlySet<string>> | undefined;

  /** 카드를 띄워 놓고 답을 기다리는 pane 들. 동시에 부르면 한 번만 읽는다. */
  check(): Promise<ReadonlySet<string>> {
    this.running ??= scan(resolve(herdrSocketPath())).finally(() => {
      this.running = undefined;
    });
    return this.running;
  }
}
