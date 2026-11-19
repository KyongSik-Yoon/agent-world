// 리뷰 보고를 읽고, 고칠 항목을 골라 보내는 창.
//
// desk-review 의 simplify-review 는 결과를 터미널 옆 패널에 그린다 — 휴대폰에서는 그 패널을 볼 수 없다. 보고는 로그에
// 도구 입력으로 남으므로(server/review.ts) 받아서 따로 그린다. 위에서부터 사람이 정할 것(남은 결함) → 이미 된 것 →
// 버린 것 순이다. 남은 결함과 넘긴 정리는 골라서 "고쳐 줘" 지시로 그 pane 에 보낸다.
import type { AgentView, ReviewItem, ReviewReport } from "../shared/types.ts";
import { get } from "./api.ts";
import { h, icon, prose } from "./dom.ts";
import { t } from "./i18n.ts";

type Group = "found" | "review-fixed" | "skipped" | "simplify-fixed" | "dismissed";

const GROUPS: ReadonlyArray<{ key: Group; title: () => string; color: string; open: boolean; pick: boolean }> = [
  { key: "found", title: () => t("남은 결함"), color: "var(--blocked)", open: true, pick: true },
  { key: "review-fixed", title: () => t("리뷰에서 고친 것"), color: "var(--done)", open: true, pick: false },
  { key: "skipped", title: () => t("넘긴 정리"), color: "var(--working)", open: false, pick: true },
  { key: "simplify-fixed", title: () => t("정리한 것"), color: "var(--done)", open: false, pick: false },
  { key: "dismissed", title: () => t("버린 지적"), color: "var(--idle)", open: false, pick: false },
];

function groupOf(item: ReviewItem): Group {
  if (item.stage === "simplify") return item.status === "fixed" ? "simplify-fixed" : "skipped";
  return item.status === "fixed" ? "review-fixed" : item.status === "found" ? "found" : "dismissed";
}

/** 지시에 싣는 한 줄 — 에이전트가 보고의 어느 항목인지 알아볼 만큼만. */
function oneLine(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const chars = [...flat];
  return chars.length <= max ? flat : `${chars.slice(0, max - 1).join("")}…`;
}

export class ReviewReader {
  private dlg: HTMLDialogElement | undefined;
  private body: HTMLElement | undefined;
  private foot: HTMLElement | undefined;
  private agent: AgentView | undefined;
  /** 지금 보여 주는(또는 받아 오는 중인) 보고의 시각. */
  private at = 0;
  /** 체크한 항목(보고 안의 차례)과, 그 고름이 어느 보고의 것인지. */
  private readonly picked = new Set<number>();
  private pickedFor = 0;
  private sending = false;
  private sendBtn: HTMLButtonElement | undefined;
  private note: HTMLTextAreaElement | undefined;
  private report: ReviewReport | undefined;
  private error: HTMLElement | undefined;
  /** 닫힌 뒤에 부른다. */
  onClose: (() => void) | undefined;
  /** 이 월드가 pane 에 지시를 보낼 수 있는지(보기 전용이 아닌지). */
  canSend: () => boolean = () => false;
  /** 고를 항목을 담은 지시를 보낸다. 실패하면 던진다 — 창은 열어 둔다. */
  onSend: ((a: AgentView, text: string) => Promise<void>) | undefined;

  get isOpen(): boolean {
    return this.dlg !== undefined;
  }

  open(a: AgentView): void {
    if (!a.review) return;
    this.dlg?.close();
    this.agent = a;
    // 앞 창에서 적던 말·보내던 상태는 이 창의 것이 아니다 — 다른 에이전트에게 새어 가지 않게 비운다.
    this.pickedFor = 0;
    this.sending = false;
    this.note = this.sendBtn = this.error = this.report = undefined;
    const close = h("button", { class: "btn icon", type: "button", title: t("닫기"), "aria-label": t("닫기") }, icon("close"));
    const body = h("div", { class: "plan-body rv-body", tabindex: "-1" }, h("p", { class: "plan-wait" }, t("리뷰 보고를 읽는 중…")));
    const foot = h("footer", { class: "plan-foot rv-foot" });
    const dlg = h("dialog", { class: "dlg plan-dlg rv-dlg" }, h("header", {}, icon("search"), h("div", { class: "names" }, h("b", {}, t("리뷰 — {title}", { title: a.title })), h("span", {}, "desk-review")), close), body, foot);
    this.dlg = dlg;
    this.body = body;
    this.foot = foot;
    close.addEventListener("click", () => dlg.close());
    dlg.addEventListener("click", (e) => {
      if (e.target !== dlg) return;
      const box = dlg.getBoundingClientRect();
      if (e.clientX < box.left || e.clientX > box.right || e.clientY < box.top || e.clientY > box.bottom) dlg.close();
    });
    // 이 안에서 누른 키는 월드의 단축키도, 터미널로 가는 입력도 아니다.
    dlg.addEventListener("keydown", (e) => e.stopPropagation());
    dlg.addEventListener("close", () => {
      dlg.remove();
      if (this.dlg !== dlg) return;
      this.dlg = this.body = this.foot = this.agent = undefined;
      this.note = this.sendBtn = this.error = this.report = undefined;
      this.onClose?.();
    });
    document.body.append(dlg);
    dlg.showModal();
    body.focus();
    this.load(a.review);
  }

  /** 새 스냅샷에 맞춘다: 보고가 없어졌으면(세션이 바뀌었다) 닫고, 새 보고면 다시 읽는다. */
  sync(agents: readonly AgentView[]): void {
    if (!this.dlg || !this.agent) return;
    const a = agents.find((x) => x.id === this.agent!.id);
    if (!a?.review) this.dlg.close();
    else {
      this.agent = a;
      if (a.review !== this.at) this.load(a.review);
    }
  }

  private load(at: number): void {
    const { dlg, body, agent } = this;
    if (!dlg || !body || !agent) return;
    this.at = at;
    void get<ReviewReport>(`/api/review?agent=${encodeURIComponent(agent.id)}`)
      .then((report) => {
        if (this.dlg !== dlg || this.at !== at) return;
        this.render(report);
      })
      .catch((e: Error) => {
        if (this.dlg !== dlg || this.at !== at) return;
        if (body.querySelector(".plan-wait")) body.replaceChildren(h("p", { class: "plan-wait" }, t("리뷰 보고를 읽지 못했습니다."), " ", e.message));
      });
  }

  private render(report: ReviewReport): void {
    const { body, foot } = this;
    if (!body || !foot) return;
    const canPick = this.canSend() && this.onSend !== undefined;
    const by = new Map<Group, number[]>();
    report.items.forEach((item, i) => {
      const g = groupOf(item);
      by.set(g, [...(by.get(g) ?? []), i]);
    });
    // 처음 열 때 남은 결함은 모두 골라 둔다 — 대개 그것을 고치라고 답한다. 넘긴 정리는 일부러 남긴 것이라 비워 둔다.
    if (this.pickedFor !== report.at) {
      this.pickedFor = report.at;
      this.picked.clear();
      for (const i of by.get("found") ?? []) this.picked.add(i);
    }

    const counts = h("div", { class: "rv-counts" });
    for (const g of GROUPS) {
      const n = by.get(g.key)?.length ?? 0;
      if (n === 0 && g.key !== "found") continue;
      const chip = h("span", { class: "rv-count" }, g.title(), h("b", {}, String(n)));
      chip.style.setProperty("--c", g.color);
      counts.append(chip);
    }
    const out: Node[] = [h("div", { class: "prose rv-summary" }, prose(report.summary)), counts];

    for (const g of GROUPS) {
      const idx = by.get(g.key) ?? [];
      // 남은 결함은 없어도 적는다 — 고칠 것이 없다는 것이 이 보고에서 가장 먼저 알고 싶은 것이다.
      if (idx.length === 0 && g.key !== "found") continue;
      const list = h("div", { class: "rv-list" });
      if (idx.length === 0) list.append(h("p", { class: "rv-none" }, t("없음")));
      for (const i of idx) list.append(this.item(report.items[i]!, i, g, canPick && g.pick));
      const sec = h("details", { class: "rv-group" }, h("summary", {}, h("span", {}, g.title()), h("b", {}, String(idx.length))), list);
      sec.style.setProperty("--c", g.color);
      sec.open = g.open;
      out.push(sec);
    }
    if (report.unverified) out.push(h("section", { class: "rv-text" }, h("h4", {}, t("확인 못 한 것")), h("div", { class: "prose" }, prose(report.unverified))));
    if (report.next) out.push(h("section", { class: "rv-text" }, h("h4", {}, t("다음 할 일")), h("div", { class: "prose" }, prose(report.next))));

    // 다시 받은 보고면 읽던 자리를 지킨다.
    const top = body.scrollTop;
    body.replaceChildren(...out);
    body.scrollTop = top;
    this.renderFoot(report, canPick);
  }

  private item(item: ReviewItem, i: number, g: (typeof GROUPS)[number], pick: boolean): HTMLElement {
    const slash = item.file.lastIndexOf("/");
    const where = h("div", { class: "rv-where", title: `${item.file}:${item.line}` }, slash >= 0 ? h("span", { class: "rv-dir" }, item.file.slice(0, slash + 1)) : null, h("b", {}, item.file.slice(slash + 1)), h("span", { class: "rv-line" }, `:${item.line}`));
    const text = h("div", { class: "rv-main" }, where, h("div", { class: "prose rv-reason" }, prose(item.reason)));
    if (item.resolution) text.append(h("div", { class: "rv-res" }, h("span", { class: "rv-label" }, item.status === "fixed" ? t("고친 방법") : t("남긴 까닭")), h("div", { class: "prose" }, prose(item.resolution))));
    if (!pick) {
      const el = h("div", { class: "rv-item" }, text);
      el.style.setProperty("--c", g.color);
      return el;
    }
    const box = h("input", { type: "checkbox", "aria-label": `${item.file}:${item.line}` });
    box.checked = this.picked.has(i);
    box.addEventListener("change", () => {
      if (box.checked) this.picked.add(i);
      else this.picked.delete(i);
      this.updateSend();
    });
    const el = h("label", { class: "rv-item pick" }, box, text);
    el.style.setProperty("--c", g.color);
    return el;
  }

  private renderFoot(report: ReviewReport, canPick: boolean): void {
    const foot = this.foot;
    if (!foot) return;
    this.report = report;
    if (!canPick) {
      this.sendBtn = this.note = this.error = undefined;
      foot.replaceChildren(h("span", { class: "plan-note" }, t("읽기만 하는 창입니다. 고치게 하려면 터미널에서 답하세요.")));
      return;
    }
    // 다시 그려도 적던 말은 지킨다.
    const draft = this.note?.value ?? "";
    const note = h("textarea", { class: "rv-note", rows: "1", placeholder: t("덧붙일 말 (선택)"), "aria-label": t("덧붙일 말 (선택)") });
    note.value = draft;
    const send = h("button", { class: "btn primary", type: "button" }, icon("enter"), h("span", {}));
    send.addEventListener("click", () => void this.send());
    this.note = note;
    this.sendBtn = send;
    this.error = h("p", { class: "rv-error", role: "alert", hidden: "" });
    foot.replaceChildren(this.error, note, send);
    this.updateSend();
  }

  private updateSend(): void {
    const send = this.sendBtn;
    if (!send) return;
    const n = this.picked.size;
    send.disabled = this.sending || n === 0;
    send.lastElementChild!.textContent = this.sending ? t("보내는 중…") : n === 0 ? t("고칠 항목을 고르세요") : t("{n}건 고치게 하기", { n });
    send.title = t("고른 항목을 고치라는 지시를 이 에이전트에게 보냅니다");
  }

  /** 고른 항목을 지시 글로 — 경로·줄과 이유 한 줄. 보고는 에이전트의 대화에 그대로 있으니 알아볼 만큼만 싣는다. */
  private compose(report: ReviewReport): string {
    const picked = [...this.picked].sort((a, b) => a - b).map((i) => report.items[i]).filter((x) => x !== undefined);
    const lines = picked.map((item, n) => `${n + 1}. ${item.stage === "simplify" ? t("[정리] ") : ""}${item.file}:${item.line} — ${oneLine(item.reason)}`);
    const note = this.note?.value.trim();
    return [t("방금 리뷰 보고에서 아래 {n}건을 고쳐 줘.", { n: picked.length }), ...lines, ...(note ? ["", note] : [])].join("\n");
  }

  private async send(): Promise<void> {
    const { agent, report, dlg } = this;
    if (!agent || !report || !dlg || !this.onSend || this.sending || this.picked.size === 0) return;
    this.sending = true;
    if (this.error) this.error.hidden = true;
    this.updateSend();
    try {
      await this.onSend(agent, this.compose(report));
      // 할 일을 보냈으니 닫는다. 보고는 남아 상태 창에서 다시 열 수 있다.
      dlg.close();
    } catch (e) {
      // 알림(토스트)은 모달 창 뒤에 깔려 보이지 않는다 — 창 안에 적고, 창은 열어 두어 다시 보낼 수 있게 한다.
      if (this.error && this.dlg === dlg) {
        this.error.textContent = `${t("지시를 보내지 못했습니다")} — ${(e as Error).message}`;
        this.error.hidden = false;
      }
    } finally {
      // 보내는 사이에 창을 닫고 새로 열었으면 그 창의 상태는 건드리지 않는다.
      if (this.dlg === dlg) {
        this.sending = false;
        this.updateSend();
      }
    }
  }
}
