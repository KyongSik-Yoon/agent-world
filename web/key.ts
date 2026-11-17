// 접속 열쇠. 서버의 모든 /api 요청은 이 열쇠를 가져가야 한다(server/key.ts).
//
// 브라우저는 열쇠가 붙은 주소(`…/#k=열쇠`)로 한 번 열면 기억한다. 열쇠는 # 뒤에 실려 와서 서버 기록에도, 다른 사이트로
// 가는 Referer 에도 남지 않고, 받자마자 주소에서 지운다. 기억하는 곳은 이 출처(주소와 포트)에만 열리는 localStorage 다 —
// 쿠키는 포트를 가리지 않아 같은 PC 의 다른 서버에도 실려 가므로 쓰지 않는다.
const STORE = "agent-world.key";

function fromAddress(): string | null {
  const m = /(?:^#|&)k=([0-9a-f]{32,})/.exec(location.hash);
  if (!m) return null;
  // 주소창과 방문 기록에 열쇠가 남지 않게 지운다.
  history.replaceState(null, "", location.pathname + location.search);
  return m[1]!;
}

function remembered(): string | null {
  try {
    return localStorage.getItem(STORE);
  } catch {
    return null;
  }
}

function remember(key: string): void {
  try {
    localStorage.setItem(STORE, key);
  } catch {
    // 기억하지 못해도 이번 한 번은 쓴다.
  }
}

const given = fromAddress();
if (given) remember(given);

// 이미 열려 있는 탭에서 열쇠 붙은 주소로 옮겨 오면 문서를 새로 읽지 않고 # 뒤만 바뀐다. 그때도 받아서 다시 읽는다.
window.addEventListener("hashchange", () => {
  const late = fromAddress();
  if (!late) return;
  remember(late);
  location.reload();
});

/** 지금 가진 열쇠. 없으면 빈 문자열. */
export let key: string = given ?? remembered() ?? "";

/** 손으로 붙여 넣은 열쇠(또는 열쇠가 든 주소)를 받아 기억한다. 열쇠 모양이 아니면 false. */
export function acceptKey(pasted: string): boolean {
  const m = /([0-9a-f]{32,})\s*$/.exec(pasted.trim());
  if (!m) return false;
  key = m[1]!;
  remember(key);
  return true;
}

/** EventSource 는 머리말을 달 수 없다 — 주소에 열쇠를 싣는다. */
export function withKey(url: string): string {
  return `${url}${url.includes("?") ? "&" : "?"}k=${key}`;
}
