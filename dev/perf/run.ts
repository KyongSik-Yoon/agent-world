// 화면 프레임 검사. 작업 폴더의 코드로 서버를 띄우고 GPU 헤드리스 크롬에서 고정 시나리오를 돌려,
// "장면 밖에서 화면을 내보내지 않는다"와 "조용해야 할 때 장면 박자가 오르지 않는다"를 잰다.
//
//   bun run perf                    불변식만 본다(2분 남짓). 통과하면 web/ 트리의 통과 기록을 남긴다(.githooks/pre-push 가 본다).
//   bun run perf --compare [ref]    ref(기본 origin/main)와 번갈아 재서 비용을 표로 비교한다(경고만, 막지 않는다).
//   bun run perf --rounds 3         --compare 의 번갈아 재는 횟수(기본 3).
//   bun run perf --only 끌기,평소    그 시나리오만(기록은 남기지 않는다).
//
// 읽는 법과 함정은 .claude/skills/ui-perf/SKILL.md.
import { $, type Subprocess } from "bun";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CDP } from "./cdp.ts";

const ROOT = (await $`git rev-parse --show-toplevel`.text()).trim();
const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  if (i < 0) return undefined;
  const next = argv[i + 1];
  return next && !next.startsWith("--") ? next : "";
};
const compareRef = flag("--compare") === "" ? "origin/main" : flag("--compare");
const rounds = compareRef ? Number(flag("--rounds") || 3) : 1;
const only = flag("--only")?.split(",").filter(Boolean);
const CHROME = process.env.CHROME ?? "google-chrome-stable";

// ── 시나리오와 불변식 ─────────────────────────────────────────────

interface Sample {
  /** 장면이 그린 장(WebGL 그리기를 낸 rAF)/초. */
  scene: number;
  /** 화면 출력(viz Display::DrawAndSwap)/초. */
  out: number;
  /** 렌더러 메인 스레드 일한 시간(ms)/장면 장. */
  mainMs: number;
  /** 스타일을 다시 계산한 요소 수/장면 장. */
  styleEls: number;
  /** 렌더러·GPU 프로세스 CPU(코어의 %). */
  renderer: number;
  gpu: number;
}

interface Scenario {
  name: string;
  what: string;
  /** 장면 장 수가 들어야 할 범위(/초). */
  scene: [number, number];
  run(page: Page): Promise<Sample>;
}

/** 출력이 장면보다 많으면 장면 밖에서 화면을 내보낸 것이다. 반올림·경계의 한 장은 봐준다. */
const outOk = (s: Sample): boolean => s.out <= s.scene * 1.1 + 1;

const SCENARIOS: Scenario[] = [
  {
    name: "평소",
    what: "초점은 있고 입력은 없다",
    scene: [26, 34],
    run: (p) => p.measure(8),
  },
  {
    name: "장면 밖 입력",
    what: "위쪽 막대 위 포인터, 검색창에서 키 누르기",
    scene: [26, 34],
    run: async (p) => {
      const top = await p.rect("#topbar");
      await p.cdp.eval(`document.getElementById("search").focus()`);
      const s = await p.measure(6, async (until) => {
        for (let i = 0; performance.now() < until; i++) {
          await p.mouse("mouseMoved", top.x + top.w * 0.55 + Math.sin(i / 3) * 40, top.y + top.h / 2);
          if (i % 6 === 0) await p.key("Shift");
          await Bun.sleep(50);
        }
      });
      await p.cdp.eval(`document.activeElement?.blur()`);
      return s;
    },
  },
  {
    name: "끌기",
    what: "장면을 끌어 돌린다",
    scene: [48, 62],
    run: async (p) => {
      await Bun.sleep(3000);
      return p.measure(6, (until) => p.drag(until));
    },
  },
  {
    name: "고르기",
    what: "주민을 골라 가운데 터미널이 흐른다",
    scene: [26, 34],
    run: async (p) => {
      // 작업 중인 주민 — 확인 필요는 미리보기를 질문 카드 안에 품어 무대에 세우지 않는다.
      const row = await p.rect('#roster button.row[data-status="working"]');
      await p.click(row.x + row.w / 2, row.y + row.h / 2);
      await Bun.sleep(5000);
      if (!(await p.cdp.eval<boolean>(`!document.getElementById("stage").hidden`))) {
        const why = await p.cdp.eval<string>(`JSON.stringify({ w: innerWidth, h: innerHeight, roster: Math.round(document.getElementById("roster").getBoundingClientRect().right), detail: document.getElementById("detail").hidden ? "숨김" : Math.round(document.getElementById("detail").getBoundingClientRect().left) })`);
        throw new Error(`무대(가운데 터미널)가 열리지 않았다 ${why}`);
      }
      // 터미널이 정말 흐르는지(시나리오의 {t} 줄) — 멈춘 화면을 재면 이 시나리오는 아무것도 지키지 못한다.
      const text = () => p.cdp.eval<string>(`document.getElementById("stage").innerText`);
      const before = await text();
      await Bun.sleep(1200);
      if ((await text()) === before) throw new Error("가운데 터미널이 흐르지 않는다 — 시나리오의 {t} 줄을 확인한다");
      return p.measure(8);
    },
  },
  {
    name: "곁눈질",
    what: "20초 넘게 입력이 없다(고른 주민의 터미널은 계속 흐른다)",
    scene: [2, 4.5],
    run: async (p) => {
      await Bun.sleep(22_000);
      return p.measure(9);
    },
  },
  {
    // 전체 보기(/all)는 3D 장면이 없다. 걷는 캐릭터가 없으면 화면이 한 장도 나가지 않아야 한다.
    name: "전체 보기·쉼",
    what: "/all — 월드 둘, 상태가 그대로다",
    scene: [0, 1],
    run: async (p) => {
      await p.loadAll();
      return p.measure(8);
    },
  },
  {
    name: "전체 보기·걷기",
    what: "/all — 곁 월드의 상태가 1초에 한 번 바뀐다(걷기 박자는 30장을 넘지 않는다)",
    scene: [15, 33],
    run: async (p) => {
      await p.loadAll();
      return p.measure(8, async (until) => {
        for (let i = 0; performance.now() < until; i++) {
          flipSide(i);
          await Bun.sleep(1000);
        }
      });
    },
  },
  {
    name: "끌기·박자 거르기",
    what: "?perf-skip=1 — 120Hz 화면처럼 한 박자씩 걸러 그린다",
    scene: [20, 34],
    run: async (p) => {
      await p.load("perf-skip=1");
      await Bun.sleep(3000);
      return p.measure(6, (until) => p.drag(until));
    },
  },
];

// ── 페이지 조작과 측정 ─────────────────────────────────────────────

const INIT = `
window.__renders = 0;
{
  let draws = 0;
  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (f) => raf((t) => { const d = draws; f(t); if (draws > d) window.__renders++; });
  for (const C of [window.WebGL2RenderingContext, window.WebGLRenderingContext]) {
    if (!C) continue;
    for (const n of ["drawElements", "drawArrays", "drawElementsInstanced", "drawArraysInstanced", "drawRangeElements"]) {
      const o = C.prototype[n];
      if (o) C.prototype[n] = function () { draws++; return o.apply(this, arguments); };
    }
  }
}`;

class Page {
  constructor(
    readonly cdp: CDP,
    private readonly url: string,
    private readonly profile: string,
  ) {}

  async load(query = ""): Promise<void> {
    const [base, hash] = this.url.split("#");
    await this.cdp.send("Page.navigate", { url: `${base}${query ? `?${query}` : ""}#${hash}` });
    const until = performance.now() + 20_000;
    while (performance.now() < until) {
      await Bun.sleep(500);
      const ready = await this.cdp.eval<boolean>(`(window.__renders ?? 0) > 20 && !!document.querySelector("#roster button.row")`).catch(() => false);
      if (ready) break;
    }
    await this.cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    await Bun.sleep(3000);
  }

  /** 전체 보기를 연다 — 곁 월드의 열쇠를 이 출처에 적어 두고, 섬 둘이 열릴 때까지 기다린다. */
  async loadAll(): Promise<void> {
    if (!side) throw new Error("곁 월드가 없다");
    const [base, hash] = this.url.split("#");
    await this.cdp.send("Page.navigate", { url: `${base}all#${hash}` });
    await Bun.sleep(1500);
    await this.cdp.eval(`localStorage.setItem("agent-world.worlds", ${JSON.stringify(JSON.stringify({ [side.origin]: side.key }))}); location.reload()`);
    const until = performance.now() + 20_000;
    let open = 0;
    while (performance.now() < until && open < 2) {
      await Bun.sleep(500);
      open = await this.cdp.eval<number>(`document.querySelectorAll('a.world[data-state="open"]').length`).catch(() => 0);
    }
    if (open < 2) throw new Error(`전체 보기의 섬이 열리지 않았다(${open}/2)`);
    await this.cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
    await Bun.sleep(4000);
  }

  async rect(selector: string): Promise<{ x: number; y: number; w: number; h: number }> {
    const r = await this.cdp.eval(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
    if (!r) throw new Error(`${selector} 가 없다`);
    return r;
  }

  mouse(type: string, x: number, y: number, buttons = 0): Promise<unknown> {
    return this.cdp.send("Input.dispatchMouseEvent", { type, x, y, button: buttons || type !== "mouseMoved" ? "left" : "none", buttons, clickCount: type === "mouseMoved" ? 0 : 1 });
  }

  async click(x: number, y: number): Promise<void> {
    await this.mouse("mouseMoved", x, y);
    await this.mouse("mousePressed", x, y, 1);
    await this.mouse("mouseReleased", x, y, 0);
  }

  async key(key: string): Promise<void> {
    await this.cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key, code: `${key}Left`, windowsVirtualKeyCode: 16 });
    await this.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key, code: `${key}Left`, windowsVirtualKeyCode: 16 });
  }

  /** 장면 가운데를 눌러 until 까지 원을 그리며 끈다. 누른 자리가 캔버스가 아니면 실패한다(이름표를 누르면 카메라가 안 돈다). */
  async drag(until: number): Promise<void> {
    const c = await this.rect("#world canvas");
    const x = c.x + c.w * 0.5;
    const y = c.y + c.h * 0.6;
    const hit = await this.cdp.eval<string>(`document.elementFromPoint(${x}, ${y})?.tagName`);
    if (hit !== "CANVAS") throw new Error(`끌기를 시작할 자리가 캔버스가 아니다(${hit})`);
    await this.mouse("mouseMoved", x, y);
    await this.mouse("mousePressed", x, y, 1);
    const t0 = performance.now();
    while (performance.now() < until - 100) {
      const a = ((performance.now() - t0) / 1000) * 2.2;
      await this.mouse("mouseMoved", x + Math.sin(a) * 260, y + Math.sin(a * 0.7) * 60, 1);
      await Bun.sleep(8);
    }
    await this.mouse("mouseReleased", x, y, 0);
  }

  /** seconds 동안 잰다. act 는 그동안 할 일(끝낼 시각을 받는다). */
  async measure(seconds: number, act?: (until: number) => Promise<void>): Promise<Sample> {
    const events: any[] = [];
    this.cdp.on("Tracing.dataCollected", (p) => events.push(...p.value));
    const done = new Promise<void>((r) => this.cdp.on("Tracing.tracingComplete", () => r()));
    await this.cdp.send("Tracing.start", { traceConfig: { includedCategories: ["viz", "devtools.timeline"] }, transferMode: "ReportEvents" });
    const metrics = async () => Object.fromEntries((await this.cdp.send("Performance.getMetrics")).metrics.map((m: any) => [m.name, m.value]));
    // 전체 보기에서는 걷기 박자가 그린 장을 센다(web/all/walk.ts).
    const frames = "window.__all ? window.__all.frames : window.__renders";
    const r0 = await this.cdp.eval<number>(frames);
    const m0 = await metrics();
    const c0 = cpu(this.profile);
    const t0 = performance.now();
    const until = t0 + seconds * 1000;
    if (act) await act(until);
    const left = until - performance.now();
    if (left > 0) await Bun.sleep(left);
    const dt = (performance.now() - t0) / 1000;
    const r1 = await this.cdp.eval<number>(frames);
    const m1 = await metrics();
    const c1 = cpu(this.profile);
    await this.cdp.send("Tracing.end");
    await done;
    const renders = Math.max(1, r1 - r0);
    const names = new Map<string, string>();
    for (const e of events) if (e.name === "thread_name") names.set(`${e.pid}:${e.tid}`, e.args.name);
    let swaps = 0;
    let styleEls = 0;
    for (const e of events) {
      if (e.name === "Display::DrawAndSwap" && e.ph === "X") swaps++;
      else if (e.name === "UpdateLayoutTree" && names.get(`${e.pid}:${e.tid}`) === "CrRendererMain" && e.args?.elementCount) styleEls += e.args.elementCount;
    }
    return {
      scene: (r1 - r0) / dt,
      out: swaps / dt,
      mainMs: ((m1.TaskDuration - m0.TaskDuration) * 1000) / renders,
      styleEls: styleEls / renders,
      renderer: ((c1.renderer - c0.renderer) / dt) * 100,
      gpu: ((c1.gpu - c0.gpu) / dt) * 100,
    };
  }
}

/** 이 프로필로 뜬 크롬 프로세스들의 CPU 초(렌더러 합, GPU 프로세스). 측정 사이에 뜨고 진 프로세스는 차이에서 빠진다. */
function cpu(profile: string): { renderer: number; gpu: number } {
  const out = { renderer: 0, gpu: 0 };
  for (const d of readdirSync("/proc")) {
    if (!/^\d+$/.test(d)) continue;
    let cmd = "";
    try {
      cmd = readFileSync(`/proc/${d}/cmdline`, "utf8");
    } catch {
      continue;
    }
    if (!cmd.includes(profile)) continue;
    const type = /--type=([\w-]+)/.exec(cmd)?.[1];
    if (type !== "renderer" && type !== "gpu-process") continue;
    try {
      const f = readFileSync(`/proc/${d}/stat`, "utf8").split(") ")[1]!.split(" ");
      const s = (Number(f[11]) + Number(f[12])) / 100;
      if (type === "renderer") out.renderer += s;
      else out.gpu += s;
    } catch {}
  }
  return out;
}

// ── 띄우고 거두기 ─────────────────────────────────────────────────

const children: Subprocess[] = [];
const tmp = mkdtempSync(join(tmpdir(), "aw-perf-"));
const runtime = process.env.XDG_RUNTIME_DIR && existsSync(process.env.XDG_RUNTIME_DIR) ? process.env.XDG_RUNTIME_DIR : tmp;
/** 가상 herdr 의 소켓. 경로가 길면 소켓을 못 만들어 XDG_RUNTIME_DIR 에 짧게 둔다. */
const socket = join(runtime, `awperf-${process.pid}.sock`);
const sockets: string[] = [];
let cleaned = false;
function cleanup(): void {
  if (cleaned) return;
  cleaned = true;
  // 띄운 것만 끈다(pkill -f 는 같은 문자열을 담은 다른 셸까지 잡는다).
  for (const child of children.reverse()) {
    try {
      child.kill("SIGTERM");
    } catch {}
  }
  Bun.sleepSync(500);
  for (const child of children) {
    try {
      if (child.exitCode === null) child.kill("SIGKILL");
    } catch {}
  }
  rmSync(tmp, { recursive: true, force: true });
  rmSync(socket, { force: true });
  for (const s of sockets) rmSync(s, { force: true });
}
// Ctrl-C, timeout, 닫힌 터미널 — 어떻게 끊겨도 띄운 크롬·서버·가상 herdr 를 남기지 않는다.
for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]] as const) {
  process.on(signal, () => {
    cleanup();
    process.exit(code);
  });
}
process.on("exit", cleanup);

function freePort(): number {
  const s = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = s.port;
  s.stop(true);
  return port;
}

/** 전체 보기 시나리오의 곁 월드: 제 가상 herdr(시나리오 사본)에 붙은 서버 하나. 사본의 상태를 바꿔 캐릭터를 걷게 한다. */
let side: { origin: string; key: string; file: string } | undefined;
function flipSide(i: number): void {
  if (!side) return;
  const state = JSON.parse(readFileSync(side.file, "utf8")) as { agents: Array<{ pane_id: string; agent_status: string; state_change_seq?: number }>; panes: Array<{ pane_id: string; agent_status?: string; state_change_seq?: number }> };
  const agent = state.agents[i % state.agents.length]!;
  const next = ["working", "blocked", "done", "idle"].filter((s) => s !== agent.agent_status)[i % 3]!;
  for (const p of [agent, state.panes.find((x) => x.pane_id === agent.pane_id)]) {
    if (!p) continue;
    p.agent_status = next;
    p.state_change_seq = 1000 + i;
  }
  writeFileSync(side.file, JSON.stringify(state));
}

async function startServer(dir: string, label: string, socket: string, extra: Record<string, string> = {}): Promise<string> {
  const port = freePort();
  const home = join(tmp, label);
  for (const sub of ["state", "config", "claude", "codex", "agy"]) mkdirSync(join(home, sub), { recursive: true });
  const log = join(home, "server.log");
  children.push(
    Bun.spawn(["bun", "server/index.ts"], {
      cwd: dir,
      env: {
        ...process.env,
        HERDR_SOCKET_PATH: socket,
        // 실제 세션의 로그·설정·사용량이 끼어들지 않게 다 비운 폴더로 돌린다.
        XDG_STATE_HOME: join(home, "state"),
        XDG_CONFIG_HOME: join(home, "config"),
        CLAUDE_CONFIG_DIR: join(home, "claude"),
        CODEX_HOME: join(home, "codex"),
        AGY_HOME: join(home, "agy"),
        AGENT_WORLD_PORT: String(port),
        AGENT_WORLD_READONLY: "1",
        AGENT_WORLD_RAISE: "0",
        AGENT_WORLD_LANG: "ko",
        AGENT_WORLD_DEV: "",
        ...extra,
      },
      stdout: Bun.file(log),
      stderr: Bun.file(`${log}.err`),
    }),
  );
  for (let i = 0; i < 60; i++) {
    await Bun.sleep(250);
    const m = existsSync(log) ? /http:\/\/127\.0\.0\.1:\d+\/#k=[0-9a-f]+/.exec(readFileSync(log, "utf8")) : null;
    if (m) return m[0];
  }
  throw new Error(`${label} 서버가 뜨지 않았다:\n${readFileSync(`${log}.err`, "utf8").slice(-800)}`);
}

async function startChrome(): Promise<CDP> {
  const port = freePort();
  const profile = join(tmp, "chrome");
  const chrome = Bun.spawn(
    [CHROME, "--headless=new", "--enable-gpu", "--use-angle=vulkan", "--ignore-gpu-blocklist", `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, "--window-size=1600,1000", "--force-device-scale-factor=1", "--no-first-run", "--no-default-browser-check", "about:blank"],
    { stdout: "ignore", stderr: "ignore" },
  );
  children.push(chrome);
  for (let i = 0; i < 40; i++) {
    await Bun.sleep(250);
    // 그 포트를 쥔 것이 방금 띄운 크롬인지 본다 — 포트가 겹치면 남의 크롬(다른 세션의 벤치)에 붙는다.
    const owner = /pid=(\d+)/.exec(await $`ss -ltnpH ${`sport = :${port}`}`.text().catch(() => ""))?.[1];
    if (!owner) continue;
    const cmd = readFileSync(`/proc/${owner}/cmdline`, "utf8");
    if (!cmd.includes(profile)) throw new Error(`포트 ${port} 를 다른 프로세스(${owner})가 쥐고 있다`);
    const list = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as any[];
    const cdp = await CDP.connect(list.find((t) => t.type === "page").webSocketDebuggerUrl);
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Performance.enable");
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: INIT });
    return cdp;
  }
  throw new Error(`크롬(${CHROME})이 뜨지 않았다`);
}

// ── 돌리기 ─────────────────────────────────────────────────────

type Build = { label: string; url: string };
type Results = Map<string, Map<string, Array<Sample | Error>>>; // build → scenario → 회차별

async function runBuild(cdp: CDP, build: Build, results: Results, scenarios: Scenario[]): Promise<void> {
  const page = new Page(cdp, build.url, join(tmp, "chrome"));
  await page.load();
  const byName = results.get(build.label) ?? new Map();
  results.set(build.label, byName);
  for (const s of scenarios) {
    let sample: Sample | Error;
    try {
      sample = await s.run(page);
    } catch (e) {
      sample = e instanceof Error ? e : new Error(String(e));
    }
    (byName.get(s.name) ?? byName.set(s.name, []).get(s.name)!).push(sample);
    process.stdout.write(`  ${build.label} · ${s.name}: ${sample instanceof Error ? `오류 — ${sample.message}` : `장면 ${sample.scene.toFixed(1)}/s 출력 ${sample.out.toFixed(1)}/s`}\n`);
  }
}

const verdict = (s: Scenario, x: Sample | Error): string | null => {
  if (x instanceof Error) return x.message;
  const problems: string[] = [];
  if (x.scene < s.scene[0] || x.scene > s.scene[1]) problems.push(`장면 ${x.scene.toFixed(1)}/s 가 ${s.scene[0]}~${s.scene[1]} 밖`);
  if (!outOk(x)) problems.push(`화면 출력 ${x.out.toFixed(1)}/s 가 장면 ${x.scene.toFixed(1)}/s 보다 많다 — 장면 프레임 밖에서 화면이 나간다`);
  return problems.length ? problems.join(", ") : null;
};

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[s.length >> 1]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
};

async function main(): Promise<number> {
  const scenarios = only ? SCENARIOS.filter((s) => only.includes(s.name)) : SCENARIOS;
  if (!scenarios.length) throw new Error(`시나리오 이름: ${SCENARIOS.map((s) => s.name).join(", ")}`);
  // "끌기·박자 거르기"는 페이지를 다시 읽으니 맨 뒤에 둔다(SCENARIOS 의 차례 그대로).

  children.push(Bun.spawn(["bun", "dev/mock-herdr.ts", socket, join(ROOT, "dev/perf/scenario.json")], { cwd: ROOT, stdout: "ignore", stderr: "ignore" }));
  for (let i = 0; i < 40 && !existsSync(socket); i++) await Bun.sleep(100);

  // 곁 월드를 먼저 띄우고, 이번 판의 서버가 그것을 모아 보는 중계를 겸하게 한다.
  const sideSocket = join(runtime, `awperf-${process.pid}-side.sock`);
  const sideFile = join(tmp, "side-scenario.json");
  copyFileSync(join(ROOT, "dev/perf/scenario.json"), sideFile);
  children.push(Bun.spawn(["bun", "dev/mock-herdr.ts", sideSocket, sideFile], { cwd: ROOT, stdout: "ignore", stderr: "ignore" }));
  for (let i = 0; i < 40 && !existsSync(sideSocket); i++) await Bun.sleep(100);
  const sideUrl = new URL(await startServer(ROOT, "곁", sideSocket));
  side = { origin: sideUrl.origin, key: /k=([0-9a-f]+)/.exec(sideUrl.hash)![1]!, file: sideFile };
  sockets.push(sideSocket);

  const builds: Build[] = [{ label: "이번", url: await startServer(ROOT, "이번", socket, { AGENT_WORLD_WORLDS: `곁=${side.origin}` }) }];
  if (compareRef) {
    const dir = join(tmp, "base");
    mkdirSync(dir);
    await $`git -C ${ROOT} archive ${compareRef} | tar -x -C ${dir}`;
    symlinkSync(join(ROOT, "node_modules"), join(dir, "node_modules"));
    builds.unshift({ label: "기준", url: await startServer(dir, "기준", socket) });
  }
  const cdp = await startChrome();
  const load = readFileSync("/proc/loadavg", "utf8").split(" ")[0];
  console.log(`프레임 검사 — ${scenarios.length}개 시나리오${compareRef ? `, ${compareRef} 와 번갈아 ${rounds}회` : ""} (부하 평균 ${load})`);

  const results: Results = new Map();
  for (let r = 0; r < rounds; r++) for (const b of r % 2 ? [...builds].reverse() : builds) await runBuild(cdp, b, results, scenarios);

  // 이번 판의 불변식. 한 번만 잰 경우 어긋난 시나리오는 한 번 더 재 보고, 두 번 다 어긋나야 실패로 친다(헤드리스는 가끔 한 번 크게 흔들린다).
  const mine = results.get("이번")!;
  if (rounds === 1) {
    const retry = scenarios.filter((s) => verdict(s, mine.get(s.name)![0]!) !== null);
    if (retry.length) {
      console.log(`다시 재 본다: ${retry.map((s) => s.name).join(", ")}`);
      // 곁눈질은 앞의 고르기가 있어야 의미가 있다 — 고르기부터 같이 잰다.
      const again = scenarios.filter((s) => retry.includes(s) || (s.name === "고르기" && retry.some((x) => x.name === "곁눈질")));
      await runBuild(cdp, builds.find((b) => b.label === "이번")!, results, again);
    }
  }
  cdp.close();

  console.log(`\n${"시나리오".padEnd(14)}${"장면/s".padStart(8)}${"출력/s".padStart(8)}${"main ms/장".padStart(12)}${"스타일/장".padStart(10)}${"렌더러%".padStart(9)}${"GPU%".padStart(7)}`);
  let failed = 0;
  for (const s of scenarios) {
    const xs = mine.get(s.name)!;
    const bad = xs.map((x) => verdict(s, x));
    // 한 번 재면 두 번 다, 여러 번 재면 절반 넘게 어긋나야 실패.
    const fail = rounds === 1 ? bad.every((b) => b !== null) : bad.filter((b) => b !== null).length > rounds / 2;
    const ok = xs.filter((x): x is Sample => !(x instanceof Error));
    const row = (label: string, list: Sample[]) => {
      if (!list.length) return `${label.padEnd(14)}(잰 값 없음)`;
      const m = (k: keyof Sample) => median(list.map((x) => x[k]));
      return `${label.padEnd(14)}${m("scene").toFixed(1).padStart(8)}${m("out").toFixed(1).padStart(8)}${m("mainMs").toFixed(2).padStart(12)}${m("styleEls").toFixed(0).padStart(10)}${m("renderer").toFixed(0).padStart(9)}${m("gpu").toFixed(0).padStart(7)}`;
    };
    console.log(`${fail ? "✗" : "✓"} ${row(s.name, ok)}`);
    if (compareRef) {
      const base = (results.get("기준")!.get(s.name) ?? []).filter((x): x is Sample => !(x instanceof Error));
      console.log(`  ${row("  기준", base)}`);
      if (base.length && ok.length) {
        const warn: string[] = [];
        for (const [k, name] of [["mainMs", "main ms/장"], ["renderer", "렌더러"], ["gpu", "GPU"], ["out", "출력"]] as const) {
          const a = median(base.map((x) => x[k]));
          const b = median(ok.map((x) => x[k]));
          if (a > 0 && b > a * 1.15 && b - a > (k === "mainMs" ? 0.3 : 2)) warn.push(`${name} +${(((b - a) / a) * 100).toFixed(0)}%`);
        }
        if (warn.length) console.log(`  ⚠ 기준보다 무겁다: ${warn.join(", ")} (헤드리스는 ±30% 흔들린다 — 여러 회차가 같은 쪽이면 원인을 찾는다)`);
      }
    }
    if (fail) {
      failed++;
      for (const b of bad) if (b) console.log(`    ${b}`);
      console.log(`    (${s.what})`);
    }
  }

  if (failed) {
    console.log(`\n✗ ${failed}개 시나리오가 어긋났다. 통과 기록을 남기지 않는다.`);
    return 1;
  }
  // 통과 기록: 커밋된 web/ 이 잰 코드와 같을 때만. pre-push 가 올리는 묶음의 web/ 트리 해시로 찾는다.
  if (only) {
    console.log("\n✓ 통과(--only 라 기록은 남기지 않는다)");
    return 0;
  }
  const dirty = (await $`git -C ${ROOT} status --porcelain -- web`.text()).trim();
  if (dirty) {
    console.log("\n✓ 통과. 다만 web/ 에 커밋하지 않은 변경이 있어 기록을 남기지 않는다 — 커밋한 뒤 다시 돌린다.");
    return 0;
  }
  const tree = (await $`git -C ${ROOT} rev-parse HEAD:web`.text()).trim();
  const dir = join((await $`git -C ${ROOT} rev-parse --path-format=absolute --git-common-dir`.text()).trim(), "agent-world-perf");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, tree), `${JSON.stringify({ at: new Date().toISOString(), head: (await $`git -C ${ROOT} rev-parse HEAD`.text()).trim() })}\n`);
  console.log(`\n✓ 통과. web/ ${tree.slice(0, 10)} 의 통과 기록을 남겼다.`);
  return 0;
}

let code = 2;
try {
  code = await main();
} catch (e) {
  console.error(`프레임 검사를 돌리지 못했다: ${e instanceof Error ? e.message : e}`);
} finally {
  cleanup();
}
process.exit(code);
