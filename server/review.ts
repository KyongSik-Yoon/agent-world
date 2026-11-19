// desk-review 가 남긴 리뷰 보고를 읽는다.
//
// desk-review 의 simplify-review 는 마지막 보고를 `mcp__desk-review__review_report` 도구 호출로 넘긴다. 그 입력(한 줄 결론,
// 항목마다 단계·상태·파일·줄·이유·처리)이 세션 로그에 그대로 남으므로, 터미널 옆 패널을 열지 않고도 화면이 그 보고를
// 따로 그릴 수 있다. 서버는 보고를 들고 있지 않는다 — 로그를 읽을 때 그 호출이 놓인 줄의 위치만 기억하고(summary 의
// review), 화면이 열 때 그 한 줄만 다시 읽어 다듬는다.
import { open } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";

import { REVIEW_FIX_MARKS, type ReviewItem, type ReviewReport } from "../shared/types.ts";
import { clip, isRecord, str, type LogSummary } from "./summary.ts";
import { type LogReader, readLineAt } from "./tail.ts";

export const REVIEW_TOOL = "mcp__desk-review__review_report";

/** 이 길은 휴대폰에서도 닿는다 — 보고가 아무리 커도 화면에 보내는 양을 묶어 둔다. */
const MAX_ITEMS = 300;
const MAX_TEXT = 4000;

const STATUSES: Record<ReviewItem["stage"], readonly ReviewItem["status"][]> = {
  simplify: ["fixed", "skipped"],
  review: ["fixed", "found", "dismissed"],
};

/** 로그에서 리뷰 보고가 놓인 자리. 그 줄의 바이트 위치와 도구 호출 id 로 다시 찾는다. */
export interface ReviewMark {
  pos: number;
  id: string;
  /** 그 행의 시각(로그에 적힌 ISO 글). */
  at: string;
  /** 그 뒤에 월드의 '고치게 하기' 지시가 갔다. */
  sent?: boolean;
}

function item(raw: unknown, cwd: string | undefined): ReviewItem | undefined {
  if (!isRecord(raw)) return undefined;
  const stage = raw.stage === "simplify" || raw.stage === "review" ? raw.stage : undefined;
  const status = stage && (STATUSES[stage] as readonly unknown[]).includes(raw.status) ? (raw.status as ReviewItem["status"]) : undefined;
  const file = str(raw.file);
  const line = typeof raw.line === "number" && Number.isInteger(raw.line) && raw.line > 0 ? raw.line : undefined;
  if (!stage || !status || !file || !line) return undefined;
  // 작업 폴더 안의 절대 경로는 그 기준으로 줄인다 — 좁은 화면에서 경로 앞머리가 이름을 밀어낸다.
  const rel = cwd && isAbsolute(file) ? relative(cwd, file) : "";
  const out: ReviewItem = { stage, status, file: rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : file, line, reason: clip(str(raw.reason) ?? "", MAX_TEXT) };
  const resolution = str(raw.resolution);
  if (resolution && stage === "review" && status !== "dismissed") out.resolution = clip(resolution, MAX_TEXT);
  return out;
}

/** 로그의 한 행에서 그 id 의 review_report 호출을 찾아 다듬는다. 행이 바뀌었거나(파일이 다시 쓰였다) 모양이 틀리면 undefined. */
export function reviewFromRow(row: unknown, mark: ReviewMark): ReviewReport | undefined {
  if (!isRecord(row) || row.timestamp !== mark.at || !isRecord(row.message) || !Array.isArray(row.message.content)) return undefined;
  const call = row.message.content.find((p) => isRecord(p) && p.type === "tool_use" && p.id === mark.id && p.name === REVIEW_TOOL);
  const input = isRecord(call) && isRecord(call.input) ? call.input : undefined;
  const summary = input && str(input.summary);
  if (!input || !summary || !Array.isArray(input.items)) return undefined;
  const cwd = str(row.cwd);
  const items = input.items
    .slice(0, MAX_ITEMS)
    .map((raw) => item(raw, cwd))
    .filter((x) => x !== undefined);
  const unverified = str(input.unverified)?.trim();
  const next = str(input.next)?.trim();
  return {
    summary: clip(summary.trim(), MAX_TEXT),
    items,
    ...(unverified ? { unverified: clip(unverified, MAX_TEXT) } : {}),
    ...(next ? { next: clip(next, MAX_TEXT) } : {}),
    at: Date.parse(mark.at),
  };
}

export async function readReview(path: string, mark: ReviewMark): Promise<ReviewReport | undefined> {
  const line = await readLineAt(path, mark.pos).catch(() => undefined);
  if (line === undefined) return undefined;
  try {
    return reviewFromRow(JSON.parse(line), mark);
  } catch {
    return undefined;
  }
}

/**
 * 꼬리 창 앞을 거슬러 찾을 한도. 그보다 오래된 보고는 다시 띄운 서버에서는 놓는다. 비용은 읽는 바이트에 비례한다(페이지
 * 캐시에서 32MB 를 읽는 데 70~80ms, 글자 찾기는 1ms 안). 실제 로그에서 보고는 꼬리 창 앞 5.6MB 안에 있었다.
 */
const MAX_SCAN = 8 * 1024 * 1024;
/** 보고 뒤로 결과 행과 '고치게 하기' 지시를 찾는 한도. 꼬리 창(최대 수 MB)과 위 한도를 함께 덮는다. */
const MAX_AFTER = 24 * 1024 * 1024;
const SCAN_CHUNK = 2 * 1024 * 1024;
const NL = 0x0a;
const CALL_MARK = Buffer.from(`"${REVIEW_TOOL}"`);

type Handle = Awaited<ReturnType<typeof open>>;

async function readBytes(file: Handle, start: number, end: number): Promise<Buffer> {
  const buf = Buffer.allocUnsafe(Math.max(0, end - start));
  let got = 0;
  while (got < buf.length) {
    const { bytesRead } = await file.read(buf, got, buf.length - got, start + got);
    if (bytesRead === 0) break;
    got += bytesRead;
  }
  return buf.subarray(0, got);
}

/** buf 안에서 at 을 품은 줄의 [시작, 끝). */
function lineAround(buf: Buffer, at: number): [number, number] {
  const to = buf.indexOf(NL, at);
  return [buf.lastIndexOf(NL, at) + 1, to < 0 ? buf.length : to];
}

/**
 * 꼬리 창(before 부터) 앞에 놓인 마지막 리뷰 보고. 서버를 다시 띄우면 꼬리 창은 마지막 지시까지만 읽으므로, 그 앞의 보고는
 * 이것으로 찾는다. 로그를 JSON 으로 풀면 몇 MB 에 수백 ms 가 들어, 바이트에서 글자로 찾고 걸린 줄만 푼다.
 * 찾은 보고 뒤의 줄 가운데 그 호출의 결과(거절됐는지)와 월드의 '고치게 하기' 지시만 같은 리더로 다시 읽어 상태를 맞춘다.
 */
export async function findReview(path: string, before: number, reader: LogReader<LogSummary>): Promise<ReviewMark | undefined> {
  const file = await open(path, "r");
  try {
    return await scan(file, before, reader);
  } finally {
    await file.close();
  }
}

async function scan(file: Handle, before: number, reader: LogReader<LogSummary>): Promise<ReviewMark | undefined> {
  const floor = Math.max(0, before - MAX_SCAN);
  let end = before;
  let call: { pos: number; line: string } | undefined;
  /** 앞 덩어리에서 줄 머리가 잘린 채 넘어온 조각. */
  let carry: Buffer = Buffer.alloc(0);
  while (!call && end > floor) {
    const start = Math.max(floor, end - SCAN_CHUNK);
    const chunk = await readBytes(file, start, end);
    const buf = carry.length ? Buffer.concat([chunk, carry]) : chunk;
    // 덩어리의 첫 줄은 앞이 잘렸을 수 있다 — 한도의 바닥에 닿기 전에는 다음 덩어리에 붙여 본다.
    const head = start === floor ? 0 : buf.indexOf(NL) + 1;
    for (let at = buf.lastIndexOf(CALL_MARK); at >= head; at = buf.lastIndexOf(CALL_MARK, at - 1)) {
      const [from, to] = lineAround(buf, at);
      const line = buf.toString("utf8", from, to);
      try {
        const row: unknown = JSON.parse(line);
        // 대화에 인용된 같은 글자열이 아니라 맨 위 세션의 도구 호출 행인지 본다.
        if (isRecord(row) && row.type === "assistant" && row.isSidechain !== true && isRecord(row.message) && Array.isArray(row.message.content) && row.message.content.some((p) => isRecord(p) && p.type === "tool_use" && p.name === REVIEW_TOOL)) {
          call = { pos: start + from, line };
          break;
        }
      } catch {
        // 잘린 줄.
      }
      at = from;
    }
    carry = head > 0 ? buf.subarray(0, head) : Buffer.alloc(0);
    end = start;
  }
  if (!call) return undefined;

  const s = reader.init();
  reader.feed(s, JSON.parse(call.line), call.pos);
  const id = s.reviewCall?.id;
  if (!id) return undefined;
  // 보고 뒤로는 그 호출의 결과 행과 '고치게 하기' 지시만 차례대로 다시 읽는다.
  const after = call.pos + Buffer.byteLength(call.line) + 1;
  const rest = await readBytes(file, after, Math.min(after + MAX_AFTER, (await file.stat()).size));
  const starts = new Set<number>();
  for (const mark of [`"${id}"`, ...REVIEW_FIX_MARKS].map((m) => Buffer.from(m))) {
    for (let at = rest.indexOf(mark); at >= 0; at = rest.indexOf(mark, at + 1)) starts.add(lineAround(rest, at)[0]);
  }
  for (const from of [...starts].sort((a, b) => a - b)) {
    const [, to] = lineAround(rest, from);
    try {
      reader.feed(s, JSON.parse(rest.toString("utf8", from, to)), after + from);
    } catch {
      // 쓰는 중인 줄.
    }
  }
  return s.review;
}
