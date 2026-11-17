// 화면의 말을 고르는 곳. 바탕은 한국어이고, 영어는 한국어 문장을 열쇠로 삼아 찾는다.
//
//   t("집 짓기")                         → "집 짓기" / "Build a house"
//   t("에이전트 {n}", { n: agents.length }) → "에이전트 3" / "3 agents"
//
// 한국어 문장이 곧 열쇠라 코드를 읽을 때 무엇이 보이는지 그대로 보이고, 영어 풀이가 빠진 문장은 한국어로 나온다
// (`bun run i18n` 이 빠진 것과 남아도는 것을 찾아 준다). 말을 바꾸면 페이지를 다시 읽는다 — 이미 지어 둔 화면
// 조각마다 글을 갈아 끼우는 길을 따로 두지 않는다.
import { en } from "./locale/en.ts";

export type Lang = "ko" | "en";

const KEY = "agent-world.lang";

function chosen(): Lang {
  try {
    // 주소에 ?lang=en 을 붙여 열면 그 말로 정하고 기억한다(전환 단추가 안 보이는 화면에서 쓰는 길).
    const asked = new URLSearchParams(location.search).get("lang");
    if (asked === "ko" || asked === "en") {
      localStorage.setItem(KEY, asked);
      return asked;
    }
    const kept = localStorage.getItem(KEY);
    if (kept === "ko" || kept === "en") return kept;
  } catch {
    // 저장소를 못 쓰면 서버가 정해 준 말을 쓴다.
  }
  // 서버가 문서에 적어 준 기본 말(AGENT_WORLD_LANG). 따로 정하지 않았으면 한국어다.
  return document.documentElement.lang === "en" ? "en" : "ko";
}

export const lang: Lang = chosen();
document.documentElement.lang = lang;

/** 한국어 문장을 지금 말로. `{이름}` 자리는 params 의 값으로 채운다. */
export function t(ko: string, params?: Record<string, string | number>): string {
  const text = lang === "en" ? (en[ko] ?? ko) : ko;
  return params ? text.replace(/\{(\w+)\}/g, (whole, name: string) => (name in params ? String(params[name]) : whole)) : text;
}

/** 말을 바꾸고 페이지를 다시 읽는다. */
export function setLang(next: Lang): void {
  try {
    localStorage.setItem(KEY, next);
  } catch {
    // 기억하지 못해도 이번 한 번은 주소로 넘긴다.
  }
  const url = new URL(location.href);
  url.searchParams.set("lang", next);
  location.replace(url);
}

/**
 * index.html 에 적혀 있는 글(단추 이름, 안내, 도움말 줄)을 지금 말로 바꾼다. 화면 조각을 짓기 전에 한 번 부른다.
 * 글자 노드와 title·placeholder·aria-label 을 본다. 풀이가 없는 글은 그대로 둔다.
 */
export function localizeStatic(root: ParentNode = document): void {
  if (lang === "ko") return;
  for (const el of root.querySelectorAll<HTMLElement>("[title], [placeholder], [aria-label]")) {
    for (const attr of ["title", "placeholder", "aria-label"]) {
      const value = el.getAttribute(attr);
      if (value && en[value]) el.setAttribute(attr, en[value]);
    }
  }
  const walker = document.createTreeWalker(root instanceof Document ? root.body : (root as Node), NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const raw = node.nodeValue ?? "";
    const key = raw.trim();
    if (key && en[key]) node.nodeValue = raw.replace(key, en[key]);
  }
}
