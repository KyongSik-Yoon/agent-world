// 아래에서 올라오는 서랍을 손가락으로 끌어내려 닫는다.

/** 이만큼 움직여야 끌기인지 스크롤인지 가른다(px). */
const SLOP = 6;
/** 서랍 높이의 이 비율보다 많이 내리면 놓았을 때 닫힌다. */
const CLOSE_RATIO = 0.3;
/** 놓기 직전 이 시간 동안 이보다 빠르게 아래로 움직였으면 조금만 내렸어도 닫힌다(px/ms). */
const FLICK = 0.5;
const FLICK_WINDOW = 100;

/**
 * 서랍을 아래로 끌어 닫게 한다. 손잡이나 검색칸을 잡으면 늘 서랍이 끌리고, 목록 안에서 시작하면
 * 목록이 맨 위까지 올라가 있을 때만 끌린다 — 그 밖에는 목록이 스크롤된다.
 * `active` 가 거짓이면(넓은 화면, 닫힌 서랍) 아무것도 하지 않는다.
 */
export function swipeToClose(sheet: HTMLElement, scroller: HTMLElement, active: () => boolean, close: () => void): void {
  let state: "idle" | "maybe" | "drag" = "idle";
  let startX = 0;
  let startY = 0;
  let canPull = false;
  let offset = 0;
  /** 최근 움직임 — 놓을 때의 속도를 잰다. */
  let samples: Array<{ y: number; t: number }> = [];

  sheet.addEventListener(
    "touchstart",
    (e) => {
      if (!active() || e.touches.length !== 1) return void (state = "idle");
      const touch = e.touches[0]!;
      startX = touch.clientX;
      startY = touch.clientY;
      canPull = !scroller.contains(e.target as Node) || scroller.scrollTop <= 0;
      samples = [{ y: touch.clientY, t: e.timeStamp }];
      state = canPull ? "maybe" : "idle";
    },
    { passive: true },
  );

  sheet.addEventListener(
    "touchmove",
    (e) => {
      if (state === "idle") return;
      if (e.touches.length !== 1) return end(false, e.timeStamp);
      const touch = e.touches[0]!;
      const dx = touch.clientX - startX;
      const dy = touch.clientY - startY;
      if (state === "maybe") {
        if (Math.abs(dx) < SLOP && Math.abs(dy) < SLOP) return;
        // 위로, 혹은 옆으로 먼저 움직였으면 스크롤에 맡긴다.
        if (dy <= 0 || Math.abs(dy) < Math.abs(dx)) return void (state = "idle");
        state = "drag";
        sheet.classList.add("dragging");
        startY += SLOP; // 가르는 데 쓴 거리만큼 튀지 않게
      }
      e.preventDefault();
      offset = Math.max(0, touch.clientY - startY);
      sheet.style.transform = `translateY(${offset}px)`;
      samples.push({ y: touch.clientY, t: e.timeStamp });
      if (samples.length > 12) samples.shift();
    },
    { passive: false },
  );

  const end = (released: boolean, at: number): void => {
    if (state !== "drag") return void (state = "idle");
    state = "idle";
    sheet.classList.remove("dragging");
    // 놓는 순간의 속도 — 끌다가 멈춘 뒤 놓았다면 0 이다.
    const recent = samples.find((s) => at - s.t <= FLICK_WINDOW);
    const last = samples[samples.length - 1]!;
    const speed = recent && at > recent.t ? (last.y - recent.y) / (at - recent.t) : 0;
    const height = sheet.getBoundingClientRect().height;
    if (!released || (offset < height * CLOSE_RATIO && !(speed > FLICK && offset > SLOP * 3))) {
      sheet.style.transform = ""; // 제자리로 미끄러져 돌아간다
      return;
    }
    // 화면 밖까지 내려보낸 뒤 닫는다. 움직임을 줄인 기기에서는 전환이 없으니 바로 닫는다.
    const gone = window.innerHeight - sheet.getBoundingClientRect().top + 8;
    const done = (): void => {
      clearTimeout(timer);
      sheet.removeEventListener("transitionend", done);
      if (sheet.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
      close();
      sheet.style.transform = "";
    };
    const timer = setTimeout(done, 320);
    sheet.addEventListener("transitionend", done);
    sheet.style.transform = `translateY(${offset + gone}px)`;
    if (getComputedStyle(sheet).transitionDuration === "0s") done();
  };
  sheet.addEventListener("touchend", (e) => end(true, e.timeStamp));
  sheet.addEventListener("touchcancel", (e) => end(false, e.timeStamp));
}
