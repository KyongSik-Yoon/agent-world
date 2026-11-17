// Agent World 서버. 루프백에만 묶이고, 브라우저에는 스냅샷을 SSE 로 밀어 준다.
//
// 이 서버가 내보내는 것은 에이전트 로그의 요약과 터미널 화면이다. 그래서 127.0.0.1 밖으로는
// 열지 않고, Host 와 Origin 을 확인해 다른 사이트가 브라우저를 거쳐 읽어 가는 길도 막는다.
import index from "../web/index.html";
import type { WorldSnapshot } from "../shared/types.ts";
import { herdrFocus, herdrScreen } from "./herdr.ts";
import { raiseHerdrWindow } from "./raise.ts";
import { World } from "./world.ts";

const PORT = Number(process.env.AGENT_WORLD_PORT || 4780);
const TICK_MS = 1000;
const HEARTBEAT_MS = 15_000;
const IDLE_TICK_MS = 15_000;
/** 새로 붙은 브라우저에 바로 건네도 되는 스냅샷의 나이. 이보다 묵었으면 새로 만들어 보낸다. */
const FRESH_MS = 2_500;

const world = new World();
const encoder = new TextEncoder();
const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();
let latest: WorldSnapshot | undefined;
let latestKey = "";
let ticking = false;

function frame(snapshot: WorldSnapshot): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(snapshot)}\n\n`);
}

function broadcast(bytes: Uint8Array): void {
  for (const client of clients) {
    try {
      client.enqueue(bytes);
    } catch {
      clients.delete(client);
    }
  }
}

async function tick(): Promise<void> {
  // 보는 사람이 없으면 드문드문만 만든다 — 상태가 바뀐 시각을 크게 놓치지 않을 만큼만.
  if (ticking || (clients.size === 0 && Date.now() - (latest?.at ?? 0) < IDLE_TICK_MS)) return;
  ticking = true;
  try {
    const snapshot = await world.snapshot();
    // `at` 만 다른 스냅샷은 보내지 않는다 — 조용한 동안에는 브라우저가 아무 일도 하지 않는다.
    const key = JSON.stringify({ ...snapshot, at: 0 });
    latest = snapshot;
    if (key !== latestKey) {
      latestKey = key;
      broadcast(frame(snapshot));
    }
  } catch (e) {
    console.error("스냅샷 실패:", e);
  } finally {
    ticking = false;
  }
}

setInterval(() => void tick(), TICK_MS);
setInterval(() => broadcast(encoder.encode(": keepalive\n\n")), HEARTBEAT_MS);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}

const LOOPBACK = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`]);

/** 루프백 이름으로 들어온 요청인지, 그리고 다른 출처의 페이지가 보낸 것은 아닌지. */
function trusted(req: Request): boolean {
  const host = req.headers.get("host") ?? "";
  if (!LOOPBACK.has(host)) return false;
  const origin = req.headers.get("origin");
  if (origin === null) return req.method === "GET";
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function guarded(handler: (req: Request) => Response | Promise<Response>) {
  return (req: Request) => (trusted(req) ? handler(req) : json({ error: "forbidden" }, 403));
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: PORT,
  idleTimeout: 0,
  // 평소에는 한 번 묶어 둔 번들을 내보낸다. 화면을 고치는 동안에는 AGENT_WORLD_DEV=1 로 띄운다.
  development: process.env.AGENT_WORLD_DEV === "1",
  routes: {
    "/": index,
    "/api/snapshot": {
      GET: guarded(async () => json(await world.snapshot())),
    },
    "/api/events": {
      GET: guarded((req) => {
        let self: ReadableStreamDefaultController<Uint8Array> | undefined;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            self = controller;
            clients.add(controller);
            // 묵은 스냅샷을 먼저 보내면 화면이 옛 상태를 기준 삼아, 곧이어 오는 새 스냅샷의 차이를
            // 전부 "방금 바뀐 것"으로 알린다. 신선할 때만 건네고, 아니면 바로 새로 만든다.
            if (latest && Date.now() - latest.at < FRESH_MS) controller.enqueue(frame(latest));
            latestKey = "";
            void tick();
          },
          cancel() {
            if (self) clients.delete(self);
          },
        });
        req.signal.addEventListener("abort", () => {
          if (self) clients.delete(self);
        });
        return new Response(stream, {
          headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" },
        });
      }),
    },
    "/api/screen": {
      GET: guarded(async (req) => {
        const paneId = new URL(req.url).searchParams.get("pane") ?? "";
        if (!(await world.hasPane(paneId))) return json({ error: "그 pane 은 지금 herdr 에 없습니다." }, 404);
        try {
          return json({ text: await herdrScreen(paneId) });
        } catch (e) {
          return json({ error: (e as Error).message }, 502);
        }
      }),
    },
    "/api/focus": {
      POST: guarded(async (req) => {
        let paneId = "";
        try {
          paneId = String(((await req.json()) as { paneId?: unknown }).paneId ?? "");
        } catch {
          return json({ error: "요청 본문이 JSON 이 아닙니다." }, 400);
        }
        // 화면을 옮기는 요청이므로, 지금 herdr 에 실제로 있는 pane 일 때만 보낸다.
        if (!(await world.hasPane(paneId))) return json({ error: "그 pane 은 지금 herdr 에 없습니다." }, 404);
        try {
          await herdrFocus(paneId);
        } catch (e) {
          return json({ error: (e as Error).message }, 502);
        }
        const raised = await raiseHerdrWindow().catch(() => false);
        return json({ ok: true, raised });
      }),
    },
  },
  fetch: () => new Response("not found", { status: 404 }),
});

console.log(`Agent World → http://127.0.0.1:${server.port}`);
