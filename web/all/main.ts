// 전체 보기 — 여러 PC 의 Agent World 를 섬 하나씩으로 한 화면에 그린다(/all).
//
// 이 화면은 보기만 한다. 섬을 누르면 그 월드의 주소로 넘어가고, 조작은 거기서 한다. 3D 장면을 쓰지 않는다 —
// 섬은 SVG 한 장이고 캐릭터는 상태가 바뀔 때만 걷는다(walk.ts). 쉬는 동안 화면은 한 장도 나가지 않는다.
//
// 월드마다 접속 열쇠가 따로 있다. 이 기기가 기억한 열쇠를 중계 서버에 보내면, 서버는 맞는 월드의 내용만 돌려준다
// (server/all.ts). 열쇠가 없는 월드는 잠긴 섬으로만 보인다. 열쇠는 이 출처의 localStorage 에만 둔다.
import "../fonts.ts";
import type { AllOp, DigestStatus } from "../../shared/types.ts";
import { headers } from "../api.ts";
import { stored, store } from "../dom.ts";
import { t } from "../i18n.ts";
import { acceptKey } from "../key.ts";
import { Isle, ORDER, STATUS_NAME } from "./isle.ts";
import { counters } from "./walk.ts";

(window as unknown as { __all: typeof counters }).__all = counters;

// ── 낮/밤: 월드 화면에서 고른 것을 그대로 따른다 ─────────────────────────
const dark = matchMedia("(prefers-color-scheme: dark)");
function applyTheme(): void {
  const mode = stored("agent-world.theme-mode");
  document.body.dataset.theme = mode === "day" || mode === "night" ? mode : dark.matches ? "night" : "day";
}
applyTheme();
dark.addEventListener("change", applyTheme);

// ── 월드별 열쇠 ────────────────────────────────────────────────────
const STORE = "agent-world.worlds";
const KEY_SHAPE = /([0-9a-f]{32,})\s*$/;
let keys: Record<string, string> = {};
try {
  const kept = JSON.parse(stored(STORE) ?? "{}") as unknown;
  if (kept && typeof kept === "object") for (const [id, key] of Object.entries(kept)) if (typeof key === "string") keys[id] = key;
} catch {
  // 적어 둔 것이 깨졌으면 없는 것으로 친다.
}
const saveKeys = (): void => store(STORE, JSON.stringify(keys));

/**
 * 월드 화면의 "전체 보기로" 단추가 주소 뒤에 실어 보낸 열쇠(`#w=<월드 주소들>&wk=<열쇠>`). 받자마자 주소에서 지우고,
 * 중계 서버가 그 주소를 제 월드 목록에 있는 것으로 열어 줬을 때만 기억한다. 주소가 여럿인 것은 그 월드가 여러 이름
 * (tailnet 주소, localhost)으로 불리기 때문이다 — 중계의 설정에 적힌 것 하나가 맞는다.
 */
let handed: { ids: string[]; key: string } | undefined;
{
  const m = /(?:^#|&)w=([^&]+)&wk=([0-9a-f]{32,})/.exec(location.hash);
  if (m) {
    const ids: string[] = [];
    for (const part of decodeURIComponent(m[1]!).split(",")) {
      try {
        ids.push(new URL(part).origin);
      } catch {
        // 주소 모양이 아니다.
      }
    }
    if (ids.length) handed = { ids, key: m[2]! };
    history.replaceState(null, "", location.pathname + location.search);
  }
}

// ── 화면 ──────────────────────────────────────────────────────────
const grid = document.getElementById("grid")!;
const conn = document.getElementById("conn")!;
document.getElementById("title")!.textContent = t("전체 보기");
const isles = new Map<string, Isle>();
const totalChips = new Map<DigestStatus, HTMLElement>();
for (const s of ORDER) {
  const chip = document.createElement("span");
  chip.className = "chip big";
  chip.dataset.s = s;
  const n = document.createElement("b");
  n.textContent = "0";
  chip.append(n, ` ${STATUS_NAME[s]}`);
  totalChips.set(s, n);
  document.getElementById("totals")!.append(chip);
}

let totalsQueued = false;
function totals(): void {
  if (totalsQueued) return;
  totalsQueued = true;
  queueMicrotask(() => {
    totalsQueued = false;
    const sum: Record<DigestStatus, number> = { blocked: 0, done: 0, working: 0, idle: 0 };
    for (const isle of isles.values()) {
      const n = isle.counts();
      for (const s of ORDER) sum[s] += n[s];
    }
    for (const s of ORDER) {
      const text = String(sum[s]);
      const el = totalChips.get(s)!;
      if (el.textContent !== text) el.textContent = text;
    }
  });
}

/** 섬이 가장 크게 보이는 칸 수를 고른다(화면의 가로세로와 섬 수로). 좁은 화면은 스타일이 한 줄로 세운다. */
function fit(): void {
  const n = isles.size;
  if (!n) return;
  const w = grid.clientWidth;
  const h = grid.clientHeight;
  let best = 1;
  let size = 0;
  for (let cols = 1; cols <= n; cols += 1) {
    const side = Math.min(w / cols, (h / Math.ceil(n / cols)) * (720 / 520));
    if (side > size + 0.5) {
      size = side;
      best = cols;
    }
  }
  const text = String(best);
  if (grid.style.getPropertyValue("--cols") !== text) grid.style.setProperty("--cols", text);
}
addEventListener("resize", fit);

/** 이번 연결에서 서버에 보낸 열쇠들. */
let sent: Record<string, string> = {};

function apply(ops: AllOp[]): void {
  for (const op of ops) {
    if (op.t === "s") {
      isles.get(op.w)?.status(op.a, op.s);
      continue;
    }
    const w = op.w;
    let isle = isles.get(w.id);
    const refused = w.state === "locked" && sent[w.id] !== undefined;
    if (refused && keys[w.id] === sent[w.id]) {
      // 기억해 둔 열쇠가 이제 맞지 않는다(월드의 열쇠가 바뀌었다). 다시 보내지 않게 지운다.
      delete keys[w.id];
      saveKeys();
    }
    if (w.state === "open" && handed?.ids.includes(w.id) && sent[w.id] === handed.key) {
      keys[w.id] = handed.key;
      saveKeys();
      handed = undefined;
    }
    if (isle) {
      isle.refused = refused;
      isle.build(w);
    } else {
      isle = new Isle(w, totals);
      isle.refused = refused;
      isle.note();
      isles.set(w.id, isle);
      grid.append(isle.el);
      fit();
    }
  }
}

// ── 스트림 ─────────────────────────────────────────────────────────
// EventSource 는 본문을 실을 수 없어(열쇠를 주소에 적게 된다) fetch 로 읽는다.
let stream: AbortController | undefined;

function say(text: string, bad = false): void {
  conn.textContent = text;
  conn.hidden = text === "";
  conn.classList.toggle("bad", bad);
}

async function connect(): Promise<void> {
  stream?.abort();
  const mine = (stream = new AbortController());
  sent = { ...keys };
  if (handed) for (const id of handed.ids) sent[id] = handed.key;
  try {
    const res = await fetch("/api/all/events", { method: "POST", headers: { ...headers(), "content-type": "application/json" }, body: JSON.stringify({ keys: sent }), signal: mine.signal });
    if (res.status === 401) {
      askKey(null);
      return;
    }
    if (res.status === 404) {
      say(t("이 서버는 전체 보기를 내주지 않습니다(AGENT_WORLD_WORLDS 가 없습니다)."), true);
      return;
    }
    if (!res.ok || !res.body) throw new Error(String(res.status));
    say("");
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let end: number;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const raw = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (raw.startsWith("data:")) apply(JSON.parse(raw.slice(5)) as AllOp[]);
      }
    }
  } catch {
    // 아래에서 다시 붙는다.
  }
  if (mine.signal.aborted) return;
  say(t("서버와 연결이 끊겼습니다. 다시 붙는 중…"), true);
  setTimeout(() => {
    if (!mine.signal.aborted) void connect();
  }, 2000);
}

// ── 열쇠 넣기 ──────────────────────────────────────────────────────
const dialog = document.getElementById("key-dialog") as HTMLDialogElement;
const keyInput = document.getElementById("key-input") as HTMLInputElement;
const keyTitle = document.getElementById("key-title")!;
const keyHelp = document.getElementById("key-help")!;
const keyError = document.getElementById("key-error")!;
document.getElementById("key-cancel")!.textContent = t("닫기");
document.getElementById("key-ok")!.textContent = t("열기");
/** 열쇠를 넣을 월드. null 이면 이 서버(중계) 자신의 열쇠다. */
let asking: string | null = null;

function askKey(id: string | null): void {
  asking = id;
  const name = id === null ? "" : (isles.get(id)?.world.name ?? "");
  keyTitle.textContent = id === null ? t("접속 열쇠가 필요합니다") : t("{name} 열기", { name });
  keyHelp.textContent =
    id === null
      ? t("서버를 띄울 때 찍힌 주소(…/#k=열쇠)를 붙여 넣으세요. 이 브라우저가 기억합니다.")
      : t("그 PC 의 Agent World 가 찍어 준 주소(…/#k=열쇠)나 열쇠를 붙여 넣으세요. 이 기기에 한 번만 넣으면 됩니다.");
  keyError.textContent = "";
  keyInput.value = "";
  if (!dialog.open) dialog.showModal();
  keyInput.focus();
}

document.getElementById("key-form")!.addEventListener("submit", (e) => {
  e.preventDefault();
  if (asking === null) {
    if (!acceptKey(keyInput.value)) {
      keyError.textContent = t("열쇠 모양이 아닙니다.");
      return;
    }
  } else {
    const m = KEY_SHAPE.exec(keyInput.value.trim());
    if (!m) {
      keyError.textContent = t("열쇠 모양이 아닙니다.");
      return;
    }
    keys[asking] = m[1]!;
    saveKeys();
  }
  dialog.close();
  void connect();
});
document.getElementById("key-cancel")!.addEventListener("click", () => dialog.close());

// ── 들어가기(쓔욱) ──────────────────────────────────────────────────
// 섬이 다가오며 하늘빛으로 덮이고, 그 월드의 주소로 넘어간다. 한 번 그린 섬을 층으로 올려 그대로 키운다.
const cover = document.getElementById("cover")!;
const still = matchMedia("(prefers-reduced-motion: reduce)");
const WHOOSH_MS = 520;

function enter(isle: Isle): void {
  const w = isle.world;
  // 이 기기가 가진 열쇠를 주소 뒤에 실어 간다 — 그 월드의 화면이 받아 기억한다(web/key.ts).
  const to = w.id === "local" ? w.url : `${w.url}#k=${keys[w.id] ?? ""}`;
  if (still.matches) {
    location.href = to;
    return;
  }
  const stage = isle.el.querySelector<HTMLElement>(".isle")!;
  const r = stage.getBoundingClientRect();
  const k = Math.min(innerWidth / r.width, innerHeight / r.height) * 2.4;
  const dx = innerWidth / 2 - (r.left + r.width / 2);
  const dy = innerHeight * 0.56 - (r.top + r.height * 0.48);
  isle.el.style.zIndex = "5";
  stage.style.willChange = "transform";
  cover.hidden = false;
  stage.animate([{ transform: "none" }, { transform: `translate(${dx}px, ${dy}px) scale(${k})` }], { duration: WHOOSH_MS, easing: "cubic-bezier(0.5, 0, 0.9, 0.4)", fill: "forwards" });
  cover.animate([{ opacity: 0 }, { opacity: 0, offset: 0.45 }, { opacity: 1 }], { duration: WHOOSH_MS, fill: "forwards" }).onfinish = () => {
    location.href = to;
  };
}

grid.addEventListener("click", (e) => {
  const a = (e.target as Element).closest<HTMLAnchorElement>("a.world");
  if (!a) return;
  const isle = isles.get(a.dataset.id ?? "");
  if (!isle) return;
  const state = isle.world.state;
  // 새 탭으로 여는 누르기는 브라우저에 맡긴다(열린 월드만).
  if (state === "open" && (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0)) return;
  e.preventDefault();
  if (state === "locked") askKey(isle.world.id);
  else if (state === "open") enter(isle);
});

// 다른 주소로 넘어가면 스트림을 끊는다. 브라우저가 이 화면을 뒤로 가기용으로 묵혀 두는 동안(bfcache) 스트림이 살아
// 있으면, 보는 사람이 없는데도 중계가 월드들에 계속 붙어 있게 된다.
addEventListener("pagehide", () => stream?.abort());

// 뒤로 가기로 돌아왔을 때(bfcache) 덮개와 키워 둔 섬을 되돌린다.
addEventListener("pageshow", (e: PageTransitionEvent) => {
  if (!e.persisted) return;
  cover.hidden = true;
  for (const anim of document.getAnimations()) anim.cancel();
  for (const el of document.querySelectorAll<HTMLElement>(".isle")) el.style.willChange = "";
  for (const el of document.querySelectorAll<HTMLElement>("a.world")) el.style.zIndex = "";
  void connect();
});

void connect();
