// 들머리: 서버의 스냅샷 흐름을 받아 장면과 HUD 에 나눠 주고, 둘 사이의 고르기·필터·단축키를 잇는다.
import type { AgentStatus, AgentView, SnapshotPatch, WorldSnapshot } from "../shared/types.ts";
import { post } from "./api.ts";
import { Builder } from "./build.ts";
import { type Action, workspaceKey } from "./detail.ts";
import { STATUS_VAR } from "./dom.ts";
import { STATUS_LABEL, bubbleText, needsAttention } from "./format.ts";
import { Hud } from "./hud.ts";
import { TermOverlay, loadTermTheme } from "./term.ts";
import type { Theme } from "./world/environment.ts";
import { WorldScene } from "./world/scene.ts";

function stored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function store(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // 저장소를 못 써도 화면은 그대로 돈다.
  }
}

let selectedId: string | null = null;
/** 지금 고른 것을 고른 시각 — 얼마나 들여다봤는지 잰다. */
let selectedAt = 0;

/** 이 탭이 마지막으로 화면에 드러난 시각. */
let visibleSince = Date.now();
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") visibleSince = Date.now();
});

/** 완료를 읽었다고 치는 데 필요한, 상태 창을 열어 둔 최소 시간. 스친 클릭은 치지 않는다. */
const READ_MS = 1500;

const scene = new WorldScene(document.getElementById("world")!, {
  onSelect: (id) => select(id),
  onHover: (id) => hud.setHover(id),
  onPlot: (workspaceId) => select(workspaceKey(workspaceId)),
});

const hud = new Hud({
  onSelect: (id) => select(id),
  onHover: (id) => {
    scene.setExternalHover(id);
    hud.setHover(id);
  },
  onFilter: (pass) => scene.setFilter(pass),
  onAction: (action) => act(action),
});

const terminal = new TermOverlay();
terminal.onError = (message) => hud.toast("입력을 보내지 못했습니다", message, "var(--blocked)");
void loadTermTheme();

const builder = new Builder({
  snapshot: () => hud.latest,
  select: (id) => select(id),
  toast: (title, text, color) => hud.toast(title, text, color),
  draft: (paneId, text) => hud.setDraft(paneId, text),
});

function select(id: string | null): void {
  if (id === selectedId) return;
  // 완료한 에이전트의 상태 창을 들여다보다 떠나면, 읽은 것으로 적는다. 들여다본 시간은 "완료된 결과가
  // 눈앞에 보이던 동안"만 센다 — 고른 뒤에 끝났거나, 창을 가려 둔 사이에 끝난 것은 아직 읽지 않은 것이다.
  const left = hud.selected;
  if (left?.status === "done" && left.paneId && document.visibilityState === "visible") {
    const readSince = Math.max(selectedAt, left.statusSince, visibleSince);
    if (Date.now() - readSince >= READ_MS) markSeen(left, false);
  }
  selectedId = id;
  selectedAt = Date.now();
  // 좁은 화면에서는 목록이 마을을 덮고 있으므로, 고르면 접는다.
  if (id) setRoster(false);
  scene.select(id);
  hud.select(id);
}

/** 완료를 확인했다고 적는다(또는 되돌린다). herdr 의 초점은 건드리지 않고 월드 서버가 기억한다. */
function markSeen(a: AgentView, undo: boolean): void {
  if (!a.paneId || !hud.latest?.control) return;
  const paneId = a.paneId;
  void post<{ seen?: boolean }>("/api/seen", { paneId, undo })
    .then((res) => {
      if (!undo && res.seen) hud.undoToast("확인 처리했습니다", a.title, () => markSeen(a, true));
    })
    .catch((e: Error) => hud.toast("확인 처리 실패", e.message, "var(--blocked)"));
}

function openTerminal(paneId: string): void {
  const snap = hud.latest;
  const pane = snap?.panes.find((p) => p.id === paneId);
  const agent = snap?.agents.find((a) => a.paneId === paneId);
  const ws = snap?.workspaces.find((w) => w.id === pane?.workspaceId);
  terminal.open(paneId, agent?.title ?? pane?.label ?? pane?.title ?? paneId, `${ws ? `${ws.number} · ${ws.label} · ` : ""}${paneId}`, pane?.cols);
}

function act(action: Action): void {
  switch (action.type) {
    case "select":
      select(action.id);
      break;
    case "open-herdr":
      void openInHerdr(action.agent);
      break;
    case "terminal":
      openTerminal(action.paneId);
      break;
    case "new-agent":
      builder.newAgent(action.workspaceId, action.paneId);
      break;
    case "new-tab":
      void builder.newTab(action.workspaceId);
      break;
    case "split":
      void builder.split(action.paneId, action.direction);
      break;
    case "rename":
      builder.rename(action.kind, action.id, action.current, action.what);
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
  if (!a.paneId) return;
  try {
    const res = await fetch("/api/focus", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ paneId: a.paneId }) });
    const data = (await res.json()) as { ok?: boolean; raised?: boolean; error?: string };
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    hud.toast("herdr 로 이동", data.raised ? `${a.title} — 터미널 창을 앞으로 가져왔습니다.` : `${a.title} — herdr 화면을 이 pane 으로 옮겼습니다.`, "var(--accent)");
  } catch (e) {
    hud.toast("이동 실패", (e as Error).message, "var(--blocked)");
  }
}

function nextAttention(): void {
  const list = hud.attention();
  if (list.length === 0) {
    hud.toast("확인할 에이전트가 없습니다", "완료했거나 입력을 기다리는 에이전트가 생기면 여기로 데려다 드립니다.", "var(--idle)");
    return;
  }
  const at = list.findIndex((a) => a.id === selectedId);
  select(list[(at + 1) % list.length]!.id);
}

// ── 낮/밤 ────────────────────────────────────────────────────────────────────────────────────

const themeBtn = document.getElementById("btn-theme")!;

function setTheme(theme: Theme): void {
  document.body.dataset.theme = theme;
  scene.setTheme(theme);
  themeBtn.textContent = theme === "day" ? "🌙" : "☀️";
  store("agent-world.theme", theme);
}

setTheme((stored("agent-world.theme") as Theme | null) ?? (matchMedia("(prefers-color-scheme: dark)").matches ? "night" : "day"));
themeBtn.addEventListener("click", () => setTheme(document.body.dataset.theme === "day" ? "night" : "day"));

// ── 알림 ─────────────────────────────────────────────────────────────────────────────────────

const notifyBtn = document.getElementById("btn-notify")!;
let notify = stored("agent-world.notify") === "on" && "Notification" in window && Notification.permission === "granted";
notifyBtn.setAttribute("aria-pressed", String(notify));
notifyBtn.addEventListener("click", async () => {
  if (!notify && "Notification" in window) {
    const permission = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
    notify = permission === "granted";
    if (!notify) hud.toast("알림이 막혀 있습니다", "브라우저의 사이트 설정에서 알림을 허용해 주세요.", "var(--blocked)");
  } else notify = false;
  notifyBtn.setAttribute("aria-pressed", String(notify));
  store("agent-world.notify", notify ? "on" : "off");
});

const lastStatus = new Map<string, AgentStatus>();
let primed = false;

/** 지켜보는 동안 완료나 확인 필요로 바뀐 에이전트를 알린다. 처음 받은 스냅샷은 알리지 않는다. */
function announce(snapshot: WorldSnapshot): void {
  for (const a of snapshot.agents) {
    const before = lastStatus.get(a.id);
    lastStatus.set(a.id, a.status);
    if (!primed || before === undefined || before === a.status || !needsAttention(a.status)) continue;
    const where = a.workspaceNumber ? `${a.workspaceNumber} · ${a.workspaceLabel}` : a.workspaceLabel;
    // 확인 필요면 무엇을 기다리는지까지 알린다.
    const what = a.status === "blocked" && a.pending ? ` — ${bubbleText(a) ?? ""}` : "";
    hud.toast(STATUS_LABEL[a.status], `${a.title} — ${where}${what}`, STATUS_VAR[a.status], () => select(a.id));
    if (notify && document.visibilityState !== "visible") {
      const n = new Notification(`${STATUS_LABEL[a.status]} · ${a.title}`, { body: `${where}${what}`, tag: a.id });
      n.onclick = () => {
        window.focus();
        select(a.id);
      };
    }
  }
  const alive = new Set(snapshot.agents.map((a) => a.id));
  for (const id of lastStatus.keys()) if (!alive.has(id)) lastStatus.delete(id);
  primed = true;
}

// ── 스냅샷 흐름 ──────────────────────────────────────────────────────────────────────────────

/** 다시 붙기를 직접 시도할 때의 간격(ms). 실패가 이어지면 조금씩 늘린다. */
let retryMs = 1000;

function show(snapshot: WorldSnapshot): void {
  if (snapshot.herdr) hud.setConnection("live", `herdr 연결됨 · 에이전트 ${snapshot.agents.length}`);
  else hud.setConnection("logs", `herdr 없음 — 로그만으로 표시 · ${snapshot.agents.length}`);
  announce(snapshot);
  scene.sync(snapshot);
  hud.update(snapshot);
  builder.observe(snapshot);
  buildBtn.hidden = !snapshot.herdr || !snapshot.control;
}

function connect(): void {
  const events = new EventSource("/api/events");
  /** 이 연결로 받은 최신 상태. 서버는 전체를 한 번 보낸 뒤로 달라진 것만 보낸다. */
  let current: WorldSnapshot | undefined;
  events.onmessage = (e) => {
    retryMs = 1000;
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
    hud.setConnection("down", "서버와 끊김 — 다시 연결 중…");
    // 연결이 그냥 끊긴 것이면 EventSource 가 스스로 다시 붙는다. 하지만 오류 응답을 받으면(서버가 꺼진 동안
    // 앞단 프록시가 502 를 돌려줄 때) 영영 포기하므로, 그때는 직접 새로 연다.
    if (events.readyState !== EventSource.CLOSED) return;
    events.close();
    setTimeout(connect, retryMs);
    retryMs = Math.min(retryMs * 1.6, 8000);
  };
}

const buildBtn = document.getElementById("btn-build")!;

// 좁은 화면(휴대폰)에서는 목록을 접어 두고 단추로 여닫는다. 넓은 화면에서는 늘 보인다.
const rosterBtn = document.getElementById("btn-roster")!;
function setRoster(open: boolean): void {
  document.body.dataset.roster = open ? "open" : "closed";
  rosterBtn.setAttribute("aria-expanded", String(open));
}
rosterBtn.addEventListener("click", () => setRoster(document.body.dataset.roster !== "open"));

connect();

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
      const a = hud.selected;
      if (a?.paneId) void openInHerdr(a);
      break;
    }
  }
});
