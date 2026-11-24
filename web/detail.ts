// 오른쪽 상태 창. 고른 것이 에이전트면 상태·응답·터미널과 대화 입력을, 셸 pane 이면 터미널과 명령 입력을,
// 집(스페이스)이면 그 안의 탭과 pane 목록을 보여 준다.
//
// 스냅샷이 올 때마다 위쪽(머리·본문)은 다시 그리지만, 아래쪽 도크(빠른 키·입력창)는 고른 대상이 바뀔 때만
// 새로 만든다 — 치고 있던 글과 초점이 스냅샷에 쓸려 가지 않게.
import { type Activity, type AgentView, LIVE_MODEL_KINDS, type PaneView, type PendingRequest, type SkillView, type WorkspaceView, type WorldSnapshot } from "../shared/types.ts";
import { ApiError, get, headers, post, sendInput, uploadImage } from "./api.ts";
import { brandFor, brandTile } from "./brands.ts";
import { setLogoActive } from "./logos.ts";
import { buzzConfirm, tapOnPress } from "./haptic.ts";
import { type Child, type IconName, STATUS_VAR, fitCompose, growCompose, h, icon, prose, store, stored } from "./dom.ts";
import { STATUS_LABEL, activityParts, bubbleParts, clock, effortLevel, shortPath, statusAge, tokens } from "./format.ts";
import { t } from "./i18n.ts";
import { TermScreen } from "./term.ts";

export type TargetKind = "workspace" | "tab" | "pane" | "agent";

export type Action =
  | { type: "select"; id: string | null }
  | { type: "open-herdr"; agent: AgentView }
  | { type: "terminal"; paneId: string }
  | { type: "plan"; agent: AgentView }
  | { type: "artifact"; agent: AgentView }
  | { type: "review"; agent: AgentView }
  | { type: "approve-plan"; agent: AgentView }
  | { type: "new-agent"; workspaceId: string; paneId?: string }
  | { type: "new-tab"; workspaceId: string }
  | { type: "new-worktree"; workspace: WorkspaceView }
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

/**
 * 미리보기에 그리는 화면의 아랫줄 수. 상자(스타일시트의 .term.preview, 높이 상한 320px — 글이 놓이는 안쪽은 298px)를 늘
 * 넘치게 채우는 수다: 모든 줄이 8px 로 줄어든 표·상태줄이어도(줄 높이 9.76px) 32줄이면 312px 이다. 모자라게 그리면(18줄이던
 * 때) 상자 높이가 줄이 접힌 수를 따라가, 스피너 옆 글이나 상태줄의 숫자가 바뀔 때마다 상자 아래 끝과 그 밑의 것이 위아래로
 * 흔들린다(휴대폰 폭에서 0.4초마다 302↔320px). 넘치면 상자는 상한에 머물고 아래에 붙은 채 위쪽만 밀린다.
 */
/** 주 포인터가 손가락인 기기(휴대폰·태블릿). 화면 자판으로 쓰므로 Shift+Enter 를 칠 수 없다. */
const touchFirst = matchMedia("(pointer: coarse)");
const PREVIEW_LINES = 32;
/** 받아 둔 스킬 목록을 다시 쓰는 시간. 세션이 플러그인을 다시 읽으면 목록이 바뀐다. */
const SKILLS_TTL_MS = 30_000;
const STAGE_OFF_KEY = "agent-world.stage-off";
/** 미리보기가 이만큼(px) 넘게 보이면 다시 그릴 때 그것을 제자리에 붙든다(pinPoint). 상자 높이의 절반쯤이다. */
const PIN_SCREEN_PX = 160;
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
  private readonly skillPop = h("div", { class: "skill-pop", role: "listbox", "aria-label": t("스킬"), hidden: "" });
  /** 스킬을 고를 수 있는 에이전트(지금은 Claude Code 만). */
  private skillAgent: string | null = null;
  private readonly skillCache = new Map<string, { at: number; skills: SkillView[] }>();
  private skillLoading: string | null = null;
  private headKey = "";
  private headTile: Element | undefined;
  private headTitle: HTMLElement | undefined;
  private headSub: HTMLElement | undefined;
  /** 지금 목록에 보이는 스킬과 고른 줄. */
  private skillShown: SkillView[] = [];
  private skillActive = -1;
  /** 목록을 거른 글자(빗금 뒤, 소문자). */
  private skillQuery = "";
  /** 쓰던 글이 있을 때 단추로 연 목록 — 거르지 않고 다 보이며, 고른 스킬을 그 글 앞에 붙인다. */
  private readonly note = h("div", { class: "dock-note" });
  /** 보낼 말에 붙인 이미지들. id 는 서버가 맡아 준 뒤에 생긴다. */
  private readonly shotsEl = h("div", { class: "shots", hidden: "" });
  private shots: Array<{ id?: string; url: string; el: HTMLElement }> = [];
  private readonly preview = new TermScreen({ tail: PREVIEW_LINES, ride: true });
  /** 지어 둔 질문 카드와 그 내용(askCard). */
  private asked: { sig: string; el: HTMLElement } | undefined;
  /** 지어 둔 터미널 화면 칸(screenSection). */
  private screened: { sig: string; el: HTMLElement } | undefined;
  /** 터미널 크게 보기에 덮여 있다 — 같은 화면을 두 번 읽지 않도록 미리보기를 쉰다. */
  private covered = false;
  private snapshot: WorldSnapshot | undefined;
  private selectedId: string | null = null;
  /** 도크가 지금 붙어 있는 pane 과 방식. */
  private docked: { paneId: string; agent: boolean } | null = null;
  private sent: { text: string; at: number; confirmed: boolean; before?: string; beforeCommand?: string; beforeStatus?: string } | null = null;
  /** 마지막 응답은 읽으려고 여는 것이라 펼쳐 두고, 필요할 때 접는다. 지시와 터미널 미리보기는 접어 둔다. */
  private readonly open = { prompt: false, reply: true, screen: false };
  private readonly sectionOf: { prompt?: { stamp: string; el: HTMLElement }; reply?: { stamp: string; el: HTMLElement } } = {};
  /** 활동 로그에서 펼친 줄(logKey). 원문은 펼칠 때 서버에서 받아 둔다 — 스냅샷에는 한 줄 요약만 온다. */
  private logOpen: string | null = null;
  /** logKey → 받아 온 원문(받는 중이면 빈 객체). 그려 둔 상자도 같이 둬서 스냅샷마다 다시 짓지 않는다. */
  private readonly logText = new Map<string, { text?: string; error?: string; el?: HTMLElement }>();
  /** 접은 뒤 보이는 자리로 데려올 줄(다시 그린 다음에 쓴다). */
  private logReveal: HTMLElement | null = null;
  private logRevealKey: string | null = null;
  /** 펼치거나 접으려고 누른 줄과 그 줄이 있던 높이 — 다음 다시 그리기는 이 줄을 붙든다(pinPoint 대신). */
  private logPin: { key: string; top: number } | null = null;
  /**
   * 펼친 원문의 단추 줄이 위에 붙었는지 본다 — 원문 맨 위의 표식이 창 위 끝을 넘어가면 붙은 것이다. 붙은 동안만
   * 바탕을 깔아, 평소에는 창의 유리와 같은 색으로 보인다(CSS 의 scroll-state 는 Bun 의 CSS 묶기가 읽지 못한다).
   */
  private readonly stuckWatch = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        const stuck = !e.isIntersecting && e.rootBounds !== null && e.boundingClientRect.top < e.rootBounds.top;
        e.target.nextElementSibling?.classList.toggle("stuck", stuck);
      }
    },
    { root: this.body },
  );
  private busy = false;
  /** 멈추기를 보내고 답을 기다리는 pane — 두 번 누른 것은 한 번만 보내고, 그동안 단추를 잠가 둔다. */
  private readonly stopping = new Set<string>();

  /**
   * 가운데 아래의 무대. 넓은 화면에서는 고른 주민의 터미널 화면을 상태 창 안의 접힌 구획 대신 여기에 띄운다 —
   * 좌우 창 사이의 빈 자리에 "지금 무엇을 하고 있는지"가 흐른다. 화면을 읽는 것은 미리보기 하나뿐이라(같은 TermScreen 을
   * 옮겨 붙인다) 상태 창에서 펼쳐 볼 때와 드는 값이 같다.
   */
  private readonly stageTitle = h("b", {});
  private readonly stageSub = h("span", {});
  private readonly stageBody = h("div", { class: "body" });
  /** 무대를 놓을 자리가 화면에 있다(main 이 창 크기를 보고 알려 준다). */
  private stageRoom = false;
  /** 사용자가 무대를 접어 두었다 — 이 브라우저에 기억한다. */
  private stageOff = stored(STAGE_OFF_KEY) === "1";
  /** 탭이 가려져 있다 — 보이지 않는 화면을 읽지 않는다. */
  private asleep = document.hidden;

  constructor(
    private readonly root: HTMLElement,
    private readonly callbacks: DetailCallbacks,
    private readonly stage?: HTMLElement,
  ) {
    if (stage) {
      const fold = h("button", { class: "btn icon", type: "button", title: t("가운데 화면 접기"), "aria-label": t("가운데 화면 접기") }, icon("fold"));
      // 접으면 상태 창의 터미널 화면 칸을 펼쳐 둔다 — 화면이 사라진 게 아니라 옮겨 간 것이 보이고, 다시 띄우는 단추도 거기 있다.
      fold.addEventListener("click", () => {
        this.open.screen = true;
        this.setStageOff(true);
      });
      const big = this.button(t("크게 보기"), () => this.preview.pane && this.callbacks.act({ type: "terminal", paneId: this.preview.pane }), { cls: "btn", icon: "expand" });
      stage.replaceChildren(h("header", {}, icon("terminal"), h("div", { class: "names" }, this.stageTitle, this.stageSub), big, fold), this.stageBody);
    }
    document.addEventListener("visibilitychange", () => {
      this.asleep = document.hidden;
      if (this.asleep) this.preview.stop();
      else this.rerender();
    });
    // 키 단추는 한 묶음으로 남는 폭을 나눠 쓰고, 터미널 단추는 그 옆에 제 폭으로 선다.
    const keys = h("div", { class: "keys" });
    for (const key of QUICK_KEYS) {
      const btn = key.icon
        ? h("button", { type: "button", title: key.title, "aria-label": key.title }, icon(key.icon), key.caption ? h("span", { "aria-hidden": "true" }, key.caption) : null)
        : h("button", { type: "button", title: key.title }, key.label);
      tapOnPress(btn);
      btn.addEventListener("click", () => {
        if (!this.docked) return;
        void sendInput(this.docked.paneId, { text: key.text, keys: key.keys, raw: key.raw }).catch((e: Error) => this.setNote(e.message, "err"));
      });
      keys.append(btn);
    }
    const term = h("button", { type: "button", class: "wide", title: t("터미널 크게 보기 (`)") }, icon("expand"), h("span", {}, t("터미널")));
    term.addEventListener("click", () => this.docked && this.callbacks.act({ type: "terminal", paneId: this.docked.paneId }));
    this.quick.append(keys, term);

    // 높이를 먼저 맞추고 스킬 목록을 놓는다 — 목록은 입력줄 위의 빈자리를 재서 편다.
    growCompose(this.input);
    this.input.addEventListener("input", () => this.updateSkills());
    this.input.addEventListener("blur", () => this.closeSkills());
    // 단추와 목록을 누르는 동안 입력창이 초점을 잃어 목록이 먼저 닫히지 않게 한다.
    this.skillPop.addEventListener("pointerdown", (e) => e.preventDefault());
    this.input.addEventListener("keydown", (e) => {
      if (this.skillKey(e)) return;
      // 한글을 조합하는 중의 Enter 는 글자를 확정하는 키다.
      if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
      // 화면 자판에는 Shift+Enter 가 없어, 터치 기기에서 지시를 쓸 때는 Enter 가 줄을 바꾸고 보내기는 단추로 한다.
      if (this.docked?.agent && touchFirst.matches) return;
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
    this.dock.append(this.quick, this.shotsEl, h("div", { class: "compose" }, this.attachBtn, this.input, this.sendBtn, this.skillPop), picker, this.note);
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
      // perf-ok: 상태 창 폭을 끄는 동안만, 포인터 움직임을 한 장으로 모은다
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
      // perf-ok: 끌기를 놓은 뒤 한 번 잰다
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
    fitCompose(this.input);
  }

  /** 무대를 놓을 자리가 생겼거나 없어졌다. */
  setStageRoom(room: boolean): void {
    if (room === this.stageRoom) return;
    this.stageRoom = room;
    this.rerender();
  }

  private setStageOff(off: boolean): void {
    this.stageOff = off;
    store(STAGE_OFF_KEY, off ? "1" : null);
    this.rerender();
  }

  /** 터미널 화면을 무대에 띄우는 중인가. */
  private get staged(): boolean {
    return this.stage !== undefined && this.stageRoom && !this.stageOff;
  }

  /** 미리보기를 무대에 올리거나 내린다. 글자 크기가 자리마다 달라 칸 눈금을 다시 맞춘다. */
  private syncStage(on: boolean): void {
    if (!this.stage) return;
    const was = this.preview.el.parentElement === this.stageBody;
    if (on && !was) this.stageBody.append(this.preview.el);
    else if (!on && was) this.preview.el.remove();
    if (this.stage.hidden === on) this.stage.hidden = !on;
    if (on !== this.onStage) {
      this.onStage = on;
      this.preview.refit();
    }
  }

  private onStage = false;

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
    // 활동 로그의 줄을 눌러 다시 그릴 때는 누른 그 줄을 붙든다. 다른 원문을 펼쳐 둔 채 누르면 pinPoint 는 그 원문을
    // 고르는데, 이번에 접혀 빠지므로 기댈 데가 없어져 스크롤이 맨 위로 끌려갔다.
    const pin: { node?: Element; key?: string; top: number } | undefined = selectedId === this.selectedId ? (this.logPin ?? this.pinPoint()) : undefined;
    this.logPin = null;
    if (selectedId !== this.selectedId) {
      this.open.prompt = this.open.screen = false;
      this.open.reply = true;
      this.sent = null;
      this.logOpen = null;
      this.logText.clear();
      this.stuckWatch.disconnect();
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
      this.syncStage(false);
      return;
    }
    // 확인 필요일 때는 질문 카드가 미리보기를 제 안에 품는다 — 답하는 단추 곁에 있어야 한다.
    this.syncStage(this.staged && wantPreview !== null && !this.body.contains(this.preview.el));
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
    if (wantPreview && !this.covered && !this.asleep) this.preview.start(wantPreview);
    else this.preview.stop();
    this.preview.restoreScroll();

    const control = snapshot.control;
    if (agent?.paneId && control) this.setDock({ paneId: agent.paneId, agent: true });
    else if (pane && control) this.setDock({ paneId: pane.id, agent: false });
    else this.setDock(null);
    this.skillAgent = agent?.paneId && control && (agent.vendor === "claude" || agent.vendor === "agy") ? agent.id : null;
    if (this.skillAgent === null) this.closeSkills();
    if (agent) this.confirmDelivery(agent);
  }

  // ── 도크 ───────────────────────────────────────────────────────────────────────────────────

  private setDock(target: { paneId: string; agent: boolean } | null): void {
    const same = target?.paneId === this.docked?.paneId && target?.agent === this.docked?.agent;
    this.docked = target;
    this.dock.hidden = target === null;
    this.attachBtn.hidden = !target?.agent;
    if (same || !target) return;
    this.closeSkills();
    this.setInput("");
    this.clearShots();
    const touch = target.agent && touchFirst.matches;
    this.input.placeholder = !target.agent ? t("Enter 실행") : touch ? t("Enter 줄바꿈 · 보내기 단추로 전송") : t("Enter 전송 · Shift+Enter 줄바꿈");
    this.input.enterKeyHint = touch ? "enter" : target.agent ? "send" : "go";
    this.sendBtn.textContent = target.agent ? t("보내기") : t("실행");
    this.setNote("", "");
  }

  // ── 스킬 고르기 ────────────────────────────────────────────────────────────────────────────

  /** 입력창이 `/글자` 뿐이면 그 글자로 거른 스킬 목록을 띄운다. 다른 글이 되면 닫는다. */
  private updateSkills(): void {
    const typed = /^\/(\S*)$/.exec(this.input.value)?.[1];
    const agent = this.skillAgent;
    if (!agent || typed === undefined) return this.closeSkills();
    const cached = this.skillCache.get(agent);
    if (!cached || Date.now() - cached.at > SKILLS_TTL_MS) this.loadSkills(agent);
    const query = typed.toLowerCase();
    const rank = (s: SkillView): number => {
      const name = s.name.toLowerCase();
      if (name === query) return 0;
      if (!query || name.startsWith(query)) return 1;
      if (name.slice(name.indexOf(":") + 1).startsWith(query)) return 2;
      if (name.includes(query)) return 3;
      return s.description.toLowerCase().includes(query) ? 4 : -1;
    };
    const ranked = (cached?.skills ?? [])
      .map((s, i) => ({ s, r: rank(s), i }))
      .filter((x) => x.r >= 0)
      .sort((a, b) => a.r - b.r || a.i - b.i);
    this.skillShown = ranked.map((x) => x.s);
    this.skillQuery = query;
    // 첫 줄은 친 글자로 시작하는 이름일 때만 잡아 둔다. 그 밖에는(`/model` 이 agy:models 에 걸리는 등) 잡지 않아, Enter 가
    // 친 그대로 보낸다 — 목록에 없는 내장 명령(`/model` 등)도 쳐서 보낼 수 있다.
    this.skillActive = ranked.length > 0 && ranked[0]!.r <= 1 ? 0 : -1;
    const empty = !cached ? t("스킬 목록을 읽는 중…") : cached.skills.length === 0 ? t("이 세션에서 찾은 스킬이 없습니다.") : t("맞는 스킬이 없습니다.");
    this.renderSkills(this.skillShown.length > 0 ? null : empty);
  }

  private renderSkills(empty: string | null): void {
    const rows = this.skillShown.map((s, i) => {
      const row = h(
        "div",
        { class: i === this.skillActive ? "skill on" : "skill", role: "option", "aria-selected": String(i === this.skillActive), id: `skill-${i}` },
        h("div", { class: "skill-name" }, h("span", { class: "n" }, `/${s.name}`), s.hint ? h("span", { class: "hint" }, s.hint) : null),
        s.description ? h("div", { class: "skill-desc" }, s.description) : null,
      );
      row.title = s.description;
      row.addEventListener("click", () => this.chooseSkill(s));
      return row;
    });
    this.skillPop.replaceChildren(...(empty ? [h("div", { class: "skill-empty" }, empty)] : rows));
    // 목록은 입력창 위로 편다. 상태 창 위 끝을 넘지 않게 높이를 그때그때 맞춘다(휴대폰 자판이 올라오면 줄어든다).
    const room = (this.input.parentElement?.getBoundingClientRect().top ?? 0) - this.root.getBoundingClientRect().top - 16;
    this.skillPop.style.maxHeight = `${Math.max(120, Math.min(360, room))}px`;
    this.skillPop.hidden = false;
    this.input.setAttribute("aria-expanded", "true");
    this.markSkill();
  }

  private markSkill(): void {
    this.skillPop.querySelectorAll(".skill").forEach((row, i) => {
      row.classList.toggle("on", i === this.skillActive);
      row.setAttribute("aria-selected", String(i === this.skillActive));
      if (i === this.skillActive) row.scrollIntoView({ block: "nearest" });
    });
  }

  private loadSkills(agent: string): void {
    if (this.skillLoading === agent) return;
    this.skillLoading = agent;
    void get<{ skills: SkillView[] }>(`/api/skills?agent=${encodeURIComponent(agent)}`)
      .then(({ skills }) => this.skillCache.set(agent, { at: Date.now(), skills }))
      .catch(() => {})
      .finally(() => {
        this.skillLoading = null;
        if (!this.skillPop.hidden && this.skillAgent === agent) this.updateSkills();
      });
  }

  private closeSkills(): void {
    if (this.skillPop.hidden) return;
    this.skillPop.hidden = true;
    this.skillPop.replaceChildren();
    this.input.setAttribute("aria-expanded", "false");
  }

  /** 고른 스킬을 입력창 맨 앞에 넣는다. 보내지는 않는다 — 대개 뒤에 할 일을 적는다. */
  private chooseSkill(s: SkillView): void {
    this.closeSkills();
    this.setInput(`/${s.name} `);
    this.input.focus();
    this.input.setSelectionRange(this.input.value.length, this.input.value.length);
  }

  /**
   * 목록이 떠 있을 때의 키. 처리했으면 true. ↑↓ 로 옮기고 Tab 으로 채운다. Enter 는 잡힌 줄이 있으면 그것을 채우고, 없거나
   * 이름을 끝까지 다 쳤으면 목록을 닫고 입력창의 Enter(보내기)로 넘긴다.
   */
  private skillKey(e: KeyboardEvent): boolean {
    if (this.skillPop.hidden || e.isComposing) return false;
    const n = this.skillShown.length;
    const active = this.skillShown[this.skillActive];
    if ((e.key === "ArrowDown" || e.key === "ArrowUp") && n > 0) {
      const step = e.key === "ArrowDown" ? 1 : -1;
      this.skillActive = this.skillActive < 0 ? (step > 0 ? 0 : n - 1) : (this.skillActive + step + n) % n;
      this.markSkill();
    } else if (e.key === "Tab" && !e.shiftKey && n > 0) {
      this.chooseSkill(active ?? this.skillShown[0]!);
    } else if (e.key === "Enter" && !e.shiftKey) {
      if (!active || active.name.toLowerCase() === this.skillQuery) {
        this.closeSkills();
        return false;
      }
      this.chooseSkill(active);
    } else if (e.key === "Escape") {
      // 목록만 닫는다 — 상태 창의 Esc(입력창 떠나기·창 닫기)로 번지지 않게.
      e.stopPropagation();
      this.closeSkills();
    } else return false;
    e.preventDefault();
    return true;
  }

  /** 입력창 아래에 남겨 둘 말(고쳐야 할 것). 잘 됐다는 확인은 여기 두지 않고 알림으로 띄운다 — 자리를 계속 차지하지 않게. */
  private setNote(text: string, tone: "" | "err" | "wait"): void {
    this.note.textContent = text;
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
        // 보내기 전의 모습을 먼저 잡아 둔다. 서버는 글이 입력창을 떠난 것까지 보고 답하므로, 그 사이에 온 스냅샷에 이미 새 행이
        // 실려 있으면 "앞의 것"이 방금 보낸 것이 되어 끝내 받은 줄 모른다.
        const was = this.snapshot?.agents.find((a) => a.paneId === target.paneId);
        await post("/api/prompt", { paneId: target.paneId, text, ...(shots.length ? { images: shots.map((s) => s.id) } : {}) });
        this.sent = { text, at: Date.now(), confirmed: false, before: was?.lastPrompt, beforeCommand: was?.lastCommandAt, beforeStatus: was?.status };
        this.setNote("", "");
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
    const bare = (v: string): string => norm(v.replace(/^(\[Image #\d+\]\s*)+/, ""));
    const logged = a.lastPrompt ? bare(a.lastPrompt) : undefined;
    const want = norm(sent.text).slice(0, 32);
    // 일하는 중에 보낸 지시는 줄에 섰다가 나중에 들어간다 — 줄에 선 것도 받은 것이다. 줄의 글에도 [Image #N] 이 붙는다.
    const queued = want !== "" && a.queued?.some((q) => bare(q).startsWith(want)) === true;
    // `/clear` 같은 내장 명령과 `!git pull` 같은 셸 명령은 지시로 남지 않는다 — 명령 행이 새로 찍혔는지로 본다. 같은 명령을
    // 거푸 보내도 시각이 다르다. 셸 명령은 느낌표 뒤의 빈칸이 로그에서 빠진다.
    const typed = want.replace(/^!\s*/, "!");
    const command = /^[/!]/.test(typed) && a.lastCommandAt !== sent.beforeCommand && a.lastCommand !== undefined && norm(a.lastCommand).startsWith(typed);
    // `/compact` 는 압축이 끝난 뒤에야 명령 행이 찍힌다(수십 초~몇 분). 그동안의 흔적은 쉬던 에이전트가 일하기 시작한 것뿐이다 —
    // 글이 입력창을 떠난 것은 서버가 이미 보고 답했다. 일하던 중에 보낸 명령은 줄에 선 것(queued)으로 안다.
    const started = /^[/!]/.test(typed) && a.status === "working" && sent.beforeStatus !== undefined && sent.beforeStatus !== "working";
    if (queued || command || started || (logged !== undefined && (want ? logged.startsWith(want) : a.lastPrompt !== sent.before))) {
      sent.confirmed = true;
      this.setNote("", "");
      this.callbacks.toast(t("에이전트가 받았습니다"), a.title, "var(--done)");
      buzzConfirm();
    } else if (!a.hasLog && a.status === "working") {
      sent.confirmed = true;
      this.setNote("", "");
      this.callbacks.toast(t("에이전트가 일하기 시작했습니다"), a.title, "var(--done)");
      buzzConfirm();
    } else if (Date.now() - sent.at > 12_000) {
      this.setNote(t("아직 받은 흔적이 없습니다. 터미널 화면에서 입력창에 그대로 남아 있는지 확인해 보세요."), "err");
    }
  }

  // ── 에이전트 ───────────────────────────────────────────────────────────────────────────────

  /**
   * 머리를 그린다. 같은 대상(key)이면 타일과 단추를 그대로 두고 글만 고친다 — 활동 로그 한 줄을 펴는 것처럼 창을 다시
   * 그릴 때마다 타일을 새로 만들면, 일하는 중인 캐릭터의 움직임이 처음부터 다시 돌아 한 번씩 깜빡인다.
   */
  private setHead(key: string, makeTile: () => Element, title: string, sub: string): Element {
    if (this.headKey === key && this.headTile && this.headTitle && this.headSub) {
      if (this.headTitle.textContent !== title) this.headTitle.textContent = this.headTitle.title = title;
      if (this.headSub.textContent !== sub) this.headSub.textContent = this.headSub.title = sub;
      return this.headTile;
    }
    const tile = makeTile();
    const close = h("button", { class: "btn icon close", type: "button", title: t("닫기 (Esc)"), "aria-label": t("닫기 (Esc)") }, icon("close"));
    close.addEventListener("click", () => this.callbacks.act({ type: "select", id: null }));
    // 휴대폰에서는 상태 창이 화면을 다 덮어 목록이 가려진다. 창을 닫지 않고 목록을 꺼내 다른 에이전트로 옮겨 가게 한다.
    // 가장자리·아래쪽에서 끌어내는 몸짓은 휴대폰의 뒤로 가기·홈 몸짓과 겹쳐 단추로 둔다. 넓은 화면에서는 숨는다.
    const roster = h("button", { class: "btn icon roster-open", type: "button", title: t("에이전트 목록"), "aria-label": t("에이전트 목록") }, icon("menu"));
    roster.addEventListener("click", () => this.callbacks.act({ type: "roster" }));
    // 제목은 두 줄까지, 버금줄은 한 줄. 넘치는 글은 말풍선으로 다 보인다.
    this.headTitle = h("h2", { title }, title);
    this.headSub = h("p", { title: sub }, sub);
    this.head.replaceChildren(roster, tile, h("div", { class: "d-title" }, this.headTitle, this.headSub), close);
    this.headKey = key;
    this.headTile = tile;
    return tile;
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
    const working = a.status === "working";
    const tile = this.setHead(
      `agent:${a.id}:${a.vendor}`,
      () => {
        const made = brandTile(a.vendor, 36, working);
        const harness = brandFor(a.vendor).name;
        made.setAttribute("role", "img");
        made.setAttribute("aria-label", harness);
        if (made instanceof HTMLElement) made.title = harness;
        else made.appendChild(document.createElementNS("http://www.w3.org/2000/svg", "title")).textContent = harness;
        return made;
      },
      a.title,
      a.name ? `${where} · ${a.name}` : where,
    );
    setLogoActive(tile, working);
    this.stageTitle.textContent = a.title;
    this.stageSub.textContent = where;

    const source = a.statusSource === "herdr" ? t("herdr 가 알려준 상태") : a.statusSource === "card" ? t("질문 카드가 답을 기다리는 중") : a.statusSource === "dialog" ? t("터미널의 확인 창이 답을 기다리는 중") : a.statusSource === "prompt" ? t("보낸 첫 지시를 시작하는 중") : t("로그 시각으로 추정한 상태");
    const badge = h("span", { class: "badge", title: source }, a.seen ? t("확인함") : STATUS_LABEL[a.status]);
    badge.style.setProperty("--c", STATUS_VAR[a.status]);
    // 상태의 출처는 herdr 가 알려 준 평소의 경우에는 적지 않는다 — 다른 데서 짐작한 때에만 눈여겨볼 값이다.
    const statusLine = h("div", { class: "status-line" }, badge, h("span", { class: "age" }, statusAge(a)), a.statusSource === "herdr" ? null : h("span", { class: "src" }, source));
    if (a.seen && a.paneId) {
      const undo = this.button(t("되돌리기"), () => this.callbacks.act({ type: "seen", paneId: a.paneId!, undo: true }), { cls: "link" });
      statusLine.append(undo);
    }
    if (a.status === "working" && a.paneId && this.snapshot?.control) statusLine.append(this.stopButton(a, a.paneId));

    const blocked = a.status === "blocked" && a.paneId !== undefined;
    const now = a.status === "working" ? bubbleParts(a) : null;
    // 지금 하는 일은 한 줄로 자른다 — 글 길이를 따라 높이가 바뀌면 갱신마다 그 아래가 위아래로 들썩인다. 다 보려면
    // 활동 로그의 맨 윗줄을 눌러 펼친다.
    const nowEl = now ? h("div", { class: "now line", title: now.text }, ...(now.icon ? [icon(now.icon)] : []), now.text) : null;
    // 열쇠(data-k)는 다시 지은 본문에서 보던 덩어리를 다시 찾는 데 쓴다(pinPoint).
    const keyed: Array<[string, HTMLElement | null]> = [
      ["status", statusLine],
      ["ask", blocked ? this.askCard(a) : null],
      ["review", a.review && !blocked ? this.reviewCard(a) : null],
      ["artifact", a.artifact && !blocked ? this.artifactCard(a) : null],
      ["now", nowEl],
      ["facts", this.facts(a)],
      ["actions", this.actions(a)],
      ["prompt", a.lastPrompt ? this.textSection(t("마지막 지시"), a.lastPrompt, "prompt") : null],
      ["reply", a.lastReply ? this.textSection(t("마지막 응답"), a.lastReply, "reply") : null],
      ["screen", a.paneId && !blocked && !this.staged ? this.screenSection(a.paneId) : null],
      ["log", a.recent.length > 0 ? this.logSection(a) : null],
    ];
    for (const [k, el] of keyed) if (el) el.dataset.k = k;
    this.setBody(...keyed.map(([, el]) => el));
    return a.paneId && (blocked || this.open.screen || this.staged) ? a.paneId : null;
  }

  /**
   * 이 세션의 마지막 리뷰 보고 — 터미널 옆 패널 대신 따로 띄워 읽고, 고칠 항목을 골라 보낸다. 되묻기("한글로 요약")를 해도
   * 남는다. 월드에서 고칠 항목을 보냈으면 답한 것이라 눈에 덜 띄게 접고, 다시 열어 볼 수만 있게 둔다.
   */
  private reviewCard(a: AgentView): HTMLElement {
    const sent = a.reviewSent === true;
    const read = this.button(sent ? t("리뷰 다시 보기") : t("리뷰 읽기"), () => this.callbacks.act({ type: "review", agent: a }), { cls: "btn", icon: "search", title: t("리뷰 보고를 열어 고칠 항목을 고릅니다 (R)") });
    const note = sent ? t("고칠 항목을 보냈어요. 다음 리뷰가 오면 바뀝니다.") : this.snapshot?.control ? t("남은 결함을 읽고 고칠 것을 골라 보냅니다.") : t("남은 결함과 고친 것을 읽습니다.");
    return h("section", { class: sent ? "review-card sent" : "review-card" }, h("div", { class: "rv-card-text" }, h("b", {}, sent ? t("리뷰 보고") : t("리뷰 보고가 있어요")), h("span", {}, note)), read);
  }

  /**
   * AGY 가 승인을 바라고 남긴 글(구현 계획·제안서). 터미널에는 "/artifact to review" 한 줄뿐이라 따로 띄워 읽는다. 답은
   * 평범한 지시라 아래 입력줄로 보낸다. 답한 뒤에도 다음 글이 올 때까지 다시 읽을 수 있게 두고, 눈에 덜 띄게 접는다.
   */
  private artifactCard(a: AgentView): HTMLElement {
    const done = a.artifactAnswered === true;
    const read = this.button(done ? t("다시 읽기") : t("읽기"), () => this.callbacks.act({ type: "artifact", agent: a }), { cls: "btn", icon: "file" });
    const note = done ? t("답을 보냈어요. 다음 글이 오면 바뀝니다.") : this.snapshot?.control ? t("읽고 입력줄로 승인하거나 고칠 점을 보내세요.") : t("에이전트가 남긴 글을 읽습니다.");
    return h("section", { class: done ? "review-card sent" : "review-card" }, h("div", { class: "rv-card-text" }, h("b", {}, done ? t("아티팩트") : t("승인을 기다리는 아티팩트가 있어요")), h("span", {}, note)), read);
  }

  /** 확인 필요: 무엇을 묻는지 — 로그에 남은 요청과, 화면에 떠 있는 대화상자를 함께 보여 준다. */
  private askCard(a: AgentView): HTMLElement {
    // 스냅샷은 다른 주민의 일로도 초마다 온다. 그때마다 카드를 새로 지으면 품고 있던 미리보기가 떼였다 붙어 스크롤이 처음으로
    // 갔다 돌아오고, 요청 글(플랜) 칸은 굴려 둔 자리를 잃는다 — 휴대폰에서는 두 칸의 스크롤 막대가 그때마다 번쩍인다.
    // 내용이 같으면 지어 둔 카드를 그대로 둔다. 단추는 누르는 순간의 주민을 다시 찾아 쓴다.
    const sig = JSON.stringify([a.id, a.paneId, a.plan ?? null, a.pending ?? null, Boolean(this.snapshot?.control)]);
    if (this.asked?.sig === sig && this.asked.el.contains(this.preview.el)) return this.asked.el;
    const now = (): AgentView => this.snapshot?.agents.find((x) => x.id === a.id) ?? a;
    const big = this.button(t("크게 보기"), () => this.callbacks.act({ type: "terminal", paneId: a.paneId! }), { cls: "", icon: "expand" });
    // 플랜 승인 카드면 플랜 글을 따로 읽는 창을 연다 — 터미널에는 옆 창에 잘려 보인다.
    const plan = a.plan ? this.button(t("플랜 읽기"), () => this.callbacks.act({ type: "plan", agent: now() }), { cls: "", icon: "file" }) : null;
    const card = h("section", { class: "ask" }, h("h3", {}, t("답을 기다리고 있어요"), plan, big));
    // 승인은 플랜 글 위에 둔다 — 글이 길어 그 아래에 두면 굴려 내려가야 보인다. 고칠 점과 줄 댓글은 플랜 읽기 창에서 적는다.
    if (a.plan && this.snapshot?.control) {
      const approve = this.button(t("승인하고 시작"), () => this.callbacks.act({ type: "approve-plan", agent: now() }), { cls: "btn primary", icon: "check", title: t("플랜 카드의 Approve and start 를 누릅니다 (1)") });
      card.append(h("div", { class: "plan-approve" }, approve, h("span", { class: "hint" }, t("고칠 점은 플랜 읽기에서 적습니다."))));
    }
    if (a.pending) card.append(this.pendingBlock(a.pending));
    card.append(this.preview.el, h("p", { class: "hint" }, this.snapshot?.control ? t("대화상자에 적힌 번호·키를 아래 버튼으로 누르거나, 크게 보기에서 직접 입력하세요.") : t("보기 전용이라 여기서는 답할 수 없습니다. herdr 에서 열어 답해 주세요.")));
    this.asked = { sig, el: card };
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
    const done = a.status === "done" && a.paneId && control;
    if (done) row.append(this.button(t("확인 완료"), () => this.callbacks.act({ type: "seen", paneId: a.paneId!, undo: false }), { cls: "btn primary", icon: "check", title: t("읽었다고 표시하고 집으로 돌려보냅니다 (D)") }));
    // 손가락 기기에서는 큰 단추로 두지 않는다. 그 기기는 대개 PC 앞이 아니어서 PC 의 herdr 화면을 옮길 일이 드문데, 누르면 PC 의
    // 터미널 창이 앞으로 튀어나오고 완료 표시가 풀린다 — 머리 바로 밑의 넓은 단추라 스크롤하다·알림을 닫다 잘못 눌리기 쉽다.
    if (done || touchFirst.matches) {
      const open = this.tool("open", t("herdr 에서 열기"), openHerdr);
      open.title = `${t("herdr 에서 열기")} — ${openTitle}`;
      open.disabled = !a.paneId || !control;
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

  /**
   * 하던 일 멈추기. 키 단추의 Esc 와 같은 일이지만 일하는 중일 때만 보이고, 서버가 지금도 일하는지 보고 보낸다 — 질문이 떠 있을
   * 때의 Esc 는 그 질문을 거절한다. 멈춘 뒤의 완료는 서버가 확인한 것으로 적어, 주민이 "다 했어요" 하고 뛰어가지 않는다.
   */
  private stopButton(a: AgentView, paneId: string): HTMLButtonElement {
    const pending = this.stopping.has(paneId);
    const btn = this.button(pending ? t("멈추는 중…") : t("멈추기"), () => {
      if (this.stopping.has(paneId)) return;
      this.stopping.add(paneId);
      this.rerender();
      void post("/api/stop", { paneId })
        .then(() => this.callbacks.toast(t("멈췄습니다"), a.title, "var(--accent)"))
        .catch((e: Error) => this.callbacks.toast(t("멈추지 못했습니다"), e.message, "var(--blocked)"))
        .finally(() => {
          this.stopping.delete(paneId);
          this.rerender();
        });
    }, { cls: "stop", icon: "stop", disabled: pending, title: t("하던 일을 멈춥니다 — 터미널에서 Esc 를 누른 것과 같습니다. Claude 는 백그라운드 에이전트도 멈춥니다.") });
    return btn;
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
    // 터미널 미리보기를 보고 있으면 그것을 붙든다(다시 지어도 같은 노드다). 그 위의 마지막 응답은 에이전트가 말을 이을
    // 때마다 줄 수가 바뀌는데(agy 는 도구를 부를 때마다 한두 문장을 적는다), 위쪽 덩어리를 붙들면 그때마다 흐르는 화면이
    // 통째로 오르내린다. 화면에 조금 걸친 정도면 평소대로 위쪽을 붙든다.
    const screen = this.preview.el.isConnected ? this.preview.el.getBoundingClientRect() : undefined;
    if (screen && Math.min(screen.bottom, view.bottom) - Math.max(screen.top, view.top) >= PIN_SCREEN_PX) return { node: this.preview.el, top: screen.top };
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
    const key = `log:${ref}`;
    const row = [...this.body.querySelectorAll<HTMLElement>("[data-k]")].find((e) => e.dataset.k === key);
    if (row) this.logPin = { key, top: row.getBoundingClientRect().top };
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
    const mark = h("i", { class: "log-top" });
    this.stuckWatch.observe(mark);
    got.el = h("li", { class: "log-detail" }, mark, bar, body);
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
    // 스냅샷마다 새로 지으면 미리보기가 떼였다 붙는다(askCard 와 같은 까닭) — 같은 pane 을 같은 모양으로 보이는 동안에는 그대로 둔다.
    const sig = `${paneId}\n${Boolean(this.stage && this.stageRoom && this.stageOff)}`;
    if (this.screened?.sig === sig && this.screened.el.contains(this.preview.el)) return this.screened.el;
    const head = h(
      "h3",
      {},
      t("터미널 화면"),
      this.stageButton(),
      this.button(t("숨기기"), () => {
        this.open.screen = false;
        this.rerender();
      }, { cls: "" }),
      this.button(t("크게 보기"), () => this.callbacks.act({ type: "terminal", paneId }), { cls: "", icon: "expand" }),
    );
    const el = h("section", {}, head, this.preview.el);
    this.screened = { sig, el };
    return el;
  }

  /** 접어 둔 무대를 다시 여는 단추. 무대를 놓을 자리가 없는 화면에서는 없다. */
  private stageButton(): HTMLElement | null {
    if (!this.stage || !this.stageRoom || !this.stageOff) return null;
    return this.button(t("가운데에 띄우기"), () => this.setStageOff(false), { cls: "" });
  }

  private rerender(): void {
    if (this.snapshot) this.render(this.snapshot, this.selectedId, true);
  }

  // ── 셸 pane ────────────────────────────────────────────────────────────────────────────────

  private renderShell(p: PaneView): string {
    const snap = this.snapshot!;
    const ws = snap.workspaces.find((w) => w.id === p.workspaceId);
    const tab = snap.tabs.find((tb) => tb.id === p.tabId);
    this.setHead(`pane:${p.id}`, () => h("span", { class: "shell-tile big" }, ">_"), p.label || p.title || t("터미널"), t("셸 · {where}", { where: ws ? ws.label : p.workspaceId }));
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
    this.stageTitle.textContent = p.label || p.title || t("터미널");
    this.stageSub.textContent = ws ? ws.label : p.workspaceId;
    if (!this.staged) parts.push(h("section", {}, h("h3", {}, t("터미널 화면"), this.stageButton()), this.preview.el));
    this.setBody(...parts);
    return p.id;
  }

  // ── 집(스페이스) ───────────────────────────────────────────────────────────────────────────

  private renderHouse(ws: WorkspaceView): void {
    const snap = this.snapshot!;
    const agents = snap.agents.filter((a) => a.workspaceId === ws.id);
    const panes = snap.panes.filter((p) => p.workspaceId === ws.id);
    const sub = ws.managed ? `${t("스페이스 {n}", { n: ws.number })}${ws.repo ? ` · ${ws.repo}` : ""}${ws.worktree?.linked ? ` · ${t("워크트리")}` : ""}` : t("herdr 밖의 세션들");
    this.setHead(`house:${ws.id}`, () => h("span", { class: "house-tile" }, icon("house")), ws.label, sub);

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
            ...(ws.worktree?.repoKey || ws.inRepo
              ? [this.button(t("워크트리 추가"), () => this.callbacks.act({ type: "new-worktree", workspace: ws }), { icon: "plus", title: t("이 저장소에 새 브랜치를 따로 체크아웃해 별채로 짓습니다") })]
              : []),
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
    // 같은 저장소의 본채·별채 — 섬에서 한 집터에 모여 있는 집들.
    const repoKey = ws.worktree?.repoKey;
    const kin = repoKey ? snap.workspaces.filter((w) => w.id !== ws.id && w.worktree?.repoKey === repoKey) : [];
    if (kin.length > 0) {
      const section = h("section", {}, h("h3", {}, t("같은 저장소")));
      for (const w of kin) {
        const sub2 = w.worktree?.linked ? `${t("워크트리")}${w.worktree.path ? ` · ${shortPath(w.worktree.path)}` : ""}` : t("본체");
        section.append(row(h("span", { class: "house-tile" }, icon("house")), `${w.number} · ${w.label}`, sub2, workspaceKey(w.id)));
      }
      parts.push(section);
    }
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
