// herdr 흉내 소켓 — 실제 herdr 를 건드리지 않고 화면을 시험할 때 쓴다.
//
//   bun dev/mock-herdr.ts <소켓 경로> <시나리오.json>
//   HERDR_SOCKET_PATH=<소켓 경로> AGENT_WORLD_PORT=4781 bun server/index.ts
//
// session.snapshot 을 받을 때마다 시나리오 파일을 다시 읽으므로, 파일의 agent_status 를 고치면
// 화면의 캐릭터가 따라 움직인다. pane.focus 는 받은 pane id 를 표준 출력에 적기만 한다.
import { unlinkSync } from "node:fs";
import { createServer } from "node:net";

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

createServer((socket) => {
  let buffer = "";
  socket.on("data", async (chunk) => {
    buffer += chunk.toString("utf8");
    if (!buffer.includes("\n")) return;
    const request = JSON.parse(buffer.split("\n")[0]!) as { id: string; method: string; params: { pane_id?: string } };
    let result: unknown;
    if (request.method === "session.snapshot") {
      result = { type: "session_snapshot", snapshot: await Bun.file(scenarioPath).json() };
    } else if (request.method === "pane.focus") {
      console.log(`pane.focus ${request.params.pane_id}`);
      result = { type: "pane_info" };
    } else if (request.method === "pane.read") {
      result = { type: "pane_read", read: { text: `$ (흉내 화면) ${request.params.pane_id}\n> 여기에 터미널 화면이 보입니다.` } };
    } else {
      socket.end(`${JSON.stringify({ id: request.id, error: { code: "unknown_method", message: request.method } })}\n`);
      return;
    }
    socket.end(`${JSON.stringify({ id: request.id, result })}\n`);
  });
}).listen(socketPath, () => console.log(`mock herdr → ${socketPath}`));
