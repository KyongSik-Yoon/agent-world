// herdr 흉내 소켓 — 실제 herdr 를 건드리지 않고 화면을 시험할 때 쓴다.
//
//   bun dev/mock-herdr.ts <소켓 경로> <시나리오.json>
//   HERDR_SOCKET_PATH=<소켓 경로> AGENT_WORLD_PORT=4781 bun server/index.ts
//   MOCK_DELAY="agent.prompt=12000" 을 주면 그 메서드의 답을 늦춘다(시간 초과 시험).
//
// 시나리오 파일이 바뀌면 다시 읽으므로, 파일의 agent_status 를 고치면 화면의 캐릭터가 따라 움직인다.
// 조작 요청(지시·키 입력·만들기·닫기)은 메모리 안의 상태만 바꾸고, 받은 요청을 표준 출력에 적는다.
// 실제 herdr 의 동작(붙여넣기 모드, 질문 감지, 시작 대기)까지 확인하려면 이름 붙은 테스트 세션을 쓴다:
//   herdr --session aw-test server   →   HERDR_SOCKET_PATH=~/.config/herdr/sessions/aw-test/herdr.sock
import { statSync, unlinkSync } from "node:fs";
import { createServer } from "node:net";

interface Pane {
  pane_id: string;
  workspace_id: string;
  tab_id: string;
  cwd?: string;
  label?: string | null;
  agent?: string;
  name?: string | null;
  agent_status?: string;
  state_change_seq?: number;
  terminal_title_stripped?: string;
  [key: string]: unknown;
}

interface State {
  workspaces: Array<{ workspace_id: string; number: number; label: string; [key: string]: unknown }>;
  tabs: Array<{ tab_id: string; workspace_id: string; label: string; number?: number }>;
  panes: Pane[];
  agents: Pane[];
  [key: string]: unknown;
}

const [socketPath, scenarioPath] = process.argv.slice(2);
if (!socketPath || !scenarioPath) {
  console.error("사용법: bun dev/mock-herdr.ts <소켓 경로> <시나리오.json>");
  process.exit(1);
}
try {
  unlinkSync(socketPath);
} catch {
  // 남아 있던 소켓이 없으면 그만이다.
}

let state: State | undefined;
let loadedAt = 0;
let counter = 100;
const screens = new Map<string, string[]>();

async function load(): Promise<State> {
  const mtime = statSync(scenarioPath!).mtimeMs;
  if (!state || mtime !== loadedAt) {
    state = (await Bun.file(scenarioPath!).json()) as State;
    state.tabs ??= [];
    state.panes ??= [];
    state.agents ??= [];
    loadedAt = mtime;
  }
  return state;
}

function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { code });
}

function screen(paneId: string): string[] {
  let lines = screens.get(paneId);
  if (!lines) screens.set(paneId, (lines = [`\x1b[1m\x1b[38;5;2m(흉내 화면)\x1b[0m ${paneId}`, "$ "]));
  return lines;
}

function paneOf(s: State, id: unknown): Pane {
  return s.panes.find((p) => p.pane_id === id) ?? s.agents.find((p) => p.pane_id === id) ?? fail("pane_not_found", `pane ${String(id)} not found`);
}

function bump(pane: Pane, status: string): void {
  pane.agent_status = status;
  pane.state_change_seq = (pane.state_change_seq ?? 0) + 1;
}

function addPane(s: State, workspaceId: string, tabId: string, cwd?: string): Pane {
  const pane: Pane = { pane_id: `${workspaceId}:p${(counter += 1)}`, workspace_id: workspaceId, tab_id: tabId, cwd, agent_status: "unknown", terminal_title_stripped: "mock@shell" };
  s.panes.push(pane);
  return pane;
}

function addTab(s: State, workspaceId: string, label?: string): { tab_id: string; workspace_id: string; label: string; number: number } {
  const number = s.tabs.filter((t) => t.workspace_id === workspaceId).length + 1;
  const tab = { tab_id: `${workspaceId}:t${(counter += 1)}`, workspace_id: workspaceId, label: label ?? String(number), number };
  s.tabs.push(tab);
  return tab;
}

function removePanes(s: State, match: (p: Pane) => boolean): void {
  s.panes = s.panes.filter((p) => !match(p));
  s.agents = s.agents.filter((p) => !match(p));
}

/** 느린 herdr 흉내: `MOCK_DELAY="agent.prompt=12000,pane.read=6000"` 처럼 메서드별로 답을 늦춘다(ms). */
const delays = new Map((process.env.MOCK_DELAY ?? "").split(",").filter(Boolean).map((pair) => pair.split("=") as [string, string]));

async function handle(method: string, p: Record<string, unknown>): Promise<unknown> {
  const delay = Number(delays.get(method) ?? 0);
  if (delay > 0) await Bun.sleep(delay);
  const s = await load();
  if (method !== "session.snapshot" && method !== "pane.read") console.log(method, JSON.stringify(p));
  switch (method) {
    case "session.snapshot":
      return { type: "session_snapshot", snapshot: s };
    case "pane.focus":
      paneOf(s, p.pane_id);
      return { type: "pane_info" };
    case "pane.read":
      paneOf(s, p.pane_id);
      return { type: "pane_read", read: { text: screen(String(p.pane_id)).join("\r\n") } };
    case "pane.send_input":
    case "pane.send_text": {
      paneOf(s, p.pane_id);
      const lines = screen(String(p.pane_id));
      const keys = Array.isArray(p.keys) ? (p.keys as string[]) : [];
      for (const key of keys) if (!/^((ctrl|alt|shift)\+)*(enter|esc|tab|backspace|up|down|left|right|space|f\d+|.)$/i.test(key)) fail("invalid_key", `unsupported key ${key}`);
      lines[lines.length - 1] += `${typeof p.text === "string" ? p.text : ""}${keys.filter((k) => k !== "enter").map((k) => `<${k}>`).join("")}`;
      if (keys.includes("enter")) lines.push("$ ");
      return { type: "ok" };
    }
    case "agent.prompt": {
      const pane = s.agents.find((a) => a.pane_id === p.target) ?? fail("agent_not_found", `agent ${String(p.target)} not found`);
      if (pane.agent_status === "blocked") fail("agent_blocked", "agent is waiting at an approval or question dialog");
      screen(pane.pane_id).push(`> ${String(p.text)}`);
      bump(pane, "working");
      setTimeout(() => bump(pane, "done"), 4000);
      return { type: "agent_prompted" };
    }
    case "agent.start": {
      const pane = paneOf(s, p.pane_id);
      if (pane.agent) fail("agent_pane_busy", `agent target pane ${pane.pane_id} is not an available shell`);
      Object.assign(pane, { agent: String(p.kind), name: String(p.name), agent_status: "idle", state_change_seq: 1, terminal_title_stripped: String(p.kind) });
      s.agents.push(pane);
      return { type: "agent_started" };
    }
    case "workspace.create":
    case "worktree.create": {
      const id = `w${(counter += 1)}`;
      const label = typeof p.label === "string" ? p.label : String(p.cwd ?? id).split("/").pop()!;
      const workspace = { workspace_id: id, number: s.workspaces.length + 1, label };
      s.workspaces.push(workspace);
      const tab = addTab(s, id);
      return { type: "workspace_created", workspace, tab, root_pane: addPane(s, id, tab.tab_id, typeof p.cwd === "string" ? p.cwd : undefined) };
    }
    case "tab.create": {
      const tab = addTab(s, String(p.workspace_id), typeof p.label === "string" ? p.label : undefined);
      return { type: "tab_created", tab, root_pane: addPane(s, tab.workspace_id, tab.tab_id) };
    }
    case "pane.split": {
      const from = paneOf(s, p.target_pane_id);
      return { type: "pane_split", pane: addPane(s, from.workspace_id, from.tab_id, from.cwd) };
    }
    case "workspace.rename":
      (s.workspaces.find((w) => w.workspace_id === p.workspace_id) ?? fail("workspace_not_found", "workspace not found")).label = String(p.label);
      return { type: "ok" };
    case "tab.rename":
      (s.tabs.find((t) => t.tab_id === p.tab_id) ?? fail("tab_not_found", "tab not found")).label = String(p.label);
      return { type: "ok" };
    case "pane.rename":
      paneOf(s, p.pane_id).label = typeof p.label === "string" ? p.label : null;
      return { type: "ok" };
    case "agent.rename":
      paneOf(s, p.target).name = typeof p.name === "string" ? p.name : null;
      return { type: "ok" };
    case "workspace.close":
    case "worktree.remove":
      s.workspaces = s.workspaces.filter((w) => w.workspace_id !== p.workspace_id);
      s.tabs = s.tabs.filter((t) => t.workspace_id !== p.workspace_id);
      removePanes(s, (x) => x.workspace_id === p.workspace_id);
      return { type: "ok" };
    case "tab.close":
      s.tabs = s.tabs.filter((t) => t.tab_id !== p.tab_id);
      removePanes(s, (x) => x.tab_id === p.tab_id);
      return { type: "ok" };
    case "pane.close":
      removePanes(s, (x) => x.pane_id === p.pane_id);
      return { type: "ok" };
    case "server.agent_manifests":
      return { type: "agent_manifest_status", manifests: ["claude", "codex", "agy"].map((agent) => ({ agent })) };
    default:
      return fail("unknown_method", method);
  }
}

createServer((socket) => {
  let buffer = "";
  // 기다리다 끊은 상대에게 쓰다가 흉내 소켓이 통째로 죽지 않게 한다.
  socket.on("error", () => {});
  socket.on("data", async (chunk) => {
    buffer += chunk.toString("utf8");
    if (!buffer.includes("\n")) return;
    const request = JSON.parse(buffer.split("\n")[0]!) as { id: string; method: string; params?: Record<string, unknown> };
    try {
      socket.end(`${JSON.stringify({ id: request.id, result: await handle(request.method, request.params ?? {}) })}\n`);
    } catch (e) {
      const err = e as Error & { code?: string };
      socket.end(`${JSON.stringify({ id: request.id, error: { code: err.code ?? "internal", message: err.message } })}\n`);
    }
  });
}).listen(socketPath, () => console.log(`mock herdr → ${socketPath}`));
