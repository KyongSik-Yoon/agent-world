// 월드에서 이미 확인한 완료의 기록.
//
// herdr 는 화면을 그 pane 으로 옮겼을 때만 "봤다"고 친다. 월드에서 응답을 다 읽어도 완료로 남으므로,
// 월드가 따로 적어 둔다: pane 과 그때의 herdr 상태 변경 번호. 에이전트가 다시 일하면 번호가 바뀌어
// 기록은 저절로 무효가 된다. herdr 의 초점은 건드리지 않는다.
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { herdrDefaultSocket } from "./herdr.ts";

/**
 * 기록 파일은 herdr 세션마다 따로 둔다. pane id 는 세션 안에서만 고유해서(w1:p1 …), 한 파일을 같이 쓰면
 * 다른 세션에 붙은 월드가 서로의 기록을 "사라진 pane"으로 보고 지운다. 기본 소켓은 예전 이름 그대로다.
 */
function storePath(): string {
  const base = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
  const socket = process.env.HERDR_SOCKET_PATH;
  const tag = socket && resolve(socket) !== herdrDefaultSocket() ? `-${createHash("sha1").update(resolve(socket)).digest("hex").slice(0, 10)}` : "";
  return join(base, "agent-world", `seen${tag}.json`);
}

export class SeenStore {
  private marks = new Map<string, number>();
  private loaded = false;
  private writing: Promise<void> = Promise.resolve();

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const data = JSON.parse(await readFile(storePath(), "utf8")) as Record<string, unknown>;
      for (const [id, seq] of Object.entries(data)) if (typeof seq === "number") this.marks.set(id, seq);
    } catch {
      // 아직 기록이 없다.
    }
  }

  /**
   * 그 pane 의 지금 상태 번호가 확인해 둔 것과 같은지. 번호가 달라졌으면(다시 일했다) 기록을 그 자리에서
   * 지운다 — 나중에 같은 번호가 다시 나와도 새 완료를 가리지 않게.
   */
  check(paneId: string, seq: number): boolean {
    const mark = this.marks.get(paneId);
    if (mark === undefined) return false;
    if (mark === seq) return true;
    this.marks.delete(paneId);
    this.save();
    return false;
  }

  set(paneId: string, seq: number | null): void {
    if (seq === null) this.marks.delete(paneId);
    else this.marks.set(paneId, seq);
    this.save();
  }

  /** 사라진 pane 의 기록을 치운다. */
  prune(alive: ReadonlySet<string>): void {
    let changed = false;
    for (const id of this.marks.keys()) {
      if (!alive.has(id)) {
        this.marks.delete(id);
        changed = true;
      }
    }
    if (changed) this.save();
  }

  private save(): void {
    const body = JSON.stringify(Object.fromEntries(this.marks));
    this.writing = this.writing
      .then(async () => {
        const path = storePath();
        await mkdir(dirname(path), { recursive: true });
        await writeFile(`${path}.tmp`, body);
        await rename(`${path}.tmp`, path);
      })
      .catch((e) => console.error("확인 기록 저장 실패:", e));
  }
}
