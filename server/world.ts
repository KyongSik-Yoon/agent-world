// herdr 의 pane 목록과 각 세션의 로그 요약을 합쳐 월드 스냅샷을 만든다.
//
// 누가 있고 어떤 상태인지는 herdr 가 정본이고, 무엇을 하고 있는지·모델·effort 는 로그에서 읽는다.
// herdr 에 없는 세션(다른 터미널, 데스크톱 앱)은 로그만으로 찾아 상태를 추정한다.
import { basename } from "node:path";

import type { Activity, AgentStatus, AgentView, PaneView, TabView, WorkspaceView, WorldSnapshot } from "../shared/types.ts";
import { agy } from "./adapters/agy.ts";
import { claude } from "./adapters/claude.ts";
import { codex } from "./adapters/codex.ts";
import type { Harness, LogFile } from "./adapters/types.ts";
import { herdrSnapshot, type HerdrPane, type HerdrSnapshot, type Kind } from "./herdr.ts";
import { SeenStore } from "./seen.ts";
import { currentPending, oneLine, type LogSummary } from "./summary.ts";
import { TailedLog } from "./tail.ts";

const HARNESSES: Harness[] = [claude, agy, codex];

const RESOLVE_RETRY_MS = 5_000;
const DISCOVER_EVERY_MS = 10_000;
/** herdr 밖 세션은 로그가 이 시간 안에 움직였을 때만 월드에 둔다. */
const EXTERNAL_KEEP_MS = 30 * 60_000;
/** 턴이 열린 채 로그가 이만큼 조용하면 더는 일하는 중으로 보지 않는다(긴 도구 실행을 감안한 값). */
const EXTERNAL_WORKING_MS = 10 * 60_000;
/** 턴이 닫힌 뒤 이만큼은 "방금 끝남"으로 보여 준다. */
const EXTERNAL_DONE_MS = 10 * 60_000;

/** pane 이 닫히면서 로그에 마지막 몇 줄이 더 적히는 것을 "다시 움직였다"로 보지 않기 위한 여유. */
const RETIRED_GRACE_MS = 15_000;

/** 스냅샷 사이가 이보다 벌어지면 "지켜보던 중"이 아니었다고 본다. */
const WATCH_GAP_MS = 5_000;

const STATUSES = new Set<AgentStatus>(["working", "blocked", "done", "idle", "unknown"]);

function harnessFor(agent: string): Harness | undefined {
  const key = agent.toLowerCase().trim();
  return HARNESSES.find((h) => h.matches(key));
}

/** 터미널 제목이 에이전트가 붙인 이름이 아니라 셸 프롬프트나 하네스 기본값인지. */
function isGenericTitle(title: string): boolean {
  return title === "" || /^[\w.-]+@[\w.-]+:/.test(title) || /^(claude code|codex|agy|antigravity|opencode)$/i.test(title);
}

/**
 * 지금 하고 있는 일 — 마지막 활동. 마지막이 사용자 지시면 이번 턴에는 아직 한 일이 없으므로 비워 둔다.
 * 지난 턴의 활동을 끌어오면 새 지시를 받고도 지난 응답을 말풍선에 단 채 일하러 간다.
 */
function currentActivity(recent: readonly Activity[]): Activity | undefined {
  const last = recent[recent.length - 1];
  return last?.kind === "user" ? undefined : last;
}

interface Tracked {
  harness: Harness;
  path: string;
  tail: TailedLog<LogSummary>;
}

export class World {
  private readonly tracked = new Map<string, Tracked>();
  private readonly unresolved = new Map<string, number>();
  private readonly since = new Map<string, { status: AgentStatus; at: number }>();
  private external: Array<LogFile & { harness: Harness }> = [];
  private discoveredAt = 0;
  private discovering = false;
  /** 직전 스냅샷을 다 만든 시각. */
  private builtAt = 0;
  /** 이번 스냅샷에서 읽은 로그들 — 끝나면 나머지는 놓아준다. */
  private used = new Set<string>();
  private readonly seen = new SeenStore();
  /** herdr pane 안에서 돌던 세션을 마지막으로 본 시각. pane 을 닫은 세션이 "herdr 밖 세션"으로 되살아나지 않게 한다. */
  private readonly lastInHerdr = new Map<string, number>();
  /** 완료 상태인 pane 의 herdr 상태 변경 번호 — 확인 기록을 남길 때 쓴다. */
  /** 완료 상태인 pane 과 그 상태 번호. 스냅샷을 만드는 도중에 확인 요청이 와도 답할 수 있게, 만들 때마다 비우지 않고 고쳐 쓴다. */
  private doneSeq = new Map<string, number>();

  /** outside: herdr 에 붙어 있는 동안에도 herdr 밖 세션을 보여 준다. */
  constructor(
    private readonly control: boolean,
    private readonly outside = false,
  ) {}

  private async track(harness: Harness, sessionId: string, knownPath?: string): Promise<Tracked | undefined> {
    const key = `${harness.vendor}:${sessionId}`;
    this.used.add(key);
    let entry = this.tracked.get(key);
    if (!entry) {
      const missedAt = this.unresolved.get(key);
      if (!knownPath && missedAt !== undefined && Date.now() - missedAt < RESOLVE_RETRY_MS) return undefined;
      const path = knownPath ?? (await harness.resolve(sessionId));
      if (!path) {
        this.unresolved.set(key, Date.now());
        return undefined;
      }
      this.unresolved.delete(key);
      entry = { harness, path, tail: new TailedLog(path, harness.reader) };
      this.tracked.set(key, entry);
    }
    try {
      await entry.tail.refresh();
    } catch {
      // 열 수 없는 로그(권한이 다르거나, 확인한 사이에 지워졌다) 하나가 스냅샷 전체를 깨뜨리지 않게 한다.
      // 그 에이전트는 로그 없이 herdr 가 알려 주는 것만으로 선다.
      return undefined;
    }
    return entry;
  }

  /**
   * 지금 상태가 언제 시작됐는지.
   *
   * 지켜보던 중에 바뀌었으면 지금이다. 처음 보는 에이전트면 로그가 마지막으로 움직인 때를 쓴다.
   * 한동안 스냅샷을 만들지 않다가(아무도 화면을 보고 있지 않았다) 바뀐 것을 발견했을 때는 지금이
   * 아니다 — 마지막으로 본 때와 지금 사이의 어느 시점이므로, 그 사이에 로그가 움직였으면 그때를,
   * 아니면 마지막으로 본 때를 쓴다. 그러지 않으면 몇 시간 전에 끝난 일이 "방금 완료"로 보인다.
   */
  private statusSince(id: string, status: AgentStatus, logUpdatedAt: number | undefined): number {
    const now = Date.now();
    const prev = this.since.get(id);
    if (prev && prev.status === status) return prev.at;
    let at = now;
    if (!prev) at = Math.min(logUpdatedAt ?? now, now);
    else if (now - this.builtAt > WATCH_GAP_MS) at = Math.max(Math.min(logUpdatedAt ?? now, now), this.builtAt);
    this.since.set(id, { status, at });
    return at;
  }

  private async fromLog(view: AgentView, harness: Harness, sessionId: string, knownPath?: string): Promise<LogSummary | undefined> {
    const entry = await this.track(harness, sessionId, knownPath);
    if (!entry) return undefined;
    const s = entry.tail.state;
    view.hasLog = true;
    view.model = s.model;
    view.effort = s.effort;
    view.permissionMode = s.permissionMode;
    view.harnessVersion = s.harnessVersion;
    view.branch = s.branch;
    view.contextTokens = s.contextTokens;
    view.contextWindow = s.contextWindow;
    view.recent = s.recent;
    view.activity = currentActivity(s.recent);
    view.lastPrompt = s.lastPrompt;
    view.lastReply = s.lastReply;
    view.pending = currentPending(s);
    view.logUpdatedAt = entry.tail.mtimeMs;
    if (harness.subagents) view.subagents = await harness.subagents(entry.path);
    return s;
  }

  private async paneView(pane: HerdrPane, snap: HerdrSnapshot): Promise<AgentView> {
    const ws = snap.workspaces.find((w) => w.workspace_id === pane.workspace_id);
    const tab = snap.tabs.find((t) => t.tab_id === pane.tab_id);
    const vendor = (pane.agent ?? "unknown").toLowerCase();
    let status: AgentStatus = STATUSES.has(pane.agent_status as AgentStatus) ? (pane.agent_status as AgentStatus) : "unknown";
    const view: AgentView = {
      id: pane.pane_id,
      vendor,
      paneId: pane.pane_id,
      workspaceId: pane.workspace_id,
      workspaceLabel: ws?.label ?? pane.workspace_id,
      workspaceNumber: ws?.number ?? 0,
      tabId: pane.tab_id,
      tabLabel: tab?.label,
      paneLabel: pane.label,
      name: pane.name,
      title: "",
      status,
      statusSource: "herdr",
      focused: pane.focused === true,
      cwd: pane.foreground_cwd || pane.cwd || "",
      hasLog: false,
      recent: [],
      statusSince: 0,
      subagents: 0,
    };

    const harness = harnessFor(vendor);
    view.readable = harness !== undefined;
    const session = pane.agent_session;
    let summary: LogSummary | undefined;
    let harnessTitle: string | undefined;
    if (harness && session?.kind === "id" && session.value) {
      view.sessionId = session.value;
      summary = await this.fromLog(view, harness, session.value);
      harnessTitle = await harness.title?.(session.value);
    }

    const terminalTitle = (pane.terminal_title_stripped ?? "").trim();
    view.title =
      (isGenericTitle(terminalTitle) ? "" : terminalTitle) ||
      summary?.title ||
      harnessTitle ||
      pane.label ||
      (view.lastPrompt ? oneLine(view.lastPrompt, 60) : "") ||
      ws?.tokens?.topic ||
      view.workspaceLabel;

    // 로그의 대기 요청은 확인 필요 카드에 보탤 내용일 뿐, 상태를 바꾸지는 않는다 — 상태는 herdr 가 정본이다.
    if (status !== "blocked") view.pending = undefined;
    const seq = pane.state_change_seq ?? 0;
    const seen = this.seen.check(pane.pane_id, seq);
    if (status !== "done") this.doneSeq.delete(pane.pane_id);
    else {
      this.doneSeq.set(pane.pane_id, seq);
      if (seen) {
        status = "idle";
        view.seen = true;
      }
    }
    view.status = status;
    view.statusSince = this.statusSince(view.id, status, view.logUpdatedAt);
    return view;
  }

  private async externalView(file: LogFile & { harness: Harness }): Promise<AgentView | undefined> {
    const view: AgentView = {
      id: `log:${file.harness.vendor}:${file.sessionId}`,
      vendor: file.harness.vendor,
      workspaceId: "",
      workspaceLabel: "",
      workspaceNumber: 0,
      title: "",
      status: "idle",
      statusSource: "log",
      focused: false,
      cwd: "",
      sessionId: file.sessionId,
      hasLog: false,
      recent: [],
      statusSince: 0,
      subagents: 0,
    };
    const summary = await this.fromLog(view, file.harness, file.sessionId, file.path);
    if (!summary || !summary.sawAssistant) return undefined;
    const quiet = Date.now() - (view.logUpdatedAt ?? 0);
    if (quiet > EXTERNAL_KEEP_MS) return undefined;
    if (summary.turnOpen && quiet < EXTERNAL_WORKING_MS) view.status = "working";
    else if (!summary.turnOpen && quiet < EXTERNAL_DONE_MS) view.status = "done";
    else view.status = "idle";

    view.cwd = summary.cwd ?? "";
    const place = view.cwd ? basename(view.cwd) : file.harness.vendor;
    view.workspaceId = `ext:${view.cwd || file.harness.vendor}`;
    view.workspaceLabel = place;
    view.title = summary.title || (await file.harness.title?.(file.sessionId)) || (view.lastPrompt ? oneLine(view.lastPrompt, 60) : place);
    view.statusSince = this.statusSince(view.id, view.status, view.logUpdatedAt);
    return view;
  }

  private discover(): void {
    if (this.discovering || Date.now() - this.discoveredAt < DISCOVER_EVERY_MS) return;
    this.discovering = true;
    const sinceMs = Date.now() - EXTERNAL_KEEP_MS;
    void Promise.all(
      HARNESSES.map(async (harness) => ((await harness.discover?.(sinceMs)) ?? []).map((f) => ({ ...f, harness }))),
    )
      .then((lists) => {
        this.external = lists.flat();
      })
      .catch(() => {})
      .finally(() => {
        this.discoveredAt = Date.now();
        this.discovering = false;
      });
  }

  private running: Promise<WorldSnapshot> | undefined;

  /** 스냅샷을 만든다. 만드는 중에 또 부르면 같은 결과를 함께 기다린다. */
  snapshot(): Promise<WorldSnapshot> {
    this.running ??= this.build().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async build(): Promise<WorldSnapshot> {
    this.used = new Set();
    await this.seen.load();
    let snap: HerdrSnapshot | undefined;
    let herdrError: string | undefined;
    try {
      snap = await herdrSnapshot();
    } catch (e) {
      herdrError = (e as Error).message;
    }

    const agents: AgentView[] = [];
    const workspaces = new Map<string, WorkspaceView>();
    const inHerdr = new Set<string>();

    const tabs: TabView[] = [];
    const panes: PaneView[] = [];

    if (snap) {
      // 주민이 없는 집도 집이다 — herdr 의 스페이스는 전부 세운다.
      for (const ws of snap.workspaces) {
        workspaces.set(ws.workspace_id, {
          id: ws.workspace_id,
          label: ws.label,
          number: ws.number,
          topic: ws.tokens?.topic,
          repo: ws.worktree?.repo_name,
          focused: ws.focused === true,
          managed: true,
          worktree: ws.worktree ? { path: ws.worktree.checkout_path, linked: ws.worktree.is_linked_worktree === true } : undefined,
        });
      }
      for (const tab of snap.tabs) tabs.push({ id: tab.tab_id, workspaceId: tab.workspace_id, label: tab.label ?? "", number: tab.number ?? 0 });

      const views = await Promise.all(snap.agents.filter((p) => p.agent).map((p) => this.paneView(p, snap)));
      for (const view of views) {
        agents.push(view);
        if (view.sessionId) inHerdr.add(`${harnessFor(view.vendor)?.vendor ?? view.vendor}:${view.sessionId}`);
      }

      const sizes = new Map<string, { width: number; height: number }>();
      for (const layout of snap.layouts ?? []) for (const p of layout.panes) sizes.set(p.pane_id, p.rect);
      const hosts = new Set(views.map((v) => v.id));
      for (const pane of snap.panes) {
        const size = sizes.get(pane.pane_id);
        panes.push({
          id: pane.pane_id,
          workspaceId: pane.workspace_id,
          tabId: pane.tab_id,
          label: pane.label,
          title: (pane.terminal_title_stripped ?? "").trim(),
          cwd: pane.foreground_cwd || pane.cwd || "",
          agentId: hosts.has(pane.pane_id) ? pane.pane_id : undefined,
          cols: size?.width,
          rows: size?.height,
        });
      }
      const alive = new Set(snap.panes.map((p) => p.pane_id));
      this.seen.prune(alive);
      for (const id of this.doneSeq.keys()) if (!alive.has(id)) this.doneSeq.delete(id);
    }

    // herdr 에 붙어 있으면 herdr 의 에이전트만 보여 준다 — 밖의 세션은 월드에서 말을 걸 수도, 확인 처리할 수도
    // 없어 자리와 알림만 차지한다. herdr 가 꺼져 있을 때는 로그로 찾은 세션이 전부이므로 그대로 보여 준다.
    if (!snap || this.outside) this.discover();
    else this.external = [];
    const now = Date.now();
    for (const key of inHerdr) this.lastInHerdr.set(key, now);
    for (const [key, at] of this.lastInHerdr) if (now - at > EXTERNAL_KEEP_MS) this.lastInHerdr.delete(key);
    const outside = this.external.filter((f) => {
      const key = `${f.harness.vendor}:${f.sessionId}`;
      if (inHerdr.has(key)) return false;
      // herdr 에서 pane 이 닫힌 뒤로 로그가 움직이지 않았으면 끝난 세션이다. 다른 곳에서 이어 받아
      // 로그가 다시 움직일 때만 herdr 밖 세션으로 보여 준다.
      const left = this.lastInHerdr.get(key);
      return left === undefined || f.mtimeMs > left + RETIRED_GRACE_MS;
    });
    const extViews = await Promise.all(outside.map((f) => this.externalView(f)));
    for (const view of extViews) {
      if (!view) continue;
      agents.push(view);
      if (!workspaces.has(view.workspaceId)) {
        workspaces.set(view.workspaceId, { id: view.workspaceId, label: view.workspaceLabel, number: 0, focused: false, managed: false });
      }
    }

    // 사라진 에이전트의 상태 기록과, 더는 읽지 않는 로그를 치운다.
    const alive = new Set(agents.map((a) => a.id));
    for (const id of this.since.keys()) if (!alive.has(id)) this.since.delete(id);
    for (const key of this.tracked.keys()) if (!this.used.has(key)) this.tracked.delete(key);

    this.builtAt = Date.now();
    return {
      at: this.builtAt,
      herdr: snap !== undefined,
      herdrError,
      control: this.control,
      workspaces: [...workspaces.values()].sort((a, b) => (a.number || 1e9) - (b.number || 1e9) || a.label.localeCompare(b.label)),
      tabs,
      panes,
      agents,
    };
  }

  /** 완료를 확인했다고 적는다(undo 면 지운다). 지금 완료 상태가 아닌 pane 이면 false. */
  markSeen(paneId: string, undo: boolean): boolean {
    if (undo) {
      this.seen.set(paneId, null);
      return true;
    }
    const seq = this.doneSeq.get(paneId);
    if (seq === undefined) return false;
    this.seen.set(paneId, seq);
    return true;
  }

  /**
   * 지금 herdr 에 있는 대상인지 — 조작 요청은 실제로 있는 것에만 보낸다.
   * herdr 에 묻지 못했으면 HerdrError 를 던진다. "없다"로 답하면 화면이 멀쩡한 pane 을 닫힌 것으로 안다.
   */
  async has(kind: Kind, id: string): Promise<boolean> {
    if (!id) return false;
    const snap = await herdrSnapshot();
    if (kind === "workspace") return snap.workspaces.some((w) => w.workspace_id === id);
    if (kind === "tab") return snap.tabs.some((t) => t.tab_id === id);
    if (kind === "agent") return snap.agents.some((p) => p.pane_id === id && p.agent);
    return snap.panes.some((p) => p.pane_id === id);
  }

  hasPane(paneId: string): Promise<boolean> {
    return this.has("pane", paneId);
  }
}
