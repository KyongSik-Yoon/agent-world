// 승인을 기다리는 플랜을 읽고, 승인하거나 고칠 점을 보내는 창.
//
// 플랜 승인 카드가 뜨면 터미널에는 플랜이 옆 창에 잘려 보인다 — 그 창은 터미널 안의 그림이라 월드에서는 굴릴 수 없다.
// 플랜은 파일로 있으므로(server/plan.ts) 그 글을 받아 응답 글처럼 그려 보여 준다. 다 읽고 바로 승인하거나, 고칠 점을
// 적어 보낸다. 고칠 점은 desk-plan 카드의 글 칸과 같은 답으로 간다(서버가 카드의 답 파이프에 써 넣는다).
//
// 줄 댓글은 desk-look 의 미리보기 패널처럼 원문 줄 보기에서 단다: 줄 번호를 누르고(다른 번호를 누르면 범위) 적는다.
// 보낼 때 댓글마다 파일:줄과 그 줄 원문을 붙여 고칠 점 글 앞에 싣는다(desk-plan 의 reviseReason 과 같은 모양).
// 적던 것은 창을 닫아도 그 카드가 떠 있는 동안 남는다.
//
// AGY 가 남긴 글(아티팩트, server/artifact.ts)도 이 창으로 읽는다. 승인을 바라지 않는 보고서는 읽기만 한다. 승인을 바란
// 글은 아무것도 막고 있지 않고 턴이 끝나 있어 답은 평범한 지시다 — 같은 글 칸과 줄 댓글로 적되, 카드 대신 지시로 보낸다(/api/prompt, 받음 확인까지).
// 승인도 누를 키가 없어 승인한다는 지시를 보낸다. 적은 것이 있으면 그것을 반영해 진행하라고 함께 싣는다.
import type { AgentView } from "../shared/types.ts";
import { ApiError, get } from "./api.ts";
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
  /** 보낸 때의 파일 이름과 그 줄 원문 — 닿지 않은 초안을 다음 카드로 옮길 때 줄이 그대로인지 맞춰 본다. */
  sent?: { name: string; lines: string[] };
}

/** 한 카드에 적던 것. */
interface Draft {
  card: number | undefined;
  text: string;
  notes: LineNote[];
  /**
   * 보냈는데 카드만 내려가고 Claude 에 닿지 않았다(desk-plan 이 답을 알아보지 못했거나 확인하지 못했다). 카드가 없어도
   * 지우지 않고, 다음 카드에 줄 댓글까지 그대로 옮긴다 — 플랜이 그대로여서 같은 말을 다시 보내게 된다.
   */
  unsent?: boolean;
}

/** 읽는 글: Claude 의 승인 카드에 걸린 플랜, 또는 AGY 가 승인을 바라고 남긴 글. */
type Kind = "plan" | "artifact";

/** 그 글이 고쳐진 시각 — 없으면 읽을 것이 없다. */
function stampOf(a: AgentView, kind: Kind): number | undefined {
  return kind === "plan" ? a.plan : a.artifact;
}

/** 서버가 받는 길이(control.ts MAX_REVISE). */
const MAX_REVISE = 16_000;

export class PlanReader {
  private dlg: HTMLDialogElement | undefined;
  private body: HTMLElement | undefined;
  private file: HTMLElement | undefined;
  private agentId = "";
  private kind: Kind = "plan";
  /** 지금 보여 주는(또는 받아 오는 중인) 글이 고쳐진 시각. */
  private at = 0;
  /** 받아 온 플랜. */
  private plan: Plan | undefined;
  /** 원문 줄 보기인지. */
  private lines = false;
  /** 원문 줄 보기에서 댓글을 적으려고 고른 범위. */
  private pick: { from: number; to: number } | undefined;
  private sending = false;
  /**
   * 답을 적던 AGY 의 글이 열어 둔 사이 다른 곳에서(다른 기기, 터미널) 답해졌다 — 단추를 잠그고 읽던 글과 적던 것은 그대로
   * 둔다. 창을 닫으면 적던 것이 사라지고, 단추가 살아 있으면 같은 승인이 또 가거나 뒤에 쓰인 보고서에 승인이 간다.
   */
  private locked = false;
  /** 에이전트마다 적던 것 — 창을 닫았다 열어도 남는다. 다른 카드가 뜨면 줄 댓글은 버린다(줄 번호가 옛 플랜의 것이다). */
  private readonly drafts = new Map<string, Draft>();
  private ui: { lineBtn: HTMLButtonElement; note: HTMLTextAreaElement; send: HTMLButtonElement; approve: HTMLButtonElement; count: HTMLElement; error: HTMLElement } | undefined;
  /** 닫힌 뒤에 부른다 — 크게 보기가 열려 있으면 입력을 다시 그리로 돌린다. */
  onClose: (() => void) | undefined;
  /** 이 월드가 pane 을 조작할 수 있는지(보기 전용이 아닌지). */
  canApprove: () => boolean = () => false;
  /** 승인 단추를 눌렀다. 카드가 내려가면 다음 스냅샷(sync)에서 창이 닫힌다. */
  onApprove: ((a: AgentView) => void) | undefined;
  /** 고칠 점을 보낸다. 카드가 내려가는 것까지 확인되면 끝난다. 실패하면 던진다 — 적던 것은 그대로 둔다. */
  onRevise: ((a: AgentView, card: number, text: string) => Promise<void>) | undefined;
  /** 보낸 고칠 점이 카드와 함께 사라졌다(창은 카드를 따라 닫힌다). text 는 보낸 글. */
  onLost: ((a: AgentView, message: string, text: string) => void) | undefined;
  /** AGY 의 글에 대한 답(승인·고칠 점)을 지시로 보낸다. 닿지 않으면 던진다 — 적던 것은 그대로 둔다. */
  onArtifactSend: ((a: AgentView, text: string, approve: boolean) => Promise<void>) | undefined;

  get isOpen(): boolean {
    return this.dlg !== undefined;
  }

  /** kind 를 주지 않으면 승인 카드의 플랜이 있으면 그것을, 없으면 AGY 의 글을 연다. */
  open(a: AgentView, kind: Kind = a.plan ? "plan" : "artifact"): void {
    const stamp = stampOf(a, kind);
    if (!stamp) return;
    this.dlg?.close();
    this.agentId = a.id;
    this.kind = kind;
    this.plan = undefined;
    this.lines = false;
    this.pick = undefined;
    this.sending = false;
    this.locked = false;
    const editable =
      this.canApprove() &&
      (kind === "plan" ? this.onApprove !== undefined && this.onRevise !== undefined : this.onArtifactSend !== undefined && a.paneId !== undefined && a.artifactReport !== true && a.artifactAnswered !== true);
    const close = h("button", { class: "btn icon", type: "button", title: t("닫기"), "aria-label": t("닫기") }, icon("close"));
    const file = h("span", {});
    const body = h("div", { class: "prose plan-body", tabindex: "-1" }, h("p", { class: "plan-wait" }, kind === "plan" ? t("플랜을 읽는 중…") : t("글을 읽는 중…")));
    const name = kind === "plan" ? t("플랜 — {title}", { title: a.title }) : t("아티팩트 — {title}", { title: a.title });
    const head = h("header", {}, icon("file"), h("div", { class: "names" }, h("b", {}, name), file));
    const dlg = h("dialog", { class: "dlg plan-dlg" }, head, body);
    if (editable) {
      const lineBtn = h("button", { class: "btn", type: "button", "aria-pressed": "false", title: t("원문 줄에 번호를 붙여 보고, 줄 번호를 눌러 댓글을 답니다") }, icon("chat"), h("span", {}, t("줄 댓글")));
      lineBtn.addEventListener("click", () => this.toggleLines());
      head.append(lineBtn);
      dlg.append(this.footer(a, lineBtn));
    } else if (kind === "artifact") {
      dlg.append(h("p", { class: "plan-note" }, a.artifactReport ? t("읽기만 하는 글입니다. 할 말은 닫고 입력줄로 보내세요.") : a.artifactAnswered ? t("이미 답한 글입니다. 더 할 말은 닫고 입력줄로 보내세요.") : t("읽기만 하는 창입니다.")));
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
      // 잠긴 창에 남겨 둔 것은 창과 함께 버린다 — 이미 답한 글의 것이다.
      if (this.locked) this.drafts.delete(this.agentId);
      this.locked = false;
      this.dlg = this.body = this.file = this.ui = this.plan = undefined;
      this.onClose?.();
    });
    document.body.append(dlg);
    dlg.showModal();
    // 글에 초점을 둔다 — 화살표·PageDown·Space 로 바로 굴릴 수 있다.
    body.focus();
    this.load(stamp);
  }

  private footer(a: AgentView, lineBtn: HTMLButtonElement): HTMLElement {
    const plan = this.kind === "plan";
    const note = h("textarea", { class: "rv-note", rows: "1", maxlength: String(MAX_REVISE), placeholder: plan ? t("고칠 점 — 플랜 모드에 남아 고쳐 다시 묻습니다") : t("고칠 점 — 글을 고쳐 다시 묻습니다"), "aria-label": t("고칠 점") });
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
    const send = h("button", { class: "btn", type: "button", title: plan ? t("적은 것을 플랜 카드의 고칠 점으로 보냅니다 (Ctrl+Enter)") : t("적은 것을 고쳐 달라는 지시로 보냅니다 (Ctrl+Enter)") }, icon("enter"), h("span", {}, t("고쳐 달라고 하기")));
    send.addEventListener("click", () => void this.send(a));
    const approve = plan
      ? h("button", { class: "btn primary", type: "button", title: t("플랜 카드의 Approve and start 를 누릅니다 (1)") }, icon("check"), h("span", {}, t("승인하고 시작")))
      : h("button", { class: "btn primary", type: "button", title: t("승인한다는 지시를 보냅니다. 적은 것이 있으면 반영해 진행하라고 함께 보냅니다") }, icon("check"), h("span", {}, t("승인하고 진행")));
    approve.addEventListener("click", () => (plan ? this.onApprove?.(a) : void this.send(a, true)));
    const count = h("span", { class: "plan-count", hidden: "" });
    const error = h("p", { class: "rv-error", role: "alert", hidden: "" });
    this.ui = { lineBtn, note, send, approve, count, error };
    this.updateFoot();
    return h("footer", { class: "plan-foot rv-foot" }, error, note, h("div", { class: "plan-acts" }, count, send, approve));
  }

  /** 이 에이전트에 적던 것. 지금 카드와 다른 카드에 적은 줄 댓글은 버린다. */
  private draft(): Draft {
    const card = this.plan?.card;
    let d = this.drafts.get(this.agentId);
    if (!d) this.drafts.set(this.agentId, (d = { card, text: "", notes: [] }));
    if (card !== undefined && d.card !== card) {
      if (d.card !== undefined && !d.unsent) d.notes = [];
      else if (d.unsent && this.plan) this.carry(d, this.plan);
      d.card = card;
      d.unsent = false;
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
    ui.send.disabled = this.locked || this.sending || this.plan?.card === undefined || (!d.text.trim() && n === 0);
    ui.send.lastElementChild!.textContent = this.sending ? t("보내는 중…") : t("고쳐 달라고 하기");
    // 승인 카드의 승인은 키 하나라 글을 기다리지 않는다. AGY 의 승인은 지시라 받은 글이 있어야 무엇을 승인하는지 안다.
    if (this.kind === "artifact") ui.approve.disabled = this.locked || this.sending || this.plan === undefined;
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
      if (!n || this.locked) return;
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
    const src = lines(plan.text);
    const blocks = d.notes.map((c) => noteBlock(plan.name, c, src.slice(c.from - 1, c.to)));
    const notes = [`Comments on lines of the plan file (line numbers are the file's, each quoting the lines as they were):`, ...blocks].join("\n\n");
    return wish ? `${notes}\n\nAlso:\n\n${wish}` : notes;
  }

  /**
   * 닿지 않은 초안을 새 카드로 옮긴다. 그 사이 플랜이 바뀌었을 수 있다(확인만 못 했고 실은 닿아 고쳐졌거나, 엔진 창에서
   * 따로 답했다) — 줄 원문이 그대로인 댓글만 줄에 남기고, 달라진 것은 보낸 때의 인용째 글 칸으로 옮긴다. 줄 번호만 믿으면
   * 옛 댓글이 엉뚱한 줄을 인용해 간다.
   */
  private carry(d: Draft, plan: Plan): void {
    const src = lines(plan.text);
    const moved: string[] = [];
    d.notes = d.notes.filter((c) => {
      if (!c.sent) return true;
      const now = src.slice(c.from - 1, c.to);
      const same = now.length === c.sent.lines.length && now.every((l, i) => l === c.sent!.lines[i]);
      if (!same) moved.push(noteBlock(c.sent.name, c, c.sent.lines));
      return same;
    });
    if (!moved.length) return;
    d.text = [...moved, d.text.trim()].filter(Boolean).join("\n\n");
    // 글 칸은 창을 열 때 초안을 읽었다 — 옮긴 것이 보이게 고쳐 둔다.
    if (this.ui) this.ui.note.value = d.text;
  }

  private async send(a: AgentView, approve = false): Promise<void> {
    if (this.kind === "artifact") return this.sendArtifact(a, approve);
    const ui = this.ui;
    const plan = this.plan;
    const card = plan?.card;
    if (!ui || !plan || !this.onRevise || this.sending || card === undefined || ui.send.disabled) return;
    const text = this.compose();
    if (text.length > MAX_REVISE) {
      this.showError(t("고칠 점이 너무 깁니다."));
      return;
    }
    const dlg = this.dlg;
    this.sending = true;
    this.showError("");
    this.updateFoot();
    // 답을 기다리는 사이 카드가 내려가 스냅샷(sync)이 먼저 올 수 있다 — 닿았다고 확인될 때까지는 지우지 않게 둔다.
    const draft = this.draft();
    draft.unsent = true;
    const src = lines(plan.text);
    for (const c of draft.notes) c.sent = { name: plan.name, lines: src.slice(c.from - 1, c.to) };
    try {
      await this.onRevise(a, card, text);
      // 닿았다 — 적던 것은 버린다. 창은 다음 스냅샷에서 닫힌다.
      this.drafts.delete(a.id);
    } catch (e) {
      // 카드는 내려갔는데 닿지 않았다 — 창은 카드를 따라 닫히므로 밖에서 알리고, 적던 것은 다음 카드까지 둔다.
      if (e instanceof ApiError && e.status === 502) this.onLost?.(a, e.message, text);
      else {
        draft.unsent = false;
        if (this.dlg === dlg) this.showError((e as Error).message);
      }
    } finally {
      this.sending = false;
      if (this.dlg === dlg) this.updateFoot();
    }
  }

  /**
   * AGY 의 글에 답한다. 고칠 점이면 글을 고쳐 다시 묻게 하고, 승인이면 진행하게 한다 — 적은 것이 있으면 반영하라고 함께 싣는다.
   * 지시는 받음 확인까지 기다린다. 닿으면 적던 것을 버리고 창을 닫는다(로그에 지시가 적히면 카드가 접힌다).
   */
  private async sendArtifact(a: AgentView, approve: boolean): Promise<void> {
    const ui = this.ui;
    const plan = this.plan;
    if (!ui || !plan || !this.onArtifactSend || this.sending || (approve ? ui.approve.disabled : ui.send.disabled)) return;
    const body = this.compose();
    const head = approve
      ? body
        ? t("{name} 확인했습니다. 승인합니다 — 아래를 반영해 진행해 주세요.", { name: plan.name })
        : t("{name} 확인했습니다. 승인합니다 — 이대로 진행해 주세요.", { name: plan.name })
      : t("{name} 에 고칠 점이 있습니다. 아래를 반영해 글을 고친 뒤 다시 승인을 청해 주세요.", { name: plan.name });
    const text = body ? `${head}\n\n${body}` : head;
    if (text.length > MAX_REVISE) {
      this.showError(t("고칠 점이 너무 깁니다."));
      return;
    }
    const dlg = this.dlg;
    this.sending = true;
    this.showError("");
    this.updateFoot();
    try {
      await this.onArtifactSend(a, text, approve);
      this.drafts.delete(a.id);
      if (this.dlg === dlg) dlg?.close();
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
    // 열어 둔 창에 적던 것은 보내는 중이거나 잠긴 동안 둔다 — 보내는 중에는 닿기 전에 답한 것으로 보일 수 있고, 잠긴 창은
    // 적던 것을 보여 주고 있다.
    const held = this.dlg && (this.sending || this.locked) ? this.agentId : undefined;
    for (const [id, d] of this.drafts) if (!d.unsent && id !== held && !agents.some((a) => a.id === id && (a.plan || (a.artifact && !a.artifactReport && !a.artifactAnswered)))) this.drafts.delete(id);
    if (!this.dlg) return;
    const agent = agents.find((a) => a.id === this.agentId);
    const stamp = agent && stampOf(agent, this.kind);
    if (!stamp) {
      this.dlg.close();
      return;
    }
    if (this.kind === "artifact") {
      // 보내는 중에는 건드리지 않는다 — 닿으면 창이 닫히고, 닿지 않으면 다음 스냅샷에서 잠근다.
      if (this.sending) return;
      if (this.ui && !this.locked && (agent.artifactReport || agent.artifactAnswered)) this.lock();
      // 잠긴 창은 읽던 글을 그대로 둔다 — 뒤에 쓰인 보고서로 바꾸면 적어 둔 줄 댓글이 엉뚱한 글에 붙는다.
      if (this.locked) return;
    }
    if (stamp !== this.at) this.load(stamp);
  }

  /** 답을 적던 글이 다른 곳에서 답해졌다: 단추와 글 칸을 잠그고 그렇다고 적는다. 읽던 글과 적던 것은 남긴다. */
  private lock(): void {
    const ui = this.ui;
    if (!ui) return;
    this.locked = true;
    ui.note.readOnly = true;
    ui.lineBtn.disabled = true;
    ui.note.closest("footer")?.before(h("p", { class: "plan-note", role: "status" }, t("다른 곳에서 이미 답한 글입니다. 적은 것은 복사해 두고, 닫은 뒤 입력줄로 보내세요.")));
    this.showError("");
    if (this.pick) this.setPick(undefined);
    this.updateFoot();
  }

  private load(at: number): void {
    const { dlg, body, file } = this;
    if (!dlg || !body || !file) return;
    this.at = at;
    void get<Plan>(`/api/${this.kind}?agent=${encodeURIComponent(this.agentId)}`)
      .then((plan) => {
        if (this.dlg !== dlg || this.at !== at) return;
        // AGY 의 글에는 카드가 없다 — 고쳐진 시각을 카드 삼아, 글이 바뀌면 옛 줄 번호에 단 댓글을 놓는다.
        if (this.kind === "artifact") plan.card = plan.at;
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
        if (body.querySelector(".plan-wait")) body.replaceChildren(h("p", { class: "plan-wait" }, this.kind === "plan" ? t("플랜을 읽지 못했습니다.") : t("글을 읽지 못했습니다."), " ", e.message));
      });
  }
}

function lines(text: string): string[] {
  return text.replace(/\r\n?/g, "\n").split("\n");
}

/** 줄 댓글 하나: 파일:줄, 울타리 친 원문(줄 번호 붙임), 댓글. */
function noteBlock(name: string, c: LineNote, quote: string[]): string {
  const width = String(c.to).length;
  const quoted = quote.map((line, i) => `${String(c.from + i).padStart(width)} ${line}`);
  // 원문에 ``` 가 있어도 닫히지 않게 그보다 긴 울타리를 쓴다.
  const longest = Math.max(0, ...quoted.flatMap((l) => (l.match(/`+/g) ?? []).map((r) => r.length)));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${name}:${span(c)}\n${fence}\n${quoted.join("\n")}\n${fence}\n${c.body}`;
}

/** 줄 범위를 글로: 12, 12–14. */
function span(r: { from: number; to: number }): string {
  return r.from === r.to ? String(r.from) : `${r.from}–${r.to}`;
}
