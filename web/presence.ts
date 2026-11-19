// 이 기기 앞에 사람이 있는지 서버에 알린다. 있다고 알린 기기가 하나라도 있으면 서버는 그 기기에만 알림을 보낸다 —
// PC 를 쓰는 동안 같은 알림이 휴대폰과 워치까지 울리지 않게.
//
// "있다"는 둘 중 하나다: 이 기기의 키보드·마우스가 최근 2분 안에 움직였거나(IdleDetector, 데스크톱 Chrome 에서 권한을
// 준 뒤 — 다른 앱에 입력해도 센다), 이 창이 앞에 떠 있고 마지막 입력이 5분 안이다(입력 없이 섬을 지켜보는 동안).
// 창을 앞에 둔 채 자리를 떠도 5분이 지나면 없는 것이 된다. 서버는 소식이 끊기면 스스로 잊으므로(브라우저가 죽거나
// 창을 닫아도), 있는 동안에만 1분에 한 번 다시 알린다. 없는 동안에는 아무것도 보내지 않는다.
import { headers } from "./api.ts";

/** 입력이 이만큼 없으면 자리를 비운 것으로 본다. 긴 답을 읽는 동안 휴대폰이 울리지 않을 만큼. */
const IDLE_MS = 120_000;
/** 창이 앞에 떠 있을 때, 입력 없이도 있는 것으로 보는 시간. */
const FOCUS_MS = 300_000;
/** 있는 동안 다시 알리는(그리고 위 시간이 지났는지 다시 보는) 간격. 서버는 이것의 세 배쯤 소식이 없으면 잊는다. */
const REFRESH_MS = 60_000;

interface IdleDetectorLike extends EventTarget {
  userState: "active" | "idle" | null;
  start(options: { threshold: number; signal?: AbortSignal }): Promise<void>;
}
type IdleDetectorClass = { new (): IdleDetectorLike; requestPermission(): Promise<PermissionState> };

const Detector = (window as unknown as { IdleDetector?: IdleDetectorClass }).IdleDetector;
/** 기기 전체의 입력을 물어볼 만한 곳: IdleDetector 가 있고, 손가락이 아니라 마우스로 쓰는 기기. 휴대폰에서는 묻지 않는다. */
const askable = Detector !== undefined && matchMedia("(pointer: fine)").matches;

let endpoint: string | null = null;
let inputActive = false;
/** 사람이 있었다는 마지막 증거의 시각: 이 화면의 입력, 창이 앞으로 온 순간, 또는 IdleDetector 가 본 마지막 입력. */
let lastInput = Date.now();
let detecting: AbortController | null = null;
let sent: boolean | null = null;
let timer: ReturnType<typeof setInterval> | undefined;

function present(): boolean {
  return inputActive || (document.visibilityState === "visible" && document.hasFocus() && Date.now() - lastInput < FOCUS_MS);
}

function report(on: boolean): void {
  if (!endpoint) return;
  // 창을 닫는 순간에도 닿도록 keepalive 로 보낸다. 실패해도 서버가 곧 잊으므로 다시 보내지 않는다.
  void fetch("/api/push/presence", {
    method: "POST",
    keepalive: true,
    headers: { "content-type": "application/json", ...headers() },
    body: JSON.stringify({ endpoint, present: on }),
  }).catch(() => undefined);
}

/** 지금 있는지 다시 세고, 바뀌었으면(refresh 면 있을 때도) 서버에 알린다. */
function update(refresh = false): void {
  const on = endpoint !== null && present();
  if (on !== sent || (on && refresh)) {
    report(on);
    sent = on;
  }
  if (on && timer === undefined) timer = setInterval(() => update(true), REFRESH_MS);
  else if (!on && timer !== undefined) {
    clearInterval(timer);
    timer = undefined;
  }
}

async function detect(): Promise<void> {
  if (!Detector || detecting) return;
  const state = await navigator.permissions.query({ name: "idle-detection" as PermissionName }).catch(() => null);
  if (state?.state !== "granted") return;
  const controller = new AbortController();
  detecting = controller;
  const detector = new Detector();
  detector.addEventListener("change", () => {
    inputActive = detector.userState === "active";
    // 쉬는 것으로 바뀐 순간의 마지막 입력은 문턱만큼 전이다.
    lastInput = inputActive ? Date.now() : Math.max(lastInput, Date.now() - IDLE_MS);
    update();
  });
  try {
    await detector.start({ threshold: IDLE_MS, signal: controller.signal });
  } catch {
    detecting = null;
  }
}

/** 기기 전체의 입력을 볼 권한을 묻는다. 사용자가 누른 순간에만 물을 수 있다(브라우저 규칙). 이미 답했으면 묻지 않는다. */
export async function askForInput(): Promise<void> {
  if (!askable || !Detector) return;
  const state = await navigator.permissions.query({ name: "idle-detection" as PermissionName }).catch(() => null);
  if (state?.state === "prompt") await Detector.requestPermission().catch(() => undefined);
  await detect();
}

/** 이 브라우저가 알림을 받는 구독(endpoint)으로 자리를 알리기 시작한다. null 이면 그만두고 서버에서도 지운다. */
export function reportPresence(next: string | null): void {
  if (next === endpoint) return;
  if (endpoint && sent) report(false);
  endpoint = next;
  sent = null;
  if (!next) {
    detecting?.abort();
    detecting = null;
    inputActive = false;
  } else void detect();
  update();
}

/** 아직 권한을 묻지 않은 데스크톱 브라우저면, 화면을 처음 누를 때 한 번 묻는다. 알림을 이미 켜 둔 기기를 위한 길이다. */
export function askOnFirstTouch(): void {
  if (!askable) return;
  void navigator.permissions
    .query({ name: "idle-detection" as PermissionName })
    .then((state) => {
      if (state.state !== "prompt") return;
      document.addEventListener("pointerdown", () => void askForInput(), { once: true, capture: true });
    })
    .catch(() => undefined);
}

function touched(): void {
  lastInput = Date.now();
  // 있다고 알린 동안에는 시각만 적는다 — 마우스가 움직일 때마다 다시 셀 필요는 없다.
  if (sent !== true) update();
}
for (const name of ["pointerdown", "pointermove", "keydown", "wheel"] as const) window.addEventListener(name, touched, { passive: true, capture: true });
window.addEventListener("focus", touched);
window.addEventListener("blur", () => update());
document.addEventListener("visibilitychange", () => update());
// 창을 닫으면 곧장 "없음"을 알린다. 다시 보이면(뒤로 가기 캐시) 다시 센다.
window.addEventListener("pagehide", () => {
  if (sent) report(false);
  sent = false;
});
window.addEventListener("pageshow", () => update());
