// 승인을 기다리는 플랜을 읽는 창.
//
// 플랜 승인 카드가 뜨면 터미널에는 플랜이 옆 창에 잘려 보인다 — 그 창은 터미널 안의 그림이라 월드에서는 굴릴 수 없다.
// 플랜은 파일로 있으므로(server/plan.ts) 그 글을 받아 응답 글처럼 그려 보여 준다. 읽기만 하는 창이고, 답은 터미널에서 한다.
import type { AgentView } from "../shared/types.ts";
import { get } from "./api.ts";
import { h, icon, prose } from "./dom.ts";
import { t } from "./i18n.ts";

interface Plan {
  name: string;
  text: string;
  at: number;
}

export class PlanReader {
  private dlg: HTMLDialogElement | undefined;
  private body: HTMLElement | undefined;
  private file: HTMLElement | undefined;
  private agentId = "";
  /** 지금 보여 주는(또는 받아 오는 중인) 글이 고쳐진 시각. */
  private at = 0;
  /** 닫힌 뒤에 부른다 — 크게 보기가 열려 있으면 입력을 다시 그리로 돌린다. */
  onClose: (() => void) | undefined;

  get isOpen(): boolean {
    return this.dlg !== undefined;
  }

  open(a: AgentView): void {
    if (!a.plan) return;
    this.dlg?.close();
    this.agentId = a.id;
    const close = h("button", { class: "btn icon", type: "button", title: t("닫기"), "aria-label": t("닫기") }, icon("close"));
    const file = h("span", {});
    const body = h("div", { class: "prose plan-body", tabindex: "-1" }, h("p", { class: "plan-wait" }, t("플랜을 읽는 중…")));
    const dlg = h(
      "dialog",
      { class: "dlg plan-dlg" },
      h("header", {}, icon("file"), h("div", { class: "names" }, h("b", {}, t("플랜 — {title}", { title: a.title })), file), close),
      body,
      h("p", { class: "plan-note" }, t("읽기만 하는 창입니다. 승인하거나 고치려면 닫고 터미널에서 답하세요.")),
    );
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
    dlg.addEventListener("close", () => {
      dlg.remove();
      if (this.dlg !== dlg) return;
      this.dlg = this.body = this.file = undefined;
      this.onClose?.();
    });
    document.body.append(dlg);
    dlg.showModal();
    // 글에 초점을 둔다 — 화살표·PageDown·Space 로 바로 굴릴 수 있다.
    body.focus();
    this.load(a.plan);
  }

  /** 새 스냅샷에 맞춘다: 카드가 내려갔으면(승인·거절·세션 종료) 닫고, 에이전트가 플랜을 고쳤으면 다시 읽는다. */
  sync(agents: readonly AgentView[]): void {
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
        // 고쳐 쓴 플랜을 다시 받았으면 읽던 자리를 지킨다.
        const top = body.scrollTop;
        file.textContent = plan.name;
        body.replaceChildren(prose(plan.text));
        body.scrollTop = top;
      })
      .catch((e: Error) => {
        if (this.dlg !== dlg || this.at !== at) return;
        // 이미 읽고 있던 글이 있으면 그대로 둔다 — 다음 스냅샷에서 카드가 내려갔으면 창이 닫힌다.
        if (body.querySelector(".plan-wait")) body.replaceChildren(h("p", { class: "plan-wait" }, t("플랜을 읽지 못했습니다."), " ", e.message));
      });
  }
}
