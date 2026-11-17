// 월드에서 이미 확인한 완료의 기록.
//
// herdr 는 화면을 그 pane 으로 옮겼을 때만 "봤다"고 친다. 월드에서 응답을 다 읽어도 완료로 남으므로,
// 월드가 따로 적어 둔다: pane 과 그때의 herdr 상태 변경 번호. 에이전트가 다시 일하면 번호가 바뀌어
// 기록은 저절로 무효가 된다. herdr 의 초점은 건드리지 않는다.
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { herdrSessionTag } from "./herdr.ts";

/** 이 사용자의 Agent World 가 상태를 적어 두는 폴더. */
export function stateDir(): string {
  return join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "agent-world");
}

/** 떠 있는 서버가 제 주소를 적어 두는 파일 — herdr 세션마다, 그리고 조작용과 보기 전용이 따로. */
export function addressFile(readonly: boolean): string {
  const tag = herdrSessionTag();
  return join(stateDir(), `server${tag ? `-${tag}` : ""}${readonly ? ".readonly" : ""}.json`);
}

/**
 * 기록 파일은 herdr 세션마다 따로 둔다. pane id 는 세션 안에서만 고유해서(w1:p1 …), 한 파일을 같이 쓰면
 * 다른 세션에 붙은 월드가 서로의 기록을 "사라진 pane"으로 보고 지운다. 기본 소켓은 예전 이름 그대로다.
 */
function storePath(): string {
  const tag = herdrSessionTag();
  return join(stateDir(), `seen${tag ? `-${tag}` : ""}.json`);
}

export class SeenStore {
  private marks = new Map<string, number>();
  private writing: Promise<void> = Promise.resolve();
  /** 마지막으로 읽었거나 내가 쓴 파일의 모습(수정 시각과 크기). 달라졌으면 다른 서버가 쓴 것이다. */
  private stamp = "";
  /** 고친 횟수 — 파일을 읽는 사이에 고쳤는지 알아보는 데 쓴다. */
  private edits = 0;

  /**
   * 파일이 바뀌었으면 다시 읽는다. 같은 herdr 에 서버가 둘 붙을 수 있어서(조작용과 보기 전용) 처음 한 번만 읽으면
   * 한쪽이 묵은 내용으로 다른 쪽의 기록을 덮어쓴다. 스냅샷을 만들 때마다 부른다.
   */
  async load(): Promise<void> {
    await this.writing;
    const edits = this.edits;
    let stamp: string;
    let body: string;
    try {
      const info = await stat(storePath());
      stamp = `${info.mtimeMs}:${info.size}`;
      if (stamp === this.stamp) return;
      body = await readFile(storePath(), "utf8");
    } catch {
      // 아직 기록이 없다.
      return;
    }
    // 읽는 사이에 내가 고쳤으면 내 것이 더 새롭다 — 곧 파일에 적히고, 다음에 다시 맞춘다.
    if (edits !== this.edits) return;
    try {
      const data = JSON.parse(body) as Record<string, unknown>;
      this.marks = new Map(Object.entries(data).filter((e): e is [string, number] => typeof e[1] === "number"));
      this.stamp = stamp;
    } catch {
      // 쓰다 만 파일이면 지금 가진 것을 그대로 쓴다.
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
    this.edits += 1;
    const body = JSON.stringify(Object.fromEntries(this.marks));
    this.writing = this.writing
      .then(async () => {
        const path = storePath();
        await mkdir(dirname(path), { recursive: true });
        // 임시 파일은 프로세스마다 따로 — 둘이 같은 이름에 쓰다 섞이지 않게.
        const tmp = `${path}.${process.pid}.tmp`;
        await writeFile(tmp, body);
        await rename(tmp, path);
        const info = await stat(path);
        this.stamp = `${info.mtimeMs}:${info.size}`;
      })
      .catch((e) => console.error("확인 기록 저장 실패:", e));
  }
}
