// 월드에서 이미 확인한 완료의 기록.
//
// herdr 는 화면을 그 pane 으로 옮겼을 때만 "봤다"고 친다. 월드에서 응답을 다 읽어도 완료로 남으므로,
// 월드가 따로 적어 둔다: pane 과 그때의 herdr 상태 변경 번호. 에이전트가 다시 일하면 번호가 바뀌어
// 기록은 저절로 무효가 된다. herdr 의 초점은 건드리지 않는다.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

function storePath(): string {
  const base = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
  return join(base, "agent-world", "seen.json");
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

  has(paneId: string, seq: number): boolean {
    return this.marks.get(paneId) === seq;
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
