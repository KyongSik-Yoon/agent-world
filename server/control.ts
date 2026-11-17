// 조작 엔드포인트: 지시·키 입력, 터미널 미러, 스페이스·탭·pane·에이전트 만들기와 닫기.
//
// 여기서부터 이 서버는 "보는 창"이 아니라 터미널에 글자를 넣을 수 있는 통로다. 그래서
//   - 바꾸는 요청은 전부 POST 이고 Origin 이 같은 호스트일 때만 받는다(index.ts 의 guarded),
//   - 대상 id 는 지금 herdr 에 실제로 있는 것만 통과시키고,
//   - 만들 때는 초점을 옮기지 않으며, 묶음 닫기·강제 삭제·저장소 신뢰는 요청이 명시했을 때만 싣는다.
// AGENT_WORLD_READONLY=1 이면 바꾸는 요청을 모두 거절한다.
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import {
  HerdrError,
  herdrAgentKinds,
  herdrClose,
  herdrCreateTab,
  herdrCreateWorkspace,
  herdrCreateWorktree,
  herdrInput,
  herdrPrompt,
  herdrRaw,
  herdrRename,
  herdrScreen,
  herdrSnapshot,
  herdrSplit,
  herdrStartAgent,
  herdrTerm,
  type Kind,
} from "./herdr.ts";
import { MAX_IMAGE_BYTES, MAX_IMAGES, imagePath, saveImage } from "./images.ts";
import { termTheme } from "./termtheme.ts";
import type { World } from "./world.ts";

// herdr 는 화면을 밀어 주지 않아(읽기 요청에만 답한다) 주기적으로 읽어야 한다. 늘 빠르게 읽으면 herdr 에 짐이 되고
// 늘 느리게 읽으면 친 글자가 한참 뒤에 보이므로, 화면이 움직이는 동안과 입력 직후에만 촘촘히 읽는다.
/** 조용한 화면을 읽는 간격. */
const TERM_POLL_MS = 400;
/** 크게 보는 화면이 바뀌고 있는 동안의 간격과, 마지막으로 바뀐 뒤 그 간격을 지키는 시간. 미리보기는 해당 없다. */
const TERM_LIVE_MS = 60;
const TERM_LIVE_FOR_MS = 2000;
/** 입력을 보낸 직후의 간격과 그 시간 — 친 글자가 곧바로 보이게. */
const TERM_ECHO_MS = 25;
const TERM_ECHO_FOR_MS = 600;
const TERM_BACK_POLL_MS = 1500;
const TERM_BACK_ECHO_MS = 150;
/** 이만큼 보낸 것이 없으면 연결이 살아 있다는 표시를 보낸다. */
const TERM_KEEPALIVE_MS = 12_000;
/** 화면을 읽고 있는 pane 은 이 시간 안에 herdr 가 "있다"고 답한 것이다 — 키 입력마다 다시 묻지 않는다. */
const WATCH_FRESH_MS = 1500;
/** 키 입력이 이어지는 동안에는 월드 스냅샷을 다시 만들지 않고, 멎은 뒤에 한 번 만든다. */
const KEYS_REFRESH_MS = 300;
const MAX_BACK_LINES = 2000;
const MAX_TEXT = 200_000;
const AGENT_NAME = /^[a-z][a-z0-9_-]{0,31}$/;
const KINDS = new Set<Kind>(["workspace", "tab", "pane", "agent"]);
/** 붙여넣은 경로를 하네스가 이미지로 바꿔 달 때까지 기다려 주는 시간. */
const IMAGE_ATTACH_MS = 6000;
const IMAGE_MARK = /\[Image #\d+\]/g;

type Handler = (req: Request) => Response | Promise<Response>;
type Body = Record<string, unknown>;

export interface ControlDeps {
  world: World;
  readonly: boolean;
  guarded(handler: Handler): Handler;
  json(body: unknown, status?: number): Response;
  /** 바꾼 결과가 곧바로 화면에 보이도록 스냅샷을 새로 만들어 내보낸다. */
  refresh(): void;
}

class Reject extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

function reject(message: string, status: number): never {
  throw new Reject(message, status);
}

function text(body: Body, key: string, max = 400): string {
  const v = body[key];
  if (v === undefined || v === null) return "";
  if (typeof v !== "string") throw new Reject(`${key} 는 문자열이어야 합니다.`, 400);
  if (v.length > max) throw new Reject(`${key} 가 너무 깁니다.`, 400);
  return v;
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

async function directory(path: string): Promise<string> {
  const full = resolve(expandHome(path.trim()));
  if (!path.trim()) throw new Reject("폴더를 정해 주세요.", 400);
  try {
    if (!(await stat(full)).isDirectory()) throw new Error();
  } catch {
    throw new Reject(`폴더가 없습니다: ${full}`, 400);
  }
  return full;
}

async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** pane 의 화면을 읽고 있는 흐름 하나. */
interface Watcher {
  /** 방금 입력이 들어갔다 — 기다리지 말고 지금 다시 읽는다. */
  poke(): void;
  /** 마지막으로 읽기에 성공한 시각. */
  okAt: number;
}

export function controlRoutes({ world, readonly, guarded, json, refresh }: ControlDeps): Record<string, Record<string, Handler>> {
  const watchers = new Map<string, Set<Watcher>>();
  const poke = (paneId: string): void => watchers.get(paneId)?.forEach((w) => w.poke());
  const watched = (paneId: string): boolean => [...(watchers.get(paneId) ?? [])].some((w) => Date.now() - w.okAt < WATCH_FRESH_MS);
  let keysRefresh: ReturnType<typeof setTimeout> | undefined;

  const need = async (kind: Kind, id: string): Promise<string> => {
    if (!(await world.has(kind, id))) throw new Reject(`지금 herdr 에 없는 대상입니다: ${id || "(비어 있음)"}`, 404);
    return id;
  };

  /** 바꾸는 요청 하나. 본문을 읽고, 실패를 구분할 수 있는 모양으로 돌려준다. */
  const mutate = (run: (body: Body) => Promise<unknown>, after: () => void = refresh): Record<string, Handler> => ({
    POST: guarded(async (req) => {
      if (readonly) return json({ error: "보기 전용으로 띄운 서버입니다(AGENT_WORLD_READONLY=1).", code: "readonly" }, 403);
      let body: Body;
      try {
        body = (await req.json()) as Body;
        if (typeof body !== "object" || body === null) throw new Error();
      } catch {
        return json({ error: "요청 본문이 JSON 이 아닙니다." }, 400);
      }
      try {
        const result = await run(body);
        after();
        return json({ ok: true, ...(typeof result === "object" && result !== null ? result : {}) });
      } catch (e) {
        if (e instanceof Reject) return json({ error: e.message, code: e.code }, e.status);
        if (e instanceof HerdrError) return json({ error: e.message, code: e.code }, 502);
        // 예상하지 못한 실패도 화면이 읽을 수 있는 모양으로 돌려준다.
        console.error("조작 요청 실패:", e);
        return json({ error: `서버 안에서 실패했습니다: ${(e as Error).message}` }, 500);
      }
    }),
  });

  /**
   * 지시를 보낸다. herdr 가 제때 답하지 않은 것은 "못 보냈다"가 아니다 — 늦게라도 들어갔을 수 있어서,
   * 실패로만 알리면 다시 보내 같은 지시가 두 번 들어간다.
   */
  const deliver = async (paneId: string, prompt: string): Promise<void> => {
    try {
      await herdrPrompt(paneId, prompt);
    } catch (e) {
      if (e instanceof HerdrError && e.code === "timeout") {
        throw new Reject("herdr 가 제때 답하지 않았습니다. 지시가 들어갔을 수도 있으니, 다시 보내기 전에 터미널 화면을 확인해 주세요.", 504, "prompt_unconfirmed");
      }
      throw e;
    }
  };

  const herdrDown = (e: unknown): Response => json({ error: (e as Error).message, code: (e as HerdrError).code }, 502);

  return {
    // ── 터미널 미러 ──────────────────────────────────────────────────────────────────────────────
    "/api/term": {
      GET: guarded(async (req) => {
        const url = new URL(req.url);
        const paneId = url.searchParams.get("pane") ?? "";
        const back = Math.min(MAX_BACK_LINES, Math.max(0, Number(url.searchParams.get("back")) || 0));
        // 크게 보는 화면만 흐르는 출력을 촘촘히 따라간다. 종일 열려 있는 미리보기까지 그러면 herdr 를 쉬지 않고 읽게 된다.
        const live = url.searchParams.get("live") === "1";
        try {
          if (!(await world.hasPane(paneId))) return json({ error: "그 pane 은 지금 herdr 에 없습니다." }, 404);
        } catch (e) {
          return herdrDown(e);
        }
        const encoder = new TextEncoder();
        let timer: ReturnType<typeof setTimeout> | undefined;
        let closed = false;
        const watcher: Watcher = { poke: () => {}, okAt: 0 };
        const stop = () => {
          closed = true;
          clearTimeout(timer);
          const set = watchers.get(paneId);
          set?.delete(watcher);
          if (set?.size === 0) watchers.delete(paneId);
        };
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            let last: string[] | undefined;
            let changedAt = 0;
            let pokedAt = 0;
            let sentAt = Date.now();
            let reading = false;
            /** 읽는 도중에 입력이 들어갔다 — 그 읽기는 입력 전의 화면일 수 있으니 끝나자마자 다시 읽는다. */
            let stale = false;
            /** herdr 가 읽기에 답하지 않고 있다 — 화면에 알려 두었고, 다시 읽히면 풀어 준다. */
            let stalled = false;
            const send = (event: string, data: unknown) => {
              sentAt = Date.now();
              controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
            };
            const wait = (): number => {
              const now = Date.now();
              if (back > 0) return now - pokedAt < TERM_ECHO_FOR_MS ? TERM_BACK_ECHO_MS : TERM_BACK_POLL_MS;
              if (now - pokedAt < TERM_ECHO_FOR_MS) return TERM_ECHO_MS;
              return live && now - changedAt < TERM_LIVE_FOR_MS ? TERM_LIVE_MS : TERM_POLL_MS;
            };
            const loop = async (): Promise<void> => {
              if (closed || reading) return;
              clearTimeout(timer);
              reading = true;
              try {
                const screen = (back > 0 ? await herdrTerm(paneId, "recent", back) : await herdrTerm(paneId, "visible")).split(/\r?\n/);
                if (closed) return;
                watcher.okAt = Date.now();
                if (stalled) {
                  stalled = false;
                  send("resumed", {});
                }
                // 달라진 줄만 보낸다. 줄 수가 바뀌었거나 절반 넘게 달라졌으면 통째로 보내는 편이 싸다.
                const diff: Array<[number, string]> = [];
                if (last?.length === screen.length) screen.forEach((line, i) => line !== last![i] && diff.push([i, line]));
                if (!last || last.length !== screen.length || diff.length > screen.length / 2) send("screen", { text: screen.join("\n") });
                else if (diff.length > 0) send("lines", { set: diff });
                else if (Date.now() - sentAt > TERM_KEEPALIVE_MS) {
                  sentAt = Date.now();
                  controller.enqueue(encoder.encode(": keepalive\n\n"));
                }
                if (!last || last.length !== screen.length || diff.length > 0) changedAt = Date.now();
                last = screen;
              } catch (e) {
                if (closed) return;
                // pane 이 닫혔으면 여기서 끝낸다. 그 밖의 실패는 잠깐 쉬었다 다시 읽는다.
                if (e instanceof HerdrError && e.code === "pane_not_found") {
                  send("gone", { error: e.message });
                  stop();
                  controller.close();
                  return;
                }
                // 멈춘 화면을 살아 있는 것으로 보이게 두지 않는다. 연결이 살아 있다는 표시도 여기서 이어 간다.
                if (!stalled) {
                  stalled = true;
                  send("stalled", { error: (e as Error).message });
                } else if (Date.now() - sentAt > TERM_KEEPALIVE_MS) {
                  sentAt = Date.now();
                  controller.enqueue(encoder.encode(": keepalive\n\n"));
                }
              } finally {
                reading = false;
              }
              if (stale) {
                stale = false;
                return loop();
              }
              timer = setTimeout(() => void loop(), wait());
            };
            watcher.poke = () => {
              pokedAt = Date.now();
              if (reading) stale = true;
              else void loop();
            };
            const set = watchers.get(paneId) ?? new Set<Watcher>();
            watchers.set(paneId, set.add(watcher));
            void loop();
          },
          cancel: stop,
        });
        req.signal.addEventListener("abort", stop);
        return new Response(stream, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" } });
      }),
    },

    "/api/term/theme": { GET: guarded(async (req) => json(await termTheme(new URL(req.url).searchParams.get("scheme") === "light" ? "light" : "dark"))) },

    // ── 말 걸기와 키 입력 ────────────────────────────────────────────────────────────────────────
    "/api/image": {
      POST: guarded(async (req) => {
        if (readonly) return json({ error: "보기 전용으로 띄운 서버입니다(AGENT_WORLD_READONLY=1).", code: "readonly" }, 403);
        try {
          if (!(await world.has("agent", new URL(req.url).searchParams.get("pane") ?? ""))) return json({ error: "지금 herdr 에 없는 에이전트입니다." }, 404);
        } catch (e) {
          return herdrDown(e);
        }
        const tooBig = () => json({ error: `이미지가 너무 큽니다(최대 ${MAX_IMAGE_BYTES / 1024 / 1024}MB).`, code: "too_large" }, 413);
        if (Number(req.headers.get("content-length") ?? 0) > MAX_IMAGE_BYTES) return tooBig();
        const bytes = new Uint8Array(await req.arrayBuffer());
        if (bytes.length > MAX_IMAGE_BYTES) return tooBig();
        let id: string | null;
        try {
          id = await saveImage(bytes);
        } catch (e) {
          return json({ error: `이미지를 저장하지 못했습니다: ${(e as Error).message}` }, 500);
        }
        return id ? json({ ok: true, id }) : json({ error: "PNG·JPEG·GIF·WebP 이미지만 붙일 수 있습니다.", code: "not_image" }, 415);
      }),
    },
    "/api/prompt": mutate(async (body) => {
      const paneId = await need("agent", text(body, "paneId"));
      const prompt = text(body, "text", MAX_TEXT);
      const ids = Array.isArray(body.images) ? body.images : [];
      if (ids.length > MAX_IMAGES) throw new Reject(`이미지는 한 번에 ${MAX_IMAGES}장까지 보낼 수 있습니다.`, 400);
      const images: string[] = [];
      for (const id of ids) images.push((typeof id === "string" && (await imagePath(id))) || reject("붙인 이미지를 찾지 못했습니다. 다시 붙여 주세요.", 400));
      if (!prompt.trim() && images.length === 0) throw new Reject("보낼 말이 비어 있습니다.", 400);
      if (images.length === 0) await deliver(paneId, prompt);
      else {
        const pane = (await herdrSnapshot()).agents.find((p) => p.pane_id === paneId);
        // 질문에 막혀 있으면 붙여넣은 경로가 대화상자로 들어간다. agent.prompt 가 거절하는 것과 같은 이유로 먼저 막는다.
        if (pane?.agent_status === "blocked") throw new Reject("에이전트가 질문에 대한 답을 기다리는 중입니다.", 409, "agent_blocked");
        if (pane?.agent === "claude") {
          // Claude Code 는 경로만 붙여넣으면 그 파일을 읽어 [Image #N] 으로 단다. 새 번호가 장수만큼 보인 뒤에만 보낸다 —
          // 붙지 않았다면 입력창이 아닌 무언가(herdr 가 못 알아본 대화상자 등)가 떠 있는 것이라, Enter 가 엉뚱한 것을 누른다.
          const marks = async () => new Set((await herdrScreen(paneId)).match(IMAGE_MARK) ?? []);
          const before = await marks();
          for (const path of images) await herdrInput(paneId, path, undefined);
          let attached = false;
          for (const until = Date.now() + IMAGE_ATTACH_MS; !attached && Date.now() < until; ) {
            await Bun.sleep(120);
            attached = [...(await marks())].filter((m) => !before.has(m)).length >= images.length;
          }
          if (!attached) throw new Reject("이미지가 에이전트 입력창에 붙지 않았습니다. 터미널 화면을 확인해 주세요.", 409, "image_not_attached");
          if (prompt.trim()) await deliver(paneId, prompt);
          else await herdrInput(paneId, undefined, ["enter"]);
        } else {
          // 그 밖의 하네스는 경로를 글에 실어 보낸다 — 에이전트가 제 도구로 파일을 연다.
          await deliver(paneId, [prompt.trim(), ...images].filter(Boolean).join("\n"));
        }
      }
      // 지시를 보냈으면 그 전의 완료는 읽은 것이다.
      world.markSeen(paneId, false);
      poke(paneId);
    }),
    "/api/keys": mutate(
      async (body) => {
        const paneId = text(body, "paneId");
        // 화면을 읽고 있는 pane 이면 herdr 에 있는지 다시 묻지 않는다 — 글자마다 묻는 만큼 입력이 늦어진다.
        // 그 사이에 닫혔다면 herdr 가 pane_not_found 로 거절한다.
        if (!watched(paneId)) await need("pane", paneId);
        const input = text(body, "text", MAX_TEXT);
        const keys = Array.isArray(body.keys) ? body.keys : [];
        if (keys.length > 64 || keys.some((k) => typeof k !== "string" || k.length === 0 || k.length > 32)) throw new Reject("keys 가 올바르지 않습니다.", 400);
        if (!input && keys.length === 0) throw new Reject("보낼 입력이 없습니다.", 400);
        // raw 는 제어 문자·이스케이프 시퀀스를 그대로 넣을 때 쓴다(herdr 에 논리 키가 없는 Home, PageUp 등).
        if (body.raw === true) await herdrRaw(paneId, input);
        else await herdrInput(paneId, input || undefined, keys as string[]);
        poke(paneId);
      },
      () => {
        clearTimeout(keysRefresh);
        keysRefresh = setTimeout(refresh, KEYS_REFRESH_MS);
      },
    ),
    "/api/seen": mutate(async (body) => {
      const paneId = await need("pane", text(body, "paneId"));
      return { seen: world.markSeen(paneId, body.undo === true) };
    }),

    // ── 만들기 ───────────────────────────────────────────────────────────────────────────────────
    "/api/workspace": mutate(async (body) => herdrCreateWorkspace(await directory(text(body, "cwd", 4096)), text(body, "label").trim() || undefined)),
    "/api/worktree": mutate(async (body) => {
      const workspaceId = text(body, "workspaceId");
      const cwd = text(body, "cwd", 4096);
      return herdrCreateWorktree({
        workspaceId: workspaceId ? await need("workspace", workspaceId) : undefined,
        cwd: workspaceId ? undefined : await directory(cwd),
        branch: text(body, "branch").trim() || undefined,
        base: text(body, "base").trim() || undefined,
        label: text(body, "label").trim() || undefined,
        trust: body.trust === true,
      });
    }),
    "/api/tab": mutate(async (body) => herdrCreateTab(await need("workspace", text(body, "workspaceId")), text(body, "label").trim() || undefined)),
    "/api/pane/split": mutate(async (body) => {
      const direction = body.direction === "down" ? "down" : "right";
      return herdrSplit(await need("pane", text(body, "paneId")), direction);
    }),
    "/api/agent/start": mutate(async (body) => {
      const paneId = await need("pane", text(body, "paneId"));
      const kind = text(body, "kind", 40);
      const name = text(body, "name", 40);
      if (!/^[a-z][a-z0-9_-]*$/.test(kind)) throw new Reject("에이전트 종류가 올바르지 않습니다.", 400);
      if (!AGENT_NAME.test(name)) throw new Reject("이름은 영문 소문자로 시작하고 소문자·숫자·-·_ 만 32자까지 쓸 수 있습니다.", 400);
      const args = Array.isArray(body.args) ? body.args : [];
      if (args.length > 32 || args.some((a) => typeof a !== "string" || a.length > 2000)) throw new Reject("args 가 올바르지 않습니다.", 400);
      await herdrStartAgent(paneId, kind, name, args as string[]);
    }),

    // ── 관리 ─────────────────────────────────────────────────────────────────────────────────────
    "/api/rename": mutate(async (body) => {
      const kind = text(body, "kind") as Kind;
      if (!KINDS.has(kind)) throw new Reject("kind 가 올바르지 않습니다.", 400);
      const label = text(body, "label", 120).trim();
      if (kind === "agent" && label && !AGENT_NAME.test(label)) throw new Reject("에이전트 이름은 영문 소문자로 시작하고 소문자·숫자·-·_ 만 쓸 수 있습니다.", 400);
      if ((kind === "workspace" || kind === "tab") && !label) throw new Reject("이름이 비어 있습니다.", 400);
      await herdrRename(kind, await need(kind, text(body, "id")), label);
    }),
    "/api/close": mutate(async (body) => {
      const kind = text(body, "kind") as Kind;
      if (!KINDS.has(kind) || kind === "agent") throw new Reject("kind 가 올바르지 않습니다.", 400);
      await herdrClose(kind, await need(kind, text(body, "id")), {
        group: body.group === true,
        removeWorktree: body.removeWorktree === true,
        force: body.force === true,
      });
    }),

    // ── 폼에 쓰는 읽기 전용 목록 ─────────────────────────────────────────────────────────────────
    "/api/kinds": {
      GET: guarded(async () => {
        try {
          const kinds = (await herdrAgentKinds()).map((kind) => ({ kind, installed: Bun.which(kind) !== null }));
          return json({ kinds: kinds.sort((a, b) => Number(b.installed) - Number(a.installed)) });
        } catch (e) {
          return json({ error: (e as Error).message }, 502);
        }
      }),
    },
    "/api/dirs": {
      GET: guarded(async (req) => {
        const prefix = new URL(req.url).searchParams.get("prefix") ?? "";
        const home = homedir();
        const short = (p: string) => (p === home ? "~" : p.startsWith(`${home}/`) ? `~/${p.slice(home.length + 1)}` : p);
        if (!prefix.trim()) {
          // 아직 아무것도 치지 않았으면 지금 쓰고 있는 폴더들을 권한다.
          const seen = new Set<string>();
          try {
            const snap = await herdrSnapshot();
            for (const ws of snap.workspaces) if (ws.worktree) seen.add((ws.worktree as { repo_root?: string }).repo_root ?? "");
            for (const pane of snap.panes) if (pane.cwd) seen.add(pane.cwd);
          } catch {
            // herdr 가 없으면 권할 것이 없다.
          }
          seen.delete("");
          return json({ dirs: [...seen].filter((p) => !p.includes("/.herdr/worktrees/")).sort().slice(0, 30).map(short) });
        }
        const full = resolve(expandHome(prefix));
        // 홈 밖은 훑지 않는다 — 폴더 이름을 알려 주는 창구이므로 범위를 좁게 둔다.
        if (full !== home && !full.startsWith(`${home}/`)) return json({ dirs: [] });
        const [dir, head] = prefix.endsWith("/") ? [full, ""] : [dirname(full), basename(full)];
        let names: string[];
        try {
          names = await readdir(dir);
        } catch {
          return json({ dirs: [] });
        }
        const hits = names.filter((n) => n.toLowerCase().startsWith(head.toLowerCase()) && (head.startsWith(".") || !n.startsWith("."))).sort();
        const dirs: string[] = [];
        for (const name of hits) {
          if (dirs.length >= 30) break;
          if (await isDir(join(dir, name))) dirs.push(short(join(dir, name)));
        }
        return json({ dirs });
      }),
    },
  };
}
