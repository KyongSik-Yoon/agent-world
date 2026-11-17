// herdr 가 떠 있는 터미널 창을 앞으로 가져온다(Hyprland 에서만, 되는 만큼만).
//
// `pane.focus` 는 herdr 안에서 화면을 옮길 뿐 창을 올리지는 않는다. 브라우저에서 눌렀을 때
// 터미널까지 한 번에 넘어가도록, herdr 클라이언트 프로세스의 조상 중 창을 가진 것을 찾아 올린다.
// 터미널 하나가 창을 여러 개 가질 수 있어서(ghostty), herdr 가 붙이는 제목 `<호스트>: <워크스페이스>` 로 고른다.
import { readFile } from "node:fs/promises";
import { hostname } from "node:os";

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

async function herdrClientAncestors(): Promise<Set<number>> {
  const pids = (await run(["pgrep", "-x", "herdr"])).split("\n").map(Number).filter(Boolean);
  const ancestors = new Set<number>();
  for (const pid of pids) {
    let cmdline = "";
    try {
      cmdline = (await readFile(`/proc/${pid}/cmdline`, "utf8")).replaceAll("\0", " ");
    } catch {
      continue;
    }
    if (/\sserver(\s|$)/.test(cmdline)) continue;
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
  const target = await findHerdrWindow();
  if (!target) return false;
  await run(["hyprctl", "dispatch", "focuswindow", `address:${target.address}`]);
  return true;
}
