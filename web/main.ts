// 들머리: 서버의 스냅샷 흐름을 받아 장면과 HUD 에 나눠 주고, 둘 사이의 고르기·필터·단축키를 잇는다.
import type { AgentStatus, AgentView, SnapshotPatch, WorldSnapshot } from "../shared/types.ts";
import { post, hasAccess, headers } from "./api.ts";
import { Builder } from "./build.ts";
import { type Action, workspaceKey } from "./detail.ts";
import { STATUS_VAR, h, store, stored } from "./dom.ts";
import { STATUS_LABEL, bubbleText, needsAttention } from "./format.ts";
import { Hud } from "./hud.ts";
import { lang, localizeStatic, t, setLang } from "./i18n.ts";
import { acceptKey, withKey } from "./key.ts";
import { TermOverlay, loadTermTheme } from "./term.ts";
import type { Theme } from "./world/environment.ts";
import { WorldScene } from "./world/scene.ts";

// index.html 에 적힌 글을 지금 말로 — HUD 와 장면을 짓기 전에 한 번.
localizeStatic();

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
terminal.onError = (message) => hud.toast(t("입력을 보내지 못했습니다"), message, "var(--blocked)");
terminal.onGone = (title) => hud.toast(t("터미널을 닫았습니다"), t("{title} — 이 pane 이 herdr 에서 닫혔습니다.", { title }), "var(--idle)");
terminal.onToggle = (open) => {
  scene.setCovered(open);
  hud.setCovered(open);
};

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
      if (!undo && res.seen) hud.undoToast(t("확인 처리했습니다"), a.title, () => markSeen(a, true));
    })
    .catch((e: Error) => hud.toast(t("확인 처리 실패"), e.message, "var(--blocked)"));
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
    if (!notify) hud.toast(t("알림이 막혀 있습니다"), t("브라우저의 사이트 설정에서 알림을 허용해 주세요."), "var(--blocked)");
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
  // 이름 붙은 herdr 세션이면 그 이름을 함께 보여 준다 — 세션마다 띄운 화면이 여럿일 때 어느 것인지 알 수 있게.
  const session = snapshot.session ? ` (${snapshot.session})` : "";
  if (snapshot.herdr) hud.setConnection("live", t("herdr{session} 연결됨 · 에이전트 {n}", { session, n: snapshot.agents.length }), snapshot.session ? t("herdr 세션 {name}", { name: snapshot.session }) : "");
  else hud.setConnection("logs", t("herdr 없음 — 로그만으로 표시 · {n}", { n: snapshot.agents.length }), snapshot.herdrError?.[lang] ?? "");
  announce(snapshot);
  scene.sync(snapshot);
  hud.update(snapshot);
  builder.observe(snapshot);
  buildBtn.hidden = !snapshot.herdr || !snapshot.control;
}

function connect(): void {
  const events = new EventSource(withKey("/api/events"));
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
    hud.setConnection("down", t("서버와 끊김 — 다시 연결 중…"));
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

// 목록과 상태 창이 장면을 얼마나 덮는지 알려 준다 — 장면이 그 사이 빈 자리의 한가운데에 오게.
// 좁은 화면(휴대폰)에서는 패널이 화면 전체를 쓰는 서랍이라 밀지 않는다.
{
  const rosterEl = document.getElementById("roster")!;
  const detailEl = document.getElementById("detail")!;
  const phone = matchMedia("(max-width: 760px)");
  const syncInsets = (): void => {
    if (phone.matches) return scene.setInsets(0, 0);
    const detail = detailEl.hidden ? 0 : window.innerWidth - detailEl.getBoundingClientRect().left;
    scene.setInsets(rosterEl.getBoundingClientRect().right, Math.max(0, detail));
  };
  const watch = new ResizeObserver(syncInsets);
  watch.observe(rosterEl);
  watch.observe(detailEl);
  new MutationObserver(syncInsets).observe(detailEl, { attributes: true, attributeFilter: ["hidden"] });
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
    h("p", {}, t("herdr 플러그인이면 명령 팔레트의 “Agent World: open in browser” 로 열고, 직접 띄웠으면 서버를 띄운 터미널이나 `bun run url` 이 찍는 주소로 엽니다.")),
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
