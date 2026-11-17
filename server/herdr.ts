// herdr 소켓 RPC. 줄 단위 JSON 이고 요청 하나에 연결 하나다(서버가 응답 뒤 연결을 닫는다).
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

export function herdrSocketPath(): string {
  return process.env.HERDR_SOCKET_PATH || join(homedir(), ".config", "herdr", "herdr.sock");
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
    const timer = setTimeout(() => finish(new HerdrError(`herdr ${method} 응답 시간 초과`)), timeoutMs);
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
}

export interface HerdrWorkspace {
  workspace_id: string;
  number: number;
  label: string;
  focused?: boolean;
  tokens?: { topic?: string };
  worktree?: { repo_name?: string };
}

export interface HerdrTab {
  tab_id: string;
  workspace_id: string;
  label?: string;
}

export interface HerdrSnapshot {
  focused_pane_id?: string;
  workspaces: HerdrWorkspace[];
  tabs: HerdrTab[];
  panes: HerdrPane[];
  agents: HerdrPane[];
}

export async function herdrSnapshot(): Promise<HerdrSnapshot> {
  const result = await herdrRpc<{ snapshot: HerdrSnapshot }>("session.snapshot");
  return result.snapshot;
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
