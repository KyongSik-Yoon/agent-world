// 터미널 미러에 입힐 색. 에이전트 화면의 색은 사용자의 터미널 테마(밝은 배경인지 어두운 배경인지)를
// 전제로 골라진 것이라, 다른 배경 위에 그리면 글자가 묻힌다. ghostty 설정(직접 적은 색과 `theme` 이 가리키는
// 테마 파일)에서 배경·글자색·팔레트를 읽고, 설정이 없으면 흔한 어두운 팔레트를 쓴다.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export interface TermTheme {
  background: string;
  foreground: string;
  /** ANSI 0~15. */
  palette: string[];
}

const FALLBACK: TermTheme = {
  background: "#0d1017",
  foreground: "#d5dbea",
  palette: ["#1d2330", "#f0506e", "#2fbf71", "#f5a524", "#5b8cff", "#c678dd", "#3fc1c9", "#c9d1e3", "#5c6680", "#ff7a90", "#5ee39a", "#ffc65c", "#8aadff", "#dda0f0", "#6fe0e6", "#ffffff"],
};

/** ghostty 가 아무 색도 정해 주지 않았을 때 쓰는 제 기본색. 설정 파일은 있는데 배경이나 글자색이 빠져 있으면 이 값이다. */
const GHOSTTY_DEFAULT = { background: "#282c34", foreground: "#ffffff" };

const COLOR = /^#?([0-9a-f]{6})$/i;

interface Found {
  background?: string;
  foreground?: string;
  palette: string[];
  /** `theme = …` 에 적힌 값. 색을 직접 적지 않고 테마 이름만 적는 설정이 흔하다. */
  theme?: string;
  /** 설정 파일을 하나라도 읽었는지. */
  read: boolean;
}

const unquote = (value: string): string => value.replace(/^"(.*)"$/, "$1");

async function readGhostty(path: string, into: Found, depth: number): Promise<void> {
  let body: string;
  try {
    body = await readFile(path, "utf8");
  } catch {
    return;
  }
  into.read = true;
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (key === "config-file" && depth >= 0 && depth < 4) {
      const file = unquote(value.replace(/^\?/, ""));
      const full = file.startsWith("~/") ? join(homedir(), file.slice(2)) : resolve(dirname(path), file);
      await readGhostty(full, into, depth + 1);
    } else if (key === "background" || key === "foreground") {
      const m = COLOR.exec(value);
      if (m) into[key] = `#${m[1]}`;
    } else if (key === "palette") {
      const m = /^(\d+)\s*=\s*#?([0-9a-f]{6})$/i.exec(value);
      if (m && Number(m[1]) < 16) into.palette[Number(m[1])] = `#${m[2]}`;
    } else if (key === "theme" && depth >= 0) {
      // 테마 파일 안에서는 다른 테마를 가리키지 못한다.
      into.theme = unquote(value);
    }
  }
}

/** ghostty 설정 폴더들. macOS 는 XDG 자리와 앱 지원 폴더를 둘 다 읽는다(뒤의 것이 이긴다). */
function configDirs(): string[] {
  const dirs = [join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "ghostty")];
  if (process.platform === "darwin") dirs.push(join(homedir(), "Library", "Application Support", "com.mitchellh.ghostty"));
  return dirs;
}

/** 테마 파일이 있을 수 있는 자리: 사용자가 둔 것 먼저, 그다음 ghostty 와 함께 깔린 것. */
function themeDirs(): string[] {
  const resources = [
    process.env.GHOSTTY_RESOURCES_DIR,
    "/usr/share/ghostty",
    "/usr/local/share/ghostty",
    "/opt/homebrew/share/ghostty",
    "/Applications/Ghostty.app/Contents/Resources/ghostty",
    join(homedir(), "Applications", "Ghostty.app", "Contents", "Resources", "ghostty"),
  ].filter((d): d is string => Boolean(d));
  return [...configDirs(), ...resources].map((d) => join(d, "themes"));
}

/** ghostty 설정에 적힌 줄들을 적힌 차례대로(끼워 넣은 `config-file` 까지 따라가서) 돌려준다. 설정이 없으면 빈 배열. */
export async function ghosttyEntries(): Promise<Array<[key: string, value: string]>> {
  const out: Array<[string, string]> = [];
  const read = async (path: string, depth: number): Promise<void> => {
    let body: string;
    try {
      body = await readFile(path, "utf8");
    } catch {
      return;
    }
    for (const raw of body.split("\n")) {
      const line = raw.trim();
      const eq = line.indexOf("=");
      if (!line || line.startsWith("#") || eq < 0) continue;
      const key = line.slice(0, eq).trim();
      const value = line.slice(eq + 1).trim();
      if (key === "config-file" && depth < 4) {
        const file = unquote(value.replace(/^\?/, ""));
        await read(file.startsWith("~/") ? join(homedir(), file.slice(2)) : resolve(dirname(path), file), depth + 1);
      } else out.push([key, unquote(value)]);
    }
  };
  for (const dir of configDirs()) for (const file of ["config", "config.ghostty"]) await read(join(dir, file), 0);
  return out;
}

/** `theme` 값에서 지금 쓸 이름을 고른다: `이름` 또는 `light:밝은것,dark:어두운것`. */
function themeName(value: string, scheme: "light" | "dark"): string {
  const byMode = new Map<string, string>();
  for (const part of value.split(",")) {
    const m = /^\s*(light|dark)\s*:\s*(.+?)\s*$/.exec(part);
    if (m) byMode.set(m[1]!, m[2]!);
  }
  return byMode.get(scheme) ?? byMode.get("dark") ?? byMode.get("light") ?? value.trim();
}

async function readTheme(name: string): Promise<Found> {
  const found: Found = { palette: [], read: false };
  // 테마 파일 안의 theme·config-file 은 따라가지 않는다(depth 를 끝에 맞춘다).
  const candidates = name.startsWith("/") ? [name] : name.includes("/") ? [] : themeDirs().map((d) => join(d, name));
  for (const path of candidates) {
    await readGhostty(path, found, -1);
    if (found.read) break;
  }
  return found;
}

/**
 * 사용자의 터미널 색. scheme 은 화면 쪽이 아는 밝은/어두운 모드 — 테마를 모드별로 나눠 적은 설정에서 고르는 데 쓴다.
 * ghostty 는 테마를 먼저 깔고 설정에 직접 적은 색으로 덮으므로 여기서도 그 순서를 따른다.
 */
export async function termTheme(scheme: "light" | "dark" = "dark"): Promise<TermTheme> {
  const own: Found = { palette: [], read: false };
  for (const dir of configDirs()) for (const file of ["config", "config.ghostty"]) await readGhostty(join(dir, file), own, 0);
  if (!own.read) return FALLBACK;
  const theme = own.theme ? await readTheme(themeName(own.theme, scheme)) : undefined;
  return {
    background: own.background ?? theme?.background ?? GHOSTTY_DEFAULT.background,
    foreground: own.foreground ?? theme?.foreground ?? GHOSTTY_DEFAULT.foreground,
    palette: FALLBACK.palette.map((c, i) => own.palette[i] ?? theme?.palette[i] ?? c),
  };
}
