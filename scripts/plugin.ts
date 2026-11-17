// herdr 플러그인으로 돌 때의 손잡이: 서버를 띄우고, 끄고, 어디에 떠 있는지 알려 주고, 브라우저로 연다.
//
//   bun scripts/plugin.ts start | stop | restart | status | open | info
//
// herdr 는 시작할 때 `start` 를 한 번 부르고(herdr-plugin.toml 의 [[startup]]) 끝나기를 기다리지 않는다. 그래서 서버는
// 따로 떼어 띄워 두고 이 명령은 곧 끝난다. 서버는 제 주소를 상태 폴더에 적어 두므로(server/address.ts) 여기서는
// 프로세스 번호를 따로 기억하지 않는다. herdr 가 넘겨 주는 HERDR_SOCKET_PATH 가 어느 세션에 붙을지를 정한다.
//
// 설정은 플러그인 설정 폴더(`herdr plugin config-dir <id>`)의 `env` 파일에 `이름=값` 으로 적는다:
//   AGENT_WORLD_LANG=en        AGENT_WORLD_PORT=4790        AGENT_WORLD_READONLY=1        AGENT_WORLD_TRUST_HOSTS=…
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { runningServers, type Address } from "../server/address.ts";
import { stateDir } from "../server/seen.ts";
import { L, say } from "../server/text.ts";

const ROOT = resolve(process.env.HERDR_PLUGIN_ROOT ?? join(import.meta.dir, ".."));
const LOG_DIR = process.env.HERDR_PLUGIN_STATE_DIR ?? stateDir();
const LOG = join(LOG_DIR, "server.log");
/** 서버가 뜨기를 기다려 주는 시간. 처음 띄울 때는 화면을 묶고 압축하느라 조금 걸린다. */
const START_TIMEOUT_MS = 20_000;

/** 설정 폴더의 `env` 파일에 적힌 값들. 없으면 빈 것. */
function configured(): Record<string, string> {
  const dir = process.env.HERDR_PLUGIN_CONFIG_DIR;
  if (!dir) return {};
  let body: string;
  try {
    body = readFileSync(join(dir, "env"), "utf8");
  } catch {
    return {};
  }
  const out: Record<string, string> = {};
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    const eq = line.indexOf("=");
    if (!line || line.startsWith("#") || eq < 1) continue;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim().replace(/^(["'])(.*)\1$/, "$2");
  }
  return out;
}

// 이 명령이 쓰는 말(AGENT_WORLD_LANG)과, 보기 전용으로 띄울지를 설정에서 먼저 읽는다.
const config = configured();
for (const [name, value] of Object.entries(config)) process.env[name] ??= value;

function describe(server: Address): string {
  return `${server.url}${server.readonly ? say(L(" (보기 전용)", " (read-only)")) : ""}${server.session ? say(L(` · herdr 세션 ${server.session}`, ` · herdr session ${server.session}`)) : ""}`;
}

async function start(): Promise<Address | null> {
  const [already] = await runningServers();
  if (already) {
    console.log(say(L(`Agent World 가 이미 떠 있습니다 → ${describe(already)}`, `Agent World is already running → ${describe(already)}`)));
    return already;
  }
  mkdirSync(LOG_DIR, { recursive: true });
  const out = openSync(LOG, "a");
  // 제 세션을 갖는 프로세스로 떼어 띄운다 — 이 명령이 끝나도, herdr 가 이 명령의 무리를 정리해도 서버는 남는다.
  const child = spawn(process.execPath, [join(ROOT, "server", "index.ts")], { cwd: ROOT, detached: true, stdio: ["ignore", out, out], env: process.env });
  child.unref();
  closeSync(out);
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await Bun.sleep(250);
    const [up] = await runningServers();
    if (up) {
      console.log(`Agent World → ${describe(up)}`);
      return up;
    }
    if (child.exitCode !== null) break;
  }
  console.error(say(L(`Agent World 가 뜨지 않았습니다. 기록을 확인해 주세요: ${LOG}`, `Agent World did not start. See the log: ${LOG}`)));
  try {
    console.error(readFileSync(LOG, "utf8").trim().split("\n").slice(-8).join("\n"));
  } catch {
    // 기록이 없으면 그만이다.
  }
  return null;
}

async function stop(): Promise<boolean> {
  const servers = await runningServers();
  if (servers.length === 0) {
    console.log(say(L("Agent World 가 떠 있지 않습니다.", "Agent World is not running.")));
    return true;
  }
  for (const server of servers) {
    try {
      process.kill(server.pid, "SIGTERM");
    } catch {
      // 그새 끝났다.
    }
  }
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    await Bun.sleep(150);
    if ((await runningServers()).length === 0) {
      console.log(say(L("Agent World 를 껐습니다.", "Agent World stopped.")));
      return true;
    }
  }
  console.error(say(L("Agent World 가 꺼지지 않았습니다.", "Agent World did not stop.")));
  return false;
}

async function status(): Promise<boolean> {
  const servers = await runningServers();
  if (servers.length === 0) console.log(say(L("Agent World 가 떠 있지 않습니다.", "Agent World is not running.")));
  for (const server of servers) console.log(`Agent World → ${describe(server)}`);
  return servers.length > 0;
}

/** 브라우저로 연다. 띄울 수 없으면(화면이 없는 서버 등) 주소만 알려 준다. */
async function open(): Promise<boolean> {
  const server = await start();
  if (!server) return false;
  const opener = process.platform === "darwin" ? "open" : "xdg-open";
  if (!Bun.which(opener)) {
    console.log(say(L(`브라우저를 열 방법이 없습니다. 이 주소를 직접 열어 주세요: ${server.url}`, `No way to open a browser here. Open this address yourself: ${server.url}`)));
    return true;
  }
  spawn(opener, [server.url], { detached: true, stdio: "ignore" }).unref();
  return true;
}

/** herdr 의 팝업 pane 에서 도는 안내: 어디에 떠 있는지 보여 주고 키 하나를 기다린다. */
async function info(): Promise<boolean> {
  const server = await start();
  console.log("");
  if (server) {
    console.log(say(L("  브라우저에서 위 주소를 열면 마을이 보입니다.", "  Open the address above in a browser to see the village.")));
    console.log(say(L("  o 브라우저로 열기 · r 다시 띄우기 · s 끄기 · 그 밖의 키로 닫기", "  o open in browser · r restart · s stop · any other key to close")));
  } else console.log(say(L("  아무 키나 누르면 닫습니다.", "  Press any key to close.")));
  const key = await new Promise<string>((done) => {
    if (!process.stdin.isTTY) return done("");
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.once("data", (data) => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      done(String(data).toLowerCase());
    });
  });
  if (!server) return false;
  if (key === "o") return open();
  if (key === "s") return stop();
  if (key === "r") return (await stop()) && (await start()) !== null;
  return true;
}

const command = process.argv[2] ?? "status";
const ok =
  command === "start"
    ? (await start()) !== null
    : command === "stop"
      ? await stop()
      : command === "restart"
        ? (await stop()) && (await start()) !== null
        : command === "open"
          ? await open()
          : command === "info"
            ? await info()
            : await status();
process.exit(ok ? 0 : 1);
