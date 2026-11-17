// 터미널 미러: herdr 가 읽어 준 화면(SGR 색상 코드가 섞인 글)을 그리고, 키 입력을 pane 으로 보낸다.
//
// herdr 는 화면을 "지금 보이는 그대로"의 줄들로 준다 — 커서 이동이 없고 색·굵기 코드만 있다. 그래서
// 터미널 에뮬레이터 없이 줄마다 span 으로 그리면 된다. 표와 테두리가 어긋나지 않도록 한글 같은
// 전각 문자는 2칸, 글꼴에 없을 법한 기호는 1칸 너비의 상자에 넣는다.
import { get, sendInput } from "./api.ts";

interface TermTheme {
  background: string;
  foreground: string;
  palette: string[];
}

let palette: string[] = [];

/** 사용자의 터미널 테마를 받아 온다. 화면의 색은 그 배경을 전제로 골라진 것이다. */
export async function loadTermTheme(): Promise<void> {
  try {
    const theme = await get<TermTheme>("/api/term/theme");
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

/** 한 줄 안의 글을 칸에 맞춰 노드로 만든다. */
function cells(text: string, into: HTMLElement): void {
  let plain = "";
  const flush = () => {
    if (plain) into.append(plain);
    plain = "";
  };
  for (const ch of text) {
    if (SAFE.test(ch)) {
      plain += ch;
      continue;
    }
    flush();
    const box = document.createElement("span");
    box.className = WIDE.test(ch) ? "w2" : "w1";
    box.textContent = ch;
    into.append(box);
  }
  flush();
}

// eslint-disable-next-line no-control-regex
const ESCAPE = /\x1b\[([0-9;:]*)([A-Za-z])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

// eslint-disable-next-line no-control-regex
const TRAILING = /(?:\x1b\[[0-9;:]*m|[ \t])+$/;

/**
 * SGR 이 섞인 화면 글을 줄 단위 요소로 바꾼다.
 * reflow 면 좁은 곳에서 읽기 좋게 줄 끝 공백을 걷어 낸다(줄은 CSS 가 접는다).
 */
export function renderAnsi(text: string, reflow = false): HTMLDivElement[] {
  const lines: HTMLDivElement[] = [];
  let style: Style = {};
  for (const full of text.split(/\r?\n/)) {
    const raw = reflow ? full.replace(TRAILING, "") : full;
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
    if (!line.hasChildNodes()) line.append("\u200b");
    // 가로줄뿐인 줄은 접히면 여러 줄을 차지하므로 한 줄로 잘라 보여 준다.
    else if (reflow && /^[\s\u2500-\u257F]+$/.test(line.textContent ?? "")) line.classList.add("rule");
    lines.push(line);
  }
  return lines;
}

function plainText(line: HTMLElement): string {
  return (line.textContent ?? "").replace(/\u200b/g, "");
}

export interface ScreenOptions {
  /** 아래에서부터 비지 않은 줄 몇 개만 보여 준다(미리보기). 없으면 화면 전체. */
  tail?: number;
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
  private lastText: string | undefined;

  constructor(private readonly options: ScreenOptions = {}) {
    this.el.className = "term";
    this.el.textContent = "화면을 읽는 중…";
  }

  get pane(): string {
    return this.paneId;
  }

  get scrollback(): number {
    return this.back;
  }

  /** back 이 0 이면 지금 보이는 화면, 크면 그만큼의 스크롤백까지 읽는다. */
  start(paneId: string, back = 0): void {
    if (this.source && paneId === this.paneId && back === this.back) return;
    this.stop();
    this.paneId = paneId;
    this.back = back;
    this.lastText = undefined;
    this.el.textContent = "화면을 읽는 중…";
    const source = new EventSource(`/api/term?pane=${encodeURIComponent(paneId)}&back=${back}`);
    this.source = source;
    source.addEventListener("screen", (e) => this.draw((JSON.parse((e as MessageEvent<string>).data) as { text: string }).text));
    const gone = () => {
      this.stop();
      this.el.textContent = "이 pane 은 닫혔습니다.";
      this.onGone?.();
    };
    source.addEventListener("gone", gone);
    source.onerror = () => {
      // 오류 응답을 받은 EventSource 는 다시 붙지 않는다. pane 이 사라진 것인지(404) 서버가 잠깐 꺼진 것인지
      // 가려서, 꺼진 것이면 조금 뒤에 새로 연다.
      if (source.readyState !== EventSource.CLOSED || this.source !== source) return;
      this.source = undefined;
      void fetch(`/api/screen?pane=${encodeURIComponent(paneId)}`)
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
    this.source?.close();
    this.source = undefined;
  }

  get running(): boolean {
    return this.source !== undefined;
  }

  /** fitFooter 를 바꾼 뒤, 받아 둔 화면으로 다시 그린다. */
  redraw(): void {
    if (this.lastText !== undefined) this.draw(this.lastText);
  }

  private draw(text: string): void {
    this.lastText = text;
    const { tail } = this.options;
    let lines = renderAnsi(text, tail !== undefined);
    const trim = () => {
      while (lines.length > 1 && plainText(lines[lines.length - 1]!).trim() === "") lines.pop();
    };
    if (tail || this.back > 0) trim();
    if (tail && this.fitFooter) {
      const start = footerStart(lines.map(plainText));
      if (start > 0) for (const line of lines.slice(start)) line.classList.add("fit");
    }
    if (tail) lines = lines.slice(-tail);
    const stick = this.back === 0 || this.el.scrollHeight - this.el.scrollTop - this.el.clientHeight < 40;
    this.el.replaceChildren(...lines);
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
  private readonly screen = new TermScreen();
  private readonly ime = document.createElement("textarea");
  private readonly body = document.createElement("div");
  private cols = 120;
  private pending = "";
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  onError: ((message: string) => void) | undefined;

  constructor() {
    this.root.id = "term-overlay";
    this.root.hidden = true;
    const head = document.createElement("header");
    const hint = document.createElement("span");
    hint.className = "hint";
    hint.textContent = "입력은 그대로 터미널로 갑니다 · Shift+Esc 닫기";
    this.backBtn.type = "button";
    this.backBtn.className = "btn";
    this.backBtn.addEventListener("click", () => this.toggleBack());
    const close = document.createElement("button");
    close.type = "button";
    close.className = "btn icon";
    close.textContent = "✕";
    close.title = "닫기 (Shift+Esc)";
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
    keyboard.title = "자판 열기";
    keyboard.addEventListener("click", () => this.ime.focus());
    soft.append(keyboard);

    this.ime.className = "ime";
    this.ime.setAttribute("aria-label", "터미널 입력");
    // 터치 기기에서는 이 입력란이 화면 아래에 보인다(조합 중인 글자를 볼 수 있게).
    this.ime.placeholder = "여기에 치면 터미널로 들어갑니다";
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
    this.screen.onGone = () => this.close();
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
  }

  close(): void {
    if (this.root.hidden) return;
    this.flush();
    this.root.hidden = true;
    this.screen.stop();
  }

  private toggleBack(): void {
    this.screen.start(this.screen.pane, this.screen.scrollback > 0 ? 0 : BACK_LINES);
    this.syncBack();
    this.ime.focus();
  }

  private syncBack(): void {
    const on = this.screen.scrollback > 0;
    this.backBtn.textContent = on ? "지금 화면으로" : "지난 출력 보기";
    this.screen.el.classList.toggle("back", on);
  }

  /** 화면의 칸 수가 창 너비에 들어가도록 글자 크기를 맞춘다. */
  private fit(): void {
    if (this.root.hidden) return;
    const width = this.body.clientWidth - 28;
    // 좁은 화면에서는 칸을 다 넣으려다 글자가 깨알이 되느니, 읽을 만한 크기로 두고 가로로 민다.
    const floor = window.innerWidth < 760 ? 10 : 7;
    const size = Math.max(floor, Math.min(14, width / (this.cols * 0.6)));
    this.screen.el.style.fontSize = `${size.toFixed(2)}px`;
  }

  private send(input: { text?: string; keys?: string[]; raw?: boolean }): void {
    void sendInput(this.screen.pane, input).catch((e: Error) => this.onError?.(e.message));
  }

  /**
   * 친 글자는 키보드가 보내는 바이트 그대로(raw) 넣는다 — text 로 보내면 붙여넣기로 취급돼, 키 입력을
   * 기다리는 대화상자가 받지 않는다. 빠르게 친 글자들은 모아서 한 번에 보낸다.
   */
  private type(text: string): void {
    if (!text) return;
    this.pending += text;
    clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => this.flush(), 12);
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
