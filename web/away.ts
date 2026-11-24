// 휴대폰에서 앱이 가려졌다 돌아온 것을 서버에 알린다 — 그사이에 앱이 내려갔는지(문서를 새로 읽었는지) 세려는 것이다.
// 가려질 때 표식을 적고, 같은 문서로 돌아오면 지운다. 새 문서가 그 표식을 보면 가려진 사이에 앞 문서가 사라진 것이다.
import { post } from "./api.ts";
import { store, stored } from "./dom.ts";

const MARK = "agent-world.away";
/** 이보다 짧게 가려졌다 살아 돌아온 것은 적지 않는다. */
const BRIEF_MS = 60_000;
const touchDevice = matchMedia("(pointer: coarse)");

function back(kind: "alive" | "reloaded"): void {
  const at = Number(stored(MARK));
  if (!at) return;
  store(MARK, null);
  // 잠깐 다른 앱을 본 것까지 적으면 살아 돌아온 횟수만 부푼다 — 앱이 내려가는 것은 한참 가려진 뒤다.
  if (kind === "alive" && Date.now() - at < BRIEF_MS) return;
  const nav = (performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined)?.type ?? "";
  const discarded = (document as Document & { wasDiscarded?: boolean }).wasDiscarded === true;
  void post("/api/away", { back: kind, awayMs: Date.now() - at, discarded, nav }).catch(() => undefined);
}

back("reloaded");
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") back("alive");
  else if (touchDevice.matches) store(MARK, String(Date.now()));
});
