// 접속 열쇠와, 이 사용자만 읽는 상태 파일.
//
// 이 서버는 터미널 화면을 내보내고 터미널에 글자를 넣는다. "127.0.0.1 로 들어왔으니 내 브라우저"라고만 믿으면 같은 PC 의
// 다른 계정이나, tailscale serve 뒤에서 Host 를 꾸며 보낸 다른 기기도 같은 일을 할 수 있다. 그래서 열쇠를 하나 만들어
// 이 사용자만 읽는 파일에 두고, 모든 /api 요청에 그 열쇠를 요구한다. 브라우저는 열쇠가 붙은 주소(`…/#k=열쇠`)로 한 번 열면
// 기억한다. 열쇠는 주소의 # 뒤에 실어 서버로도, 다른 사이트로도 나가지 않게 한다.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** 이 사용자의 Agent World 가 상태를 적어 두는 폴더. */
export function stateDir(): string {
  return join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "agent-world");
}

/** 상태 폴더를 이 사용자만 들어올 수 있게 만든다(이미 있으면 권한을 고친다). */
export async function ensureStateDir(): Promise<string> {
  const dir = stateDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700).catch(() => {});
  return dir;
}

/** 이 사용자만 읽고 쓰는 파일로 적는다. */
export async function writePrivate(path: string, body: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, body, { mode: 0o600 });
  // 이미 있던 파일은 writeFile 의 mode 가 듣지 않는다.
  await chmod(path, 0o600).catch(() => {});
}

function keyFile(): string {
  return join(stateDir(), "key");
}

/**
 * 접속 열쇠. 없으면 만든다. herdr 세션마다가 아니라 사용자에게 하나다 — 서버를 다시 띄워도, 세션이 여럿이어도
 * 한 번 기억한 브라우저는 그대로 쓴다. 지우면(`rm ~/.local/state/agent-world/key`) 다음에 뜰 때 새로 만들어진다.
 */
export async function accessKey(): Promise<string> {
  await ensureStateDir();
  try {
    const kept = (await readFile(keyFile(), "utf8")).trim();
    if (/^[0-9a-f]{32,}$/.test(kept)) {
      await chmod(keyFile(), 0o600).catch(() => {});
      return kept;
    }
  } catch {
    // 아직 없다.
  }
  const fresh = randomBytes(24).toString("hex");
  try {
    // 동시에 뜬 다른 서버가 먼저 만들었으면 그것을 쓴다(wx: 이미 있으면 실패).
    await writeFile(keyFile(), `${fresh}\n`, { mode: 0o600, flag: "wx" });
    return fresh;
  } catch {
    return (await readFile(keyFile(), "utf8")).trim();
  }
}

/** 이미 만들어 둔 열쇠. 없으면 null — 열쇠를 만드는 것은 서버뿐이다. */
export async function existingKey(): Promise<string | null> {
  try {
    const kept = (await readFile(keyFile(), "utf8")).trim();
    return /^[0-9a-f]{32,}$/.test(kept) ? kept : null;
  } catch {
    return null;
  }
}

/** 받은 열쇠가 맞는지. 걸린 시간으로 열쇠가 새지 않게 길이가 같을 때만 통째로 견준다. */
export function keyMatches(given: string | null | undefined, key: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(key);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * "나는 이 열쇠를 가진 Agent World 다"라는 증명. 같은 포트를 다른 계정이 차지하고 Agent World 인 척해도,
 * 열쇠를 모르면 이 값을 만들지 못한다. nonce 는 묻는 쪽이 그때그때 짓는다.
 */
export function proofOf(key: string, nonce: string, socket: string): string {
  return createHmac("sha256", key).update(`${nonce}\n${socket}`).digest("hex");
}

/** 열쇠가 붙은 주소. 열쇠는 # 뒤에 둔다 — 서버 기록에도, 다른 사이트로 가는 Referer 에도 실리지 않는다. */
export function keyedUrl(base: string, key: string): string {
  return `${base.replace(/\/$/, "")}/#k=${key}`;
}
