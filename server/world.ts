// herdr 의 pane 목록과 각 세션의 로그 요약을 합쳐 월드 스냅샷을 만든다.
//
// 누가 있고 어떤 상태인지는 herdr 가 정본이고, 무엇을 하고 있는지·모델·effort 는 로그에서 읽는다.
// herdr 에 없는 세션(다른 터미널, 데스크톱 앱)은 로그만으로 찾아 상태를 추정한다.
import { basename } from "node:path";

import type { Activity, AgentStatus, AgentView, PaneView, ReviewReport, TabView, WorkspaceView, WorldSnapshot } from "../shared/types.ts";
import { agy } from "./adapters/agy.ts";
import { claude } from "./adapters/claude.ts";
import { codex } from "./adapters/codex.ts";
import type { Harness, LogFile } from "./adapters/types.ts";
import { AskingPanes, type Card } from "./asking.ts";
import { herdrSnapshot, type HerdrPane, type HerdrSnapshot, type Kind, herdrSessionName, HerdrError } from "./herdr.ts";
import { asText, type Text } from "./text.ts";
import { planMtime, planPathIn, readPlan, type PlanText } from "./plan.ts";
import { findReview, readReview } from "./review.ts";
import { NameStore, SeenStore } from "./seen.ts";
import { activityText, currentPending, oneLine, refOf, type LogSummary } from "./summary.ts";
import { TailedLog } from "./tail.ts";
import { UsageWatch } from "./usage.ts";

const HARNESSES: Harness[] = [claude, agy, codex];

const RESOLVE_RETRY_MS = 5_000;
const DISCOVER_EVERY_MS = 10_000;
/** herdr 밖 세션은 로그가 이 시간 안에 움직였을 때만 월드에 둔다. */
const EXTERNAL_KEEP_MS = 30 * 60_000;
/** 턴이 열린 채 로그가 이만큼 조용하면 더는 일하는 중으로 보지 않는다(긴 도구 실행을 감안한 값). */
const EXTERNAL_WORKING_MS = 10 * 60_000;
/** 턴이 닫힌 뒤 이만큼은 "방금 끝남"으로 보여 준다. */
const EXTERNAL_DONE_MS = 10 * 60_000;

/**
 * 월드가 첫 지시를 보낸 Claude 가 첫 응답을 로그에 적을 때까지 쉬는 것으로 보지 않는 최대 시간(firstPrompt 참고).
 * 모든 코어를 바쁘게 한 시험에서 턴이 시작하기까지 23초 걸렸다.
 */
const FIRST_PROMPT_HOLD_MS = 45_000;

/** pane 이 닫히면서 로그에 마지막 몇 줄이 더 적히는 것을 "다시 움직였다"로 보지 않기 위한 여유. */
const RETIRED_GRACE_MS = 15_000;

/**
 * herdr 가 알려 준 세션을 하네스가 아직 모를 때(서브에이전트인지 가릴 행이 아직 없을 때) pane 이 읽던 대화를 붙드는 최대 시간.
 * 이보다 오래 모르면 새 대화로 받아들인다.
 */
const UNKNOWN_SESSION_HOLD_MS = 10_000;

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
 * 로그가 턴이 끝났다고 하는데도 비워 둔다: herdr 는 지시를 받자마자 working 이 되지만 그 지시가 로그에
 * 적혀 읽히기까지는 틈이 있고, 그 사이 마지막 활동은 지난 턴의 응답이다. 지난 턴의 활동을 끌어오면
 * 새 지시를 받고도 지난 응답을 말풍선에 단 채 일하러 간다.
 */
function currentActivity(s: LogSummary): Activity | undefined {
  const last = s.recent[s.recent.length - 1];
  return !s.turnOpen || last?.kind === "user" ? undefined : last;
}

interface Tracked {
  harness: Harness;
  path: string;
  tail: TailedLog<LogSummary>;
  /** 꼬리 창 앞의 리뷰 보고를 찾아본 로드(TailedLog.loads). 로그를 새로 읽을 때마다 한 번만 찾는다. */
  reviewScan?: number;
}

export class World {
  private readonly tracked = new Map<string, Tracked>();
  /** 에이전트 id → 그 에이전트의 로그(tracked 의 키). 활동의 원문을 찾을 때 쓴다. */
  private readonly logOf = new Map<string, string>();
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
  /** 월드에서 지어 준 pane 이름. label 이 그대로인 동안 주민의 제목이 된다. */
  private readonly names = new NameStore();
  /** herdr 는 working 이라 하지만 카드를 띄워 답을 기다리는 pane 들. */
  private readonly asking = new AskingPanes();
  /** 플랜 승인 카드가 떠 있는 pane 의 플랜 파일. 카드(세션·뜬 시각)마다 한 번 로그에서 찾고, 못 찾은 것도 적어 다시 찾지 않는다. */
  private readonly plans = new Map<string, { card: string; path: string | undefined }>();
  /** herdr pane 안에서 돌던 세션을 마지막으로 본 시각. pane 을 닫은 세션이 "herdr 밖 세션"으로 되살아나지 않게 한다. */
  private readonly lastInHerdr = new Map<string, number>();
  /** 완료 상태인 pane 의 herdr 상태 변경 번호 — 확인 기록을 남길 때 쓴다. */
  /** 완료 상태인 pane 과 그 상태 번호. 스냅샷을 만드는 도중에 확인 요청이 와도 답할 수 있게, 만들 때마다 비우지 않고 고쳐 쓴다. */
  private doneSeq = new Map<string, number>();
  /** 마지막으로 쉬고 있을 때 확인하지 않은 완료가 있었는지(pane → 여부). 일하는 동안에는 그대로 둔다. */
  private unread = new Map<string, boolean>();
  /** 월드가 첫 지시를 보낸 pane 과 보낸 시각. 첫 응답이 로그에 적히면 지운다. */
  private readonly firstPrompt = new Map<string, number>();
  /**
   * 월드에서 그 세션에만 바꾼 모델·수준. 로그는 다음 응답이 와야 새 모델을 적으므로, 로그가 바꾸기 전의 값(base)을 말하는
   * 동안은 바꾼 값을 보인다. 로그가 무엇이든 다른 값을 말하기 시작하면 로그를 믿는다.
   */
  private readonly switched = new Map<string, { model?: string; effort?: string; base?: { model?: string; effort?: string; session?: string } }>();
  /** pane → 그 pane 에서 읽고 있는 맨 위 세션, 그리고 하네스가 모르는 세션을 받기 시작한 시각. */
  private readonly mainOf = new Map<string, { id: string; unknownSince?: number }>();
  private readonly usage = new UsageWatch();

  /** outside: herdr 에 붙어 있는 동안에도 herdr 밖 세션을 보여 준다. */
  constructor(
    private readonly control: boolean,
    private readonly outside = false,
  ) {}

  /** eager: 못 찾은 로그를 기다리지 않고 지금 다시 찾는다 — 새 세션의 로그는 첫 지시가 적힐 때 생긴다. */
  private async track(harness: Harness, sessionId: string, knownPath?: string, eager = false): Promise<Tracked | undefined> {
    const key = `${harness.vendor}:${sessionId}`;
    this.used.add(key);
    let entry = this.tracked.get(key);
    if (!entry) {
      const missedAt = this.unresolved.get(key);
      if (!knownPath && !eager && missedAt !== undefined && Date.now() - missedAt < RESOLVE_RETRY_MS) return undefined;
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
      // 다시 띄운 서버의 꼬리 창은 마지막 지시까지만 읽는다 — 그 앞에 남은 리뷰 보고를 한 번 찾아 이어 붙인다.
      const tail = entry.tail;
      if (harness.vendor === "claude" && entry.reviewScan !== tail.loads) {
        entry.reviewScan = tail.loads;
        if (!tail.state.review && tail.start > 0) {
          const found = await findReview(entry.path, tail.start, harness.reader);
          // 찾는 사이에 꼬리 창에 새 보고가 들어왔으면 그것이 더 새것이다.
          if (found && !tail.state.review) tail.state.review = found;
        }
      }
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

  private async fromLog(view: AgentView, harness: Harness, sessionId: string, knownPath?: string, eager = false): Promise<LogSummary | undefined> {
    const entry = await this.track(harness, sessionId, knownPath, eager);
    if (!entry) return undefined;
    this.logOf.set(view.id, `${harness.vendor}:${sessionId}`);
    const s = entry.tail.state;
    view.hasLog = true;
    view.model = s.model;
    view.effort = s.effort;
    view.permissionMode = s.permissionMode;
    view.harnessVersion = s.harnessVersion;
    view.branch = s.branch;
    view.contextTokens = s.contextTokens;
    view.contextWindow = s.contextWindow ?? (s.contextTokens && harness.contextWindow ? await harness.contextWindow(sessionId, s.model) : undefined);
    view.recent = s.recent;
    view.activity = currentActivity(s);
    view.lastPrompt = s.lastPrompt;
    view.lastReply = s.lastReply;
    const reviewAt = s.review ? Date.parse(s.review.at) : NaN;
    if (Number.isFinite(reviewAt)) {
      view.review = reviewAt;
      if (s.review?.sent) view.reviewSent = true;
    }
    view.pending = currentPending(s);
    view.logUpdatedAt = entry.tail.mtimeMs;
    if (harness.subagents) view.subagents = await harness.subagents(entry.path);
    return s;
  }

  private async paneView(pane: HerdrPane, snap: HerdrSnapshot, asking: ReadonlyMap<string, Card>): Promise<AgentView> {
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
      const sessionId = await this.mainSession(pane.pane_id, harness, session.value);
      view.sessionId = sessionId;
      summary = await this.fromLog(view, harness, sessionId, undefined, this.firstPrompt.has(pane.pane_id));
      harnessTitle = await harness.title?.(sessionId);
    }

    const switched = this.switched.get(pane.pane_id);
    if (switched) {
      const now = { model: view.model, effort: view.effort, session: view.sessionId };
      switched.base ??= now;
      if (now.model !== switched.base.model || now.effort !== switched.base.effort || now.session !== switched.base.session) this.switched.delete(pane.pane_id);
      else {
        view.model = switched.model ?? view.model;
        view.effort = switched.effort ?? view.effort;
      }
    }

    const terminalTitle = (pane.terminal_title_stripped ?? "").trim();
    view.title =
      this.names.check(pane.pane_id, pane.label) ||
      (isGenericTitle(terminalTitle) ? "" : terminalTitle) ||
      summary?.title ||
      harnessTitle ||
      pane.label ||
      (view.lastPrompt ? oneLine(view.lastPrompt, 60) : "") ||
      ws?.tokens?.topic ||
      view.workspaceLabel;

    // 상태는 herdr 가 정본이다. 하나만 덧쓴다: desk-look·desk-plan 이 엔진 대화상자 대신 띄운 카드는 도구가 도는 중이라
    // herdr 가 working 으로 본다. 그 카드가 답을 기다리는 것을 desk-look 의 표식 파일로 확인했으면 확인 필요로 올린다(asking.ts).
    const card = asking.get(pane.pane_id);
    if (status === "working" && card) {
      status = "blocked";
      view.statusSource = "card";
    }
    if (card?.plan) view.plan = await this.planOf(pane.pane_id, card, view.sessionId);
    // 갓 띄운 Claude 의 첫 턴은 PC 가 바쁘면 Enter 뒤 몇 초에서 수십 초가 지나서야 시작한다(SessionStart 훅 등). 그동안
    // herdr 가 읽는 작업 표시(제목 스피너, esc to interrupt)가 빠지는 틈이 생겨 herdr 는 working → done(또는 idle) → working 으로
    // 오간다 — 새 주민이 "다 했어요" 하고 뛰쳐나갔다가 돌아온다. desk-look 이 스피너 줄을 바꿔 그리면 그 틈이 넓어진다.
    // 그래서 월드가 첫 지시를 보낸 Claude 는 첫 응답이 로그에 적힐 때까지 쉬는 것으로 보지 않는다. 지시가 훅에 막히는 등
    // 응답이 끝내 오지 않을 때를 위해 상한을 둔다. 로그가 이미 응답을 담고 있으면(이어 쓰는 세션) 처음부터 건드리지 않는다.
    const sentAt = this.firstPrompt.get(pane.pane_id);
    if (sentAt !== undefined) {
      if (vendor !== "claude" || summary?.sawAssistant || Date.now() - sentAt > FIRST_PROMPT_HOLD_MS) this.firstPrompt.delete(pane.pane_id);
      else if (status === "done" || status === "idle") {
        status = "working";
        view.statusSource = "prompt";
      }
    }
    // 로그의 대기 요청은 확인 필요 카드에 보탤 내용일 뿐, 상태를 바꾸지는 않는다.
    if (status !== "blocked") view.pending = undefined;
    const seq = pane.state_change_seq ?? 0;
    let seen = this.seen.check(pane.pane_id, seq);
    // 컴팩션(대화 요약)도 herdr 에게는 일하다 끝난 것이라 완료로 온다. 로그의 마지막 사건이 컴팩션이면 새 결과가
    // 아니므로 그 전의 모습으로 둔다: 이미 확인했거나 쉬고 있었으면 확인한 것으로, 확인 전의 완료였으면 완료로 두되 알리지 않는다.
    if (status === "done" && !seen && summary?.compacted) {
      if (this.unread.get(pane.pane_id) === false) {
        this.seen.set(pane.pane_id, seq);
        seen = true;
      } else view.compacted = true;
    }
    if (status === "done") this.unread.set(pane.pane_id, !seen);
    else if (status === "idle" || status === "unknown") this.unread.set(pane.pane_id, false);
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

  /**
   * pane 에서 읽을 세션. herdr 는 pane 안에서 마지막으로 훅을 부른 대화를 알려 주는데, AGY 의 서브에이전트도 같은 pane 에서
   * 훅을 불러 그 자리를 차지한다. 하네스가 맨 위 대화를 알면 그것을 읽고, 아직 모르면 잠시 읽던 대화를 붙든다.
   */
  private async mainSession(paneId: string, harness: Harness, reported: string): Promise<string> {
    if (!harness.mainSession) return reported;
    const main = await harness.mainSession(reported);
    const prev = this.mainOf.get(paneId);
    if (main) {
      this.mainOf.set(paneId, { id: main });
      return main;
    }
    if (prev && prev.id !== reported) {
      const since = prev.unknownSince ?? Date.now();
      if (Date.now() - since < UNKNOWN_SESSION_HOLD_MS) {
        this.mainOf.set(paneId, { id: prev.id, unknownSince: since });
        return prev.id;
      }
    }
    this.mainOf.set(paneId, { id: reported });
    return reported;
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
    await Promise.all([this.seen.load(), this.names.load()]);
    let snap: HerdrSnapshot | undefined;
    let herdrError: Text | undefined;
    try {
      snap = await herdrSnapshot();
    } catch (e) {
      herdrError = e instanceof HerdrError ? e.text : asText((e as Error).message);
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
          worktree: ws.worktree
            ? { path: ws.worktree.checkout_path, linked: ws.worktree.is_linked_worktree === true, repoKey: ws.worktree.repo_key, repoRoot: ws.worktree.repo_root }
            : undefined,
        });
      }
      for (const tab of snap.tabs) tabs.push({ id: tab.tab_id, workspaceId: tab.workspace_id, label: tab.label ?? "", number: tab.number ?? 0 });

      const asking = snap.agents.some((p) => p.agent_status === "working") ? await this.asking.check() : new Map<string, Card>();
      for (const paneId of this.plans.keys()) if (!asking.get(paneId)?.plan) this.plans.delete(paneId);
      const views = await Promise.all(snap.agents.filter((p) => p.agent).map((p) => this.paneView(p, snap, asking)));
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
      this.names.prune(alive);
      for (const id of this.doneSeq.keys()) if (!alive.has(id)) this.doneSeq.delete(id);
      for (const id of this.unread.keys()) if (!alive.has(id)) this.unread.delete(id);
      for (const id of this.firstPrompt.keys()) if (!alive.has(id)) this.firstPrompt.delete(id);
      for (const id of this.mainOf.keys()) if (!alive.has(id)) this.mainOf.delete(id);
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
    for (const id of this.logOf.keys()) if (!alive.has(id)) this.logOf.delete(id);
    for (const key of this.tracked.keys()) if (!this.used.has(key)) this.tracked.delete(key);

    this.builtAt = Date.now();
    return {
      at: this.builtAt,
      herdr: snap !== undefined,
      herdrError,
      session: herdrSessionName() || undefined,
      control: this.control,
      workspaces: [...workspaces.values()].sort((a, b) => (a.number || 1e9) - (b.number || 1e9) || a.label.localeCompare(b.label)),
      tabs,
      panes,
      agents,
      usage: this.usage.current(() => [...this.tracked.values()].filter((t) => t.harness.vendor === "codex").map((t) => t.path)),
    };
  }

  /** 월드에서 pane 이름을 바꿨다고 적는다(비웠으면 지운다). */
  named(paneId: string, label: string): void {
    this.names.set(paneId, label || null);
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

  /** 그 세션의 모델·수준을 바꿨다고 적는다. 다음 응답이 로그에 적힐 때까지 바꾼 값을 보인다. */
  modelSwitched(paneId: string, to: { model?: string; effort?: string }): void {
    this.switched.set(paneId, { model: to.model, effort: to.effort });
  }

  /** 지시를 보냈다고 적는다. 그 세션의 첫 지시였으면 첫 응답까지 쉬는 것으로 보지 않는다(paneView 참고). */
  promptSent(paneId: string): void {
    this.firstPrompt.set(paneId, Date.now());
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

  /** 플랜 승인 카드가 뜬 pane 의 플랜 파일이 고쳐진 시각. 파일을 찾지 못했으면 undefined. */
  private async planOf(paneId: string, card: Card, sessionId: string | undefined): Promise<number | undefined> {
    const session = card.sessionId ?? sessionId;
    const key = `${session}|${card.since}`;
    let found = this.plans.get(paneId);
    if (found?.card !== key) {
      const log = session ? await claude.resolve(session) : null;
      found = { card: key, path: log ? await planPathIn(log) : undefined };
      this.plans.set(paneId, found);
    }
    return found.path ? planMtime(found.path) : undefined;
  }

  /** 승인을 기다리는 플랜의 글. 화면은 에이전트만 가리키고, 어느 파일인지는 서버가 정한다. 카드가 내려갔으면 undefined. */
  async planText(agentId: string): Promise<PlanText | undefined> {
    const path = this.plans.get(agentId)?.path;
    return path ? readPlan(path) : undefined;
  }

  /** 마지막 턴의 리뷰 보고. 그 뒤로 새 지시가 갔거나 로그를 놓았으면 undefined. */
  async reviewText(agentId: string): Promise<ReviewReport | undefined> {
    const key = this.logOf.get(agentId);
    const entry = key ? this.tracked.get(key) : undefined;
    const mark = entry?.tail.state.review;
    return entry && mark ? readReview(entry.path, mark) : undefined;
  }

  /** 카드를 띄워 답을 기다리는 중인지 — herdr 가 막아 주지 않으므로 지시를 보내기 전에 따로 묻는다. */
  async waitingOnCard(paneId: string): Promise<boolean> {
    return (await this.asking.check()).has(paneId);
  }

  /** 플랜 승인 카드(desk-plan)가 떠 있는지. 질문 카드는 아니다 — 같은 숫자 키가 다른 선택지를 고른다. */
  async waitingOnPlan(paneId: string): Promise<boolean> {
    return (await this.asking.check()).get(paneId)?.plan === true;
  }

  /**
   * 활동 로그 한 줄의 원문. 화면은 그 줄의 시각과 한 줄 요약으로 가리키고, 서버는 지금의 최근 활동에서 둘이 같은 것을
   * 찾아 그 자리를 다시 읽는다 — 화면이 로그의 아무 자리나 읽게 하지 않는다. 이미 밀려났거나 로그를 놓았으면 undefined.
   */
  /** n: 시각과 요약이 같은 활동 가운데 최신부터 몇 번째인지(화면의 logKey 와 같은 셈). */
  async activityText(agentId: string, at: string, text: string, n = 0): Promise<string | undefined> {
    const key = this.logOf.get(agentId);
    const entry = key ? this.tracked.get(key) : undefined;
    const activity = entry?.tail.state.recent.filter((a) => a.at === at && a.text === text).at(-1 - n);
    const ref = activity && refOf(activity);
    if (!entry || !activity || !ref) return undefined;
    return activityText(entry.path, entry.harness.reader, ref, at);
  }

  hasPane(paneId: string): Promise<boolean> {
    return this.has("pane", paneId);
  }
}
