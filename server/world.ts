// herdr 의 pane 목록과 각 세션의 로그 요약을 합쳐 월드 스냅샷을 만든다.
//
// 누가 있고 어떤 상태인지는 herdr 가 정본이고, 무엇을 하고 있는지·모델·effort 는 로그에서 읽는다.
// herdr 에 없는 세션(다른 터미널, 데스크톱 앱)은 로그만으로 찾아 상태를 추정한다.
import { basename } from "node:path";

import type { Activity, AgentStatus, AgentView, WorkspaceView, WorldSnapshot } from "../shared/types.ts";
import { agy } from "./adapters/agy.ts";
import { claude } from "./adapters/claude.ts";
import { codex } from "./adapters/codex.ts";
import type { Harness, LogFile } from "./adapters/types.ts";
import { herdrSnapshot, type HerdrPane, type HerdrSnapshot } from "./herdr.ts";
import { oneLine, type LogSummary } from "./summary.ts";
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

const STATUSES = new Set<AgentStatus>(["working", "blocked", "done", "idle", "unknown"]);

function harnessFor(agent: string): Harness | undefined {
  const key = agent.toLowerCase().trim();
  return HARNESSES.find((h) => h.matches(key));
}

/** 터미널 제목이 에이전트가 붙인 이름이 아니라 셸 프롬프트나 하네스 기본값인지. */
function isGenericTitle(title: string): boolean {
  return title === "" || /^[\w.-]+@[\w.-]+:/.test(title) || /^(claude code|codex|agy|antigravity|opencode)$/i.test(title);
}

function currentActivity(recent: readonly Activity[]): Activity | undefined {
  for (let i = recent.length - 1; i >= 0; i -= 1) {
    if (recent[i]!.kind !== "user") return recent[i];
  }
  return recent[recent.length - 1];
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
  /** 이번 스냅샷에서 읽은 로그들 — 끝나면 나머지는 놓아준다. */
  private used = new Set<string>();

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
    await entry.tail.refresh();
    return entry;
  }

  private statusSince(id: string, status: AgentStatus, firstSeenAt: number): number {
    const prev = this.since.get(id);
    if (prev && prev.status === status) return prev.at;
    // 처음 보는 에이전트면 로그가 마지막으로 움직인 때를, 지켜보던 중에 바뀌었으면 지금을 쓴다.
    const at = prev ? Date.now() : firstSeenAt;
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
    view.logUpdatedAt = entry.tail.mtimeMs;
    if (harness.subagents) view.subagents = await harness.subagents(entry.path);
    return s;
  }

  private async paneView(pane: HerdrPane, snap: HerdrSnapshot): Promise<AgentView> {
    const ws = snap.workspaces.find((w) => w.workspace_id === pane.workspace_id);
    const tab = snap.tabs.find((t) => t.tab_id === pane.tab_id);
    const vendor = (pane.agent ?? "unknown").toLowerCase();
    const status = STATUSES.has(pane.agent_status as AgentStatus) ? (pane.agent_status as AgentStatus) : "unknown";
    const view: AgentView = {
      id: pane.pane_id,
      vendor,
      paneId: pane.pane_id,
      workspaceId: pane.workspace_id,
      workspaceLabel: ws?.label ?? pane.workspace_id,
      workspaceNumber: ws?.number ?? 0,
      tabLabel: tab?.label,
      paneLabel: pane.label,
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
    view.statusSince = this.statusSince(view.id, status, view.logUpdatedAt ?? Date.now());
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
    view.statusSince = this.statusSince(view.id, view.status, view.logUpdatedAt ?? Date.now());
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

    if (snap) {
      const views = await Promise.all(snap.agents.filter((p) => p.agent).map((p) => this.paneView(p, snap)));
      for (const view of views) {
        agents.push(view);
        if (view.sessionId) inHerdr.add(`${harnessFor(view.vendor)?.vendor ?? view.vendor}:${view.sessionId}`);
        const ws = snap.workspaces.find((w) => w.workspace_id === view.workspaceId);
        if (!workspaces.has(view.workspaceId)) {
          workspaces.set(view.workspaceId, {
            id: view.workspaceId,
            label: view.workspaceLabel,
            number: view.workspaceNumber,
            topic: ws?.tokens?.topic,
            repo: ws?.worktree?.repo_name,
            focused: ws?.focused === true,
          });
        }
      }
    }

    this.discover();
    const outside = this.external.filter((f) => !inHerdr.has(`${f.harness.vendor}:${f.sessionId}`));
    const extViews = await Promise.all(outside.map((f) => this.externalView(f)));
    for (const view of extViews) {
      if (!view) continue;
      agents.push(view);
      if (!workspaces.has(view.workspaceId)) {
        workspaces.set(view.workspaceId, { id: view.workspaceId, label: view.workspaceLabel, number: 0, focused: false });
      }
    }

    // 사라진 에이전트의 상태 기록과, 더는 읽지 않는 로그를 치운다.
    const alive = new Set(agents.map((a) => a.id));
    for (const id of this.since.keys()) if (!alive.has(id)) this.since.delete(id);
    for (const key of this.tracked.keys()) if (!this.used.has(key)) this.tracked.delete(key);

    return {
      at: Date.now(),
      herdr: snap !== undefined,
      herdrError,
      workspaces: [...workspaces.values()].sort((a, b) => (a.number || 1e9) - (b.number || 1e9) || a.label.localeCompare(b.label)),
      agents,
    };
  }

  /** 지금 herdr 에 있는 pane 인지 — 포커스·화면 읽기 요청을 받을 때 확인한다. */
  async hasPane(paneId: string): Promise<boolean> {
    try {
      return (await herdrSnapshot()).panes.some((p) => p.pane_id === paneId);
    } catch {
      return false;
    }
  }
}
