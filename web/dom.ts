// 화면 조각들이 함께 쓰는 작은 DOM 도구.
import type { AgentStatus } from "../shared/types.ts";

export type Child = Node | string | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") el.className = v;
    else el.setAttribute(k, v);
  }
  for (const c of children) if (c) el.append(c);
  return el;
}

/** 선으로 그린 아이콘(24×24 판). 글자 기호(↵ ✓ ⤢ ✕ ＋)는 기기의 글꼴마다 굵기와 자리가 달라서 쓰지 않는다. */
const ICONS = {
  open: "M14 4h6v6M20 4l-8.5 8.5M18 14v5H5V6h5",
  check: "M5 12.5 9.5 17 19 7.5",
  copy: "M9 9h11v11H9zM15 9V4H4v11h5",
  pencil: "M4 20h4L19.5 8.5l-4-4L4 16zM13.5 6.5l4 4",
  house: "M4.5 11.5 12 5l7.5 6.5M6.5 10.2V19h11v-8.8M10 19v-5h4v5",
  close: "M6 6l12 12M18 6 6 18",
  expand: "M14 4h6v6M10 20H4v-6M20 4l-6.5 6.5M4 20l6.5-6.5",
  terminal: "M3.5 5h17v14h-17zM7 9.5l3 2.5-3 2.5M12.5 15h4.5",
  plus: "M12 5v14M5 12h14",
  enter: "M19 5v6a2 2 0 0 1-2 2H6M9.5 8.5 6 13l3.5 4.5",
  up: "M12 19V5.5M6.5 11 12 5.5l5.5 5.5",
  down: "M12 5v13.5M6.5 13l5.5 5.5 5.5-5.5",
  shift: "M12 4.5 4.5 12.5H9V19h6v-6.5h4.5z",
  left: "M19 12H5.5M11 6.5 5.5 12l5.5 5.5",
  right: "M5 12h13.5M13 6.5l5.5 5.5-5.5 5.5",
  backspace: "M8.5 6h10.5a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H8.5L3 12zM12.5 10l4 4M16.5 10l-4 4",
  keyboard: "M3.5 6.5h17v11h-17zM7 10h.01M10 10h.01M13 10h.01M16 10h.01M8 14h8",
  chevron: "M9 6l6 6-6 6",
  info: "M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 1 0 0-17zM12 11v5.5M12 7.6v.1",
  play: "M8 5.5v13l10.5-6.5z",
  splitRight: "M3.5 5h17v14h-17zM12 5v14",
  splitDown: "M3.5 5h17v14h-17zM3.5 12h17",
  trash: "M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 12.5h9l1-12.5",
  // 활동 로그의 종류 표시.
  bolt: "M13 3.5 5.5 13.5H11L10 20.5l8.5-10.5H13z",
  dots: "M6 12h.01M12 12h.01M18 12h.01",
  chat: "M4.5 5h15v11h-8L7 19.5V16H4.5z",
  person: "M12 4.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 1 0 0-7zM5 19.5c.8-3.3 3.5-5 7-5s6.2 1.7 7 5",
  file: "M6.5 3.5h7l4 4v13h-11zM13.5 3.5v4h4M9.5 12.5h5M9.5 16h5",
  search: "M10.5 4.5a6 6 0 1 0 0 12 6 6 0 1 0 0-12zM15 15l4.5 4.5",
  people: "M9.5 5a3 3 0 1 0 0 6 3 3 0 1 0 0-6zM3.5 19c.6-2.9 2.9-4.5 6-4.5s5.4 1.6 6 4.5M15.5 5.2a3 3 0 0 1 0 5.6M17.5 14.8c1.6.6 2.6 2 3 4.2",
  globe: "M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 1 0 0-17zM3.5 12h17M12 3.5c-4.5 5-4.5 12 0 17M12 3.5c4.5 5 4.5 12 0 17",
  // 목록 서랍 꺼내기(위 막대와 상태 창 머리). index.html 의 #btn-roster 도 같은 선을 쓴다.
  menu: "M5 7h14M5 12h14M5 17h14",
  list: "M9 6.5h10.5M9 12h10.5M9 17.5h10.5M4.5 6.5h.01M4.5 12h.01M4.5 17.5h.01",
  spark: "M12 4l2.2 5.3L19.5 12l-5.3 2.7L12 20l-2.2-5.3L4.5 12l5.3-2.7z",
  compass: "M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 1 0 0-17zM15.5 8.5l-2 5-5 2 2-5z",
  plug: "M9 3.5v5M15 3.5v5M6.5 8.5h11v3a5.5 5.5 0 0 1-11 0zM12 17v3.5",
  box: "M12 3.5l7.5 4v9l-7.5 4-7.5-4v-9zM4.5 7.5l7.5 4 7.5-4M12 11.5v9",
  // 말풍선: 일하는 중, 질문, 권한 요청.
  clock: "M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 1 0 0-17zM12 7.5V12l3 2",
  question: "M12 3.5a8.5 8.5 0 1 0 0 17 8.5 8.5 0 1 0 0-17zM9.6 9.6a2.5 2.5 0 1 1 3.4 2.3c-.6.3-1 .8-1 1.5v.6M12 16.9v.1",
  lock: "M6 11h12v9H6zM8.5 11V8a3.5 3.5 0 0 1 7 0v3",
  // 위쪽 막대와 집 패널.
  bell: "M5.5 17h13l-1.5-2.2V10.5a5 5 0 0 0-10 0v4.3zM10 20h4",
  moon: "M19.5 14.6A7.5 7.5 0 0 1 9.4 4.5a7.8 7.8 0 1 0 10.1 10.1z",
  sun: "M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 1 0 0-7zM12 3v1.5M12 19.5V21M3 12h1.5M19.5 12H21M5.6 5.6l1.1 1.1M17.3 17.3l1.1 1.1M5.6 18.4l1.1-1.1M17.3 6.7l1.1-1.1",
} as const;

export type IconName = keyof typeof ICONS;

export function icon(name: IconName): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "ico");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", ICONS[name]);
  svg.append(path);
  return svg;
}

export function stored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** 값이 null 이면 지운다. */
export function store(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // 저장소를 못 써도 화면은 그대로 돈다.
  }
}

export const STATUS_VAR: Record<AgentStatus, string> = {
  blocked: "var(--blocked)",
  done: "var(--done)",
  working: "var(--working)",
  idle: "var(--idle)",
  unknown: "var(--idle)",
};

const INLINE = /(`[^`\n]+`|\*\*[^\n]+?\*\*|~~[^~\n]+~~|(?<![\w*])\*(?![\s*])[^*\n]+?(?<![\s*])\*(?![\w*])|\[[^\]\n]+\]\((?:https?|file):[^)\s]+\)|https?:\/\/[^\s<>()\[\]`"']+)/g;

/** 한 줄 안의 꾸밈: 코드, 굵게, 기울임, 취소선, 링크. */
function inline(target: Node, text: string): void {
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    let token = m[0];
    target.appendChild(document.createTextNode(text.slice(last, m.index)));
    last = m.index + token.length;
    if (token.startsWith("`")) target.appendChild(h("code", {}, token.slice(1, -1)));
    else if (token.startsWith("**")) inline(target.appendChild(h("b")), token.slice(2, -2));
    else if (token.startsWith("~~")) inline(target.appendChild(h("s")), token.slice(2, -2));
    else if (token.startsWith("*")) inline(target.appendChild(h("i")), token.slice(1, -1));
    else if (token.startsWith("[")) {
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token)!;
      // 로컬 파일 링크는 브라우저가 열 수 없으니 이름만 코드로 보여 준다.
      if (link[2]!.startsWith("http")) inline(target.appendChild(h("a", { href: link[2]!, target: "_blank", rel: "noreferrer" })), link[1]!);
      else target.appendChild(h("code", {}, link[1]!));
    } else {
      // 맨 주소. 문장 끝의 구두점은 주소에 넣지 않는다.
      const tail = /[.,;:!?]+$/.exec(token)?.[0] ?? "";
      token = token.slice(0, token.length - tail.length);
      target.appendChild(h("a", { href: token, target: "_blank", rel: "noreferrer" }, token));
      last -= tail.length;
    }
  }
  target.appendChild(document.createTextNode(text.slice(last)));
}

/** 표의 한 줄을 칸으로 나눈다. 코드 안의 `|` 와 `\|` 는 칸을 가르지 않는다. */
function cells(line: string): string[] {
  const out: string[] = [];
  let cell = "";
  let code = false;
  const body = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i]!;
    if (ch === "\\" && body[i + 1] === "|") {
      cell += "|";
      i += 1;
    } else if (ch === "|" && !code) {
      out.push(cell.trim());
      cell = "";
    } else {
      if (ch === "`") code = !code;
      cell += ch;
    }
  }
  out.push(cell.trim());
  return out;
}

const TABLE_RULE = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;
const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const FENCE = /^\s*(```|~~~)/;

/**
 * 응답 글(마크다운)을 그린다: 제목, 문단, 목록, 표, 코드 블록, 인용, 가로줄.
 * innerHTML 을 쓰지 않고 노드로만 만든다 — 에이전트가 쓴 글이 그대로 들어오기 때문이다.
 */
export function prose(text: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let i = 0;
  const startsBlock = (line: string, next: string | undefined): boolean =>
    FENCE.test(line) || /^#{1,6}\s/.test(line) || LIST_ITEM.test(line) || /^\s*>/.test(line) || /^\s*([-*_])(\s*\1){2,}\s*$/.test(line) || (line.includes("|") && next !== undefined && next.includes("-") && next.includes("|") && TABLE_RULE.test(next));

  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      i += 1;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i]!.trim().startsWith(fence[1]!)) body.push(lines[i++]!);
      i += 1;
      frag.append(h("pre", {}, h("code", {}, body.join("\n"))));
      continue;
    }

    const heading = /^(#{1,6})\s+(.*?)\s*#*$/.exec(line);
    if (heading) {
      const el = h("div", { class: `h h${Math.min(heading[1]!.length, 3)}` });
      inline(el, heading[2]!);
      frag.append(el);
      i += 1;
      continue;
    }

    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      frag.append(h("hr"));
      i += 1;
      continue;
    }

    const next = lines[i + 1];
    if (line.includes("|") && next !== undefined && next.includes("-") && next.includes("|") && TABLE_RULE.test(next)) {
      const aligns = cells(next).map((c) => (c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : ""));
      const row = (texts: string[], tag: "th" | "td"): HTMLElement => {
        const tr = h("tr");
        texts.forEach((t, col) => {
          const cell = h(tag, aligns[col] ? { style: `text-align:${aligns[col]}` } : {});
          inline(cell, t);
          tr.append(cell);
        });
        return tr;
      };
      const body = h("tbody");
      const table = h("table", {}, h("thead", {}, row(cells(line), "th")), body);
      i += 2;
      while (i < lines.length && lines[i]!.trim() && lines[i]!.includes("|")) body.append(row(cells(lines[i++]!), "td"));
      frag.append(h("div", { class: "table" }, table));
      continue;
    }

    if (LIST_ITEM.test(line)) {
      // 들여쓰기 깊이로 목록을 겹친다. 번호 없는 이어지는 줄은 바로 앞 항목에 붙인다.
      const stack: Array<{ indent: number; list: HTMLElement; item?: HTMLElement }> = [];
      while (i < lines.length) {
        const cur = lines[i]!;
        const m = LIST_ITEM.exec(cur);
        if (!m) {
          const top = stack[stack.length - 1];
          if (!cur.trim() || !top?.item || !/^\s/.test(cur) || startsBlock(cur, lines[i + 1])) break;
          top.item.append("\n");
          inline(top.item, cur.trim());
          i += 1;
          continue;
        }
        const indent = m[1]!.replace(/\t/g, "    ").length;
        while (stack.length > 1 && indent < stack[stack.length - 1]!.indent) stack.pop();
        let top = stack[stack.length - 1];
        if (!top || indent > top.indent + 1) {
          const ordered = /\d/.test(m[2]!);
          const list = h(ordered ? "ol" : "ul", ordered && m[2]!.slice(0, -1) !== "1" ? { start: m[2]!.slice(0, -1) } : {});
          if (top?.item) top.item.append(list);
          else frag.append(list);
          stack.push((top = { indent, list }));
        }
        const task = /^\[([ xX])\]\s+(.*)$/.exec(m[3]!);
        top.item = h("li", task ? { class: "task" } : {});
        if (task) top.item.append(h("input", { type: "checkbox", tabindex: "-1", "aria-readonly": "true", ...(task[1] === " " ? {} : { checked: "" }) }));
        inline(top.item, task ? task[2]! : m[3]!);
        top.list.append(top.item);
        i += 1;
      }
      continue;
    }

    if (/^\s*>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i]!)) body.push(lines[i++]!.replace(/^\s*>\s?/, ""));
      frag.append(h("blockquote", {}, prose(body.join("\n"))));
      continue;
    }

    const para: string[] = [line];
    i += 1;
    while (i < lines.length && lines[i]!.trim() && !startsBlock(lines[i]!, lines[i + 1])) para.push(lines[i++]!);
    const p = h("p");
    inline(p, para.join("\n"));
    frag.append(p);
  }
  return frag;
}
