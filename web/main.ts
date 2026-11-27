// 들머리: 서버의 스냅샷 흐름을 받아 장면과 HUD 에 나눠 주고, 둘 사이의 고르기·필터·단축키를 잇는다.
import "./fonts.ts";
import "./away.ts";
import type { AgentStatus, AgentView, SnapshotPatch, WorldSnapshot } from "../shared/types.ts";
import { get, post, hasAccess, headers, serverBuild } from "./api.ts";
import { Builder } from "./build.ts";
import { type Action, workspaceKey } from "./detail.ts";
import { STATUS_VAR, h, icon, store, stored } from "./dom.ts";
import { STATUS_LABEL, bubbleText, needsAttention } from "./format.ts";
import { Hud } from "./hud.ts";
import { lang, localizeStatic, t, setLang } from "./i18n.ts";
import { acceptKey, key, withKey } from "./key.ts";
import { setSolo } from "./beat.ts";
import { setRosterVisible } from "./logos.ts";
import { swipeToClose } from "./sheet.ts";
import { PlanReader } from "./plan.ts";
import { askForInput, askOnFirstTouch, reportPresence } from "./presence.ts";
import { ReviewReader } from "./review.ts";
import { TermOverlay, loadTermTheme } from "./term.ts";
import type { Theme } from "./world/environment.ts";
import { WorldScene } from "./world/scene.ts";
import { version } from "../package.json";

// index.html 에 적힌 글을 지금 말로 — HUD 와 장면을 짓기 전에 한 번.
localizeStatic();
// 설치한 판. 페이지는 서버가 같은 트리에서 빌드하므로 서버의 판과 같다.
document.getElementById("app-version")!.textContent = `Agent World v${version}`;

// 아래 도움말 줄. 글이 <kbd> 로 쪼개져 있어 조각마다 풀 수 없으니, 줄 전체를 t() 문장들로 짓는다.
{
  const kbd = (key: string) => h("kbd", {}, key);
  const items: Array<Array<Node | string>> = [
    [t("드래그 회전")],
    [kbd("Space"), "+", t("드래그 이동")],
    [t("휠 확대")],
    [kbd("H"), " ", t("처음 화면")],
    [kbd("N"), " ", t("다음 확인")],
    [kbd("C"), " ", t("말 걸기")],
    [kbd("`"), " ", t("터미널")],
    [kbd("D"), " ", t("확인 완료")],
    [kbd("B"), " ", t("집 짓기")],
    [kbd("Enter"), " ", t("herdr 로")],
    [kbd("Esc"), " ", t("닫기")],
  ];
  const help = document.getElementById("help")!;
  items.forEach((item, i) => help.append(...(i > 0 ? [" · "] : []), ...item));
}

let selectedId: string | null = null;

const scene = new WorldScene(document.getElementById("world")!, {
  onSelect: (id) => select(id),
  onHover: (id) => hud.setHover(id),
  onPlot: (workspaceId) => select(workspaceKey(workspaceId)),
});

const hud = new Hud({
  onSelect: (id, gone) => select(id, !gone),
  onHover: (id) => {
    scene.setExternalHover(id);
    hud.setHover(id);
  },
  onFilter: (pass) => scene.setFilter(pass),
  onAction: (action) => act(action),
});

const terminal = new TermOverlay();
// 새로고침·탭 닫기로 크게 보기가 끝나거나, 휴대폰에서 앱을 내리고 화면을 꺼도 넘겨 둔 앱 화면은 돌려 둔다.
addEventListener("pagehide", () => terminal.pageHide());
document.addEventListener("visibilitychange", () => document.visibilityState === "hidden" && terminal.pageHide());
terminal.onError = (message) => hud.toast(t("입력을 보내지 못했습니다"), message, "var(--blocked)");
terminal.onGone = (title) => hud.toast(t("터미널을 닫았습니다"), t("{title} — 이 pane 이 herdr 에서 닫혔습니다.", { title }), "var(--idle)");
terminal.onToggle = (open) => {
  syncCovered();
  hud.setCovered(open);
  // 덮인 화면의 애니메이션(일하는 로고, 이름표의 깜빡임)을 멈춘다 — 보이지 않는 움직임이 합성을 초당 수십 장 붙든다.
  document.body.toggleAttribute("data-covered", open);
  syncBack();
};

// 승인을 기다리는 플랜을 읽는 창. 크게 보기 위에 뜨고, 닫히면 입력을 다시 터미널로 돌린다.
const planReader = new PlanReader();
planReader.onClose = () => terminal.focus();
planReader.canApprove = () => hud.latest?.control === true;
planReader.onApprove = (a) => approvePlan(a);
planReader.onRevise = async (a, card, text) => {
  await post("/api/plan/revise", { paneId: a.paneId ?? "", card, text });
  hud.toast(t("고칠 점을 보냈습니다"), a.title, "var(--accent)");
};
planReader.onLost = (a, message, text) =>
  hud.toast(t("고칠 점이 전해지지 않았습니다"), `${t("적은 것은 다음 플랜 카드에 남겨 두었습니다. 누르면 복사합니다.")} ${message}`, "var(--blocked)", () =>
    navigator.clipboard.writeText(text).then(
      () => hud.toast(t("복사했습니다"), t("고칠 점"), "var(--accent)"),
      () => hud.toast(t("복사하지 못했습니다"), t("고칠 점"), "var(--blocked)"),
    ),
    true,
  );
terminal.onPlan = (paneId) => {
  const agent = hud.latest?.agents.find((a) => a.paneId === paneId);
  if (agent) planReader.open(agent);
};

// AGY 의 글에 대한 답은 평범한 지시다. 실패는 창이 제 안에 적고, 닿았으면 창이 닫히므로 토스트로 알린다.
planReader.onArtifactSend = async (a, text, approve) => {
  if (!a.paneId) throw new Error(t("이 세션은 herdr 밖에서 돌아 지시를 보낼 pane 이 없습니다."));
  await post("/api/prompt", { paneId: a.paneId, text });
  hud.toast(approve ? t("승인을 보냈습니다") : t("고칠 점을 보냈습니다"), a.title, "var(--accent)");
};

// 마지막 턴의 리뷰 보고를 읽고 고칠 항목을 골라 보내는 창.
const reviewReader = new ReviewReader();
reviewReader.canSend = () => hud.latest?.control === true;
// 실패는 리뷰 창이 제 안에 적는다(토스트는 모달 창 뒤에 깔린다). 보냈으면 창이 닫히므로 토스트로 알린다.
reviewReader.onSend = async (a, text) => {
  if (!a.paneId) throw new Error(t("이 세션은 herdr 밖에서 돌아 지시를 보낼 pane 이 없습니다."));
  await post("/api/prompt", { paneId: a.paneId, text });
  hud.toast(t("고칠 항목을 보냈습니다"), a.title, "var(--accent)");
};

// 응답 글 안 코드 블록의 복사 단추(dom.ts 의 prose). 상태 창·플랜·리뷰 어디에 그려졌든 여기서 받는다.
document.addEventListener("click", (e) => {
  const btn = e.target instanceof Element ? e.target.closest(".code-copy") : null;
  const code = btn?.parentElement?.querySelector("pre > code")?.textContent;
  if (!btn || code == null) return;
  navigator.clipboard.writeText(code).then(
    () => hud.toast(t("복사했습니다"), t("코드"), "var(--accent)"),
    () => hud.toast(t("복사하지 못했습니다"), t("코드"), "var(--blocked)"),
  );
});

const builder = new Builder({
  snapshot: () => hud.latest,
  select: (id) => select(id),
  toast: (title, text, color) => hud.toast(title, text, color),
  draft: (paneId, text) => hud.setDraft(paneId, text),
});

/** 휴대폰에서 목록 서랍을 펴 둔 채 골라 들어왔다 — 뒤로 가기로 상태 창을 닫으면 그 목록으로 돌아간다. */
let cameFromRoster = false;

/** fly 가 false 면 고르기만 바꾸고 카메라는 보던 자리에 둔다. */
function select(id: string | null, fly = true): void {
  // 상태 창이 열려 있는 동안에는 지우지 않는다 — 목록에서 들어온 뒤 알림을 눌러 다른 세션으로 옮겨 가도 돌아갈 곳은 목록이다.
  if (id === null) cameFromRoster = false;
  else if (document.body.dataset.roster === "open" && phoneLayout.matches) cameFromRoster = true;
  // 이미 고른 캐릭터를 다시 고르면, 다른 데를 보고 있었을 때 그 자리를 다시 비춘다(장면이 판단한다).
  // 좁은 화면에서는 목록이 마을이나 상태 창을 덮고 있으므로, 고르면 접는다. 지금 보던 것을 다시 골라도 접는다.
  if (id) setRoster(false);
  if (id === selectedId) {
    if (id) scene.select(id);
    return;
  }
  selectedId = id;
  scene.select(id, fly);
  hud.select(id);
  syncBack();
}

/** 완료를 확인했다고 적는다(또는 되돌린다). herdr 의 초점은 건드리지 않고 월드 서버가 기억한다. */
function markSeen(a: AgentView, undo: boolean): void {
  if (!a.paneId || !hud.latest?.control) return;
  const paneId = a.paneId;
  void post<{ seen?: boolean }>("/api/seen", { paneId, undo })
    .then((res) => {
      if (!undo && res.seen) hud.undoToast(t("확인 처리했습니다"), a.title, () => markSeen(a, true));
    })
    .catch((e: Error) => hud.toast(t("확인 처리 실패"), e.message, "var(--blocked)"));
}

/** 승인을 보내는 중인 pane — 두 번 누른 것은 한 번만 보낸다. */
const approving = new Set<string>();

/** 플랜 승인 카드의 Approve and start 를 누른다. 서버가 카드가 아직 떠 있는지 보고 보낸 뒤 카드가 내려가는 것까지 확인한다. */
function approvePlan(a: AgentView): void {
  if (!a.paneId || !hud.latest?.control || approving.has(a.paneId)) return;
  const paneId = a.paneId;
  approving.add(paneId);
  void post("/api/plan/approve", { paneId })
    .then(() => hud.toast(t("플랜을 승인했습니다"), a.title, "var(--accent)"))
    .catch((e: Error) => hud.toast(t("플랜을 승인하지 못했습니다"), e.message, "var(--blocked)"))
    .finally(() => approving.delete(paneId));
}

function openTerminal(paneId: string): void {
  const snap = hud.latest;
  const pane = snap?.panes.find((p) => p.id === paneId);
  const agent = snap?.agents.find((a) => a.paneId === paneId);
  const ws = snap?.workspaces.find((w) => w.id === pane?.workspaceId);
  terminal.open(paneId, agent?.title ?? pane?.label ?? pane?.title ?? paneId, `${ws ? `${ws.number} · ${ws.label} · ` : ""}${paneId}`, pane?.cols, pane?.rows);
  terminal.setPlan(agent !== undefined && hasReading(agent));
}

/** 크게 보기의 플랜 읽기 단추를 둘 글: 승인 카드의 플랜, 또는 아직 답하지 않은(보고서면 다음 지시가 가지 않은) AGY 의 글. */
function hasReading(a: AgentView): boolean {
  return a.plan !== undefined || (a.artifact !== undefined && !a.artifactAnswered);
}

function act(action: Action): void {
  switch (action.type) {
    case "select":
      select(action.id);
      break;
    case "open-herdr":
      void openInHerdr(action.agent);
      break;
    case "roster":
      setRoster(true);
      break;
    case "terminal":
      openTerminal(action.paneId);
      break;
    case "plan":
      planReader.open(action.agent, "plan");
      break;
    case "artifact":
      planReader.open(action.agent, "artifact");
      break;
    case "review":
      reviewReader.open(action.agent);
      break;
    case "approve-plan":
      approvePlan(action.agent);
      break;
    case "new-agent":
      builder.newAgent(action.workspaceId, action.paneId);
      break;
    case "new-tab":
      void builder.newTab(action.workspaceId);
      break;
    case "new-worktree":
      builder.newHouse(action.workspace);
      break;
    case "split":
      void builder.split(action.paneId, action.direction);
      break;
    case "rename":
      builder.rename(action.kind, action.id, action.current, action.what);
      break;
    case "model":
      builder.switchModel(action.agent);
      break;
    case "close":
      builder.close(action.kind, action.id);
      break;
    case "seen": {
      const a = hud.latest?.agents.find((x) => x.paneId === action.paneId);
      if (a) markSeen(a, action.undo);
      break;
    }
  }
}

async function openInHerdr(a: AgentView): Promise<void> {
  if (!a.paneId || !hud.latest?.control) return;
  try {
    const res = await fetch("/api/focus", { method: "POST", headers: { "content-type": "application/json", ...headers() }, body: JSON.stringify({ paneId: a.paneId }) });
    const data = (await res.json()) as { ok?: boolean; raised?: boolean; error?: string };
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    hud.toast(t("herdr 로 이동"), data.raised ? t("{title} — 터미널 창을 앞으로 가져왔습니다.", { title: a.title }) : t("{title} — herdr 화면을 이 pane 으로 옮겼습니다.", { title: a.title }), "var(--accent)");
  } catch (e) {
    hud.toast(t("이동 실패"), (e as Error).message, "var(--blocked)");
  }
}

function nextAttention(): void {
  const list = hud.attention();
  if (list.length === 0) {
    hud.toast(t("확인할 에이전트가 없습니다"), t("완료했거나 입력을 기다리는 에이전트가 생기면 여기로 데려다 드립니다."), "var(--idle)");
    return;
  }
  const at = list.findIndex((a) => a.id === selectedId);
  select(list[(at + 1) % list.length]!.id);
}

// ── 낮/밤 ────────────────────────────────────────────────────────────────────────────────────

// 말 바꾸기: 단추에는 바꿔 갈 말을 적는다(한국어 화면에서는 EN, 영어 화면에서는 한).
const langBtn = document.getElementById("btn-lang")!;
langBtn.textContent = lang === "ko" ? "EN" : "한";
langBtn.title = lang === "ko" ? "Switch to English" : "한국어로 바꾸기";
langBtn.addEventListener("click", () => setLang(lang === "ko" ? "en" : "ko"));

const themeBtn = document.getElementById("btn-theme")!;
/** 문서에 적힌 매니페스트(낮 색). 낮으로 고른 때가 아니면 색만 다른 밤 것으로 바꿔 가리킨다 — 설치한 앱이 페이지 밖에 칠하는 색을 위해서다. */
const manifestLink = document.querySelector<HTMLLinkElement>('link[rel="manifest"]');
const dayManifest = manifestLink?.getAttribute("href") ?? "";

/** 테마를 어떻게 정할지. auto 는 기기의 라이트/다크를 따라가고(기기가 시간에 맞춰 바꾸면 같이 바뀐다), 나머지는 그 테마에 붙박는다. */
type ThemeMode = "auto" | Theme;
const MODES: ThemeMode[] = ["auto", "day", "night"];
const systemDark = matchMedia("(prefers-color-scheme: dark)");
let themeMode: ThemeMode = MODES.find((m) => m === stored("agent-world.theme-mode")) ?? "auto";
// 예전에는 처음 연 날의 테마를 그대로 적어 두었다(고른 것이 아니다). 이제 쓰지 않는다.
store("agent-world.theme", null);

function applyTheme(): void {
  const theme: Theme = themeMode === "auto" ? (systemDark.matches ? "night" : "day") : themeMode;
  document.body.dataset.theme = theme;
  // 설치한 앱(안드로이드)은 자판이 올라올 때 화면과 자판 사이의 틈을 매니페스트의 색으로 칠하는데, 그 색은 하루에 한 번쯤만
  // 갱신된다. 기기를 따라 하루에 두 번 바뀌는 테마는 쫓아갈 수 없으니, auto 에서는 밤 색에 붙박는다 — 어두운 화면에서
  // 밝은 틈이 번쩍이는 쪽이 더 거슬린다. 낮으로 고른 때만 낮 색이다.
  manifestLink?.setAttribute("href", themeMode === "day" ? dayManifest : "./manifest-night.webmanifest");
  scene.setTheme(theme);
  themeBtn.replaceChildren(icon(themeMode === "auto" ? "auto" : themeMode === "day" ? "sun" : "moon"));
  const label = themeMode === "auto" ? t("테마: 기기를 따름 (T)") : themeMode === "day" ? t("테마: 낮 (T)") : t("테마: 밤 (T)");
  themeBtn.title = label;
  themeBtn.setAttribute("aria-label", label);
  // 앱으로 설치했을 때 기기의 상태 표시줄이 하늘과 이어지게.
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme === "day" ? "#7cc4f1" : "#080c1f");
}

applyTheme();
systemDark.addEventListener("change", () => {
  if (themeMode === "auto") applyTheme();
});
// 단추는 기기를 따름 → 낮 → 밤 차례로 돈다. 기기를 따르는 동안에는 눌러도 화면이 그대로일 수 있어, 무엇이 됐는지 알려 준다.
themeBtn.addEventListener("click", () => {
  themeMode = MODES[(MODES.indexOf(themeMode) + 1) % MODES.length]!;
  store("agent-world.theme-mode", themeMode);
  applyTheme();
  const name = themeMode === "auto" ? t("기기를 따름") : themeMode === "day" ? t("낮") : t("밤");
  hud.toast(t("테마"), themeMode === "auto" ? t("{name} — 기기가 라이트/다크를 바꾸면 같이 바뀝니다.", { name }) : name, "var(--accent)");
});

// ── 알림 ─────────────────────────────────────────────────────────────────────────────────────

const notifyBtn = document.getElementById("btn-notify")!;
/** 화면을 닫아 둔 동안에도 알림을 받는 길(Web Push)이 이 브라우저에 있는지. iOS 는 홈 화면에 설치한 앱에만 있다. */
const pushable = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
let notify = stored("agent-world.notify") === "on" && "Notification" in window && Notification.permission === "granted";
/** 서버에 푸시 구독을 맡겼다 — 화면이 가려진 동안의 알림은 서버가 보내므로 화면은 따로 띄우지 않는다. */
let pushed = false;
notifyBtn.setAttribute("aria-pressed", String(notify));

/** 서비스 워커를 깔고 이 브라우저의 구독을 서버에 맡긴다. 알림을 켠 브라우저만 여기까지 온다. */
async function subscribePush(): Promise<boolean> {
  if (!pushable) return false;
  try {
    const reg = await navigator.serviceWorker.register("/sw.js");
    await navigator.serviceWorker.ready;
    const { key } = await get<{ key: string }>("/api/push/key");
    let sub = await reg.pushManager.getSubscription();
    // 구독은 서버의 열쇠에 묶인다. 열쇠가 바뀌었으면 옛 구독으로는 받지 못하니 새로 맺는다.
    const boundTo = sub?.options.applicationServerKey;
    if (sub && (!boundTo || toBase64Url(new Uint8Array(boundTo)) !== key)) {
      await sub.unsubscribe();
      sub = null;
    }
    sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: fromBase64Url(key) });
    await post("/api/push", { subscription: sub.toJSON() as Record<string, unknown> });
    // 그사이 알림을 껐으면(열자마자 다시 맞추는 중에 🔔 을 누름) 자리는 알리지 않는다.
    if (notify) reportPresence(sub.endpoint);
    return true;
  } catch {
    // 구독하지 못하면 화면이 열려 있는 동안의 알림만 남는다.
    return false;
  }
}

/** 구독을 브라우저와 서버 양쪽에서 지운다. */
async function unsubscribePush(): Promise<void> {
  if (!pushable) return;
  reportPresence(null);
  try {
    const reg = await navigator.serviceWorker.getRegistration("/");
    const sub = await reg?.pushManager.getSubscription();
    if (!sub) return;
    await sub.unsubscribe();
    await post("/api/push", { off: sub.endpoint });
  } catch {
    // 서버에 닿지 못해도 브라우저 쪽 구독은 지워졌다 — 서버는 다음에 보내다 거절당하면 스스로 지운다.
  }
}

function toBase64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const raw = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

notifyBtn.addEventListener("click", async () => {
  // PC 를 쓰는 동안 휴대폰으로 알림을 넘기지 않으려면 기기의 입력을 볼 권한이 필요하다. 누른 순간에만 물을 수 있다.
  if (!notify) void askForInput();
  if (!notify && "Notification" in window) {
    const permission = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
    notify = permission === "granted";
    if (!notify) hud.toast(t("알림이 막혀 있습니다"), t("브라우저의 사이트 설정에서 알림을 허용해 주세요."), "var(--blocked)");
  } else {
    // 알림이 아예 없는 브라우저다. iOS 는 홈 화면에 설치한 앱에서만 알림을 쓸 수 있다.
    if (!notify) hud.toast(t("이 브라우저는 알림을 쓸 수 없습니다"), t("iOS 는 홈 화면에 앱으로 설치한 뒤에 켤 수 있습니다."), "var(--blocked)");
    notify = false;
  }
  notifyBtn.setAttribute("aria-pressed", String(notify));
  store("agent-world.notify", notify ? "on" : "off");
  if (notify) {
    pushed = await subscribePush();
    // 켜진 것처럼 보이는데 앱을 내리면 오지 않는 일이 없게, 반쪽만 켜졌으면 그렇다고 알린다.
    if (!pushed) hud.toast(t("화면이 열려 있는 동안에만 알립니다"), t("이 브라우저에서는 닫아 둔 동안의 알림을 켜지 못했습니다."), "var(--idle)");
  } else {
    pushed = false;
    await unsubscribePush();
  }
});
// 켜 둔 브라우저는 열 때마다 구독을 다시 맞춘다(서버가 기록을 잃었거나 브라우저가 구독을 갈았을 수 있다). 화면이 뜬 뒤로 미룬다.
if (notify && pushable) {
  setTimeout(() => void subscribePush().then((ok) => (pushed = ok && notify)), 3000);
  askOnFirstTouch();
}

/** 알림을 눌러 들어왔을 때 고를 에이전트. 스냅샷에 나타나면 고른다. */
let wanted: string | null = null;
function wantedFromAddress(): void {
  const m = /(?:^#|&)a=([^&]+)/.exec(location.hash);
  if (!m) return;
  try {
    wanted = decodeURIComponent(m[1]!);
  } catch {
    // 깨진 주소는 버린다.
  }
  history.replaceState(null, "", location.pathname + location.search);
}
wantedFromAddress();
// 이미 열려 있는 화면이 알림의 주소로 옮겨 오면 문서를 새로 읽지 않고 # 뒤만 바뀐다.
window.addEventListener("hashchange", () => {
  wantedFromAddress();
  if (hud.latest) selectWanted(hud.latest);
});
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.addEventListener("message", (e) => {
    const id = (e.data as { select?: unknown } | null)?.select;
    if (typeof id !== "string" || !id) return;
    wanted = id;
    if (hud.latest) selectWanted(hud.latest);
  });
}
function selectWanted(snapshot: WorldSnapshot): void {
  if (wanted === null || !snapshot.agents.some((a) => a.id === wanted)) return;
  const id = wanted;
  wanted = null;
  select(id);
}

// 휴대폰은 가려진 브라우저를 통째로 내리곤 한다(다른 앱을 2분 쓰는 사이에도). 돌아오면 문서를 처음부터 다시 읽어 마을 첫 화면이
// 뜨므로, 가려지는 순간 보던 자리를 적어 두고 다시 읽힌 문서가 첫 스냅샷에서 그 자리로 돌아간다. 적는 것은 가려질 때 한 번,
// 읽는 것은 문서마다 한 번뿐이다. 앱을 닫았다 새로 연 것(navigate)은 마을에서 시작한다.
const VIEW = "agent-world.view";
type View = { sel: string | null; roster: boolean; fromRoster: boolean; term: string; rosterTop: number; detailTop: number };
function saveView(): void {
  const view: View = {
    sel: selectedId,
    roster: document.body.dataset.roster === "open",
    fromRoster: cameFromRoster,
    term: terminal.isOpen ? terminal.pane : "",
    rosterTop: document.getElementById("roster-list")!.scrollTop,
    detailTop: document.querySelector("#detail .d-body")?.scrollTop ?? 0,
  };
  store(VIEW, JSON.stringify(view));
}
addEventListener("pagehide", saveView);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") saveView();
});
let leftAt: View | null = (() => {
  const raw = stored(VIEW);
  store(VIEW, null);
  const nav = (performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined)?.type;
  // 알림을 눌러 들어왔으면 그 에이전트가 먼저다.
  if (!raw || wanted !== null || (nav !== "back_forward" && nav !== "reload")) return null;
  try {
    return JSON.parse(raw) as View;
  } catch {
    return null;
  }
})();
function restoreView(snapshot: WorldSnapshot): void {
  const view = leftAt;
  leftAt = null;
  if (!view || wanted !== null) return;
  const id = view.sel;
  const alive = typeof id === "string" && (snapshot.agents.some((a) => a.id === id) || snapshot.panes.some((p) => p.id === id) || snapshot.workspaces.some((w) => workspaceKey(w.id) === id));
  if (alive) {
    select(id);
    cameFromRoster = view.fromRoster === true && phoneLayout.matches;
    const body = document.querySelector("#detail .d-body");
    if (body) body.scrollTop = Number(view.detailTop) || 0;
  } else if (view.roster && phoneLayout.matches) {
    setRoster(true);
    document.getElementById("roster-list")!.scrollTop = Number(view.rosterTop) || 0;
  }
  if (view.term && snapshot.panes.some((p) => p.id === view.term)) openTerminal(view.term);
}

const lastStatus = new Map<string, AgentStatus>();
/** 에이전트마다 마지막으로 본 컴팩션 자리(AgentView.compaction). */
const lastCompaction = new Map<string, string | undefined>();
let primed = false;

/** 토스트를 띄우고, 화면이 앞에 있지 않으면 시스템 알림도 낸다. detail: 어느 집인지와 덧붙일 말. */
function notice(a: AgentView, title: string, detail: string, color: string): void {
  hud.toast(title, `${a.title} — ${detail}`, color, () => select(a.id));
  // 서비스 워커와 같은 규칙: 보이고 창이 앞에 있을 때만 토스트로 그친다. 보이기만 하고 앞에 있지 않으면(옆에 띄운 창,
  // 두 번째 모니터) 사람은 다른 앱을 쓰는 중이라 토스트를 못 본다.
  if (notify && !pushed && !(document.visibilityState === "visible" && document.hasFocus())) {
    try {
      const n = new Notification(`${title} · ${a.title}`, { body: detail, tag: a.id });
      n.onclick = () => {
        window.focus();
        select(a.id);
      };
    } catch {
      // 이 방식의 알림을 막아 둔 브라우저(Android Chrome)다.
    }
  }
}

/** 지켜보는 동안 완료나 확인 필요로 바뀐 에이전트를 알린다. 처음 받은 스냅샷은 알리지 않는다. */
function announce(snapshot: WorldSnapshot): void {
  for (const a of snapshot.agents) {
    const before = lastStatus.get(a.id);
    lastStatus.set(a.id, a.status);
    const compactedAt = lastCompaction.get(a.id);
    lastCompaction.set(a.id, a.compaction);
    if (!primed || before === undefined) continue;
    const where = a.workspaceNumber ? `${a.workspaceNumber} · ${a.workspaceLabel}` : a.workspaceLabel;
    // 사람이 친 `/compact` 가 끝났다. 그 끝은 완료로 알리지 않으므로(compacted) 따로 알린다 — 기다리던 사람이 이어서 지시하게.
    if (a.compaction !== undefined && a.compaction !== compactedAt) notice(a, t("대화를 요약했습니다"), where, "var(--accent)");
    if (before === a.status || !needsAttention(a.status) || a.compacted) continue;
    // 확인 필요면 무엇을 기다리는지까지 알린다.
    const what = a.status === "blocked" && a.pending ? ` — ${bubbleText(a) ?? ""}` : "";
    notice(a, STATUS_LABEL[a.status], `${where}${what}`, STATUS_VAR[a.status]);
  }
  const alive = new Set(snapshot.agents.map((a) => a.id));
  for (const id of lastStatus.keys()) if (!alive.has(id)) lastStatus.delete(id);
  for (const id of lastCompaction.keys()) if (!alive.has(id)) lastCompaction.delete(id);
  primed = true;
}

// ── 스냅샷 흐름 ──────────────────────────────────────────────────────────────────────────────

/** 다시 붙기를 직접 시도할 때의 간격(ms). 실패가 이어지면 조금씩 늘린다. */
let retryMs = 1000;

function show(snapshot: WorldSnapshot): void {
  // 이름 붙은 herdr 세션이면 그 이름을 함께 보여 준다 — 세션마다 띄운 화면이 여럿일 때 어느 것인지 알 수 있게.
  const session = snapshot.session ? ` (${snapshot.session})` : "";
  if (snapshot.herdr) hud.setConnection("live", t("herdr{session} 연결됨 · 에이전트 {n}", { session, n: snapshot.agents.length }), snapshot.session ? t("herdr 세션 {name}", { name: snapshot.session }) : "");
  else hud.setConnection("logs", t("herdr 없음 — 로그만으로 표시 · {n}", { n: snapshot.agents.length }), snapshot.herdrError?.[lang] ?? "");
  announce(snapshot);
  scene.sync(snapshot);
  hud.update(snapshot);
  if (terminal.isOpen) {
    terminal.setPlan(snapshot.agents.some((a) => a.paneId === terminal.pane && hasReading(a)));
    // 보는 동안 pane 크기가 바뀌면(herdr 창을 나누거나 터미널 창을 키우면) 글자 크기를 다시 맞춘다.
    const pane = snapshot.panes.find((p) => p.id === terminal.pane);
    terminal.resize(pane?.cols, pane?.rows);
  }
  planReader.sync(snapshot.agents);
  reviewReader.sync(snapshot.agents);
  builder.observe(snapshot);
  restoreView(snapshot);
  selectWanted(snapshot);
  buildBtn.hidden = !snapshot.herdr || !snapshot.control;
}

/** 이 문서를 받았을 때의 서버 화면 판. */
let loadedBuild: string | undefined;
/** 연결이 한 번 끊겼다 — 다시 붙으면 서버가 새 판으로 바뀌었는지 본다. */
let dropped = false;

/**
 * 서버가 새 화면으로 다시 떴으면 이 문서도 새로 읽는다. 앱으로 설치해 쓰면 새로 읽을 단추가 없어, 그대로 두면
 * 앱을 완전히 닫았다 열 때까지 옛 화면이 남는다. 무언가 쓰거나 열어 둔 동안에는 기다린다.
 */
async function reloadIfUpdated(): Promise<void> {
  const now = await serverBuild();
  if (!now || !loadedBuild || now === loadedBuild) return;
  const busy = (): boolean =>
    terminal.isOpen ||
    // 가운데 화면에서 치는 중이다 — 그 입력란은 늘 비어 있어 아래의 글 검사에 걸리지 않는다.
    document.querySelector("#stage.typing") !== null ||
    document.querySelector("dialog[open]") !== null ||
    [...document.querySelectorAll("textarea")].some((el) => el.value.trim() !== "");
  const tryReload = (): void => {
    if (busy()) setTimeout(tryReload, 5000);
    else location.reload();
  };
  tryReload();
}

/** 지금 열려 있는 상태 연결. 닫아 둔 동안에는 없다. */
let stream: EventSource | undefined;
let retryTimer: ReturnType<typeof setTimeout> | undefined;

function connect(): void {
  clearTimeout(retryTimer);
  stream?.close();
  const events = new EventSource(withKey("/api/events"));
  stream = events;
  /** 이 연결로 받은 최신 상태. 서버는 전체를 한 번 보낸 뒤로 달라진 것만 보낸다. */
  let current: WorldSnapshot | undefined;
  events.onmessage = (e) => {
    retryMs = 1000;
    if (dropped) {
      dropped = false;
      void reloadIfUpdated();
    }
    current = JSON.parse(e.data as string) as WorldSnapshot;
    show(current);
  };
  events.addEventListener("patch", (e) => {
    if (!current) return;
    const { order, agents, ...rest } = JSON.parse((e as MessageEvent<string>).data) as SnapshotPatch;
    const byId = new Map(current.agents.map((a) => [a.id, a]));
    for (const a of agents) byId.set(a.id, a);
    current = { ...current, ...rest, agents: order.map((id) => byId.get(id)).filter((a): a is AgentView => a !== undefined) };
    show(current);
  });
  events.onerror = () => {
    dropped = true;
    hud.setConnection("down", t("서버와 끊김 — 다시 연결 중…"));
    // 연결이 그냥 끊긴 것이면 EventSource 가 스스로 다시 붙는다. 하지만 오류 응답을 받으면(서버가 꺼진 동안
    // 앞단 프록시가 502 를 돌려줄 때) 영영 포기하므로, 그때는 직접 새로 연다.
    if (events.readyState !== EventSource.CLOSED || stream !== events) return;
    events.close();
    retryTimer = setTimeout(connect, retryMs);
    retryMs = Math.min(retryMs * 1.6, 8000);
  };
}

/** 화면이 가려져 연결을 닫아 두었다. */
let parked = false;

// 닫아 둔 동안의 알림(푸시)을 켠 기기는 화면이 가려지면 연결을 닫는다. 열어 두면 주머니 속 휴대폰이 15초마다
// 깨어나고, 서버는 보는 사람이 있는 줄 알고 1초마다 상태를 만든다. 푸시가 없는 탭은 이 연결로 알림을 띄우므로 둔다.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    if (!pushed || !stream) return;
    clearTimeout(retryTimer);
    stream.close();
    stream = undefined;
    parked = true;
    return;
  }
  if (!parked) return;
  parked = false;
  // 가려진 동안 바뀐 것은 푸시가 이미 알렸다 — 돌아와서 한꺼번에 다시 알리지 않는다. 서버가 그사이 새 판이 됐는지도 본다.
  primed = false;
  dropped = true;
  connect();
});

// 전체 보기로: 서버에 전체 보기의 주소가 설정돼 있을 때만 보인다(이 서버가 중계를 겸하거나, AGENT_WORLD_ALL).
// 다른 PC 의 전체 보기로 갈 때는 이 월드의 열쇠를 주소 뒤(#)에 실어 간다 — 그 화면이 이 월드를 열쇠 입력 없이 연다.
// 주소는 서버 설정에서만 온다. 링크로 받은 주소로 열쇠를 보내지 않는다.
const allBtn = document.getElementById("btn-all")!;
void fetch("/api/identity", { headers: headers() })
  .then((res) => (res.ok ? (res.json() as Promise<{ all?: string; origins?: string[] }>) : undefined))
  .then((identity) => {
    const all = identity?.all;
    if (!all) return;
    allBtn.hidden = false;
    allBtn.addEventListener("click", () => {
      const to = new URL(all, location.href);
      // 전체 보기는 이 월드를 제 설정에 적힌 주소로 안다. 지금 열린 주소와 다를 수 있어, 이 서버가 불리는 주소를 다 보낸다.
      const mine = [...new Set([location.origin, ...(identity?.origins ?? [])])];
      if (to.origin !== location.origin) to.hash = `w=${encodeURIComponent(mine.join(","))}&wk=${key}`;
      location.href = to.href;
    });
  })
  .catch(() => {});

const buildBtn = document.getElementById("btn-build")!;

const phoneLayout = matchMedia("(max-width: 760px)");

// 좁은 화면(휴대폰)에서는 목록을 접어 두고 여닫는다. 넓은 화면에서는 늘 보인다.
// 여닫는 단추는 아래 막대의 상태 숫자 묶음이다 — 숫자를 보고 누르면 그 순서(확인 필요·완료·작업 중·대기)로 묶인 목록이 올라온다.
// 넓은 화면에서 그 숫자들은 상태별로 거르는 단추인데, 휴대폰에서는 칸 하나가 손가락으로 집기에 작아 묶음째 단추 하나로 쓴다.
const chipsEl = document.getElementById("chips")!;
const rosterEl = document.getElementById("roster")!;
/**
 * 목록 서랍을 여닫는다. still 이면 아래에서 올라오지 않고 그 자리에 바로 선다 — 상태 창에서 뒤로 가기로 돌아올 때는
 * 방금 보던 목록으로 되돌아가는 것이라, 처음 펼 때처럼 올라오면 멀미만 나고 장면 프레임만 더 쓴다.
 */
function setRoster(open: boolean, still = false): void {
  rosterEl.toggleAttribute("data-still", open && still);
  document.body.dataset.roster = open ? "open" : "closed";
  if (chipsEl.hasAttribute("aria-expanded")) chipsEl.setAttribute("aria-expanded", String(open));
  setRosterVisible(!phoneLayout.matches || open);
  syncBack();
}
const toggleRoster = (): void => setRoster(document.body.dataset.roster !== "open");
// 칸의 거르기보다 먼저 받아(capture) 묶음의 누름으로 삼는다.
chipsEl.addEventListener(
  "click",
  (e) => {
    if (!phoneLayout.matches) return;
    e.stopPropagation();
    toggleRoster();
  },
  true,
);
chipsEl.addEventListener("keydown", (e) => {
  if (!phoneLayout.matches || e.target !== chipsEl || (e.key !== "Enter" && e.key !== " ")) return;
  e.preventDefault();
  toggleRoster();
});
// 휴대폰의 서랍은 아래로 끌어내려도 닫힌다.
swipeToClose(
  rosterEl,
  document.getElementById("roster-list")!,
  () => document.body.dataset.roster === "open" && phoneLayout.matches,
  () => setRoster(false),
);
// 상태 창 위로 꺼낸 목록은 뒤의 어두운 막(상태 창의 ::after)을 누르면 닫힌다. 막을 누른 손가락은 상태 창 안의 단추에 닿지 않는다.
document.getElementById("detail")!.addEventListener("click", (e) => {
  if (document.body.dataset.roster === "open" && e.target === e.currentTarget) setRoster(false);
});

// ── 뒤로 가기 ──────────────────────────────────────────────────────────────────────────────
// 휴대폰의 뒤로 가기(몸짓·단추)는 앱을 벗어나는 대신 맨 위에 열린 것 하나를 닫는다: 대화상자 → 크게 보기 → 목록 서랍 →
// 상태 창. 열린 것이 하나라도 있는 동안 방문 기록에 지킴 칸을 하나 얹어 두고, 뒤로 가기가 그 칸을 빼면 하나를 닫은 뒤
// 남은 것이 있으면 다시 얹는다. 단추로 다 닫았으면 얹어 둔 칸을 스스로 걷어, 다음 뒤로 가기가 헛돌지 않게 한다.
// 닫을 수 없는 대화상자(열쇠 묻기, data-stay)는 세지 않는다 — 뒤로 가기에 갇히지 않고 앱을 떠날 수 있게.
// 목록 서랍에서 골라 들어온 상태 창은 뒤로 가기로 닫으면 그 목록이 다시 올라온다(닫기 단추·홈·Esc 는 마을로 간다).
const BACK_GUARD = "agent-world.back";
/** 가운데 무대를 세우려면 두 창 사이와 창 높이가 이만큼은 돼야 한다(px). */
const STAGE_MIN_WIDTH = 520;
const STAGE_MIN_HEIGHT = 680;

// 장면이 통째로 가려진 동안에는 그리지 않는다: 터미널 크게 보기, 그리고 휴대폰에서 화면 전체를 쓰는 상태 창.
// 상태 창은 휴대폰에서 가장 오래 보는 화면인데, 그 뒤에서 장면이 초당 30장(창을 만질 때마다 2.5초씩 60장)을 그리고 있었다.
function syncCovered(): void {
  const sheet = phoneLayout.matches && !document.getElementById("detail")!.hidden && !terminal.isOpen;
  scene.setCovered(terminal.isOpen || sheet);
  setSolo(sheet);
}
new MutationObserver(syncCovered).observe(document.getElementById("detail")!, { attributes: true, attributeFilter: ["hidden"] });
phoneLayout.addEventListener("change", syncCovered);
syncCovered();
// 휴대폰 배치에서는 상태 숫자 묶음이 단추다. 넓은 화면에서 걸어 둔 상태 거르기는 풀 길이 없으니 들어설 때 푼다.
function syncChipsRole(): void {
  if (phoneLayout.matches) {
    hud.clearStatusFilter();
    chipsEl.setAttribute("role", "button");
    chipsEl.tabIndex = 0;
    chipsEl.setAttribute("aria-label", t("에이전트 목록"));
    chipsEl.setAttribute("aria-expanded", String(document.body.dataset.roster === "open"));
    setRosterVisible(document.body.dataset.roster === "open");
  } else {
    chipsEl.setAttribute("role", "group");
    chipsEl.removeAttribute("tabindex");
    chipsEl.setAttribute("aria-label", t("상태별 에이전트 수"));
    chipsEl.removeAttribute("aria-expanded");
    setRosterVisible(true);
  }
}
phoneLayout.addEventListener("change", syncChipsRole);
syncChipsRole();
/** 지금 기록 칸이 우리가 얹은 지킴 칸인가. */
const onGuard = (): boolean => (history.state as Record<string, unknown> | null)?.[BACK_GUARD] === true;
/** 뒤로 가기로 닫을 맨 위의 것. 없으면 null. */
function topLayer(): (() => void) | null {
  const dlg = [...document.querySelectorAll<HTMLDialogElement>("dialog[open]:not([data-stay])")].at(-1);
  if (dlg)
    return () => {
      // Esc 와 같은 길로 닫는다 — 대화상자가 cancel 을 막으면 닫지 않는다.
      const cancel = new Event("cancel", { cancelable: true });
      if (dlg.dispatchEvent(cancel)) dlg.close();
    };
  if (terminal.isOpen) return () => terminal.close();
  if (document.body.dataset.roster === "open" && phoneLayout.matches) return () => setRoster(false);
  if (selectedId !== null)
    return () => {
      const toRoster = cameFromRoster && phoneLayout.matches;
      select(null);
      if (toRoster) setRoster(true, true);
    };
  return null;
}
/** 얹은 칸을 걷으려고 부른 history.back() 이 아직 돌아오지 않았다. */
let unwinding = false;
function syncBack(): void {
  if (unwinding) return; // 돌아온 뒤(popstate)에 다시 맞춘다
  const open = topLayer() !== null;
  if (open && !onGuard()) history.pushState({ [BACK_GUARD]: true }, "");
  else if (!open && onGuard()) {
    unwinding = true;
    history.back();
  }
}
window.addEventListener("popstate", () => {
  if (unwinding) {
    unwinding = false;
    return syncBack();
  }
  // 지킴 칸에 내려앉았으면(앞으로 가기, 알림으로 옮겨 오며 뒤에 남은 옛 칸) 닫지 않고 맞추기만 한다.
  if (onGuard()) return syncBack();
  topLayer()?.();
  syncBack();
});
// 대화상자는 여러 곳(집 짓기·이름 바꾸기 등)에서 열고 닫는다 — open 속성이 바뀔 때마다 맞춘다.
new MutationObserver(() => syncBack()).observe(document.body, { subtree: true, attributes: true, attributeFilter: ["open"] });
// 새로 읽은 페이지가 지난번의 지킴 칸 위에서 시작하면 그 칸을 보통 칸으로 바꾼다. 뒤로 가서 걷으면 이전 칸의 문서를 새로 읽는다.
if (onGuard()) history.replaceState(null, "");

// 목록과 상태 창이 장면을 얼마나 덮는지 알려 준다 — 장면이 그 사이 빈 자리의 한가운데에 오게.
// 좁은 화면(휴대폰)에서는 패널이 화면 전체를 쓰는 서랍이라 밀지 않는다.
{
  const detailEl = document.getElementById("detail")!;
  const phone = matchMedia("(max-width: 760px)");
  const stageEl = document.getElementById("stage")!;
  let phoneBar = 0;
  const syncInsets = (): void => {
    if (phone.matches) {
      hud.setStageRoom(false);
      // 아래 막대(접힌 한 줄)가 덮는 만큼 섬을 올린다. 서랍을 열어 막대가 두 줄이 돼도 섬은 그 자리에 둔다.
      const bar = document.getElementById("topbar")!;
      if (document.body.dataset.roster !== "open" && bar.offsetHeight > 0) phoneBar = window.innerHeight - bar.getBoundingClientRect().top;
      return scene.setInsets(0, 0, phoneBar);
    }
    const left = rosterEl.getBoundingClientRect().right;
    const right = Math.max(0, detailEl.hidden ? 0 : window.innerWidth - detailEl.getBoundingClientRect().left);
    // 무대는 두 창 사이에 선다. 사이가 좁거나 창이 낮으면 세우지 않는다 — 장면을 다 가리고 화면도 읽기 어렵다.
    stageEl.style.setProperty("--stage-left", `${left}px`);
    stageEl.style.setProperty("--stage-right", `${right}px`);
    hud.setStageRoom(window.innerWidth - left - right >= STAGE_MIN_WIDTH && window.innerHeight >= STAGE_MIN_HEIGHT);
    const bottom = stageEl.hidden ? 0 : Math.max(0, window.innerHeight - stageEl.getBoundingClientRect().top);
    scene.setInsets(left, right, bottom);
  };
  const watch = new ResizeObserver(syncInsets);
  watch.observe(rosterEl);
  watch.observe(detailEl);
  watch.observe(stageEl);
  new MutationObserver(syncInsets).observe(detailEl, { attributes: true, attributeFilter: ["hidden"] });
  new MutationObserver(syncInsets).observe(stageEl, { attributes: true, attributeFilter: ["hidden"] });
  phone.addEventListener("change", syncInsets);
  window.addEventListener("resize", syncInsets);
  syncInsets();
}

/**
 * 이 브라우저가 열쇠를 모를 때: 어떻게 여는지 알려 주고, 열쇠(또는 열쇠가 든 주소)를 붙여 넣을 수 있게 한다.
 * 닫을 수 없다 — 열쇠 없이는 아무것도 보여 줄 수 없다.
 */
function askForKey(): void {
  const input = h("input", { type: "text", autocomplete: "off", spellcheck: "false", placeholder: t("열쇠 또는 열쇠가 든 주소") });
  const error = h("p", { class: "dlg-error" });
  error.hidden = true;
  const form = h(
    "form",
    { method: "dialog" },
    h("h2", {}, t("접속 열쇠가 필요합니다")),
    h("p", {}, t("이 브라우저는 아직 이 Agent World 의 열쇠를 모릅니다. 열쇠가 붙은 주소로 한 번 열면 그 뒤로는 기억합니다.")),
    h("p", {}, t("herdr 플러그인이면 “Agent World: open in browser” 동작(묶어 둔 키, 또는 herdr pane 에서 `herdr plugin action invoke open --plugin kyongsik-yoon.agent-world`)으로 열고, 직접 띄웠으면 서버를 띄운 터미널이나 `bun run url` 이 찍는 주소로 엽니다.")),
    h("label", { class: "field" }, h("span", {}, t("또는 여기에 붙여 넣기")), input),
    error,
    h("div", { class: "dlg-actions" }, h("button", { class: "btn primary", type: "submit" }, t("열기"))),
  );
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (!acceptKey(input.value)) {
      error.textContent = t("열쇠 모양이 아닙니다. 열쇠가 붙은 주소를 통째로 붙여 넣어도 됩니다.");
      error.hidden = false;
      return;
    }
    void hasAccess().then((ok) => {
      if (ok) return location.reload();
      error.textContent = ok === false ? t("열쇠가 맞지 않습니다.") : t("서버에 닿지 못했습니다.");
      error.hidden = false;
    });
  });
  const dlg = h("dialog", { class: "dlg" }, form);
  dlg.addEventListener("cancel", (e) => e.preventDefault());
  dlg.dataset.stay = "";
  document.body.append(dlg);
  dlg.showModal();
  input.focus();
}

// 열쇠가 통하는지 먼저 본다. 서버에 닿지 못한 것이면(잠깐 꺼져 있다) 평소처럼 붙기를 되풀이한다.
void hasAccess().then((ok) => {
  if (ok === false) {
    hud.setConnection("down", t("접속 열쇠가 필요합니다"));
    askForKey();
    return;
  }
  void loadTermTheme();
  void serverBuild().then((build) => (loadedBuild = build));
  connect();
});

// ── 단추와 단축키 ────────────────────────────────────────────────────────────────────────────

document.getElementById("btn-next")!.addEventListener("click", nextAttention);
buildBtn.addEventListener("click", () => builder.newHouse());
document.getElementById("btn-home")!.addEventListener("click", () => {
  select(null);
  scene.overview();
});

// 화면 전체가 하나의 앱이라, 브라우저가 페이지를 통째로 확대하면 패널이 화면 밖으로 밀려난다.
// 터치패드의 두 손가락 벌리기와 Ctrl+휠은 ctrlKey 가 켜진 wheel 로 오므로 여기서 막는다
// (3D 화면 위에서는 카메라가 대신 확대된다. 글자 크기를 바꾸려면 Ctrl +/- 를 쓴다).
window.addEventListener(
  "wheel",
  (e) => {
    if (e.ctrlKey) e.preventDefault();
  },
  { passive: false },
);
// Safari 는 같은 동작을 gesture 이벤트로 알린다.
for (const type of ["gesturestart", "gesturechange"]) window.addEventListener(type, (e) => e.preventDefault(), { passive: false });

// Space 를 누른 채 드래그하면 맵이 이동한다. 글을 치는 중의 Space 는 그냥 띄어쓰기다.
function isTyping(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.matches("input, textarea, select, [contenteditable]") || target.closest("dialog") !== null);
}
window.addEventListener("keydown", (e) => {
  if (e.code !== "Space" || isTyping(e.target) || terminal.isOpen || document.querySelector("dialog[open]")) return;
  // 초점이 단추에 남아 있어도 Space 가 그 단추를 누르지 않게 한다.
  e.preventDefault();
  scene.setPanMode(true);
});
window.addEventListener("keyup", (e) => {
  if (e.code !== "Space") return;
  if (!isTyping(e.target)) e.preventDefault();
  scene.setPanMode(false);
});
window.addEventListener("blur", () => scene.setPanMode(false));

window.addEventListener("keydown", (e) => {
  // 글을 치는 중이면(입력란, 터미널, 대화상자) 그 키는 월드의 단축키가 아니다.
  const target = e.target instanceof HTMLElement ? e.target : null;
  const typing = target !== null && (target.matches("input, textarea, select, [contenteditable]") || target.closest("dialog") !== null);
  if (e.isComposing || terminal.isOpen || document.querySelector("dialog[open]")) return;
  if (e.key === "Escape") {
    if (typing) target.blur();
    else select(null);
    return;
  }
  if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
  switch (e.key.toLowerCase()) {
    case "c":
      if (hud.focusComposer()) e.preventDefault();
      break;
    case "`": {
      const paneId = hud.selectedPaneId;
      if (paneId) {
        e.preventDefault();
        openTerminal(paneId);
      }
      break;
    }
    case "b":
      if (!buildBtn.hidden) {
        e.preventDefault();
        builder.newHouse();
      }
      break;
    case "d": {
      const a = hud.selected;
      if (a?.status === "done") markSeen(a, false);
      break;
    }
    case "r": {
      const a = hud.selected;
      // 상태 창의 카드와 같은 조건 — 확인 필요일 때는 질문 카드가 먼저다.
      if (a?.review && a.status !== "blocked") reviewReader.open(a);
      break;
    }
    case "n":
      nextAttention();
      break;
    case "h":
      select(null);
      scene.overview();
      break;
    case "t":
      themeBtn.click();
      break;
    case "/":
      e.preventDefault();
      hud.focusSearch();
      break;
    case "enter": {
      // 다른 단추 위에서 누른 Enter 는 그 단추의 것이다 — 덩달아 herdr 화면을 옮기지 않는다.
      if (e.target instanceof HTMLElement && e.target.closest("button:not(.row), a")) break;
      // 실제 자판의 Enter 만 받는다. 휴대폰에서 보내기를 누르면 그 단추가 잠기며 초점이 문서 바닥으로 떨어지는데, 그 뒤에 화면
      // 자판에서 온 Enter 가 이 단축키가 되어 PC 의 herdr 화면을 옮기고 터미널 창을 앞으로 끌어왔다. 화면 자판의 키는 code 가
      // 비어 오고, 손가락이 주 포인터인 기기에서는 이 단축키를 쓸 일이 없다(옮기기는 상태 창의 아이콘 단추로).
      if ((e.code !== "Enter" && e.code !== "NumpadEnter") || matchMedia("(pointer: coarse)").matches) break;
      const a = hud.selected;
      if (a?.paneId) void openInHerdr(a);
      break;
    }
  }
});
