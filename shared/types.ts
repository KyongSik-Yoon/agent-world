// 서버와 웹이 함께 쓰는 스냅샷 모델. 서버가 herdr 상태와 트랜스크립트 요약을 합쳐 이 모양으로 내보낸다.

export type AgentStatus = "working" | "blocked" | "done" | "idle" | "unknown";

export type ActivityKind = "tool" | "text" | "thinking" | "user" | "result";

export interface Activity {
  kind: ActivityKind;
  /** 도구 이름(tool) 또는 빈 문자열. */
  name: string;
  /** 한 줄 요약 — 말풍선과 활동 로그에 그대로 쓴다. */
  text: string;
  /** ISO 시각. 로그 행에 시각이 없으면 빈 문자열. */
  at: string;
  /** 도구 결과가 에러였는지. */
  error?: boolean;
}

/** 에이전트가 사용자의 답을 기다리며 멈춰 있는 요청(로그에서 읽은 것). */
export interface PendingRequest {
  /** 도구 이름 — Bash, Edit, AskUserQuestion … */
  tool: string;
  /** 잘리지 않은 명령·파일 경로·설명. */
  detail: string;
  /** 사용자에게 직접 묻는 도구(AskUserQuestion, 플랜 승인)면 true — 답이 올 때까지 반드시 멈춰 있다. */
  asksUser: boolean;
  questions?: Array<{ question: string; options: Array<{ label: string; description?: string }> }>;
  at: string;
}

export interface AgentView {
  /** 안정 키. herdr pane 이면 pane_id, 로그에서만 찾은 세션이면 `log:<vendor>:<session>`. */
  id: string;
  /** herdr 의 agent 문자열(claude, agy, codex …). */
  vendor: string;
  /** herdr pane 이 있으면 그 id. 없으면 herdr 로 이동할 수 없다. */
  paneId?: string;
  workspaceId: string;
  workspaceLabel: string;
  workspaceNumber: number;
  tabId?: string;
  tabLabel?: string;
  paneLabel?: string;
  /** herdr 에 등록된 에이전트 이름(agent.start 로 띄웠거나 이름을 붙인 경우). */
  name?: string;
  title: string;
  status: AgentStatus;
  /** 상태를 어디서 읽었는지 — herdr 가 알려준 값인지, 로그 시각으로 추정한 값인지. */
  statusSource: "herdr" | "log";
  /** 완료를 월드에서 이미 확인했다 — status 는 idle 로 내려가 있다. */
  seen?: boolean;
  /** 아직 결과가 오지 않은 마지막 도구 호출. */
  pending?: PendingRequest;
  focused: boolean;
  cwd: string;
  sessionId?: string;
  /** 이 하네스의 로그를 읽는 어댑터가 있는지. 없으면 herdr 가 알려 주는 제목과 상태가 전부다. */
  readable?: boolean;
  /** 트랜스크립트를 찾아 읽었는지. false 면 아래 필드는 대부분 비어 있다. */
  hasLog: boolean;
  model?: string;
  effort?: string;
  permissionMode?: string;
  harnessVersion?: string;
  branch?: string;
  /** 마지막 요청의 컨텍스트 크기(입력+캐시 토큰). */
  contextTokens?: number;
  contextWindow?: number;
  /** 지금 하고 있는(또는 마지막으로 한) 일. */
  activity?: Activity;
  /** 최근 활동, 오래된 것부터. */
  recent: Activity[];
  lastPrompt?: string;
  lastReply?: string;
  /** 로그 파일이 마지막으로 바뀐 시각(ms). */
  logUpdatedAt?: number;
  /** 지금 상태로 바뀐 것을 서버가 처음 본 시각(ms). */
  statusSince: number;
  /** 최근에 로그가 움직인 서브에이전트 수. */
  subagents: number;
}

export interface WorkspaceView {
  id: string;
  label: string;
  number: number;
  topic?: string;
  repo?: string;
  focused: boolean;
  /** herdr 에 실제로 있는 스페이스인지. false 면 로그만으로 묶은 자리라 조작할 수 없다. */
  managed: boolean;
  /** 워크트리 스페이스면 그 브랜치 체크아웃 경로. */
  worktree?: { path?: string; linked: boolean };
}

export interface TabView {
  id: string;
  workspaceId: string;
  label: string;
  number: number;
}

/** herdr 의 pane 하나. 에이전트가 들어 있으면 agentId 가 그 AgentView 의 id 다. */
export interface PaneView {
  id: string;
  workspaceId: string;
  tabId: string;
  label?: string;
  /** 터미널 제목(셸이면 보통 `user@host:cwd`). */
  title: string;
  cwd: string;
  agentId?: string;
  cols?: number;
  rows?: number;
}

export interface WorldSnapshot {
  at: number;
  /** herdr 소켓에 닿았는지. false 면 로그만으로 만든 스냅샷이다. */
  herdr: boolean;
  /** 닿지 못한 까닭. 화면마다 고른 말이 다를 수 있어 두 말로 싣는다. */
  herdrError?: { ko: string; en: string };
  /** 이 서버가 붙은 herdr 세션의 이름. 기본 세션이면 비어 있다 — 세션을 여럿 쓸 때 어느 화면인지 가리는 데 쓴다. */
  session?: string;
  /** 조작(지시·키 입력·만들기·닫기)을 받는 서버인지. AGENT_WORLD_READONLY=1 이면 false. */
  control: boolean;
  workspaces: WorkspaceView[];
  tabs: TabView[];
  panes: PaneView[];
  agents: AgentView[];
}

/**
 * 직전 스냅샷과 달라진 부분. 화면은 전체 스냅샷을 한 번 받은 뒤로는 이것만 받아 덧입힌다.
 * agents 는 바뀌었거나 새로 생긴 것만 담고, order 가 전체의 차례와 남아 있는 것을 정한다.
 * 그 밖의 항목(workspaces, tabs, panes …)은 달라졌을 때만 들어 있다.
 */
export interface SnapshotPatch extends Partial<Omit<WorldSnapshot, "agents" | "at">> {
  at: number;
  order: string[];
  agents: AgentView[];
}
