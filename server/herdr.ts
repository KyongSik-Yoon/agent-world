// herdr 소켓 RPC. 줄 단위 JSON 이고 요청 하나에 연결 하나다(서버가 응답 뒤 연결을 닫는다).
import { dlopen, FFIType, ptr } from "bun:ffi";
import { createHash } from "node:crypto";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { L, asText, say, type Text } from "./text.ts";

export function herdrDefaultSocket(): string {
  return join(homedir(), ".config", "herdr", "herdr.sock");
}

export function herdrSocketPath(): string {
  return process.env.HERDR_SOCKET_PATH || herdrDefaultSocket();
}

/**
 * 이 서버가 붙은 herdr 세션의 이름. 기본 세션이면 "", 알 수 없는 자리의 소켓이면 undefined.
 * 이름 붙은 세션의 소켓은 `…/herdr/sessions/<이름>/herdr.sock` 에 있다.
 */
export function herdrSessionName(socket = herdrSocketPath()): string | undefined {
  if (resolve(socket) === resolve(herdrDefaultSocket())) return "";
  return /\/sessions\/([^/]+)\/herdr\.sock$/.exec(resolve(socket))?.[1];
}

/** 소켓 경로에서 나오는 짧은 표시. 세션마다 따로 둬야 하는 것(파일 이름, 포트)을 가르는 데 쓴다. 기본 세션은 "". */
export function herdrSessionTag(): string {
  const socket = resolve(herdrSocketPath());
  return socket === resolve(herdrDefaultSocket()) ? "" : createHash("sha1").update(socket).digest("hex").slice(0, 10);
}

export class HerdrError extends Error {
  /** 두 말로 적은 문장. herdr 가 돌려준 오류 문장은 옮길 수 없어 두 말에 그대로 실린다. */
  readonly text: Text;

  constructor(
    message: Text | string,
    readonly code?: string,
  ) {
    super(say(message));
    this.text = asText(message);
  }
}

/**
 * herdr 세션이 아직 있는지. 소켓 파일이 없거나(ENOENT) 받는 쪽이 없으면(ECONNREFUSED) false 다. 그 밖에(응답이 늦음,
 * 권한 등) 알 수 없을 때는 있는 것으로 친다 — 바쁜 herdr 를 사라진 것으로 보고 서버를 내리지 않게.
 */
export function herdrAlive(timeoutMs = 3000): Promise<boolean> {
  return new Promise((done) => {
    const socket = createConnection(herdrSocketPath());
    const finish = (alive: boolean) => {
      clearTimeout(timer);
      socket.destroy();
      done(alive);
    };
    const timer = setTimeout(() => finish(true), timeoutMs);
    socket.on("connect", () => finish(true));
    socket.on("error", (e: NodeJS.ErrnoException) => finish(e.code !== "ENOENT" && e.code !== "ECONNREFUSED"));
  });
}

let seq = 0;

/**
 * 연결과 첫 쓰기를 한 번에 한다(Linux). 돌려주는 것은 요청을 이미 써 넣은 소켓의 fd, 이 길을 못 쓰면 undefined.
 *
 * herdr 는 연결을 받자마자 요청을 읽고, 아직 와 있지 않으면 100ms 를 쉰 뒤 다시 읽는다(0.9.5 실측: 연결 뒤 쓰기를 0.5ms 만
 * 늦춰도 20번 모두 101ms). Bun 의 소켓은 연결이 된 것을 이벤트 루프가 한 번 돈 뒤에야 알려 줘서 그 사이에 herdr 가 먼저
 * 읽는 일이 4번에 1번쯤 생긴다 — 글자 하나, 화면 읽기 한 번이 0.1초씩 늦는다. connect 와 write 를 시스템 호출로 잇달아
 * 부르면 herdr 가 깨어나 읽을 때는 요청이 이미 와 있다(100번에 1번쯤만 늦는다).
 *
 * 유닉스 소켓의 connect 는 기다리지 않고 바로 끝나므로(받는 쪽 줄이 차 있으면 실패) 이벤트 루프를 붙잡지 않는다.
 * macOS 는 시험하지 못해 예전 길로 둔다.
 */
type FastOpen = (path: string, line: Buffer) => number | undefined;
/** 시험 삼아 한 번 불러 답을 받은 뒤에만 쓴다(tryFastOpen). */
let fastOpen: FastOpen | null = null;
let fastTried = false;
let closeFd: (fd: number) => void = () => {};
const FAST_MAX_BYTES = 32 * 1024;

function loadFastOpen(): FastOpen | null {
  if (process.platform !== "linux") return null;
  try {
    const libc = dlopen("libc.so.6", {
      socket: { args: [FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
      connect: { args: [FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
      write: { args: [FFIType.i32, FFIType.ptr, FFIType.u64], returns: FFIType.i64 },
      close: { args: [FFIType.i32], returns: FFIType.i32 },
    }).symbols;
    closeFd = (fd) => void libc.close(fd);
    const AF_UNIX = 1;
    const SOCK_STREAM = 1;
    const SOCK_NONBLOCK = 0o4000;
    const SOCK_CLOEXEC = 0o2000000;
    return (path, line) => {
      // sockaddr_un: 2바이트 family 뒤에 108바이트 경로(끝의 0 포함).
      const name = Buffer.from(path);
      if (name.length > 107) return undefined;
      const addr = Buffer.alloc(110);
      addr.writeUInt16LE(AF_UNIX, 0);
      name.copy(addr, 2);
      const fd = libc.socket(AF_UNIX, SOCK_STREAM | SOCK_NONBLOCK | SOCK_CLOEXEC, 0);
      if (fd < 0) return undefined;
      if (libc.connect(fd, ptr(addr), addr.length) !== 0) {
        libc.close(fd);
        return undefined;
      }
      const wrote = Number(libc.write(fd, ptr(line), line.length));
      if (wrote === line.length) return fd;
      libc.close(fd);
      // 하나도 못 썼으면 예전 길로 다시 보낸다. 쓰다 만 요청은 줄이 끝나지 않아 herdr 가 실행하지 않지만, 같은 입력이
      // 두 번 들어갈 여지를 두지 않으려고 다시 보내지 않고 실패로 알린다.
      if (wrote > 0) throw new HerdrError(L("herdr 에 요청을 다 쓰지 못함", "could not write the whole request to herdr"));
      return undefined;
    };
  } catch {
    return null;
  }
}

/**
 * 빠른 길을 처음 한 번 시험한다. 열어 둔 fd 를 Bun 소켓으로 넘겨받는 것(`Bun.connect({ fd })`)은 Bun 의 형 선언에 없는
 * 기능이라, 이 Bun 에서 되는지 해가 없는 읽기 요청으로 확인한 뒤에만 쓴다. 확인되기 전과 안 되는 곳에서는 예전 길이다.
 */
function tryFastOpen(): void {
  fastTried = true;
  const open = loadFastOpen();
  if (!open) return;
  call("session.snapshot", {}, 3000, open).then(
    () => {
      fastOpen = open;
    },
    () => {},
  );
}

export function herdrRpc<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs = 3000): Promise<T> {
  if (!fastTried) tryFastOpen();
  return call(method, params, timeoutMs, fastOpen);
}

function call<T>(method: string, params: Record<string, unknown>, timeoutMs: number, open: FastOpen | null): Promise<T> {
  return new Promise((resolve, reject) => {
    const id = `agent-world:${++seq}`;
    const line = `${JSON.stringify({ id, method, params })}\n`;
    const chunks: Buffer[] = [];
    let settled = false;
    let hangUp = (): void => {};
    const finish = (err: Error | null, value?: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      hangUp();
      if (err) reject(err);
      else resolve(value as T);
    };
    const timer = setTimeout(() => finish(new HerdrError(L(`herdr ${method} 응답 시간 초과`, `herdr ${method} timed out`), "timeout")), timeoutMs);
    const parse = () => {
      const text = Buffer.concat(chunks).toString("utf8").trim();
      if (!text) return finish(new HerdrError(L(`herdr ${method} 응답 없음`, `herdr ${method} sent no reply`)));
      try {
        const reply = JSON.parse(text.split("\n")[0]!) as { result?: T; error?: { code?: string; message?: string } };
        if (reply.error) return finish(new HerdrError(reply.error.message || L("herdr 오류", "herdr error"), reply.error.code));
        finish(null, reply.result as T);
      } catch (e) {
        finish(new HerdrError(L(`herdr ${method} 응답을 읽지 못함: ${(e as Error).message}`, `could not read the herdr ${method} reply: ${(e as Error).message}`)));
      }
    };
    const onData = (c: Buffer) => {
      chunks.push(Buffer.from(c));
      if (c[c.length - 1] === 0x0a) parse();
    };
    const broken = (e: Error) => finish(new HerdrError(L(`herdr 소켓 연결 실패: ${e.message}`, `could not connect to the herdr socket: ${e.message}`)));

    const bytes = Buffer.from(line);
    let fd: number | undefined;
    try {
      fd = open && bytes.length <= FAST_MAX_BYTES ? open(herdrSocketPath(), bytes) : undefined;
    } catch (e) {
      return finish(e as Error);
    }
    if (fd !== undefined) {
      // 요청은 이미 들어갔다 — 여기서부터는 답만 읽는다. 실패해도 예전 길로 다시 보내지 않는다(입력이 두 번 들어간다).
      const opened = fd;
      let adopted = false;
      hangUp = () => {
        if (!adopted) closeFd(opened);
      };
      const options = {
        fd: opened,
        socket: {
          data: (_s: unknown, c: Buffer) => onData(c),
          end: () => parse(),
          close: () => parse(),
          error: (_s: unknown, e: Error) => broken(e),
        },
      };
      Bun.connect(options as unknown as Parameters<typeof Bun.connect>[0]).then(
        (s) => {
          adopted = true;
          hangUp = () => s.terminate();
          if (settled) s.terminate();
        },
        (e: Error) => broken(e),
      );
      return;
    }

    const socket = createConnection(herdrSocketPath());
    hangUp = () => socket.destroy();
    socket.on("connect", () => socket.write(line));
    socket.on("data", onData);
    socket.on("end", parse);
    socket.on("error", broken);
  });
}

export interface HerdrAgentSession {
  agent?: string;
  kind?: "id" | "path";
  source?: string;
  value?: string;
}

export interface HerdrPane {
  pane_id: string;
  workspace_id: string;
  tab_id: string;
  focused?: boolean;
  cwd?: string;
  foreground_cwd?: string;
  label?: string;
  agent?: string;
  terminal_title?: string;
  terminal_title_stripped?: string;
  agent_status?: string;
  agent_session?: HerdrAgentSession;
  /** 에이전트 목록(agents)에만 있는 값들. */
  name?: string;
  state_change_seq?: number;
  interactive_ready?: boolean;
  launch_pending?: boolean;
  /** 화면 줄 수(viewport_rows)는 테두리를 뺀 안쪽 크기다 — layouts 의 rect 는 테두리까지 친 크기라 이것으로 테두리 폭을 안다. */
  scroll?: { viewport_rows?: number };
}

export interface HerdrWorkspace {
  workspace_id: string;
  number: number;
  label: string;
  focused?: boolean;
  tokens?: { topic?: string };
  worktree?: { repo_name?: string; repo_key?: string; repo_root?: string; checkout_path?: string; is_linked_worktree?: boolean };
}

export interface HerdrTab {
  tab_id: string;
  workspace_id: string;
  label?: string;
  number?: number;
}

export interface HerdrLayout {
  tab_id: string;
  panes: Array<{ pane_id: string; rect: { width: number; height: number } }>;
}

export interface HerdrSnapshot {
  focused_pane_id?: string;
  layouts?: HerdrLayout[];
  workspaces: HerdrWorkspace[];
  tabs: HerdrTab[];
  panes: HerdrPane[];
  agents: HerdrPane[];
}

export async function herdrSnapshot(): Promise<HerdrSnapshot> {
  const result = await herdrRpc<{ snapshot: HerdrSnapshot }>("session.snapshot");
  const snap = result.snapshot;
  // 버전이 다른 herdr 가 목록 하나를 빼고 보내도 스냅샷 전체가 깨지지 않게 한다.
  snap.workspaces ??= [];
  snap.tabs ??= [];
  snap.panes ??= [];
  snap.agents ??= [];
  // 에이전트 목록에는 pane 이름(label)이 빠져 온다(herdr 0.9.5). pane 목록에서 이어 붙인다.
  const labels = new Map(snap.panes.map((p) => [p.pane_id, p.label]));
  for (const a of snap.agents) a.label ??= labels.get(a.pane_id) ?? undefined;
  return snap;
}

/** 사용자의 실제 herdr 화면을 그 pane 으로 옮긴다(pane·tab·workspace 가 한 번에 따라간다). */
export async function herdrFocus(paneId: string): Promise<void> {
  await herdrRpc("pane.focus", { pane_id: paneId });
}

/** pane 의 지금 보이는 화면. `visible` 은 뷰포트만 읽으므로 사용자의 터미널을 스크롤시키지 않는다. */
export async function herdrScreen(paneId: string): Promise<string> {
  const result = await herdrRpc<{ read: { text: string } }>("pane.read", {
    pane_id: paneId,
    source: "visible",
    lines: 200,
    format: "text",
  });
  return result.read.text;
}

// ── 조작 ───────────────────────────────────────────────────────────────────────────────────────
//
// 만들 때는 늘 focus:false 다 — 월드에서 한 일이 사용자의 herdr 화면을 끌고 다니지 않게.
// close_group·force·trust_repository 는 부르는 쪽이 명시했을 때만 싣는다.

/** 새 pane 의 셸이 준비되기를 기다려 주는 시간. */
const SHELL_READY_MS = 8000;

export type TermSource = "visible" | "recent";

/** 색상(SGR) 이 살아 있는 화면. `recent` 는 스크롤백까지 읽되 사용자의 스크롤 위치는 건드리지 않는다. */
export async function herdrTerm(paneId: string, source: TermSource, lines?: number): Promise<string> {
  const result = await herdrRpc<{ read: { text: string } }>("pane.read", { pane_id: paneId, source, format: "ansi", ...(lines ? { lines } : {}) }, 5000);
  return result.read.text;
}

/** 지시를 입력창에 넣고 제출한다. 질문에 막힌 에이전트면 herdr 가 `agent_blocked` 로 거절한다. */
export async function herdrPrompt(paneId: string, text: string): Promise<void> {
  await herdrRpc("agent.prompt", { target: paneId, text }, 10_000);
}

/** 글자와 논리 키를 차례로 넣는다. 논리 키(enter, esc, up, shift+tab …)는 herdr 가 pane 의 모드에 맞춰 인코딩한다. */
export async function herdrInput(paneId: string, text: string | undefined, keys: string[] | undefined): Promise<void> {
  await herdrRpc("pane.send_input", { pane_id: paneId, ...(text ? { text } : {}), ...(keys?.length ? { keys } : {}) }, 5000);
}

/** 가공하지 않은 바이트(제어 문자, 이스케이프 시퀀스)를 그대로 넣는다. */
export async function herdrRaw(paneId: string, text: string): Promise<void> {
  await herdrRpc("pane.send_text", { pane_id: paneId, text }, 5000);
}

export interface Created {
  workspaceId?: string;
  tabId?: string;
  paneId?: string;
}

interface CreateResult {
  workspace?: { workspace_id: string };
  tab?: { tab_id: string };
  root_pane?: { pane_id: string };
  pane?: { pane_id: string };
}

function created(r: CreateResult): Created {
  return { workspaceId: r.workspace?.workspace_id, tabId: r.tab?.tab_id, paneId: r.root_pane?.pane_id ?? r.pane?.pane_id };
}

export async function herdrCreateWorkspace(cwd: string, label?: string): Promise<Created> {
  return created(await herdrRpc<CreateResult>("workspace.create", { cwd, focus: false, ...(label ? { label } : {}) }, 10_000));
}

export interface WorktreeRequest {
  workspaceId?: string;
  cwd?: string;
  branch?: string;
  base?: string;
  label?: string;
  trust?: boolean;
}

export async function herdrCreateWorktree(req: WorktreeRequest): Promise<Created> {
  const params: Record<string, unknown> = { focus: false };
  if (req.workspaceId) params.workspace_id = req.workspaceId;
  else if (req.cwd) params.cwd = req.cwd;
  if (req.branch) params.branch = req.branch;
  if (req.base) params.base = req.base;
  if (req.label) params.label = req.label;
  if (req.trust) params.trust_repository = true;
  return created(await herdrRpc<CreateResult>("worktree.create", params, 30_000));
}

export async function herdrCreateTab(workspaceId: string, label?: string, cwd?: string): Promise<Created> {
  return created(await herdrRpc<CreateResult>("tab.create", { workspace_id: workspaceId, focus: false, ...(label ? { label } : {}), ...(cwd ? { cwd } : {}) }, 10_000));
}

export async function herdrSplit(paneId: string, direction: "right" | "down"): Promise<Created> {
  return created(await herdrRpc<CreateResult>("pane.split", { target_pane_id: paneId, direction, focus: false }, 10_000));
}

/** 셸 pane 에서 에이전트를 띄운다. herdr 는 명령을 넣자마자 돌아오고, 준비됐는지는 스냅샷으로 따라간다. */
export async function herdrStartAgent(paneId: string, kind: string, name: string, args: string[]): Promise<void> {
  // 방금 만든 pane 은 셸이 프롬프트에 닿기 전이라 herdr 가 "바쁘다"고 거절한다. 잠깐씩 다시 시도한다.
  const deadline = Date.now() + SHELL_READY_MS;
  for (;;) {
    try {
      await herdrRpc("agent.start", { pane_id: paneId, kind, name, ...(args.length ? { args } : {}) }, 35_000);
      return;
    } catch (e) {
      if (!(e instanceof HerdrError) || e.code !== "agent_pane_busy" || Date.now() > deadline) throw e;
      await new Promise((r) => setTimeout(r, 400));
    }
  }
}

export type Kind = "workspace" | "tab" | "pane" | "agent";

export async function herdrRename(kind: Kind, id: string, label: string): Promise<void> {
  if (kind === "workspace") await herdrRpc("workspace.rename", { workspace_id: id, label });
  else if (kind === "tab") await herdrRpc("tab.rename", { tab_id: id, label });
  else if (kind === "pane") await herdrRpc("pane.rename", { pane_id: id, label: label || null });
  else await herdrRpc("agent.rename", { target: id, name: label || null });
}

export interface CloseOptions {
  /** 워크트리로 묶인 스페이스들을 함께 닫는다. */
  group?: boolean;
  /** 스페이스를 닫으면서 워크트리 체크아웃도 지운다. */
  removeWorktree?: boolean;
  /** 커밋하지 않은 변경이 있어도 워크트리를 지운다. */
  force?: boolean;
}

/**
 * 닫는다. 돌려주는 값은 닫은 자리에 빈 셸을 남겼는지다.
 *
 * 워크트리 묶음의 본채(연결된 워크트리 스페이스가 딸린 원 저장소 스페이스)에 남은 마지막 pane·탭은 herdr 가
 * `confirmation_required` 로 닫지 않는다 — 본채가 닫히면 묶음이 통째로 닫혀야 하기 때문이다. pane·탭 닫기에는 묶음
 * 옵션이 없고, 사용자가 닫으려던 것은 그 pane 하나다. 그래서 같은 자리에 빈 셸을 먼저 세우고 다시 닫는다. 본채는 남는다.
 */
export async function herdrClose(kind: Kind, id: string, options: CloseOptions = {}): Promise<{ replaced?: boolean }> {
  if (kind === "workspace" && options.removeWorktree) {
    await herdrRpc("worktree.remove", { workspace_id: id, ...(options.force ? { force: true } : {}) }, 30_000);
    return {};
  }
  if (kind === "workspace") {
    await herdrRpc("workspace.close", { workspace_id: id, ...(options.group ? { close_group: true } : {}) }, 10_000);
    return {};
  }
  const close = () => (kind === "tab" ? herdrRpc("tab.close", { tab_id: id }, 10_000) : herdrRpc("pane.close", { pane_id: id }, 10_000));
  try {
    await close();
    return {};
  } catch (e) {
    if (!(e instanceof HerdrError) || e.code !== "confirmation_required") throw e;
  }
  if (kind === "tab") {
    const snap = await herdrSnapshot();
    const workspaceId = snap.tabs.find((tab) => tab.tab_id === id)?.workspace_id;
    if (!workspaceId) throw new HerdrError(L(`탭을 찾지 못했습니다: ${id}`, `Tab not found: ${id}`));
    const cwd = snap.panes.find((p) => p.tab_id === id)?.cwd;
    await herdrCreateTab(workspaceId, undefined, cwd);
  } else await herdrSplit(id, "right");
  await close();
  return { replaced: true };
}

/** herdr 가 알아보는 에이전트 종류들(감지 매니페스트 기준). */
export async function herdrAgentKinds(): Promise<string[]> {
  const result = await herdrRpc<{ manifests?: Array<{ agent?: string }> }>("server.agent_manifests");
  return (result.manifests ?? []).map((m) => m.agent ?? "").filter(Boolean);
}
