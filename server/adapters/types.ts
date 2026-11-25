import type { LogReader } from "../tail.ts";
import type { LogSummary } from "../summary.ts";

export interface LogFile {
  sessionId: string;
  path: string;
  mtimeMs: number;
}

/** 로그 밖에서 읽은 입력: 마지막 명령(`/clear`, `!pwd`)과, 보냈지만 아직 로그에 지시로 적히지 않은 글들. */
export interface Typed {
  command?: { text: string; at: string };
  /** 대화를 마지막으로 비운 시각(ms). 그 뒤로 로그가 움직이지 않았으면 그 로그는 지나간 대화다. */
  clearedAt?: number;
  queued?: string[];
}

/** 하네스 하나의 로그를 읽는 방법. 새 하네스는 이 인터페이스 하나만 채우면 월드에 나타난다. */
export interface Harness {
  vendor: string;
  /** herdr 의 agent 문자열이 이 하네스인지. */
  matches(agent: string): boolean;
  reader: LogReader<LogSummary>;
  /** 세션 id 로 로그 파일을 찾는다. 없으면 null. */
  resolve(sessionId: string): Promise<string | null>;
  /** 최근에 로그가 움직인 서브에이전트 수. */
  subagents?(path: string): Promise<number>;
  /** 로그에 없는 문맥 창 크기(토큰)를 다른 곳에서 읽는다. model 은 로그가 말하는 지금의 모델. */
  contextWindow?(sessionId: string, model: string | undefined): Promise<number | undefined>;
  /** 로그에 없는 제목을 다른 곳에서 읽는다(AGY 의 대화 요약 DB). */
  title?(sessionId: string): Promise<string | undefined>;
  /**
   * herdr 가 알려 준 세션이 서브에이전트면 그것을 부른 맨 위 세션을 돌려준다. 맨 위면 그대로, 아직 알 수 없으면 null.
   * 없으면 herdr 의 세션을 그대로 읽는다.
   */
  mainSession?(sessionId: string): Promise<string | null>;
  /**
   * 로그에 남지 않거나 늦게 남는 입력을 다른 곳에서 읽는다(AGY 의 입력 기록). 세션이 아직 없으면 폴더로 찾는다.
   * last 는 로그가 아는 마지막 지시 — 그 뒤에 친 것만 "줄에 선 것"으로 본다.
   */
  typed?(sessionId: string | undefined, cwd: string, last: { prompt?: string; at?: string }): Promise<Typed | undefined>;
  /** 사람에게 읽으라고 남긴 글(server/artifact.ts)이 놓이는 대화 폴더(AGY 의 brain/<id>). */
  artifactDir?(sessionId: string): string | undefined;
  /** herdr 밖에서 도는 세션을 찾는다 — sinceMs 이후로 바뀐 로그 파일들. */
  discover?(sinceMs: number): Promise<LogFile[]>;
}
