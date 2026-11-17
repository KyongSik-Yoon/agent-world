// 장면 위에 얹는 화면: 상태 칩, 에이전트 목록, 고른 에이전트의 상태 창, 알림.
import type { AgentStatus, AgentView, WorldSnapshot } from "../shared/types.ts";
import { brandFor, brandTile } from "./brands.ts";
import {
  STATUS_LABEL,
  STATUS_ORDER,
  activityLine,
  bubbleText,
  clock,
  effortLevel,
  needsAttention,
  shortPath,
  statusAge,
  tokens,
} from "./format.ts";

type Child = Node | string | null | undefined | false;

function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") el.className = v;
    else el.setAttribute(k, v);
  }
  for (const c of children) if (c) el.append(c);
  return el;
}

const STATUS_VAR: Record<AgentStatus, string> = {
  blocked: "var(--blocked)",
  done: "var(--done)",
  working: "var(--working)",
  idle: "var(--idle)",
  unknown: "var(--idle)",
};

/** 응답 글을 가볍게 꾸민다: 굵게, 코드, 제목, 링크. innerHTML 을 쓰지 않고 노드로만 만든다. */
function prose(text: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  const inline = /(\*\*[^*\n]+\*\*|`[^`\n]+`|\[[^\]\n]+\]\((?:https?|file):[^)\s]+\))/g;
  text.split("\n").forEach((line, i) => {
    if (i > 0) frag.append("\n");
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    const target: Node = heading ? h("span", { class: "h" }) : frag;
    const body = heading ? heading[1]! : line;
    let last = 0;
    for (const m of body.matchAll(inline)) {
      target.appendChild(document.createTextNode(body.slice(last, m.index)));
      const token = m[0];
      if (token.startsWith("**")) target.appendChild(h("b", {}, token.slice(2, -2)));
      else if (token.startsWith("`")) target.appendChild(h("code", {}, token.slice(1, -1)));
      else {
        const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token)!;
        // 로컬 파일 링크는 브라우저가 열 수 없으니 이름만 코드로 보여 준다.
        if (link[2]!.startsWith("http")) target.appendChild(h("a", { href: link[2]!, target: "_blank", rel: "noreferrer" }, link[1]!));
        else target.appendChild(h("code", {}, link[1]!));
      }
      last = m.index + token.length;
    }
    target.appendChild(document.createTextNode(body.slice(last)));
    if (heading) frag.append(target);
  });
  return frag;
}

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
  onOpenInHerdr(a: AgentView): void;
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
  /** 상태 창에서 펼쳐 둔 것들 — 스냅샷이 올 때마다 다시 그려도 유지한다. */
  private readonly open = { prompt: false, reply: false, screen: false };
  private screenTimer: ReturnType<typeof setInterval> | undefined;
  private screenText = "";
  private detailScroll = 0;

  constructor(private readonly callbacks: HudCallbacks) {
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

  update(snapshot: WorldSnapshot): void {
    this.snapshot = snapshot;
    if (this.selectedId && !snapshot.agents.some((a) => a.id === this.selectedId)) this.select(null);
    this.render();
  }

  setConnection(state: "live" | "logs" | "down", text: string): void {
    this.conn.dataset.state = state;
    this.conn.textContent = text;
  }

  select(id: string | null): void {
    if (id !== this.selectedId) {
      this.open.prompt = this.open.reply = false;
      this.detailScroll = 0;
      this.stopScreen();
    }
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
    this.renderDetail();
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
    const doing = a.status === "working" ? bubbleText(a) : null;
    sub.textContent = doing ? `${where} — ${doing}` : where;
    row.title = `${a.title}\n${where}`;
    return row;
  }

  // ── 상태 창 ────────────────────────────────────────────────────────────────────────────────

  private renderDetail(): void {
    const a = this.selected;
    if (!a) {
      this.detail.hidden = true;
      this.detail.replaceChildren();
      return;
    }
    const oldBody = this.detail.querySelector(".d-body");
    if (oldBody) this.detailScroll = oldBody.scrollTop;
    const brand = brandFor(a.vendor);
    const where = a.workspaceNumber ? `${a.workspaceNumber} · ${a.workspaceLabel}` : `${a.workspaceLabel} (herdr 밖)`;

    const close = h("button", { class: "btn icon close", type: "button", title: "닫기 (Esc)" }, "✕");
    close.addEventListener("click", () => this.callbacks.onSelect(null));
    const head = h("div", { class: "d-head" }, brandTile(a.vendor, 46), h("div", {}, h("h2", {}, a.title), h("p", {}, `${brand.name} · ${where}`)), close);

    const badge = h("span", { class: "badge" }, STATUS_LABEL[a.status]);
    badge.style.setProperty("--c", STATUS_VAR[a.status]);
    const statusLine = h(
      "div",
      { class: "status-line" },
      badge,
      h("span", { class: "age" }, statusAge(a)),
      h("span", { class: "src" }, a.statusSource === "herdr" ? "herdr 가 알려준 상태" : "로그 시각으로 추정한 상태"),
    );

    const body = h("div", { class: "d-body" }, statusLine);
    // 끝난 에이전트의 "지금"은 아래 마지막 응답과 같은 말이라 일하는 중에만 보여 준다.
    const now = a.status === "working" || a.status === "blocked" ? bubbleText(a) : null;
    if (now) body.append(h("div", { class: "now" }, now));
    body.append(this.stats(a), this.actions(a));

    if (!a.hasLog) {
      const why = a.sessionId
        ? "이 세션의 로그 파일을 아직 찾지 못했습니다. 모델과 활동은 로그가 생기면 채워집니다."
        : "이 하네스의 로그는 아직 읽지 못합니다. herdr 가 알려 준 제목과 상태만 보여 줍니다.";
      body.append(h("p", { class: "note" }, why));
    }
    if (a.lastPrompt) body.append(this.textSection("마지막 지시", a.lastPrompt, "prompt"));
    if (a.lastReply) body.append(this.textSection("마지막 응답", a.lastReply, "reply"));
    if (a.paneId) body.append(this.screenSection(a));
    if (a.recent.length > 0) body.append(this.logSection(a));

    this.detail.replaceChildren(head, body);
    this.detail.hidden = false;
    body.scrollTop = this.detailScroll;
  }

  private stats(a: AgentView): HTMLElement {
    const stat = (label: string, value: Child, opts: { wide?: boolean; mono?: boolean; title?: string } = {}): HTMLElement => {
      const dd = h("dd", opts.mono ? { class: "mono" } : {}, value);
      if (opts.title) dd.title = opts.title;
      return h("div", { class: opts.wide ? "stat wide" : "stat" }, h("dt", {}, label), dd);
    };
    const dl = h("dl", { class: "stats" });
    dl.append(stat("모델", a.model ?? "—", { title: a.model }));

    const level = effortLevel(a.effort);
    const pips = h("span", { class: "pips" });
    for (let i = 1; i <= 5; i += 1) pips.append(h("i", i <= level ? { class: "on" } : {}));
    dl.append(stat("EFFORT", a.effort ? h("span", {}, level > 0 ? pips : null, a.effort) : "—"));

    if (a.contextTokens) {
      const dd = h("span", {}, a.contextWindow ? `${tokens(a.contextTokens)} / ${tokens(a.contextWindow)}` : `${tokens(a.contextTokens)} 토큰`);
      const cell = stat("컨텍스트", dd);
      if (a.contextWindow) {
        const bar = h("i");
        bar.style.width = `${Math.min(100, (a.contextTokens / a.contextWindow) * 100).toFixed(1)}%`;
        cell.append(h("div", { class: "meter" }, bar));
      }
      dl.append(cell);
    } else dl.append(stat("컨텍스트", "—"));

    dl.append(stat("권한 모드", a.permissionMode ?? "—"));
    if (a.branch) dl.append(stat("브랜치", a.branch, { mono: true, title: a.branch }));
    if (a.subagents > 0) dl.append(stat("서브에이전트", `${a.subagents}개 실행 중`));
    if (a.harnessVersion) dl.append(stat("하네스", `${brandFor(a.vendor).name} ${a.harnessVersion}`));
    if (a.paneId) dl.append(stat("PANE", a.tabLabel ? `${a.paneId} · ${a.tabLabel}` : a.paneId, { mono: true, title: a.tabLabel }));
    if (a.cwd) dl.append(stat("작업 폴더", shortPath(a.cwd), { wide: true, mono: true, title: a.cwd }));
    return dl;
  }

  private actions(a: AgentView): HTMLElement {
    const open = h("button", { class: "btn primary", type: "button" }, "herdr 에서 열기 ↵");
    if (a.paneId) open.addEventListener("click", () => this.callbacks.onOpenInHerdr(a));
    else {
      open.disabled = true;
      open.title = "herdr 밖에서 도는 세션이라 옮겨 갈 pane 이 없습니다.";
    }
    const copy = h("button", { class: "btn", type: "button" }, "세션 ID 복사");
    copy.disabled = !a.sessionId;
    copy.addEventListener("click", () => {
      void navigator.clipboard.writeText(a.sessionId ?? "").then(() => this.toast("복사했습니다", a.sessionId ?? "", "var(--accent)"));
    });
    return h("div", { class: "actions" }, open, copy);
  }

  private textSection(title: string, text: string, key: "prompt" | "reply"): HTMLElement {
    const long = text.length > 420 || text.split("\n").length > 8;
    const box = h("div", { class: long && !this.open[key] ? "prose clamp" : "prose" }, prose(text));
    const head = h("h3", {}, title);
    if (long) {
      const toggle = h("button", { type: "button" }, this.open[key] ? "접기" : "펼치기");
      toggle.addEventListener("click", () => {
        this.open[key] = !this.open[key];
        this.renderDetail();
      });
      head.append(toggle);
    }
    return h("section", {}, head, box);
  }

  private logSection(a: AgentView): HTMLElement {
    const list = h("ol", { class: "log" });
    const items = [...a.recent].reverse();
    items.forEach((item, i) => {
      const cls = [item.error ? "err" : "", i === 0 ? "latest" : ""].filter(Boolean).join(" ");
      const line = activityLine(item);
      const text = h("span", {}, item.error ? `${line} — 실패` : line);
      text.title = line;
      list.append(h("li", cls ? { class: cls } : {}, h("time", {}, clock(item.at)), text));
    });
    return h("section", {}, h("h3", {}, "활동 로그"), list);
  }

  private screenSection(a: AgentView): HTMLElement {
    const head = h("h3", {}, "터미널 화면");
    const toggle = h("button", { type: "button" }, this.open.screen ? "숨기기" : "보기");
    toggle.addEventListener("click", () => {
      this.open.screen = !this.open.screen;
      if (this.open.screen) this.startScreen(a.paneId!);
      else this.stopScreen();
      this.renderDetail();
    });
    head.append(toggle);
    const section = h("section", {}, head);
    if (this.open.screen) {
      const pre = h("pre", { class: "screen", id: "screen-text" }, this.screenText || "읽는 중…");
      section.append(pre);
    }
    return section;
  }

  private startScreen(paneId: string): void {
    this.stopScreen();
    this.open.screen = true;
    const read = async (): Promise<void> => {
      try {
        const res = await fetch(`/api/screen?pane=${encodeURIComponent(paneId)}`);
        const data = (await res.json()) as { text?: string; error?: string };
        this.screenText = data.text ?? data.error ?? "";
      } catch {
        this.screenText = "화면을 읽지 못했습니다.";
      }
      const pre = document.getElementById("screen-text");
      if (pre) pre.textContent = this.screenText.replace(/\s+$/, "");
    };
    void read();
    this.screenTimer = setInterval(() => void read(), 2000);
  }

  private stopScreen(): void {
    clearInterval(this.screenTimer);
    this.screenTimer = undefined;
    this.open.screen = false;
    this.screenText = "";
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
}

export { STATUS_VAR };
