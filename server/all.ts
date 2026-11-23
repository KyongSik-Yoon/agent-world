// 전체 보기의 중계. 여러 PC 의 Agent World 를 읽어, 한 화면에 그릴 것만 추려 보낸다.
//
// AGENT_WORLD_WORLDS="노트북=https://lap.tailnet.ts.net:4780,빌드 서버=https://…" 를 주면 이 서버가 중계를 겸한다.
// 중계는 읽기만 한다 — 조작은 넘기지 않고, 화면은 섬을 누르면 그 월드의 주소로 넘어간다.
//
// 중계는 다른 월드의 열쇠를 갖지 않는다. 화면이 그 기기에 기억해 둔 열쇠를 보내면 그것으로 월드에 붙어 보고, 붙었을 때만
// 그 화면에 그 월드의 내용을 보낸다. 열쇠를 주지 않았거나 틀린 월드는 잠긴 것으로만 알린다(이름과 주소뿐). 받은 열쇠는
// 메모리에만 두고, 보는 화면이 없어지면 연결과 함께 버린다.
//
// 월드는 일하는 에이전트가 있으면 매초 패치를 보내지만(활동 글·제목), 전체 보기는 그것을 그리지 않는다. 여기서 걸러
// 화면은 배치나 상태가 바뀔 때만 깬다.
import { hostname } from "node:os";

import { groupLots } from "../shared/lots.ts";
import type { AllOp, DigestHouse, DigestStatus, WorldDigest, WorldSnapshot } from "../shared/types.ts";

/** 같은 박자에 온 변화는 한 번에 보낸다 — 여러 캐릭터가 같은 장을 나눠 쓰게. */
const BEAT_MS = 200;
/** 보는 화면이 없어진 뒤 월드와의 연결을 붙들어 두는 시간(새로 고침 사이에 끊었다 붙이지 않게). */
const LINGER_MS = 10_000;
const RETRY_MS = 3_000;
const HEARTBEAT_MS = 15_000;

interface Target {
  id: string;
  name: string;
  url: string;
}

/** 설정에 적힌 다른 월드들. 주소가 아닌 것은 버린다. */
export function parseWorlds(spec: string | undefined): Target[] {
  const out: Target[] = [];
  for (const part of (spec ?? "").split(",")) {
    const text = part.trim();
    if (!text) continue;
    const eq = text.indexOf("=");
    try {
      const url = new URL(eq > 0 ? text.slice(eq + 1).trim() : text);
      if (url.protocol !== "http:" && url.protocol !== "https:") continue;
      if (out.some((t) => t.id === url.origin)) continue;
      out.push({ id: url.origin, name: eq > 0 ? text.slice(0, eq).trim() : url.hostname, url: `${url.origin}/` });
    } catch {
      // 주소 모양이 아니다.
    }
  }
  return out;
}

type Workspaces = WorldSnapshot["workspaces"];
type Agent = Pick<WorldSnapshot["agents"][number], "id" | "workspaceId" | "vendor" | "status">;

const statusOf = (s: string): DigestStatus => (s === "working" || s === "blocked" || s === "done" ? s : "idle");

/** 월드 하나를 따라가는 것. 제 월드(Local)와 다른 PC 의 월드(Remote)가 같은 모양이다. */
abstract class Source {
  state: WorldDigest["state"] = "wait";
  protected workspaces: Workspaces = [];
  protected agents = new Map<string, Agent>();
  protected order: string[] = [];
  readonly viewers = new Set<Viewer>();

  constructor(readonly target: Target) {}

  digest(): WorldDigest {
    const base = { id: this.target.id, name: this.target.name, url: this.target.url, state: this.state };
    if (this.state !== "open") return { ...base, lots: [], agents: [] };
    const byId = new Map(this.workspaces.map((w) => [w.id, w]));
    const house = (id: string, main: boolean): DigestHouse => {
      const ws = byId.get(id);
      return { id, n: ws?.number ?? 0, label: ws?.label ?? "", main };
    };
    const lots = groupLots(this.workspaces).map((lot) => {
      // 본채를 가운데에 두고 별채를 오른쪽·왼쪽 번갈아 붙인다(web/world/layout.ts 와 같은 차례).
      const right = lot.annexes.filter((_, k) => k % 2 === 0);
      const left = lot.annexes.filter((_, k) => k % 2 === 1).reverse();
      const main: DigestHouse = lot.main ? house(lot.main, true) : { id: lot.key, n: 0, label: lot.name ?? "", main: true };
      return { key: lot.key, houses: [...left.map((id) => house(id, false)), main, ...right.map((id) => house(id, false))] };
    });
    const agents = this.order.flatMap((id) => {
      const a = this.agents.get(id);
      return a && byId.has(a.workspaceId) ? [{ id: a.id, ws: a.workspaceId, v: a.vendor, s: statusOf(a.status) }] : [];
    });
    return { ...base, lots, agents };
  }

  protected take(snapshot: Pick<WorldSnapshot, "workspaces" | "agents">): void {
    this.workspaces = snapshot.workspaces;
    this.agents = new Map(snapshot.agents.map((a) => [a.id, a]));
    this.order = snapshot.agents.map((a) => a.id);
  }

  protected changed(): void {
    for (const viewer of this.viewers) viewer.touch(this);
  }

  attach(viewer: Viewer): void {
    this.viewers.add(viewer);
  }

  detach(viewer: Viewer): void {
    this.viewers.delete(viewer);
  }
}

class Local extends Source {
  constructor(name: string) {
    super({ id: "local", name, url: "/" });
  }

  update(snapshot: WorldSnapshot): void {
    this.state = "open";
    this.take(snapshot);
    this.changed();
  }
}

class Remote extends Source {
  private abort: AbortController | undefined;
  private linger: ReturnType<typeof setTimeout> | undefined;

  constructor(
    target: Target,
    private readonly key: string,
    private readonly gone: () => void,
  ) {
    super(target);
    void this.follow();
  }

  override attach(viewer: Viewer): void {
    clearTimeout(this.linger);
    this.linger = undefined;
    super.attach(viewer);
  }

  override detach(viewer: Viewer): void {
    super.detach(viewer);
    if (this.viewers.size > 0 || this.linger) return;
    this.linger = setTimeout(() => {
      if (this.viewers.size > 0) return;
      this.abort?.abort();
      this.abort = undefined;
      this.gone();
    }, LINGER_MS);
  }

  private set(state: WorldDigest["state"]): void {
    if (this.state === state) return;
    this.state = state;
    this.changed();
  }

  private async follow(): Promise<void> {
    const abort = (this.abort = new AbortController());
    while (!abort.signal.aborted) {
      try {
        const res = await fetch(`${this.target.id}/api/events`, { headers: { "x-agent-world-key": this.key, accept: "text/event-stream" }, signal: abort.signal });
        if (res.status === 401) {
          // 열쇠가 틀렸다. 같은 열쇠로 다시 두드리지 않는다 — 화면이 새 열쇠를 보내면 새로 따라간다.
          this.set("locked");
          return;
        }
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        const decoder = new TextDecoder();
        let buffer = "";
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
          buffer += decoder.decode(chunk, { stream: true });
          let end: number;
          while ((end = buffer.indexOf("\n\n")) >= 0) {
            const raw = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            let event = "message";
            let data = "";
            for (const line of raw.split("\n")) {
              if (line.startsWith("event:")) event = line.slice(6).trim();
              else if (line.startsWith("data:")) data += line.slice(5).trimStart();
            }
            if (data) this.frame(event, JSON.parse(data));
          }
        }
        throw new Error("closed");
      } catch {
        if (abort.signal.aborted) return;
        this.set("down");
        await Bun.sleep(RETRY_MS);
      }
    }
  }

  /** 월드가 보낸 것 하나: 전체 스냅샷이거나, 그 뒤의 패치(shared/types.ts 의 SnapshotPatch). */
  private frame(event: string, body: any): void {
    if (event === "patch") {
      for (const a of body.agents as Agent[]) this.agents.set(a.id, a);
      this.order = body.order as string[];
      const kept = new Set(this.order);
      for (const id of [...this.agents.keys()]) if (!kept.has(id)) this.agents.delete(id);
      if (body.workspaces) this.workspaces = body.workspaces as Workspaces;
    } else this.take(body as WorldSnapshot);
    this.state = "open";
    this.changed();
  }
}

/** 전체 보기 화면 하나(열려 있는 스트림 하나). */
class Viewer {
  private readonly sources = new Map<string, Source | Target>();
  private readonly sentShape = new Map<string, string>();
  private readonly sentStatus = new Map<string, Map<string, DigestStatus>>();
  private readonly dirty = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;

  constructor(
    private readonly controller: ReadableStreamDefaultController<Uint8Array>,
    sources: Array<Source | Target>,
  ) {
    for (const s of sources) {
      const id = s instanceof Source ? s.target.id : s.id;
      this.sources.set(id, s);
      this.dirty.add(id);
      if (s instanceof Source) s.attach(this);
    }
    this.flush();
  }

  touch(source: Source): void {
    this.dirty.add(source.target.id);
    this.timer ??= setTimeout(() => this.flush(), BEAT_MS);
  }

  private flush(): void {
    this.timer = undefined;
    if (this.closed) return;
    const ops: AllOp[] = [];
    for (const id of this.dirty) {
      const s = this.sources.get(id)!;
      // 열쇠를 받지 못한 월드는 붙어 보지도 않는다 — 잠긴 것으로만 알린다.
      const d: WorldDigest = s instanceof Source ? s.digest() : { ...s, state: "locked", lots: [], agents: [] };
      const shape = JSON.stringify([d.state, d.name, d.url, d.lots, d.agents.map((a) => [a.id, a.ws, a.v])]);
      const before = this.sentStatus.get(id);
      if (shape !== this.sentShape.get(id)) ops.push({ t: "world", w: d });
      else for (const a of d.agents) if (before?.get(a.id) !== a.s) ops.push({ t: "s", w: id, a: a.id, s: a.s });
      this.sentShape.set(id, shape);
      this.sentStatus.set(id, new Map(d.agents.map((a) => [a.id, a.s])));
    }
    this.dirty.clear();
    if (ops.length) this.send(`data: ${JSON.stringify(ops)}\n\n`);
  }

  send(text: string): void {
    try {
      this.controller.enqueue(encoder.encode(text));
    } catch {
      this.close();
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.timer);
    for (const s of this.sources.values()) if (s instanceof Source) s.detach(this);
    viewers.delete(this);
  }
}

const encoder = new TextEncoder();
const viewers = new Set<Viewer>();
/** 다른 월드를 따라가는 것들. 같은 월드를 같은 열쇠로 보는 화면들은 하나를 나눠 쓴다. */
const remotes = new Map<string, Remote>();

export interface Relay {
  /** 설정된 다른 월드들(이름과 주소). */
  targets: Target[];
  /** 제 월드의 새 스냅샷. */
  update(snapshot: WorldSnapshot): void;
  /** 지금 전체 보기를 열어 둔 화면 수 — 있으면 제 월드도 매초 따라간다. */
  watching(): number;
  /** 화면 하나의 스트림. keys 는 그 화면이 가진 월드별 열쇠(출처 → 열쇠). */
  stream(keys: Record<string, string>, signal: AbortSignal): Response;
}

/** 중계를 겸하도록 설정돼 있으면 그 중계, 아니면 undefined. */
export function createRelay(spec: string | undefined = process.env.AGENT_WORLD_WORLDS): Relay | undefined {
  const targets = parseWorlds(spec);
  if (!targets.length) return undefined;
  const local = new Local(process.env.AGENT_WORLD_NAME?.trim() || hostname());
  setInterval(() => {
    for (const viewer of viewers) viewer.send(": keepalive\n\n");
  }, HEARTBEAT_MS).unref();
  return {
    targets,
    update: (snapshot) => local.update(snapshot),
    watching: () => viewers.size,
    stream(keys, signal) {
      let viewer: Viewer | undefined;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          const sources: Array<Source | Target> = [local];
          for (const target of targets) {
            const key = keys[target.id];
            if (typeof key !== "string" || !/^[0-9a-f]{32,128}$/.test(key)) {
              sources.push(target);
              continue;
            }
            const id = `${target.id}\n${key}`;
            let remote = remotes.get(id);
            if (!remote) remotes.set(id, (remote = new Remote(target, key, () => remotes.delete(id))));
            sources.push(remote);
          }
          viewer = new Viewer(controller, sources);
          viewers.add(viewer);
        },
        cancel() {
          viewer?.close();
        },
      });
      signal.addEventListener("abort", () => viewer?.close());
      return new Response(body, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" } });
    },
  };
}
