// 스냅샷을 한 번 만들어 표로 찍는다 — 서버를 띄우지 않고 데이터 결합을 확인할 때 쓴다.
import { World } from "./world.ts";

const world = new World(false, process.env.AGENT_WORLD_OUTSIDE === "1");
await world.snapshot();
// 로그 탐색은 첫 스냅샷이 띄워 놓고 끝나기를 기다리지 않으므로, 한 박자 뒤에 다시 만든다.
await new Promise((r) => setTimeout(r, 1500));
const t0 = performance.now();
const snap = await world.snapshot();
const ms = (performance.now() - t0).toFixed(1);

console.log(`herdr=${snap.herdr}${snap.herdrError ? ` (${snap.herdrError})` : ""} workspaces=${snap.workspaces.length} agents=${snap.agents.length} (두 번째 스냅샷 ${ms}ms)`);
for (const a of snap.agents) {
  const act = a.activity ? `${a.activity.kind}${a.activity.name ? `:${a.activity.name}` : ""} ${a.activity.text.slice(0, 50)}` : "-";
  const ctx = a.contextTokens ? `${Math.round(a.contextTokens / 1000)}k` : "-";
  console.log(
    [
      a.id.slice(0, 22).padEnd(22),
      a.vendor.padEnd(6),
      a.status.padEnd(7),
      (a.model ?? "-").padEnd(24),
      (a.effort ?? "-").padEnd(6),
      ctx.padStart(5),
      `sub=${a.subagents}`,
      `#${a.workspaceNumber} ${a.workspaceLabel.slice(0, 14)}`.padEnd(20),
      `| ${a.title.slice(0, 34)}`.padEnd(38),
      `| ${act}`,
    ].join(" "),
  );
}
if (process.argv.includes("--json")) console.log(JSON.stringify(snap, null, 1));
