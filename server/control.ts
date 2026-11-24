// 조작 엔드포인트: 지시·키 입력, 터미널 미러, 스페이스·탭·pane·에이전트 만들기와 닫기.
//
// 여기서부터 이 서버는 "보는 창"이 아니라 터미널에 글자를 넣을 수 있는 통로다. 그래서
//   - 바꾸는 요청은 전부 POST 이고 Origin 이 같은 호스트일 때만 받는다(index.ts 의 guarded),
//   - 대상 id 는 지금 herdr 에 실제로 있는 것만 통과시키고,
//   - 만들 때는 초점을 옮기지 않으며, 묶음 닫기·강제 삭제·저장소 신뢰는 요청이 명시했을 때만 싣는다.
// AGENT_WORLD_READONLY=1 이면 바꾸는 요청을 모두 거절한다.
import { readdir, realpath, stat } from "node:fs/promises";
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
import { agy } from "./adapters/agy.ts";
import { agyLinesBelow, agyToBottom } from "./agyscroll.ts";
import { AnswerError } from "./asking.ts";
import { claudeComposer, squash } from "./composer.ts";
import { MAX_IMAGE_BYTES, MAX_IMAGES, imagePath, saveImage } from "./images.ts";
import { ModelError, modelCatalog, startFlags, switchModel } from "./models.ts";
import { termTheme } from "./termtheme.ts";
import { L, asText, langOf, say, type Text } from "./text.ts";
import type { World } from "./world.ts";

// herdr 는 화면을 밀어 주지 않아(읽기 요청에만 답한다) 주기적으로 읽어야 한다. 늘 빠르게 읽으면 herdr 에 짐이 되고
// 늘 느리게 읽으면 친 글자가 한참 뒤에 보이므로, 화면이 움직이는 동안과 입력 직후에만 촘촘히 읽는다.
/** 조용한 화면을 읽는 간격. */
const TERM_POLL_MS = 400;
/** 크게 보는 화면이 바뀌고 있는 동안의 간격과, 마지막으로 바뀐 뒤 그 간격을 지키는 시간. 미리보기는 해당 없다. */
const TERM_LIVE_MS = 60;
const TERM_LIVE_FOR_MS = 2000;
/** 휴대폰에서 크게 보는 화면이 바뀌고 있는 동안의 간격. 쉬지 않고 도는 표시(agy 의 진행 표시는 초당 10번 바뀐다)를 60ms 로 따라가면
    화면을 여는 내내 초당 10번 넘게 받고 그리느라 무선과 GPU 가 쉬지 못한다. 친 글자는 TERM_ECHO_MS 가 따로 챙긴다. */
const TERM_CALM_LIVE_MS = 250;
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
/** 지시가 입력창에 나타나고 제출되기까지 기다리는 시간. 막 뜬 Claude 는 시작 10초 안팎에야 입력창을 채우기도 한다. */
const SUBMIT_CHECK_MS = 20_000;
const SUBMIT_POLL_MS = 100;
/** 플랜 승인 키를 보낸 뒤 카드가 내려가기를(desk-plan 이 표식 파일을 지우기를) 기다리는 시간. */
const PLAN_APPROVE_MS = 3_000;
/** 플랜 카드가 내려간 뒤 고칠 점이 세션 로그에 실리기를 기다리는 시간. */
const REVISE_LANDED_MS = 3_000;
/** 플랜 카드의 고칠 점 — 줄 댓글을 원문과 함께 싣는다. 파이프 한 번에 들어가야 한다(asking.ts MAX_ANSWER_BYTES). */
const MAX_REVISE = 16_000;
/** 멈춤 키(Esc)를 보낸 뒤 herdr 가 일하는 중을 벗어나기를 기다리는 시간. 세 하네스 모두 1초 안에 완료로 내려왔다. */
const STOP_SETTLE_MS = 1_500;
/** Claude 의 백그라운드 에이전트를 끄고 기다리는 시간. 끈 소식에 답하는 짧은 턴이 이어질 수 있어 조금 넉넉히 둔다. */
const STOP_AGENTS_MS = 5_000;
/**
 * Claude 의 "백그라운드 에이전트 모두 멈추기"(chat:killAgents). 한 번 누르면 "한 번 더 누르면 멈춘다"는 안내만 뜨고 두 번째에
 * 멈춘다. 돌던 에이전트가 없으면 "No background agents running" 안내만 뜨고 입력창의 글은 그대로다(2.1.328 실측).
 */
const KILL_AGENTS = ["ctrl+x", "ctrl+k", "ctrl+x", "ctrl+k"];
/** Enter 를 누른 뒤 보낸 글이 이만큼 입력창에 남아 있으면 그 Enter 는 버려진 것이다. */
const SUBMIT_STUCK_MS = 1000;
const SUBMIT_PRESSES = 3;
/** 입력창에서 보낸 글을 알아볼 때 견주는 첫 줄의 길이(공백을 뺀 글자 수). */
const SUBMIT_MARK_CHARS = 12;
const PAGE_DOWN = "\x1b[6~";
const CTRL_END = "\x1b[1;5F";
/** 화면이 넘겼다고 알려 오는 쪽 수의 상한. */
const MAX_PAGES = 200;
/** Claude Code 는 긴 붙여넣기를 입력창에 이 표시로 접어 둔다. */
const PASTED_MARK = /\[Pasted text #\d+/;

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
  readonly text: Text;

  constructor(
    message: Text | string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(say(message));
    this.text = asText(message);
  }
}

function reject(message: Text, status: number): never {
  throw new Reject(message, status);
}

const READONLY_TEXT = L("보기 전용으로 띄운 서버입니다(AGENT_WORLD_READONLY=1).", "This server is read-only (AGENT_WORLD_READONLY=1).");
const NOT_JSON = L("요청 본문이 JSON 이 아닙니다.", "The request body is not JSON.");
const NO_PANE = L("그 pane 은 지금 herdr 에 없습니다.", "That pane no longer exists in herdr.");

function text(body: Body, key: string, max = 400): string {
  const v = body[key];
  if (v === undefined || v === null) return "";
  if (typeof v !== "string") throw new Reject(L(`${key} 는 문자열이어야 합니다.`, `${key} must be a string.`), 400);
  if (v.length > max) throw new Reject(L(`${key} 가 너무 깁니다.`, `${key} is too long.`), 400);
  return v;
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

async function directory(path: string): Promise<string> {
  const full = resolve(expandHome(path.trim()));
  if (!path.trim()) throw new Reject(L("폴더를 정해 주세요.", "Choose a folder."), 400);
  try {
    if (!(await stat(full)).isDirectory()) throw new Error();
  } catch {
    throw new Reject(L(`폴더가 없습니다: ${full}`, `No such folder: ${full}`), 400);
  }
  return full;
}

/** 브랜치나 기준 커밋의 이름. `-` 로 시작하면 git 이 선택지로 읽을 수 있어 받지 않는다. */
function gitName(raw: string): string | undefined {
  const name = raw.trim();
  if (name.startsWith("-")) throw new Reject(L(`브랜치 이름은 - 로 시작할 수 없습니다: ${name}`, `A branch name cannot start with -: ${name}`), 400);
  return name || undefined;
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
    if (!(await world.has(kind, id))) throw new Reject(L(`지금 herdr 에 없는 대상입니다: ${id || "(비어 있음)"}`, `No longer in herdr: ${id || "(empty)"}`), 404);
    return id;
  };

  /** 바꾸는 요청 하나. 본문을 읽고, 실패를 구분할 수 있는 모양으로 돌려준다. */
  const mutate = (run: (body: Body) => Promise<unknown>, after: () => void = refresh): Record<string, Handler> => ({
    POST: guarded(async (req) => {
      const lang = langOf(req);
      if (readonly) return json({ error: say(READONLY_TEXT, lang), code: "readonly" }, 403);
      let body: Body;
      try {
        body = (await req.json()) as Body;
        if (typeof body !== "object" || body === null) throw new Error();
      } catch {
        return json({ error: say(NOT_JSON, lang) }, 400);
      }
      try {
        const result = await run(body);
        after();
        return json({ ok: true, ...(typeof result === "object" && result !== null ? result : {}) });
      } catch (e) {
        if (e instanceof Reject || e instanceof ModelError) return json({ error: say(e.text, lang), code: e.code }, e.status);
        if (e instanceof HerdrError) return json({ error: say(e.text, lang), code: e.code }, 502);
        // 예상하지 못한 실패도 화면이 읽을 수 있는 모양으로 돌려준다.
        console.error(say(L("조작 요청 실패:", "Control request failed:")), e);
        return json({ error: say(L(`서버 안에서 실패했습니다: ${(e as Error).message}`, `The server failed: ${(e as Error).message}`), lang) }, 500);
      }
    }),
  });

  /**
   * 질문 카드(desk-look·desk-plan)가 답을 기다리면 지시를 막는다. herdr 는 그 pane 을 working 으로 알아 `agent_blocked` 로
   * 거절해 주지 않는다. 그대로 넣으면 글이 입력창에 차서, 입력창이 비어 있을 때만 받는 카드의 숫자 키가 먹지 않는다.
   * 상태줄을 켠 agy 의 질문·권한 창도 herdr 가 쉬는 것으로 알아 거절하지 않는다 — 지시가 창에 들어가 질문에 답해 버린다.
   */
  const refuseIfAsking = async (paneId: string): Promise<void> => {
    if (await world.waitingOnCard(paneId)) throw new Reject(L("에이전트가 질문에 대한 답을 기다리는 중입니다.", "The agent is waiting for an answer to its question."), 409, "agent_blocked");
  };

  /**
   * 지시를 보낸다. herdr 가 제때 답하지 않은 것은 "못 보냈다"가 아니다 — 늦게라도 들어갔을 수 있어서,
   * 실패로만 알리면 다시 보내 같은 지시가 두 번 들어간다.
   */
  const deliver = async (paneId: string, prompt: string): Promise<void> => {
    await refuseIfAsking(paneId);
    try {
      const pane = (await herdrSnapshot()).agents.find((p) => p.pane_id === paneId);
      if (pane?.agent === "claude") await submitToClaude(paneId, prompt, pane.agent_status);
      else {
        // 위로 넘겨 둔 agy 는 지시를 받아도 그 자리에 머물러, 보낸 지시와 그 답이 pane 화면에도 미리보기에도 안 보인다.
        if (agy.matches(pane?.agent ?? "")) await agyToBottom(paneId).catch(() => {});
        await herdrPrompt(paneId, prompt);
      }
    } catch (e) {
      if (e instanceof HerdrError && e.code === "timeout") {
        throw new Reject(
          L(
            "herdr 가 제때 답하지 않았습니다. 지시가 들어갔을 수도 있으니, 다시 보내기 전에 터미널 화면을 확인해 주세요.",
            "herdr did not answer in time. The prompt may still have gone through — check the terminal before sending it again.",
          ),
          504,
          "prompt_unconfirmed",
        );
      }
      throw e;
    }
  };

  /**
   * Claude Code 에는 herdr 의 agent.prompt 를 쓰지 않는다. 그것은 글을 넣고 잠깐 뒤 Enter 를 누를 뿐이라, 막 뜬 Claude 가
   * 아직 받을 준비가 안 됐으면(herdr 가 idle·interactive_ready 를 알린 뒤에도 몇 초) 글은 나중에 입력창에 채워지고 Enter 는
   * 버려진다 — "ok" 를 받았는데 지시가 입력창에 멈춰 있다(2.1.327, 시작 4초 뒤에 보내면 다섯 번에 한두 번).
   * 그래서 글을 넣고, 입력창에 그 글이 보인 뒤에 Enter 를 누르고, 글이 입력창을 떠났는지 본다. 입력창에 그 글이 보일 때만
   * 누른다 — 다른 것이 떠 있을 때 누르면 그것을 고른다.
   */
  const submitToClaude = async (paneId: string, prompt: string, status: string | undefined): Promise<void> => {
    // agent.prompt 가 해 주던 거절. 질문이 떠 있으면 글이 대화상자로 들어간다.
    if (status === "blocked") throw new Reject(L("에이전트가 질문에 대한 답을 기다리는 중입니다.", "The agent is waiting for an answer to its question."), 409, "agent_blocked");
    const mark = squash(prompt.split("\n").find((l) => l.trim()) ?? "").slice(0, SUBMIT_MARK_CHARS);
    const holds = (box: string | undefined): boolean => box !== undefined && ((mark !== "" && squash(box).includes(mark)) || PASTED_MARK.test(box));
    const composer = async () => claudeComposer(await herdrScreen(paneId));
    const until = Date.now() + SUBMIT_CHECK_MS;
    await herdrInput(paneId, prompt, undefined);
    while (!holds(await composer())) {
      if (Date.now() > until) {
        throw new Reject(
          L("지시가 에이전트의 입력창에 나타나지 않았습니다. 다시 보내기 전에 터미널 화면을 확인해 주세요.", "The prompt did not show up in the agent's input. Check the terminal before sending it again."),
          504,
          "prompt_unconfirmed",
        );
      }
      await Bun.sleep(SUBMIT_POLL_MS);
    }
    for (let press = 1; ; press++) {
      await herdrInput(paneId, undefined, ["enter"]);
      // 입력창을 떠났거나 입력창 자리를 다른 것(명령이 연 선택 목록 등)이 차지했으면 제출된 것이다.
      for (const wait = Date.now() + SUBMIT_STUCK_MS; Date.now() < wait; await Bun.sleep(SUBMIT_POLL_MS)) if (!holds(await composer())) return;
      if (press >= SUBMIT_PRESSES || Date.now() > until) {
        throw new Reject(
          L("지시가 입력창에 들어갔지만 제출되지 않았습니다. 터미널 화면에서 확인해 주세요.", "The prompt is in the agent's input but was not submitted. Check the terminal."),
          504,
          "prompt_unconfirmed",
        );
      }
    }
  };

  const herdrDown = (e: unknown, req: Request): Response =>
    json({ error: e instanceof HerdrError ? say(e.text, langOf(req)) : (e as Error).message, code: (e as HerdrError).code }, 502);

  return {
    // ── 터미널 미러 ──────────────────────────────────────────────────────────────────────────────
    "/api/term": {
      GET: guarded(async (req) => {
        const url = new URL(req.url);
        const paneId = url.searchParams.get("pane") ?? "";
        const back = Math.min(MAX_BACK_LINES, Math.max(0, Number(url.searchParams.get("back")) || 0));
        // 크게 보는 화면만 흐르는 출력을 촘촘히 따라간다. 종일 열려 있는 미리보기까지 그러면 herdr 를 쉬지 않고 읽게 된다.
        const live = url.searchParams.get("live") === "1";
        const liveMs = url.searchParams.get("calm") === "1" ? TERM_CALM_LIVE_MS : TERM_LIVE_MS;
        try {
          if (!(await world.hasPane(paneId))) return json({ error: say(NO_PANE, langOf(req)) }, 404);
        } catch (e) {
          return herdrDown(e, req);
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
              return live && now - changedAt < TERM_LIVE_FOR_MS ? liveMs : TERM_POLL_MS;
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

    // 지난 출력이 herdr 에 남는 pane 인지. 전체 화면으로 도는 앱(Claude Code 의 fullscreen 등)은 대체 화면에 그려
    // 스크롤백이 없다 — 그런 pane 은 앱에 PageUp/PageDown 을 보내 앱의 화면을 넘긴다.
    "/api/term/back": {
      GET: guarded(async (req) => {
        const paneId = new URL(req.url).searchParams.get("pane") ?? "";
        try {
          if (!(await world.hasPane(paneId))) return json({ error: say(NO_PANE, langOf(req)) }, 404);
          const visible = (await herdrTerm(paneId, "visible")).split(/\r?\n/).length;
          const recent = (await herdrTerm(paneId, "recent", visible + 1)).split(/\r?\n/).length;
          // 셸처럼 화면이 덜 찬 pane 도 스크롤백이 없을 수 있다 — 넘김 키는 에이전트에게만 보낸다.
          const agent = recent <= visible && !readonly ? (await herdrSnapshot()).agents.find((p) => p.pane_id === paneId)?.agent : undefined;
          // 이미 위로 넘겨져 있는 agy 면 아래에 남은 줄 수 — 화면이 "지금 화면으로"를 띄운다.
          const below = agent && agy.matches(agent) ? agyLinesBelow(await herdrScreen(paneId)) : 0;
          // 휠 신호(SGR 마우스)는 마우스를 받지 않는 앱의 입력창에 글자로 찍힐 수 있다. herdr 는 pane 이 마우스를 켰는지
          // 알려 주지 않아, 실측한 Claude Code 에만 보낸다(전체 화면이면 줄 단위로 굴리고, 아니면 말없이 버린다).
          return json({ scrollback: recent > visible, page: Boolean(agent), wheel: /claude/i.test(agent ?? ""), below });
        } catch (e) {
          return herdrDown(e, req);
        }
      }),
    },
    "/api/term/theme": { GET: guarded(async (req) => json(await termTheme(new URL(req.url).searchParams.get("scheme") === "light" ? "light" : "dark"))) },

    // ── 말 걸기와 키 입력 ────────────────────────────────────────────────────────────────────────
    "/api/image": {
      POST: guarded(async (req) => {
        if (readonly) return json({ error: say(READONLY_TEXT, langOf(req)), code: "readonly" }, 403);
        try {
          if (!(await world.has("agent", new URL(req.url).searchParams.get("pane") ?? ""))) return json({ error: say(L("지금 herdr 에 없는 에이전트입니다.", "That agent no longer exists in herdr."), langOf(req)) }, 404);
        } catch (e) {
          return herdrDown(e, req);
        }
        const tooBig = () =>
          json({ error: say(L(`이미지가 너무 큽니다(최대 ${MAX_IMAGE_BYTES / 1024 / 1024}MB).`, `The image is too large (max ${MAX_IMAGE_BYTES / 1024 / 1024}MB).`), langOf(req)), code: "too_large" }, 413);
        if (Number(req.headers.get("content-length") ?? 0) > MAX_IMAGE_BYTES) return tooBig();
        const bytes = new Uint8Array(await req.arrayBuffer());
        if (bytes.length > MAX_IMAGE_BYTES) return tooBig();
        let id: string | null;
        try {
          id = await saveImage(bytes);
        } catch (e) {
          return json({ error: say(L(`이미지를 저장하지 못했습니다: ${(e as Error).message}`, `Could not save the image: ${(e as Error).message}`), langOf(req)) }, 500);
        }
        return id ? json({ ok: true, id }) : json({ error: say(L("PNG·JPEG·GIF·WebP 이미지만 붙일 수 있습니다.", "Only PNG, JPEG, GIF and WebP images can be attached."), langOf(req)), code: "not_image" }, 415);
      }),
    },
    "/api/prompt": mutate(async (body) => {
      const paneId = await need("agent", text(body, "paneId"));
      const prompt = text(body, "text", MAX_TEXT);
      const ids = Array.isArray(body.images) ? body.images : [];
      if (ids.length > MAX_IMAGES) throw new Reject(L(`이미지는 한 번에 ${MAX_IMAGES}장까지 보낼 수 있습니다.`, `You can send up to ${MAX_IMAGES} images at once.`), 400);
      const images: string[] = [];
      for (const id of ids) images.push((typeof id === "string" && (await imagePath(id))) || reject(L("붙인 이미지를 찾지 못했습니다. 다시 붙여 주세요.", "The attached image is gone. Attach it again."), 400));
      if (!prompt.trim() && images.length === 0) throw new Reject(L("보낼 말이 비어 있습니다.", "There is nothing to send."), 400);
      if (images.length === 0) await deliver(paneId, prompt);
      else {
        const pane = (await herdrSnapshot()).agents.find((p) => p.pane_id === paneId);
        // 질문에 막혀 있으면 붙여넣은 경로가 대화상자로 들어간다. agent.prompt 가 거절하는 것과 같은 이유로 먼저 막는다.
        if (pane?.agent_status === "blocked") throw new Reject(L("에이전트가 질문에 대한 답을 기다리는 중입니다.", "The agent is waiting for an answer to its question."), 409, "agent_blocked");
        await refuseIfAsking(paneId);
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
          if (!attached) throw new Reject(L("이미지가 에이전트 입력창에 붙지 않았습니다. 터미널 화면을 확인해 주세요.", "The image did not attach to the agent's input. Check the terminal."), 409, "image_not_attached");
          if (prompt.trim()) await deliver(paneId, prompt);
          else await herdrInput(paneId, undefined, ["enter"]);
        } else {
          // 그 밖의 하네스는 경로를 글에 실어 보낸다 — 에이전트가 제 도구로 파일을 연다.
          await deliver(paneId, [prompt.trim(), ...images].filter(Boolean).join("\n"));
        }
      }
      // 지시를 보냈으면 그 전의 완료는 읽은 것이다.
      world.markSeen(paneId, false);
      world.promptSent(paneId);
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
        if (keys.length > 64 || keys.some((k) => typeof k !== "string" || k.length === 0 || k.length > 32)) throw new Reject(L("keys 가 올바르지 않습니다.", "keys is not valid."), 400);
        if (!input && keys.length === 0) throw new Reject(L("보낼 입력이 없습니다.", "There is no input to send."), 400);
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
    // 위로 넘겨 둔 앱 화면(스크롤백 없는 에이전트)을 맨 아래로. agy 는 화면의 "↓ N lines" 가 사라질 때까지 내리고(agyscroll.ts),
    // 넘긴 정도를 화면에서 읽을 수 없는 앱은 화면이 넘긴 쪽 수(pages)보다 조금 더 PageDown 을 보낸다. wheel 은 Claude 의 Ctrl+End.
    "/api/term/bottom": mutate(async (body) => {
      const paneId = text(body, "paneId");
      if (!watched(paneId)) await need("pane", paneId);
      if (body.wheel === true) await herdrRaw(paneId, CTRL_END);
      else {
        const agent = (await herdrSnapshot()).agents.find((p) => p.pane_id === paneId)?.agent ?? "";
        const pages = Math.min(MAX_PAGES, Math.max(0, Math.floor(Number(body.pages) || 0)));
        if (agy.matches(agent)) await agyToBottom(paneId);
        else if (pages > 0) await herdrRaw(paneId, PAGE_DOWN.repeat(pages + 2));
      }
      poke(paneId);
    }),
    // 하던 일 멈추기. 키 단추의 Esc 와 달리 지금 일하는 중일 때만 보낸다 — 질문이 떠 있으면 Esc 는 그 질문을 거절한다.
    // Esc 는 세 하네스(Claude·Codex·agy) 모두 지금 턴을 끊는다. 그래도 일하는 중으로 남는 경우가 둘 있다(Claude 2.1.328 실측):
    //   - 일하는 중에 보내 줄 선 지시가 있으면, 끊는 즉시 그 지시로 새 턴을 시작한다 → Esc 를 한 번 더 눌러 그것도 끊는다.
    //     일하는 중의 Esc 라 두 번 눌러도 되감기 창이 뜨지 않는다(쉬고 있을 때의 Esc 두 번이 되감기다).
    //   - 백그라운드 에이전트가 돌면 턴이 끝나도 제목 스피너가 남는다 → 그 에이전트들을 끈다.
    // 사람이 멈춘 것이라 그 뒤의 완료는 알리지 않는다(stopRequested). 멈추지 못했으면 그 표시를 거둔다.
    "/api/stop": mutate(async (body) => {
      const paneId = await need("agent", text(body, "paneId"));
      await refuseIfAsking(paneId);
      const agent = async () => (await herdrSnapshot()).agents.find((p) => p.pane_id === paneId);
      const now = await agent();
      if (now?.agent_status === "blocked") throw new Reject(L("에이전트가 질문에 대한 답을 기다리는 중입니다.", "The agent is waiting for an answer to its question."), 409, "agent_blocked");
      const working = now?.agent_status === "working";
      if (!working && !world.holding(paneId)) throw new Reject(L("지금 하는 일이 없습니다. 이미 끝났을 수 있습니다.", "It is not working on anything. It may already have finished."), 409, "not_working");
      world.stopRequested(paneId, now?.state_change_seq ?? 0, working);
      const settled = async (ms: number): Promise<boolean> => {
        for (const until = Date.now() + ms; ; await Bun.sleep(SUBMIT_POLL_MS)) {
          if ((await agent())?.agent_status !== "working") return true;
          if (Date.now() > until) return false;
        }
      };
      const steps: string[][] = [["esc"], ["esc"], ...(now?.agent === "claude" ? [KILL_AGENTS] : [])];
      for (const keys of steps) {
        await herdrInput(paneId, undefined, keys);
        poke(paneId);
        if (await settled(keys === KILL_AGENTS ? STOP_AGENTS_MS : STOP_SETTLE_MS)) return;
      }
      world.stopCancelled(paneId);
      throw new Reject(L("멈춤 키를 보냈지만 아직 일하는 중으로 보입니다. 터미널 화면을 확인해 주세요.", "The stop key was sent but it still looks busy. Check the terminal."), 504, "stop_unconfirmed");
    }),
    // 플랜 승인 카드의 "Approve and start"(desk-plan 의 1 키). 키 단추로 1 을 보내는 것과 달리, 카드가 아직 떠 있을 때만
    // 보낸다 — 터미널에서 먼저 답해 카드가 내려간 뒤라면 1 이 입력창에 그대로 찍힌다. 보낸 뒤 카드가 내려가는 것까지 본다.
    "/api/plan/approve": mutate(async (body) => {
      const paneId = await need("pane", text(body, "paneId"));
      if (!(await world.waitingOnPlan(paneId))) throw new Reject(L("승인을 기다리는 플랜이 없습니다. 이미 답했을 수 있습니다.", "No plan is waiting for approval. It may already have been answered."), 409, "no_plan");
      await herdrRaw(paneId, "1");
      poke(paneId);
      for (const until = Date.now() + PLAN_APPROVE_MS; await world.waitingOnPlan(paneId); await Bun.sleep(SUBMIT_POLL_MS)) {
        if (Date.now() > until) throw new Reject(L("승인 키를 보냈지만 카드가 그대로입니다. 터미널 화면을 확인해 주세요.", "The approve key was sent but the card is still up. Check the terminal."), 504, "plan_unconfirmed");
      }
    }),
    // 플랜 카드에 고칠 점을 답한다 — 카드의 글 칸에 적고 Enter 한 것과 같다. 키를 흉내 내지 않고 카드가 답을 기다리는
    // 파이프에 써 넣는다(asking.ts answerPlan). 화면이 읽은 그 카드에만 보내고, 카드가 내려가는(또는 고친 플랜으로 새
    // 카드가 뜨는) 것까지 본다.
    "/api/plan/revise": mutate(async (body) => {
      const paneId = await need("pane", text(body, "paneId"));
      const card = body.card;
      const wish = text(body, "text", MAX_REVISE).trim();
      if (typeof card !== "number") throw new Reject(L("card 는 숫자여야 합니다.", "card must be a number."), 400);
      if (!wish) throw new Reject(L("고칠 점을 적어 주세요.", "Write what to change."), 400, "empty");
      const gone = L("그 플랜 카드는 이미 내려갔습니다. 터미널에서 먼저 답했거나 플랜이 바뀌었을 수 있습니다.", "That plan card is gone. It may have been answered in the terminal or the plan changed.");
      let sent: { log?: string; from: number } | false;
      try {
        sent = await world.revisePlan(paneId, card, wish);
      } catch (e) {
        if (!(e instanceof AnswerError)) throw e;
        if (e.reason === "too_long") throw new Reject(L("고칠 점이 너무 깁니다.", "That is too long."), 400, "too_long");
        throw new Reject(e.reason === "gone" ? gone : L("고칠 점을 다 보내지 못했습니다. 터미널 화면을 확인해 주세요.", "Could not send all of it. Check the terminal."), 409, "no_plan");
      }
      if (!sent) throw new Reject(gone, 409, "no_plan");
      poke(paneId);
      for (const until = Date.now() + PLAN_APPROVE_MS; await world.planCardUp(paneId, card); await Bun.sleep(SUBMIT_POLL_MS)) {
        if (Date.now() > until) throw new Reject(L("고칠 점을 보냈지만 카드가 그대로입니다. 터미널 화면을 확인해 주세요.", "The changes were sent but the card is still up. Check the terminal."), 504, "plan_unconfirmed");
      }
      // 카드가 내려간 것만으로는 닿았는지 모른다 — desk-plan 이 답을 알아보지 못하면 취소로 거절해도 카드는 내려간다.
      const unknown = L("카드는 내려갔지만 Claude 가 고칠 점을 받았는지 확인하지 못했습니다. 터미널 화면을 확인해 주세요.", "The card closed, but it could not be confirmed that Claude got the changes. Check the terminal.");
      if (!sent.log) throw new Reject(unknown, 502, "plan_unconfirmed");
      for (const until = Date.now() + REVISE_LANDED_MS; ; await Bun.sleep(SUBMIT_POLL_MS)) {
        const landed = await world.reviseLanded(sent.log, sent.from, wish);
        if (landed === "yes") return;
        if (landed === "no") throw new Reject(L("카드는 내려갔지만 고칠 점이 Claude 에 전해지지 않았습니다. desk-plan 이 답을 알아보지 못했을 수 있습니다.", "The card closed, but Claude did not get the changes. desk-plan may not have understood the answer."), 502, "plan_lost");
        if (Date.now() > until) throw new Reject(unknown, 502, "plan_unconfirmed");
      }
    }),
    "/api/seen": mutate(async (body) => {
      const paneId = await need("pane", text(body, "paneId"));
      return { seen: world.markSeen(paneId, body.undo === true) };
    }),

    // ── 만들기 ───────────────────────────────────────────────────────────────────────────────────
    "/api/workspace": mutate(async (body) => herdrCreateWorkspace(await directory(text(body, "cwd", 4096)), text(body, "label").trim() || undefined)),
    "/api/worktree": mutate(async (body) => {
      let workspaceId = text(body, "workspaceId");
      let cwd = text(body, "cwd", 4096);
      if (workspaceId) {
        await need("workspace", workspaceId);
        // herdr 는 워크트리를 저장소의 본체 스페이스에서만 새로 연다(별채에서 시작하면 linked_worktree_source).
        // 별채에서 '워크트리 추가'를 누르면 같은 저장소의 본체 스페이스로, 본체가 닫혀 있으면 저장소 경로로 바꿔 보낸다.
        const spaces = (await herdrSnapshot()).workspaces;
        const from = spaces.find((w) => w.workspace_id === workspaceId)?.worktree;
        if (from?.is_linked_worktree && from.repo_key) {
          const main = spaces.find((w) => w.worktree?.repo_key === from.repo_key && w.worktree?.is_linked_worktree === false);
          if (main) workspaceId = main.workspace_id;
          else if (from.repo_root) {
            workspaceId = "";
            cwd = from.repo_root;
          }
        }
      }
      return herdrCreateWorktree({
        workspaceId: workspaceId || undefined,
        cwd: workspaceId ? undefined : await directory(cwd),
        branch: gitName(text(body, "branch")),
        base: gitName(text(body, "base")),
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
      if (!/^[a-z][a-z0-9_-]*$/.test(kind)) throw new Reject(L("에이전트 종류가 올바르지 않습니다.", "That agent kind is not valid."), 400);
      if (!AGENT_NAME.test(name)) throw new Reject(L("이름은 영문 소문자로 시작하고 소문자·숫자·-·_ 만 32자까지 쓸 수 있습니다.", "A name starts with a lowercase letter and may use lowercase letters, digits, - and _ (32 characters at most)."), 400);
      const args = Array.isArray(body.args) ? body.args : [];
      if (args.length > 32 || args.some((a) => typeof a !== "string" || a.length > 2000)) throw new Reject(L("args 가 올바르지 않습니다.", "args is not valid."), 400);
      // 고른 모델·수준은 실행 인자로 넘긴다 — 그 세션에만 적용되고 하네스의 기본값은 그대로다(models.ts).
      const model = text(body, "model", 120);
      const effort = text(body, "effort", 20);
      const flags = await startFlags(kind, model, effort);
      await herdrStartAgent(paneId, kind, name, [...flags, ...(args as string[])]);
      // 첫 응답 전에는 로그에 모델이 없다. 고른 값을 상세에 바로 보이게 적어 둔다(world.started).
      world.agentStarted(paneId, { model, effort });
    }),
    "/api/model": mutate(async (body) => {
      const paneId = await need("agent", text(body, "paneId"));
      const pane = (await herdrSnapshot()).agents.find((p) => p.pane_id === paneId);
      // 일하는 중에 바꾸는 것은 하네스마다 어떻게 되는지 확인하지 않았다. 턴 사이에만 바꾼다.
      if (pane?.agent_status === "working") throw new Reject(L("일하는 중에는 모델을 바꾸지 않습니다. 이번 일이 끝난 뒤에 바꿔 주세요.", "The model is not switched mid-task. Switch it once this task is done."), 409, "agent_busy");
      if (pane?.agent_status === "blocked") throw new Reject(L("에이전트가 질문에 대한 답을 기다리는 중입니다.", "The agent is waiting for an answer to its question."), 409, "agent_blocked");
      await refuseIfAsking(paneId);
      const switched = await switchModel(paneId, (pane?.agent ?? "").toLowerCase(), text(body, "model", 120), text(body, "effort", 20));
      world.modelSwitched(paneId, switched);
      poke(paneId);
      return { switched };
    }),

    // ── 관리 ─────────────────────────────────────────────────────────────────────────────────────
    "/api/rename": mutate(async (body) => {
      const kind = text(body, "kind") as Kind;
      if (!KINDS.has(kind)) throw new Reject(L("kind 가 올바르지 않습니다.", "kind is not valid."), 400);
      const label = text(body, "label", 120).trim();
      if (kind === "agent" && label && !AGENT_NAME.test(label)) throw new Reject(L("에이전트 이름은 영문 소문자로 시작하고 소문자·숫자·-·_ 만 쓸 수 있습니다.", "An agent name starts with a lowercase letter and may use lowercase letters, digits, - and _."), 400);
      if ((kind === "workspace" || kind === "tab") && !label) throw new Reject(L("이름이 비어 있습니다.", "The name is empty."), 400);
      const id = await need(kind, text(body, "id"));
      await herdrRename(kind, id, label);
      if (kind === "pane") world.named(id, label);
    }),
    "/api/close": mutate(async (body) => {
      const kind = text(body, "kind") as Kind;
      if (!KINDS.has(kind) || kind === "agent") throw new Reject(L("kind 가 올바르지 않습니다.", "kind is not valid."), 400);
      return await herdrClose(kind, await need(kind, text(body, "id")), {
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
    "/api/models": {
      GET: guarded(async (req) => {
        const kind = new URL(req.url).searchParams.get("kind") ?? "";
        return json((await modelCatalog(kind)) ?? { kind, models: [], efforts: [], live: false });
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
            for (const ws of snap.workspaces) if (ws.worktree) seen.add(ws.worktree.repo_root ?? "");
            for (const pane of snap.panes) if (pane.cwd) seen.add(pane.cwd);
          } catch {
            // herdr 가 없으면 권할 것이 없다.
          }
          seen.delete("");
          return json({ dirs: [...seen].filter((p) => !p.includes("/.herdr/worktrees/")).sort().slice(0, 30).map(short) });
        }
        // 경로로 읽을 수 있는 것만 받는다(`~/…`, `/…`). 그 밖의 글자는 서버가 떠 있는 폴더 기준으로 풀려 엉뚱한 곳을 보여 준다.
        if (!/^(~($|\/)|\/)/.test(prefix.trim())) return json({ dirs: [] });
        const full = resolve(expandHome(prefix.trim()));
        // 홈 밖은 훑지 않는다 — 폴더 이름을 알려 주는 창구이므로 범위를 좁게 둔다.
        if (full !== home && !full.startsWith(`${home}/`)) return json({ dirs: [] });
        // 홈 자체(`~`)를 쳤을 때는 홈 안을 보여 준다 — 홈의 부모를 훑으면 다른 계정의 폴더 이름이 나온다.
        const [dir, head] = prefix.endsWith("/") || full === home ? [full, ""] : [dirname(full), basename(full)];
        // 글자로는 홈 안이어도 중간에 낀 심볼릭 링크가 밖을 가리킬 수 있다. 실제 자리로 다시 본다.
        const real = await realpath(dir).catch(() => "");
        const realHome = await realpath(home).catch(() => home);
        if (real !== realHome && !real.startsWith(`${realHome}/`)) return json({ dirs: [] });
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
