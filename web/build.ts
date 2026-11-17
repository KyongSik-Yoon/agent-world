// 만들고 정리하는 일: 집 짓기(스페이스·워크트리), 새 주민(에이전트 시작), 새 탭, 나누기, 이름 바꾸기, 닫기.
//
// 닫기는 herdr 의 API 가 TUI 처럼 되묻지 않으므로, 여기서 무엇이 함께 꺼지는지 보여 주고 확인을 받는다.
import type { AgentView, WorldSnapshot } from "../shared/types.ts";
import { ApiError, get, post } from "./api.ts";
import { brandFor } from "./brands.ts";
import { type TargetKind, workspaceKey } from "./detail.ts";
import { type Child, h } from "./dom.ts";
import { STATUS_LABEL } from "./format.ts";

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

const AGENT_NAME = /^[a-z][a-z0-9_-]{0,31}$/;
const READY_TIMEOUT_MS = 60_000;

function field(label: string, control: HTMLElement, hint?: string): HTMLElement {
  return h("label", { class: "field" }, h("span", {}, label), control, hint ? h("small", {}, hint) : null);
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
   * run 은 진행 상황을 step 으로 알릴 수 있다.
   */
  private dialog(title: string, submitLabel: string, fields: Child[], run: (step: (text: string) => void) => Promise<void>, danger = false): HTMLDialogElement {
    const dlg = h("dialog", { class: "dlg" });
    const error = h("p", { class: "dlg-error" });
    error.hidden = true;
    const progress = h("ol", { class: "dlg-steps" });
    const cancel = h("button", { class: "btn", type: "button" }, "취소");
    const submit = h("button", { class: danger ? "btn danger solid" : "btn primary", type: "submit" }, submitLabel);
    const form = h("form", { method: "dialog" }, h("h2", {}, title), ...fields, progress, error, h("div", { class: "dlg-actions" }, cancel, submit));
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
      progress.replaceChildren();
      let current: HTMLElement | undefined;
      const step = (text: string) => {
        current?.classList.add("ok");
        current = h("li", {}, text);
        progress.append(current);
      };
      run(step)
        .then(() => dlg.close())
        .catch((err: Error) => {
          current?.classList.add("fail");
          error.textContent = err.message;
          error.hidden = false;
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
  private agentFields(optional: boolean): { fields: HTMLElement[]; chosen(): boolean; start(paneId: string, step: (text: string) => void): Promise<string> } {
    const kind = h("select", {});
    if (optional) kind.append(h("option", { value: "" }, "없음 — 셸만 둡니다"));
    const name = h("input", { type: "text", autocomplete: "off", spellcheck: "false", pattern: "[a-z][a-z0-9_\\-]{0,31}" });
    const args = h("input", { type: "text", autocomplete: "off", spellcheck: "false", placeholder: "예: --model opus" });
    const prompt = h("textarea", { rows: "3", placeholder: "에이전트가 준비되면 바로 보낼 말 (비워 두면 보내지 않습니다)" });
    let touched = false;
    name.addEventListener("input", () => {
      touched = true;
    });
    const syncName = () => {
      if (!touched) name.value = kind.value ? this.freeName(kind.value) : "";
      for (const el of [name, args, prompt]) el.disabled = kind.value === "";
    };
    kind.addEventListener("change", syncName);
    void this.loadKinds().then((kinds) => {
      // 서버의 PATH 에서 못 찾은 것도 고를 수 있게 둔다 — 셸 설정으로만 잡히는 설치(alias, nvm)는 herdr 의
      // pane 안에서는 잘 뜬다. 숨기면 목록이 비어 아무것도 못 들이는 사람이 생긴다.
      for (const k of kinds) kind.append(h("option", { value: k.kind }, `${brandFor(k.kind).name} (${k.kind})${k.installed ? "" : " — PATH 에서 못 찾음"}`));
      const prefer = kinds.find((k) => k.installed && k.kind === "claude") ?? kinds.find((k) => k.installed);
      if (prefer) kind.value = prefer.kind;
      syncName();
    });
    syncName();

    return {
      fields: [
        field("주민 (에이전트)", kind),
        field("주민 이름", name, "herdr 에서 이 에이전트를 부르는 이름 — 영문 소문자로 시작, 소문자·숫자·-·_"),
        field("실행 인자", args, "선택 사항"),
        field("첫 지시", prompt),
      ],
      chosen: () => kind.value !== "",
      start: async (paneId, step) => {
        if (!AGENT_NAME.test(name.value)) throw new Error("주민 이름은 영문 소문자로 시작하고 소문자·숫자·-·_ 만 32자까지 쓸 수 있습니다.");
        step(`${brandFor(kind.value).name} 을(를) 띄우는 중…`);
        await post("/api/agent/start", { paneId, kind: kind.value, name: name.value, args: splitArgs(args.value) });
        step("에이전트가 준비되기를 기다리는 중…");
        const agent = await this.waitFor((s) => s.agents.find((a) => a.id === paneId && a.status !== "unknown"), READY_TIMEOUT_MS);
        if (!agent) throw new Error("에이전트가 제때 준비되지 않았습니다. 터미널 화면에서 무슨 일이 있는지 확인해 보세요.");
        const text = prompt.value.trim();
        if (!text) return paneId;
        if (agent.status === "blocked") {
          // 폴더 신뢰 확인처럼, 시작하면서 띄운 질문에 먼저 답해야 한다. 지시는 입력창에 남겨 둔다.
          this.deps.select(paneId);
          this.deps.draft(paneId, text);
          this.deps.toast("에이전트가 먼저 질문을 띄웠습니다", "답한 뒤, 입력창에 적어 둔 첫 지시를 보내 주세요.", "var(--blocked)");
          return paneId;
        }
        step("첫 지시를 보내는 중…");
        await post("/api/prompt", { paneId, text });
        return paneId;
      },
    };
  }

  // ── 집 짓기 ────────────────────────────────────────────────────────────────────────────────

  newHouse(): void {
    const dirs = h("datalist", { id: "dlg-dirs" });
    const cwd = h("input", { type: "text", list: "dlg-dirs", autocomplete: "off", spellcheck: "false", required: "", placeholder: "~/dev/…" });
    const label = h("input", { type: "text", autocomplete: "off", placeholder: "비워 두면 herdr 가 폴더 이름으로 붙입니다" });
    const worktree = h("input", { type: "checkbox" });
    const branch = h("input", { type: "text", autocomplete: "off", spellcheck: "false", placeholder: "비워 두면 herdr 가 이름을 짓습니다" });
    const base = h("input", { type: "text", autocomplete: "off", spellcheck: "false", placeholder: "비워 두면 지금 브랜치" });
    const trust = h("input", { type: "checkbox" });
    const wtBox = h(
      "div",
      { class: "sub-fields" },
      field("새 브랜치", branch),
      field("기준 (base)", base),
      h("label", { class: "check" }, trust, "이 저장소를 신뢰합니다 (herdr 가 요구할 때만 켜세요)"),
    );
    wtBox.hidden = true;
    worktree.addEventListener("change", () => {
      wtBox.hidden = !worktree.checked;
    });

    let seq = 0;
    const suggest = () => {
      const mine = (seq += 1);
      void get<{ dirs: string[] }>(`/api/dirs?prefix=${encodeURIComponent(cwd.value)}`)
        .then(({ dirs: list }) => {
          if (mine === seq) dirs.replaceChildren(...list.map((d) => h("option", { value: d })));
        })
        .catch(() => {});
    };
    cwd.addEventListener("input", suggest);
    suggest();

    const agent = this.agentFields(true);
    let made: Created | undefined;
    this.dialog(
      "집 짓기",
      "짓기",
      [
        field("폴더", cwd, "이 폴더에서 셸이 열립니다"),
        dirs,
        field("집 이름", label),
        h("label", { class: "check" }, worktree, "워크트리로 — 새 브랜치를 따로 체크아웃해서 엽니다"),
        wtBox,
        h("hr", {}),
        ...agent.fields,
      ],
      async (step) => {
        // 뒤 단계에서 실패해 다시 누르면, 이미 지은 집을 이어서 쓴다 — 집이 두 채 생기지 않게.
        if (made) step("이미 지은 스페이스를 이어서 씁니다");
        else {
          step(worktree.checked ? "워크트리를 만들고 스페이스를 여는 중…" : "스페이스를 여는 중…");
          made = worktree.checked
            ? await post<Created>("/api/worktree", { cwd: cwd.value, branch: branch.value, base: base.value, label: label.value, trust: trust.checked })
            : await post<Created>("/api/workspace", { cwd: cwd.value, label: label.value });
        }
        const workspaceId = made.workspaceId;
        if (!workspaceId) throw new Error("herdr 가 새 스페이스의 id 를 돌려주지 않았습니다.");
        const paneId = made.paneId ?? (await this.waitFor((s) => s.panes.find((p) => p.workspaceId === workspaceId)?.id, 8000));
        if (!paneId) throw new Error("새 스페이스의 pane 을 찾지 못했습니다.");
        if (agent.chosen()) await agent.start(paneId, step);
        await this.waitFor((s) => (s.workspaces.some((w) => w.id === workspaceId) ? true : undefined), 4000);
        this.deps.select(agent.chosen() ? paneId : workspaceKey(workspaceId));
        this.deps.toast("집을 지었습니다", label.value || cwd.value, "var(--done)");
      },
    );
    cwd.focus();
  }

  // ── 새 주민 ────────────────────────────────────────────────────────────────────────────────

  newAgent(workspaceId: string, paneId?: string): void {
    const snap = this.deps.snapshot();
    const ws = snap?.workspaces.find((w) => w.id === workspaceId);
    const where = h("select", {});
    if (paneId) where.append(h("option", { value: paneId }, `이 셸 (${paneId})`));
    else {
      where.append(h("option", { value: "" }, "새 탭을 열어서"));
      for (const p of snap?.panes.filter((x) => x.workspaceId === workspaceId && !x.agentId) ?? []) {
        where.append(h("option", { value: p.id }, `비어 있는 셸 ${p.id}${p.label ? ` · ${p.label}` : ""}`));
      }
    }
    const agent = this.agentFields(false);
    /** 실패 뒤 다시 눌렀을 때 탭을 또 열지 않도록, 이미 연 탭의 pane 을 기억한다. */
    let opened = "";
    this.dialog(`새 주민 — ${ws?.label ?? workspaceId}`, "들이기", [field("어디에", where), ...agent.fields], async (step) => {
      let target = where.value || opened;
      if (!target) {
        step("새 탭을 여는 중…");
        target = (await post<Created>("/api/tab", { workspaceId })).paneId ?? "";
        if (!target) throw new Error("herdr 가 새 탭의 pane id 를 돌려주지 않았습니다.");
        opened = target;
      }
      await agent.start(target, step);
      this.deps.select(target);
    });
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
      this.deps.toast("탭을 열지 못했습니다", (e as Error).message, "var(--blocked)");
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
      this.deps.toast("나누지 못했습니다", (e as Error).message, "var(--blocked)");
    }
  }

  // ── 이름 바꾸기 · 닫기 ─────────────────────────────────────────────────────────────────────

  rename(kind: TargetKind, id: string, current: string, what: string): void {
    const input = h("input", { type: "text", autocomplete: "off", value: current });
    this.dialog(`${what} 바꾸기`, "바꾸기", [field(what, input, kind === "pane" ? "비워 두면 이름을 지웁니다" : undefined)], async () => {
      await post("/api/rename", { kind, id, label: input.value });
    });
    input.select();
  }

  close(kind: "workspace" | "tab" | "pane", id: string): void {
    const snap = this.deps.snapshot();
    if (!snap) return;
    const doomed: AgentView[] = snap.agents.filter((a) => (kind === "workspace" ? a.workspaceId === id : kind === "tab" ? a.tabId === id : a.paneId === id));
    const ws = kind === "workspace" ? snap.workspaces.find((w) => w.id === id) : undefined;
    const name = kind === "workspace" ? (ws?.label ?? id) : kind === "tab" ? (snap.tabs.find((t) => t.id === id)?.label ?? id) : (snap.panes.find((p) => p.id === id)?.label ?? id);
    const what = kind === "workspace" ? "집(스페이스)" : kind === "tab" ? "탭" : "pane";

    const list = h("ul", { class: "doomed" });
    for (const a of doomed) list.append(h("li", { "data-status": a.status }, h("b", {}, a.title), ` — ${brandFor(a.vendor).name} · ${STATUS_LABEL[a.status]}`));
    const working = doomed.filter((a) => a.status === "working" || a.status === "blocked").length;
    const fields: Child[] = [
      h("p", {}, h("b", {}, name), ` ${what} 을(를) 닫습니다. 되돌릴 수 없습니다.`),
      doomed.length > 0 ? h("p", { class: working > 0 ? "warn" : "" }, `함께 꺼지는 에이전트 ${doomed.length}개${working > 0 ? ` — 그중 ${working}개는 아직 일하는 중입니다` : ""}:`) : h("p", {}, "이 안에 돌고 있는 에이전트는 없습니다."),
      doomed.length > 0 ? list : null,
    ];

    const removeWorktree = h("input", { type: "checkbox" });
    const force = h("input", { type: "checkbox" });
    const group = h("input", { type: "checkbox" });
    const groupRow = h("label", { class: "check" }, group, "이 저장소에 묶인 워크트리 스페이스들도 함께 닫기");
    groupRow.hidden = true;
    if (ws?.worktree?.linked) {
      const forceRow = h("label", { class: "check sub" }, force, "커밋하지 않은 변경이 있어도 지우기");
      forceRow.hidden = true;
      removeWorktree.addEventListener("change", () => {
        forceRow.hidden = !removeWorktree.checked;
        if (!removeWorktree.checked) force.checked = false;
      });
      fields.push(h("label", { class: "check" }, removeWorktree, "워크트리 체크아웃 폴더도 지우기"), forceRow);
    }
    fields.push(groupRow);

    const dlg = this.dialog(
      `${what} 닫기`,
      "닫기",
      fields,
      async () => {
        await post("/api/close", { kind, id, group: group.checked, removeWorktree: removeWorktree.checked, force: force.checked });
        this.deps.toast("닫았습니다", name, "var(--idle)");
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
