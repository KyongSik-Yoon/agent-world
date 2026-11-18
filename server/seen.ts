// 월드가 pane 마다 적어 두는 기록 두 가지.
//
// - 확인 기록(SeenStore): herdr 는 화면을 그 pane 으로 옮겼을 때만 "봤다"고 친다. 월드에서 응답을 다 읽어도 완료로
//   남으므로, 월드가 따로 적어 둔다: pane 과 그때의 herdr 상태 변경 번호. 에이전트가 다시 일하면 번호가 바뀌어
//   기록은 저절로 무효가 된다. herdr 의 초점은 건드리지 않는다.
// - 이름 기록(NameStore): 월드에서 지어 준 pane 이름. herdr 의 pane label 은 이름을 짓지 않아도 다른 플러그인
//   (auto-title 등)이 터미널 제목이나 폴더 이름으로 채우므로, label 만 보고는 사람이 지은 이름인지 알 수 없다.
//   월드에서 지은 것은 월드가 알므로 적어 두고, label 이 그 이름 그대로인 동안만 주민의 제목으로 쓴다.
import { readFile, rename, stat } from "node:fs/promises";
import { join } from "node:path";

import { herdrSessionTag } from "./herdr.ts";
import { stateDir, writePrivate } from "./key.ts";
import { L, say, type Text } from "./text.ts";

/**
 * pane id → 값 하나씩의 기록 파일. herdr 세션마다 따로 둔다. pane id 는 세션 안에서만 고유해서(w1:p1 …), 한 파일을
 * 같이 쓰면 다른 세션에 붙은 월드가 서로의 기록을 "사라진 pane"으로 보고 지운다. 기본 소켓은 이름에 꼬리를 달지 않는다.
 */
abstract class PaneStore<T> {
  protected marks = new Map<string, T>();
  private writing: Promise<void> = Promise.resolve();
  /** 마지막으로 읽었거나 내가 쓴 파일의 모습(수정 시각과 크기). 달라졌으면 다른 서버가 쓴 것이다. */
  private stamp = "";
  /** 고친 횟수 — 파일을 읽는 사이에 고쳤는지 알아보는 데 쓴다. */
  private edits = 0;

  constructor(
    private readonly name: string,
    private readonly valid: (v: unknown) => v is T,
    private readonly failText: Text,
  ) {}

  private path(): string {
    const tag = herdrSessionTag();
    return join(stateDir(), `${this.name}${tag ? `-${tag}` : ""}.json`);
  }

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
      const info = await stat(this.path());
      stamp = `${info.mtimeMs}:${info.size}`;
      if (stamp === this.stamp) return;
      body = await readFile(this.path(), "utf8");
    } catch {
      // 아직 기록이 없다.
      return;
    }
    // 읽는 사이에 내가 고쳤으면 내 것이 더 새롭다 — 곧 파일에 적히고, 다음에 다시 맞춘다.
    if (edits !== this.edits) return;
    try {
      const data = JSON.parse(body) as Record<string, unknown>;
      this.marks = new Map(Object.entries(data).filter((e): e is [string, T] => this.valid(e[1])));
      this.stamp = stamp;
    } catch {
      // 쓰다 만 파일이면 지금 가진 것을 그대로 쓴다.
    }
  }

  set(paneId: string, value: T | null): void {
    if (value === null) {
      if (!this.marks.delete(paneId)) return;
    } else if (this.marks.get(paneId) === value) return;
    else this.marks.set(paneId, value);
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

  protected save(): void {
    this.edits += 1;
    const body = JSON.stringify(Object.fromEntries(this.marks));
    this.writing = this.writing
      .then(async () => {
        const path = this.path();
        // 임시 파일은 프로세스마다 따로 — 둘이 같은 이름에 쓰다 섞이지 않게. 이 사용자만 읽게 적는다.
        const tmp = `${path}.${process.pid}.tmp`;
        await writePrivate(tmp, body);
        await rename(tmp, path);
        const info = await stat(path);
        this.stamp = `${info.mtimeMs}:${info.size}`;
      })
      .catch((e) => console.error(say(this.failText), e));
  }
}

export class SeenStore extends PaneStore<number> {
  constructor() {
    super("seen", (v): v is number => typeof v === "number", L("확인 기록 저장 실패:", "Could not save the seen marks:"));
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
}

export class NameStore extends PaneStore<string> {
  constructor() {
    super("names", (v): v is string => typeof v === "string" && v !== "", L("이름 기록 저장 실패:", "Could not save the pane names:"));
  }

  /**
   * 월드에서 지어 준 이름이 아직 그 pane 의 label 이면 그 이름. herdr 에서 다른 이름으로 바꿨거나 지웠으면 기록을
   * 그 자리에서 지운다 — 그 뒤의 label 은 누가 지었는지 모르므로 제목으로 올리지 않는다.
   */
  check(paneId: string, label: string | undefined): string | undefined {
    const name = this.marks.get(paneId);
    if (name === undefined) return undefined;
    if (name === label) return name;
    this.marks.delete(paneId);
    this.save();
    return undefined;
  }
}
