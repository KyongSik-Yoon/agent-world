import type { LogReader } from "../tail.ts";
import type { LogSummary } from "../summary.ts";

export interface LogFile {
  sessionId: string;
  path: string;
  mtimeMs: number;
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
  /** 로그에 없는 제목을 다른 곳에서 읽는다(AGY 의 대화 요약 DB). */
  title?(sessionId: string): Promise<string | undefined>;
  /** herdr 밖에서 도는 세션을 찾는다 — sinceMs 이후로 바뀐 로그 파일들. */
  discover?(sinceMs: number): Promise<LogFile[]>;
}
