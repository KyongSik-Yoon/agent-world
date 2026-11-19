// 승인을 기다리는 플랜 파일을 찾아 읽는다.
//
// Claude Code 는 플랜 모드에 들어갈 때 플랜을 적을 파일(`<설정 폴더>/plans/<이름>.md`)을 정해 세션 로그에 한 번 적는다
// (attachment.type "plan_mode" 의 planFilePath). 승인 카드가 뜬 동안 터미널에는 그 글이 옆 창에 잘려 보일 뿐이라, 화면은
// 이 파일을 받아 따로 읽기 좋게 그린다. 그 줄은 로그 한참 앞에 있을 수 있어(꼬리만 읽는 요약에는 안 잡힌다) 카드가 뜰 때
// 한 번 로그를 뒤에서부터 찾는다.
import { lstat, open, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve, sep } from "node:path";

import { isRecord } from "./summary.ts";

/** 이보다 큰 파일은 플랜으로 보지 않는다 — 이 길은 휴대폰에서도 닿는다. */
const MAX_PLAN_BYTES = 512 * 1024;
const MARK = '"planFilePath"';
const SCAN_CHUNK = 1024 * 1024;

function plansDir(): string {
  return resolve(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "plans");
}

/** 플랜 폴더 바로 아래의 .md 파일만 받는다. 로그에 적힌 경로라도 그 밖은 읽지 않는다. */
function allowed(path: string): string | undefined {
  const full = resolve(path);
  return full.startsWith(plansDir() + sep) && full.endsWith(".md") ? full : undefined;
}

/** 플랜 모드 행이면 거기 적힌 경로. 맨 위 세션의 것만 본다(서브에이전트의 플랜은 사용자가 승인하는 것이 아니다). */
function planPathOf(line: string): string | undefined {
  try {
    // 이 글자열은 대화에 인용돼서도 나온다 — 줄을 풀어 플랜 모드 행인지 확인한다.
    const row: unknown = JSON.parse(line);
    const a = isRecord(row) && row.isSidechain !== true && isRecord(row.attachment) ? row.attachment : undefined;
    if (a && typeof a.type === "string" && a.type.startsWith("plan_mode") && a.isSubAgent !== true && typeof a.planFilePath === "string") return a.planFilePath;
  } catch {
    // 쓰는 중인 줄.
  }
  return undefined;
}

/**
 * 세션 로그에서 가장 최근에 정한 플랜 파일 경로. 로그를 끝에서부터 덩어리로 읽는다 — 카드는 플랜 모드에 든 지 얼마 안 돼
 * 뜨므로 대개 첫 덩어리에서 찾고, 로그는 수십 MB 까지 커서 통째로 읽으면 스냅샷이 그만큼(100MB 에 0.4초) 멈춘다.
 */
export async function planPathIn(logPath: string): Promise<string | undefined> {
  let file;
  try {
    file = await open(logPath, "r");
  } catch {
    return undefined;
  }
  try {
    let pos = (await file.stat()).size;
    /** 앞 덩어리에서 줄 머리가 잘린 채 넘어온 조각. */
    let carry: Buffer = Buffer.alloc(0);
    while (pos > 0) {
      const start = Math.max(0, pos - SCAN_CHUNK);
      const chunk = Buffer.alloc(pos - start);
      await file.read(chunk, 0, chunk.length, start);
      const buf = carry.length ? Buffer.concat([chunk, carry]) : chunk;
      pos = start;
      // 덩어리의 첫 줄은 앞이 잘렸을 수 있다 — 파일 머리에 닿기 전에는 다음 덩어리에 붙여 본다.
      const head = start === 0 ? 0 : buf.indexOf(10) + 1;
      if (head === 0 && start > 0) {
        carry = buf;
        continue;
      }
      for (let end = buf.length; end > head; ) {
        const at = buf.lastIndexOf(MARK, end);
        if (at < head) break;
        const from = buf.lastIndexOf(10, at) + 1;
        const to = buf.indexOf(10, at);
        const found = planPathOf(buf.toString("utf8", from, to < 0 ? buf.length : to));
        if (found) return allowed(found);
        end = from - 1;
      }
      carry = buf.subarray(0, head);
    }
    return undefined;
  } catch {
    return undefined;
  } finally {
    await file.close();
  }
}

/** 플랜 파일이 마지막으로 고쳐진 시각(ms). 아직 없거나 읽을 수 없는 것이면 undefined. */
export async function planMtime(path: string): Promise<number | undefined> {
  try {
    const info = await lstat(path);
    return info.isFile() && info.size > 0 && info.size <= MAX_PLAN_BYTES ? Math.round(info.mtimeMs) : undefined;
  } catch {
    return undefined;
  }
}

export interface PlanText {
  /** 파일 이름. */
  name: string;
  text: string;
  /** 고쳐진 시각(ms). */
  at: number;
}

export async function readPlan(path: string): Promise<PlanText | undefined> {
  const at = allowed(path) ? await planMtime(path) : undefined;
  if (at === undefined) return undefined;
  try {
    return { name: basename(path), text: await readFile(path, "utf8"), at };
  } catch {
    return undefined;
  }
}
