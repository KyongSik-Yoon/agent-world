// 승인을 기다리는 플랜 파일을 찾아 읽는다.
//
// Claude Code 는 플랜 모드에 들어갈 때 플랜을 적을 파일(`<설정 폴더>/plans/<이름>.md`)을 정해 세션 로그에 한 번 적는다
// (attachment.type "plan_mode" 의 planFilePath). 승인 카드가 뜬 동안 터미널에는 그 글이 옆 창에 잘려 보일 뿐이라, 화면은
// 이 파일을 받아 따로 읽기 좋게 그린다. 그 줄은 로그 한참 앞에 있을 수 있어(꼬리만 읽는 요약에는 안 잡힌다) 카드가 뜰 때
// 한 번 로그를 뒤에서부터 찾는다.
import { lstat, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve, sep } from "node:path";

import { isRecord } from "./summary.ts";

/** 이보다 큰 파일은 플랜으로 보지 않는다 — 이 길은 휴대폰에서도 닿는다. */
const MAX_PLAN_BYTES = 512 * 1024;
const MARK = '"planFilePath"';

function plansDir(): string {
  return resolve(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "plans");
}

/** 플랜 폴더 바로 아래의 .md 파일만 받는다. 로그에 적힌 경로라도 그 밖은 읽지 않는다. */
function allowed(path: string): string | undefined {
  const full = resolve(path);
  return full.startsWith(plansDir() + sep) && full.endsWith(".md") ? full : undefined;
}

/** 세션 로그에서 가장 최근에 정한 플랜 파일 경로. 맨 위 세션의 것만 본다(서브에이전트의 플랜은 사용자가 승인하는 것이 아니다). */
export async function planPathIn(logPath: string): Promise<string | undefined> {
  let text: string;
  try {
    text = await readFile(logPath, "utf8");
  } catch {
    return undefined;
  }
  for (let end = text.length; end > 0; ) {
    const at = text.lastIndexOf(MARK, end);
    if (at < 0) return undefined;
    const from = text.lastIndexOf("\n", at) + 1;
    const to = text.indexOf("\n", at);
    try {
      // 이 글자열은 대화에 인용돼서도 나온다 — 줄을 풀어 플랜 모드 행인지 확인한다.
      const row: unknown = JSON.parse(text.slice(from, to < 0 ? text.length : to));
      const a = isRecord(row) && row.isSidechain !== true && isRecord(row.attachment) ? row.attachment : undefined;
      if (a && typeof a.type === "string" && a.type.startsWith("plan_mode") && a.isSubAgent !== true && typeof a.planFilePath === "string") return allowed(a.planFilePath);
    } catch {
      // 쓰는 중인 줄.
    }
    end = from - 1;
  }
  return undefined;
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
