// 장면 위에 얹는 화면: 상태 칩, 에이전트 목록, 고른 에이전트의 상태 창, 알림.
import type { AgentStatus, AgentView, WorldSnapshot } from "../shared/types.ts";
import { brandFor, brandTile } from "./brands.ts";
import { type Action, DetailPanel, workspaceKey } from "./detail.ts";
import { STATUS_VAR, h } from "./dom.ts";
import { STATUS_LABEL, STATUS_ORDER, bubbleText, needsAttention, statusAge } from "./format.ts";

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
  private readonly panel: DetailPanel;

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

  focusComposer(): boolean {
    return this.panel.focusComposer();
  }

  setDraft(paneId: string, text: string): void {
    this.panel.setDraft(paneId, text);
  }

  update(snapshot: WorldSnapshot): void {
    this.snapshot = snapshot;
    const id = this.selectedId;
    const alive = id === null || snapshot.agents.some((a) => a.id === id) || snapshot.panes.some((p) => p.id === id) || snapshot.workspaces.some((w) => workspaceKey(w.id) === id);
    // 고른 것이 사라졌으면 고르기를 푼다 — 장면과 메인도 함께 알도록 바깥을 거친다.
    if (!alive) this.callbacks.onSelect(null);
    else this.render();
  }

  setConnection(state: "live" | "logs" | "down", text: string): void {
    this.conn.dataset.state = state;
    this.conn.textContent = text;
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
    document.title = waiting > 0 ? `(${waiting}) Agent World` : "Agent World";
  }

  private renderChips(): void {
    const agents = this.snapshot!.agents;
    const order: AgentStatus[] = ["blocked", "done", "working", "idle"];
    this.chips.replaceChildren(
      ...order.map((status) => {
        const count = agents.filter((a) => (a.status === "unknown" ? "idle" : a.status) === status).length;
        const chip = h("button", { class: "chip", type: "button", "aria-pressed": String(this.statusFilter === status), "data-zero": String(count === 0) });
        chip.style.setProperty("--c", STATUS_VAR[status]);
        chip.append(h("i"), STATUS_LABEL[status], h("b", {}, String(count)));
        chip.addEventListener("click", () => {
          this.statusFilter = this.statusFilter === status ? null : status;
          this.applyFilter();
          this.render();
        });
        return chip;
      }),
    );
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
      children.push(h("div", { class: "empty" }, this.snapshot!.agents.length === 0 ? "지금 보이는 에이전트가 없습니다." : "조건에 맞는 에이전트가 없습니다."));
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
    const [, title, age, sub] = row.children as unknown as [Element, HTMLElement, HTMLElement, HTMLElement];
    title.textContent = a.title;
    age.textContent = statusAge(a);
    const where = a.workspaceNumber ? `${a.workspaceNumber} · ${a.workspaceLabel}` : a.workspaceLabel;
    const doing = a.status === "working" || a.status === "blocked" ? bubbleText(a) : null;
    sub.textContent = doing ? `${where} — ${doing}` : where;
    row.title = `${a.title}\n${where}`;
    return row;
  }

  toast(title: string, text: string, color: string, onClick?: () => void): void {
    const el = h("div", { class: "toast" }, h("b", {}, title), h("span", {}, text));
    el.style.setProperty("--c", color);
    el.addEventListener("click", () => {
      onClick?.();
      el.remove();
    });
    this.toasts.append(el);
    while (this.toasts.childElementCount > 4) this.toasts.firstElementChild?.remove();
    setTimeout(() => el.remove(), 7000);
  }

  /** 되돌릴 수 있는 일을 알린다 — 단추를 누르면 undo 를 부른다. */
  undoToast(title: string, text: string, undo: () => void): void {
    const btn = h("button", { type: "button" }, "되돌리기");
    const el = h("div", { class: "toast undo" }, h("b", {}, title), h("span", {}, text), btn);
    el.style.setProperty("--c", "var(--idle)");
    btn.addEventListener("click", () => {
      undo();
      el.remove();
    });
    this.toasts.append(el);
    while (this.toasts.childElementCount > 4) this.toasts.firstElementChild?.remove();
    setTimeout(() => el.remove(), 6000);
  }
}

export { STATUS_VAR };
