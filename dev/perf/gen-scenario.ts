// 프레임 검사(dev/perf/run.ts)가 쓰는 고정 시나리오를 만든다: 스페이스 14개, 에이전트 22명(벤더·상태가 섞임), 셸 몇 개.
// 에이전트의 화면에는 {t} 줄이 있어, 골랐을 때 가운데 터미널이 쉬지 않고 흐른다(dev/mock-herdr.ts 가 읽을 때마다 바꾼다).
//   bun dev/perf/gen-scenario.ts dev/perf/scenario.json
export {};
const names = ["billing-api", "web-shop", "search", "infra", "docs-site", "mobile-app", "auth", "data-pipeline", "design-system", "notifier", "cli-tools", "payments", "analytics", "playground"];
const vendors = ["claude", "codex", "agy", "claude", "claude", "codex"];
const statuses = ["working", "working", "idle", "done", "blocked", "working", "idle", "done", "working", "idle", "working"];
const tasks = ["API 응답 캐시 정리", "결제 실패 재시도", "검색 색인 재구축", "배포 스크립트 손보기", "문서 목차 다듬기", "로그인 흐름 테스트", "알림 묶음 보내기", "대시보드 차트 고치기", "빌드 시간 줄이기", "타입 오류 정리", "CI 캐시 설정", "에러 화면 개선"];
const workspaces: object[] = [];
const tabs: object[] = [];
const panes: object[] = [];
const agents: object[] = [];
let k = 0;
names.forEach((label, i) => {
  const wid = `w${i + 1}`;
  workspaces.push({ workspace_id: wid, number: i + 1, label, focused: i === 0 });
  tabs.push({ tab_id: `${wid}:t1`, workspace_id: wid, label: "1", number: 1 });
  const n = 1 + (i % 3 === 0 ? 2 : i % 2);
  for (let j = 0; j < n && agents.length < 22; j++) {
    const pid = `${wid}:p${j + 1}`;
    const vendor = vendors[k % vendors.length]!;
    const status = statuses[k % statuses.length]!;
    const task = tasks[k % tasks.length]!;
    const screen = [`\x1b[1m${task}\x1b[0m`, "", "  파일을 읽고 고치는 중입니다.", `  \x1b[38;5;3m✻\x1b[0m 생각하는 중… {t}s`, "", "> "];
    const p = { pane_id: pid, workspace_id: wid, tab_id: `${wid}:t1`, cwd: `/home/dev/${label}`, agent: vendor, name: `${vendor}-${k + 1}`, agent_status: status, state_change_seq: 1, terminal_title_stripped: task, screen };
    panes.push(p);
    agents.push({ ...p });
    k++;
  }
  if (i % 4 === 1) panes.push({ pane_id: `${wid}:p9`, workspace_id: wid, tab_id: `${wid}:t1`, cwd: `/home/dev/${label}`, agent_status: "unknown", terminal_title_stripped: "dev@box:~" });
});
await Bun.write(process.argv[2] ?? "dev/perf/scenario.json", `${JSON.stringify({ workspaces, tabs, panes, agents }, null, 1)}\n`);
console.log(workspaces.length, "workspaces", agents.length, "agents", panes.length - agents.length, "shells");
