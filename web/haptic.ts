// 휴대폰에서 누른 손끝에 짧게 울려 준다. 웹은 navigator.vibrate 하나뿐이라(iOS Safari 는 없다) 시스템 햅틱처럼 또각이지
// 않고 모터를 잠깐 돌린다 — 그래서 아무 단추에나 달지 않고, 화면을 보지 않고 누르는 키 패드와 '받았습니다' 확인에만 둔다.
// 한 번에 10ms 남짓이라 배터리는 화면에 비하면 셀 수도 없다.

/** 키 하나를 누를 때(ms). 너무 짧으면 기기에 따라 모터가 돌다 만다. */
const TAP_MS = 12;
/** 보낸 지시가 닿았을 때 — 두 번 톡톡. */
const CONFIRM: number[] = [12, 70, 12];

function buzz(pattern: number | number[]): void {
  // 한 번도 누른 적 없는 페이지에서 부르면 Chrome 이 막고 콘솔에 경고를 남긴다. 숨은 페이지에서는 저절로 무시된다.
  if (typeof navigator.vibrate !== "function" || navigator.userActivation?.hasBeenActive === false) return;
  navigator.vibrate(pattern);
}

/**
 * 키 단추에 손이 닿는 순간 울린다. 떼는 순간(click)이면 시스템 자판보다 한 박자 늦게 느껴진다. 마우스·펜에는 울리지 않는다.
 */
export function tapOnPress(btn: HTMLElement): void {
  btn.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "touch" && !(btn as HTMLButtonElement).disabled) buzz(TAP_MS);
  });
}

export function buzzConfirm(): void {
  buzz(CONFIRM);
}
