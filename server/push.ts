// 화면을 닫아 둔 동안의 알림(Web Push).
//
// 휴대폰은 앱을 내리면 페이지를 얼려서, 화면이 스스로 띄우는 알림은 오지 않는다. 그래서 상태가 바뀐 것을 서버가 보고
// 브라우저 회사의 푸시 서버(Chrome 은 FCM, Safari 는 APNs)에 맡긴다. 맡기는 글은 그 브라우저만 풀 수 있게 잠가서
// 보내므로(RFC 8291), 중간의 푸시 서버는 내용을 읽지 못한다. 서명(VAPID, RFC 8292)과 잠그기는 node:crypto 로 직접 한다.
//
// 일은 상태가 바뀐 순간에만 한다. 구독한 브라우저가 없으면 스냅샷을 들여다보지도 않는다.
import { createCipheriv, createECDH, createPrivateKey, hkdfSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { AgentStatus, AgentView, WorldSnapshot } from "../shared/types.ts";
import { herdrSessionTag } from "./herdr.ts";
import { ensureStateDir, stateDir, writePrivate } from "./key.ts";
import { L, say, type Lang, type Text } from "./text.ts";

/** 브라우저가 건네준 구독: 보낼 주소와, 그 브라우저만 풀 수 있게 잠그는 데 쓰는 두 값. */
export interface PushTarget {
  endpoint: string;
  p256dh: string;
  auth: string;
  lang: Lang;
}

/** 한 서버가 기억하는 구독 수. 이 사용자의 기기 몇 대면 충분하다. */
const MAX_TARGETS = 20;
/** 푸시 서버가 기기에 닿지 못할 때 붙들어 두는 시간(초). 한 시간 지난 "확인 필요"는 이미 늦었다. */
const TTL_S = 3600;
const SEND_TIMEOUT_MS = 10_000;
/**
 * "이 기기 앞에 사람이 있다"는 소식을 믿는 시간. 화면은 있는 동안 1분마다 다시 알리므로, 이만큼 끊기면
 * 브라우저가 죽었거나 기기가 잠든 것으로 보고 잊는다 — 잊으면 다시 모든 기기로 보낸다.
 */
const PRESENCE_MS = 200_000;
/**
 * 앞에 있는 기기로만 보낸 알림을 들고 있는 시간. 자리를 뜬 뒤에도 화면은 몇 분 동안 "있다"고 하므로(입력 없이 지켜보는
 * 동안을 봐주느라), 그사이 온 알림은 "없음"이 되는 순간 다른 기기로도 보낸다 — 그때도 상태가 그대로일 때만.
 */
const HOLD_MS = 7 * 60_000;
/** 서명한 표의 수명. 푸시 서버는 24시간까지만 받는다. */
const TOKEN_S = 12 * 3600;
/**
 * 푸시 서버가 이 보낸이에게 연락할 곳. 표준이 요구하는 칸이고(Apple 은 없으면 거절한다), 사람의 주소 대신
 * 이 프로그램의 홈페이지를 적는다.
 */
const CONTACT = "https://agent-world.ksyoon.com";

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");
const unb64 = (text: string): Buffer => Buffer.from(text, "base64url");

// ── 보낸이의 열쇠(VAPID) ─────────────────────────────────────────────────────────────────────

interface Vapid {
  /** 브라우저가 구독할 때 받아 가는 공개 열쇠(P-256 점, 65바이트). */
  publicKey: string;
  key: KeyObject;
}

let vapid: Promise<Vapid> | undefined;

/**
 * 보낸이의 열쇠. 접속 열쇠처럼 사용자에게 하나고, 없으면 만든다. 구독은 이 열쇠에 묶이므로, 지우면
 * (`rm ~/.local/state/agent-world/vapid.json`) 기기마다 알림을 다시 켜야 한다.
 */
function vapidKeys(): Promise<Vapid> {
  vapid ??= (async () => {
    const path = join(await ensureStateDir(), "vapid.json");
    const open = (saved: { publicKey: string; privateKey: string }): Vapid => {
      const point = unb64(saved.publicKey);
      if (point.length !== 65) throw new Error("bad key");
      const jwk = { kty: "EC", crv: "P-256", d: saved.privateKey, x: b64(point.subarray(1, 33)), y: b64(point.subarray(33)) };
      return { publicKey: saved.publicKey, key: createPrivateKey({ key: jwk, format: "jwk" }) };
    };
    const read = async (): Promise<Vapid> => open(JSON.parse(await readFile(path, "utf8")) as { publicKey: string; privateKey: string });
    try {
      return await read();
    } catch {
      // 아직 없거나 읽을 수 없다 — 새로 만든다.
    }
    const pair = createECDH("prime256v1");
    pair.generateKeys();
    // 비밀 값은 앞자리가 0 이면 짧게 나올 수 있다. 늘 32바이트로 맞춘다.
    const secret = Buffer.concat([Buffer.alloc(32), pair.getPrivateKey()]).subarray(-32);
    const fresh = { publicKey: b64(pair.getPublicKey()), privateKey: b64(secret) };
    try {
      // 동시에 뜬 다른 서버가 먼저 만들었으면 그것을 쓴다(wx: 이미 있으면 실패).
      await writeFile(path, JSON.stringify(fresh), { mode: 0o600, flag: "wx" });
      return open(fresh);
    } catch {
      try {
        return await read();
      } catch {
        // 있던 파일이 깨져 있었다 — 덮어쓴다.
        await writePrivate(path, JSON.stringify(fresh));
        return open(fresh);
      }
    }
  })();
  return vapid;
}

export async function pushPublicKey(): Promise<string> {
  return (await vapidKeys()).publicKey;
}

/** 푸시 서버마다 한 장씩 서명해 두고 수명이 남은 동안 다시 쓴다 — 보낼 때마다 서명하지 않는다. */
const tokens = new Map<string, { token: string; until: number }>();

function tokenFor(audience: string, keys: Vapid): string {
  const now = Math.floor(Date.now() / 1000);
  const kept = tokens.get(audience);
  if (kept && kept.until - now > 3600) return kept.token;
  const part = (value: unknown): string => b64(Buffer.from(JSON.stringify(value)));
  const head = `${part({ typ: "JWT", alg: "ES256" })}.${part({ aud: audience, exp: now + TOKEN_S, sub: CONTACT })}`;
  const token = `${head}.${b64(sign("sha256", Buffer.from(head), { key: keys.key, dsaEncoding: "ieee-p1363" }))}`;
  tokens.set(audience, { token, until: now + TOKEN_S });
  return token;
}

// ── 잠그기(RFC 8291, aes128gcm) ──────────────────────────────────────────────────────────────

/** 그 브라우저만 풀 수 있게 잠근 본문. 보낼 때마다 새 열쇠 쌍과 새 소금을 쓴다. */
export function seal(target: Pick<PushTarget, "p256dh" | "auth">, plain: Uint8Array): Buffer {
  const theirs = unb64(target.p256dh);
  const pair = createECDH("prime256v1");
  pair.generateKeys();
  const ours = pair.getPublicKey();
  const shared = pair.computeSecret(theirs);
  const ikm = Buffer.from(hkdfSync("sha256", shared, unb64(target.auth), Buffer.concat([Buffer.from("WebPush: info\0"), theirs, ours]), 32));
  const salt = randomBytes(16);
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, "Content-Encoding: aes128gcm\0", 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, "Content-Encoding: nonce\0", 12));
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  // 본문 끝의 0x02 는 "이것이 마지막 조각"이라는 표시다.
  const sealed = Buffer.concat([cipher.update(plain), cipher.update(Buffer.from([2])), cipher.final(), cipher.getAuthTag()]);
  const head = Buffer.alloc(21);
  salt.copy(head, 0);
  head.writeUInt32BE(4096, 16);
  head.writeUInt8(ours.length, 20);
  return Buffer.concat([head, ours, sealed]);
}

// ── 구독 ─────────────────────────────────────────────────────────────────────────────────────

/**
 * 구독 파일은 서버마다 따로 둔다. 구독은 브라우저가 연 주소(포트)에 묶이는데, 같은 herdr 에 조작용과 보기 전용 서버가
 * 함께 붙을 수 있어서 한 파일을 같이 쓰면 같은 알림이 두 번 나간다.
 */
function storePath(readonly: boolean): string {
  const tag = herdrSessionTag();
  return join(stateDir(), `push${tag ? `-${tag}` : ""}${readonly ? "-readonly" : ""}.json`);
}

/** 브라우저가 건넨 구독이 제 모양인지 보고 고른다. 아니면 null. */
export function asTarget(given: unknown, lang: Lang): PushTarget | null {
  const sub = given as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } } | null;
  const endpoint = sub?.endpoint;
  const p256dh = sub?.keys?.p256dh;
  const auth = sub?.keys?.auth;
  if (typeof endpoint !== "string" || typeof p256dh !== "string" || typeof auth !== "string" || endpoint.length > 2048) return null;
  try {
    // 푸시 서버는 늘 https 다. 그 밖의 주소로는 보내지 않는다.
    if (new URL(endpoint).protocol !== "https:") return null;
  } catch {
    return null;
  }
  const point = unb64(p256dh);
  if (point.length !== 65 || point[0] !== 4 || unb64(auth).length !== 16) return null;
  return { endpoint, p256dh, auth, lang };
}

const STATUS_TEXT: Partial<Record<AgentStatus, Text>> = {
  blocked: L("확인 필요", "Needs input"),
  done: L("완료", "Done"),
};

function firstLine(text: string | undefined, max: number): string {
  const line = (text ?? "")
    .split("\n")
    .map((l) => l.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/[*`]|^#+\s*|^>\s*/g, "").replace(/\s+/g, " ").trim())
    .find((l) => l);
  if (!line) return "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** 알림 한 장에 적을 글. 확인 필요면 무엇을 기다리는지, 완료면 마지막 응답의 첫 줄을 함께 싣는다. */
function message(a: AgentView, lang: Lang): { id: string; title: string; body: string } {
  const where = a.workspaceNumber ? `${a.workspaceNumber} · ${a.workspaceLabel}` : a.workspaceLabel;
  let what = "";
  if (a.status === "blocked" && a.pending) {
    const line = firstLine(a.pending.questions?.[0]?.question || a.pending.detail, 120);
    what = a.pending.asksUser ? line : `${a.pending.tool}${line ? ` · ${line}` : ""}`;
  } else if (a.status === "done") what = firstLine(a.lastReply, 120);
  return { id: a.id, title: `${say(STATUS_TEXT[a.status] ?? "", lang)} · ${a.title}`, body: [where, what].filter(Boolean).join("\n") };
}

export class Pusher {
  private targets = new Map<string, PushTarget>();
  private loaded: Promise<void> | undefined;
  private writing: Promise<void> = Promise.resolve();
  /** 사람이 앞에 있다고 알려 온 구독과, 그 소식을 믿을 시각. */
  private present = new Map<string, number>();
  /** 앞에 있는 기기로만 보낸 알림: 에이전트별로 그때의 상태·글·받은 구독. */
  private held = new Map<string, { status: AgentStatus; agent: AgentView; sentTo: Set<string>; at: number }>();
  /** 직전 스냅샷의 상태. 구독이 없는 동안에는 비워 둔다. */
  private last = new Map<string, AgentStatus>();
  private primed = false;

  constructor(private readonly readonly: boolean) {}

  /** 적어 둔 구독을 읽는다(서버를 다시 띄워도 알림이 이어지게). 처음 한 번만 읽는다. */
  load(): Promise<void> {
    this.loaded ??= (async () => {
      try {
        const saved = JSON.parse(await readFile(storePath(this.readonly), "utf8")) as unknown[];
        for (const one of saved) {
          const item = one as Partial<PushTarget>;
          const target = asTarget({ endpoint: item.endpoint, keys: { p256dh: item.p256dh, auth: item.auth } }, item.lang === "en" ? "en" : "ko");
          if (target) this.targets.set(target.endpoint, target);
        }
      } catch {
        // 아직 구독이 없다.
      }
    })();
    return this.loaded;
  }

  async add(target: PushTarget): Promise<void> {
    await this.load();
    const kept = this.targets.get(target.endpoint);
    if (kept && kept.p256dh === target.p256dh && kept.auth === target.auth && kept.lang === target.lang) return;
    // 같은 주소는 새것으로 바꾸고, 자리가 차면 가장 오래된 것부터 내보낸다.
    this.targets.delete(target.endpoint);
    this.targets.set(target.endpoint, target);
    while (this.targets.size > MAX_TARGETS) this.targets.delete(this.targets.keys().next().value!);
    this.save();
  }

  async remove(endpoint: string): Promise<void> {
    await this.load();
    this.present.delete(endpoint);
    if (this.targets.delete(endpoint)) this.save();
  }

  /** 그 구독의 기기 앞에 사람이 있는지 적는다. 모르는 구독이면 false 를 돌려준다. */
  async setPresent(endpoint: string, on: boolean, now = Date.now()): Promise<boolean> {
    await this.load();
    if (!this.targets.has(endpoint)) return false;
    if (on) this.present.set(endpoint, now + PRESENCE_MS);
    else this.present.delete(endpoint);
    return true;
  }

  /**
   * 이번 알림을 받을 구독. 사람이 앞에 있는 기기가 있으면 그 기기만 — PC 를 쓰는 동안 휴대폰·워치까지 울리지 않게.
   * 그런 기기가 없거나 소식이 끊겼으면 모두에게 보낸다(모를 때는 보낸다).
   */
  recipients(now = Date.now()): PushTarget[] {
    const here = this.presentTargets(now);
    return here.length > 0 ? here : [...this.targets.values()];
  }

  private presentTargets(now: number): PushTarget[] {
    const here: PushTarget[] = [];
    for (const [endpoint, until] of this.present) {
      const target = this.targets.get(endpoint);
      if (!target || until <= now) this.present.delete(endpoint);
      else here.push(target);
    }
    return here;
  }

  /** 앞에 있던 기기가 모두 "없음"이 됐으면, 그 기기로만 보냈던 알림 중 아직 상태가 그대로인 것을 나머지 기기로 보낸다. */
  private release(status: Map<string, AgentStatus>, now: number): void {
    if (this.held.size === 0) return;
    const away = this.presentTargets(now).length === 0;
    for (const [id, h] of this.held) {
      if (status.get(id) !== h.status || now - h.at > HOLD_MS) this.held.delete(id);
      else if (away) {
        for (const target of this.targets.values()) if (!h.sentTo.has(target.endpoint)) void this.send(target, message(h.agent, target.lang));
        this.held.delete(id);
      }
    }
  }

  private save(): void {
    const body = JSON.stringify([...this.targets.values()]);
    this.writing = this.writing
      .then(async () => {
        const path = storePath(this.readonly);
        const tmp = `${path}.${process.pid}.tmp`;
        await writePrivate(tmp, body);
        await rename(tmp, path);
      })
      .catch((e) => console.error(say(L("알림 구독 저장 실패:", "Could not save the push subscriptions:")), e));
  }

  /**
   * 새 스냅샷을 직전 것과 견줘, 완료나 확인 필요로 바뀐 에이전트를 알린다. 화면의 알림과 같은 규칙이다 —
   * 처음 본 스냅샷과 처음 보는 에이전트는 알리지 않는다. 보내는 일은 기다리지 않는다.
   */
  observe(snapshot: WorldSnapshot): void {
    if (this.targets.size === 0) {
      // 구독이 없으면 아무것도 하지 않는다. 다시 생기면 그때의 스냅샷이 기준이 된다.
      if (this.primed) {
        this.last.clear();
        this.held.clear();
        this.primed = false;
      }
      return;
    }
    const now = new Map<string, AgentStatus>();
    const at = Date.now();
    let to: PushTarget[] | undefined;
    for (const a of snapshot.agents) {
      now.set(a.id, a.status);
      const before = this.last.get(a.id);
      if (!this.primed || before === undefined || before === a.status || (a.status !== "blocked" && a.status !== "done") || a.compacted) continue;
      to ??= this.recipients(at);
      for (const target of to) void this.send(target, message(a, target.lang));
      if (to.length < this.targets.size) this.held.set(a.id, { status: a.status, agent: a, sentTo: new Set(to.map((t) => t.endpoint)), at });
      else this.held.delete(a.id);
    }
    this.release(now, at);
    this.last = now;
    this.primed = true;
  }

  private async send(target: PushTarget, payload: unknown): Promise<void> {
    try {
      const keys = await vapidKeys();
      const res = await fetch(target.endpoint, {
        method: "POST",
        headers: {
          "content-encoding": "aes128gcm",
          "content-type": "application/octet-stream",
          ttl: String(TTL_S),
          urgency: "high",
          authorization: `vapid t=${tokenFor(new URL(target.endpoint).origin, keys)}, k=${keys.publicKey}`,
        },
        body: new Uint8Array(seal(target, Buffer.from(JSON.stringify(payload)))),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
      // 브라우저가 구독을 버렸다(알림을 껐거나 앱을 지웠다) — 더 보내지 않는다.
      if (res.status === 404 || res.status === 410) {
        if (this.targets.get(target.endpoint) === target && this.targets.delete(target.endpoint)) {
          this.present.delete(target.endpoint);
          this.save();
        }
      } else if (!res.ok) console.error(say(L("알림을 보내지 못했습니다:", "Could not send the push notification:")), res.status, (await res.text()).slice(0, 200));
    } catch (e) {
      console.error(say(L("알림을 보내지 못했습니다:", "Could not send the push notification:")), (e as Error).message);
    }
  }
}
