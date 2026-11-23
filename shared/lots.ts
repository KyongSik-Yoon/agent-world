// 스페이스들을 집터로 묶는 규칙. 3D 장면(web/world/layout.ts)과 전체 보기(server/all.ts, web/all/)가 같이 쓴다 —
// 그래서 three 에 기대지 않는다.

/** 집터 하나에 들어갈 스페이스들. linked 가 아닌 것(본체 체크아웃)이 main 이다. */
export interface LotSpec {
  key: string;
  main?: string;
  annexes: string[];
  /** 본채가 비었을 때 문패에 쓸 이름. */
  name?: string;
}

/** 워크스페이스 id 로 정해지는 색상 — 순서가 바뀌어도 같은 집은 같은 지붕색을 갖는다. */
export function hueOf(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i += 1) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return ((h >>> 0) % 360) / 360;
}

/**
 * 스페이스들을 집터로 묶는다. 같은 저장소(repoKey)의 스페이스가 둘 이상이면 한 집터, 아니면 홀로 선 집이다.
 * 집터의 차례는 그 저장소의 첫 스페이스가 herdr 목록에 나오는 자리다.
 */
export function groupLots(workspaces: ReadonlyArray<{ id: string; label: string; repo?: string; worktree?: { linked: boolean; repoKey?: string } }>): LotSpec[] {
  const count = new Map<string, number>();
  for (const ws of workspaces) if (ws.worktree?.repoKey) count.set(ws.worktree.repoKey, (count.get(ws.worktree.repoKey) ?? 0) + 1);
  const lots: LotSpec[] = [];
  const byRepo = new Map<string, LotSpec>();
  for (const ws of workspaces) {
    const repoKey = ws.worktree?.repoKey;
    if (!repoKey || (count.get(repoKey) ?? 0) < 2) {
      lots.push({ key: ws.id, main: ws.id, annexes: [] });
      continue;
    }
    let lot = byRepo.get(repoKey);
    if (!lot) {
      lot = { key: `repo:${repoKey}`, annexes: [], name: ws.repo ?? repoKey };
      byRepo.set(repoKey, lot);
      lots.push(lot);
    }
    // 본체 체크아웃이 둘 이상 열려 있으면(같은 폴더에 스페이스 둘) 먼저 나온 것만 본채이고 나머지는 별채로 선다.
    if (!ws.worktree!.linked && !lot.main) lot.main = ws.id;
    else lot.annexes.push(ws.id);
  }
  return lots;
}

/** 집터 배치를 다시 지어야 하는지 가르는 열쇠 — 이름·초점이 바뀌는 것으로는 다시 짓지 않는다. */
export function lotsKey(lots: readonly LotSpec[]): string {
  return lots.map((l) => (l.annexes.length === 0 && l.main === l.key ? l.key : `${l.key}[${l.main ?? ""}|${l.annexes.join(",")}]`)).join("|");
}
