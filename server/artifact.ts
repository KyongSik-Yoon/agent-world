// AGY 가 승인을 바라고 남긴 글(아티팩트)을 찾아 읽는다.
//
// AGY 는 구현 계획·제안서 같은 글을 대화 폴더(`brain/<id>/`)에 마크다운으로 쓰고, 곁에 `<이름>.md.metadata.json` 을 둔다.
// 그 안의 requestFeedback 이 참이면 사람의 승인을 바라는 글이다 — 터미널에는 "1 artifact · /artifact to review" 한 줄만
// 보이고 글은 터미널 안의 검토 창에서만 읽힌다. Claude 의 플랜 카드와 달리 아무것도 막고 있지 않고 턴은 끝나 있다.
//
// 어느 글인지는 로그가 아니라 곁 파일로 고른다. 로그(`write_file` 의 ArtifactMetadata)는 꼬리 창 밖으로 밀려나거나
// 줄인 사본(transcript.jsonl)에서는 인자가 잘리고, 같은 표시가 대화 폴더 밖의 파일에도 붙는다.
import { lstat, readFile, readdir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import { isRecord } from "./summary.ts";

/** 이보다 큰 글은 읽지 않는다 — 이 길은 휴대폰에서도 닿는다. */
const MAX_ARTIFACT_BYTES = 512 * 1024;
const META = ".md.metadata.json";

export interface ArtifactMark {
  /** 글 파일의 절대 경로(대화 폴더 바로 아래의 .md). */
  path: string;
  /** 글이 마지막으로 고쳐진 시각(ms). */
  at: number;
  /** 승인을 청한 시각(ms, 곁 파일의 updatedAt). 이 뒤에 지시가 갔으면 답한 것이다. */
  asked: number;
}

/** 글 파일이 마지막으로 고쳐진 시각. 파일이 아니거나(링크 포함) 너무 크면 undefined. */
async function mtimeOf(path: string): Promise<number | undefined> {
  try {
    const info = await lstat(path);
    return info.isFile() && info.size > 0 && info.size <= MAX_ARTIFACT_BYTES ? Math.round(info.mtimeMs) : undefined;
  } catch {
    return undefined;
  }
}

/** 대화 폴더에서 승인을 바란 글 가운데 가장 최근에 청한 것. */
export async function findArtifact(dir: string): Promise<ArtifactMark | undefined> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return undefined;
  }
  let best: { name: string; asked: number } | undefined;
  for (const name of names) {
    if (!name.endsWith(META)) continue;
    let meta: unknown;
    try {
      meta = JSON.parse(await readFile(join(dir, name), "utf8"));
    } catch {
      continue; // 쓰는 중이거나 모양이 다르다.
    }
    if (!isRecord(meta) || meta.requestFeedback !== true || typeof meta.updatedAt !== "string") continue;
    const asked = Date.parse(meta.updatedAt);
    if (Number.isFinite(asked) && (!best || asked > best.asked)) best = { name: name.slice(0, -".metadata.json".length), asked };
  }
  if (!best) return undefined;
  const path = join(dir, best.name);
  const at = await mtimeOf(path);
  return at === undefined ? undefined : { path, at, asked: best.asked };
}

export interface ArtifactText {
  /** 파일 이름. */
  name: string;
  text: string;
  /** 고쳐진 시각(ms). */
  at: number;
}

/** dir 바로 아래의 .md 만 읽는다. */
export async function readArtifact(dir: string, path: string): Promise<ArtifactText | undefined> {
  const full = resolve(path);
  if (dirname(full) !== resolve(dir) || !full.endsWith(".md") || basename(full).startsWith(".")) return undefined;
  const at = await mtimeOf(full);
  if (at === undefined) return undefined;
  try {
    return { name: basename(full), text: await readFile(full, "utf8"), at };
  } catch {
    return undefined;
  }
}
