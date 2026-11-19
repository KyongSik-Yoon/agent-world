// 장면 위에 얹는 화면: 상태 칩, 에이전트 목록, 고른 에이전트의 상태 창, 알림.
import type { AgentStatus, AgentView, WorldSnapshot } from "../shared/types.ts";
import { brandFor, brandTile } from "./brands.ts";
import { setLogoActive } from "./logos.ts";
import { type Action, DetailPanel, workspaceKey } from "./detail.ts";
import { STATUS_VAR, h } from "./dom.ts";
import { STATUS_LABEL, STATUS_ORDER, bubbleText, needsAttention, statusAge } from "./format.ts";
import { lang, t } from "./i18n.ts";
import { UsageChip } from "./usage.ts";

function matches(a: AgentView, query: string): boolean {
  if (!query) return true;
  const hay = [a.title, a.workspaceLabel, a.vendor, a.model, a.cwd, a.branch, a.paneLabel, a.tabLabel, brandFor(a.vendor).name]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .every((word) => hay.includes(word));
}

/**
 * 알림을 ms 뒤에 치우고, 그 전에도 옆으로 밀면 치운다. 누르고 있는 동안에는 시간을 세지 않는다 — 읽는 중에 사라지지 않게.
 * 옆으로 조금이라도 끌었으면 손을 뗄 때의 누르기(click)는 버린다. 위아래로 끄는 것은 화면 스크롤에 맡긴다(touch-action: pan-y).
 */
/** 목록과 상태 창 사이가 이보다 좁으면 알림을 그 사이에 두지 않는다. */
const TOAST_ROOM_PX = 360;

function swipeAway(el: HTMLElement, ms: number): void {
  let deadline = performance.now() + ms;
  let timer = setTimeout(() => el.remove(), ms);
  // 손을 뗀 뒤 남은 시간만큼 더 둔다. 다 썼더라도 읽을 틈은 준다.
  const resume = (): void => {
    deadline = Math.max(deadline, performance.now() + 2500);
    timer = setTimeout(() => el.remove(), deadline - performance.now());
  };
  let start: { id: number; x: number; y: number } | null = null;
  let dragging = false;
  let swiped = false;
  let samples: Array<{ x: number; t: number }> = [];

  const settle = (dx: number, fly: boolean): void => {
    el.style.transition = "translate 0.18s ease-out, opacity 0.18s ease-out";
    if (fly) {
      el.style.translate = `${Math.sign(dx) * (el.offsetWidth + 40)}px`;
      el.style.opacity = "0";
      el.addEventListener("transitionend", () => el.remove(), { once: true });
      setTimeout(() => el.remove(), 300); // 움직임 줄이기 설정 등으로 transitionend 가 오지 않을 때
      return;
    }
    el.style.translate = "";
    el.style.opacity = "";
    resume();
  };

  el.addEventListener("pointerdown", (e) => {
    if (start || e.button !== 0) return;
    clearTimeout(timer);
    start = { id: e.pointerId, x: e.clientX, y: e.clientY };
    dragging = false;
    swiped = false;
    samples = [{ x: e.clientX, t: e.timeStamp }];
  });
  el.addEventListener("pointermove", (e) => {
    if (!start || e.pointerId !== start.id) return;
    const dx = e.clientX - start.x;
    if (!dragging) {
      if (Math.abs(dx) < 8 || Math.abs(dx) < Math.abs(e.clientY - start.y)) return;
      // 끌기로 정해진 뒤에야 잡는다. 처음부터 잡으면 안의 단추(되돌리기)가 누르기를 받지 못한다.
      dragging = swiped = true;
      el.setPointerCapture(e.pointerId);
      el.style.transition = "none";
    }
    el.style.translate = `${dx}px`;
    el.style.opacity = String(Math.max(0.2, 1 - Math.abs(dx) / el.offsetWidth));
    samples.push({ x: e.clientX, t: e.timeStamp });
    while (samples.length > 2 && e.timeStamp - samples[0]!.t > 80) samples.shift();
  });
  const release = (e: PointerEvent): void => {
    if (!start || e.pointerId !== start.id) return;
    const dx = e.clientX - start.x;
    start = null;
    if (!dragging) {
      resume();
      return;
    }
    dragging = false;
    const first = samples[0]!;
    const speed = (e.clientX - first.x) / Math.max(1, e.timeStamp - first.t); // px/ms, 마지막 80ms 동안
    const flick = Math.abs(speed) > 0.5 && Math.sign(speed) === Math.sign(dx) && Math.abs(dx) > 24;
    settle(dx, e.type === "pointerup" && (flick || Math.abs(dx) > el.offsetWidth * 0.35));
  };
  el.addEventListener("pointerup", release);
  el.addEventListener("pointercancel", release);
  el.addEventListener(
    "click",
    (e) => {
      if (!swiped) return;
      swiped = false;
      e.stopImmediatePropagation();
      e.preventDefault();
    },
    { capture: true },
  );
}

export interface HudCallbacks {
  onSelect(id: string | null): void;
  onHover(id: string | null): void;
  onFilter(pass: ((a: AgentView) => boolean) | null): void;
  onAction(action: Action): void;
}

export class Hud {
  private snapshot: WorldSnapshot | undefined;
  private selectedId: string | null = null;
  private hoveredId: string | null = null;
  private statusFilter: AgentStatus | null = null;
  private query = "";
  private readonly rows = new Map<string, HTMLButtonElement>();
  private readonly chips = document.getElementById("chips")!;
  private readonly list = document.getElementById("roster-list")!;
  private readonly detail = document.getElementById("detail")!;
  private readonly conn = document.getElementById("conn")!;
  private readonly nextCount = document.getElementById("next-count")!;
  private readonly nextBtn = document.getElementById("btn-next")!;
  private readonly search = document.getElementById("search") as HTMLInputElement;
  private readonly toasts = document.getElementById("toasts")!;
  private readonly topbar = document.getElementById("topbar")!;
  private readonly roster = document.getElementById("roster")!;
  private readonly panel: DetailPanel;
  private readonly usage = new UsageChip();

  constructor(private readonly callbacks: HudCallbacks) {
    this.panel = new DetailPanel(this.detail, {
      act: (action) => this.callbacks.onAction(action),
      toast: (title, text, color) => this.toast(title, text, color),
    });
    this.search.addEventListener("input", () => {
      this.query = this.search.value.trim();
      this.applyFilter();
      this.renderRoster();
    });
    // 시간 문구("3분 전")는 스냅샷이 오지 않아도 흘러야 한다.
    setInterval(() => this.render(), 15_000);
    // 알림이 떠 있는 동안 머리줄이나 옆 창의 자리가 바뀌면(창 폭, 상태 창 여닫기·폭 조절) 따라 옮긴다.
    const moved = new ResizeObserver(() => {
      if (this.toasts.childElementCount > 0) this.placeToasts();
    });
    for (const el of [this.topbar, this.roster, this.detail]) moved.observe(el);
  }

  get selected(): AgentView | undefined {
    return this.snapshot?.agents.find((a) => a.id === this.selectedId);
  }

  /** 확인할 에이전트들: 확인 필요가 먼저, 그다음 오래 기다린 완료 순. */
  attention(): AgentView[] {
    return (this.snapshot?.agents ?? [])
      .filter((a) => needsAttention(a.status))
      .sort((a, b) => STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) || a.statusSince - b.statusSince);
  }

  /** 고른 것이 pane 을 가졌으면 그 id(에이전트의 pane 이거나 셸 pane). */
  get selectedPaneId(): string | undefined {
    return this.selected?.paneId ?? this.snapshot?.panes.find((p) => p.id === this.selectedId)?.id;
  }

  get latest(): WorldSnapshot | undefined {
    return this.snapshot;
  }

  /** 터미널 크게 보기가 열려 상태 창이 덮였다. */
  setCovered(covered: boolean): void {
    this.panel.setCovered(covered);
    if (this.toasts.childElementCount > 0) this.placeToasts();
  }

  focusComposer(): boolean {
    return this.panel.focusComposer();
  }

  setDraft(paneId: string, text: string): void {
    this.panel.setDraft(paneId, text);
  }

  update(snapshot: WorldSnapshot): void {
    this.snapshot = snapshot;
    this.usage.update(snapshot.usage ?? []);
    const id = this.selectedId;
    const alive = id === null || snapshot.agents.some((a) => a.id === id) || snapshot.panes.some((p) => p.id === id) || snapshot.workspaces.some((w) => workspaceKey(w.id) === id);
    // 고른 것이 사라졌으면 고르기를 푼다 — 장면과 메인도 함께 알도록 바깥을 거친다.
    if (!alive) this.callbacks.onSelect(null);
    else this.render();
  }

  setConnection(state: "live" | "logs" | "down", text: string, why = ""): void {
    this.conn.dataset.state = state;
    this.conn.textContent = text;
    this.conn.title = why;
  }

  select(id: string | null): void {
    this.selectedId = id;
    this.render();
  }

  setHover(id: string | null): void {
    this.hoveredId = id;
    for (const [rowId, row] of this.rows) row.classList.toggle("hovered", rowId === id);
  }

  focusSearch(): void {
    this.search.focus();
    this.search.select();
  }

  private pass(a: AgentView): boolean {
    const bucket = a.status === "unknown" ? "idle" : a.status;
    return (!this.statusFilter || bucket === this.statusFilter) && matches(a, this.query);
  }

  private applyFilter(): void {
    this.callbacks.onFilter(this.statusFilter || this.query ? (a) => this.pass(a) : null);
  }

  private render(): void {
    if (!this.snapshot) return;
    this.renderChips();
    this.renderRoster();
    this.panel.render(this.snapshot, this.selectedId);
    const waiting = this.attention().length;
    this.nextCount.textContent = String(waiting);
    this.nextBtn.dataset.hot = String(waiting > 0);
    const name = this.snapshot.session ? `Agent World — ${this.snapshot.session}` : "Agent World";
    document.title = waiting > 0 ? `(${waiting}) ${name}` : name;
  }

  /** 상태 칩. 한 번 만들어 두고 수와 눌림만 고친다 — 스냅샷마다 새로 만들면 누르는 도중의 단추가 발밑에서 바뀐다. */
  private readonly chipEls = new Map<AgentStatus, { chip: HTMLButtonElement; count: HTMLElement }>();

  private renderChips(): void {
    const agents = this.snapshot!.agents;
    const order: AgentStatus[] = ["blocked", "done", "working", "idle"];
    if (this.chipEls.size === 0) {
      for (const status of order) {
        const count = h("b");
        const chip = h("button", { class: "chip", type: "button", title: STATUS_LABEL[status] }, h("i"), h("span", { class: "chip-label" }, STATUS_LABEL[status]), count);
        chip.style.setProperty("--c", STATUS_VAR[status]);
        chip.addEventListener("click", () => {
          this.statusFilter = this.statusFilter === status ? null : status;
          this.applyFilter();
          this.render();
        });
        this.chipEls.set(status, { chip, count });
        this.chips.append(chip);
      }
    }
    for (const [status, { chip, count }] of this.chipEls) {
      const n = agents.filter((a) => (a.status === "unknown" ? "idle" : a.status) === status).length;
      if (count.textContent !== String(n)) count.textContent = String(n);
      chip.setAttribute("aria-pressed", String(this.statusFilter === status));
      chip.dataset.zero = String(n === 0);
    }
  }

  private renderRoster(): void {
    const agents = this.snapshot!.agents.filter((a) => this.pass(a));
    const children: Node[] = [];
    const alive = new Set<string>();
    for (const status of STATUS_ORDER) {
      const group = agents
        .filter((a) => a.status === status)
        .sort((a, b) => (status === "working" ? a.workspaceNumber - b.workspaceNumber : b.statusSince - a.statusSince) || a.id.localeCompare(b.id));
      if (group.length === 0) continue;
      const head = h("div", { class: "group-head" }, h("i"), `${STATUS_LABEL[status]} ${group.length}`);
      head.style.setProperty("--c", STATUS_VAR[status]);
      children.push(head);
      for (const a of group) {
        alive.add(a.id);
        children.push(this.row(a));
      }
    }
    for (const id of [...this.rows.keys()]) if (!alive.has(id)) this.rows.delete(id);
    if (children.length === 0) {
      const snap = this.snapshot!;
      // 처음 띄운 사람이 가장 먼저 보는 글이다 — 왜 비었고 무엇을 하면 되는지까지 적는다.
      const paragraphs =
        snap.agents.length > 0
          ? [t("조건에 맞는 에이전트가 없습니다.")]
          : !snap.herdr
            ? [t("herdr 에 붙지 못했습니다."), t("최근 30분 안에 움직인 에이전트 세션도 없습니다. herdr 를 띄우면 여기에 나타납니다."), ...(snap.herdrError ? [snap.herdrError[lang]] : [])]
            : snap.control
              ? [t("아직 에이전트가 없습니다."), t("위의 집 짓기 (B) 에서 폴더를 열고 에이전트를 들여 보세요."), t("herdr 에서 띄운 에이전트도 여기에 나타납니다.")]
              : [t("아직 에이전트가 없습니다."), t("herdr 에서 에이전트를 띄우면 여기에 나타납니다.")];
      const why = paragraphs.join("\n\n");
      children.push(h("div", { class: "empty" }, why));
    }
    // 순서가 그대로면 DOM 을 건드리지 않는다 — 누르려던 행이 발밑에서 바뀌지 않게.
    const current = [...this.list.childNodes];
    if (current.length !== children.length || current.some((n, i) => n !== children[i] && !(n instanceof HTMLDivElement && n.isEqualNode(children[i]!)))) {
      this.list.replaceChildren(...children);
    }
  }

  private row(a: AgentView): HTMLButtonElement {
    let row = this.rows.get(a.id);
    if (!row) {
      row = h("button", { class: "row", type: "button" });
      row.append(brandTile(a.vendor, 26), h("span", { class: "title" }), h("span", { class: "age" }), h("span", { class: "sub" }));
      const id = a.id;
      row.addEventListener("click", () => this.callbacks.onSelect(id));
      row.addEventListener("pointerenter", () => this.callbacks.onHover(id));
      row.addEventListener("pointerleave", () => this.callbacks.onHover(null));
      this.rows.set(a.id, row);
    }
    row.dataset.status = a.status;
    row.classList.toggle("selected", a.id === this.selectedId);
    row.classList.toggle("hovered", a.id === this.hoveredId);
    const [tile, title, age, sub] = row.children as unknown as [Element, HTMLElement, HTMLElement, HTMLElement];
    setLogoActive(tile, a.status === "working");
    title.textContent = a.title;
    age.textContent = statusAge(a);
    const where = a.workspaceNumber ? `${a.workspaceNumber} · ${a.workspaceLabel}` : a.workspaceLabel;
    const doing = a.status === "working" || a.status === "blocked" ? bubbleText(a) : null;
    sub.textContent = doing ? `${where} — ${doing}` : where;
    row.title = `${a.title}\n${where}`;
    return row;
  }

  /**
   * 알림은 지금 맨 위에 있는 화면의 머리줄 바로 아래에 뜬다. 아래쪽은 입력창(상태 창의 도크, 터미널의 입력 줄)과
   * 방금 온 글이 있는 자리라 덮지 않는다. 머리줄의 높이는 화면마다 달라(두 줄로 접히는 휴대폰 위 막대, 상태 창 머리,
   * 터미널 머리) 띄울 때 잰다. 데스크톱에서는 목록과 상태 창 사이, 월드 위에 둔다.
   */
  private placeToasts(): void {
    const vw = window.innerWidth;
    const shown = (el: Element | null): DOMRect | null => {
      const r = el?.getBoundingClientRect();
      return r && r.width > 0 && r.right > 0 && r.left < vw ? r : null;
    };
    let top = this.topbar.getBoundingClientRect().bottom;
    let left = 0;
    let right = 0;
    const term = shown(document.getElementById("term-overlay"));
    const detail = shown(this.detail);
    if (term) {
      top = document.querySelector("#term-overlay header")!.getBoundingClientRect().bottom;
      left = term.left;
      right = vw - term.right;
    } else if (detail && detail.width >= vw - 1) {
      // 휴대폰: 상태 창이 화면 전체를 쓴다.
      top = this.detail.querySelector(".d-head")!.getBoundingClientRect().bottom;
    } else {
      const roster = shown(this.roster);
      const l = roster && roster.width < vw / 2 ? roster.right : 0;
      const r = detail ? vw - detail.left : 0;
      if (vw - l - r >= TOAST_ROOM_PX) {
        left = l;
        right = r;
      } else if (detail) {
        // 두 창 사이가 좁으면 상태 창 안, 그 머리 아래에 둔다 — 머리의 단추와 목록의 찾기 칸을 덮지 않게.
        top = this.detail.querySelector(".d-head")!.getBoundingClientRect().bottom;
        left = detail.left;
        right = vw - detail.right;
      }
    }
    Object.assign(this.toasts.style, { top: `${Math.round(top) + 8}px`, left: `${Math.round(left)}px`, right: `${Math.round(right)}px` });
  }

  toast(title: string, text: string, color: string, onClick?: () => void): void {
    const el = h("div", { class: "toast" }, h("b", {}, title), h("span", {}, text));
    el.style.setProperty("--c", color);
    el.addEventListener("click", () => {
      onClick?.();
      el.remove();
    });
    this.placeToasts();
    this.toasts.append(el);
    while (this.toasts.childElementCount > 4) this.toasts.firstElementChild?.remove();
    this.raiseToasts();
    swipeAway(el, 7000);
  }

  /** 되돌릴 수 있는 일을 알린다 — 단추를 누르면 undo 를 부른다. */
  undoToast(title: string, text: string, undo: () => void): void {
    const btn = h("button", { type: "button" }, t("되돌리기"));
    const el = h("div", { class: "toast undo" }, h("b", {}, title), h("span", {}, text), btn);
    el.style.setProperty("--c", "var(--idle)");
    btn.addEventListener("click", () => {
      undo();
      el.remove();
    });
    this.placeToasts();
    this.toasts.append(el);
    while (this.toasts.childElementCount > 4) this.toasts.firstElementChild?.remove();
    this.raiseToasts();
    swipeAway(el, 6000);
  }

  /**
   * 알림 칸을 최상위 층(top layer)에 다시 올린다. 모달 창(플랜·리뷰 읽기)도 그 층에 뜨므로 z-index 로는 그 뒤에 깔린다 —
   * 그 층에서는 나중에 올린 것이 위라, 알림을 띄울 때마다 내렸다 올린다.
   */
  private raiseToasts(): void {
    if (this.toasts.matches(":popover-open")) this.toasts.hidePopover();
    this.toasts.showPopover();
  }
}

export { STATUS_VAR };
