// 들머리: 서버의 스냅샷 흐름을 받아 장면과 HUD 에 나눠 주고, 둘 사이의 고르기·필터·단축키를 잇는다.
import type { AgentStatus, AgentView, WorldSnapshot } from "../shared/types.ts";
import { STATUS_LABEL, needsAttention } from "./format.ts";
import { Hud, STATUS_VAR } from "./hud.ts";
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

const scene = new WorldScene(document.getElementById("world")!, {
  onSelect: (id) => select(id),
  onHover: (id) => hud.setHover(id),
});

const hud = new Hud({
  onSelect: (id) => select(id),
  onHover: (id) => {
    scene.setExternalHover(id);
    hud.setHover(id);
  },
  onFilter: (pass) => scene.setFilter(pass),
  onOpenInHerdr: (a) => void openInHerdr(a),
});

function select(id: string | null): void {
  selectedId = id;
  scene.select(id);
  hud.select(id);
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
    hud.toast(STATUS_LABEL[a.status], `${a.title} — ${where}`, STATUS_VAR[a.status], () => select(a.id));
    if (notify && document.visibilityState !== "visible") {
      const n = new Notification(`${STATUS_LABEL[a.status]} · ${a.title}`, { body: where, tag: a.id });
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

function connect(): void {
  const events = new EventSource("/api/events");
  events.onmessage = (e) => {
    const snapshot = JSON.parse(e.data as string) as WorldSnapshot;
    if (snapshot.herdr) hud.setConnection("live", `herdr 연결됨 · 에이전트 ${snapshot.agents.length}`);
    else hud.setConnection("logs", `herdr 없음 — 로그만으로 표시 · ${snapshot.agents.length}`);
    announce(snapshot);
    scene.sync(snapshot);
    hud.update(snapshot);
  };
  // EventSource 가 스스로 다시 붙는다. 끊긴 동안에는 그렇다고 알려 둔다.
  events.onerror = () => hud.setConnection("down", "서버와 끊김 — 다시 연결 중…");
}

connect();

// ── 단추와 단축키 ────────────────────────────────────────────────────────────────────────────

document.getElementById("btn-next")!.addEventListener("click", nextAttention);
document.getElementById("btn-home")!.addEventListener("click", () => {
  select(null);
  scene.overview();
});

window.addEventListener("keydown", (e) => {
  const typing = e.target instanceof HTMLInputElement;
  if (e.key === "Escape") {
    if (typing) (e.target as HTMLInputElement).blur();
    else select(null);
    return;
  }
  if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
  switch (e.key.toLowerCase()) {
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
