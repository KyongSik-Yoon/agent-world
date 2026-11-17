// Agent World 서버. 루프백에만 묶이고, 브라우저에는 스냅샷을 SSE 로 밀어 준다.
//
// 이 서버는 에이전트 로그의 요약과 터미널 화면을 내보내고, 에이전트에게 글자를 넣을 수도 있다.
// 그래서 127.0.0.1 밖으로는 열지 않고, Host 와 Origin 을 확인해 다른 사이트가 브라우저를 거쳐
// 읽어 가거나 조작하는 길을 막는다. 조작을 아예 끄려면 AGENT_WORLD_READONLY=1 로 띄운다.
import { unlinkSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { brotliCompressSync, constants as zlibConstants } from "node:zlib";

import index from "../web/index.html";
import type { SnapshotPatch, WorldSnapshot } from "../shared/types.ts";
import { controlRoutes } from "./control.ts";
import { MAX_IMAGE_BYTES } from "./images.ts";
import { herdrFocus, herdrScreen, herdrSessionName, herdrSessionTag, herdrSocketPath } from "./herdr.ts";
import { raiseHerdrWindow } from "./raise.ts";
import { addressFile, type Address } from "./address.ts";
import { L, defaultLang, langOf, say } from "./text.ts";
import { World } from "./world.ts";

const NO_PANE = L("그 pane 은 지금 herdr 에 없습니다.", "That pane no longer exists in herdr.");

/** 포트를 직접 정해 줬는지. 정해 줬으면 그 포트만 쓰고, 아니면 이 herdr 세션의 자리부터 빈 포트를 찾는다. */
const PORT_GIVEN = Boolean(process.env.AGENT_WORLD_PORT);
const PORT = Number(process.env.AGENT_WORLD_PORT || sessionPort());
/** 제 포트가 차 있을 때 더 찾아보는 자리 수. */
const PORT_TRIES = 10;

/**
 * 이 herdr 세션의 포트. 기본 세션은 늘 4780 이고, 이름 붙은 세션은 소켓 경로에서 정해지는 4781~4879 의 한 자리다.
 * 띄운 순서로 정하면(먼저 뜬 쪽이 4780) 재부팅 뒤 순서가 바뀔 때 같은 주소가 다른 세션을 보여 준다 —
 * 북마크와 tailnet 주소가 가리키는 세션이 달라지지 않게, 세션이 같으면 포트도 같게 한다.
 */
function sessionPort(): number {
  const tag = herdrSessionTag();
  return tag ? 4781 + (Number.parseInt(tag.slice(0, 6), 16) % 99) : 4780;
}
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  console.error(say(L(`AGENT_WORLD_PORT 가 포트 번호가 아닙니다: ${process.env.AGENT_WORLD_PORT}`, `AGENT_WORLD_PORT is not a port number: ${process.env.AGENT_WORLD_PORT}`)));
  process.exit(1);
}
const TICK_MS = 1000;
const HEARTBEAT_MS = 15_000;
const IDLE_TICK_MS = 15_000;
/** 새로 붙은 브라우저에 바로 건네도 되는 스냅샷의 나이. 이보다 묵었으면 새로 만들어 보낸다. */
const FRESH_MS = 2_500;

const READONLY = process.env.AGENT_WORLD_READONLY === "1";
const DEV = process.env.AGENT_WORLD_DEV === "1";

const world = new World(!READONLY, process.env.AGENT_WORLD_OUTSIDE === "1");
const encoder = new TextEncoder();
type Client = ReadableStreamDefaultController<Uint8Array>;
/** 붙어 있는 화면들. 값은 전체 스냅샷을 한 번 받았는지 — 받은 화면에는 바뀐 것만 보낸다. */
const clients = new Map<Client, boolean>();
let latest: WorldSnapshot | undefined;
let ticking = false;
/** 마지막으로 내보낸 상태: 에이전트별 직렬화와, 에이전트를 뺀 나머지의 직렬화. */
let sentAgents = new Map<string, string>();
let sentOrder = "";
let sentRest = "";

function frame(snapshot: WorldSnapshot): Uint8Array {
  return encoder.encode(`data: ${JSON.stringify(snapshot)}\n\n`);
}

function send(client: Client, bytes: Uint8Array): void {
  try {
    client.enqueue(bytes);
  } catch {
    clients.delete(client);
  }
}

function broadcast(bytes: Uint8Array): void {
  for (const client of clients.keys()) send(client, bytes);
}

/**
 * 새 스냅샷을 내보낸다. 처음 붙은 화면에는 전체를, 이미 전체를 받은 화면에는 달라진 에이전트만 보낸다 —
 * 에이전트 하나가 일하는 동안 매초 스냅샷 전체(수십 KB)를 다시 보내지 않게.
 */
function publish(snapshot: WorldSnapshot): void {
  const { agents, at, ...rest } = snapshot;
  const now = new Map<string, string>();
  const changed: WorldSnapshot["agents"] = [];
  for (const agent of agents) {
    // 로그 파일의 수정 시각은 화면이 쓰지 않는다. 그것만 바뀐 것은 변화로 치지 않는다.
    const body = JSON.stringify({ ...agent, logUpdatedAt: undefined });
    now.set(agent.id, body);
    if (sentAgents.get(agent.id) !== body) changed.push(agent);
  }
  const order = agents.map((a) => a.id).join("\n");
  const restBody = JSON.stringify(rest);
  const restChanged = restBody !== sentRest;
  const dirty = changed.length > 0 || order !== sentOrder || restChanged;
  sentAgents = now;
  sentOrder = order;
  sentRest = restBody;

  let full: Uint8Array | undefined;
  let patch: Uint8Array | undefined;
  for (const [client, primed] of clients) {
    if (!primed) {
      send(client, (full ??= frame(snapshot)));
      clients.set(client, true);
    } else if (dirty) {
      if (!patch) {
        const body: SnapshotPatch = { at, order: agents.map((a) => a.id), agents: changed, ...(restChanged ? rest : {}) };
        patch = encoder.encode(`event: patch\ndata: ${JSON.stringify(body)}\n\n`);
      }
      send(client, patch);
    }
  }
}

let again = false;

async function tick(force = false): Promise<void> {
  // 만드는 중에 조작이 끝났으면, 그 결과가 빠지지 않도록 끝난 뒤 한 번 더 만든다.
  if (ticking) {
    again ||= force;
    return;
  }
  // 보는 사람이 없으면 드문드문만 만든다 — 상태가 바뀐 시각을 크게 놓치지 않을 만큼만.
  if (!force && clients.size === 0 && Date.now() - (latest?.at ?? 0) < IDLE_TICK_MS) return;
  ticking = true;
  try {
    const snapshot = await world.snapshot();
    latest = snapshot;
    // 달라진 것이 없으면 아무것도 보내지 않는다 — 조용한 동안에는 브라우저가 아무 일도 하지 않는다.
    publish(snapshot);
  } catch (e) {
    console.error(say(L("스냅샷 실패:", "Snapshot failed:")), e);
  } finally {
    ticking = false;
    if (again) {
      again = false;
      void tick(true);
    }
  }
}

setInterval(() => void tick(), TICK_MS);
setInterval(() => broadcast(encoder.encode(": keepalive\n\n")), HEARTBEAT_MS);

/**
 * 화면을 한 번 묶어, 파일마다 압축본까지 만들어 둔다.
 *
 * 묶은 스크립트는 700KB 쯤인데 압축하면 그 1/4 이다. 이 PC 에서 열 때는 차이가 없지만, tailnet 너머의 휴대폰에서
 * 처음 열 때는 그만큼이 기다리는 시간이다(tailscale serve 는 압축해 주지 않는다).
 */
async function bundledPage(): Promise<Record<string, { GET: (req: Request) => Response }>> {
  const built = await Bun.build({ entrypoints: [join(import.meta.dir, "..", "web", "index.html")], minify: true });
  if (!built.success) {
    console.error(say(L("화면을 묶지 못했습니다:", "Could not bundle the page:")), built.logs.join("\n"));
    process.exit(1);
  }
  const routes: Record<string, { GET: (req: Request) => Response }> = {};
  for (const out of built.outputs) {
    const isPage = out.path.endsWith(".html");
    // 문서에 서버의 기본 말을 적어 준다 — 화면은 따로 고른 말이 없을 때 이것을 따른다.
    const raw = isPage ? new TextEncoder().encode((await out.text()).replace(/<html lang="[^"]*"/, `<html lang="${defaultLang()}"`)) : new Uint8Array(await out.arrayBuffer());
    const br = new Uint8Array(brotliCompressSync(raw, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 9 } }));
    const gz = Bun.gzipSync(raw, { level: 9 });
    const base: Record<string, string> = {
      "content-type": out.type,
      vary: "accept-encoding",
      // 스크립트와 스타일은 이름에 내용의 해시가 들어 있어 영영 묵혀도 된다. 문서는 매번 확인하게 한다.
      "cache-control": isPage ? "no-cache" : "public, max-age=31536000, immutable",
      etag: `"${Bun.hash(raw).toString(16)}"`,
    };
    routes[isPage ? "/" : `/${basename(out.path)}`] = {
      GET: (req) => {
        if (req.headers.get("if-none-match") === base.etag) return new Response(null, { status: 304, headers: base });
        const accepts = req.headers.get("accept-encoding") ?? "";
        if (/\bbr\b/.test(accepts)) return new Response(br, { headers: { ...base, "content-encoding": "br" } });
        if (/\bgzip\b/.test(accepts)) return new Response(gz, { headers: { ...base, "content-encoding": "gzip" } });
        return new Response(raw, { headers: base });
      },
    };
  }
  return routes;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}

/** 실제로 묶인 포트. 기본 포트가 차 있으면 PORT 와 다를 수 있다. */
let port = PORT;
const loopback = (host: string): boolean => host === `127.0.0.1:${port}` || host === `localhost:${port}` || host === `[::1]:${port}`;

// 다른 기기에서 쓰려고 `tailscale serve` 로 내보낼 때 그 주소를 적는다(예: `host.tailnet.ts.net:4780`).
// 이 이름으로 온 요청은 tailscale 이 붙여 주는 사용자 표시가 이 PC 의 주인과 같을 때만 받는다 —
// 같은 tailnet 의 다른 사람이나 태그 기기는 통과하지 못한다.
const TAILNET_HOSTS = new Set(
  (process.env.AGENT_WORLD_TRUST_HOSTS ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean),
);

let owner: Promise<string | null> | undefined;
let ownerAskedAt = 0;
/** 계정을 알아내지 못했을 때 다시 물어보기까지의 간격. */
const OWNER_RETRY_MS = 30_000;

/** 이 PC 를 tailnet 에 올린 계정. 알아내지 못하면 null — 그러면 tailnet 으로 온 요청은 모두 거절된다. */
function tailnetOwner(): Promise<string | null> {
  if (owner && Date.now() - ownerAskedAt < OWNER_RETRY_MS) return owner;
  const asked = (async () => {
    try {
      const proc = Bun.spawn(["tailscale", "status", "--json"], { stdout: "pipe", stderr: "ignore", timeout: 5000 });
      const status = (await new Response(proc.stdout).json()) as { Self?: { UserID?: number }; User?: Record<string, { LoginName?: string }> };
      return status.User?.[String(status.Self?.UserID)]?.LoginName ?? null;
    } catch (e) {
      console.error(
        say(L("tailscale 에서 이 PC 의 계정을 알아내지 못했습니다(tailnet 으로 온 요청은 거절됩니다):", "Could not find this machine's tailscale account (requests arriving over the tailnet are refused):")),
        (e as Error).message,
      );
      return null;
    }
  })();
  owner = asked;
  ownerAskedAt = Date.now();
  // 알아낸 답은 계속 쓴다. 못 알아낸 답만(서버를 띄울 때 tailscale 이 아직 안 떠 있었을 수 있다) 조금 뒤에 다시 묻는다.
  void asked.then((login) => {
    if (login !== null && owner === asked) ownerAskedAt = Number.POSITIVE_INFINITY;
  });
  return owner;
}

/** 믿을 수 있는 이름으로 들어온 요청인지, 그리고 다른 출처의 페이지가 보낸 것은 아닌지. */
async function trusted(req: Request): Promise<boolean> {
  const host = (req.headers.get("host") ?? "").toLowerCase();
  if (TAILNET_HOSTS.has(host)) {
    const login = req.headers.get("tailscale-user-login");
    if (!login || login !== (await tailnetOwner())) return false;
  } else if (!loopback(host)) return false;
  // 다른 사이트의 페이지가 <img> 나 no-cors fetch 로 보낸 GET 은 답을 읽지는 못해도 herdr 를 읽는 흐름을 열어 둘 수 있다.
  // 브라우저는 그런 요청에 출처 관계를 적어 보낸다 — 이 화면이 보낸 것(same-origin)과 주소창에서 연 것(none)만 받는다.
  const site = req.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin" && site !== "none") return false;
  const origin = req.headers.get("origin");
  if (origin === null) return req.method === "GET";
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function guarded(handler: (req: Request) => Response | Promise<Response>) {
  return async (req: Request) => ((await trusted(req)) ? handler(req) : json({ error: "forbidden" }, 403));
}

/** 이 서버가 무엇에 붙어 있는지. 같은 포트를 두고 만난 다른 Agent World 가 서로를 알아보는 데 쓴다. */
interface Identity {
  app: "agent-world";
  socket: string;
  readonly: boolean;
}
const identity: Identity = { app: "agent-world", socket: resolve(herdrSocketPath()), readonly: READONLY };

/**
 * 지금 어느 주소에 떠 있는지를 상태 폴더에 적어 둔다. 서버를 herdr 가 대신 띄우면(플러그인) 이 출력은 아무도 보지
 * 않으므로, 주소를 열어 주는 쪽(`bun run url`)이 읽을 곳이 있어야 한다. 끝날 때 지운다.
 */
async function announce(at: number): Promise<void> {
  const path = addressFile(READONLY);
  try {
    await mkdir(dirname(path), { recursive: true });
    const address: Address = { url: `http://127.0.0.1:${at}`, port: at, pid: process.pid, socket: identity.socket, session: herdrSessionName() ?? null, readonly: READONLY };
    await writeFile(path, `${JSON.stringify(address)}\n`);
  } catch (e) {
    console.error(say(L("주소를 적어 두지 못했습니다:", "Could not record the address:")), (e as Error).message);
    return;
  }
  const forget = (): void => {
    try {
      unlinkSync(path);
    } catch {
      // 이미 없으면 그만이다.
    }
  };
  process.on("exit", forget);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, () => process.exit(0));
}

/** 그 포트에 떠 있는 것이 Agent World 면 그 정체를, 아니면(다른 프로그램이거나 답이 없으면) null 을 준다. */
async function identify(at: number): Promise<Identity | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${at}/api/identity`, { signal: AbortSignal.timeout(1000) });
    const body = (await res.json()) as Partial<Identity>;
    return body.app === "agent-world" && typeof body.socket === "string" ? (body as Identity) : null;
  } catch {
    return null;
  }
}

/**
 * 포트를 잡는다. 차 있으면 누가 쓰는지 본다:
 *   - 같은 herdr 에 같은 모드로 붙은 Agent World 면 이미 떠 있는 것이다. 그 주소를 알리고 조용히 끝낸다
 *     (herdr 가 시작할 때마다 띄우는 플러그인에서 두 번째 실행이 오류가 되지 않게).
 *   - 다른 herdr 세션의 Agent World 나 다른 프로그램이면 다음 포트를 본다. 포트를 직접 정해 줬으면 옮기지 않고 알린다.
 */
async function start() {
  for (let at = PORT; ; at += 1) {
    port = at;
    try {
      return listen(at);
    } catch (e) {
      if ((e as { code?: string }).code !== "EADDRINUSE") {
        console.error(say(L(`서버를 띄우지 못했습니다: ${(e as Error).message}`, `Could not start the server: ${(e as Error).message}`)));
        process.exit(1);
      }
      const other = await identify(at);
      if (other?.socket === identity.socket && other.readonly === identity.readonly) {
        console.log(say(L(`Agent World 가 이미 떠 있습니다 → http://127.0.0.1:${at}`, `Agent World is already running → http://127.0.0.1:${at}`)));
        process.exit(0);
      }
      const held = other
        ? L(`${at}번 포트는 다른 herdr 세션(또는 다른 모드)의 Agent World 가 쓰고 있습니다.`, `Port ${at} is in use by an Agent World for another herdr session (or mode).`)
        : L(`${at}번 포트는 다른 프로그램이 쓰고 있습니다.`, `Port ${at} is in use by another program.`);
      if (PORT_GIVEN || at >= PORT + PORT_TRIES - 1 || at >= 65535) {
        console.error(
          say(
            PORT_GIVEN
              ? L(`${held.ko} AGENT_WORLD_PORT 로 다른 포트를 주세요.`, `${held.en} Set AGENT_WORLD_PORT to another port.`)
              : L(`${PORT}~${at}번 포트가 모두 차 있습니다. AGENT_WORLD_PORT 로 빈 포트를 주세요.`, `Ports ${PORT}–${at} are all in use. Set AGENT_WORLD_PORT to a free port.`),
          ),
        );
        process.exit(1);
      }
      console.log(say(L(`${held.ko} 다음 포트를 봅니다.`, `${held.en} Trying the next one.`)));
    }
  }
}

/** 화면(HTML·JS·CSS). 개발 중에는 Bun 이 고칠 때마다 다시 묶어 주고, 평소에는 미리 묶어 압축해 둔 것을 내보낸다. */
const page = (DEV ? { "/": index } : await bundledPage()) as Record<string, typeof index>;

const listen = (at: number) =>
  Bun.serve({
  hostname: "127.0.0.1",
  port: at,
  // 같은 포트를 여러 프로세스가 나눠 쓰지 않는다. 나눠 쓰면 요청이 서로 다른 herdr 에 붙은 서버들 사이를 오간다.
  reusePort: false,
  // 가장 큰 요청은 이미지 한 장(10MB)이다. 그보다 훨씬 큰 본문은 읽기 전에 끊는다.
  maxRequestBodySize: MAX_IMAGE_BYTES + 1024 * 1024,
  idleTimeout: 0,
  // 평소에는 한 번 묶어 압축해 둔 번들을 내보낸다. 화면을 고치는 동안에는 AGENT_WORLD_DEV=1 로 띄운다.
  development: DEV,
  routes: {
    ...page,
    "/api/identity": { GET: guarded(() => json(identity)) },
    "/api/snapshot": {
      GET: guarded(async () => json(await world.snapshot())),
    },
    "/api/events": {
      GET: guarded((req) => {
        let self: ReadableStreamDefaultController<Uint8Array> | undefined;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            self = controller;
            // 묵은 스냅샷을 먼저 보내면 화면이 옛 상태를 기준 삼아, 곧이어 오는 새 스냅샷의 차이를
            // 전부 "방금 바뀐 것"으로 알린다. 신선할 때만 건네고, 아니면 바로 새로 만들어 전체를 보낸다.
            const fresh = latest !== undefined && Date.now() - latest.at < FRESH_MS;
            clients.set(controller, fresh);
            if (fresh) controller.enqueue(frame(latest!));
            void tick(true);
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
        try {
          if (!(await world.hasPane(paneId))) return json({ error: say(NO_PANE, langOf(req)) }, 404);
          return json({ text: await herdrScreen(paneId) });
        } catch (e) {
          return json({ error: (e as Error).message }, 502);
        }
      }),
    },
    "/api/focus": {
      POST: guarded(async (req) => {
        // herdr 의 화면을 옮기고(그 pane 의 완료 표시도 풀린다) 터미널 창을 앞으로 가져오므로, 보는 것이 아니라 바꾸는 요청이다.
        if (READONLY) return json({ error: say(L("보기 전용으로 띄운 서버입니다(AGENT_WORLD_READONLY=1).", "This server is read-only (AGENT_WORLD_READONLY=1)."), langOf(req)), code: "readonly" }, 403);
        let paneId = "";
        try {
          paneId = String(((await req.json()) as { paneId?: unknown }).paneId ?? "");
        } catch {
          return json({ error: say(L("요청 본문이 JSON 이 아닙니다.", "The request body is not JSON."), langOf(req)) }, 400);
        }
        // 화면을 옮기는 요청이므로, 지금 herdr 에 실제로 있는 pane 일 때만 보낸다.
        try {
          if (!(await world.hasPane(paneId))) return json({ error: say(NO_PANE, langOf(req)) }, 404);
          await herdrFocus(paneId);
        } catch (e) {
          return json({ error: (e as Error).message }, 502);
        }
        const raised = await raiseHerdrWindow().catch(() => false);
        return json({ ok: true, raised });
      }),
    },
    ...controlRoutes({ world, readonly: READONLY, guarded, json, refresh: () => void tick(true) }),
  },
  fetch: () => new Response("not found", { status: 404 }),
});

const server = await start();

const session = herdrSessionName();
console.log(
  `Agent World → http://127.0.0.1:${server.port}${READONLY ? say(L(" (보기 전용)", " (read-only)")) : ""}${session ? say(L(` · herdr 세션 ${session}`, ` · herdr session ${session}`)) : ""}`,
);
void announce(server.port ?? port);
for (const host of TAILNET_HOSTS) console.log(say(L(`  tailnet 에서도 받음(이 PC 의 계정만) → https://${host}`, `  also served on the tailnet (this machine's account only) → https://${host}`)));
