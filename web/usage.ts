// 위 막대의 사용량 단추와, 누르면 뜨는 사용량 창.
//
// 단추에는 하네스마다 로고와 가장 빠듯한 창의 퍼센트만 둔다. 요금제·창별 사용량·남은 양·초기화 시각은 창에서 본다.
import type { UsageView, UsageWindow } from "../shared/types.ts";
import { brandFor, brandTile } from "./brands.ts";
import { h, icon } from "./dom.ts";
import { ago, duration } from "./format.ts";
import { lang, t } from "./i18n.ts";

/** 이만큼 썼으면 눈에 띄게: 빠듯함, 거의 다 씀. */
const WARN_PCT = 70;
const FULL_PCT = 90;

const level = (pct: number): "ok" | "warn" | "full" => (pct >= FULL_PCT ? "full" : pct >= WARN_PCT ? "warn" : "ok");

/** 가장 많이 쓴 창. 단추에는 이것 하나만 보인다. */
function tightest(view: UsageView): UsageWindow | undefined {
  return view.windows.reduce<UsageWindow | undefined>((top, w) => (!top || w.usedPct > top.usedPct ? w : top), undefined);
}

function spanLabel(minutes: number | undefined): string {
  if (!minutes) return t("한도");
  if (minutes % 1440 === 0) return t("{n}일", { n: minutes / 1440 });
  if (minutes % 60 === 0) return t("{n}시간", { n: minutes / 60 });
  return t("{n}분", { n: minutes });
}

function groupLabel(group: string): string {
  const g = group.toLowerCase();
  if (g === "gemini") return "Gemini";
  if (g === "3p") return t("외부 모델");
  return group;
}

const windowLabel = (w: UsageWindow): string => (w.group ? `${groupLabel(w.group)} · ${spanLabel(w.minutes)}` : spanLabel(w.minutes));

/** 요금제 이름은 하네스가 부르는 그대로. 소문자 한 낱말(Codex 의 free·plus)만 첫 글자를 세운다. */
const planLabel = (plan: string): string => (/^[a-z]+$/.test(plan) ? plan[0]!.toUpperCase() + plan.slice(1) : plan);

function resetText(w: UsageWindow, now: number): string {
  if (w.reset) return t("초기화됨");
  if (w.resetsAt === undefined || w.resetsAt <= now) return "";
  return t("{time} 뒤 초기화", { time: duration(now, w.resetsAt) });
}

function resetClock(at: number): string {
  return new Date(at).toLocaleString(lang === "en" ? "en-GB" : "ko-KR", { month: "short", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false });
}

export class UsageChip {
  private readonly btn = document.getElementById("btn-usage") as HTMLButtonElement;
  private views: UsageView[] = [];
  /** 단추에 그린 것. 같으면 다시 그리지 않는다. */
  private drawn = "";
  private dlg: HTMLDialogElement | undefined;
  private body: HTMLElement | undefined;

  constructor() {
    this.btn.addEventListener("click", () => this.open());
    // 창을 열어 둔 동안 "3시간 뒤" 같은 말이 흐르게 한다.
    setInterval(() => this.dlg && this.fill(), 30_000);
  }

  update(views: UsageView[]): void {
    const stamp = JSON.stringify(views);
    if (stamp === this.drawn) return;
    this.drawn = stamp;
    this.views = views;
    this.btn.hidden = views.length === 0;
    const most = Math.max(...views.map((v) => tightest(v)?.usedPct ?? 0));
    let marked = false;
    this.btn.replaceChildren(
      ...views.map((view) => {
        const top = tightest(view);
        const pct = top?.usedPct ?? 0;
        const seg = h("span", { class: "usage-seg" }, brandTile(view.vendor, 16), h("b", {}, `${pct}%`));
        seg.dataset.level = level(pct);
        if (view.asOf !== undefined) seg.dataset.stale = "";
        // 좁은 화면에는 가장 많이 쓴 하네스 하나만 남긴다.
        if (!marked && pct === most) {
          seg.dataset.top = "";
          marked = true;
        }
        return seg;
      }),
    );
    this.btn.title = [t("하네스별 요금제와 한도 사용량"), ...views.map((v) => this.line(v))].join("\n");
    if (this.dlg) {
      if (views.length === 0) this.dlg.close();
      else this.fill();
    }
  }

  /** 말풍선 한 줄: "Claude Code · Max — 7일 54%". */
  private line(view: UsageView): string {
    const name = [brandFor(view.vendor).name, view.plan && planLabel(view.plan)].filter(Boolean).join(" · ");
    return `${name} — ${view.windows.map((w) => `${windowLabel(w)} ${w.usedPct}%`).join(", ")}`;
  }

  private open(): void {
    if (this.dlg || this.views.length === 0) return;
    const close = h("button", { class: "btn icon", type: "button", title: t("닫기"), "aria-label": t("닫기") }, icon("close"));
    const body = h("div", { class: "usage-list" });
    const note = h("p", { class: "usage-note" }, t("각 하네스가 이 PC 에 남긴 값입니다. 다른 기기에서 쓴 만큼은 그 하네스를 여기서 다시 쓸 때 반영됩니다."));
    const dlg = h("dialog", { class: "dlg usage-dlg", tabindex: "-1" }, h("div", { class: "usage-head" }, h("h2", {}, t("사용량")), close), body, note);
    this.dlg = dlg;
    this.body = body;
    this.fill();
    close.addEventListener("click", () => dlg.close());
    // 창 밖(뒤 배경)을 누르면 닫는다. 배경을 누른 것도 대화상자가 받으므로 누른 자리로 가른다 — 창 안쪽 여백은 창이다.
    dlg.addEventListener("click", (e) => {
      if (e.target !== dlg) return;
      const box = dlg.getBoundingClientRect();
      if (e.clientX < box.left || e.clientX > box.right || e.clientY < box.top || e.clientY > box.bottom) dlg.close();
    });
    dlg.addEventListener("keydown", (e) => e.stopPropagation());
    dlg.addEventListener("close", () => {
      dlg.remove();
      this.dlg = this.body = undefined;
      this.btn.setAttribute("aria-expanded", "false");
    });
    // 넓은 화면에서는 단추 바로 아래에 붙인다. 좁은 화면에서는 다른 대화상자처럼 아래에서 올라온다.
    const anchor = this.btn.getBoundingClientRect();
    dlg.style.setProperty("--anchor-top", `${Math.round(anchor.bottom + 10)}px`);
    dlg.style.setProperty("--anchor-right", `${Math.max(12, Math.round(document.documentElement.clientWidth - anchor.right))}px`);
    document.body.append(dlg);
    dlg.showModal();
    // 읽기만 하는 창이다. 닫기 단추에 초점 테두리를 두르고 시작하지 않는다(Tab 을 누르면 그리로 간다).
    dlg.focus();
    this.btn.setAttribute("aria-expanded", "true");
  }

  private fill(): void {
    const now = Date.now();
    this.body?.replaceChildren(
      ...this.views.map((view) => {
        const head = h("div", { class: "usage-vendor" }, brandTile(view.vendor, 20), h("b", {}, brandFor(view.vendor).name));
        if (view.plan) head.append(h("span", { class: "usage-plan" }, planLabel(view.plan)));
        if (view.asOf !== undefined) head.append(h("span", { class: "usage-asof" }, t("{when} 기준", { when: ago(view.asOf, now) })));
        const rows = view.windows.map((w) => {
          const bar = h("i");
          bar.style.width = `${w.usedPct}%`;
          const meter = h("span", { class: "meter" }, bar);
          const row = h(
            "div",
            { class: "usage-row" },
            h("span", { class: "k" }, windowLabel(w)),
            meter,
            h("span", { class: "v" }, t("{n}% 사용", { n: w.usedPct })),
            h("span", { class: "sub" }, [t("{n}% 남음", { n: 100 - w.usedPct }), resetText(w, now)].filter(Boolean).join(" · ")),
          );
          row.dataset.level = level(w.usedPct);
          if (w.resetsAt !== undefined && w.resetsAt > now) row.title = t("{when} 에 초기화", { when: resetClock(w.resetsAt) });
          return row;
        });
        const card = h("section", { class: "usage-card" }, head, ...rows);
        if (view.asOf !== undefined) card.dataset.stale = "";
        return card;
      }),
    );
  }
}
