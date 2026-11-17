// 터미널 미러에 입힐 색. 에이전트 화면의 색은 사용자의 터미널 테마(밝은 배경인지 어두운 배경인지)를
// 전제로 골라진 것이라, 다른 배경 위에 그리면 글자가 묻힌다. ghostty 설정에서 배경·글자색·팔레트를 읽고,
// 못 읽으면 흔한 어두운 팔레트를 쓴다.
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

const COLOR = /^#?([0-9a-f]{6})$/i;

async function readGhostty(path: string, into: Partial<TermTheme> & { palette: string[] }, depth: number): Promise<void> {
  let body: string;
  try {
    body = await readFile(path, "utf8");
  } catch {
    return;
  }
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (key === "config-file" && depth < 4) {
      const file = value.replace(/^\?/, "").replace(/^"|"$/g, "");
      const full = file.startsWith("~/") ? join(homedir(), file.slice(2)) : resolve(dirname(path), file);
      await readGhostty(full, into, depth + 1);
    } else if (key === "background" || key === "foreground") {
      const m = COLOR.exec(value);
      if (m) into[key] = `#${m[1]}`;
    } else if (key === "palette") {
      const m = /^(\d+)\s*=\s*#?([0-9a-f]{6})$/i.exec(value);
      if (m && Number(m[1]) < 16) into.palette[Number(m[1])] = `#${m[2]}`;
    }
  }
}

export async function termTheme(): Promise<TermTheme> {
  const found: Partial<TermTheme> & { palette: string[] } = { palette: [] };
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  await readGhostty(join(base, "ghostty", "config"), found, 0);
  if (!found.background || !found.foreground) return FALLBACK;
  return {
    background: found.background,
    foreground: found.foreground,
    palette: FALLBACK.palette.map((c, i) => found.palette[i] ?? c),
  };
}
