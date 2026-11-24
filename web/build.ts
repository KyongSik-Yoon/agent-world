// 만들고 정리하는 일: 집 짓기(스페이스·워크트리), 새 주민(에이전트 시작), 새 탭, 나누기, 이름 바꾸기, 닫기.
//
// 닫기는 herdr 의 API 가 TUI 처럼 되묻지 않으므로, 여기서 무엇이 함께 꺼지는지 보여 주고 확인을 받는다.
import type { AgentView, ModelCatalog, WorkspaceView, WorldSnapshot } from "../shared/types.ts";
import { ApiError, get, post } from "./api.ts";
import { brandFor } from "./brands.ts";
import { type TargetKind, workspaceKey } from "./detail.ts";
import { type Child, h } from "./dom.ts";
import { STATUS_LABEL } from "./format.ts";
import { t } from "./i18n.ts";

export interface BuildDeps {
  snapshot(): WorldSnapshot | undefined;
  select(id: string | null): void;
  toast(title: string, text: string, color: string): void;
  /** 그 pane 의 대화 입력창에 보낼 말을 미리 적어 둔다. */
  draft(paneId: string, text: string): void;
}

interface Created {
  workspaceId?: string;
  tabId?: string;
  paneId?: string;
}

interface KindInfo {
  kind: string;
  installed: boolean;
}

/** 모델·수준 칸 짝. 하네스를 정하면 그 하네스의 목록으로 채운다. */
interface ModelPick {
  el: HTMLElement;
  /** kind 의 목록으로 채운다. now 는 떠 있는 세션의 지금 값 — 그 값을 고른 채로 연다. */
  load(kind: string, now?: { model?: string; effort?: string }): Promise<ModelCatalog | null>;
  model(): string;
  effort(): string;
  /** 고른 값이 지금 값(now)과 같은지. */
  unchanged(): boolean;
  /** 모델을 지금 것과 다른 것으로 골랐는지. */
  modelChanged(): boolean;
  onChange(listener: () => void): void;
}

const AGENT_NAME = /^[a-z][a-z0-9_-]{0,31}$/;
const READY_TIMEOUT_MS = 60_000;

/** 대화상자의 진행 알림. 부르면 그 단계로 넘어간다. */
type Step = ((text: string) => void) & {
  /** 이번에 거칠 단계들을 차례대로 미리 알린다. */
  plan(texts: string[]): void;
};

let promptSeq = 0;

function field(label: string, control: HTMLElement, hint?: string): HTMLElement {
  return h("label", { class: "field" }, h("span", {}, label), control, hint ? h("small", {}, hint) : null);
}

/**
 * 폴더 칸과 그 제안 목록. <datalist> 는 브라우저가 제 글꼴·크기로 목록을 그려 CSS 가 닿지 않으므로, 고르기 칸의 펼친 목록과
 * 같은 모양으로 직접 그린다. 목록은 대화상자 안에 두되(모달 밖은 눌리지 않는다) popover 로 띄워 대화상자의 스크롤에 잘리지 않게 하고,
 * 위치는 칸에 맞춰 잡는다.
 */
function dirCombo(): { input: HTMLInputElement; box: HTMLElement; list: HTMLElement; attach(dlg: HTMLDialogElement): void } {
  const input = h("input", {
    type: "text",
    class: "combo-input",
    role: "combobox",
    "aria-autocomplete": "list",
    "aria-expanded": "false",
    "aria-controls": "dlg-dirs",
    autocomplete: "off",
    spellcheck: "false",
    required: "",
    placeholder: "~/dev/…",
  });
  const chevron = h("span", { class: "combo-chevron", "aria-hidden": "true" });
  const box = h("div", { class: "combo" }, input, chevron);
  const list = h("div", { class: "combo-list", id: "dlg-dirs", role: "listbox", popover: "manual" });
  let items: string[] = [];
  let active = -1;
  let seq = 0;

  const isOpen = () => list.matches(":popover-open");
  const mark = () => {
    list.querySelectorAll<HTMLElement>("[role=option]").forEach((el, i) => el.classList.toggle("active", i === active));
    const el = list.children[active] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
    if (el) input.setAttribute("aria-activedescendant", el.id);
    else input.removeAttribute("aria-activedescendant");
  };
  const place = () => {
    const r = input.getBoundingClientRect();
    const below = innerHeight - r.bottom - 12;
    const above = r.top - 12;
    const up = below < 140 && above > below;
    list.style.left = `${r.left}px`;
    list.style.width = `${r.width}px`;
    list.style.maxHeight = `${Math.min(320, up ? above : below)}px`;
    list.style.top = up ? "" : `${r.bottom + 4}px`;
    list.style.bottom = up ? `${innerHeight - r.top + 4}px` : "";
  };
  const close = () => {
    if (isOpen()) list.hidePopover();
    input.setAttribute("aria-expanded", "false");
    active = -1;
    mark();
  };
  const open = () => {
    if (items.length === 0 || document.activeElement !== input) return close();
    place();
    if (!isOpen()) list.showPopover();
    input.setAttribute("aria-expanded", "true");
  };
  const render = () => {
    list.replaceChildren(
      ...items.map((d, i) => {
        const el = h("div", { role: "option", id: `dlg-dir-${i}`, title: d }, d);
        if (d === input.value) el.setAttribute("aria-selected", "true");
        el.addEventListener("pointermove", () => {
          if (active !== i) {
            active = i;
            mark();
          }
        });
        el.addEventListener("click", () => choose(d));
        return el;
      }),
    );
    active = Math.min(active, items.length - 1);
    mark();
  };
  const suggest = (show: boolean) => {
    const mine = (seq += 1);
    void get<{ dirs: string[] }>(`/api/dirs?prefix=${encodeURIComponent(input.value)}`)
      .then(({ dirs }) => {
        if (mine !== seq) return;
        items = dirs;
        active = -1;
        render();
        if (show) open();
        else if (isOpen() && items.length === 0) close();
      })
      .catch(() => {});
  };
  const choose = (d: string) => {
    input.value = d;
    close();
    suggest(false);
  };

  input.addEventListener("input", () => suggest(true));
  input.addEventListener("click", open);
  input.addEventListener("blur", close);
  // 목록을 누르는 동안 칸이 초점을 잃어 목록이 먼저 닫히지 않게 한다.
  list.addEventListener("pointerdown", (e) => e.preventDefault());
  chevron.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    if (isOpen()) close();
    else {
      input.focus();
      open();
    }
  });
  // 칸을 감싼 <label> 이 꺾쇠 클릭을 입력 칸으로 넘겨 방금 닫은 목록을 다시 열지 않게 한다.
  chevron.addEventListener("click", (e) => e.preventDefault());
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!isOpen()) return open();
      const step = e.key === "ArrowDown" ? 1 : -1;
      active = (active + step + items.length + 1) % (items.length + 1);
      if (active === items.length) active = -1;
      mark();
    } else if (e.key === "Enter" && isOpen() && active >= 0) {
      e.preventDefault();
      choose(items[active]!);
    } else if (e.key === "Escape" && isOpen()) {
      // 목록만 닫고 대화상자는 그대로 둔다.
      e.preventDefault();
      close();
    }
  });
  suggest(false);

  return {
    input,
    box,
    list,
    attach(dlg) {
      const stop = new AbortController();
      const follow = () => {
        if (isOpen()) place();
      };
      addEventListener("resize", follow, { signal: stop.signal });
      dlg.addEventListener("scroll", follow, { signal: stop.signal, capture: true });
      visualViewport?.addEventListener("resize", follow, { signal: stop.signal });
      dlg.addEventListener("close", () => stop.abort(), { once: true });
    },
  };
}

/** 따옴표를 존중해 실행 인자를 나눈다: `--model opus -p "a b"` → [--model, opus, -p, a b]. */
function splitArgs(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) out.push(m[1] ?? m[2] ?? m[3] ?? "");
  return out;
}

export class Builder {
  private readonly waiters = new Set<(snapshot: WorldSnapshot) => void>();
  private kinds: KindInfo[] | undefined;
  private readonly catalogs = new Map<string, Promise<ModelCatalog | null>>();

  constructor(private readonly deps: BuildDeps) {}

  /** 새 스냅샷이 올 때마다 불러 준다 — 만든 것이 나타나기를 기다리는 일들이 여기에 걸려 있다. */
  observe(snapshot: WorldSnapshot): void {
    for (const waiter of [...this.waiters]) waiter(snapshot);
  }

  private waitFor<T>(find: (snapshot: WorldSnapshot) => T | undefined, timeoutMs: number): Promise<T | undefined> {
    const now = this.deps.snapshot();
    const hit = now ? find(now) : undefined;
    if (hit !== undefined) return Promise.resolve(hit);
    return new Promise((resolve) => {
      const waiter = (snapshot: WorldSnapshot) => {
        const found = find(snapshot);
        if (found === undefined) return;
        clearTimeout(timer);
        this.waiters.delete(waiter);
        resolve(found);
      };
      const timer = setTimeout(() => {
        this.waiters.delete(waiter);
        resolve(undefined);
      }, timeoutMs);
      this.waiters.add(waiter);
    });
  }

  private async loadKinds(): Promise<KindInfo[]> {
    this.kinds ??= (await get<{ kinds: KindInfo[] }>("/api/kinds").catch(() => ({ kinds: [] }))).kinds;
    return this.kinds;
  }

  private catalog(kind: string): Promise<ModelCatalog | null> {
    let got = this.catalogs.get(kind);
    if (!got) {
      got = get<ModelCatalog>(`/api/models?kind=${encodeURIComponent(kind)}`).catch(() => null);
      this.catalogs.set(kind, got);
      // 비었거나 못 받은 목록은 기억하지 않는다 — agy 의 목록은 네트워크를 거쳐 오고, 잠깐 실패할 수 있다.
      void got.then((c) => {
        if (!c || c.models.length === 0) this.catalogs.delete(kind);
      });
    }
    return got;
  }

  /**
   * 모델과 사고 수준을 고르는 두 칸. 띄울 때(start)는 비운 칸이 하네스의 기본값이고, 떠 있는 세션을 바꿀 때(switch)는
   * 지금 값을 고른 채로 연다. Claude 는 비운 칸을 그대로 두고, Codex 는 모델을 늘 함께 보내며 비운 수준은 그 모델의 기본값이다.
   */
  private modelPick(mode: "start" | "switch"): ModelPick {
    const model = h("select", {});
    const effort = h("select", {});
    const note = h("small", {}, mode === "start" ? t("이 세션에만 적용됩니다 — 하네스의 기본값은 그대로입니다.") : "");
    const el = h("div", { class: "field-pair" }, field(t("모델"), model), field(t("Effort"), effort), note);
    el.hidden = true;
    let catalog: ModelCatalog | null = null;
    let kind = "";
    let now: { model?: string; effort?: string } = {};
    let nowModel = "";
    let loading = 0;
    const listeners: Array<() => void> = [];
    const changed = () => listeners.forEach((f) => f());

    const fillEfforts = () => {
      const choice = catalog?.models.find((m) => m.id === model.value);
      const levels = choice ? choice.efforts : (catalog?.efforts ?? []);
      const keep = effort.value || (model.value === nowModel ? (now.effort ?? "") : "");
      const blank = mode === "start" ? t("기본값") : kind === "claude" ? t("지금 수준 그대로") : t("모델의 기본값");
      effort.replaceChildren(
        h("option", { value: "" }, blank),
        ...levels.map((l) => h("option", { value: l }, l === choice?.defaultEffort ? t("{level} (기본)", { level: l }) : l)),
      );
      effort.value = levels.includes(keep) ? keep : "";
      effort.disabled = levels.length === 0;
    };
    model.addEventListener("change", () => {
      fillEfforts();
      changed();
    });
    effort.addEventListener("change", changed);

    return {
      el,
      load: async (next, current) => {
        kind = next;
        now = current ?? {};
        const ticket = ++loading;
        catalog = null;
        el.hidden = !next;
        if (!next) return null;
        model.replaceChildren(h("option", { value: "" }, t("목록을 불러오는 중…")));
        effort.replaceChildren(h("option", { value: "" }, "—"));
        model.disabled = effort.disabled = true;
        const got = await this.catalog(next);
        if (ticket !== loading) return null;
        catalog = got;
        // 띄울 때는 고를 것이 없으면 칸을 감춘다 — 실행 인자 칸이 남아 있다.
        if (!got || got.models.length === 0) {
          el.hidden = mode === "start";
          model.replaceChildren(h("option", { value: "" }, t("모델 목록을 읽지 못했습니다")));
          changed();
          return got;
        }
        // 로그가 말하는 지금 모델을 목록에서 찾는다. Claude 는 별칭(opus)으로, 로그는 id(claude-opus-5-5)로 적는다.
        const lower = (now.model ?? "").toLowerCase();
        nowModel = got.models.find((m) => m.id.toLowerCase() === lower)?.id ?? (next === "claude" ? (got.models.find((m) => lower.includes(m.id))?.id ?? "") : "");
        const blank = mode === "start" ? t("기본값") : next === "claude" ? t("지금 모델 그대로") : null;
        model.replaceChildren(...(blank ? [h("option", { value: "" }, blank)] : []), ...got.models.map((m) => h("option", { value: m.id }, m.label)));
        model.value = nowModel || (blank ? "" : got.models[0]!.id);
        model.disabled = false;
        fillEfforts();
        changed();
        return got;
      },
      model: () => model.value,
      effort: () => effort.value,
      // 빈 칸이 "그대로"인 것은 Claude 뿐이다. Codex 의 빈 수준은 그 모델의 기본값으로 바꾸라는 뜻이다.
      unchanged: () => (model.value === nowModel || model.value === "") && (effort.value === (now.effort ?? "") || (effort.value === "" && kind === "claude")),
      modelChanged: () => model.value !== "" && model.value !== nowModel,
      onChange: (listener) => listeners.push(listener),
    };
  }

  private freeName(kind: string): string {
    const used = new Set((this.deps.snapshot()?.agents ?? []).map((a) => a.name).filter(Boolean));
    const base = kind.replace(/[^a-z0-9_-]/g, "") || "agent";
    for (let i = 1; ; i += 1) {
      const name = `${base}-${i}`;
      if (!used.has(name)) return name;
    }
  }

  // ── 대화상자 ───────────────────────────────────────────────────────────────────────────────

  /**
   * 폼 대화상자를 띄운다. run 이 끝나면 닫히고, 던지면 오류를 보여 준 채 열려 있다.
   * run 은 진행 상황을 step 으로 알린다. 거칠 단계를 step.plan 으로 먼저 알려 두면 남은 단계까지 칸으로 보인다.
   */
  private dialog(title: string, submitLabel: string, fields: Child[], run: (step: Step) => Promise<void>, danger = false, actionsIn?: HTMLElement): HTMLDialogElement {
    const dlg = h("dialog", { class: "dlg" });
    const error = h("p", { class: "dlg-error" });
    error.hidden = true;
    const track = h("div", { class: "dlg-track", "aria-hidden": "true" });
    const stepText = h("span", { class: "dlg-step-text" });
    const stepCount = h("span", { class: "dlg-step-count" });
    const progress = h("div", { class: "dlg-steps", role: "status" }, track, h("div", { class: "dlg-step" }, stepText, stepCount));
    progress.hidden = true;
    const cancel = h("button", { class: "btn", type: "button" }, t("취소"));
    const submit = h("button", { class: danger ? "btn danger solid" : "btn primary", type: "submit" }, submitLabel);
    // actionsIn 을 주면 단추를 그 상자(첫 지시 칸) 안에 둔다 — 글 칸과 단추가 한 덩어리여야 듣는 음성 입력 도구가 있다.
    // 상세 창의 입력줄처럼 상자의 바로 아래 자식으로 넣는다(감싸는 칸을 두지 않는다).
    const form = h("form", { method: "dialog" }, h("h2", {}, title), ...fields, progress, error, actionsIn ? null : h("div", { class: "dlg-actions" }, cancel, submit));
    actionsIn?.append(cancel, submit);
    dlg.append(form);
    cancel.addEventListener("click", () => dlg.close());
    dlg.addEventListener("close", () => dlg.remove());
    // 대화상자 안에서 친 글자가 월드의 단축키로 새지 않게 한다.
    dlg.addEventListener("keydown", (e) => e.stopPropagation());
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      if (submit.disabled) return;
      submit.disabled = true;
      error.hidden = true;
      // 칸 하나가 단계 하나다. 지나온 칸은 초록, 지금 칸은 장면 박자에 맞춰 깜빡이고, 남은 칸은 흐리다.
      let labels: string[] = [];
      let at = -1;
      let failed = false;
      const draw = () => {
        const shown = !progress.hidden;
        progress.hidden = at < 0;
        if (!shown && !progress.hidden) progress.scrollIntoView({ block: "nearest" });
        track.replaceChildren(...labels.map((_, i) => h("i", { class: i < at ? "ok" : i > at ? "" : failed ? "fail" : "cur" })));
        stepText.textContent = labels[at] ?? "";
        stepCount.textContent = labels.length > 1 ? `${at + 1} / ${labels.length}` : "";
      };
      const step: Step = Object.assign(
        (text: string) => {
          const next = labels.indexOf(text, at + 1);
          // 알려 두지 않은 단계는 지금 단계 바로 뒤에 끼운다.
          if (next < 0) labels.splice(++at, 0, text);
          else at = next;
          draw();
        },
        {
          plan: (texts: string[]) => {
            labels = texts;
          },
        },
      );
      draw();
      run(step)
        .then(() => dlg.close())
        .catch((err: Error) => {
          failed = true;
          draw();
          error.textContent = err.message;
          error.hidden = false;
          // 단추가 첫 지시 칸 안에 있으면 오류는 그 아래에 뜬다 — 낮은 화면에서 접힌 곳 밑에 숨지 않게 보이는 데까지 굴린다.
          error.scrollIntoView({ block: "nearest" });
          form.dispatchEvent(new CustomEvent("failed", { detail: err }));
        })
        .finally(() => {
          submit.disabled = false;
        });
    });
    document.body.append(dlg);
    dlg.showModal();
    return dlg;
  }

  /** 에이전트 고르기 칸들(종류·이름·인자·첫 지시)과, 그 값으로 에이전트를 띄우는 함수. */
  private agentFields(optional: boolean): { fields: HTMLElement[]; box: HTMLElement; chosen(): boolean; check(): void; steps(): string[]; start(paneId: string, step: Step): Promise<string> } {
    const kind = h("select", {});
    if (optional) kind.append(h("option", { value: "" }, t("없음 — 셸만 둡니다")));
    const name = h("input", { type: "text", autocomplete: "off", spellcheck: "false", pattern: "[a-z][a-z0-9_\\-]{0,31}" });
    const args = h("input", { type: "text", autocomplete: "off", spellcheck: "false", placeholder: t("예: --add-dir ~/notes") });
    const pick = this.modelPick("start");
    const promptId = `first-prompt-${++promptSeq}`;
    const prompt = h("textarea", { id: promptId, rows: "3", placeholder: t("에이전트가 준비되면 바로 보낼 말 (비워 두면 보내지 않습니다)") });
    let touched = false;
    name.addEventListener("input", () => {
      touched = true;
    });
    const syncName = () => {
      if (!touched) name.value = kind.value ? this.freeName(kind.value) : "";
      for (const el of [name, args, prompt]) el.disabled = kind.value === "";
      void pick.load(kind.value);
    };
    kind.addEventListener("change", syncName);
    void this.loadKinds().then((kinds) => {
      // 서버의 PATH 에서 하나도 못 찾았으면 전부 보여 준다 — 셸 설정으로만 잡히는 설치(alias, nvm)는 herdr 의
      // pane 안에서는 잘 뜨는데, 숨기면 목록이 비어 아무것도 못 들인다.
      const none = !kinds.some((k) => k.installed);
      for (const k of kinds.filter((x) => none || x.installed)) {
        const label = `${brandFor(k.kind).name} (${k.kind})`;
        kind.append(h("option", { value: k.kind }, k.installed ? label : t("{label} — PATH 에서 못 찾음", { label })));
      }
      const prefer = kinds.find((k) => k.installed && k.kind === "claude") ?? kinds.find((k) => k.installed);
      if (prefer) kind.value = prefer.kind;
      syncName();
    });
    syncName();
    const starting = () => t("{name} 띄우는 중…", { name: brandFor(kind.value).name });

    // 상세 창의 입력줄과 같은 짜임(.compose 안에 글 칸과 단추)이다. <label> 로 감싸지 않는다 — 단추의 글이 글 칸의 이름에 섞인다.
    const box = h("div", { class: "compose stack" }, prompt);
    return {
      box,
      fields: [
        field(t("주민 (에이전트)"), kind),
        pick.el,
        field(t("주민 이름"), name, t("herdr 에서 이 에이전트를 부르는 이름 — 영문 소문자로 시작, 소문자·숫자·-·_")),
        field(t("실행 인자"), args, t("선택 사항")),
        h("div", { class: "field" }, h("label", { for: promptId }, t("첫 지시")), box),
      ],
      chosen: () => kind.value !== "",
      steps: () => [starting(), t("에이전트가 준비되기를 기다리는 중…"), ...(prompt.value.trim() ? [t("첫 지시를 보내는 중…")] : [])],
      // 탭이나 스페이스를 열기 전에 부른다 — 이름이 틀렸는데 탭부터 열리지 않게.
      check: () => {
        if (!AGENT_NAME.test(name.value)) throw new Error(t("주민 이름은 영문 소문자로 시작하고 소문자·숫자·-·_ 만 32자까지 쓸 수 있습니다."));
      },
      start: async (paneId, step) => {
        step(starting());
        await post("/api/agent/start", { paneId, kind: kind.value, name: name.value, model: pick.model(), effort: pick.effort(), args: splitArgs(args.value) });
        step(t("에이전트가 준비되기를 기다리는 중…"));
        const agent = await this.waitFor((s) => s.agents.find((a) => a.id === paneId && a.status !== "unknown"), READY_TIMEOUT_MS);
        if (!agent) throw new Error(t("에이전트가 제때 준비되지 않았습니다. 터미널 화면에서 무슨 일이 있는지 확인해 보세요."));
        const text = prompt.value.trim();
        if (!text) return paneId;
        if (agent.status === "blocked") {
          // 폴더 신뢰 확인처럼, 시작하면서 띄운 질문에 먼저 답해야 한다. 지시는 입력창에 남겨 둔다.
          this.deps.select(paneId);
          this.deps.draft(paneId, text);
          this.deps.toast(t("에이전트가 먼저 질문을 띄웠습니다"), t("답한 뒤, 입력창에 적어 둔 첫 지시를 보내 주세요."), "var(--blocked)");
          return paneId;
        }
        step(t("첫 지시를 보내는 중…"));
        await post("/api/prompt", { paneId, text });
        return paneId;
      },
    };
  }

  // ── 집 짓기 ────────────────────────────────────────────────────────────────────────────────

  /** 집 짓기. from 을 주면 그 스페이스의 저장소에 워크트리 별채를 짓는다(폴더를 다시 고르지 않는다). */
  newHouse(from?: WorkspaceView): void {
    const dirs = dirCombo();
    const cwd = dirs.input;
    const label = h("input", { type: "text", autocomplete: "off", placeholder: t("비워 두면 herdr 가 폴더 이름으로 붙입니다") });
    const worktree = h("input", { type: "checkbox" });
    const branch = h("input", { type: "text", autocomplete: "off", spellcheck: "false", placeholder: t("비워 두면 herdr 가 이름을 짓습니다") });
    const base = h("input", { type: "text", autocomplete: "off", spellcheck: "false", placeholder: t("비워 두면 지금 브랜치") });
    const trust = h("input", { type: "checkbox" });
    const wtBox = h(
      "div",
      { class: "sub-fields" },
      field(t("새 브랜치"), branch),
      field(t("기준 (base)"), base),
      h("label", { class: "check" }, trust, t("이 저장소를 신뢰합니다 (herdr 가 요구할 때만 켜세요)")),
    );
    wtBox.hidden = !from;
    worktree.checked = Boolean(from);
    worktree.addEventListener("change", () => {
      wtBox.hidden = !worktree.checked;
    });

    const agent = this.agentFields(true);
    let made: Created | undefined;
    const where = from
      ? [field(t("집 이름"), label), wtBox]
      : [
          field(t("폴더"), dirs.box, t("이 폴더에서 셸이 열립니다")),
          dirs.list,
          field(t("집 이름"), label),
          h("label", { class: "check" }, worktree, t("워크트리로 — 새 브랜치를 따로 체크아웃해서 엽니다")),
          wtBox,
        ];
    const dlg = this.dialog(
      from ? t("워크트리 별채 — {repo}", { repo: from.repo ?? from.label }) : t("집 짓기"),
      t("짓기"),
      [
        ...where,
        h("hr", {}),
        ...agent.fields,
      ],
      async (step) => {
        if (agent.chosen()) agent.check();
        const opening = worktree.checked ? t("워크트리를 만들고 스페이스를 여는 중…") : t("스페이스를 여는 중…");
        step.plan([made ? t("이미 지은 스페이스를 이어서 씁니다") : opening, ...(agent.chosen() ? agent.steps() : [])]);
        // 뒤 단계에서 실패해 다시 누르면, 이미 지은 집을 이어서 쓴다 — 집이 두 채 생기지 않게.
        if (made) step(t("이미 지은 스페이스를 이어서 씁니다"));
        else {
          step(opening);
          made = from
            ? await post<Created>("/api/worktree", { workspaceId: from.id, branch: branch.value, base: base.value, label: label.value, trust: trust.checked })
            : worktree.checked
            ? await post<Created>("/api/worktree", { cwd: cwd.value, branch: branch.value, base: base.value, label: label.value, trust: trust.checked })
            : await post<Created>("/api/workspace", { cwd: cwd.value, label: label.value });
        }
        const workspaceId = made.workspaceId;
        if (!workspaceId) throw new Error(t("herdr 가 새 스페이스의 id 를 돌려주지 않았습니다."));
        const paneId = made.paneId ?? (await this.waitFor((s) => s.panes.find((p) => p.workspaceId === workspaceId)?.id, 8000));
        if (!paneId) throw new Error(t("새 스페이스의 pane 을 찾지 못했습니다."));
        if (agent.chosen()) await agent.start(paneId, step);
        await this.waitFor((s) => (s.workspaces.some((w) => w.id === workspaceId) ? true : undefined), 4000);
        this.deps.select(agent.chosen() ? paneId : workspaceKey(workspaceId));
        if (from) this.deps.toast(t("별채를 지었습니다"), label.value || branch.value || (from.repo ?? from.label), "var(--done)");
        else this.deps.toast(t("집을 지었습니다"), label.value || cwd.value, "var(--done)");
      },
      false,
      agent.box,
    );
    if (from) branch.focus();
    else {
      dirs.attach(dlg);
      cwd.focus();
    }
  }

  // ── 새 주민 ────────────────────────────────────────────────────────────────────────────────

  newAgent(workspaceId: string, paneId?: string): void {
    const snap = this.deps.snapshot();
    const ws = snap?.workspaces.find((w) => w.id === workspaceId);
    const where = h("select", {});
    if (paneId) where.append(h("option", { value: paneId }, t("이 셸 ({id})", { id: paneId })));
    else {
      where.append(h("option", { value: "" }, t("새 탭을 열어서")));
      for (const p of snap?.panes.filter((x) => x.workspaceId === workspaceId && !x.agentId) ?? []) {
        where.append(h("option", { value: p.id }, `${t("비어 있는 셸 {id}", { id: p.id })}${p.label ? ` · ${p.label}` : ""}`));
      }
    }
    const agent = this.agentFields(false);
    /** 실패 뒤 다시 눌렀을 때 탭을 또 열지 않도록, 이미 연 탭의 pane 을 기억한다. */
    let opened = "";
    this.dialog(t("새 주민 — {name}", { name: ws?.label ?? workspaceId }), t("들이기"), [field(t("어디에"), where), ...agent.fields], async (step) => {
      agent.check();
      let target = where.value || opened;
      step.plan([...(target ? [] : [t("새 탭을 여는 중…")]), ...agent.steps()]);
      if (!target) {
        step(t("새 탭을 여는 중…"));
        target = (await post<Created>("/api/tab", { workspaceId })).paneId ?? "";
        if (!target) throw new Error(t("herdr 가 새 탭의 pane id 를 돌려주지 않았습니다."));
        opened = target;
      }
      await agent.start(target, step);
      this.deps.select(target);
    }, false, agent.box);
  }

  async newTab(workspaceId: string): Promise<void> {
    try {
      const made = await post<Created>("/api/tab", { workspaceId });
      if (made.paneId) {
        const paneId = made.paneId;
        await this.waitFor((s) => (s.panes.some((p) => p.id === paneId) ? true : undefined), 4000);
        this.deps.select(paneId);
      }
    } catch (e) {
      this.deps.toast(t("탭을 열지 못했습니다"), (e as Error).message, "var(--blocked)");
    }
  }

  async split(paneId: string, direction: "right" | "down"): Promise<void> {
    try {
      const made = await post<Created>("/api/pane/split", { paneId, direction });
      if (made.paneId) {
        const created = made.paneId;
        await this.waitFor((s) => (s.panes.some((p) => p.id === created) ? true : undefined), 4000);
        this.deps.select(created);
      }
    } catch (e) {
      this.deps.toast(t("나누지 못했습니다"), (e as Error).message, "var(--blocked)");
    }
  }

  // ── 이름 바꾸기 · 닫기 ─────────────────────────────────────────────────────────────────────

  /** 떠 있는 세션의 모델·사고 수준을 그 세션에만 바꾼다. 다음에 들일 주민의 기본값은 그대로다. */
  switchModel(a: AgentView): void {
    const paneId = a.paneId;
    if (!paneId) return;
    const pick = this.modelPick("switch");
    const note = h("p", { class: "dlg-note" }, t("이 세션에만 적용됩니다. 다음에 들이는 주민의 기본값은 그대로입니다."));
    // 대화가 이어진 세션에서 모델을 바꾸면 그 대화의 캐시를 새 모델이 처음부터 다시 읽는다(Claude 는 확인창으로 묻는다 — 서버가 "예"를 고른다).
    const cache = h("p", { class: "warn" }, t("모델을 바꾸면 다음 응답은 지금까지의 대화를 처음부터 다시 읽어 느리고 토큰이 더 듭니다."));
    cache.hidden = true;
    const dlg = this.dialog(t("모델 바꾸기 — {name}", { name: a.title }), t("적용"), [pick.el, note, cache], async (step) => {
      if (pick.unchanged()) return;
      step(t("{name} 의 모델을 바꾸는 중…", { name: brandFor(a.vendor).name }));
      const { switched } = await post<{ switched: { model?: string; effort?: string } }>("/api/model", { paneId, model: pick.model(), effort: pick.effort() });
      this.deps.toast(t("모델을 바꿨습니다"), [switched.model, switched.effort].filter(Boolean).join(" · "), "var(--accent)");
    });
    const submit = dlg.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    pick.onChange(() => {
      cache.hidden = !(pick.modelChanged() && a.lastReply);
      submit.disabled = pick.unchanged();
    });
    submit.disabled = true;
    void pick.load(a.vendor, { model: a.model, effort: a.effort });
  }

  rename(kind: TargetKind, id: string, current: string, what: string): void {
    const input = h("input", { type: "text", autocomplete: "off", value: current });
    this.dialog(t("{what} 바꾸기", { what }), t("바꾸기"), [field(what, input, kind === "pane" ? t("비워 두면 이름을 지웁니다") : undefined)], async () => {
      await post("/api/rename", { kind, id, label: input.value });
    });
    input.select();
  }

  close(kind: "workspace" | "tab" | "pane", id: string): void {
    const snap = this.deps.snapshot();
    if (!snap) return;
    const doomed: AgentView[] = snap.agents.filter((a) => (kind === "workspace" ? a.workspaceId === id : kind === "tab" ? a.tabId === id : a.paneId === id));
    const ws = kind === "workspace" ? snap.workspaces.find((w) => w.id === id) : undefined;
    const name = kind === "workspace" ? (ws?.label ?? id) : kind === "tab" ? (snap.tabs.find((tab) => tab.id === id)?.label ?? id) : (snap.panes.find((p) => p.id === id)?.label ?? id);
    const what = kind === "workspace" ? t("집(스페이스)") : kind === "tab" ? t("탭") : t("pane");

    const list = h("ul", { class: "doomed" });
    for (const a of doomed) list.append(h("li", { "data-status": a.status }, h("b", {}, a.title), ` — ${brandFor(a.vendor).name} · ${STATUS_LABEL[a.status]}`));
    const working = doomed.filter((a) => a.status === "working" || a.status === "blocked").length;
    const fields: Child[] = [
      h("p", {}, h("b", {}, name), ` ${kind === "workspace" ? t("집(스페이스)을 닫습니다. 되돌릴 수 없습니다.") : kind === "tab" ? t("탭을 닫습니다. 되돌릴 수 없습니다.") : t("pane 을 닫습니다. 되돌릴 수 없습니다.")}`),
      doomed.length > 0 ? h("p", { class: working > 0 ? "warn" : "" }, working > 0 ? t("함께 꺼지는 에이전트 {n}개 — 그중 {w}개는 아직 일하는 중입니다:", { n: doomed.length, w: working }) : t("함께 꺼지는 에이전트 {n}개:", { n: doomed.length })) : h("p", {}, t("이 안에 돌고 있는 에이전트는 없습니다.")),
      doomed.length > 0 ? list : null,
    ];

    // 워크트리 묶음의 본채에 남은 마지막 pane·탭이면 herdr 가 본채를 닫지 않으므로, 서버가 그 자리에 빈 터미널을 남긴다.
    if (kind !== "workspace") {
      const home = snap.workspaces.find((w) => w.id === (kind === "tab" ? snap.tabs.find((tab) => tab.id === id)?.workspaceId : snap.panes.find((p) => p.id === id)?.workspaceId));
      const key = home?.worktree && !home.worktree.linked ? home.worktree.repoKey : undefined;
      const tied = key ? snap.workspaces.filter((w) => w.worktree?.linked && w.worktree.repoKey === key).length : 0;
      const last = home && (kind === "tab" ? snap.tabs.filter((tab) => tab.workspaceId === home.id).length : snap.panes.filter((p) => p.workspaceId === home.id).length) === 1;
      if (tied > 0 && last) {
        fields.push(h("p", {}, t("{name} 집은 워크트리 스페이스 {n}개가 묶인 본채라 비울 수 없습니다. 닫은 자리에 빈 터미널을 하나 남깁니다.", { name: home.label, n: tied })));
      }
    }

    const removeWorktree = h("input", { type: "checkbox" });
    const force = h("input", { type: "checkbox" });
    const group = h("input", { type: "checkbox" });
    const groupRow = h("label", { class: "check" }, group, t("이 저장소에 묶인 워크트리 스페이스들도 함께 닫기"));
    groupRow.hidden = true;
    if (ws?.worktree?.linked) {
      const forceRow = h("label", { class: "check sub" }, force, t("커밋하지 않은 변경이 있어도 지우기"));
      forceRow.hidden = true;
      removeWorktree.addEventListener("change", () => {
        forceRow.hidden = !removeWorktree.checked;
        if (!removeWorktree.checked) force.checked = false;
      });
      fields.push(h("label", { class: "check" }, removeWorktree, t("워크트리 체크아웃 폴더도 지우기")), forceRow);
    }
    fields.push(groupRow);

    const dlg = this.dialog(
      t("{what} 닫기", { what }),
      t("닫기"),
      fields,
      async () => {
        const res = await post<{ replaced?: boolean }>("/api/close", { kind, id, group: group.checked, removeWorktree: removeWorktree.checked, force: force.checked });
        this.deps.toast(t("닫았습니다"), res.replaced ? t("{name} — 묶음의 본채라 그 자리에 빈 터미널을 남겼습니다.", { name }) : name, "var(--idle)");
      },
      true,
    );
    // herdr 가 묶음 닫기를 요구하면 그때 선택지를 보여 준다 — 처음부터 권하지 않는다.
    dlg.querySelector("form")?.addEventListener("failed", (e) => {
      const err = (e as CustomEvent<Error>).detail;
      if (err instanceof ApiError && err.code === "workspace_group_close_required") groupRow.hidden = false;
    });
  }
}
