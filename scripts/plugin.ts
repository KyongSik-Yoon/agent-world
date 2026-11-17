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
import { chmodSync, closeSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { runningServers, type Address } from "../server/address.ts";
import { existingKey, keyedUrl, stateDir, writePrivate } from "../server/key.ts";
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
    const name = line.slice(0, eq).trim();
    // 이 서버의 설정만 받는다. 아무 이름이나 받으면 설정 파일 한 줄로 서버가 읽어 들일 코드를 바꿀 수 있다(LD_PRELOAD 등).
    if (!/^AGENT_WORLD_[A-Z_]+$/.test(name)) continue;
    out[name] = line.slice(eq + 1).trim().replace(/^(["'])(.*)\1$/, "$2");
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
  mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 });
  // 기록에는 열쇠가 붙은 주소가 찍힌다 — 이 사용자만 읽게 둔다.
  const out = openSync(LOG, "a", 0o600);
  chmodSync(LOG, 0o600);
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

/** 열쇠가 붙은 주소. 열쇠 파일이 없으면(있을 수 없지만) 맨 주소. */
async function keyed(server: Address): Promise<string> {
  const key = await existingKey();
  return key ? keyedUrl(server.url, key) : server.url;
}

/**
 * 브라우저로 연다. 열쇠가 붙은 주소를 여는 프로그램의 인자로 넘기면 그 순간 다른 계정이 프로세스 목록에서 읽을 수 있다.
 * 그래서 이 사용자만 읽는 작은 문서를 하나 써 두고 그것을 연다 — 문서가 열쇠 붙은 주소로 넘겨 준다.
 */
async function open(): Promise<boolean> {
  const server = await start();
  if (!server) return false;
  const opener = process.platform === "darwin" ? "open" : "xdg-open";
  if (!Bun.which(opener)) {
    console.log(say(L("브라우저를 열 방법이 없습니다. 터미널에서 `bun run url` 이 찍는 주소를 직접 열어 주세요.", "No way to open a browser here. Open the address printed by `bun run url` yourself.")));
    return true;
  }
  const target = JSON.stringify(await keyed(server));
  const door = join(stateDir(), "open.html");
  await writePrivate(door, `<!doctype html><meta charset="utf-8"><title>Agent World</title><script>location.replace(${target})</script>\n`);
  spawn(opener, [door], { detached: true, stdio: "ignore" }).unref();
  return true;
}

/** herdr 의 팝업 pane 에서 도는 안내: 어디에 떠 있는지 보여 주고 키 하나를 기다린다. */
async function info(): Promise<boolean> {
  const server = await start();
  console.log("");
  if (server) {
    // 이 팝업은 사용자의 터미널이다 — 열쇠가 붙은 주소를 여기에는 보여 준다(휴대폰 등 다른 브라우저에서 처음 열 때 쓴다).
    console.log(`  ${await keyed(server)}`);
    console.log("");
    console.log(say(L("  브라우저마다 처음 한 번은 위 주소(열쇠 포함)로 엽니다. 그 뒤로는 기억합니다.", "  Open the address above (it carries the key) once per browser. It is remembered after that.")));
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
