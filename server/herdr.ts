// herdr 소켓 RPC. 줄 단위 JSON 이고 요청 하나에 연결 하나다(서버가 응답 뒤 연결을 닫는다).
import { createHash } from "node:crypto";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

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
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

let seq = 0;

export function herdrRpc<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs = 3000): Promise<T> {
  return new Promise((resolve, reject) => {
    const id = `agent-world:${++seq}`;
    const socket = createConnection(herdrSocketPath());
    const chunks: Buffer[] = [];
    let settled = false;
    const finish = (err: Error | null, value?: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (err) reject(err);
      else resolve(value as T);
    };
    const timer = setTimeout(() => finish(new HerdrError(`herdr ${method} 응답 시간 초과`, "timeout")), timeoutMs);
    const parse = () => {
      const text = Buffer.concat(chunks).toString("utf8").trim();
      if (!text) return finish(new HerdrError(`herdr ${method} 응답 없음`));
      try {
        const reply = JSON.parse(text.split("\n")[0]!) as { result?: T; error?: { code?: string; message?: string } };
        if (reply.error) return finish(new HerdrError(reply.error.message || "herdr 오류", reply.error.code));
        finish(null, reply.result as T);
      } catch (e) {
        finish(new HerdrError(`herdr ${method} 응답을 읽지 못함: ${(e as Error).message}`));
      }
    };
    socket.on("connect", () => socket.write(`${JSON.stringify({ id, method, params })}\n`));
    socket.on("data", (c: Buffer) => {
      chunks.push(c);
      if (c[c.length - 1] === 0x0a) parse();
    });
    socket.on("end", parse);
    socket.on("error", (e) => finish(new HerdrError(`herdr 소켓 연결 실패: ${e.message}`)));
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
}

export interface HerdrWorkspace {
  workspace_id: string;
  number: number;
  label: string;
  focused?: boolean;
  tokens?: { topic?: string };
  worktree?: { repo_name?: string; checkout_path?: string; is_linked_worktree?: boolean };
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

export async function herdrClose(kind: Kind, id: string, options: CloseOptions = {}): Promise<void> {
  if (kind === "workspace" && options.removeWorktree) {
    await herdrRpc("worktree.remove", { workspace_id: id, ...(options.force ? { force: true } : {}) }, 30_000);
  } else if (kind === "workspace") {
    await herdrRpc("workspace.close", { workspace_id: id, ...(options.group ? { close_group: true } : {}) }, 10_000);
  } else if (kind === "tab") await herdrRpc("tab.close", { tab_id: id }, 10_000);
  else await herdrRpc("pane.close", { pane_id: id }, 10_000);
}

/** herdr 가 알아보는 에이전트 종류들(감지 매니페스트 기준). */
export async function herdrAgentKinds(): Promise<string[]> {
  const result = await herdrRpc<{ manifests?: Array<{ agent?: string }> }>("server.agent_manifests");
  return (result.manifests ?? []).map((m) => m.agent ?? "").filter(Boolean);
}
