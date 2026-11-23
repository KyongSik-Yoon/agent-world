// 전체 보기의 박자. 걷는 캐릭터가 있을 때만 도는 rAF 하나이고, 아무도 걷지 않으면 멈춘다 — 쉬는 동안 화면은 한 장도
// 나가지 않는다. 같은 때에 걷는 캐릭터들은 같은 장을 나눠 쓴다. 3D 월드의 장면 박자(web/world/scene.ts)에 해당하는 것이라
// 이 파일은 제 requestAnimationFrame 을 돌린다(dev/perf/lint.ts 의 RAF_OK).
//
// 데스크톱은 초당 30장, 손가락으로 쓰는 기기는 8장(껑충껑충)으로 그린다 — 휴대폰에서는 장 수가 곧 발열과 배터리다.
// 화면 주사율을 따라가는 CSS 전환은 쓰지 않는다(120Hz 화면에서 장 수가 두 배가 된다).

/** 걷는 시간(ms). */
const DURATION = 900;
const asked = Number(new URLSearchParams(location.search).get("fps"));
const FPS = asked > 0 ? asked : matchMedia("(pointer: coarse)").matches ? 8 : 30;
const still = matchMedia("(prefers-reduced-motion: reduce)");

interface Walk {
  el: HTMLElement;
  /** 떠난 자리와 새 자리의 차이(섬 폭의 %). 0 으로 줄여 간다. */
  dx: number;
  dy: number;
  t0: number;
}

const walks = new Map<HTMLElement, Walk>();
let running = false;
let last = 0;

/** 잴 때 쓰는 셈: 박자가 그린 장 수와 걷기를 시작한 횟수(dev/perf/run.ts). */
export const counters = { frames: 0, walks: 0 };

/**
 * el 은 이미 새 자리에 놓여 있다. 떠난 자리와의 차이(dx, dy — 섬 폭의 %)만큼 되돌려 놓고 0 으로 줄여 걷는 것처럼 보인다.
 * 걷는 동안만 따로 층으로 올려, 밑의 섬 그림을 다시 칠하지 않는다.
 */
export function walk(el: HTMLElement, dx: number, dy: number): void {
  if (still.matches || document.hidden || (Math.abs(dx) < 0.05 && Math.abs(dy) < 0.05)) return;
  counters.walks += 1;
  el.style.willChange = "transform";
  el.style.transform = `translate(${dx.toFixed(2)}cqw, ${dy.toFixed(2)}cqw)`;
  walks.set(el, { el, dx, dy, t0: -1 });
  if (running) return;
  running = true;
  requestAnimationFrame(frame);
}

/** 걷던 것을 그 자리에서 끝낸다(캐릭터가 사라질 때). */
export function settle(el: HTMLElement): void {
  if (!walks.delete(el)) return;
  el.style.transform = "";
  el.style.willChange = "";
}

function frame(t: number): void {
  // 화면 박자가 더 빨라도 FPS 장만 그린다.
  if (t - last < 1000 / FPS - 3) {
    requestAnimationFrame(frame);
    return;
  }
  last = t;
  counters.frames += 1;
  for (const w of walks.values()) {
    if (w.t0 < 0) w.t0 = t;
    const p = Math.min(1, (t - w.t0) / DURATION);
    if (p >= 1) {
      settle(w.el);
      continue;
    }
    const left = 1 - (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);
    // 걸음마다 살짝 뛴다 — 이미 내보내는 장에 얹으므로 장 수는 늘지 않는다.
    const hop = Math.abs(Math.sin(p * Math.PI * 5)) * 0.35;
    w.el.style.transform = `translate(${(w.dx * left).toFixed(2)}cqw, ${(w.dy * left - hop).toFixed(2)}cqw)`;
  }
  if (walks.size) requestAnimationFrame(frame);
  else running = false;
}
