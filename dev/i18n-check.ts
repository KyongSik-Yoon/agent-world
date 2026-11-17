// 화면 코드의 t("…") 문장과 index.html 의 글이 영어 풀이(web/locale/en.ts)와 맞는지 본다.
//
//   bun run i18n          빠진 풀이·남아도는 풀이·자리 이름이 어긋난 풀이를 찍고, 있으면 1 로 끝난다
//
// t() 의 첫 인자는 늘 글자 그대로의 문자열이어야 한다(변수나 `${}` 가 든 문장은 열쇠가 될 수 없다) — 그것도 본다.
import { Glob } from "bun";

import { en } from "../web/locale/en.ts";

const used = new Map<string, string>();
const problems: string[] = [];
const CALL = /\bt\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|`((?:[^`\\]|\\.)*)`|([^)\s]))/g;

for await (const file of new Glob("web/**/*.ts").scan(".")) {
  if (file.startsWith("web/locale/") || file === "web/i18n.ts") continue;
  const text = await Bun.file(file).text();
  for (const m of text.matchAll(CALL)) {
    const line = text.slice(0, m.index).split("\n").length;
    if (m[4] !== undefined) {
      problems.push(`${file}:${line} t() 의 첫 인자가 글자 그대로의 문자열이 아니다`);
      continue;
    }
    const raw = m[1] ?? m[2] ?? m[3] ?? "";
    if (m[3] !== undefined && raw.includes("${")) {
      problems.push(`${file}:${line} t() 안에 \${} 가 있다 — {이름} 자리와 params 로 바꿔야 한다`);
      continue;
    }
    // 소스의 이스케이프(\n, \")를 실제 글자로.
    const key = JSON.parse(`"${raw.replace(/\\'/g, "'").replace(/(?<!\\)"/g, '\\"').replace(/\n/g, "\\n")}"`) as string;
    if (!used.has(key)) used.set(key, `${file}:${line}`);
  }
}

// index.html 의 글: 한글이 든 글자 노드와 title·placeholder·aria-label.
const html = await Bun.file("web/index.html").text();
const HANGUL = /[가-힣]/;
for (const m of html.matchAll(/(?:title|placeholder|aria-label)="([^"]*)"/g)) if (HANGUL.test(m[1]!)) used.set(m[1]!, "web/index.html");
const body = html.slice(html.indexOf("<body"));
for (const m of body.matchAll(/>([^<>]+)</g)) {
  const text = m[1]!.trim();
  if (text && HANGUL.test(text) && !used.has(text)) used.set(text, "web/index.html");
}

const slots = (s: string): string => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");
for (const [key, where] of used) {
  const english = en[key];
  if (english === undefined) problems.push(`${where} 영어 풀이가 없다: ${JSON.stringify(key)}`);
  else if (slots(key) !== slots(english)) problems.push(`${where} 자리 이름이 다르다: ${JSON.stringify(key)} ↔ ${JSON.stringify(english)}`);
}
for (const key of Object.keys(en)) if (!used.has(key)) problems.push(`web/locale/en.ts 쓰이지 않는 풀이: ${JSON.stringify(key)}`);

for (const p of problems) console.log(p);
console.log(`${used.size}문장, 문제 ${problems.length}건`);
process.exit(problems.length ? 1 : 0);
