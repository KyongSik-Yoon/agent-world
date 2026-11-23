// 승인을 기다리는 플랜을 읽고, 승인하거나 고칠 점을 보내는 창.
//
// 플랜 승인 카드가 뜨면 터미널에는 플랜이 옆 창에 잘려 보인다 — 그 창은 터미널 안의 그림이라 월드에서는 굴릴 수 없다.
// 플랜은 파일로 있으므로(server/plan.ts) 그 글을 받아 응답 글처럼 그려 보여 준다. 다 읽고 바로 승인하거나, 고칠 점을
// 적어 보낸다. 고칠 점은 desk-plan 카드의 글 칸과 같은 답으로 간다(서버가 카드의 답 파이프에 써 넣는다).
//
// 줄 댓글은 desk-look 의 미리보기 패널처럼 원문 줄 보기에서 단다: 줄 번호를 누르고(다른 번호를 누르면 범위) 적는다.
// 보낼 때 댓글마다 파일:줄과 그 줄 원문을 붙여 고칠 점 글 앞에 싣는다(desk-plan 의 reviseReason 과 같은 모양).
// 적던 것은 창을 닫아도 그 카드가 떠 있는 동안 남는다.
import type { AgentView } from "../shared/types.ts";
import { get } from "./api.ts";
import { h, icon, prose } from "./dom.ts";
import { t } from "./i18n.ts";

interface Plan {
  name: string;
  text: string;
  at: number;
  /** 이 글을 띄운 카드 — 고칠 점은 그 카드에만 보낸다. */
  card?: number;
}

/** 원문 줄 범위(1부터, 끝 포함)에 단 말. */
interface LineNote {
  from: number;
  to: number;
  body: string;
}

/** 한 카드에 적던 것. */
interface Draft {
  card: number | undefined;
  text: string;
  notes: LineNote[];
}

/** 서버가 받는 길이(control.ts MAX_REVISE). */
const MAX_REVISE = 16_000;

export class PlanReader {
  private dlg: HTMLDialogElement | undefined;
  private body: HTMLElement | undefined;
  private file: HTMLElement | undefined;
  private agentId = "";
  /** 지금 보여 주는(또는 받아 오는 중인) 글이 고쳐진 시각. */
  private at = 0;
  /** 받아 온 플랜. */
  private plan: Plan | undefined;
  /** 원문 줄 보기인지. */
  private lines = false;
  /** 원문 줄 보기에서 댓글을 적으려고 고른 범위. */
  private pick: { from: number; to: number } | undefined;
  private sending = false;
  /** 에이전트마다 적던 것 — 창을 닫았다 열어도 남는다. 다른 카드가 뜨면 줄 댓글은 버린다(줄 번호가 옛 플랜의 것이다). */
  private readonly drafts = new Map<string, Draft>();
  private ui: { lineBtn: HTMLButtonElement; note: HTMLTextAreaElement; send: HTMLButtonElement; count: HTMLElement; error: HTMLElement } | undefined;
  /** 닫힌 뒤에 부른다 — 크게 보기가 열려 있으면 입력을 다시 그리로 돌린다. */
  onClose: (() => void) | undefined;
  /** 이 월드가 pane 을 조작할 수 있는지(보기 전용이 아닌지). */
  canApprove: () => boolean = () => false;
  /** 승인 단추를 눌렀다. 카드가 내려가면 다음 스냅샷(sync)에서 창이 닫힌다. */
  onApprove: ((a: AgentView) => void) | undefined;
  /** 고칠 점을 보낸다. 카드가 내려가는 것까지 확인되면 끝난다. 실패하면 던진다 — 적던 것은 그대로 둔다. */
  onRevise: ((a: AgentView, card: number, text: string) => Promise<void>) | undefined;

  get isOpen(): boolean {
    return this.dlg !== undefined;
  }

  open(a: AgentView): void {
    if (!a.plan) return;
    this.dlg?.close();
    this.agentId = a.id;
    this.plan = undefined;
    this.lines = false;
    this.pick = undefined;
    this.sending = false;
    const editable = this.canApprove() && this.onApprove !== undefined && this.onRevise !== undefined;
    const close = h("button", { class: "btn icon", type: "button", title: t("닫기"), "aria-label": t("닫기") }, icon("close"));
    const file = h("span", {});
    const body = h("div", { class: "prose plan-body", tabindex: "-1" }, h("p", { class: "plan-wait" }, t("플랜을 읽는 중…")));
    const head = h("header", {}, icon("file"), h("div", { class: "names" }, h("b", {}, t("플랜 — {title}", { title: a.title })), file));
    const dlg = h("dialog", { class: "dlg plan-dlg" }, head, body);
    if (editable) {
      const lineBtn = h("button", { class: "btn", type: "button", "aria-pressed": "false", title: t("원문 줄에 번호를 붙여 보고, 줄 번호를 눌러 댓글을 답니다") }, icon("chat"), h("span", {}, t("줄 댓글")));
      lineBtn.addEventListener("click", () => this.toggleLines());
      head.append(lineBtn);
      dlg.append(this.footer(a, lineBtn));
    } else {
      dlg.append(h("p", { class: "plan-note" }, t("읽기만 하는 창입니다. 승인하거나 고치려면 닫고 터미널에서 답하세요.")));
    }
    head.append(close);
    this.dlg = dlg;
    this.body = body;
    this.file = file;
    close.addEventListener("click", () => dlg.close());
    // 창 밖(뒤 배경)을 누르면 닫는다.
    dlg.addEventListener("click", (e) => {
      if (e.target !== dlg) return;
      const box = dlg.getBoundingClientRect();
      if (e.clientX < box.left || e.clientX > box.right || e.clientY < box.top || e.clientY > box.bottom) dlg.close();
    });
    // 이 안에서 누른 키는 월드의 단축키도, 터미널로 가는 입력도 아니다.
    dlg.addEventListener("keydown", (e) => e.stopPropagation());
    // 줄 댓글을 적다가 누른 Esc 는 그 칸만 접는다.
    dlg.addEventListener("cancel", (e) => {
      if (!this.pick) return;
      e.preventDefault();
      this.setPick(undefined);
    });
    dlg.addEventListener("close", () => {
      dlg.remove();
      if (this.dlg !== dlg) return;
      this.dlg = this.body = this.file = this.ui = this.plan = undefined;
      this.onClose?.();
    });
    document.body.append(dlg);
    dlg.showModal();
    // 글에 초점을 둔다 — 화살표·PageDown·Space 로 바로 굴릴 수 있다.
    body.focus();
    this.load(a.plan);
  }

  private footer(a: AgentView, lineBtn: HTMLButtonElement): HTMLElement {
    const note = h("textarea", { class: "rv-note", rows: "1", maxlength: String(MAX_REVISE), placeholder: t("고칠 점 — 플랜 모드에 남아 고쳐 다시 묻습니다"), "aria-label": t("고칠 점") });
    note.value = this.draft().text;
    note.addEventListener("input", () => {
      this.draft().text = note.value;
      this.updateFoot();
    });
    // Ctrl/⌘+Enter 로 보낸다. 그냥 Enter 는 줄바꿈이다 — 여러 줄로 적는 일이 많다.
    note.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !e.isComposing) {
        e.preventDefault();
        void this.send(a);
      }
    });
    const send = h("button", { class: "btn", type: "button", title: t("적은 것을 플랜 카드의 고칠 점으로 보냅니다 (Ctrl+Enter)") }, icon("enter"), h("span", {}, t("고쳐 달라고 하기")));
    send.addEventListener("click", () => void this.send(a));
    const approve = h("button", { class: "btn primary", type: "button", title: t("플랜 카드의 Approve and start 를 누릅니다 (1)") }, icon("check"), h("span", {}, t("승인하고 시작")));
    approve.addEventListener("click", () => this.onApprove?.(a));
    const count = h("span", { class: "plan-count", hidden: "" });
    const error = h("p", { class: "rv-error", role: "alert", hidden: "" });
    this.ui = { lineBtn, note, send, count, error };
    this.updateFoot();
    return h("footer", { class: "plan-foot rv-foot" }, error, note, h("div", { class: "plan-acts" }, count, send, approve));
  }

  /** 이 에이전트에 적던 것. 지금 카드와 다른 카드에 적은 줄 댓글은 버린다. */
  private draft(): Draft {
    const card = this.plan?.card;
    let d = this.drafts.get(this.agentId);
    if (!d) this.drafts.set(this.agentId, (d = { card, text: "", notes: [] }));
    if (card !== undefined && d.card !== card) {
      if (d.card !== undefined) d.notes = [];
      d.card = card;
    }
    return d;
  }

  private updateFoot(): void {
    const ui = this.ui;
    if (!ui) return;
    const d = this.draft();
    const n = d.notes.length;
    ui.count.hidden = n === 0;
    ui.count.textContent = t("줄 댓글 {n}개", { n });
    ui.send.disabled = this.sending || this.plan?.card === undefined || (!d.text.trim() && n === 0);
    ui.send.lastElementChild!.textContent = this.sending ? t("보내는 중…") : t("고쳐 달라고 하기");
  }

  private toggleLines(): void {
    this.lines = !this.lines;
    this.pick = undefined;
    this.ui?.lineBtn.setAttribute("aria-pressed", String(this.lines));
    this.render(false);
    this.body?.focus();
  }

  /** 받은 플랜을 지금 보기로 그린다. keep: 다시 그린 것이면 읽던 자리를 지킨다. */
  private render(keep: boolean): void {
    const { body, plan } = this;
    if (!body || !plan) return;
    const top = body.scrollTop;
    body.classList.toggle("plan-src", this.lines);
    if (this.lines) body.replaceChildren(this.sourceView(plan.text));
    else body.replaceChildren(prose(plan.text));
    body.scrollTop = keep ? top : 0;
  }

  /** 원문 줄 보기: 줄마다 번호 단추와 글. 단 댓글은 그 범위의 끝 줄 아래에 붙는다. */
  private sourceView(text: string): HTMLElement {
    const src = text.replace(/\r\n?/g, "\n").split("\n");
    if (src.at(-1) === "") src.pop();
    const d = this.draft();
    const pick = this.pick;
    const box = h("div", { class: "plan-lines" });
    src.forEach((line, i) => {
      const n = i + 1;
      const on = (pick && n >= pick.from && n <= pick.to) || d.notes.some((c) => n >= c.from && n <= c.to);
      const no = h("button", { class: "ln", type: "button", "data-n": String(n), title: t("이 줄에 댓글") }, String(n));
      box.append(h("div", { class: on ? "pl-row on" : "pl-row" }, no, h("span", { class: "tx" }, line || " ")));
      d.notes.forEach((c, k) => {
        if (c.to === n) box.append(this.noteRow(c, k));
      });
      if (pick?.to === n) box.append(this.pickRow(pick));
    });
    box.addEventListener("click", (e) => {
      const n = Number((e.target as Element).closest<HTMLElement>(".ln")?.dataset.n);
      if (!n) return;
      // 고른 범위가 있으면 다른 줄을 눌러 넓힌다. 하나만 고른 줄을 다시 누르면 접는다.
      if (!pick) this.setPick({ from: n, to: n });
      else if (pick.from === n && pick.to === n) this.setPick(undefined);
      else this.setPick({ from: Math.min(pick.from, n), to: Math.max(pick.to, n) });
    });
    return box;
  }

  private noteRow(c: LineNote, k: number): HTMLElement {
    const del = h("button", { class: "btn icon", type: "button", title: t("댓글 지우기"), "aria-label": t("댓글 지우기") }, icon("trash"));
    del.addEventListener("click", () => {
      this.draft().notes.splice(k, 1);
      this.render(true);
      this.updateFoot();
    });
    return h("div", { class: "plan-cmt" }, h("span", { class: "where" }, span(c)), h("span", { class: "say" }, c.body), del);
  }

  private pickRow(pick: { from: number; to: number }): HTMLElement {
    const input = h("textarea", { class: "rv-note", rows: "1", placeholder: t("{lines} 줄에 댓글 — Enter 로 달기", { lines: span(pick) }), "aria-label": t("줄 댓글") });
    const add = (): void => {
      const body = input.value.trim();
      if (!body) return;
      const notes = this.draft().notes;
      notes.push({ ...pick, body });
      notes.sort((x, y) => x.to - y.to || x.from - y.from);
      this.setPick(undefined);
      this.updateFoot();
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        add();
      }
    });
    const ok = h("button", { class: "btn primary", type: "button" }, t("달기"));
    ok.addEventListener("click", add);
    const cancel = h("button", { class: "btn", type: "button" }, t("취소"));
    cancel.addEventListener("click", () => this.setPick(undefined));
    queueMicrotask(() => input.focus({ preventScroll: true }));
    return h("div", { class: "plan-cmt edit" }, input, ok, cancel);
  }

  private setPick(pick: { from: number; to: number } | undefined): void {
    this.pick = pick;
    this.render(true);
    if (!pick) this.body?.focus({ preventScroll: true });
  }

  /** 보낼 글: 줄 댓글(파일:줄, 그 줄 원문, 댓글)과 고칠 점. desk-plan 이 이 글을 "고쳐 달라"는 사유로 감싸 Claude 에게 준다. */
  private compose(): string {
    const plan = this.plan;
    const d = this.draft();
    const wish = d.text.trim();
    if (!plan || d.notes.length === 0) return wish;
    const src = plan.text.replace(/\r\n?/g, "\n").split("\n");
    const blocks = d.notes.map((c) => {
      const width = String(c.to).length;
      const quoted = src.slice(c.from - 1, c.to).map((line, i) => `${String(c.from + i).padStart(width)} ${line}`);
      // 원문에 ``` 가 있어도 닫히지 않게 그보다 긴 울타리를 쓴다.
      const longest = Math.max(0, ...quoted.flatMap((l) => (l.match(/`+/g) ?? []).map((r) => r.length)));
      const fence = "`".repeat(Math.max(3, longest + 1));
      return `${plan.name}:${span(c)}\n${fence}\n${quoted.join("\n")}\n${fence}\n${c.body}`;
    });
    const notes = [`Comments on lines of the plan file (line numbers are the file's, each quoting the lines as they were):`, ...blocks].join("\n\n");
    return wish ? `${notes}\n\nAlso:\n\n${wish}` : notes;
  }

  private async send(a: AgentView): Promise<void> {
    const ui = this.ui;
    const card = this.plan?.card;
    if (!ui || !this.onRevise || this.sending || card === undefined || ui.send.disabled) return;
    const text = this.compose();
    if (text.length > MAX_REVISE) {
      this.showError(t("고칠 점이 너무 깁니다."));
      return;
    }
    const dlg = this.dlg;
    this.sending = true;
    this.showError("");
    this.updateFoot();
    try {
      await this.onRevise(a, card, text);
      // 보냈다 — 카드가 내려갔으니 적던 것은 버린다. 창은 다음 스냅샷에서 닫힌다.
      this.drafts.delete(a.id);
    } catch (e) {
      if (this.dlg === dlg) this.showError((e as Error).message);
    } finally {
      this.sending = false;
      if (this.dlg === dlg) this.updateFoot();
    }
  }

  private showError(message: string): void {
    const el = this.ui?.error;
    if (!el) return;
    el.textContent = message;
    el.hidden = !message;
  }

  /** 새 스냅샷에 맞춘다: 카드가 내려갔으면(승인·거절·세션 종료) 닫고, 에이전트가 플랜을 고쳤으면 다시 읽는다. */
  sync(agents: readonly AgentView[]): void {
    for (const id of this.drafts.keys()) if (!agents.some((a) => a.id === id && a.plan)) this.drafts.delete(id);
    if (!this.dlg) return;
    const plan = agents.find((a) => a.id === this.agentId)?.plan;
    if (!plan) this.dlg.close();
    else if (plan !== this.at) this.load(plan);
  }

  private load(at: number): void {
    const { dlg, body, file } = this;
    if (!dlg || !body || !file) return;
    this.at = at;
    void get<Plan>(`/api/plan?agent=${encodeURIComponent(this.agentId)}`)
      .then((plan) => {
        if (this.dlg !== dlg || this.at !== at) return;
        const again = this.plan !== undefined;
        // 다른 카드의 글이면 고르던 줄도 놓는다.
        if (this.plan?.card !== plan.card) this.pick = undefined;
        this.plan = plan;
        file.textContent = plan.name;
        this.render(again);
        this.updateFoot();
      })
      .catch((e: Error) => {
        if (this.dlg !== dlg || this.at !== at) return;
        // 이미 읽고 있던 글이 있으면 그대로 둔다 — 다음 스냅샷에서 카드가 내려갔으면 창이 닫힌다.
        if (body.querySelector(".plan-wait")) body.replaceChildren(h("p", { class: "plan-wait" }, t("플랜을 읽지 못했습니다."), " ", e.message));
      });
  }
}

/** 줄 범위를 글로: 12, 12–14. */
function span(r: { from: number; to: number }): string {
  return r.from === r.to ? String(r.from) : `${r.from}–${r.to}`;
}
