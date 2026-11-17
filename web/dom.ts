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

/** 응답 글을 가볍게 꾸민다: 굵게, 코드, 제목, 링크. innerHTML 을 쓰지 않고 노드로만 만든다. */
export function prose(text: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  const inline = /(\*\*[^*\n]+\*\*|`[^`\n]+`|\[[^\]\n]+\]\((?:https?|file):[^)\s]+\))/g;
  text.split("\n").forEach((line, i) => {
    if (i > 0) frag.append("\n");
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    const target: Node = heading ? h("span", { class: "h" }) : frag;
    const body = heading ? heading[1]! : line;
    let last = 0;
    for (const m of body.matchAll(inline)) {
      target.appendChild(document.createTextNode(body.slice(last, m.index)));
      const token = m[0];
      if (token.startsWith("**")) target.appendChild(h("b", {}, token.slice(2, -2)));
      else if (token.startsWith("`")) target.appendChild(h("code", {}, token.slice(1, -1)));
      else {
        const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token)!;
        // 로컬 파일 링크는 브라우저가 열 수 없으니 이름만 코드로 보여 준다.
        if (link[2]!.startsWith("http")) target.appendChild(h("a", { href: link[2]!, target: "_blank", rel: "noreferrer" }, link[1]!));
        else target.appendChild(h("code", {}, link[1]!));
      }
      last = m.index + token.length;
    }
    target.appendChild(document.createTextNode(body.slice(last)));
    if (heading) frag.append(target);
  });
  return frag;
}
