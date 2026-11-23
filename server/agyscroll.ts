// 위로 넘겨 둔 agy 의 대화를 맨 아래로 돌린다.
//
// agy 는 대화를 한 번 위로 넘기면(PageUp, 휠) 스스로 내려오지 않는다 — 새 출력이 쌓여도, 지시를 제출해도 그 자리에 머물고
// 입력창 바로 위에 "↓ 1910 lines · 22 turns" 처럼 아래에 남은 양만 적는다(1.5.13·1.5.14 실측). End·Ctrl+End 는 먹지 않고
// PageDown 과 휠만 내린다. 그대로 두면 pane 화면도, 그것을 비추는 미리보기도 몇 시간 전 장면에 멈춘다.
// 넘긴 횟수를 세어 그만큼 되돌리는 것으로는 못 돌아온다 — 넘겨 둔 동안 출력이 쌓이고, 세는 쪽(브라우저)이 닫히면 횟수를 잃는다.
// 그래서 화면의 그 표시를 상태로 읽어, 사라질 때까지 PageDown 을 보낸다.
import { herdrRaw, herdrScreen } from "./herdr.ts";

const PAGE_DOWN = "\x1b[6~";
/** 입력창 바로 위의 "아래에 남은 양" 줄. */
const BELOW = /^\s*↓ ([\d,]+) lines?\b/;
/** 입력창을 두르는 가로줄(pane 폭 가득). 대화 속 지시 위의 줄은 60칸이라 이것만으로는 못 가른다 — 아래에서부터 찾는다. */
const RULE = /^─{20,}\s*$/;
/** 한 쪽에 내려가는 줄 수를 낮춰 잡는 몫. 38줄 pane 에서 한 쪽은 31~32줄이었다. 넘쳐 보내도 맨 아래에서는 아무 일도 없다. */
const PAGE_SHARE = 0.5;
const MAX_PRESSES = 60;
const MAX_ROUNDS = 6;
/** 보낸 PageDown 이 화면에 그려지기를 기다리는 시간. */
const SETTLE_MS = 120;

/** agy 화면에서 입력창 아래로 남은 줄 수. 맨 아래에 있거나 입력창이 안 보이면(확인 창 등) 0. */
export function agyLinesBelow(screen: string): number {
  const lines = screen.split(/\r?\n/);
  // 아래에서 올라가며 입력창 윗줄을 찾는다 — 가로줄 바로 다음 줄이 입력창(">")이다.
  for (let i = lines.length - 2; i > 0; i -= 1) {
    if (!RULE.test(lines[i]!) || !/^>/.test(lines[i + 1]!)) continue;
    const m = BELOW.exec(lines[i - 1]!);
    return m ? Number(m[1]!.replace(/,/g, "")) : 0;
  }
  return 0;
}

/** 위로 넘겨 둔 agy pane 을 맨 아래로 돌린다. 돌렸으면 true. */
export async function agyToBottom(paneId: string): Promise<boolean> {
  let moved = false;
  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    const screen = await herdrScreen(paneId);
    const below = agyLinesBelow(screen);
    if (below === 0) return moved;
    const page = Math.max(4, Math.floor(screen.split(/\r?\n/).length * PAGE_SHARE));
    await herdrRaw(paneId, PAGE_DOWN.repeat(Math.min(MAX_PRESSES, Math.ceil(below / page))));
    moved = true;
    await Bun.sleep(SETTLE_MS);
  }
  return moved;
}
