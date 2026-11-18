// 오른쪽 상태 창. 고른 것이 에이전트면 상태·응답·터미널과 대화 입력을, 셸 pane 이면 터미널과 명령 입력을,
// 집(스페이스)이면 그 안의 탭과 pane 목록을 보여 준다.
//
// 스냅샷이 올 때마다 위쪽(머리·본문)은 다시 그리지만, 아래쪽 도크(빠른 키·입력창)는 고른 대상이 바뀔 때만
// 새로 만든다 — 치고 있던 글과 초점이 스냅샷에 쓸려 가지 않게.
import { type Activity, type AgentView, LIVE_MODEL_KINDS, type PaneView, type PendingRequest, type WorkspaceView, type WorldSnapshot } from "../shared/types.ts";
import { ApiError, headers, post, sendInput, uploadImage } from "./api.ts";
import { brandFor, brandTile } from "./brands.ts";
import { type Child, type IconName, STATUS_VAR, h, icon, prose, store, stored } from "./dom.ts";
import { STATUS_LABEL, activityParts, bubbleParts, clock, effortLevel, shortPath, statusAge, tokens } from "./format.ts";
import { t } from "./i18n.ts";
import { TermScreen } from "./term.ts";

export type TargetKind = "workspace" | "tab" | "pane" | "agent";

export type Action =
  | { type: "select"; id: string | null }
  | { type: "open-herdr"; agent: AgentView }
  | { type: "terminal"; paneId: string }
  | { type: "new-agent"; workspaceId: string; paneId?: string }
  | { type: "new-tab"; workspaceId: string }
  | { type: "split"; paneId: string; direction: "right" | "down" }
  | { type: "rename"; kind: TargetKind; id: string; current: string; what: string }
  | { type: "model"; agent: AgentView }
  | { type: "close"; kind: "workspace" | "tab" | "pane"; id: string }
  | { type: "seen"; paneId: string; undo: boolean }
  | { type: "roster" };

export interface DetailCallbacks {
  act(action: Action): void;
  toast(title: string, text: string, color: string): void;
}

// 글자 키는 raw(키보드로 친 바이트 그대로)로 보낸다. 그냥 text 로 보내면 herdr 가 붙여넣기로 감싸서,
// 키 입력을 기다리는 대화상자(권한 확인 등)가 무시한다.
/** icon 이 있으면 글자 기호 대신 선 아이콘을 그리고 title 을 읽어 주는 이름으로 쓴다. caption 은 아이콘 옆에 붙는 글. */
// 차례가 곧 자리다. 손가락 화면은 다섯 개씩 두 줄로 세우므로, 앞의 다섯은 선택지를 고르는 키(번호·화살표),
// 뒤의 다섯은 멈추기·모드·확정 키다. Enter 는 보내기 단추 바로 위인 끝자리에 둔다.
const QUICK_KEYS: Array<{ label: string; title: string; icon?: IconName; caption?: string; keys?: string[]; text?: string; raw?: boolean }> = [
  { label: "1", title: t("{key} 누르기", { key: "1" }), text: "1", raw: true },
  { label: "2", title: t("{key} 누르기", { key: "2" }), text: "2", raw: true },
  { label: "3", title: t("{key} 누르기", { key: "3" }), text: "3", raw: true },
  { label: "Up", title: t("위"), icon: "up", keys: ["up"] },
  { label: "Down", title: t("아래"), icon: "down", keys: ["down"] },
  { label: "Esc", title: t("하던 일 멈추기 / 대화상자 닫기"), keys: ["esc"] },
  { label: "^C", title: "Ctrl+C", text: "\x03", raw: true },
  { label: "Tab", title: "Tab", keys: ["tab"] },
  { label: "Shift+Tab", title: t("Shift+Tab (권한 모드 바꾸기)"), icon: "shift", caption: "Tab", keys: ["shift+tab"] },
  { label: "Enter", title: "Enter", icon: "enter", keys: ["enter"] },
];

const PREVIEW_LINES = 18;
/** 원문을 펼쳐 볼 수 있는 활동 — 생각은 원문이 로그에 남지 않는다. */
function expandable(a: Activity): boolean {
  return a.kind === "text" || a.kind === "user" || a.kind === "tool";
}

/**
 * 활동 로그의 한 줄을 가리키는 열쇠. 서버도 같은 셋으로 그 줄을 찾는다 — 시각, 한 줄 요약, 그리고 둘이 같은 줄 가운데
 * 최신부터 몇 번째인지(n). agy 는 한 단계의 도구 호출이 같은 시각을 달아, 같은 파일을 범위만 바꿔 읽으면 앞의 둘이 겹친다.
 * 최신부터 세므로 오래된 줄이 목록에서 빠져도 번호가 밀리지 않는다.
 */
function logKey(a: Activity, n: number): string {
  return `${a.at}\n${a.text}\n${n}`;
}

/** Codex 가 긴 지시를 기록할 때 가운데를 비우고 남기는 표식. */
const OMITTED = /<truncated omitted_approx_tokens="(\d+)"\s*\/>/g;
/** 한 번에 붙일 수 있는 이미지 수(서버의 MAX_IMAGES 와 같다). */
const MAX_SHOTS = 8;
/** 끌어서 맞춘 상태 창의 폭을 적어 두는 자리. */
const WIDTH_KEY = "agent-world.detail-width";

function norm(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

interface Fact {
  label: string;
  value: Child;
  mono?: boolean;
}

/** 이름–값 줄을 한 장의 카드에 모은다. 값은 줄여 자르지 않고 줄을 바꾼다 — 휴대폰에는 말풍선(title)이 없다. */
function factCard(rows: Fact[], note?: string): HTMLElement | null {
  if (rows.length === 0 && !note) return null;
  const dl = h("dl", { class: "facts" });
  for (const row of rows) dl.append(h("div", { class: "fact" }, h("dt", {}, row.label), h("dd", row.mono ? { class: "mono" } : {}, row.value)));
  if (note) dl.append(h("div", { class: "fact-note" }, icon("info"), h("span", {}, note)));
  return dl;
}

export function workspaceKey(id: string): string {
  return `ws:${id}`;
}

export class DetailPanel {
  private readonly head = h("div", { class: "d-head" });
  private readonly body = h("div", { class: "d-body" });
  private readonly dock = h("div", { class: "d-dock" });
  private readonly quick = h("div", { class: "quick" });
  private readonly input = h("textarea", { rows: "1", spellcheck: "false" });
  private readonly sendBtn = h("button", { class: "btn primary", type: "button" }, t("보내기"));
  private readonly attachBtn = h("button", { class: "attach", type: "button", title: t("이미지 붙이기 — 입력창에 붙여넣거나 끌어다 놓아도 됩니다"), "aria-label": t("이미지 붙이기") }, icon("plus"));
  private readonly note = h("div", { class: "dock-note" });
  /** 보낼 말에 붙인 이미지들. id 는 서버가 맡아 준 뒤에 생긴다. */
  private readonly shotsEl = h("div", { class: "shots", hidden: "" });
  private shots: Array<{ id?: string; url: string; el: HTMLElement }> = [];
  private readonly preview = new TermScreen({ tail: PREVIEW_LINES });
  /** 터미널 크게 보기에 덮여 있다 — 같은 화면을 두 번 읽지 않도록 미리보기를 쉰다. */
  private covered = false;
  private snapshot: WorldSnapshot | undefined;
  private selectedId: string | null = null;
  /** 도크가 지금 붙어 있는 pane 과 방식. */
  private docked: { paneId: string; agent: boolean } | null = null;
  private sent: { text: string; at: number; confirmed: boolean; before?: string } | null = null;
  private readonly open = { prompt: false, reply: false, screen: false };
  private readonly sectionOf: { prompt?: { stamp: string; el: HTMLElement }; reply?: { stamp: string; el: HTMLElement } } = {};
  /** 활동 로그에서 펼친 줄(logKey). 원문은 펼칠 때 서버에서 받아 둔다 — 스냅샷에는 한 줄 요약만 온다. */
  private logOpen: string | null = null;
  /** logKey → 받아 온 원문(받는 중이면 빈 객체). 그려 둔 상자도 같이 둬서 스냅샷마다 다시 짓지 않는다. */
  private readonly logText = new Map<string, { text?: string; error?: string; el?: HTMLElement }>();
  /** 접은 뒤 보이는 자리로 데려올 줄(다시 그린 다음에 쓴다). */
  private logReveal: HTMLElement | null = null;
  private logRevealKey: string | null = null;
  private busy = false;

  constructor(
    private readonly root: HTMLElement,
    private readonly callbacks: DetailCallbacks,
  ) {
    // 키 단추는 한 묶음으로 남는 폭을 나눠 쓰고, 터미널 단추는 그 옆에 제 폭으로 선다.
    const keys = h("div", { class: "keys" });
    for (const key of QUICK_KEYS) {
      const btn = key.icon
        ? h("button", { type: "button", title: key.title, "aria-label": key.title }, icon(key.icon), key.caption ? h("span", { "aria-hidden": "true" }, key.caption) : null)
        : h("button", { type: "button", title: key.title }, key.label);
      btn.addEventListener("click", () => {
        if (!this.docked) return;
        void sendInput(this.docked.paneId, { text: key.text, keys: key.keys, raw: key.raw }).catch((e: Error) => this.setNote(e.message, "err"));
      });
      keys.append(btn);
    }
    const term = h("button", { type: "button", class: "wide", title: t("터미널 크게 보기 (`)") }, icon("expand"), h("span", {}, t("터미널")));
    term.addEventListener("click", () => this.docked && this.callbacks.act({ type: "terminal", paneId: this.docked.paneId }));
    this.quick.append(keys, term);

    this.input.addEventListener("input", () => this.fitInput());
    // 상태 창 폭이 바뀌면 줄바꿈이 달라지므로 높이를 다시 맞춘다(높이 변화에는 반응하지 않는다).
    // 관찰 콜백 안에서 크기를 바꾸면 관찰 고리 오류가 나므로 다음 프레임에 맞춘다.
    let inputWidth = 0;
    new ResizeObserver(([entry]) => {
      const width = entry?.contentRect.width ?? 0;
      if (width === inputWidth) return;
      inputWidth = width;
      requestAnimationFrame(() => this.fitInput());
    }).observe(this.input);
    this.input.addEventListener("keydown", (e) => {
      // 한글을 조합하는 중의 Enter 는 글자를 확정하는 키다.
      if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
      e.preventDefault();
      void this.submit();
    });
    this.sendBtn.addEventListener("click", () => void this.submit());
    // 이미지는 붙여넣거나, 끌어다 놓거나, 클립 단추로 고른다. 글 붙여넣기는 건드리지 않는다.
    const images = (list: FileList | undefined | null): File[] => [...(list ?? [])].filter((f) => f.type.startsWith("image/"));
    this.input.addEventListener("paste", (e) => {
      const files = images(e.clipboardData?.files);
      if (files.length === 0 || !this.docked?.agent) return;
      e.preventDefault();
      this.attach(files);
    });
    this.dock.addEventListener("dragover", (e) => {
      if (this.docked?.agent && e.dataTransfer?.types.includes("Files")) e.preventDefault();
    });
    this.dock.addEventListener("drop", (e) => {
      const files = images(e.dataTransfer?.files);
      if (files.length === 0 || !this.docked?.agent) return;
      e.preventDefault();
      this.attach(files);
    });
    const picker = h("input", { type: "file", accept: "image/png,image/jpeg,image/gif,image/webp", multiple: "", hidden: "" });
    picker.addEventListener("change", () => {
      this.attach(images(picker.files));
      picker.value = "";
    });
    this.attachBtn.addEventListener("click", () => picker.click());
    this.dock.append(this.quick, this.shotsEl, h("div", { class: "compose" }, this.attachBtn, this.input, this.sendBtn), picker, this.note);
    this.root.replaceChildren(this.head, this.body, this.dock, this.grip());
    this.preview.el.classList.add("preview");
    this.preview.el.title = t("눌러서 크게 보기");
    this.preview.el.addEventListener("click", () => {
      if (this.preview.pane && !window.getSelection()?.toString()) this.callbacks.act({ type: "terminal", paneId: this.preview.pane });
    });

    // 창 안에서 누르고 있거나 글을 골라 둔 동안에는 다시 그리지 않는다(render 가 미뤄 둔다). 손을 떼거나 고르기를
    // 풀면 그때 최신 상태로 그린다.
    for (const part of [this.head, this.body]) {
      part.addEventListener("pointerdown", () => {
        this.pressing = true;
      });
    }
    const released = (): void => {
      if (!this.pressing) return;
      this.pressing = false;
      // 뗀 자리의 click 이 먼저 처리된 뒤에 그린다.
      setTimeout(() => this.flushHeld(), 0);
    };
    window.addEventListener("pointerup", released);
    window.addEventListener("pointercancel", released);
    document.addEventListener("selectionchange", () => this.flushHeld());
  }

  /** 지금 다시 그리면 사용자가 하던 일이 끊기는지 — 창 안의 무언가를 누르는 중이거나, 창 안의 글을 골라 두었다. */
  private interacting(): boolean {
    if (this.pressing) return true;
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.anchorNode) return false;
    return this.head.contains(selection.anchorNode) || this.body.contains(selection.anchorNode);
  }

  private flushHeld(): void {
    if (!this.held || !this.snapshot || this.interacting()) return;
    this.render(this.snapshot, this.selectedId, true);
  }

  /**
   * 왼쪽 가장자리의 손잡이 — 끌어서 창의 폭을 바꾸고, 두 번 누르면 처음 폭으로 돌린다.
   * 폭은 CSS 변수로만 건네고 위아래 한계는 스타일이 정한다(좁은 화면의 규칙이 그대로 이기도록).
   */
  private grip(): HTMLElement {
    const grip = h("div", { class: "d-grip", title: t("끌어서 폭 조절 · 두 번 눌러 처음 폭으로") });
    const saved = Number(stored(WIDTH_KEY));
    if (saved > 0) this.root.style.setProperty("--detail-w", `${saved}px`);
    let drag: { x: number; width: number; moved: boolean } | null = null;
    let next = 0;
    let frame = 0;
    grip.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      grip.setPointerCapture(e.pointerId);
      drag = { x: e.clientX, width: this.root.getBoundingClientRect().width, moved: false };
      this.root.classList.add("resizing");
    });
    grip.addEventListener("pointermove", (e) => {
      if (!drag) return;
      drag.moved = true;
      // 창은 오른쪽에 붙어 있으니 왼쪽으로 끈 만큼 넓어진다.
      next = Math.round(drag.width + drag.x - e.clientX);
      frame ||= requestAnimationFrame(() => {
        frame = 0;
        this.root.style.setProperty("--detail-w", `${next}px`);
      });
    });
    const end = (): void => {
      if (!drag) return;
      const moved = drag.moved;
      drag = null;
      this.root.classList.remove("resizing");
      // 누르기만 한 것은 폭을 정한 것이 아니다(두 번 누르기의 되돌림을 덮어쓰지 않게).
      if (!moved) return;
      // 한계에 걸려 실제로 그려진 폭을 적어 둔다 — 끈 거리가 아니라.
      requestAnimationFrame(() => {
        const width = Math.round(this.root.getBoundingClientRect().width);
        this.root.style.setProperty("--detail-w", `${width}px`);
        store(WIDTH_KEY, String(width));
      });
    };
    grip.addEventListener("pointerup", end);
    grip.addEventListener("pointercancel", end);
    grip.addEventListener("dblclick", () => {
      this.root.style.removeProperty("--detail-w");
      store(WIDTH_KEY, null);
    });
    return grip;
  }

  /** 지금 그 pane 의 입력창이 열려 있으면 보낼 말을 적어 둔다. */
  setDraft(paneId: string, text: string): void {
    if (this.docked?.paneId === paneId) this.setInput(text);
  }

  /** 입력창 글을 바꾸고 높이를 글에 맞춘다. */
  private setInput(text: string): void {
    this.input.value = text;
    this.fitInput();
  }

  /** 입력창은 한 줄 높이에서 시작해 글이 늘면 따라 커진다(최대 높이는 CSS 가 정한다). */
  private fitInput(): void {
    // 한 줄 배치의 폭에서 재서 정한다 — 넓어진 폭에서 재면 줄 수가 줄어 두 배치 사이를 오간다.
    const box = this.input.parentElement;
    box?.classList.remove("tall");
    this.input.style.height = "auto";
    const style = getComputedStyle(this.input);
    const oneLine = parseFloat(style.lineHeight) + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
    if (box && this.input.scrollHeight > oneLine + 2) {
      box.classList.add("tall");
      this.input.style.height = "auto";
    }
    this.input.style.height = `${this.input.scrollHeight + this.input.offsetHeight - this.input.clientHeight}px`;
  }

  setCovered(covered: boolean): void {
    this.covered = covered;
    if (covered) this.preview.stop();
    else if (this.snapshot) this.render(this.snapshot, this.selectedId, true);
  }

  /** 머리나 본문의 무언가를 누르고 있는 중인지(pointerdown 과 pointerup 사이). */
  private pressing = false;
  /** 사용자가 하던 일을 끊지 않으려고 다시 그리기를 미뤄 두었다. */
  private held = false;

  focusComposer(): boolean {
    if (!this.docked) return false;
    this.input.focus();
    return true;
  }

  /** force: 사용자가 창 안에서 한 일(펼치기, 보내기)에 따른 다시 그리기 — 미루지 않는다. */
  render(snapshot: WorldSnapshot, selectedId: string | null, force = false): void {
    // 창은 스냅샷마다 머리와 본문을 새로 짓는다. 사용자가 그 안의 글을 골라 두었거나 단추를 누르는 중이면, 다시 지으면
    // 고른 것이 풀리고 누르던 단추가 발밑에서 바뀌어 클릭이 사라진다. 같은 대상을 보고 있는 동안에는 미뤄 둔다.
    if (!force && selectedId === this.selectedId && !this.root.hidden && this.interacting()) {
      this.snapshot = snapshot;
      this.held = true;
      return;
    }
    this.held = false;
    // 스크롤 위치는 본문을 짓기 전에 읽는다 — 다시 쓰는 노드(응답 글·미리보기)가 새 본문으로 옮겨 가는 순간
    // 옛 본문이 짧아져, 그 뒤에 읽으면 이미 위로 밀린 값이 나온다.
    const top = selectedId === this.selectedId ? this.body.scrollTop : 0;
    // 보던 자리를 붙든다. 스크롤 값만 되돌리면 그 위의 덩어리(바뀐 응답 글, 맨 위에 새 줄이 붙은 활동 로그)의 높이가
    // 바뀐 만큼 보던 글이 위아래로 밀린다. 펼친 원문은 옛 본문에서 빠져나가기 전에, 짓기 전에 잰다.
    const pin = selectedId === this.selectedId ? this.pinPoint() : undefined;
    if (selectedId !== this.selectedId) {
      this.open.prompt = this.open.reply = this.open.screen = false;
      this.sent = null;
      this.logOpen = null;
      this.logText.clear();
    }
    this.snapshot = snapshot;
    this.selectedId = selectedId;

    const agent = selectedId ? snapshot.agents.find((a) => a.id === selectedId) : undefined;
    const pane = !agent && selectedId ? snapshot.panes.find((p) => p.id === selectedId) : undefined;
    const ws = selectedId?.startsWith("ws:") ? snapshot.workspaces.find((w) => workspaceKey(w.id) === selectedId) : undefined;

    let wantPreview: string | null = null;
    if (agent) wantPreview = this.renderAgent(agent);
    else if (pane) wantPreview = this.renderShell(pane);
    else if (ws) this.renderHouse(ws);
    else {
      this.root.hidden = true;
      this.setDock(null);
      this.preview.stop();
      return;
    }
    this.root.hidden = false;
    this.body.scrollTop = top;
    if (pin) {
      const el = pin.node?.isConnected ? pin.node : [...this.body.querySelectorAll<HTMLElement>("[data-k]")].find((e) => e.dataset.k === pin.key);
      if (el) this.body.scrollTop += el.getBoundingClientRect().top - pin.top;
    }
    // 접기를 눌렀으면 접힌 그 줄이 보이는 자리로 돌아간다 — 긴 원문의 끝에서 접어도 길을 잃지 않게.
    if (this.logReveal?.isConnected) this.logReveal.scrollIntoView({ block: "nearest" });
    this.logReveal = null;

    // 에이전트의 미리보기는 상태줄을 접지 않고 보여 준다. 확인 필요일 때도 같다 — 질문 카드는 입력창 위에 떠 상태줄이
    // 그대로 남고, 입력창을 대신해 뜨는 대화상자는 footerStart 가 입력창 모양이 아니라고 보고 평소대로 접는다.
    const fitFooter = agent !== undefined;
    if (fitFooter !== this.preview.fitFooter) {
      this.preview.fitFooter = fitFooter;
      this.preview.redraw();
    }
    if (wantPreview && !this.covered) this.preview.start(wantPreview);
    else this.preview.stop();
    this.preview.restoreScroll();

    const control = snapshot.control;
    if (agent?.paneId && control) this.setDock({ paneId: agent.paneId, agent: true });
    else if (pane && control) this.setDock({ paneId: pane.id, agent: false });
    else this.setDock(null);
    if (agent) this.confirmDelivery(agent);
  }

  // ── 도크 ───────────────────────────────────────────────────────────────────────────────────

  private setDock(target: { paneId: string; agent: boolean } | null): void {
    const same = target?.paneId === this.docked?.paneId && target?.agent === this.docked?.agent;
    this.docked = target;
    this.dock.hidden = target === null;
    this.attachBtn.hidden = !target?.agent;
    if (same || !target) return;
    this.setInput("");
    this.clearShots();
    this.input.placeholder = target.agent ? t("Enter 전송 · Shift+Enter 줄바꿈") : t("Enter 실행");
    this.sendBtn.textContent = target.agent ? t("보내기") : t("실행");
    this.setNote("", "");
  }

  private setNote(text: string, tone: "" | "ok" | "err" | "wait"): void {
    this.note.replaceChildren(...(tone === "ok" && text ? [icon("check")] : []), text);
    this.note.dataset.tone = tone;
    this.note.hidden = text === "";
  }

  /** 이미지를 서버에 맡기고 입력창 위에 작게 보여 준다. 올라가는 동안에도 글은 계속 칠 수 있다. */
  private attach(files: File[]): void {
    const target = this.docked;
    if (!target?.agent) return;
    for (const file of files) {
      if (this.shots.length >= MAX_SHOTS) {
        this.setNote(t("이미지는 한 번에 {n}장까지 붙일 수 있습니다.", { n: MAX_SHOTS }), "err");
        break;
      }
      const url = URL.createObjectURL(file);
      const remove = h("button", { type: "button", title: t("이미지 빼기"), "aria-label": t("이미지 빼기") }, icon("close"));
      const shot: (typeof this.shots)[number] = { url, el: h("div", { class: "shot busy" }, h("img", { src: url, alt: t("붙인 이미지") }), remove) };
      const drop = () => {
        this.shots = this.shots.filter((s) => s !== shot);
        shot.el.remove();
        URL.revokeObjectURL(url);
        this.shotsEl.hidden = this.shots.length === 0;
      };
      remove.addEventListener("click", drop);
      this.shots.push(shot);
      this.shotsEl.append(shot.el);
      this.shotsEl.hidden = false;
      uploadImage(target.paneId, file).then(
        (id) => {
          shot.id = id;
          shot.el.classList.remove("busy");
        },
        (e: Error) => {
          drop();
          // 올리는 사이에 화면을 다시 그리면 docked 가 새 객체가 된다 — 값으로 견준다.
          if (this.docked?.paneId === target.paneId && this.docked.agent === target.agent) this.setNote(e.message, "err");
        },
      );
    }
    this.input.focus();
  }

  private clearShots(): void {
    for (const shot of this.shots) URL.revokeObjectURL(shot.url);
    this.shots = [];
    this.shotsEl.replaceChildren();
    this.shotsEl.hidden = true;
  }

  private async submit(): Promise<void> {
    const target = this.docked;
    const text = this.input.value;
    const shots = target?.agent ? this.shots : [];
    if (!target || (!text.trim() && shots.length === 0) || this.busy) return;
    if (shots.some((s) => !s.id)) {
      this.setNote(t("이미지를 올리는 중입니다. 잠시 뒤에 다시 보내 주세요."), "wait");
      return;
    }
    this.busy = true;
    this.sendBtn.disabled = true;
    // 보내는 동안 새 스냅샷이 오면 화면을 다시 그리면서 docked 가 새 객체로 바뀐다. 같은 대상인지는 값으로 견준다 —
    // 객체로 견주면 그때마다 "다른 대상"이 되어, 보낸 글이 입력창에 남는다.
    const still = (): boolean => this.docked?.paneId === target.paneId && this.docked.agent === target.agent;
    try {
      if (target.agent) {
        await post("/api/prompt", { paneId: target.paneId, text, ...(shots.length ? { images: shots.map((s) => s.id) } : {}) });
        this.sent = { text, at: Date.now(), confirmed: false, before: this.snapshot?.agents.find((a) => a.paneId === target.paneId)?.lastPrompt };
        this.setNote(t("보냈습니다. 에이전트가 받으면 여기에 표시됩니다…"), "wait");
        if (still()) this.clearShots();
      } else {
        await sendInput(target.paneId, { text, keys: ["enter"] });
        this.setNote("", "");
        this.open.screen = true;
      }
      // 보내는 사이에 이어서 친 글이 있으면 그것은 남긴다.
      if (still()) this.setInput(this.input.value.startsWith(text) ? this.input.value.slice(text.length) : this.input.value);
    } catch (e) {
      if (e instanceof ApiError && e.code === "agent_blocked") {
        this.setNote(t("에이전트가 질문에 대한 답을 기다리는 중입니다. 화면의 선택지를 위 키로 먼저 눌러 주세요."), "err");
        this.open.screen = true;
      } else {
        this.setNote((e as Error).message, "err");
        if (e instanceof ApiError && (e.code === "image_not_attached" || e.code === "prompt_unconfirmed")) this.open.screen = true;
      }
    } finally {
      this.busy = false;
      this.sendBtn.disabled = false;
      if (this.snapshot) this.render(this.snapshot, this.selectedId, true);
    }
  }

  /** 보낸 말이 실제로 들어갔는지는 herdr 의 응답이 아니라 로그에 찍힌 사용자 턴으로 확인한다. */
  private confirmDelivery(a: AgentView): void {
    const sent = this.sent;
    if (!sent || sent.confirmed) return;
    // 이미지를 붙여 보내면 로그의 사용자 턴 앞에 [Image #N] 표시가 붙는다. 글 없이 이미지만 보냈으면 턴이 바뀐 것으로 안다.
    const logged = a.lastPrompt ? norm(a.lastPrompt.replace(/^(\[Image #\d+\]\s*)+/, "")) : undefined;
    const want = norm(sent.text).slice(0, 32);
    if (logged !== undefined && (want ? logged.startsWith(want) : a.lastPrompt !== sent.before)) {
      sent.confirmed = true;
      this.setNote(t("에이전트가 받았습니다."), "ok");
    } else if (!a.hasLog && a.status === "working") {
      sent.confirmed = true;
      this.setNote(t("에이전트가 일하기 시작했습니다."), "ok");
    } else if (Date.now() - sent.at > 12_000) {
      this.setNote(t("아직 받은 흔적이 없습니다. 터미널 화면에서 입력창에 그대로 남아 있는지 확인해 보세요."), "err");
    }
  }

  // ── 에이전트 ───────────────────────────────────────────────────────────────────────────────

  private setHead(tile: Node, title: string, sub: string): void {
    const close = h("button", { class: "btn icon close", type: "button", title: t("닫기 (Esc)"), "aria-label": t("닫기 (Esc)") }, icon("close"));
    close.addEventListener("click", () => this.callbacks.act({ type: "select", id: null }));
    // 휴대폰에서는 상태 창이 화면을 다 덮어 목록이 가려진다. 창을 닫지 않고 목록을 꺼내 다른 에이전트로 옮겨 가게 한다.
    // 가장자리·아래쪽에서 끌어내는 몸짓은 휴대폰의 뒤로 가기·홈 몸짓과 겹쳐 단추로 둔다. 넓은 화면에서는 숨는다.
    const roster = h("button", { class: "btn icon roster-open", type: "button", title: t("에이전트 목록"), "aria-label": t("에이전트 목록") }, icon("menu"));
    roster.addEventListener("click", () => this.callbacks.act({ type: "roster" }));
    // 제목은 두 줄까지, 버금줄은 한 줄. 넘치는 글은 말풍선으로 다 보인다.
    this.head.replaceChildren(roster, tile, h("div", { class: "d-title" }, h("h2", { title }, title), h("p", { title: sub }, sub)), close);
  }

  /** 다시 쓰는 노드는 제자리에 두고 그 앞뒤만 바꾼다. replaceChildren 은 모두 떼었다 붙여, 붙어 있던 노드 안의
   *  가로 스크롤(표·코드 블록)이 처음으로 돌아가고 밀던 터치가 끊긴다. */
  private setBody(...children: Child[]): void {
    const next = children.filter((c): c is Node | string => Boolean(c)).map((c) => (typeof c === "string" ? document.createTextNode(c) : c));
    const keep = new Set(next);
    for (const old of [...this.body.childNodes]) if (!keep.has(old)) old.remove();
    let at = this.body.firstChild;
    for (const node of next) {
      if (node === at) at = at.nextSibling;
      else this.body.insertBefore(node, at);
    }
  }

  private button(label: string, onClick: () => void, opts: { cls?: string; title?: string; disabled?: boolean; icon?: IconName } = {}): HTMLButtonElement {
    const btn = h("button", { class: opts.cls ?? "btn", type: "button" }, opts.icon ? icon(opts.icon) : null, opts.icon ? h("span", {}, label) : label);
    if (opts.title) btn.title = opts.title;
    btn.disabled = opts.disabled === true;
    btn.addEventListener("click", onClick);
    return btn;
  }

  /** 상태 창을 그리고, 실시간 미리보기를 붙일 pane id 를 돌려준다(없으면 null). */
  private renderAgent(a: AgentView): string | null {
    // 버금줄은 어느 집의 누구인지만: 하네스 이름은 옆 로고(말풍선)와 아는 것 카드의 버전 꼬리표에 이미 있고,
    // 스페이스 번호는 무슨 숫자인지 읽히지 않아 뺀다(목록과 마을의 문패에는 그대로 있다).
    const where = a.workspaceNumber ? a.workspaceLabel : t("{name} (herdr 밖)", { name: a.workspaceLabel });
    const tile = brandTile(a.vendor, 36, a.status === "working");
    const harness = brandFor(a.vendor).name;
    tile.setAttribute("role", "img");
    tile.setAttribute("aria-label", harness);
    if (tile instanceof HTMLElement) tile.title = harness;
    else tile.appendChild(document.createElementNS("http://www.w3.org/2000/svg", "title")).textContent = harness;
    this.setHead(tile, a.title, a.name ? `${where} · ${a.name}` : where);

    const source = a.statusSource === "herdr" ? t("herdr 가 알려준 상태") : a.statusSource === "card" ? t("질문 카드가 답을 기다리는 중") : a.statusSource === "prompt" ? t("보낸 첫 지시를 시작하는 중") : t("로그 시각으로 추정한 상태");
    const badge = h("span", { class: "badge", title: source }, a.seen ? t("확인함") : STATUS_LABEL[a.status]);
    badge.style.setProperty("--c", STATUS_VAR[a.status]);
    // 상태의 출처는 herdr 가 알려 준 평소의 경우에는 적지 않는다 — 다른 데서 짐작한 때에만 눈여겨볼 값이다.
    const statusLine = h("div", { class: "status-line" }, badge, h("span", { class: "age" }, statusAge(a)), a.statusSource === "herdr" ? null : h("span", { class: "src" }, source));
    if (a.seen && a.paneId) {
      const undo = this.button(t("되돌리기"), () => this.callbacks.act({ type: "seen", paneId: a.paneId!, undo: true }), { cls: "link" });
      statusLine.append(undo);
    }

    const blocked = a.status === "blocked" && a.paneId !== undefined;
    const now = a.status === "working" ? bubbleParts(a) : null;
    // 지금 하는 일은 한 줄로 자른다 — 글 길이를 따라 높이가 바뀌면 갱신마다 그 아래가 위아래로 들썩인다. 다 보려면
    // 활동 로그의 맨 윗줄을 눌러 펼친다.
    const nowEl = now ? h("div", { class: "now line", title: now.text }, ...(now.icon ? [icon(now.icon)] : []), now.text) : null;
    // 열쇠(data-k)는 다시 지은 본문에서 보던 덩어리를 다시 찾는 데 쓴다(pinPoint).
    const keyed: Array<[string, HTMLElement | null]> = [
      ["status", statusLine],
      ["ask", blocked ? this.askCard(a) : null],
      ["now", nowEl],
      ["facts", this.facts(a)],
      ["actions", this.actions(a)],
      ["prompt", a.lastPrompt ? this.textSection(t("마지막 지시"), a.lastPrompt, "prompt") : null],
      ["reply", a.lastReply ? this.textSection(t("마지막 응답"), a.lastReply, "reply") : null],
      ["screen", a.paneId && !blocked ? this.screenSection(a.paneId) : null],
      ["log", a.recent.length > 0 ? this.logSection(a) : null],
    ];
    for (const [k, el] of keyed) if (el) el.dataset.k = k;
    this.setBody(...keyed.map(([, el]) => el));
    return a.paneId && (blocked || this.open.screen) ? a.paneId : null;
  }

  /** 확인 필요: 무엇을 묻는지 — 로그에 남은 요청과, 화면에 떠 있는 대화상자를 함께 보여 준다. */
  private askCard(a: AgentView): HTMLElement {
    const big = this.button(t("크게 보기"), () => this.callbacks.act({ type: "terminal", paneId: a.paneId! }), { cls: "", icon: "expand" });
    const card = h("section", { class: "ask" }, h("h3", {}, t("답을 기다리고 있어요"), big));
    if (a.pending) card.append(this.pendingBlock(a.pending));
    card.append(this.preview.el, h("p", { class: "hint" }, this.snapshot?.control ? t("대화상자에 적힌 번호·키를 아래 버튼으로 누르거나, 크게 보기에서 직접 입력하세요.") : t("보기 전용이라 여기서는 답할 수 없습니다. herdr 에서 열어 답해 주세요.")));
    return card;
  }

  private pendingBlock(p: PendingRequest): HTMLElement {
    const box = h("div", { class: "pending" }, h("b", {}, p.tool));
    if (p.questions?.length) {
      for (const q of p.questions) {
        const list = h("ol", {});
        for (const o of q.options) list.append(h("li", {}, h("b", {}, o.label), o.description ? ` — ${o.description}` : ""));
        box.append(h("p", {}, q.question), list);
      }
    } else if (p.detail) box.append(h("pre", {}, p.detail));
    return box;
  }

  /** 이 에이전트에 대해 아는 것을 세 덩어리로 모은다: 모델과 effort, 컨텍스트 게이지, 그 밖의 작은 꼬리표들.
   *  이름–값 표로 한 줄씩 세우면 휴대폰에서 창 높이의 절반을 먹어 마지막 지시·응답이 화면 밖으로 밀려난다.
   *  모르는 값은 자리를 만들지 않고, 로그가 없어 비는 까닭은 같은 카드 끝에 적는다. */
  private facts(a: AgentView): HTMLElement | null {
    const card = h("div", { class: "spec" });
    const top: Child[] = [];
    if (a.model) top.push(h("b", { class: "model" }, a.model));
    if (a.effort) {
      const level = effortLevel(a.effort);
      const pips = h("span", { class: "pips" });
      for (let i = 1; i <= 5; i += 1) pips.append(h("i", i <= level ? { class: "on" } : {}));
      top.push(h("span", { class: "effort", title: t("Effort") }, level > 0 ? pips : null, a.effort));
    }
    // 모델은 턴 사이에만 바꾼다. 그 세션에만 바꾸는 길이 없는 하네스(agy)는 띄울 때만 고른다.
    let change: HTMLButtonElement | null = null;
    if (a.paneId && this.snapshot?.control && LIVE_MODEL_KINDS.includes(a.vendor)) {
      const busy = a.status === "working" || a.status === "blocked";
      change = this.button(t("바꾸기…"), () => this.callbacks.act({ type: "model", agent: a }), {
        cls: "link",
        disabled: busy,
        title: busy ? t("일하는 중이거나 답을 기다리는 동안에는 모델을 바꾸지 않습니다") : t("이 세션의 모델과 사고 수준을 바꿉니다 — 이 세션에만 적용됩니다"),
      });
      if (!a.model) top.unshift(h("span", { class: "k" }, t("모델")));
    }
    if (top.length > 0) card.append(h("div", { class: "spec-top" }, ...top, change));
    if (a.contextTokens) {
      const used = a.contextWindow ? Math.round((a.contextTokens / a.contextWindow) * 100) : 0;
      const text = a.contextWindow ? `${tokens(a.contextTokens)} / ${tokens(a.contextWindow)} · ${used}%` : t("{n} 토큰", { n: tokens(a.contextTokens) });
      let meter: HTMLElement | null = null;
      if (a.contextWindow) {
        const bar = h("i");
        bar.style.width = `${Math.min(100, (a.contextTokens / a.contextWindow) * 100).toFixed(1)}%`;
        meter = h("span", { class: "meter" }, bar);
      }
      card.append(h("div", { class: "spec-ctx" }, h("span", { class: "k" }, t("컨텍스트")), meter, h("span", { class: "v" }, text)));
    }

    const tags: Array<{ k: string; v: string; mono?: boolean }> = [];
    if (a.permissionMode) tags.push({ k: t("권한"), v: a.permissionMode });
    if (a.subagents > 0) tags.push({ k: t("서브에이전트"), v: t("{n}개 실행 중", { n: a.subagents }) });
    if (a.branch) tags.push({ k: t("브랜치"), v: a.branch, mono: true });
    if (a.cwd) tags.push({ k: t("폴더"), v: shortPath(a.cwd), mono: true });
    if (a.harnessVersion) tags.push({ k: brandFor(a.vendor).name, v: a.harnessVersion, mono: true });
    if (a.paneId) {
      // 탭·pane 이름이 머리의 제목과 같으면(auto-title 이 셋을 같이 짓는다) 다시 적지 않는다.
      const same = (label?: string): boolean => !label || label === a.title || label.endsWith(` · ${a.title}`);
      const tab = same(a.tabLabel) ? undefined : a.tabLabel;
      const pane = same(a.paneLabel) || a.tabLabel?.endsWith(a.paneLabel!) ? undefined : a.paneLabel;
      tags.push({ k: t("Pane"), v: [a.paneId, tab, pane].filter(Boolean).join(" · "), mono: true });
    }
    if (tags.length > 0) {
      const list = h("div", { class: "spec-tags" });
      for (const tag of tags) list.append(h("span", { class: "spec-tag" }, h("span", { class: "k" }, tag.k), h("span", tag.mono ? { class: "v mono" } : { class: "v" }, tag.v)));
      card.append(list);
    }

    if (!a.hasLog) {
      const note = a.sessionId
        ? t("이 세션의 로그 파일을 아직 찾지 못했습니다. 모델과 활동은 로그가 생기면 채워집니다.")
        : a.readable
          ? t("herdr 가 아직 이 에이전트의 세션 id 를 알려 주지 않았습니다. 알려 주면 모델과 활동이 채워집니다.")
          : t("이 하네스의 로그는 아직 읽지 못합니다. herdr 가 알려 준 제목과 상태만 보여 줍니다.");
      card.append(h("div", { class: "fact-note" }, icon("info"), h("span", {}, note)));
    }
    return card.childElementCount > 0 ? card : null;
  }

  /** 글 없이 아이콘만 든 단추. 무엇을 하는지는 말풍선과 읽어 주는 이름으로 남긴다. */
  private tool(name: IconName, label: string, onClick: () => void, danger = false): HTMLButtonElement {
    const btn = h("button", { class: danger ? "btn icon danger" : "btn icon", type: "button", title: label, "aria-label": label }, icon(name));
    btn.addEventListener("click", onClick);
    return btn;
  }

  /** 할 일은 한 줄에: 앞의 큰 단추 하나와 뒤의 아이콘 단추들. 완료면 큰 단추는 "확인 완료"이고 herdr 로 옮겨 가기는
   *  아이콘으로 물러난다 — 큰 단추가 둘이면 휴대폰 폭에서 아이콘 묶음이 다음 줄로 밀려 줄이 하나 더 생긴다. */
  private actions(a: AgentView): HTMLElement {
    const control = this.snapshot?.control === true;
    const row = h("div", { class: "actions" });
    const tools = h("div", { class: "tools" });
    const openTitle = !a.paneId ? t("herdr 밖에서 도는 세션이라 옮겨 갈 pane 이 없습니다.") : control ? t("herdr 화면을 이 pane 으로 옮깁니다 (Enter)") : t("보기 전용으로 띄운 서버라 herdr 화면을 옮기지 않습니다.");
    const openHerdr = (): void => this.callbacks.act({ type: "open-herdr", agent: a });
    if (a.status === "done" && a.paneId && control) {
      row.append(this.button(t("확인 완료"), () => this.callbacks.act({ type: "seen", paneId: a.paneId!, undo: false }), { cls: "btn primary", icon: "check", title: t("읽었다고 표시하고 집으로 돌려보냅니다 (D)") }));
      const open = this.tool("open", t("herdr 에서 열기"), openHerdr);
      open.title = `${t("herdr 에서 열기")} — ${openTitle}`;
      tools.append(open);
    } else {
      row.append(this.button(t("herdr 에서 열기"), openHerdr, { cls: "btn primary", icon: "open", disabled: !a.paneId || !control, title: openTitle }));
    }
    if (a.sessionId) {
      const id = a.sessionId;
      tools.append(this.tool("copy", t("세션 ID 복사"), () => this.copy(id, id)));
    }
    if (a.paneId && control) {
      const paneId = a.paneId;
      tools.append(
        this.tool("pencil", t("이 pane 의 이름을 바꿉니다"), () => this.callbacks.act({ type: "rename", kind: "pane", id: paneId, current: a.paneLabel ?? "", what: t("pane 이름") })),
        this.tool("house", t("집 보기"), () => this.callbacks.act({ type: "select", id: workspaceKey(a.workspaceId) })),
        this.tool("trash", t("이 pane 을 닫습니다 — 에이전트도 함께 꺼집니다"), () => this.callbacks.act({ type: "close", kind: "pane", id: paneId }), true),
      );
    }
    if (tools.childElementCount > 0) row.append(tools);
    return h("div", { class: "action-group" }, row);
  }

  /** what: 토스트에 띄울 말 — 짧은 값은 그대로, 긴 글은 섹션 이름. */
  private copy(text: string, what: string): void {
    navigator.clipboard.writeText(text).then(
      () => this.callbacks.toast(t("복사했습니다"), what, "var(--accent)"),
      () => this.callbacks.toast(t("복사하지 못했습니다"), what, "var(--blocked)"),
    );
  }

  private textSection(title: string, text: string, key: "prompt" | "reply"): HTMLElement {
    const long = text.length > 420 || text.split("\n").length > 8;
    // 스냅샷이 올 때마다 다시 그리지만 글은 거의 그대로다. 같은 글이면 섹션을 통째로 다시 쓴다 — setBody 가 그 노드를
    // 떼지 않고 두므로, 옆으로 민 표·코드 블록의 스크롤과 밀던 손가락이 그대로 남는다.
    const stamp = `${title}\n${this.open[key]}\n${text}`;
    const made = this.sectionOf[key];
    if (made?.stamp === stamp) return made.el;
    const box = h("div", { class: long && !this.open[key] ? "prose clamp" : "prose" }, prose(text));
    const head = h("h3", {}, title, this.button(t("복사"), () => this.copy(text, title), { cls: "", icon: "copy", title: t("이 글을 클립보드에 복사합니다") }));
    if (long) {
      head.append(
        this.button(this.open[key] ? t("접기") : t("펼치기"), () => {
          this.open[key] = !this.open[key];
          this.rerender();
        }, { cls: "" }),
      );
    }
    const el = h("section", {}, head, box);
    this.sectionOf[key] = { stamp, el };
    return el;
  }

  private logSection(a: AgentView): HTMLElement {
    const list = h("ol", { class: "log" });
    const seen = new Map<string, number>();
    [...a.recent].reverse().forEach((item, i) => {
      const same = `${item.at}\n${item.text}`;
      const n = seen.get(same) ?? 0;
      seen.set(same, n + 1);
      const ref = expandable(item) ? logKey(item, n) : undefined;
      const open = ref !== undefined && ref === this.logOpen;
      const cls = [item.error ? "err" : "", i === 0 ? "latest" : "", ref ? "more" : "", open ? "open" : ""].filter(Boolean).join(" ");
      const { icon: kind, text: line } = activityParts(item);
      const text = h("span", {}, item.error ? t("{line} — 실패", { line }) : line);
      text.title = line;
      const row = h("li", cls ? { class: cls } : {}, h("time", {}, clock(item.at)), kind ? icon(kind) : h("i", {}), text);
      row.dataset.k = `log:${logKey(item, n)}`;
      if (ref) {
        // 줄 전체가 펼치는 단추다. 글을 골라 두고 뗀 손은 펼치지 않는다.
        row.tabIndex = 0;
        row.setAttribute("role", "button");
        row.setAttribute("aria-expanded", String(open));
        row.addEventListener("click", () => {
          if (!window.getSelection()?.isCollapsed) return;
          this.toggleLog(a.id, item, n);
        });
        row.addEventListener("keydown", (e) => {
          if (e.key !== "Enter" && e.key !== " ") return;
          e.preventDefault();
          this.toggleLog(a.id, item, n);
        });
      }
      if (ref && ref === this.logRevealKey) {
        this.logReveal = row;
        this.logRevealKey = null;
      }
      list.append(row);
      if (open) list.append(this.logDetail(a.id, item, n));
    });
    return h("section", {}, h("h3", {}, t("활동 로그")), list);
  }

  /**
   * 다시 지은 뒤에도 화면의 같은 높이에 있어야 할 것 — 펼쳐 읽던 원문이 보이면 그 상자(다시 지어도 같은 노드다),
   * 아니면 화면 위 끝 아래에서 처음 시작하는 덩어리. 걸친 덩어리는 고르지 않는다: 그 안의 글이 바뀌면 높이가 바뀌어도
   * 머리는 그대로라 그 아래가 밀린다. 덩어리는 다시 지으면 새 노드가 되므로 data-k 열쇠로 다시 찾는다. 활동 로그
   * 머리가 보이면 로그가 붙들려 새 줄이 맨 위에 보이며 붙고, 로그 안으로 내려가 있으면 읽던 줄이 붙들린다.
   */
  private pinPoint(): { node?: Element; key?: string; top: number } | undefined {
    const detail = this.visibleLogDetail();
    if (detail) return { node: detail, top: detail.getBoundingClientRect().top };
    const view = this.body.getBoundingClientRect();
    for (const el of this.body.querySelectorAll<HTMLElement>("[data-k]")) {
      const top = el.getBoundingClientRect().top;
      if (top >= view.top) return top < view.bottom ? { key: el.dataset.k, top } : undefined;
    }
    return undefined;
  }

  /** 화면 안에 들어와 있는 펼친 원문 상자. */
  private visibleLogDetail(): HTMLElement | undefined {
    const el = this.logOpen ? this.logText.get(this.logOpen)?.el : undefined;
    if (!el?.isConnected) return undefined;
    const box = el.getBoundingClientRect();
    const view = this.body.getBoundingClientRect();
    return box.bottom > view.top && box.top < view.bottom ? el : undefined;
  }

  private toggleLog(agentId: string, item: Activity, n: number): void {
    const ref = logKey(item, n);
    if (this.logOpen === ref) this.logRevealKey = ref;
    this.logOpen = this.logOpen === ref ? null : ref;
    const got = this.logText.get(ref);
    if (this.logOpen && (!got || got.error)) void this.loadLog(agentId, item, n);
    this.rerender();
  }

  private async loadLog(agentId: string, item: Activity, n: number): Promise<void> {
    const ref = logKey(item, n);
    this.logText.set(ref, {});
    let got: { text?: string; error?: string };
    try {
      const query = new URLSearchParams({ agent: agentId, at: item.at, text: item.text, n: String(n) });
      const res = await fetch(`/api/activity?${query}`, { headers: headers() });
      const body = (await res.json()) as { text?: string; error?: string };
      got = res.ok && typeof body.text === "string" ? { text: body.text } : { error: body.error ?? t("원문을 불러오지 못했습니다.") };
    } catch {
      got = { error: t("서버에 닿지 못해 원문을 불러오지 못했습니다.") };
    }
    // 받는 사이에 다른 주민으로 옮겼으면 버린다(옮길 때 받아 둔 것을 비웠다).
    if (this.selectedId !== agentId || !this.logText.has(ref)) return;
    this.logText.set(ref, got);
    // 사용자가 창 안의 글을 고르는 중이면 다시 그리기를 미루는 평소 경로로 그린다.
    if (this.snapshot) this.render(this.snapshot, this.selectedId);
  }

  /** 펼친 줄 아래의 원문. 응답·지시는 글로, 도구 호출은 입력 그대로 고정폭으로. */
  private logDetail(agentId: string, item: Activity, n: number): HTMLElement {
    const got = this.logText.get(logKey(item, n));
    if (!got || (got.text === undefined && !got.error)) return h("li", { class: "log-detail wait" }, t("원문을 불러오는 중…"));
    if (got.text === undefined) return h("li", { class: "log-detail err" }, got.error ?? "");
    if (got.el) return got.el;
    const raw = got.text;
    const text = raw.replace(OMITTED, (_, n: string) => t("…(약 {n}토큰 생략)…", { n }));
    const body = item.kind === "tool" ? h("pre", {}, text || item.name) : h("div", { class: "prose" }, prose(text));
    const what = t("활동 원문");
    // 단추 줄은 긴 원문을 읽는 내내 위에 붙어 있어, 어디까지 내려가 있든 바로 접을 수 있다.
    const bar = h(
      "div",
      { class: "log-bar" },
      this.button(t("복사"), () => this.copy(raw, what), { cls: "", icon: "copy", title: t("이 원문을 클립보드에 복사합니다") }),
      this.button(t("접기"), () => this.toggleLog(agentId, item, n), { cls: "" }),
    );
    got.el = h("li", { class: "log-detail" }, bar, body);
    return got.el;
  }

  private screenSection(paneId: string): HTMLElement {
    // 접혀 있을 때는 줄 하나가 통째로 펼치는 단추다 — 머리글 끝의 작은 글자를 노리지 않아도 된다.
    if (!this.open.screen) {
      const row = h("button", { class: "disclose", type: "button" }, icon("terminal"), h("span", { class: "label" }, t("터미널 화면")), h("span", { class: "more" }, t("보기")), icon("chevron"));
      row.addEventListener("click", () => {
        this.open.screen = true;
        this.rerender();
      });
      return h("section", {}, row);
    }
    const head = h(
      "h3",
      {},
      t("터미널 화면"),
      this.button(t("숨기기"), () => {
        this.open.screen = false;
        this.rerender();
      }, { cls: "" }),
      this.button(t("크게 보기"), () => this.callbacks.act({ type: "terminal", paneId }), { cls: "", icon: "expand" }),
    );
    return h("section", {}, head, this.preview.el);
  }

  private rerender(): void {
    if (this.snapshot) this.render(this.snapshot, this.selectedId, true);
  }

  // ── 셸 pane ────────────────────────────────────────────────────────────────────────────────

  private renderShell(p: PaneView): string {
    const snap = this.snapshot!;
    const ws = snap.workspaces.find((w) => w.id === p.workspaceId);
    const tab = snap.tabs.find((tb) => tb.id === p.tabId);
    this.setHead(h("span", { class: "shell-tile big" }, ">_"), p.label || p.title || t("터미널"), t("셸 · {where}", { where: ws ? ws.label : p.workspaceId }));
    const rows: Fact[] = [
      { label: t("Pane"), value: tab?.label ? `${p.id} · ${tab.label}` : p.id, mono: true },
      { label: t("크기"), value: p.cols && p.rows ? `${p.cols} × ${p.rows}` : "—", mono: true },
    ];
    if (p.cwd) rows.push({ label: t("작업 폴더"), value: shortPath(p.cwd), mono: true });
    const dl = factCard(rows);
    const parts: Child[] = [dl];
    if (snap.control) {
      parts.push(
        h(
          "div",
          { class: "action-group" },
          h(
            "div",
            { class: "actions" },
            this.button(t("여기서 에이전트 시작"), () => this.callbacks.act({ type: "new-agent", workspaceId: p.workspaceId, paneId: p.id }), { cls: "btn primary", icon: "play" }),
            this.button(t("터미널 크게 보기"), () => this.callbacks.act({ type: "terminal", paneId: p.id }), { icon: "expand" }),
          ),
          h(
            "div",
            { class: "actions minor" },
            this.button(t("이름"), () => this.callbacks.act({ type: "rename", kind: "pane", id: p.id, current: p.label ?? "", what: t("pane 이름") }), { icon: "pencil" }),
            this.button(t("옆으로 나누기"), () => this.callbacks.act({ type: "split", paneId: p.id, direction: "right" }), { icon: "splitRight" }),
            this.button(t("아래로 나누기"), () => this.callbacks.act({ type: "split", paneId: p.id, direction: "down" }), { icon: "splitDown" }),
            this.button(t("닫기"), () => this.callbacks.act({ type: "close", kind: "pane", id: p.id }), { cls: "btn danger", icon: "close" }),
          ),
        ),
      );
    }
    parts.push(h("section", {}, h("h3", {}, t("터미널 화면")), this.preview.el));
    this.setBody(...parts);
    return p.id;
  }

  // ── 집(스페이스) ───────────────────────────────────────────────────────────────────────────

  private renderHouse(ws: WorkspaceView): void {
    const snap = this.snapshot!;
    const agents = snap.agents.filter((a) => a.workspaceId === ws.id);
    const panes = snap.panes.filter((p) => p.workspaceId === ws.id);
    const sub = ws.managed ? `${t("스페이스 {n}", { n: ws.number })}${ws.repo ? ` · ${ws.repo}` : ""}${ws.worktree?.linked ? ` · ${t("워크트리")}` : ""}` : t("herdr 밖의 세션들");
    this.setHead(h("span", { class: "house-tile" }, icon("house")), ws.label, sub);

    const parts: Child[] = [];
    if (ws.topic) parts.push(h("div", { class: "now" }, ws.topic));
    if (ws.worktree?.path) {
      parts.push(factCard([{ label: t("체크아웃"), value: shortPath(ws.worktree.path), mono: true }]));
    }
    if (ws.managed && snap.control) {
      parts.push(
        h(
          "div",
          { class: "action-group" },
          h(
            "div",
            { class: "actions" },
            this.button(t("새 주민"), () => this.callbacks.act({ type: "new-agent", workspaceId: ws.id }), { cls: "btn primary", icon: "plus", title: t("이 집에 에이전트를 하나 더 들입니다") }),
            this.button(t("새 탭"), () => this.callbacks.act({ type: "new-tab", workspaceId: ws.id }), { icon: "plus", title: t("셸만 있는 새 탭을 엽니다") }),
          ),
          h(
            "div",
            { class: "actions minor" },
            this.button(t("이름"), () => this.callbacks.act({ type: "rename", kind: "workspace", id: ws.id, current: ws.label, what: t("집 이름") }), { icon: "pencil" }),
            this.button(t("철거"), () => this.callbacks.act({ type: "close", kind: "workspace", id: ws.id }), { cls: "btn danger", icon: "trash", title: t("이 스페이스를 닫습니다") }),
          ),
        ),
      );
    }

    const row = (tile: Node, title: string, sub2: string, id: string, status?: AgentView["status"]): HTMLElement => {
      const el = h("button", { class: "prow", type: "button" }, tile, h("span", { class: "title" }, title), h("span", { class: "sub" }, sub2));
      if (status) el.dataset.status = status;
      el.addEventListener("click", () => this.callbacks.act({ type: "select", id }));
      return el;
    };
    if (ws.managed) {
      const wsTabs = snap.tabs.filter((tb) => tb.workspaceId === ws.id);
      for (const [i, tab] of wsTabs.entries()) {
        // herdr 의 tab.number 는 만든 순번이라 닫힌 탭만큼 건너뛴다(두 번째 탭이 3). herdr 화면의 번호는 목록 순서이고,
        // 이름을 짓지 않은 탭의 label 은 herdr 가 "<순서> · <제목>" 으로 채운다. 그 앞머리를 떼어 번호가 두 번 찍히지 않게 한다.
        const n = i + 1;
        const prefix = `${n} · `;
        const label = tab.label.startsWith(prefix) ? tab.label.slice(prefix.length) : tab.label;
        const text = `${t("탭 {n}", { n })}${label ? ` · ${label}` : ""}`;
        const head = h("h3", {}, h("span", { class: "label", title: text }, text));
        if (snap.control) {
          head.append(
            this.button(t("이름"), () => this.callbacks.act({ type: "rename", kind: "tab", id: tab.id, current: label, what: t("탭 이름") }), { cls: "" }),
            this.button(t("닫기"), () => this.callbacks.act({ type: "close", kind: "tab", id: tab.id }), { cls: "" }),
          );
        }
        const section = h("section", { class: "tab" }, head);
        for (const p of panes.filter((x) => x.tabId === tab.id)) {
          const a = p.agentId ? agents.find((x) => x.id === p.agentId) : undefined;
          if (a) section.append(row(brandTile(a.vendor, 26, a.status === "working"), a.title, `${a.seen ? t("확인함") : STATUS_LABEL[a.status]} · ${statusAge(a)}`, a.id, a.status));
          else section.append(row(h("span", { class: "shell-tile" }, ">_"), p.label || p.title || t("터미널"), t("셸 · {where}", { where: shortPath(p.cwd) }), p.id));
        }
        parts.push(section);
      }
    } else {
      const section = h("section", {}, h("h3", {}, t("세션")));
      for (const a of agents) section.append(row(brandTile(a.vendor, 26, a.status === "working"), a.title, `${STATUS_LABEL[a.status]} · ${statusAge(a)}`, a.id, a.status));
      parts.push(section);
    }
    this.setBody(...parts);
  }
}
