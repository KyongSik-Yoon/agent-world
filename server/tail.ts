// 줄 단위 JSON 로그를 꼬리부터 읽고, 그 뒤로는 덧붙은 바이트만 읽는다.
//
// 처음 읽을 때 고정 크기 꼬리만 보면 안 된다: 하네스 로그에는 수백 KB 짜리 행(시스템 프롬프트
// 스냅샷, 요청 블롭)이 끼어 있어서 꼬리 창 안에 쓸 만한 행이 하나도 없을 수 있다. 그래서 요약이
// "준비됨"이 될 때까지 창을 키워가며 다시 읽는다.
import { open, stat } from "node:fs/promises";

const FIRST_WINDOW = 384 * 1024;
const MAX_WINDOW = 48 * 1024 * 1024;
const NEWLINE = 0x0a;

export interface LogReader<S> {
  /** 빈 요약. */
  init(): S;
  /** 이 줄을 JSON 으로 풀 가치가 있는지 — 큰 행을 파싱 전에 걸러낸다. */
  want?(line: string): boolean;
  /** 한 행을 요약에 반영한다. */
  feed(state: S, row: unknown): void;
  /** 처음 읽을 때, 이 요약이면 꼬리 창을 더 키우지 않아도 되는지. */
  ready(state: S): boolean;
}

async function readRange(path: string, start: number, end: number): Promise<Buffer> {
  const length = Math.max(0, end - start);
  const buf = Buffer.allocUnsafe(length);
  if (length === 0) return buf;
  const handle = await open(path, "r");
  try {
    let got = 0;
    while (got < length) {
      const { bytesRead } = await handle.read(buf, got, length - got, start + got);
      if (bytesRead === 0) break;
      got += bytesRead;
    }
    return got === length ? buf : buf.subarray(0, got);
  } finally {
    await handle.close();
  }
}

export class TailedLog<S> {
  state: S;
  size = 0;
  mtimeMs = 0;
  /** 마지막으로 다 읽은 줄의 끝(바이트). */
  private offset = 0;
  private loaded = false;

  constructor(
    readonly path: string,
    private readonly reader: LogReader<S>,
  ) {
    this.state = reader.init();
  }

  private feedBytes(state: S, bytes: Buffer): void {
    let from = 0;
    while (from < bytes.length) {
      let nl = bytes.indexOf(NEWLINE, from);
      if (nl === -1) nl = bytes.length;
      if (nl > from) {
        const line = bytes.toString("utf8", from, nl);
        if (!this.reader.want || this.reader.want(line)) {
          try {
            this.reader.feed(state, JSON.parse(line));
          } catch {
            // 쓰는 중이라 잘린 행이거나 JSON 이 아닌 줄 — 건너뛴다.
          }
        }
      }
      from = nl + 1;
    }
  }

  /** 파일이 바뀌었으면 읽어서 요약을 갱신한다. 바뀐 것이 있으면 true. */
  async refresh(): Promise<boolean> {
    let info;
    try {
      info = await stat(this.path);
    } catch {
      return false;
    }
    if (this.loaded && info.size === this.size && info.mtimeMs === this.mtimeMs) return false;

    if (!this.loaded || info.size < this.offset) {
      // 처음이거나 파일이 줄었다(다시 쓰였다) — 꼬리부터 새로 읽는다.
      let window = FIRST_WINDOW;
      for (;;) {
        const start = Math.max(0, info.size - window);
        let bytes = await readRange(this.path, start, info.size);
        if (start > 0) {
          const firstNl = bytes.indexOf(NEWLINE);
          bytes = firstNl === -1 ? bytes.subarray(bytes.length) : bytes.subarray(firstNl + 1);
        }
        const lastNl = bytes.lastIndexOf(NEWLINE);
        const complete = lastNl === -1 ? bytes.subarray(0, 0) : bytes.subarray(0, lastNl + 1);
        const state = this.reader.init();
        this.feedBytes(state, complete);
        if (this.reader.ready(state) || start === 0 || window >= MAX_WINDOW) {
          this.state = state;
          this.offset = info.size - (bytes.length - complete.length);
          break;
        }
        window *= 4;
      }
      this.loaded = true;
    } else if (info.size > this.offset) {
      const bytes = await readRange(this.path, this.offset, info.size);
      const lastNl = bytes.lastIndexOf(NEWLINE);
      if (lastNl !== -1) {
        this.feedBytes(this.state, bytes.subarray(0, lastNl + 1));
        this.offset += lastNl + 1;
      }
    }
    this.size = info.size;
    this.mtimeMs = info.mtimeMs;
    return true;
  }
}
