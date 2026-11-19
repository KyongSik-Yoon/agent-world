// desk-review 가 남긴 리뷰 보고를 읽는다.
//
// desk-review 의 simplify-review 는 마지막 보고를 `mcp__desk-review__review_report` 도구 호출로 넘긴다. 그 입력(한 줄 결론,
// 항목마다 단계·상태·파일·줄·이유·처리)이 세션 로그에 그대로 남으므로, 터미널 옆 패널을 열지 않고도 화면이 그 보고를
// 따로 그릴 수 있다. 서버는 보고를 들고 있지 않는다 — 로그를 읽을 때 그 호출이 놓인 줄의 위치만 기억하고(summary 의
// review), 화면이 열 때 그 한 줄만 다시 읽어 다듬는다.
import { isAbsolute, relative } from "node:path";

import type { ReviewItem, ReviewReport } from "../shared/types.ts";
import { clip, isRecord, str } from "./summary.ts";
import { readLineAt } from "./tail.ts";

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
