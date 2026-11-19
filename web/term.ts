// 터미널 미러: herdr 가 읽어 준 화면(SGR 색상 코드가 섞인 글)을 그리고, 키 입력을 pane 으로 보낸다.
//
// herdr 는 화면을 "지금 보이는 그대로"의 줄들로 준다 — 커서 이동이 없고 색·굵기 코드만 있다. 그래서
// 터미널 에뮬레이터 없이 줄마다 span 으로 그리면 된다. 표와 테두리가 어긋나지 않도록 한글 같은
// 전각 문자는 2칸, 글꼴에 없을 법한 기호는 1칸 너비의 상자에 넣는다.
import { get, sendInput, headers } from "./api.ts";
import { withKey } from "./key.ts";
import { drawnClass } from "./cells.ts";
import { type IconName, icon } from "./dom.ts";
import { t } from "./i18n.ts";

interface TermTheme {
  background: string;
  foreground: string;
  palette: string[];
}

let palette: string[] = [];

/** 사용자의 터미널 테마를 받아 온다. 화면의 색은 그 배경을 전제로 골라진 것이다. */
export async function loadTermTheme(): Promise<void> {
  try {
    // 밝은/어두운 테마를 나눠 적은 터미널 설정에서 어느 쪽을 쓸지는 이 기기의 모드로 고른다.
    const scheme = matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
    const theme = await get<TermTheme>(`/api/term/theme?scheme=${scheme}`);
    palette = theme.palette;
    document.documentElement.style.setProperty("--term-bg", theme.background);
    document.documentElement.style.setProperty("--term-fg", theme.foreground);
  } catch {
    // 못 받아 오면 스타일시트의 기본색을 쓴다.
  }
}

/**
 * 한글·한자가 두 칸을 채우도록 키울 배율을 이 기기의 글꼴로 재서 --wide-scale 에 둔다. 데스크톱 터미널은 한글을 두 칸에
 * 맞춘 글꼴을 쓰지만, 휴대폰의 한글은 대개 두 칸보다 좁아 그대로 두면 글자 사이가 벌어진다. 글꼴이 늦게 오면 다시 잰다.
 */
function fitWide(): void {
  const probe = document.createElement("div");
  probe.className = "term";
  probe.style.cssText = "position:absolute;left:-9999px;top:0;visibility:hidden;padding:0;overflow:visible";
  const latin = probe.appendChild(document.createElement("span"));
  latin.textContent = "0".repeat(20);
  probe.append(document.createElement("br"));
  const wide = probe.appendChild(document.createElement("span"));
  wide.textContent = "한".repeat(10);
  document.body.append(probe);
  const cell = latin.getBoundingClientRect().width / 20;
  const glyph = wide.getBoundingClientRect().width / 10;
  probe.remove();
  if (!(cell > 0 && glyph > 0)) return;
  // 두 칸보다 넓은 글꼴은 줄이지 않는다(칸 밖으로 넘치는 것은 줄여도 보기 나쁘다). 크게 어긋난 값은 믿지 않는다.
  // 세로는 1.15배까지만 — 더 키우면 줄 높이(1.22em)를 넘어 윗줄·아랫줄 글자에 닿는다. 그 이상은 가로로만 채운다.
  const x = Math.min(1.4, Math.max(1, (2 * cell) / glyph));
  const root = document.documentElement.style;
  root.setProperty("--wide-x", x.toFixed(3));
  root.setProperty("--wide-y", Math.min(x, 1.15).toFixed(3));
}

/** 터미널 기호 글꼴(서버가 이 PC 의 것을 내준다)을 아이콘·기술 기호 범위에만 건다. 범위 밖의 글자에는 쓰이지 않는다. */
function installGlyphFonts(): void {
  const style = document.createElement("style");
  style.textContent = [
    // Nerd Font 아이콘: 사설 영역(Powerline·Font Awesome·Octicons 등)과 Material Design 아이콘(보조 사설 영역).
    `@font-face{font-family:"AW Nerd";src:url("font/nerd");font-display:block;unicode-range:U+E000-F8FF,U+F0000-FFFFD}`,
    // 기술 기호(⏵ ⏸ ⎿ ⌘ …): Claude Code 의 auto mode 표시 등.
    `@font-face{font-family:"AW Symbols";src:url("font/symbols");font-display:block;unicode-range:U+2300-23FF}`,
    // 상자 그리기·화살표·도형·딩뱃·점자(TUI 의 틀과 스피너): 웹판 JetBrains Mono 에 빠진 범위를 이 PC 의 JetBrains Mono 로.
    `@font-face{font-family:"AW Mono";src:url("font/mono");font-display:block;unicode-range:U+2190-21FF,U+2500-25FF,U+2700-27BF,U+2800-28FF}`,
  ].join("\n");
  document.head.append(style);
  // 사용자의 터미널(ghostty) 글꼴: 서버가 설정을 읽어 그 글꼴들과 --term-mono·--term-bold 를 적은 CSS 를 내준다(server/termfont.ts).
  // 설정이 없으면 빈 파일이고, 화면은 위의 기본 글꼴을 쓴다.
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = "font/term.css";
  document.head.append(link);
}

/**
 * 칸 눈금. 줄은 글 조각·상자(한글, 기호)·직접 그리는 칸이 섞여 흐르는데, 브라우저는 조각마다 폭을 1/64 기기 픽셀 눈금에
 * 맞춘다 — 글 조각은 올리고 상자는 버린다. 글꼴의 글자 폭이 그 눈금에 딱 떨어지지 않으면(대개 그렇다) 조각 수만큼 오차가
 * 쌓여, 같은 칸의 세로선이 줄마다 다른 픽셀에 그어진다(304칸 화면에서 기기 픽셀 0.4–2.2 — 선이 자글자글해 보인다).
 *
 * 그래서 이 글자 크기에서 글자 하나가 실제로 차지하는 폭을 재고, 가장 가까운 눈금을 칸 폭(--cell)으로 삼아 상자는 그 폭으로,
 * 글은 자간(letter-spacing)으로 그 폭에 맞춘다. 그러면 어느 칸의 자리도 "칸 번호 × 칸 폭"으로만 정해진다.
 * 자간은 눈금에서 살짝(2e-5px) 모자라게 둔다 — 올림이 정확히 눈금으로 돌아오고, 300칸을 이어도 한 눈금에 못 미친다.
 */
interface CellFit {
  /** 글자 크기(px). snap 이면 칸이 기기 픽셀의 정수배가 되도록 고친 값. */
  size: number;
  /** 칸 폭(px). */
  cell: number;
  /** 글자 사이에 더할 간격(px). */
  spacing: number;
}

const cellFits = new Map<string, CellFit>();
/** 잰 값이 달라질 수 있는 일(글꼴이 늦게 옴, 화면 배율 바뀜)이 생기면 화면들이 다시 맞춘다. */
const cellChanged = new EventTarget();
const PROBE_CHARS = 4000;

/** 이 글자 크기에서 글자 하나의 폭(px). 긴 글 한 줄의 끝자리를 재서 나눈다 — 글자 하나를 재면 눈금 오차가 그대로 실린다. */
function advanceAt(sizePx: number): number {
  const probe = document.createElement("div");
  probe.className = "term";
  probe.style.cssText = `position:absolute;left:-99999px;top:0;visibility:hidden;padding:0;overflow:visible;letter-spacing:0;font-size:${sizePx}px`;
  probe.append("0".repeat(PROBE_CHARS));
  const end = probe.appendChild(document.createElement("span"));
  end.style.cssText = "display:inline-block;width:0";
  document.body.append(probe);
  const width = end.getBoundingClientRect().left - probe.getBoundingClientRect().left;
  probe.remove();
  return width / PROBE_CHARS;
}

/**
 * 이 글자 크기의 칸 눈금. snap 이면 글자 크기를 조금 줄여(하한 아래로는 키워) 칸을 기기 픽셀의 정수배로 만든다 — 세로선이
 * 칸마다 같은 굵기로 그어진다. 글자 크기를 우리가 정하는 크게 보기에서 쓴다.
 */
function cellFit(sizePx: number, snap: boolean, minPx = 0): CellFit | undefined {
  const dpr = devicePixelRatio || 1;
  const key = `${sizePx.toFixed(3)}|${snap ? minPx : "-"}|${dpr}`;
  let fit = cellFits.get(key);
  if (fit) return fit;
  let size = sizePx;
  let advance = advanceAt(size) * dpr;
  if (!(advance > 0)) return undefined;
  let cell = Math.round(advance * 64) / 64;
  if (snap) {
    let whole = Math.max(1, Math.floor(advance + 0.001));
    if ((size * whole) / advance < minPx - 0.01) whole += 1;
    size = (size * whole) / advance;
    advance = advanceAt(size) * dpr;
    // 고친 크기에서 다시 잰 폭이 정수 칸에서 멀면(글꼴이 크기에 비례하지 않는다) 그 크기의 눈금을 그대로 쓴다.
    cell = Math.abs(advance - whole) < 0.05 ? whole : Math.round(advance * 64) / 64;
  }
  // 칸 폭은 눈금보다 아주 조금 크게 적는다 — px 로 적은 값이 기기 픽셀로 바뀌며 눈금 바로 아래로 떨어지면 한 눈금이 버려진다.
  fit = { size, cell: (cell + 1e-5) / dpr, spacing: (cell - advance) / dpr - 2e-5 };
  // 창 폭을 끌어 바꾸는 동안에는 크기마다 하나씩 쌓인다.
  if (cellFits.size > 200) cellFits.clear();
  cellFits.set(key, fit);
  return fit;
}

if (typeof document !== "undefined") {
  installGlyphFonts();
  if (document.body) fitWide();
  else addEventListener("DOMContentLoaded", fitWide, { once: true });
  document.fonts?.addEventListener("loadingdone", () => {
    fitWide();
    cellFits.clear();
    cellChanged.dispatchEvent(new Event("change"));
  });
  let dpr = devicePixelRatio;
  addEventListener("resize", () => {
    if (devicePixelRatio === dpr) return;
    dpr = devicePixelRatio;
    cellChanged.dispatchEvent(new Event("change"));
  });
}

const CUBE = [0, 95, 135, 175, 215, 255];

function color256(n: number): string {
  if (n < 16) return palette[n] ?? "inherit";
  if (n < 232) {
    const i = n - 16;
    return `rgb(${CUBE[Math.floor(i / 36)]},${CUBE[Math.floor(i / 6) % 6]},${CUBE[i % 6]})`;
  }
  const v = 8 + (n - 232) * 10;
  return `rgb(${v},${v},${v})`;
}

interface Style {
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  inverse?: boolean;
  strike?: boolean;
}

function applySgr(style: Style, params: number[]): Style {
  let s = style;
  for (let i = 0; i < params.length; i += 1) {
    const p = params[i]!;
    if (p === 0) s = {};
    else if (p === 1) s = { ...s, bold: true };
    else if (p === 2) s = { ...s, dim: true };
    else if (p === 3) s = { ...s, italic: true };
    else if (p === 4) s = { ...s, underline: true };
    else if (p === 7) s = { ...s, inverse: true };
    else if (p === 9) s = { ...s, strike: true };
    else if (p === 22) s = { ...s, bold: false, dim: false };
    else if (p === 23) s = { ...s, italic: false };
    else if (p === 24) s = { ...s, underline: false };
    else if (p === 27) s = { ...s, inverse: false };
    else if (p === 29) s = { ...s, strike: false };
    else if (p >= 30 && p <= 37) s = { ...s, fg: color256(p - 30) };
    else if (p >= 90 && p <= 97) s = { ...s, fg: color256(p - 90 + 8) };
    else if (p === 39) s = { ...s, fg: undefined };
    else if (p >= 40 && p <= 47) s = { ...s, bg: color256(p - 40) };
    else if (p >= 100 && p <= 107) s = { ...s, bg: color256(p - 100 + 8) };
    else if (p === 49) s = { ...s, bg: undefined };
    else if (p === 38 || p === 48) {
      const key = p === 38 ? "fg" : "bg";
      if (params[i + 1] === 5) {
        s = { ...s, [key]: color256(params[i + 2] ?? 0) };
        i += 2;
      } else if (params[i + 1] === 2) {
        s = { ...s, [key]: `rgb(${params[i + 2] ?? 0},${params[i + 3] ?? 0},${params[i + 4] ?? 0})` };
        i += 4;
      }
    }
  }
  return s;
}

function css(s: Style): string {
  const fg = s.inverse ? (s.bg ?? "var(--term-bg)") : s.fg;
  const bg = s.inverse ? (s.fg ?? "var(--term-fg)") : s.bg;
  let out = "";
  if (fg) out += `color:${fg};`;
  // 글자 배경은 칸(줄 높이)만큼만 칠한다. 그냥 칠하면 글꼴의 위아래 여백(content area)까지 덮어 줄 높이(1.22em)를 넘치고,
  // 다음 줄 배경이 윗줄 글자 위에 그려진다 — Claude Code 캐릭터의 눈(검은 배경)이 머리 위 띠와 눈 사이 선으로 번진다.
  // 위아래 여백(padding)으로 칠할 자리를 넓혀 두고(줄 배치는 그대로), 가운데에 줄 높이 + 1px 띠를 깐다(이웃 줄과 0.5px
  // 겹쳐 소수점 경계에 틈이 없다 — 블록 문자 칸과 같다).
  if (bg) out += `background:linear-gradient(${bg},${bg}) 0 50%/100% calc(1.22em + 1px) no-repeat;padding:0.2em 0;`;
  if (s.bold) out += "font-weight:var(--term-bold,700);";
  if (s.dim) out += "opacity:.62;";
  if (s.italic) out += "font-style:italic;";
  if (s.underline || s.strike) out += `text-decoration:${[s.underline ? "underline" : "", s.strike ? "line-through" : ""].join(" ").trim()};`;
  return out;
}

const WIDE = /[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6\u{1F300}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{1F900}-\u{1F9FF}\u{20000}-\u{3FFFD}]/u;
/** 고정폭 글꼴이 제 너비로 그려 주는 글자들 — 나머지는 상자에 넣어 칸을 맞춘다. */
/** 두 칸 글자 가운데 그림 글자. 한글·한자와 달리 이미 두 칸쯤 넓어 키우지 않는다. */
const EMOJI = /[\u{1F300}-\u{1FAFF}]/u;
const SAFE = /[ -\u024F\u2800-\u28FF]/;
/** 한 덩어리로 긋는 가로줄 글자. */
const RUNS = new Set(["\u2500", "\u2501", "\u2550"]);


/** 칸을 차지하지 않고 앞 글자에 얹히는 글자: 결합 문자, 이음 문자, 한글 자모의 가운뎃·끝소리. */
const JOINS = /[\p{M}\u200D\u1160-\u11FF]/u;
/**
 * 터미널이 그림을 그릴 자리에 채워 두는 글자(kitty 그래픽 프로토콜). 뒤따르는 결합 문자 둘이 그림의 몇째 줄·칸인지를
 * 적는다. 그림 자체는 herdr 가 읽어 주는 화면에 없으므로, 그 자리를 빈칸으로 두고 옅게 칠해 그림이 있음을 알린다.
 */
const IMAGE_CELL = "\u{10EEEE}";
/** 그림의 맨 윗줄 첫 칸 — 여기에 "이미지" 라고 적는다. */
const IMAGE_ORIGIN = "\u0305\u0305";

/** 한 줄 안의 글을 칸에 맞춰 노드로 만든다. */
function cells(text: string, into: HTMLElement): void {
  let plain = "";
  const flush = () => {
    if (plain) into.append(plain);
    plain = "";
  };
  const chars = [...text];
  for (let i = 0; i < chars.length; ) {
    let cell = chars[i]!;
    let joined = "";
    for (i += 1; i < chars.length && JOINS.test(chars[i]!); i += 1) joined += chars[i];
    if (cell === IMAGE_CELL) {
      flush();
      const origin = joined === IMAGE_ORIGIN;
      let width = 1;
      // 같은 줄에 이어지는 자리표시는 한 덩어리로 묶는다.
      while (chars[i] === IMAGE_CELL) {
        width += 1;
        for (i += 1; i < chars.length && JOINS.test(chars[i]!); i += 1);
      }
      const image = document.createElement("span");
      image.className = origin ? "img first" : "img";
      image.textContent = " ".repeat(width);
      into.append(image);
      continue;
    }
    cell += joined;
    const drawn = drawnClass(cell);
    if (drawn) {
      flush();
      const block = document.createElement("span");
      block.className = drawn;
      // 이어지는 가로줄(─ ━ ═)은 한 덩어리로 긋는다 — 칸마다 그으면 칸 경계의 겹친 자리마다 점이 찍히고 요소도 많아진다.
      let run = 1;
      if (RUNS.has(cell)) {
        while (chars[i] === cell && !JOINS.test(chars[i + 1] ?? "")) {
          run += 1;
          i += 1;
        }
        if (run > 1) block.style.width = `calc(${run} * var(--cell, 1ch) + 1px)`;
      }
      // 글자는 남겨 둔다 — 골라 복사하면 원래 글자가 나온다. 보이지만 않는다(CSS).
      block.textContent = cell.repeat(run);
      into.append(block);
      continue;
    }
    if (SAFE.test(cell[0]!)) {
      plain += cell;
      continue;
    }
    flush();
    const box = document.createElement("span");
    box.className = WIDE.test(cell) ? (EMOJI.test(cell) ? "w2" : "w2 cjk") : "w1";
    box.textContent = cell;
    into.append(box);
  }
  flush();
}

// eslint-disable-next-line no-control-regex
const ESCAPE = /\x1b\[([0-9;:]*)([A-Za-z])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

// eslint-disable-next-line no-control-regex
const SGR_TAIL = /^\x1b\[[0-9;:]*m$/;

/**
 * 줄 끝의 공백·탭과 색상 코드를 뗀다. 정규식 /(…|[ \t])+$/ 로 하면 줄 가운데의 긴 공백마다 끝까지 다시 훑어,
 * 304칸 화면 한 번에 2ms 가 들었다 — 끝에서부터 거꾸로 본다.
 */
function trimTrailing(line: string): string {
  let end = line.length;
  for (;;) {
    const c = line.charCodeAt(end - 1);
    if (c === 32 || c === 9) end -= 1;
    else if (c === 109) {
      const at = line.lastIndexOf("\x1b[", end - 1);
      if (at < 0 || !SGR_TAIL.test(line.slice(at, end))) break;
      end = at;
    } else break;
  }
  return end === line.length ? line : line.slice(0, end);
}

/** 그려 둔 줄 하나. 같은 글이 같은 스타일로 다시 오면 요소를 그대로 다시 쓴다. */
interface Row {
  /** 줄이 시작할 때의 스타일 + 줄의 글. 이것이 같으면 그림도 같다. */
  key: string;
  node: HTMLDivElement;
  /** 색상 코드를 뺀 글. */
  text: string;
  /** 줄 앞쪽에 배경색 공백 조각이 여럿 있는지(픽셀 로고 판별용). */
  bgLogo: boolean;
  /** 줄이 끝났을 때의 스타일 — 다음 줄이 이어받는다. */
  end: Style;
  /** 그린 줄의 원문(SGR 포함)과 시작 스타일 — 상태줄을 펼쳐 다시 그릴 때 쓴다. */
  line: string;
  start: Style;
  /** 다음 값들은 처음 쓸 때 재 두고 다시 쓴다 — 같은 줄은 그리기마다 같은 Row 로 돌아온다. */
  cols?: number;
  gapCols?: number;
  logo?: number;
  unfold?: { cut: number; line: string };
}

function rowCols(row: Row, trimRightGap: boolean): number {
  return trimRightGap ? (row.gapCols ??= displayCols(row.text, true)) : (row.cols ??= displayCols(row.text));
}

/** 상자 묶음을 고쳐 쓴 결과. 묶음의 줄이 그대로면 다시 계산하지 않는다 — 화면은 대개 한두 줄만 바뀐다. */
interface BoxForm {
  /** 빈 칸 구간을 뗀 줄들. 뗄 것이 없으면 null. */
  lines: string[] | null;
  cols: number;
  table: boolean;
  /** 오른쪽 테두리까지 떼고 넘긴 줄을 이어 붙인 줄들(본문 크기로 넘칠 때). 앞줄에 붙은 줄은 null. 처음 쓸 때 만든다. */
  panel?: Array<string | null>;
}

function boxForm(group: readonly Row[]): BoxForm {
  const texts = group.map((r) => r.text);
  const drop = blankColumns(texts);
  const shown = drop ? texts.map((t) => dropColumns(t, drop)) : texts;
  return {
    lines: drop ? group.map((r) => dropColumns(r.line, drop)) : null,
    cols: Math.max(0, ...shown.map((t) => displayCols(t))),
    table: isTable(shown),
  };
}

function styleKey(s: Style): string {
  const flags = (s.bold ? 1 : 0) | (s.dim ? 2 : 0) | (s.italic ? 4 : 0) | (s.underline ? 8 : 0) | (s.inverse ? 16 : 0) | (s.strike ? 32 : 0);
  return `${s.fg ?? ""}|${s.bg ?? ""}|${flags}\n`;
}

/**
 * SGR 이 섞인 줄 하나를 요소로 바꾼다. style 은 앞줄에서 이어받은 스타일이다.
 * reflow 면 좁은 곳에서 읽기 좋게 줄 끝 공백을 걷어 낸 줄이 온다(줄은 CSS 가 접는다).
 */
function renderLine(raw: string, start: Style, reflow: boolean): Row {
  let style = start;
  const line = document.createElement("div");
  line.className = "tl";
  let last = 0;
  let col = 0;
  let bgRuns = 0;
  const emit = (chunk: string) => {
    if (!chunk) return;
    if (style.bg && col < 30 && chunk.trim() === "") bgRuns += 1;
    col += chunk.length;
    const rule = css(style);
    if (!rule) return cells(chunk, line);
    const span = document.createElement("span");
    span.style.cssText = rule;
    cells(chunk, span);
    line.append(span);
  };
  for (const m of raw.matchAll(ESCAPE)) {
    emit(raw.slice(last, m.index));
    last = m.index + m[0].length;
    if (m[2] === "m") style = applySgr(style, (m[1] || "0").split(/[;:]/).map((x) => Number(x) || 0));
  }
  emit(raw.slice(last));
  const text = line.textContent ?? "";
  if (!line.hasChildNodes()) line.append("\u200b");
  // 가로줄뿐인 줄(이름표가 낀 것도)은 접히면 여러 줄을 차지하므로 한 줄로 잘라 보여 준다.
  else if (reflow && RULE_LINE.test(text)) line.classList.add("rule");
  return { key: styleKey(start) + raw, node: line, text, bgLogo: bgRuns >= 2, end: style, line: raw, start };
}

export interface ScreenOptions {
  /** 아래에서부터 비지 않은 줄 몇 개만 보여 준다(미리보기). 없으면 화면 전체. */
  tail?: number;
  /** 흐르는 출력을 촘촘히 따라간다(크게 보기). 없으면 조용할 때의 간격으로 읽고, 입력 직후에만 서두른다. */
  live?: boolean;
}

/**
 * 선 글자로만 된 줄. 가운데 짧은 이름표 하나는 낄 수 있다 — 지난 입력을 ↑ 로 불러오면 Claude Code 가 입력창 위
 * 테두리에 `─── History 76/77 ───` 처럼 적는다.
 */
const RULE_LINE = /^\s*[\u2500-\u257F]+(?: [^\u2500-\u257F]{1,40} [\u2500-\u257F]+)?(?:\s+\S{1,8})?\s*$/;
/** 입력창 테두리로 볼 가로줄: ─ 가 스무 개 넘는 줄(이름표는 낄 수 있다). 표의 테두리(┼ ┬ 가 섞인 줄)는 아니다. */
const INPUT_RULE = /^\u2500+(?: [^\u2500-\u257F]{1,40} \u2500+)?$/;
const isInputRule = (line: string): boolean => INPUT_RULE.test(line) && line.split("\u2500").length > 20;
/** 입력창과 그 아래 꾸밈(상태줄·안내줄)이 차지할 수 있는 줄 수. */
const FOOTER_REACH = 24;
/** 입력창이 없는 대화상자 화면 맨 아래에 붙는 상태줄을 찾을 최대 줄 수. */
const STATUS_REACH = 6;
/** 입력창 안의 글이 차지할 수 있는 줄 수. 두 가로줄이 이보다 멀면 입력창이 아니라 대화를 가르는 줄이다. */
const INPUT_ROWS = 12;
/** 입력창의 첫 줄은 프롬프트 기호로 시작한다. 두 가로줄 사이가 이렇게 시작하지 않으면 입력창으로 보지 않는다. */
const PROMPT_LINE = /^\s{0,2}[\u276f>\u203a\u00bb]/;
const STATUS_STRONG = /^(?:\s*[\u23F5\u23F8]{1,2}\s|\s*[\u251C\u2514]\u2500\s.*?\b(?:5h|7d)\b)|[\u2580-\u259F\u{1FB00}-\u{1FBFF}\uE0B0-\uE0D7]{2,}\s+.*(?:\u2502|\u251C\u2500|\u2514\u2500|\b(?:5h|7d|context)\b)/u;
const STATUS_CONT = /^(?:\s*[\u2580-\u259F\u{1FB00}-\u{1FBFF}\uE0B0-\uE0D7\s]+$|\s*[\u2580-\u259F\u{1FB00}-\u{1FBFF}\uE0B0-\uE0D7]{2,}\s+\S)/u;
const LOGO_CHARS = /[\u2580-\u259F\u{1FB00}-\u{1FBFF}]/gu;
const LOGO_ONLY = /^[\s\u2580-\u259F\u{1FB00}-\u{1FBFF}]+$/u;

/**
 * 입력창이 없는 화면(신뢰 확인 등 대화상자) 맨 아래에 Collie 상태줄이 남아 있으면 그 시작 줄을 찾는다.
 */
function statusFooterStart(lines: readonly string[]): number {
  let end = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (lines[i]!.trim() !== "") {
      end = i;
      break;
    }
  }
  if (end < 0) return -1;
  let start = end + 1;
  let sawStrong = false;
  for (let i = end; i >= Math.max(0, end - STATUS_REACH + 1); i -= 1) {
    const line = lines[i]!;
    if (line.trim() === "") break;
    if (STATUS_STRONG.test(line)) {
      sawStrong = true;
      start = i;
    } else if (sawStrong && STATUS_CONT.test(line)) {
      start = i;
    } else {
      break;
    }
  }
  return sawStrong ? start : -1;
}

/**
 * 입력창 아래의 꾸밈(상태줄·안내줄)이 시작하는 줄. 입력창을 확실히 찾지 못하면 -1.
 *
 * 데스크톱 폭에 맞춰 그린 상태줄은 좁은 미리보기에서 줄이 접혀 그림이 깨진다. 이 줄들은 접지 않고 한 줄씩,
 * 폭에 맞춰 줄여 넣고 넘치면 가로로 민다. 입력창이 없는 대화상자 화면이라도 맨 아래에 상태줄이 붙어 있으면 함께 잡는다.
 */
export function footerStart(lines: readonly string[]): number {
  const rules: number[] = [];
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - FOOTER_REACH) && rules.length < 2; i -= 1) {
    if (isInputRule(lines[i]!.trim())) rules.push(i);
  }
  const [bottom, top] = rules;
  if (bottom !== undefined && top !== undefined && bottom - top <= INPUT_ROWS + 1) {
    const first = lines.slice(top + 1, bottom).find((l) => l.trim() !== "");
    if (first !== undefined && PROMPT_LINE.test(first)) return bottom + 1;
  }
  return statusFooterStart(lines);
}

/** 문자열의 터미널 표시 칸 수(전각 2칸, 결합 문자 0칸). 우측 정렬용 긴 공백 뒤는 제외할 수 있다. */
export function displayCols(text: string, trimRightGap = false): number {
  const s = (trimRightGap ? text.replace(/ {20,}\S.*$/, "") : text).trimEnd();
  let cols = 0;
  for (const ch of s) {
    if (JOINS.test(ch)) continue;
    cols += WIDE.test(ch) ? 2 : 1;
  }
  return cols;
}

/** 상자 줄: 세로선·모서리로 시작하고 상자 글자로 끝나는 줄(Claude Code 가 그리는 표, 상자에 든 대화상자). */
const BOX_ROW = /^\s*[\u2502\u2503\u2551\u256D\u2570\u250C\u2514\u251C\u2554\u255A\u2560][\s\S]*[\u2500-\u257F]\s*$/;
/** 상자 글자와 공백 말고 다른 글자가 있는 줄 — 가로줄만 이어진 묶음은 표가 아니다. */
const HAS_TEXT = /[^\s\u2500-\u257F]/;

/**
 * 표처럼 칸이 맞아야 읽히는 상자 구간들 `[start, end)`. 상자 줄이 둘 넘게 이어지고 그중에 글이 든 줄이 있으면 하나로 본다.
 * 줄을 접어 보이는 화면에서 이런 줄을 접으면 세로선이 흩어져 표가 깨진다 — 묶음째 접지 않고 폭에 맞춰 줄인다.
 */
export function gridRanges(lines: readonly string[], limit: number): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let i = 0;
  while (i < limit) {
    if (!BOX_ROW.test(lines[i]!)) {
      i += 1;
      continue;
    }
    const start = i;
    let text = false;
    while (i < limit && BOX_ROW.test(lines[i]!)) {
      if (HAS_TEXT.test(lines[i]!)) text = true;
      i += 1;
    }
    if (text && i - start >= 2) ranges.push([start, i]);
  }
  return ranges;
}

/** 상태줄을 폭에 맞춰 줄일 때의 하한(px). 스타일시트의 .tl.fit 과 같은 값이다. */
const FIT_MIN_PX = 8;
/** 손가락·휠로 굴린 뒤 이만큼(ms)은 스크롤을 사용자가 한 것으로 본다(관성으로 구르는 동안). */
const USER_SCROLL_MS = 1000;
/** 오른쪽 정렬용으로 보고 줄일 공백의 길이. */
const RIGHT_GAP = 8;
const ANSI_TOKEN = /\x1b\[[0-9;:?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|[\s\S]/gu;

/** 상태줄 로고를 그리는 글자: 블록 글자와 Powerline 삼각형(agy 로고 아랫줄의 양 끝 \uE0BA·\uE0B8). STATUS_STRONG 과 같은 범위. */
const STATUS_LOGO_CHAR = /[\u2580-\u259F\u{1FB00}-\u{1FBFF}\uE0B0-\uE0D7]/u;
const STATUS_LOGO_HEAD = /^[\s\u2580-\u259F\u{1FB00}-\u{1FBFF}\uE0B0-\uE0D7]*$/u;

/** 상태줄 머리의 로고가 차지하는 칸 수. 앞쪽 몇 칸이 공백과 로고 글자뿐이고 로고 글자가 둘 넘으면 로고로 본다. */
function logoCols(text: string): number {
  const head = [...text].slice(0, 16);
  let last = -1;
  let count = 0;
  head.forEach((ch, i) => {
    if (STATUS_LOGO_CHAR.test(ch)) {
      last = i;
      count += 1;
    }
  });
  if (count < 2 || !STATUS_LOGO_HEAD.test(head.slice(0, last + 1).join(""))) return 0;
  return last + 1;
}

/**
 * 상태줄 한 줄을 접어 보일 수 있게 편다: 앞의 cut 칸(로고)을 떼고, 오른쪽 정렬을 위한 긴 공백을 세 칸으로 줄인다.
 * 색상 코드는 하나도 버리지 않는다 — 줄이 끝날 때의 스타일이 원래와 같아야 다음 줄이 제 색으로 이어진다.
 */
export function unfoldLine(line: string, cut: number): string {
  let out = "";
  let col = 0;
  let gap = "";
  let spaces = 0;
  for (const [t] of line.matchAll(ANSI_TOKEN)) {
    if (t.startsWith("\x1b")) {
      if (spaces) gap += t;
      else out += t;
      continue;
    }
    const w = JOINS.test(t) ? 0 : WIDE.test(t) ? 2 : 1;
    if (col < cut) {
      col += w;
      continue;
    }
    col += w;
    if (t === " ") {
      spaces += 1;
      gap += t;
      continue;
    }
    if (spaces) out += spaces >= RIGHT_GAP ? `   ${gap.replace(/ /g, "")}` : gap;
    gap = "";
    spaces = 0;
    out += t;
  }
  return out + gap.replace(/ /g, "");
}

/** 가로줄 글자. 상자의 위·아래 테두리에서는 이것이 안쪽의 빈칸 자리다. */
const RULE_CHAR = /[─━┄┅┈┉╌╍═]/;

/**
 * 상자 묶음의 모든 줄에서 빈칸(테두리 줄은 가로줄)인 칸이 RIGHT_GAP 넘게 이어지면, 세 칸만 남기고 뗄 칸 표시. 뗄 칸이 없으면 null.
 * Claude 는 오른쪽 끝에 값을 둔 상자(고친 파일 목록 등)를 pane 폭 가득 그려, 넓은 pane 을 좁은 곳에서 보면 하한 크기로도
 * 들어가지 않는다. 칸째로 떼므로 세로선은 그대로 맞는다.
 */
export function blankColumns(texts: readonly string[]): boolean[] | null {
  const cells = texts.map((text) => {
    const out: boolean[] = [];
    for (const ch of text) {
      if (JOINS.test(ch)) continue;
      out.push(ch === " " || RULE_CHAR.test(ch));
      if (WIDE.test(ch)) out.push(false);
    }
    return out;
  });
  const width = Math.max(0, ...cells.map((c) => c.length));
  const drop = new Array<boolean>(width).fill(false);
  let any = false;
  for (let col = 0; col < width; ) {
    let end = col;
    while (end < width && cells.every((c) => end >= c.length || c[end])) end += 1;
    if (end - col >= RIGHT_GAP) {
      for (let i = col + 3; i < end; i += 1) drop[i] = true;
      any = true;
    }
    col = Math.max(end, col + 1);
  }
  return any ? drop : null;
}

/**
 * 칸이 맞아야 읽히는 표인지: 안쪽에 글 없는 가로줄(머리글 밑줄)이 있거나, 글 사이에 세로선이 있으면 표로 본다.
 * 그 밖의 상자(선택지 대화상자, 고친 파일 목록)는 글을 담은 틀일 뿐이다.
 */
export function isTable(texts: readonly string[]): boolean {
  for (let i = 1; i < texts.length - 1; i += 1) {
    const t = texts[i]!;
    if (!HAS_TEXT.test(t) && /[\u2500\u2501\u2550\u253C\u254B\u256A]/.test(t)) return true;
    if (/\S\s+[\u2502\u2503\u2551]\s+\S/.test(t.trim().slice(1, -1))) return true;
  }
  return false;
}

/** 상자 줄의 오른쪽 테두리와 그 앞 공백을 뗀다. 색상 코드는 그대로 둔다. */
export function dropRightBorder(line: string): string {
  const tokens = [...line.matchAll(ANSI_TOKEN)].map((m) => m[0]);
  let last = tokens.length - 1;
  while (last >= 0 && (tokens[last]!.startsWith("\x1b") || tokens[last] === " ")) last -= 1;
  if (last < 0 || !/[\u2502\u2503\u2551\u256E\u256F\u2510\u2518\u2557\u255D]/.test(tokens[last]!)) return line;
  let out = "";
  let gap = "";
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i]!;
    if (i === last) {
      gap = gap.replace(/ /g, "");
      continue;
    }
    if (t.startsWith("\x1b")) {
      if (gap) gap += t;
      else out += t;
      continue;
    }
    if (t === " " && i < last) {
      gap += t;
      continue;
    }
    out += gap + t;
    gap = "";
  }
  return out + gap.replace(/ /g, "");
}

/** 접는 글 상자 줄의 머리: 왼쪽 세로선과 그 뒤 공백. 접힌 줄은 이 칸 뒤에서 이어진다(모두 한 칸 글자라 길이가 칸 수다). */
const PANEL_HEAD = /^ *[\u2502\u2503\u2551] */;
/** 목록 머리(1. • - 등). 접힌 줄은 머리 뒤 글자에 맞춰 들여 쓴다. */
const LIST_MARK = /^(?:[-*\u2022\u25E6\u25AA\u2023]|\d{1,3}[.)]) +/;
/** 오른쪽 테두리 글자. */
const RIGHT_BORDER = /[\u2502\u2503\u2551\u256E\u256F\u2510\u2518\u2557\u255D]$/;
/** 글 상자 줄로 그린 Row 의 key 머리 — 같은 줄을 보통 줄로 그린 것과 섞이지 않게. */
const PANEL_KEY = "panel\n";

const plain = (line: string): string => line.replace(ESCAPE, "");
/** 세로선 칸이 이보다 넓으면(깊이 들여 쓴 줄) 나누지 않는다 — 휴대폰 폭에서 글 칸이 한두 글자로 좁아진다. */
const PANEL_HANG_MAX = 24;

/** 줄에서 from 칸 뒤 첫 글자와 마지막 글자의 색·흐림. 넘긴 줄이면 앞줄 끝과 다음 줄 첫 글자가 같은 글이라 같다. */
function edgeLooks(line: string, from: number): [string, string] {
  let style: Style = {};
  let col = 0;
  let first = "";
  let last = "";
  for (const [t] of line.matchAll(ANSI_TOKEN)) {
    if (t.startsWith("\x1b")) {
      const sgr = /^\x1b\[([0-9;:]*)m$/.exec(t);
      if (sgr) style = applySgr(style, (sgr[1] || "0").split(/[;:]/).map((x) => Number(x) || 0));
      continue;
    }
    if (t !== " " && !RIGHT_BORDER.test(t)) {
      const look = `${style.fg ?? ""}|${style.dim ? 1 : 0}`;
      if (col >= from && !first) first = look;
      last = look;
    }
    if (!JOINS.test(t)) col += WIDE.test(t) ? 2 : 1;
  }
  return [first, last];
}

/** 줄을 앞 n 칸과 나머지로 가른다. 색상 코드는 칸을 따라간다. */
export function splitColumns(line: string, n: number): [string, string] {
  let head = "";
  let tail = "";
  let col = 0;
  for (const [t] of line.matchAll(ANSI_TOKEN)) {
    if (col < n) head += t;
    else tail += t;
    if (!t.startsWith("\x1b") && !JOINS.test(t)) col += WIDE.test(t) ? 2 : 1;
  }
  return [head, tail];
}

/**
 * 넘쳐서 접을 글 상자의 줄들: 오른쪽 테두리를 뗀 shownLines(빈 칸 구간을 뗀 줄)에서, 상자 폭 때문에 다음 줄로 넘긴 글은 앞줄에 다시 이어 붙인다(붙은 줄은 null).
 * 넘긴 줄인지는 줄바꿈 규칙대로 가린다 — 다음 줄의 첫 낱말이 앞줄 끝 한 칸 뒤에 들어갈 자리가 없었고, 같은 들여쓰기로
 * 이어지며(목록이면 머리 뒤 글자에 맞춰), 목록 머리로 시작하지 않을 때. 그대로 두면 좁은 화면에서 넓은 상자의 줄 끝마다
 * 한두 낱말짜리 줄이 생긴다. 넘겼는지는 빈 칸을 떼기 전의 줄(lines)에서 잰다 — 뗀 줄에서는 상자 폭이 가장 긴 줄에 맞춰
 * 줄어, 짧은 줄도 끝에 닿은 것처럼 보인다.
 */
export function panelLines(lines: readonly string[], shownLines: readonly string[] = lines): Array<string | null> {
  const out: Array<string | null> = [];
  let open = -1;
  let indent = 0;
  let end = 0;
  let edge = 0;
  let tail = "";
  lines.forEach((line, i) => {
    const shown = dropRightBorder(shownLines[i]!);
    const text = plain(line).trimEnd();
    const head = PANEL_HEAD.exec(text);
    if (!head || !RIGHT_BORDER.test(text)) {
      out.push(shown);
      open = -1;
      return;
    }
    const hang = head[0].length;
    const body = text.slice(hang, -1).trimEnd();
    const mark = LIST_MARK.exec(body)?.[0].length ?? 0;
    const border = displayCols(text) - 1;
    const bodyEnd = hang + displayCols(body);
    const word = displayCols(body.split(" ")[0]!);
    // 색·흐림이 바뀌면 다른 글이다 — 미리보기를 끊은 자리의 "Show all · N more lines", 꽉 찬 제목 밑의 부제.
    const [first, last] = edgeLooks(line, hang);
    if (open >= 0 && body && !mark && hang === indent && end + 1 + word > edge && first === tail) {
      const [lead, rest] = splitColumns(shown, PANEL_HEAD.exec(plain(shown))?.[0].length ?? 0);
      out[open] += ` ${lead.match(/\x1b[^a-zA-Z]*[a-zA-Z]/g)?.join("") ?? ""}${rest}`;
      out.push(null);
    } else {
      out.push(shown);
      open = body ? out.length - 1 : -1;
      indent = hang + mark;
    }
    end = bodyEnd;
    // 상자 안쪽은 테두리 앞의 한 칸(여백) 전까지다.
    edge = border - 1;
    tail = last;
  });
  return out;
}

/** 세로로 나뉜 창의 구분선 글자. */
const DIVIDER = /[\u2502\u2503\u2551]/;
/** 오른쪽 창 끝의 스크롤 막대 글자. 줄을 접으면 엉뚱한 자리에 흩어지므로 뗀다. */
const SCROLL_TRACK = /[\u2502\u2503\u2588\u2590\u258C\u2595\u258F]/;
/** 구분선으로 볼 최소 높이: 화면 줄의 이만큼 넘게 같은 칸에 이어져야 한다(표의 세로선은 가로줄에서 끊기고 짧다). */
const SPLIT_SHARE = 0.4;
const SPLIT_MIN_ROWS = 8;
/** 양쪽 창이 이보다 좁으면 나뉜 창으로 보지 않는다. */
const SPLIT_MIN_SIDE = 20;
const SGR_ONLY = /\x1b\[[0-9;:]*m/g;
/** 바탕색만 거는 색상 코드. */
const BG_CODE = /\x1b\[48;(?:2;\d+;\d+;\d+|5;\d+)m/g;

/** 줄에서 구분선 글자가 있는 칸들과 줄의 칸 수. */
function dividerCols(text: string): [number[], number] {
  const at: number[] = [];
  let col = 0;
  for (const ch of text) {
    if (JOINS.test(ch)) continue;
    if (DIVIDER.test(ch)) at.push(col);
    col += WIDE.test(ch) ? 2 : 1;
  }
  return [at, col];
}

/**
 * 세로로 나뉜 화면(Claude Code 가 오른쪽에 플랜 보기 창을 띄운 것 등)을 줄 접는 화면에서 볼 수 있게 위아래로 쌓는다.
 * 그대로 접으면 왼쪽 창 줄 뒤에 오른쪽 창 줄이 이어 붙어 접혀, 두 창의 글이 한 줄씩 엇갈려 섞인다. 같은 칸의 세로선이
 * 화면의 SPLIT_SHARE 넘게 이어지는 구간을 찾아, 오른쪽 창을 위에, 왼쪽 창을 아래에 둔다 — 아래에 붙여 보는 미리보기와
 * 크게 보기의 끝이 왼쪽 창(대화)의 끝과 그 밑의 입력창으로 이어진다. 나뉜 화면이 아니면 null.
 */
export function stackPanes(lines: readonly string[]): string[] | null {
  if (lines.filter((l) => l.includes("\u2502") || l.includes("\u2503") || l.includes("\u2551")).length < SPLIT_MIN_ROWS) return null;
  const texts = lines.map(plain);
  const marks = texts.map(dividerCols);
  const width = Math.max(0, ...marks.map(([, w]) => w));
  // 칸마다 지금 이어지는 줄 수를 세며 가장 긴 구간을 찾는다.
  const runs = new Map<number, number>();
  let best = { col: -1, start: 0, end: 0 };
  marks.forEach(([at], i) => {
    const here = new Set(at.filter((c) => c >= SPLIT_MIN_SIDE && c < width - SPLIT_MIN_SIDE));
    for (const c of [...runs.keys()]) if (!here.has(c)) runs.delete(c);
    for (const c of here) {
      const start = runs.get(c) ?? i;
      runs.set(c, start);
      if (i + 1 - start > best.end - best.start) best = { col: c, start, end: i + 1 };
    }
  });
  const { col, start, end } = best;
  if (col < 0 || end - start < Math.max(SPLIT_MIN_ROWS, lines.length * SPLIT_SHARE)) return null;
  // 상자에 든 큰 표의 안쪽 세로선이다 — 줄마다 테두리로 시작한다.
  let boxed = 0;
  for (let i = start; i < end; i += 1) if (/^\s*[\u2502\u2503\u2551\u251C\u2560\u256D\u2570\u250C\u2514]/.test(texts[i]!)) boxed += 1;
  if (boxed * 2 > end - start) return null;
  const left: string[] = [];
  const right: string[] = [];
  for (let i = start; i < end; i += 1) {
    const [head, rest] = splitColumns(lines[i]!, col);
    const [bar, tail] = splitColumns(rest, 1);
    left.push(head);
    // 오른쪽 창의 글은 줄 앞에서 이어지던 스타일로 시작해야 한다 — 앞쪽의 색상 코드를 차례로 다시 건다.
    let side = `\x1b[0m${(head + bar).match(SGR_ONLY)?.join("") ?? ""}${tail}`;
    const shown = plain(tail).trimEnd();
    const last = shown.at(-1) ?? "";
    if (SCROLL_TRACK.test(last) && col + 1 + displayCols(shown) === marks[i]![1] && marks[i]![1] === width) {
      side = splitColumns(side, displayCols(shown) - 1)[0];
    }
    right.push(side);
  }
  // 오른쪽 창의 바탕색(가장 많이 쓰인 바탕)은 걷어 낸다. 줄마다 바탕이 깔리면 배너로 잘못 읽혀 끝이 잘리고, 접힌 줄은
  // 줄무늬가 된다. 인라인 코드처럼 그 위에 다른 바탕을 깐 글은 남는다.
  const bgs = new Map<string, number>();
  for (const line of right) for (const [code] of line.matchAll(BG_CODE)) bgs.set(code, (bgs.get(code) ?? 0) + 1);
  const surface = [...bgs].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (surface) for (let i = 0; i < right.length; i += 1) right[i] = right[i]!.split(surface).join("\x1b[49m");
  while (right.length && plain(right[right.length - 1]!).trim() === "") right.pop();
  while (right.length && plain(right[0]!).trim() === "") right.shift();
  return [...lines.slice(0, start), ...right, `\x1b[0m\x1b[2m${"\u2500".repeat(24)}\x1b[0m`, ...left, ...lines.slice(end)];
}

/**
 * 글 상자의 한 줄을 세로선 칸과 글 칸으로 나눠 그린다. 접힌 줄이 세로선 밖(맨 왼쪽)으로 나가지 않고 글 칸 안에서 이어지며,
 * 세로선은 접힌 줄 높이만큼 내려온다(스타일시트의 .tl.panel).
 */
function renderPanel(raw: string, start: Style): Row {
  const head = PANEL_HEAD.exec(plain(raw));
  if (!head || head[0].length > PANEL_HANG_MAX) {
    const row = renderLine(raw, start, true);
    return { ...row, key: PANEL_KEY + row.key };
  }
  const [lead, rest] = splitColumns(raw, head[0].length);
  const left = renderLine(lead, start, true);
  const right = renderLine(rest, left.end, true);
  const node = document.createElement("div");
  node.className = "tl panel";
  const hang = document.createElement("span");
  hang.className = "hang";
  for (const child of [...left.node.childNodes]) {
    if (child.nodeType === Node.TEXT_NODE) {
      const wrap = document.createElement("span");
      wrap.append(child);
      hang.append(wrap);
    } else hang.append(child);
  }
  const body = document.createElement("span");
  body.className = "body";
  body.append(...right.node.childNodes);
  const mark = LIST_MARK.exec(right.text)?.[0].length ?? 0;
  if (mark) body.style.setProperty("--mark", String(mark));
  node.append(hang, body);
  return { key: PANEL_KEY + styleKey(start) + raw, node, text: left.text + right.text, bgLogo: false, end: right.end, line: raw, start };
}

/** 줄에서 drop 으로 표시한 칸의 글자를 뗀다. 색상 코드는 그대로 둔다. */
export function dropColumns(line: string, drop: readonly boolean[]): string {
  let out = "";
  let col = 0;
  let kept = true;
  for (const [t] of line.matchAll(ANSI_TOKEN)) {
    if (t.startsWith("\x1b")) {
      out += t;
      continue;
    }
    if (!JOINS.test(t)) {
      kept = !drop[col];
      col += WIDE.test(t) ? 2 : 1;
    }
    if (kept) out += t;
  }
  return out;
}

/** 왼쪽에 블록·배경 로고를 두고 오른쪽에 소개 글을 나란히 배치한 시작 배너 구간들 `[start, end)` 을 찾는다. */
export function bannerRanges(lines: ReadonlyArray<{ text: string; bgLogo?: boolean }>, limit: number): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const kind = (row: { text: string; bgLogo?: boolean }): "none" | "logo" | "banner" => {
    const t = row.text;
    const head = t.slice(0, 30);
    const blockCount = head.match(LOGO_CHARS)?.length ?? 0;
    const hasLogo = blockCount >= 2 || row.bgLogo === true;
    if (!hasLogo) return "none";
    const onlyLogo = t.trim() === "" ? row.bgLogo === true : LOGO_ONLY.test(t);
    return onlyLogo ? "logo" : "banner";
  };

  let i = 0;
  while (i < limit) {
    const k = kind(lines[i]!);
    if (k === "none") {
      i += 1;
      continue;
    }
    const start = i;
    let hasBannerText = k === "banner";
    let count = 1;
    i += 1;
    while (i < limit) {
      const next = kind(lines[i]!);
      if (next !== "none") {
        if (next === "banner") hasBannerText = true;
        count += 1;
        i += 1;
        continue;
      }
      // 로고 위아래 조각 사이에 빈 줄 하나가 끼어도 같은 배너로 묶는다.
      if (lines[i]!.text.trim() === "" && i + 1 < limit && kind(lines[i + 1]!) !== "none") {
        count += 1;
        i += 1;
        continue;
      }
      break;
    }
    if (hasBannerText && count >= 2) ranges.push([start, i]);
  }
  return ranges;
}

/** 한 번 그린 뒤, 그리는 데 든 시간의 이만큼을 쉰다. 칠하기까지 쳐서, 쉬지 않고 흐르는 큰 화면이 메인 스레드의 40% 안팎을 쓴다. */
const DRAW_REST = 4;
/** 아무리 무거워도 이보다 오래 쉬지는 않는다 — 초당 네 번은 그린다. */
const DRAW_REST_MAX_MS = 250;

/** 크게 보기에서 글자가 커질 수 있는 한도(px). 80칸짜리 pane 을 넓은 창에 띄워도 구석에 작게 몰리지 않게 한다. */
const MAX_FONT_PX = 17;
/**
 * 크게 보기에서 글자가 작아질 수 있는 한도(px). 칸을 다 넣으려고 이보다 줄이면 배율 1 화면에서 읽을 수 없다(304칸 pane 을
 * 1440 폭에 넣으면 7.5px). 그보다 넓은 화면은 이 크기로 두고 가로로 민다. 창 폭이나 기기와 상관없이 같다.
 */
const MIN_FONT_PX = 10;
/** 휴대폰 세로의 크게 보기는 칸에 맞추지 않고 줄을 접는다 — 304칸 pane 을 10px 로 두면 줄마다 옆으로 네다섯 화면을 밀어야 한다. */
const FLOW_MEDIA = "(max-width: 760px) and (orientation: portrait)";
/**
 * 줄을 접을 때의 글자 크기(px). 작게 보기와 같은 하한으로 둔다 — 12px 은 360px 폭에서 한 줄이 46칸이고 한글을 두 칸에
 * 맞춰 키우면 더 커 보여, 사용자가 크다며 10px 을 골랐다.
 */
const FLOW_FONT_PX = MIN_FONT_PX;

/** pane 하나의 화면을 받아 그리는 요소. start 하면 서버의 흐름에 붙고, stop 하면 끊는다. */
export class TermScreen {
  readonly el = document.createElement("div");
  private source: EventSource | undefined;
  private paneId = "";
  private back = 0;
  /** 화면을 보고 있어야 하는 상태인지 — 끊겼을 때 다시 붙을지 정한다. */
  private wanted = false;
  onGone: (() => void) | undefined;
  /** 미리보기에서 입력창 아래의 상태줄·안내줄을 접지 않고 한 줄씩 보여 준다. */
  fitFooter = false;
  /** 칸에 맞춰 그리지 않고 창 폭에서 줄을 접는다. 미리보기는 늘, 크게 보기는 휴대폰 세로에서. */
  private flowing = false;
  /** 받아 둔 화면의 줄들(SGR 포함). 서버는 처음에 통째로, 그 뒤로는 달라진 줄만 보낸다. */
  private raw: string[] | undefined;
  private rows: Row[] = [];
  private frame = 0;
  /** 이 시각까지는 다시 그리지 않는다. */
  private restUntil = 0;
  private restTimer: ReturnType<typeof setTimeout> | undefined;
  /**
   * 미리보기가 맨 아래에 붙어 있는지와, 떨어져 있다면 어디까지 올려 두었는지. 사용자가 위로 올려 읽는 동안에는 새 화면이
   * 와도 끌어내리지 않는다. 요소가 문서에서 빠졌다 다시 붙으면(상세창이 본문을 새로 지을 때) 브라우저가 스크롤을 0 으로
   * 되돌리므로, 붙어 있는 동안의 값을 따로 들고 있다가 restoreScroll 로 되살린다.
   */
  private pinned = true;
  private savedTop = 0;
  /** 이 pane 을 이 폭에서 그리는 동안 본 가장 넓은 상태줄의 칸 수(unfoldFooter). */
  private footerSeen = { pane: "", width: 0, cols: 0 };
  /** 지난 그리기의 상자 묶음 결과(묶음 줄들의 key → 결과). 이번에 쓴 것만 남긴다. */
  private boxForms = new Map<string, BoxForm>();
  /** 크게 보기가 정해 준 글자 크기(px)와 칸을 기기 픽셀에 맞출지. 없으면 스타일시트의 크기를 쓴다. */
  private font: { px: number; snap: boolean; min: number } | undefined;
  /** 칸 눈금을 아직 맞추지 않았다 — 문서에 붙은 뒤 첫 그리기에서 맞춘다. */
  private untuned = true;

  constructor(private readonly options: ScreenOptions = {}) {
    this.el.className = "term";
    this.flow = options.tail !== undefined;
    // 폭이 바뀌면 상태줄을 줄여 넣을지 펴서 접을지 다시 정한다(상세창 폭을 끌어 바꿀 때).
    let lastWidth = 0;
    new ResizeObserver(() => {
      // 높이만 바뀌어도(화면 자판) 붙어 있던 화면은 다시 맨 아래로.
      if (this.pinned && this.el.isConnected) this.el.scrollTop = this.el.scrollHeight;
      const w = this.el.clientWidth;
      if (w === lastWidth) return;
      lastWidth = w;
      if (this.flowing && this.fitFooter) this.redraw();
    }).observe(this.el);
    this.el.textContent = t("화면을 읽는 중…");
    cellChanged.addEventListener("change", () => this.tune());
    // 아래에 붙이기를 멈추는 것은 사용자가 직접 올렸을 때뿐이다. 브라우저도 스스로 스크롤 이벤트를 낸다(화면 자판이
    // 열리고 닫힐 때, 위쪽 줄 높이가 바뀌어 보던 자리를 지킬 때) — 그것까지 "올려 읽는 중"으로 알면 휴대폰에서 상태줄이
    // 입력칸 밑에 숨은 채 남았다.
    let touching = false;
    let touchedAt = -Infinity;
    const touched = () => {
      touchedAt = performance.now();
    };
    const opts = { passive: true };
    for (const type of ["wheel", "pointerdown", "touchmove"] as const) this.el.addEventListener(type, touched, opts);
    this.el.addEventListener("touchstart", () => {
      touching = true;
      touched();
    }, opts);
    for (const type of ["touchend", "touchcancel"] as const) this.el.addEventListener(type, () => {
      touching = false;
      touched();
    }, opts);
    this.el.addEventListener(
      "scroll",
      () => {
        if (!this.el.isConnected) return;
        this.savedTop = this.el.scrollTop;
        if (this.el.scrollHeight - this.el.scrollTop - this.el.clientHeight < 40) this.pinned = true;
        // 손을 뗀 뒤에도 관성으로 한동안 구른다.
        else if (touching || performance.now() - touchedAt < USER_SCROLL_MS) this.pinned = false;
        else if (this.pinned) this.el.scrollTop = this.el.scrollHeight;
      },
      opts,
    );
  }

  get flow(): boolean {
    return this.flowing;
  }

  /** 접기를 켜고 끈다. 접을 때만 붙는 표시(가로줄 자르기)가 있어, 그려 둔 줄을 다시 쓰지 않고 새로 그린다. */
  set flow(on: boolean) {
    if (on === this.flowing) return;
    this.flowing = on;
    this.el.classList.toggle("flow", on);
    this.rows = [];
    this.redraw();
  }

  /** 글자 크기를 정한다(크게 보기). snap 이면 칸이 기기 픽셀의 정수배가 되게 조금 고친다 — min 아래로는 내리지 않는다. */
  setFont(px: number, snap: boolean, min = 0): void {
    this.font = { px, snap, min };
    this.tune();
  }

  /** 지금 글자 크기의 칸 눈금을 맞춘다(cellFit). 문서에 붙어 있어야 잴 수 있다. */
  private tune(): void {
    if (!this.el.isConnected) {
      this.untuned = true;
      return;
    }
    this.untuned = false;
    const style = this.el.style;
    const px = this.font?.px ?? (style.removeProperty("font-size"), parseFloat(getComputedStyle(this.el).fontSize));
    const fit = px > 0 ? cellFit(px, this.font?.snap ?? false, this.font?.min) : undefined;
    if (!fit) {
      if (this.font) style.fontSize = `${this.font.px.toFixed(2)}px`;
      style.removeProperty("--cell");
      style.removeProperty("letter-spacing");
      return;
    }
    if (this.font) style.fontSize = `${fit.size}px`;
    style.setProperty("--cell", `${fit.cell}px`);
    style.letterSpacing = `${fit.spacing}px`;
  }

  /** 다른 자리로 옮겨 붙어 글자 크기가 달라졌다 — 칸 눈금을 다시 맞추고 아래에 붙인다. */
  refit(): void {
    this.tune();
    this.redraw();
    this.restoreScroll();
  }

  /** 맨 위로 올리고 아래에 붙이기를 푼다 — 앱 화면을 넘겨 새로 드러난 지난 출력부터 보이게. */
  toTop(): void {
    this.pinned = false;
    this.el.scrollTop = 0;
  }

  /** 맨 아래로 내리고 다시 붙인다. */
  toBottom(): void {
    this.pinned = true;
    this.el.scrollTop = this.el.scrollHeight;
  }

  /** 다시 붙은 미리보기의 스크롤을 떼기 전 자리로 돌린다 — 맨 아래에 있었으면 맨 아래로. */
  restoreScroll(): void {
    this.el.scrollTop = this.pinned ? this.el.scrollHeight : this.savedTop;
  }

  get pane(): string {
    return this.paneId;
  }

  get scrollback(): number {
    return this.back;
  }

  /** back 이 0 이면 지금 보이는 화면, 크면 그만큼의 스크롤백까지 읽는다. */
  start(paneId: string, back = 0): void {
    const same = paneId === this.paneId && back === this.back;
    if (this.source && same) return;
    this.stop();
    this.paneId = paneId;
    this.back = back;
    // 같은 화면에 다시 붙는 것이면, 새 화면이 올 때까지 보던 것을 그대로 둔다.
    if (!same || !this.raw) {
      this.raw = undefined;
      this.clear(t("화면을 읽는 중…"));
    }
    const source = new EventSource(withKey(`/api/term?pane=${encodeURIComponent(paneId)}&back=${back}${this.options.live ? "&live=1" : ""}`));
    this.source = source;
    source.addEventListener("screen", (e) => {
      this.raw = (JSON.parse((e as MessageEvent<string>).data) as { text: string }).text.split(/\r?\n/);
      this.redraw();
    });
    source.addEventListener("lines", (e) => {
      if (!this.raw) return;
      for (const [i, line] of (JSON.parse((e as MessageEvent<string>).data) as { set: Array<[number, string]> }).set) this.raw[i] = line;
      this.redraw();
    });
    // herdr 가 읽기에 답하지 않으면 서버가 알려 준다. 멈춘 화면을 살아 있는 것처럼 두지 않는다.
    source.addEventListener("stalled", () => {
      // 안내 글은 CSS 가 data-stalled 에서 읽는다(글을 스타일시트에 두지 않으려고).
      this.el.dataset.stalled = t("herdr 가 답하지 않습니다 — 다시 읽는 중…");
      this.el.classList.add("stalled");
    });
    source.addEventListener("resumed", () => this.el.classList.remove("stalled"));
    const gone = () => {
      this.stop();
      this.raw = undefined;
      this.clear(t("이 pane 은 닫혔습니다."));
      this.onGone?.();
    };
    source.addEventListener("gone", gone);
    source.onerror = () => {
      // 오류 응답을 받은 EventSource 는 다시 붙지 않는다. pane 이 사라진 것인지(404) 서버가 잠깐 꺼진 것인지
      // 가려서, 꺼진 것이면 조금 뒤에 새로 연다.
      if (source.readyState !== EventSource.CLOSED || this.source !== source) return;
      this.source = undefined;
      void fetch(`/api/screen?pane=${encodeURIComponent(paneId)}`, { headers: headers() })
        .then((res) => res.status)
        .catch(() => 0)
        .then((status) => {
          if (this.source !== undefined || this.paneId !== paneId || this.back !== back) return;
          if (status === 404) gone();
          else setTimeout(() => this.source === undefined && this.paneId === paneId && this.back === back && this.wanted && this.start(paneId, back), 2000);
        });
    };
    this.wanted = true;
  }

  stop(): void {
    this.wanted = false;
    // 다음에 열 때는 최신 줄부터 보여 준다.
    this.pinned = true;
    this.el.classList.remove("stalled");
    this.source?.close();
    this.source = undefined;
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    clearTimeout(this.restTimer);
    this.restTimer = undefined;
  }

  get running(): boolean {
    return this.source !== undefined;
  }

  private clear(message: string): void {
    this.rows = [];
    this.el.textContent = message;
  }

  /**
   * 받아 둔 화면을 다음 프레임에 그린다. 한 프레임 사이에 여러 번 바뀌어도 마지막 것만 그린다.
   *
   * 큰 화면이 통째로 바뀌면 한 번 그리는 데 수십 ms 가 든다(느린 기기나 저전력 상태에서는 더). 그런 화면이 쉬지 않고
   * 흐르면 그리기가 메인 스레드를 다 쓰므로, 그리는 데 든 시간의 몇 배만큼 쉬었다가 그린다. 한 줄만 바뀌는
   * 그리기(글자 입력)는 1ms 도 들지 않아 쉬지 않는다.
   */
  redraw(): void {
    if (this.frame || this.restTimer !== undefined) return;
    const rest = this.restUntil - performance.now();
    if (rest > 4) {
      this.restTimer = setTimeout(() => {
        this.restTimer = undefined;
        this.redraw();
      }, rest);
      return;
    }
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      if (!this.raw) return;
      const began = performance.now();
      this.draw(this.raw);
      // 배치까지 여기서 끝내 그 값을 잰다 — 어차피 이 프레임에 치를 값이다.
      void this.el.offsetHeight;
      const now = performance.now();
      this.restUntil = now + Math.min(DRAW_REST_MAX_MS, (now - began) * DRAW_REST);
    });
  }

  /**
   * 상태줄 묶음이 폭에 맞춰 하한(8px)까지 줄여도 넘치면, 펴서 본문 크기로 접어 보일 줄들을 돌려준다. 넘치지 않으면 null.
   * 줄여 한 줄에 넣으면 컨텍스트 비율처럼 뒤쪽 값이 잘린다. 접으면 여러 줄짜리 로고가 흩어지므로 로고 칸은 뗀다.
   */
  private unfoldFooter(footer: Row[], pool: Map<string, Row[]>): Row[] | null {
    const width = this.el.clientWidth - 24;
    // 넘치는지는 이 pane·이 폭에서 본 가장 넓은 상태줄로 가린다. 그때그때의 폭으로 가리면 경계에 걸린 상태줄이 숫자 한 자리
    // (컨텍스트 3% ↔ 13%)에 한 줄로 줄였다 펴서 접었다를 오가며 높이가 바뀐다.
    if (this.footerSeen.pane !== this.paneId || this.footerSeen.width !== width) this.footerSeen = { pane: this.paneId, width, cols: 0 };
    const cols = (this.footerSeen.cols = Math.max(this.footerSeen.cols, ...footer.map((r) => rowCols(r, true))));
    if (width <= 0 || cols * FIT_MIN_PX * 0.62 <= width) return null;
    const cut = Math.max(0, ...footer.map((r) => (r.logo ??= logoCols(r.text))));
    const out: Row[] = [];
    for (const row of footer) {
      const at = row.logo! > 0 ? cut : 0;
      if (row.unfold?.cut !== at) row.unfold = { cut: at, line: unfoldLine(row.line, at) };
      const next = this.reline(row, row.unfold.line, pool);
      // 로고만 있던 줄은 비어 버린다 — 빈 줄로 남기지 않는다.
      if (next.text.trim() !== "") out.push(next);
    }
    return out;
  }

  /** 고쳐 쓴 줄을 그린다. 그려 둔 같은 줄이 있으면 그 요소를 쓰고, 새로 그린 줄은 다음 그리기에서 쓰도록 rows 에 넣는다. */
  private reline(row: Row, line: string, pool: Map<string, Row[]>, panel = false): Row {
    const key = (panel ? PANEL_KEY : "") + styleKey(row.start) + line;
    const next = key === row.key ? row : (pool.get(key)?.pop() ?? (panel ? renderPanel(line, row.start) : renderLine(line, row.start, true)));
    if (next !== row) this.rows.push(next);
    return next;
  }

  private draw(raw: readonly string[]): void {
    const { tail } = this.options;
    const reflow = this.flowing;
    if (this.untuned) this.tune();
    // 앞서 그린 줄 가운데 글과 스타일이 같은 것은 요소를 그대로 쓴다. 글자를 치면 그 한 줄만 다시 만든다(큰 화면에서
    // 0.3ms — 전부 새로 만들면 20ms 안팎). 화면이 통째로 밀릴 때는 줄을 다시 써도 배치 값이 그대로라 덕을 보지 못한다.
    const pool = new Map<string, Row[]>();
    for (let i = this.rows.length - 1; i >= 0; i -= 1) {
      const row = this.rows[i]!;
      const same = pool.get(row.key);
      if (same) same.push(row);
      else pool.set(row.key, [row]);
    }
    let style: Style = {};
    let rows = (reflow ? (stackPanes(raw) ?? raw) : raw).map((full) => {
      const line = reflow ? trimTrailing(full) : full;
      const row = pool.get(styleKey(style) + line)?.pop() ?? renderLine(line, style, reflow);
      style = row.end;
      return row;
    });
    this.rows = rows;
    if (tail || reflow || this.back > 0) while (rows.length > 1 && rows[rows.length - 1]!.text.trim() === "") rows = rows.slice(0, -1);
    let footerAt = reflow && this.fitFooter ? footerStart(rows.map((r) => r.text)) : -1;
    if (tail) {
      const offset = Math.max(0, rows.length - tail);
      rows = rows.slice(-tail);
      if (footerAt >= 0) footerAt = Math.max(0, footerAt - offset);
    }
    // 상태줄이 하한 크기에서도 넘쳐 끝이 잘리면(넓은 pane 을 좁은 곳에서 볼 때) 줄이지 않고 펴서 접는다.
    let unfolded = false;
    /** 앞줄에 이어 붙여 그리지 않을 줄. */
    let gone: Set<number> | undefined;
    if (reflow && footerAt >= 0 && footerAt < rows.length) {
      const open = this.unfoldFooter(rows.slice(footerAt), pool);
      if (open) {
        rows = [...rows.slice(0, footerAt), ...open];
        unfolded = true;
      }
    }
    if (reflow) {
      const banners = this.fitFooter ? bannerRanges(rows, footerAt >= 0 ? footerAt : rows.length) : [];

      const fitCols = new Array<number>(rows.length).fill(0);
      // 상태줄·배너는 넘치는 끝을 잘라도 되지만(fit), 표는 잘리면 값을 잃으므로 넘치면 가로로 민다(grid).
      const grid = new Array<boolean>(rows.length).fill(false);
      const applyGroup = (from: number, to: number, trimGap: boolean, isGrid = false) => {
        let max = 0;
        for (let i = from; i < to; i += 1) max = Math.max(max, rowCols(rows[i]!, trimGap));
        if (max > 0) for (let i = from; i < to; i += 1) {
          fitCols[i] = max;
          grid[i] = isGrid;
        }
      };
      const body = footerAt >= 0 ? footerAt : rows.length;
      const grids = gridRanges(rows.map((r) => r.text), body);
      // 표의 모든 줄에서 비어 있는 긴 칸 구간은 떼어 낸다. 배너 상자는 로고 자리가 흐트러지지 않게 두고 따로 맞춘다.
      // 표가 아닌 상자(선택지 대화상자 같은 글 상자)가 본문 크기로도 넘치면, 칸을 지키지 않고 오른쪽 테두리를 떼어 글을 접는다.
      const kept: Array<[number, number]> = [];
      const forms = new Map<string, BoxForm>();
      let bodyCols = 0;
      for (const [from, to] of grids) {
        if (banners.some(([b, e]) => from < e && b < to)) {
          kept.push([from, to]);
          continue;
        }
        const group = rows.slice(from, to);
        const key = group.map((r) => r.key).join("\n");
        const form = this.boxForms.get(key) ?? boxForm(group);
        forms.set(key, form);
        bodyCols ||= Math.max(1, (this.el.clientWidth - 24) / (parseFloat(getComputedStyle(this.el).fontSize) * 0.62));
        const fits = form.table || form.cols <= bodyCols;
        if (fits) kept.push([from, to]);
        const lines = fits ? form.lines : (form.panel ??= panelLines(group.map((r) => r.line), form.lines ?? undefined));
        if (!lines) continue;
        if (rows === this.rows) rows = rows.slice();
        group.forEach((row, i) => {
          const line = lines[i];
          if (line === null) (gone ??= new Set()).add(from + i);
          else rows[from + i] = this.reline(row, line!, pool, !fits);
        });
      }
      this.boxForms = forms;
      for (const [from, to] of kept) applyGroup(from, to, false, true);
      if (!unfolded && footerAt >= 0 && footerAt < rows.length) applyGroup(footerAt, rows.length, true);
      for (const [from, to] of banners) applyGroup(from, to, false);

      rows.forEach((row, i) => {
        const cols = fitCols[i]!;
        const fit = cols > 0;
        row.node.classList.toggle("fit", fit && !grid[i]);
        row.node.classList.toggle("grid", fit && grid[i]!);
        if (fit) {
          const next = String(cols);
          if (row.node.style.getPropertyValue("--fit-cols") !== next) row.node.style.setProperty("--fit-cols", next);
        } else if (row.node.style.getPropertyValue("--fit-cols")) {
          row.node.style.removeProperty("--fit-cols");
        }
      });
    }
    const drop = gone;
    if (drop) rows = rows.filter((_, i) => !drop.has(i));
    const stick = this.back === 0 || this.el.scrollHeight - this.el.scrollTop - this.el.clientHeight < 40;
    // 남는 줄은 붙어 있는 채로 두고, 빠진 줄만 떼고 새 줄만 끼운다.
    const keep = new Set<Node>(rows.map((r) => r.node));
    for (const child of [...this.el.childNodes]) if (!keep.has(child)) child.remove();
    let at = this.el.firstChild;
    for (const { node } of rows) {
      if (at === node) at = at.nextSibling;
      else this.el.insertBefore(node, at);
    }
    // 지금 화면(크게 보기)도 창보다 길면 입력줄이 있는 아래에 붙인다 — 사용자가 위로 올려 둔 동안에는 그대로 둔다.
    if (tail || this.back === 0 ? this.pinned : stick) this.el.scrollTop = this.el.scrollHeight;
  }
}

// ── 키 입력 ────────────────────────────────────────────────────────────────────────────────────

/** herdr 가 pane 의 모드에 맞춰 인코딩해 주는 논리 키. */
const LOGICAL: Record<string, string> = {
  Enter: "enter",
  Escape: "esc",
  Tab: "tab",
  Backspace: "backspace",
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
};

/** herdr 에 논리 키가 없어 바이트로 직접 넣는 키. */
const RAW: Record<string, string> = {
  Home: "\x1b[H",
  End: "\x1b[F",
  PageUp: "\x1b[5~",
  PageDown: "\x1b[6~",
  Delete: "\x1b[3~",
  Insert: "\x1b[2~",
};

/**
 * 한글 자판으로 친 자모를 두벌식에서 같은 자리의 영문 글자로. Ctrl·Alt 조합은 PC 에서도 IME 를 거치지 않고 영문 자리로
 * 가므로, 한글 자판을 띄운 채 Alt 를 걸고 ㅡ 를 눌러도 Alt+M 이 되게 한다.
 */
const DUBEOLSIK: Record<string, string> = Object.fromEntries(
  [..."ㅂㅈㄷㄱㅅㅛㅕㅑㅐㅔㅁㄴㅇㄹㅎㅗㅓㅏㅣㅋㅌㅊㅍㅠㅜㅡㅃㅉㄸㄲㅆㅒㅖ"].map((jamo, i) => [jamo, "qwertyuiopasdfghjklzxcvbnmQWERTOP"[i]!]),
);

/** 조합 키. 실제 키보드에서 눌린 것이든, 화면 단추로 걸어 둔 것이든. */
interface Mods {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
}

type Input = { text?: string; keys?: string[]; raw?: boolean };

/** 키 하나(KeyboardEvent.key 의 값)와 조합 키를 pane 으로 보낼 입력으로 바꾼다. 보낼 것이 없으면 null. */
function chord(key: string, mods: Mods): Input | null {
  const logical = LOGICAL[key];
  if (logical) {
    return { keys: [`${mods.ctrl ? "ctrl+" : ""}${mods.alt ? "alt+" : ""}${mods.shift ? "shift+" : ""}${logical}`] };
  }
  if (RAW[key]) return { text: RAW[key], raw: true };
  if (/^F([1-9]|1[0-2])$/.test(key)) return { keys: [key.toLowerCase()] };
  if ([...key].length !== 1) return null;
  if (!mods.ctrl && !mods.alt) return { text: key };
  const ch = DUBEOLSIK[key] ?? key;
  // Alt 는 ESC 를 앞에 붙인다 — herdr 의 alt+글자 와 같은 바이트이고, Claude Code 도 맨 Esc 가 아닌 Alt 로 읽는다.
  const esc = mods.alt ? "\x1b" : "";
  if (mods.ctrl) {
    // Ctrl+글자는 제어 문자 그대로 — 셸이든 TUI 든 가장 널리 통한다.
    const code = ch.toUpperCase().charCodeAt(0);
    if (code >= 64 && code <= 95) return { text: esc + String.fromCharCode(code - 64), raw: true };
    if (ch === " ") return { text: `${esc}\x00`, raw: true };
    return null;
  }
  return { text: esc + ch, raw: true };
}

/** 키 입력 하나를 pane 으로 보낼 입력으로 바꾼다. 보낼 것이 없으면(조합 키만 눌림 등) null. */
export function keyToInput(e: KeyboardEvent, held: { ctrl: boolean; alt: boolean } = { ctrl: false, alt: false }): Input | null {
  if (e.metaKey) return null;
  return chord(e.key, { ctrl: e.ctrlKey || held.ctrl, alt: e.altKey || held.alt, shift: e.shiftKey });
}

const BACK_LINES = 1200;
const PAGE_UP = "\x1b[5~";
const PAGE_DOWN = "\x1b[6~";
/** 끌거나 휠을 굴려 앱 화면을 넘길 때 한 번 넘긴 뒤 다음 넘김까지 기다리는 시간(ms) — 화면이 새로 올 틈. */
const PAGE_GAP_MS = 350;
/** 화면 끝에서 이만큼(px) 더 끌면 앱 화면을 한 쪽 넘긴다. */
const PAGE_PULL_PX = 48;

/** 화면 자판에 없는 키들 — 크게 보기 위쪽에 단추로 둔다(터치 기기에서만 보인다). */
/** 글자 기호(← ⏎ ⌫ ⇧)는 기기의 글꼴마다 굵기와 높이가 달라 선 아이콘으로 그린다. label 은 읽어 주는 이름이 된다. */
/** latch 는 누를 때 보내지 않고 걸어 두었다가 다음 키 하나에 붙이는 조합 키다. */
const SOFT_KEYS: Array<{ label: string; icon?: IconName; caption?: string; keys?: string[]; text?: string; latch?: "ctrl" | "alt" }> = [
  { label: "Esc", keys: ["esc"] },
  { label: "Ctrl", latch: "ctrl" },
  { label: "Alt", latch: "alt" },
  { label: "Tab", keys: ["tab"] },
  { label: "Shift+Tab", icon: "shift", caption: "Tab", keys: ["shift+tab"] },
  { label: "Left", icon: "left", keys: ["left"] },
  { label: "Down", icon: "down", keys: ["down"] },
  { label: "Up", icon: "up", keys: ["up"] },
  { label: "Right", icon: "right", keys: ["right"] },
  { label: "Enter", icon: "enter", keys: ["enter"] },
  { label: "Backspace", icon: "backspace", keys: ["backspace"] },
  { label: "^C", text: "\x03" },
  { label: "^D", text: "\x04" },
  { label: "^R", text: "\x12" },
];

/**
 * 크게 보는 터미널. 화면 전체를 덮고, 열려 있는 동안 키 입력은 모두 pane 으로 간다.
 * 한글은 숨은 입력란으로 조합을 받아 완성된 글자만 보낸다. Shift+Esc 로 닫는다.
 */
export class TermOverlay {
  private readonly root = document.createElement("div");
  private readonly title = document.createElement("b");
  private readonly sub = document.createElement("span");
  private readonly backBtn = document.createElement("button");
  private readonly planBtn = document.createElement("button");
  private readonly screen = new TermScreen({ live: true });
  private readonly ime = document.createElement("textarea");
  private readonly body = document.createElement("div");
  private readonly flowMedia = matchMedia(FLOW_MEDIA);
  private cols = 120;
  private pending = "";
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  /** 보내고 아직 답을 받지 못한 입력의 수. */
  private sending = 0;
  /** 화면 단추로 걸어 둔 조합 키. 다음 키 하나에 붙고 풀린다. */
  private readonly held = { ctrl: false, alt: false };
  private readonly latchBtns: Partial<Record<"ctrl" | "alt", HTMLButtonElement>> = {};
  /** 화면 자판이 조합 중인지(한글, 또는 단어 추천을 켠 영문). */
  private composing = false;
  /**
   * 스크롤백이 없는 에이전트 pane(전체 화면으로 도는 Claude Code 등)이면 true — 지난 출력은 앱에 PageUp 을 보내 앱의
   * 화면을 넘겨 본다. 열 때 서버에 묻고, 답이 오기 전에는 undefined.
   */
  private pages: boolean | undefined;
  /** 앱 화면을 위로 넘긴 횟수. 돌아갈 때(지금 화면으로, 창 닫기) 그만큼 PageDown 을 보낸다. */
  private paged = 0;
  private pagedAt = 0;
  /** 조합이 끝나기 전에 이미 보낸 앞부분. 뒤늦게 오는 compositionend 에서 떼어 낸다. */
  private sentEarly = "";
  onError: ((message: string) => void) | undefined;
  /** 보고 있던 pane 이 herdr 에서 사라져 창을 닫을 때 알린다. */
  onGone: ((title: string) => void) | undefined;
  /** 열리고 닫힐 때 알린다 — 열려 있는 동안에는 뒤의 월드가 가려진다. */
  onToggle: ((open: boolean) => void) | undefined;
  /** 머리줄의 플랜 읽기 단추를 눌렀다. */
  onPlan: ((paneId: string) => void) | undefined;

  constructor() {
    this.root.id = "term-overlay";
    this.root.hidden = true;
    const head = document.createElement("header");
    const hint = document.createElement("span");
    hint.className = "hint";
    hint.textContent = t("입력은 그대로 터미널로 갑니다 · Shift+Esc 닫기");
    this.backBtn.type = "button";
    this.backBtn.className = "btn";
    this.backBtn.addEventListener("click", () => this.toggleBack());
    this.planBtn.type = "button";
    this.planBtn.className = "btn plan";
    this.planBtn.hidden = true;
    this.planBtn.title = t("플랜 읽기");
    this.planBtn.setAttribute("aria-label", t("플랜 읽기"));
    this.planBtn.append(icon("file"), Object.assign(document.createElement("span"), { textContent: t("플랜 읽기") }));
    this.planBtn.addEventListener("click", () => this.onPlan?.(this.screen.pane));
    const close = document.createElement("button");
    close.type = "button";
    close.className = "btn icon";
    close.append(icon("close"));
    close.title = t("닫기 (Shift+Esc)");
    close.setAttribute("aria-label", t("닫기 (Shift+Esc)"));
    close.addEventListener("click", () => this.close());
    const names = document.createElement("div");
    names.className = "names";
    names.append(this.title, this.sub);
    head.append(names, hint, this.planBtn, this.backBtn, close);

    const soft = document.createElement("div");
    soft.className = "soft-keys";
    for (const key of SOFT_KEYS) {
      const btn = document.createElement("button");
      btn.type = "button";
      if (key.icon) {
        btn.setAttribute("aria-label", key.label);
        btn.title = key.label;
        btn.append(icon(key.icon));
        if (key.caption) btn.append(Object.assign(document.createElement("span"), { textContent: key.caption }));
      } else btn.textContent = key.label;
      // 단추를 눌러도 입력란의 초점(과 화면 자판)이 그대로 있도록 한다.
      btn.addEventListener("pointerdown", (e) => e.preventDefault());
      const latch = key.latch;
      if (latch) {
        btn.setAttribute("aria-pressed", "false");
        btn.title = t("다음 키에 {key} 붙이기", { key: key.label });
        this.latchBtns[latch] = btn;
        btn.addEventListener("click", () => {
          this.commitComposition();
          this.setHeld(latch, !this.held[latch]);
        });
      } else {
        btn.addEventListener("click", () => {
          this.commitComposition();
          this.flush();
          this.sendHeld(this.softInput(key));
        });
      }
      soft.append(btn);
    }
    const keyboard = document.createElement("button");
    keyboard.type = "button";
    keyboard.append(icon("keyboard"));
    keyboard.setAttribute("aria-label", t("자판 열기"));
    keyboard.title = t("자판 열기");
    keyboard.addEventListener("click", () => this.ime.focus());
    soft.append(keyboard);

    this.ime.className = "ime";
    this.ime.setAttribute("aria-label", t("터미널 입력"));
    // 터치 기기에서는 이 입력란이 화면 아래에 보인다(조합 중인 글자를 볼 수 있게).
    this.ime.placeholder = t("여기에 치면 터미널로 들어갑니다");
    this.ime.rows = 1;
    this.ime.autocapitalize = "off";
    this.ime.spellcheck = false;
    this.body.className = "body";
    this.body.append(this.screen.el, this.ime);
    this.root.append(head, soft, this.body);
    document.body.append(this.root);

    // 스크롤백이 없는 앱은 화면 끝에서 더 끌거나 굴리면 앱 화면을 넘긴다 — 위 끝에서 더 내리면 지난 출력으로,
    // 넘겨 둔 동안 아래 끝에서 더 올리면 다시 아래로.
    const el = this.screen.el;
    const atTop = () => el.scrollTop <= 0;
    const atBottom = () => el.scrollHeight - el.scrollTop - el.clientHeight < 2;
    let pullY: number | undefined;
    el.addEventListener("touchstart", (e) => {
      pullY = e.touches.length === 1 ? e.touches[0]!.clientY : undefined;
    }, { passive: true });
    el.addEventListener("touchmove", (e) => {
      if (!this.pages || pullY === undefined) return;
      const y = e.touches[0]!.clientY;
      // 끝에 닿기 전에 끈 거리는 세지 않는다 — 끝에 닿은 뒤로 더 끈 만큼만.
      if (!(atTop() && y > pullY) && !(atBottom() && y < pullY)) pullY = y;
      else if (y - pullY > PAGE_PULL_PX) {
        this.page(1);
        pullY = y;
      } else if (pullY - y > PAGE_PULL_PX) {
        this.page(-1);
        pullY = y;
      }
    }, { passive: true });
    el.addEventListener("wheel", (e) => {
      if (!this.pages) return;
      if (e.deltaY < 0 && atTop()) this.page(1);
      else if (e.deltaY > 0 && atBottom()) this.page(-1);
    }, { passive: true });

    this.body.addEventListener("mouseup", () => {
      // 글을 긁어 복사하는 중이면 초점을 빼앗지 않는다.
      if (!window.getSelection()?.toString()) this.ime.focus();
    });
    this.ime.addEventListener("keydown", (e) => this.onKey(e));
    this.ime.addEventListener("compositionstart", () => {
      // 새 조합이다 — 앞서 끊은 조합의 확정이 뒤늦게 올 일은 없다.
      this.composing = true;
      this.sentEarly = "";
    });
    this.ime.addEventListener("input", (e) => {
      const data = (e as InputEvent).data;
      if ((e as InputEvent).isComposing) {
        this.composing = true;
        // 조합 키를 걸어 두었으면 조합이 끝나기를 기다리지 않는다 — 한글 자판은 ㅡ 하나를 다음 글자가 올 때까지 쥐고 있다.
        // 첫 글자에 조합 키를 붙여 보내고, 입력란을 비워 조합을 끊는다.
        if (this.isHeld() && data) {
          this.sentEarly = data;
          this.ime.value = "";
          this.composing = false;
          this.typeHeld([...data].at(-1)!);
        }
        return;
      }
      const typed = this.takeEarly(this.ime.value);
      this.ime.value = "";
      if (this.isHeld()) this.typeHeld(typed);
      else this.type(typed);
    });
    // 화면 자판은 지우기·줄바꿈을 keydown 이 아니라 이 이벤트로만 알려 주는 경우가 많다.
    this.ime.addEventListener("beforeinput", (e) => {
      if (e.isComposing) return;
      if (e.inputType === "deleteContentBackward" && this.ime.value === "") {
        e.preventDefault();
        this.flush();
        this.sendHeld(chord("Backspace", this.mods()));
      } else if (e.inputType === "insertLineBreak" || e.inputType === "insertParagraph") {
        e.preventDefault();
        this.flush();
        this.sendHeld(chord("Enter", this.mods()));
      }
    });
    this.ime.addEventListener("compositionend", (e) => {
      this.composing = false;
      this.type(this.takeEarly(e.data ?? ""));
      this.ime.value = "";
    });
    this.ime.addEventListener("paste", (e) => {
      e.preventDefault();
      // 붙여넣기는 herdr 가 pane 의 붙여넣기 모드에 맞춰 감싸 넣도록 text 로 보낸다.
      const text = e.clipboardData?.getData("text/plain") ?? "";
      this.flush();
      if (text) this.send({ text });
    });
    this.screen.onGone = () => {
      // 치고 있던 창이 말없이 사라지면 고장으로 보인다 — 왜 닫혔는지 알린다.
      this.onGone?.(this.title.textContent ?? "");
      this.close();
    };
    // 탭을 보고 있지 않은 동안에는 읽지 않는다 — 열어 둔 채 잊어도 herdr 를 계속 읽지 않게.
    document.addEventListener("visibilitychange", () => {
      if (this.root.hidden) return;
      if (document.visibilityState === "hidden") this.screen.stop();
      else this.screen.start(this.screen.pane, this.screen.scrollback);
    });
    new ResizeObserver(() => this.fit()).observe(this.body);
    this.flowMedia.addEventListener("change", () => this.fit());
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  /** 보고 있는 pane. */
  get pane(): string {
    return this.screen.pane;
  }

  /** 이 pane 이 플랜 승인을 기다리는지 — 그동안 머리줄에 플랜 읽기 단추를 둔다. */
  setPlan(on: boolean): void {
    this.planBtn.hidden = !on;
  }

  /** 입력을 다시 터미널로 돌린다(위에 떴던 창이 닫힌 뒤). */
  focus(): void {
    if (!this.root.hidden) this.ime.focus();
  }

  open(paneId: string, title: string, sub: string, cols: number | undefined): void {
    this.cols = cols && cols > 20 ? cols : 120;
    this.title.textContent = title;
    this.sub.textContent = sub;
    this.root.hidden = false;
    this.screen.start(paneId, 0);
    this.pages = undefined;
    this.paged = 0;
    void get<{ page: boolean }>(`/api/term/back?pane=${encodeURIComponent(paneId)}`)
      .then((r) => {
        if (this.screen.pane === paneId) this.pages = r.page;
      })
      .catch(() => {});
    this.syncBack();
    this.fit();
    this.ime.focus();
    this.onToggle?.(true);
  }

  close(): void {
    if (this.root.hidden) return;
    this.flush();
    this.setHeld("ctrl", false);
    this.setHeld("alt", false);
    // 넘겨 둔 앱 화면은 지금 화면으로 돌려 두고 닫는다 — PC 에서 보는 화면도 같은 pane 이다.
    this.unpage();
    this.root.hidden = true;
    this.screen.stop();
    this.onToggle?.(false);
  }

  private toggleBack(): void {
    if (this.paged > 0) this.unpage();
    else if (this.pages) {
      this.page(1);
      this.screen.toTop();
    } else this.screen.start(this.screen.pane, this.screen.scrollback > 0 ? 0 : BACK_LINES);
    this.syncBack();
    this.ime.focus();
  }

  /** 앱 화면을 한 쪽 넘긴다(1 위로, -1 아래로). 손가락을 끌어 연달아 들어오는 것은 PAGE_GAP_MS 에 한 번만. */
  private page(dir: 1 | -1): void {
    const now = performance.now();
    if (now - this.pagedAt < PAGE_GAP_MS || (dir < 0 && this.paged === 0)) return;
    this.pagedAt = now;
    this.paged += dir;
    this.send({ text: dir > 0 ? PAGE_UP : PAGE_DOWN, raw: true });
    this.syncBack();
  }

  /** 넘겨 둔 앱 화면을 맨 아래로 돌린다. 앱이 그새 스스로 내려갔어도 남는 PageDown 은 해가 없다. */
  private unpage(): void {
    if (this.paged <= 0) return;
    this.send({ text: PAGE_DOWN.repeat(this.paged + 2), raw: true });
    this.paged = 0;
    this.screen.toBottom();
    this.syncBack();
  }

  private syncBack(): void {
    const on = this.screen.scrollback > 0 || this.paged > 0;
    this.backBtn.textContent = on ? t("지금 화면으로") : t("지난 출력 보기");
    this.screen.el.classList.toggle("back", on);
  }

  /** 화면의 칸 수가 창 너비에 들어가도록 글자 크기를 맞춘다. */
  private fit(): void {
    if (this.root.hidden) return;
    const flow = this.flowMedia.matches;
    // 접어 보일 때는 입력창 아래의 상태줄도 미리보기처럼 접지 않고 폭에 맞춘다.
    this.screen.fitFooter = flow;
    this.screen.flow = flow;
    const width = this.body.clientWidth - 28;
    // 칸을 다 넣으려다 글자가 깨알이 되느니, 읽을 만한 크기로 두고 가로로 민다.
    // 칸 수가 적은 pane 은 글자를 조금 키우고(읽기 좋은 데까지만), 그래도 남는 폭은 양옆에 고르게 둔다(스타일시트).
    // 그렇게 고른 크기에서 칸이 기기 픽셀의 정수배가 되도록 조금 줄인다(setFont) — 세로선이 줄마다·칸마다 같은 자리에 그어진다.
    if (flow) this.screen.setFont(FLOW_FONT_PX, false);
    else this.screen.setFont(Math.max(MIN_FONT_PX, Math.min(MAX_FONT_PX, width / (this.cols * 0.6))), true, MIN_FONT_PX);
    this.screen.el.style.setProperty("--cols", String(this.cols));
    // 글자 크기가 바뀌면 화면 높이도 바뀐다 — 아래에 붙어 있었으면 다시 붙인다.
    this.screen.restoreScroll();
  }

  private isHeld(): boolean {
    return this.held.ctrl || this.held.alt;
  }

  private mods(): Mods {
    return { ctrl: this.held.ctrl, alt: this.held.alt, shift: false };
  }

  private setHeld(which: "ctrl" | "alt", on: boolean): void {
    this.held[which] = on;
    this.latchBtns[which]?.setAttribute("aria-pressed", String(on));
  }

  /** 키 줄 단추 하나를 보낼 입력으로. 걸어 둔 조합 키가 있으면 붙인다. */
  private softInput(key: (typeof SOFT_KEYS)[number]): Input | null {
    const { ctrl, alt } = this.held;
    if (key.keys) return { keys: key.keys.map((k) => `${ctrl ? "ctrl+" : ""}${alt ? "alt+" : ""}${k}`) };
    // ^C 같은 제어 문자 단추는 이미 Ctrl 이 붙어 있다 — Alt 만 더한다.
    return { text: `${alt ? "\x1b" : ""}${key.text ?? ""}`, raw: true };
  }

  /** 조합 키를 붙인 입력을 보내고 걸어 둔 조합 키를 푼다. */
  private sendHeld(input: Input | null): void {
    if (!input) return;
    this.send(input);
    this.setHeld("ctrl", false);
    this.setHeld("alt", false);
  }

  /** 조합 키를 걸어 둔 채 들어온 글자. 첫 글자에만 붙이고 나머지는 그대로 친다. */
  private typeHeld(text: string): void {
    const [first, ...rest] = [...text];
    if (!first) return;
    this.flush();
    const input = chord(first, this.mods());
    // 조합 키를 붙일 수 없는 글자(Ctrl+완성된 한글 등)는 그냥 치고, 걸어 둔 것은 다음 키를 위해 남긴다.
    if (input) this.sendHeld(input);
    else this.type(first);
    this.type(rest.join(""));
  }

  /** 조합 중인 글자를 확정해 먼저 보낸다 — 키 줄 단추가 그보다 앞질러 가지 않게. */
  private commitComposition(): void {
    if (!this.composing || !this.ime.value) return;
    const text = this.ime.value;
    this.sentEarly = text;
    this.ime.value = "";
    this.composing = false;
    this.type(text);
    this.flush();
  }

  /**
   * 조합을 끊고 먼저 보낸 글자가 뒤늦게 다시 들어오면 떼어 낸다. 입력란을 비우면 브라우저는 조합을 접지만 화면 자판은
   * 저마다 달라서, 쥐고 있던 글자를 compositionend 로도, 그냥 글자 넣기로도 다시 보낼 수 있다.
   */
  private takeEarly(text: string): string {
    const early = this.sentEarly;
    this.sentEarly = "";
    return early && text.startsWith(early) ? text.slice(early.length) : text;
  }

  private send(input: { text?: string; keys?: string[]; raw?: boolean }): void {
    this.sending += 1;
    void sendInput(this.screen.pane, input)
      .catch((e: Error) => this.onError?.(e.message))
      .finally(() => {
        this.sending -= 1;
        if (this.sending === 0) this.flush();
      });
  }

  /**
   * 친 글자는 키보드가 보내는 바이트 그대로(raw) 넣는다 — text 로 보내면 붙여넣기로 취급돼, 키 입력을
   * 기다리는 대화상자가 받지 않는다.
   *
   * 앞서 보낸 입력의 답을 기다리는 동안 친 글자는 모아 두었다가 한 번에 보낸다. 글자마다 요청을 줄 세우면
   * herdr 가 느리게 답할 때(한 번에 0.1초까지) 빨리 칠수록 뒤로 밀린다.
   */
  private type(text: string): void {
    if (!text) return;
    this.pending += text;
    if (this.sending > 0) return;
    // 조합이 끝나며 한꺼번에 들어오는 글자들을 한 번에 싣도록 이번 차례가 끝난 뒤에 보낸다.
    clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => this.flush(), 0);
  }

  private flush(): void {
    clearTimeout(this.flushTimer);
    if (!this.pending) return;
    this.send({ text: this.pending, raw: true });
    this.pending = "";
  }

  private onKey(e: KeyboardEvent): void {
    // 이 안에서 누른 키는 월드의 단축키가 아니다.
    e.stopPropagation();
    if (e.key === "Escape" && e.shiftKey) {
      e.preventDefault();
      this.close();
      return;
    }
    if (e.isComposing || e.key === "Process") return;
    // 복사·붙여넣기·새로고침 같은 브라우저 조합은 그대로 둔다.
    if (e.ctrlKey && e.shiftKey && /^[cv]$/i.test(e.key)) return;
    if (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === "v") return;
    const input = keyToInput(e, this.held);
    if (!input) return;
    // 그냥 글자는 input 이벤트로 받는다(한글 조합과 같은 길).
    if (input.text !== undefined && !input.raw) return;
    e.preventDefault();
    this.flush();
    this.sendHeld(input);
  }
}
