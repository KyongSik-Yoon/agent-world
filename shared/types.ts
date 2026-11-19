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

/** 입력창에서 빗금(`/이름`)으로 부를 수 있는 스킬 하나(/api/skills). */
export interface SkillView {
  name: string;
  description: string;
  /** 이름 뒤에 쓰는 것(머리말의 argument-hint). */
  hint?: string;
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
  /**
   * 상태를 어디서 읽었는지 — herdr 가 알려준 값인지, 로그 시각으로 추정한 값인지,
   * herdr 는 working 이라 했지만 답을 기다리는 질문 카드(desk-look·desk-plan)를 찾아 올린 값인지,
   * herdr 는 쉰다고 했지만 월드가 보낸 첫 지시에 아직 첫 응답이 없어 일하는 중으로 둔 값인지.
   */
  statusSource: "herdr" | "log" | "card" | "prompt";
  /** 완료를 월드에서 이미 확인했다 — status 는 idle 로 내려가 있다. */
  seen?: boolean;
  /** 이 완료는 새 결과가 아니다 — 컴팩션(대화 요약)이 끝나 다시 나온, 아직 확인하지 않은 예전 완료다. 알리지 않는다. */
  compacted?: boolean;
  /** 아직 결과가 오지 않은 마지막 도구 호출. */
  pending?: PendingRequest;
  /** 승인을 기다리는 플랜 파일이 마지막으로 고쳐진 시각(ms). 있으면 `/api/plan` 으로 그 글을 읽을 수 있다. */
  plan?: number;
  /** 이 세션에서 desk-review 가 마지막으로 남긴 리뷰 보고의 시각(ms). 있으면 `/api/review` 로 그 보고를 읽을 수 있다. */
  review?: number;
  /** 그 보고를 두고 월드의 '고치게 하기'로 지시를 보냈다. */
  reviewSent?: boolean;
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

/** 하네스에서 고를 수 있는 모델 하나와 그 모델이 받는 사고 수준(effort). */
/** desk-review 의 리뷰 보고 한 항목. 정리(simplify)는 fixed·skipped, 리뷰(code-review)는 fixed·found·dismissed. */
export interface ReviewItem {
  stage: "simplify" | "review";
  status: "fixed" | "skipped" | "found" | "dismissed";
  /** 작업 폴더 안이면 그 기준의 경로, 밖이면 받은 그대로. */
  file: string;
  line: number;
  reason: string;
  /** 리뷰에서 찾은 결함(fixed·found)만: 어떻게 고쳤는지, 왜 남겼는지. */
  resolution?: string;
}

/**
 * 월드의 리뷰 창이 보내는 '고치게 하기' 지시의 첫 줄(web/review.ts 의 t() 문장, 한국어·영어). 서버는 로그에서 이 줄로
 * 시작하는 지시를 보면 그 보고에 답한 것으로 친다. 문장을 바꾸면 여기도 함께 바꾼다.
 */
export const REVIEW_FIX_PROMPT = /^(?:방금 리뷰 보고에서 아래 \d+건을 고쳐 줘\.|Fix these \d+ items from the review report you just gave\.)/;
/** 같은 지시를 로그의 바이트에서 찾을 때 쓰는 조각(풀기 전에 걸러 낸다). */
export const REVIEW_FIX_MARKS = ["방금 리뷰 보고에서 아래 ", "items from the review report you just gave."];

/** `/api/review` 의 답 — desk-review 의 review_report 입력을 화면이 그릴 모양으로 다듬은 것. */
export interface ReviewReport {
  summary: string;
  items: ReviewItem[];
  unverified?: string;
  next?: string;
  /** 보고를 남긴 시각(ms). AgentView.review 와 같다. */
  at: number;
}

export interface ModelChoice {
  /** 하네스에 넘기는 이름(Claude 는 별칭, Codex 는 slug, agy 는 수준을 뗀 모델 id). */
  id: string;
  label: string;
  /** 낮은 것부터. 비어 있으면 수준을 고를 수 없는 모델이다. */
  efforts: string[];
  /** 하네스가 알려 준 이 모델의 기본 수준. */
  defaultEffort?: string;
}

/**
 * 떠 있는 세션의 모델을 그 세션에만 바꿀 수 있는 하네스. agy 는 바꾸면 다음 세션의 기본값까지 바뀌어 띄울 때만 고른다
 * (server/models.ts 머리말).
 */
export const LIVE_MODEL_KINDS: readonly string[] = ["claude", "codex"];

export interface ModelCatalog {
  kind: string;
  models: ModelChoice[];
  /** 모델을 고르지 않았을 때 고를 수 있는 수준 — 목록의 모델들이 받는 것을 모두 모아 낮은 것부터. */
  efforts: string[];
  /** 떠 있는 세션의 모델을 그 세션에만 바꿀 수 있는지. 아니면 띄울 때만 고른다(agy 는 바꾸면 기본값까지 바뀐다). */
  live: boolean;
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
  /**
   * git 저장소 안에 열린 스페이스면 그 체크아웃. herdr 가 본체(linked: false)에도 붙인다.
   * repoKey 가 같은 스페이스들은 한 저장소다 — 월드는 이것들을 한 집터의 본채와 별채로 묶는다.
   */
  worktree?: { path?: string; linked: boolean; repoKey?: string; repoRoot?: string };
  /**
   * herdr 가 저장소 정보를 붙이지 않았어도 그 스페이스의 폴더가 git 저장소 안인지. herdr 는 워크트리와 엮인 적 없는
   * 스페이스에는 worktree 를 싣지 않는다 — 그래도 거기서 워크트리를 열 수 있으므로 '워크트리 추가'를 보일지 이것으로 가른다.
   */
  inRepo?: boolean;
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

/** 한도 창 하나(5시간, 7일 …)에서 쓴 만큼. */
export interface UsageWindow {
  /** 창의 길이(분). 하네스가 알려 주지 않으면 없다. */
  minutes?: number;
  /** 한 하네스 안에서 한도가 따로 도는 묶음(Antigravity 의 gemini·3p). */
  group?: string;
  /** 쓴 비율, 0–100 의 정수. */
  usedPct: number;
  /** 창이 초기화되는 시각(ms). 모르면 없다. */
  resetsAt?: number;
  /** 읽은 뒤에 초기화 시각이 지나 0 으로 돌아간 창. */
  reset?: boolean;
}

/** 하네스 하나의 요금제와 한도 사용량. 계정을 가리키는 것(메일·id)은 싣지 않는다. */
export interface UsageView {
  /** AgentView.vendor 와 같은 이름(claude, codex, agy). */
  vendor: string;
  /** 하네스가 부르는 요금제 이름 그대로. */
  plan?: string;
  windows: UsageWindow[];
  /** 방금 읽은 값이 아니면 그 값이 적힌 시각(ms). */
  asOf?: number;
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
  /** 하네스별 사용량. 남긴 것이 없는 하네스는 빠진다. */
  usage: UsageView[];
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
