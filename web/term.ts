// 터미널 미러: herdr 가 읽어 준 화면(SGR 색상 코드가 섞인 글)을 그리고, 키 입력을 pane 으로 보낸다.
//
// herdr 는 화면을 "지금 보이는 그대로"의 줄들로 준다 — 커서 이동이 없고 색·굵기 코드만 있다. 그래서
// 터미널 에뮬레이터 없이 줄마다 span 으로 그리면 된다. 표와 테두리가 어긋나지 않도록 한글 같은
// 전각 문자는 2칸, 글꼴에 없을 법한 기호는 1칸 너비의 상자에 넣는다.
import { get, sendInput, headers } from "./api.ts";
import { withKey } from "./key.ts";
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
  if (bg) out += `background:${bg};`;
  if (s.bold) out += "font-weight:700;";
  if (s.dim) out += "opacity:.62;";
  if (s.italic) out += "font-style:italic;";
  if (s.underline || s.strike) out += `text-decoration:${[s.underline ? "underline" : "", s.strike ? "line-through" : ""].join(" ").trim()};`;
  return out;
}

const WIDE = /[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6\u{1F300}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{1F900}-\u{1F9FF}\u{20000}-\u{3FFFD}]/u;
/** 고정폭 글꼴이 제 너비로 그려 주는 글자들 — 나머지는 상자에 넣어 칸을 맞춘다. */
const SAFE = /[ -\u024F\u2500-\u259F\u2800-\u28FF]/;

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
    if (SAFE.test(cell[0]!)) {
      plain += cell;
      continue;
    }
    flush();
    const box = document.createElement("span");
    box.className = WIDE.test(cell) ? "w2" : "w1";
    box.textContent = cell;
    into.append(box);
  }
  flush();
}

// eslint-disable-next-line no-control-regex
const ESCAPE = /\x1b\[([0-9;:]*)([A-Za-z])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

// eslint-disable-next-line no-control-regex
const TRAILING = /(?:\x1b\[[0-9;:]*m|[ \t])+$/;

/** 그려 둔 줄 하나. 같은 글이 같은 스타일로 다시 오면 요소를 그대로 다시 쓴다. */
interface Row {
  /** 줄이 시작할 때의 스타일 + 줄의 글. 이것이 같으면 그림도 같다. */
  key: string;
  node: HTMLDivElement;
  /** 색상 코드를 뺀 글. */
  text: string;
  /** 줄이 끝났을 때의 스타일 — 다음 줄이 이어받는다. */
  end: Style;
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
  const emit = (chunk: string) => {
    if (!chunk) return;
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
  // 가로줄뿐인 줄은 접히면 여러 줄을 차지하므로 한 줄로 잘라 보여 준다.
  else if (reflow && /^[\s\u2500-\u257F]+$/.test(text)) line.classList.add("rule");
  return { key: styleKey(start) + raw, node: line, text, end: style };
}

export interface ScreenOptions {
  /** 아래에서부터 비지 않은 줄 몇 개만 보여 준다(미리보기). 없으면 화면 전체. */
  tail?: number;
  /** 흐르는 출력을 촘촘히 따라간다(크게 보기). 없으면 조용할 때의 간격으로 읽고, 입력 직후에만 서두른다. */
  live?: boolean;
}

/** 입력창 테두리로 볼 가로줄: ─ 만으로 된 긴 줄. 표의 테두리(┼ ┬ 가 섞인 줄)는 아니다. */
const INPUT_RULE = /^\u2500{20,}$/;
/** 입력창과 그 아래 꾸밈(상태줄·안내줄)이 차지할 수 있는 줄 수. */
const FOOTER_REACH = 24;
/** 입력창 안의 글이 차지할 수 있는 줄 수. 두 가로줄이 이보다 멀면 입력창이 아니라 대화를 가르는 줄이다. */
const INPUT_ROWS = 12;
/** 입력창의 첫 줄은 프롬프트 기호로 시작한다. 두 가로줄 사이가 이렇게 시작하지 않으면 입력창으로 보지 않는다. */
const PROMPT_LINE = /^\s{0,2}[\u276f>\u203a\u00bb]/;

/**
 * 입력창 아래의 꾸밈(상태줄·안내줄)이 시작하는 줄. 입력창을 확실히 찾지 못하면 -1.
 *
 * 데스크톱 폭에 맞춰 그린 상태줄은 좁은 미리보기에서 줄이 접혀 그림이 깨진다. 이 줄들은 접지 않고 한 줄씩,
 * 넘치는 끝만 … 로 끊어 보여 준다. 가로줄 두 개와 그 사이의 프롬프트 줄이 모두 보일 때만 그렇게 하므로,
 * 대화상자처럼 모양이 다른 화면은 평소대로 접혀 전부 나온다.
 */
export function footerStart(lines: readonly string[]): number {
  const rules: number[] = [];
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - FOOTER_REACH) && rules.length < 2; i -= 1) {
    if (INPUT_RULE.test(lines[i]!.trim())) rules.push(i);
  }
  const [bottom, top] = rules;
  if (bottom === undefined || top === undefined || bottom - top > INPUT_ROWS + 1) return -1;
  const first = lines.slice(top + 1, bottom).find((l) => l.trim() !== "");
  return first !== undefined && PROMPT_LINE.test(first) ? bottom + 1 : -1;
}

/** 한 번 그린 뒤, 그리는 데 든 시간의 이만큼을 쉰다. 칠하기까지 쳐서, 쉬지 않고 흐르는 큰 화면이 메인 스레드의 40% 안팎을 쓴다. */
const DRAW_REST = 4;
/** 아무리 무거워도 이보다 오래 쉬지는 않는다 — 초당 네 번은 그린다. */
const DRAW_REST_MAX_MS = 250;

/** 크게 보기에서 글자가 커질 수 있는 한도(px). 80칸짜리 pane 을 넓은 창에 띄워도 구석에 작게 몰리지 않게 한다. */
const MAX_FONT_PX = 17;

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
  /** 받아 둔 화면의 줄들(SGR 포함). 서버는 처음에 통째로, 그 뒤로는 달라진 줄만 보낸다. */
  private raw: string[] | undefined;
  private rows: Row[] = [];
  private frame = 0;
  /** 이 시각까지는 다시 그리지 않는다. */
  private restUntil = 0;
  private restTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly options: ScreenOptions = {}) {
    this.el.className = "term";
    this.el.textContent = t("화면을 읽는 중…");
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

  private draw(raw: readonly string[]): void {
    const { tail } = this.options;
    const reflow = tail !== undefined;
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
    let rows = raw.map((full) => {
      const line = reflow ? full.replace(TRAILING, "") : full;
      const row = pool.get(styleKey(style) + line)?.pop() ?? renderLine(line, style, reflow);
      style = row.end;
      return row;
    });
    this.rows = rows;
    if (tail || this.back > 0) while (rows.length > 1 && rows[rows.length - 1]!.text.trim() === "") rows = rows.slice(0, -1);
    if (tail) {
      const start = this.fitFooter ? footerStart(rows.map((r) => r.text)) : -1;
      rows.forEach((row, i) => row.node.classList.toggle("fit", start > 0 && i >= start));
      rows = rows.slice(-tail);
    }
    const stick = this.back === 0 || this.el.scrollHeight - this.el.scrollTop - this.el.clientHeight < 40;
    // 남는 줄은 붙어 있는 채로 두고, 빠진 줄만 떼고 새 줄만 끼운다.
    const keep = new Set<Node>(rows.map((r) => r.node));
    for (const child of [...this.el.childNodes]) if (!keep.has(child)) child.remove();
    let at = this.el.firstChild;
    for (const { node } of rows) {
      if (at === node) at = at.nextSibling;
      else this.el.insertBefore(node, at);
    }
    if (tail || (this.back > 0 && stick)) this.el.scrollTop = this.el.scrollHeight;
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

/** 키 입력 하나를 pane 으로 보낼 입력으로 바꾼다. 보낼 것이 없으면(조합 키만 눌림 등) null. */
export function keyToInput(e: KeyboardEvent): { text?: string; keys?: string[]; raw?: boolean } | null {
  if (e.metaKey) return null;
  const logical = LOGICAL[e.key];
  if (logical) {
    const mods = `${e.ctrlKey ? "ctrl+" : ""}${e.altKey ? "alt+" : ""}${e.shiftKey ? "shift+" : ""}`;
    return { keys: [`${mods}${logical}`] };
  }
  if (RAW[e.key]) return { text: RAW[e.key], raw: true };
  if (/^F([1-9]|1[0-2])$/.test(e.key)) return { keys: [e.key.toLowerCase()] };
  if (e.key.length !== 1) return null;
  if (e.ctrlKey) {
    // Ctrl+글자는 제어 문자 그대로 — 셸이든 TUI 든 가장 널리 통한다.
    const code = e.key.toUpperCase().charCodeAt(0);
    if (code >= 64 && code <= 95) return { text: String.fromCharCode(code - 64), raw: true };
    if (e.key === " ") return { text: "\x00", raw: true };
    return null;
  }
  if (e.altKey) return { text: `\x1b${e.key}`, raw: true };
  return { text: e.key };
}

const BACK_LINES = 1200;

/** 화면 자판에 없는 키들 — 크게 보기 위쪽에 단추로 둔다(터치 기기에서만 보인다). */
const SOFT_KEYS: Array<{ label: string; keys?: string[]; text?: string }> = [
  { label: "Esc", keys: ["esc"] },
  { label: "Tab", keys: ["tab"] },
  { label: "⇧Tab", keys: ["shift+tab"] },
  { label: "←", keys: ["left"] },
  { label: "↓", keys: ["down"] },
  { label: "↑", keys: ["up"] },
  { label: "→", keys: ["right"] },
  { label: "⏎", keys: ["enter"] },
  { label: "⌫", keys: ["backspace"] },
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
  private readonly screen = new TermScreen({ live: true });
  private readonly ime = document.createElement("textarea");
  private readonly body = document.createElement("div");
  private cols = 120;
  private pending = "";
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  /** 보내고 아직 답을 받지 못한 입력의 수. */
  private sending = 0;
  onError: ((message: string) => void) | undefined;
  /** 보고 있던 pane 이 herdr 에서 사라져 창을 닫을 때 알린다. */
  onGone: ((title: string) => void) | undefined;
  /** 열리고 닫힐 때 알린다 — 열려 있는 동안에는 뒤의 월드가 가려진다. */
  onToggle: ((open: boolean) => void) | undefined;

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
    const close = document.createElement("button");
    close.type = "button";
    close.className = "btn icon";
    close.textContent = "✕";
    close.title = t("닫기 (Shift+Esc)");
    close.addEventListener("click", () => this.close());
    const names = document.createElement("div");
    names.className = "names";
    names.append(this.title, this.sub);
    head.append(names, hint, this.backBtn, close);

    const soft = document.createElement("div");
    soft.className = "soft-keys";
    for (const key of SOFT_KEYS) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = key.label;
      // 단추를 눌러도 입력란의 초점(과 화면 자판)이 그대로 있도록 한다.
      btn.addEventListener("pointerdown", (e) => e.preventDefault());
      btn.addEventListener("click", () => {
        this.flush();
        this.send(key.keys ? { keys: key.keys } : { text: key.text, raw: true });
      });
      soft.append(btn);
    }
    const keyboard = document.createElement("button");
    keyboard.type = "button";
    keyboard.textContent = "⌨";
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

    this.body.addEventListener("mouseup", () => {
      // 글을 긁어 복사하는 중이면 초점을 빼앗지 않는다.
      if (!window.getSelection()?.toString()) this.ime.focus();
    });
    this.ime.addEventListener("keydown", (e) => this.onKey(e));
    this.ime.addEventListener("input", (e) => {
      if ((e as InputEvent).isComposing) return;
      this.type(this.ime.value);
      this.ime.value = "";
    });
    // 화면 자판은 지우기·줄바꿈을 keydown 이 아니라 이 이벤트로만 알려 주는 경우가 많다.
    this.ime.addEventListener("beforeinput", (e) => {
      if (e.isComposing) return;
      if (e.inputType === "deleteContentBackward" && this.ime.value === "") {
        e.preventDefault();
        this.flush();
        this.send({ keys: ["backspace"] });
      } else if (e.inputType === "insertLineBreak" || e.inputType === "insertParagraph") {
        e.preventDefault();
        this.flush();
        this.send({ keys: ["enter"] });
      }
    });
    this.ime.addEventListener("compositionend", (e) => {
      this.type(e.data);
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
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  open(paneId: string, title: string, sub: string, cols: number | undefined): void {
    this.cols = cols && cols > 20 ? cols : 120;
    this.title.textContent = title;
    this.sub.textContent = sub;
    this.root.hidden = false;
    this.screen.start(paneId, 0);
    this.syncBack();
    this.fit();
    this.ime.focus();
    this.onToggle?.(true);
  }

  close(): void {
    if (this.root.hidden) return;
    this.flush();
    this.root.hidden = true;
    this.screen.stop();
    this.onToggle?.(false);
  }

  private toggleBack(): void {
    this.screen.start(this.screen.pane, this.screen.scrollback > 0 ? 0 : BACK_LINES);
    this.syncBack();
    this.ime.focus();
  }

  private syncBack(): void {
    const on = this.screen.scrollback > 0;
    this.backBtn.textContent = on ? t("지금 화면으로") : t("지난 출력 보기");
    this.screen.el.classList.toggle("back", on);
  }

  /** 화면의 칸 수가 창 너비에 들어가도록 글자 크기를 맞춘다. */
  private fit(): void {
    if (this.root.hidden) return;
    const width = this.body.clientWidth - 28;
    // 좁은 화면에서는 칸을 다 넣으려다 글자가 깨알이 되느니, 읽을 만한 크기로 두고 가로로 민다.
    const floor = window.innerWidth < 760 ? 10 : 7;
    // 칸 수가 적은 pane 은 글자를 조금 키우고(읽기 좋은 데까지만), 그래도 남는 폭은 양옆에 고르게 둔다(스타일시트).
    const size = Math.max(floor, Math.min(MAX_FONT_PX, width / (this.cols * 0.6)));
    this.screen.el.style.fontSize = `${size.toFixed(2)}px`;
    this.screen.el.style.setProperty("--cols", String(this.cols));
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
    const input = keyToInput(e);
    if (!input) return;
    // 그냥 글자는 input 이벤트로 받는다(한글 조합과 같은 길).
    if (input.text !== undefined && !input.raw) return;
    e.preventDefault();
    this.flush();
    this.send(input);
  }
}
