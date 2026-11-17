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
  tabLabel?: string;
  paneLabel?: string;
  title: string;
  status: AgentStatus;
  /** 상태를 어디서 읽었는지 — herdr 가 알려준 값인지, 로그 시각으로 추정한 값인지. */
  statusSource: "herdr" | "log";
  focused: boolean;
  cwd: string;
  sessionId?: string;
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
}

export interface WorldSnapshot {
  at: number;
  /** herdr 소켓에 닿았는지. false 면 로그만으로 만든 스냅샷이다. */
  herdr: boolean;
  herdrError?: string;
  workspaces: WorkspaceView[];
  agents: AgentView[];
}
