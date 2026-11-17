// herdr 가 떠 있는 터미널 창을 앞으로 가져온다(Hyprland 에서만, 되는 만큼만).
//
// `pane.focus` 는 herdr 안에서 화면을 옮길 뿐 창을 올리지는 않는다. 브라우저에서 눌렀을 때
// 터미널까지 한 번에 넘어가도록, herdr 클라이언트 프로세스의 조상 중 창을 가진 것을 찾아 올린다.
// 터미널 하나가 창을 여러 개 가질 수 있어서(ghostty), herdr 가 붙이는 제목 `<호스트>: <워크스페이스>` 로 고른다.
import { readFile } from "node:fs/promises";
import { hostname } from "node:os";
import { herdrSessionName } from "./herdr.ts";

interface HyprClient {
  address: string;
  pid: number;
  title: string;
  focusHistoryID: number;
}

async function run(cmd: string[]): Promise<string> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out;
}

async function parentOf(pid: number): Promise<number> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    // `pid (comm) state ppid …` — comm 에 공백과 괄호가 들어갈 수 있어 마지막 `)` 뒤에서 센다.
    return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
  } catch {
    return 0;
  }
}

/**
 * herdr 프로세스가 어느 세션의 화면인지를 실행 인자로 읽는다. 기본 세션이면 "", 화면이 아니면(서버, 다른 기계에
 * 붙은 것, 한 번 돌고 끝나는 명령) null.
 */
export function sessionOfClient(args: readonly string[]): string | null {
  const rest = args.slice(1);
  if (rest.includes("--remote") || rest.some((a) => a.startsWith("--remote=")) || rest.includes("--machine")) return null;
  let session = "";
  const words: string[] = [];
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i]!;
    if (arg === "--session") session = rest[(i += 1)] ?? "";
    else if (arg.startsWith("--session=")) session = arg.slice("--session=".length);
    else if (!arg.startsWith("-")) words.push(arg);
  }
  if (words.length === 0) return session;
  if (words[0] === "session" && words[1] === "attach") return words[2] ?? null;
  return null;
}

async function herdrClientAncestors(): Promise<Set<number>> {
  const pids = (await run(["pgrep", "-x", "herdr"])).split("\n").map(Number).filter(Boolean);
  // herdr 창이 세션마다 따로 떠 있을 수 있다. 이 서버가 붙은 세션의 창만 올린다 — 다른 세션의 창을 올리면
  // 누른 pane 이 없는 화면이 앞으로 나온다.
  const mine = herdrSessionName();
  const ancestors = new Set<number>();
  for (const pid of pids) {
    let args: string[];
    try {
      args = (await readFile(`/proc/${pid}/cmdline`, "utf8")).split("\0").filter(Boolean);
    } catch {
      continue;
    }
    const session = sessionOfClient(args);
    if (session === null || (mine !== undefined && session !== mine)) continue;
    for (let p = await parentOf(pid), hops = 0; p > 1 && hops < 12; p = await parentOf(p), hops += 1) ancestors.add(p);
  }
  return ancestors;
}

/** 올릴 창을 고른다. 확신할 수 없으면 null — 엉뚱한 창을 올리느니 가만히 둔다. */
export async function findHerdrWindow(): Promise<HyprClient | null> {
  if (!process.env.HYPRLAND_INSTANCE_SIGNATURE) return null;
  const ancestors = await herdrClientAncestors();
  if (ancestors.size === 0) return null;
  let clients: HyprClient[];
  try {
    clients = JSON.parse(await run(["hyprctl", "clients", "-j"])) as HyprClient[];
  } catch {
    return null;
  }
  const candidates = clients.filter((c) => ancestors.has(c.pid));
  if (candidates.length <= 1) return candidates[0] ?? null;
  const titled = candidates.filter((c) => c.title.startsWith(`${hostname()}: `));
  if (titled.length === 0) return null;
  return titled.sort((a, b) => a.focusHistoryID - b.focusHistoryID)[0]!;
}

export async function raiseHerdrWindow(): Promise<boolean> {
  // 창 초점을 빼앗기고 싶지 않으면 AGENT_WORLD_RAISE=0 으로 끈다(herdr 안의 화면만 옮긴다).
  if (process.env.AGENT_WORLD_RAISE === "0") return false;
  const target = await findHerdrWindow();
  if (!target) return false;
  await run(["hyprctl", "dispatch", "focuswindow", `address:${target.address}`]);
  return true;
}
