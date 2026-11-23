// 화면 성능 린트: 장면 프레임 밖에서 화면을 내보내거나 쉬지 않고 도는 것을 코드에서 미리 잡는다(몇 초).
// 지금까지의 회귀가 다 이 꼴이었다 — SVG 안의 CSS 애니메이션, 깜빡임의 CSS 애니메이션, 이름표의 transition,
// 제 rAF 로 그리던 미리보기. 실제로 화면이 몇 장 나가는지는 dev/perf/run.ts 가 잰다.
//
// 의도한 예외는 그 줄이나 바로 윗줄에 `perf-ok: <이유>` 를 적는다. 여러 줄이면 `perf-ok-block: <이유>` … `perf-ok-end`.
//   bun run perf:lint
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dir, "../..");
const WEB = join(ROOT, "web");

/** 이름표 층(web/world/labels.ts)에 드는 요소들. 여기에 transition·animation 을 걸면 장면이 쉬는 박자에도 화면이 나간다. */
const OVERLAY = /\.(labels|label-slot|tag|plot-sign|bubble|plate|sign-name)(?![\w-])/;
/** 제 requestAnimationFrame 을 돌려도 되는 곳 — 장면의 박자 자체(전체 보기는 walk.ts 가 그 박자다). 나머지는 beat.ts 의 rideFrame 에 얹는다. */
const RAF_OK = new Set(["web/world/scene.ts", "web/beat.ts", "web/all/walk.ts"]);

interface Problem {
  file: string;
  line: number;
  message: string;
}
const problems: Problem[] = [];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : /\.(ts|css|html)$/.test(name) ? [path] : [];
  });
}

/** 예외 표식이 덮는 줄 번호(1부터). */
function allowed(lines: string[]): Set<number> {
  const ok = new Set<number>();
  let block = false;
  lines.forEach((text, i) => {
    const n = i + 1;
    if (/perf-ok-block:/.test(text)) block = true;
    if (block || /perf-ok:/.test(text)) {
      ok.add(n);
      ok.add(n + 1);
    }
    if (/perf-ok-end/.test(text)) block = false;
  });
  return ok;
}

function report(file: string, line: number, ok: Set<number>, message: string): void {
  if (!ok.has(line)) problems.push({ file, line, message });
}

/** CSS 를 규칙 단위로 훑어, 선언마다 그것이 걸린 선택자와 함께 본다. */
function lintCss(file: string, text: string): void {
  const lines = text.split("\n");
  const ok = allowed(lines);
  // 주석을 같은 길이의 공백으로 지워 줄 번호를 지킨다.
  const css = text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  const stack: string[] = [];
  let buf = "";
  let line = 1;
  let start = 1;
  for (const ch of css) {
    if (ch === "\n") line++;
    if (ch === "{") {
      stack.push(buf.trim());
      buf = "";
      start = line;
    } else if (ch === "}" || ch === ";") {
      const decl = buf.trim();
      if (decl) checkDecl(file, start, decl, stack.filter((s) => !s.startsWith("@")).at(-1) ?? "", ok);
      if (ch === "}") stack.pop();
      buf = "";
      start = line;
    } else {
      if (!buf.trim()) start = line;
      buf += ch;
    }
  }
}

function checkDecl(file: string, line: number, decl: string, selector: string, ok: Set<number>): void {
  const m = /^([\w-]+)\s*:\s*([\s\S]*)$/.exec(decl);
  if (!m) return;
  const [, prop, value] = m as unknown as [string, string, string];
  const off = /^none\b/.test(value.trim());
  if (/^animation(-iteration-count)?$/.test(prop) && /\binfinite\b/.test(value)) {
    report(file, line, ok, `끝없이 도는 CSS 애니메이션(${prop}: …infinite) — 화면 박자마다 화면을 내보낸다. 박자 있는 움직임은 beat.ts 로 장면 프레임에 얹는다`);
  }
  if (/^(transition|transition-property|animation|animation-name)$/.test(prop) && !off && OVERLAY.test(selector)) {
    report(file, line, ok, `이름표 층(${selector.replace(/\s+/g, " ").slice(0, 60)})의 ${prop} — 장면이 쉬는 박자에도 화면이 나간다. 움직임은 labels.ts 가 장면 프레임에서 넘긴다`);
  }
  if (prop === "backdrop-filter" && !off) {
    report(file, line, ok, "backdrop-filter — 밑의 장면이 매 장 바뀌어 장마다 다시 흐린다. 꼭 필요하면 perf-ok 로 이유를 남긴다");
  }
}

function lintTs(file: string, text: string): void {
  const lines = text.split("\n");
  const ok = allowed(lines);
  lines.forEach((raw, i) => {
    const n = i + 1;
    const code = raw.replace(/\/\/.*$/, "");
    if (/^\s*(\*|\/\*)/.test(raw)) return; // 주석 줄
    if (/requestAnimationFrame\s*\(/.test(code) && !RAF_OK.has(file)) {
      report(file, n, ok, "장면 밖의 requestAnimationFrame — 장면이 쉬는 사이에 화면을 한 장 더 내보낸다. beat.ts 의 rideFrame 에 얹는다");
    }
    const interval = /setInterval\([\s\S]*,\s*([\d_]+)\s*\)/.exec(code);
    if (interval && Number(interval[1]!.replaceAll("_", "")) < 1000) {
      report(file, n, ok, `1초보다 짧은 setInterval(${interval[1]}ms) — 장면과 따로 깨어난다`);
    }
    if (/\banimation\b[^;{}]*\binfinite\b/.test(code)) {
      report(file, n, ok, "문자열 안의 끝없이 도는 CSS 애니메이션(SVG 등) — 합성기로 못 넘겨 장마다 다시 칠한다");
    }
    if (/<animate(Transform|Motion)?\b/.test(code)) report(file, n, ok, "SVG <animate> — 장면과 따로 화면을 내보낸다");
    if (/iterations\s*:\s*Infinity/.test(code)) report(file, n, ok, "끝없는 Web Animations — 장면과 따로 화면을 내보낸다");
  });
}

for (const path of files(WEB)) {
  const file = relative(ROOT, path);
  const text = readFileSync(path, "utf8");
  if (path.endsWith(".css")) lintCss(file, text);
  else lintTs(file, text);
}

if (problems.length) {
  for (const p of problems) console.log(`${p.file}:${p.line}: ${p.message}`);
  console.log(`\n✗ 화면 성능 린트 ${problems.length}건. 고치거나, 의도한 것이면 그 줄(또는 윗줄)에 perf-ok: <이유> 를 단다.`);
  process.exit(1);
}
console.log("✓ 화면 성능 린트 통과");
