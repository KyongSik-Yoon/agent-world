// herdr 가 "쉬는 중"으로 보지만 실제로는 화면에 확인 창을 띄워 답을 기다리는 agy pane 을 찾는다.
//
// agy 의 질문·권한 창은 입력창 자리에 뜨고 맨 아래에 키 안내 줄을 둔다("↑/↓ Navigate · … · esc Skip"). herdr 의 agy 규칙
// (매니페스트 2026.10.05.1)은 그 줄을 화면의 맨 아래 두 줄에서만 찾는다. 상태줄을 켠 agy 는 안내 줄 밑에 상태줄을 그리므로
// 규칙이 하나도 맞지 않고, herdr 는 알려진 에이전트의 기본값인 idle 로 떨어뜨린다 — 묻고 있는데 "완료"로 보인다(0.9.5 실측).
// 그래서 herdr 가 쉰다고 한 agy pane 의 화면을 직접 읽어 안내 줄을 찾는다.
import { herdrScreen } from "./herdr.ts";

/** 안내 줄을 찾을 범위 — 화면 아래쪽의 비지 않은 줄 수. 상태줄이 몇 줄이든 덮고, 대화 본문까지는 올라가지 않는다. */
const FOOTER_LINES = 10;
/** 질문("esc Skip"), 권한("tab Amend"), 폴더 신뢰("enter Confirm") 창의 안내 줄. 빗금 명령 목록("tab Complete")은 아니다. */
const HINT = /^\s*↑\/↓ Navigate\b.*\b(esc Skip|tab Amend|enter Confirm)\b/i;
/** 상태가 바뀐 뒤 이만큼은 매번 다시 읽는다 — herdr 가 상태를 넘긴 때와 창이 그려진 때가 조금 어긋날 수 있다. */
const SETTLE_MS = 5_000;

/** 화면에 agy 의 확인 창이 떠 있는지. */
export function agyDialogOpen(screen: string): boolean {
  const lines = screen.split(/\r?\n/).filter((l) => l.trim());
  return lines.slice(-FOOTER_LINES).some((l) => HINT.test(l));
}

export class AgyDialogs {
  private readonly panes = new Map<string, { key: string; at: number; open: boolean }>();

  /**
   * 이 pane 이 확인 창을 띄워 놓았는지. `key` 는 화면이 달라졌을 만한 일(herdr 상태 번호, 로그가 고쳐진 시각)을 묶은 값이다.
   * 그것이 그대로이고 창도 없었으면 화면을 다시 읽지 않는다. 창이 떠 있는 동안은 닫혔는지 매번 본다 — 답하지 않고 닫으면
   * herdr 에게는 쉬다가 쉬는 것이라 아무것도 달라지지 않는다.
   */
  async check(paneId: string, key: string): Promise<boolean> {
    const now = Date.now();
    let known = this.panes.get(paneId);
    if (!known || known.key !== key) this.panes.set(paneId, (known = { key, at: now, open: known?.open ?? false }));
    else if (!known.open && now - known.at > SETTLE_MS) return false;
    try {
      known.open = agyDialogOpen(await herdrScreen(paneId));
    } catch {
      // 화면을 읽지 못했다 — 직전에 본 대로 둔다.
    }
    return known.open;
  }

  /** 지금 이 순간 확인 창이 떠 있는지 — 지시를 넣기 직전에 묻는다. 쉬고 있는 agy pane 이 아니면 화면을 읽지 않는다. */
  async now(paneId: string): Promise<boolean> {
    const known = this.panes.get(paneId);
    if (!known) return false;
    known.open = agyDialogOpen(await herdrScreen(paneId));
    return known.open;
  }

  /** herdr 가 쉰다고 하지 않는 pane 은 잊는다. */
  forget(paneId: string): void {
    this.panes.delete(paneId);
  }

  prune(alive: ReadonlySet<string>): void {
    for (const id of this.panes.keys()) if (!alive.has(id)) this.panes.delete(id);
  }
}
