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
