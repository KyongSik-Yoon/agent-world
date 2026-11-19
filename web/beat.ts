// 이름표의 깜빡임·들썩임과 일하는 로고의 박자. CSS 애니메이션으로 따로 돌리지 않고, 장면이 한 장 그릴 때 같이 넘긴다.
//
// CSS 애니메이션은 계단식이어도 제 박자가 올 때마다 화면을 한 장씩 더 내보낸다. 그것도 요소마다 시작한 때가 달라
// 서로 겹치지도 않는다. 실제 창에서 재니(4K 60Hz, 에이전트 22명 중 일하는 로고 6개, 띄워만 둔 상태) 장면은 초당
// 12장을 그리는데 화면 출력은 37장이었고, 크롬이 코어의 39% 를 썼다. 화면을 한 장 내보내는 데는 무엇이 바뀌었든
// 고정비가 든다 — 그래서 바꿀 것을 장면의 프레임 안에서 바꿔 그 프레임에 묻어 나가게 한다.
//
// 장면이 그리지 않는 동안(터미널 크게 보기에 덮였을 때, 탭이 가려졌을 때)에는 박자도 선다.
import { stepLogos } from "./logos.ts";

interface Tick {
  /** 박자 사이의 간격(ms). */
  readonly every: number;
  at: number;
  run(count: number): void;
  count: number;
}

/** 박자가 홀수 번째인 동안 body 에 이 속성이 붙는다. 모양은 style.css 가 정한다. */
function flip(attribute: string): (count: number) => void {
  return (count) => document.body.toggleAttribute(attribute, count % 2 === 1);
}

/** 일하는 로고가 한 칸 넘어가는 간격(ms). 굽는 칸 수도 여기에 맞춘다(logos.ts). */
export const LOGO_STEP_MS = 240;

const ticks: Tick[] = [
  { every: LOGO_STEP_MS, at: 0, count: 0, run: stepLogos },
  // 일하는 에이전트의 점: 0.6초마다 흐려졌다 돌아온다.
  { every: 600, at: 0, count: 0, run: flip("data-beat") },
  // 확인이 필요한 에이전트의 점은 두 배로 빨리 깜빡이고, 말풍선은 0.45초마다 들썩인다.
  { every: 300, at: 0, count: 0, run: flip("data-beat-quick") },
  { every: 450, at: 0, count: 0, run: flip("data-beat-nudge") },
];

/**
 * 장면의 다음 프레임에 얹어 할 일들. 제 requestAnimationFrame 으로 그리면 장면이 쉬는 사이에 화면을 한 장 더 내보낸다 —
 * 곁눈질 화면(초당 3장)에서 0.4초마다 바뀌는 터미널 미리보기가 그렇게 출력을 두 배로 늘렸다.
 */
const riders = new Set<() => void>();
let stranded: ReturnType<typeof setTimeout> | undefined;
/** 장면이 이만큼 그리지 않으면(덮였거나 멈췄다) 기다리지 않고 따로 그린다. 곁눈질 화면의 간격(333ms)보다 길다. */
const RIDE_WAIT_MS = 700;

function flush(): void {
  clearTimeout(stranded);
  stranded = undefined;
  if (riders.size === 0) return;
  const run = [...riders];
  riders.clear();
  for (const fn of run) fn();
}

/** 장면의 다음 프레임 안에서 fn 을 부른다. 돌려주는 함수로 무른다. */
export function rideFrame(fn: () => void): () => void {
  riders.add(fn);
  stranded ??= setTimeout(() => requestAnimationFrame(flush), RIDE_WAIT_MS);
  return () => riders.delete(fn);
}

const stillness = matchMedia("(prefers-reduced-motion: reduce)");

/**
 * 장면이 한 장 그릴 때마다 부른다. frameMs 는 지금 장면이 그리는 간격이다.
 *
 * 박자는 프레임에 맞춰서만 넘어가므로, 간격을 그대로 기다리면 프레임이 느릴 때(띄워만 둔 화면의 80ms) 어떤 칸은
 * 세 프레임, 어떤 칸은 네 프레임 동안 보여 걸음이 절뚝인다. 반 프레임 일찍 넘겨, 늘 가장 가까운 프레임에서 넘어가게 한다.
 */
export function beat(now: number, frameMs: number): void {
  flush();
  if (stillness.matches) {
    for (const tick of ticks) if (tick.count % 2 === 1) tick.run((tick.count = 0));
    return;
  }
  for (const tick of ticks) {
    if (now - tick.at < tick.every - frameMs / 2) continue;
    tick.at = now;
    tick.run((tick.count += 1));
  }
}
