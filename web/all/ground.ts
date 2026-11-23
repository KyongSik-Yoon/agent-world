// 섬 하나의 땅 그림(SVG): 섬, 마당과 길, 광장, 집·나무·돌. 배치가 바뀔 때만 다시 만든다 — 한 번 칠해지면 그대로다.
// 집·나무·돌의 본은 all.html 의 <defs> 에 있고 여기서는 <use> 로 찍는다. 글(문패)은 넣지 않는다.
import { at, CX, CY, type Geo, HOUSE_AT, PLAZA, px, SQUASH, VH, VW, yardScale } from "./geometry.ts";

const NS = "http://www.w3.org/2000/svg";
const f1 = (n: number): string => n.toFixed(1);

function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** seed 는 월드마다 나무가 다르게 서게 하는 값(월드의 id). 같은 월드는 늘 같은 자리에 선다. */
export function ground(seed: string, g: Geo): SVGSVGElement {
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${VW} ${VH}`);
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("ground");
  const ry = 322 * SQUASH;
  const parts: string[] = [
    `<path class="f-rock3" d="M40 ${CY + 14} 360 ${CY + 232} 680 ${CY + 14}Z"/>`,
    `<path class="f-rock1" d="M40 ${CY + 14} 190 ${CY + 60} 250 ${CY + 176}Z"/>`,
    `<path class="f-rock2" d="M190 ${CY + 60} 360 ${CY + 70} 360 ${CY + 232} 250 ${CY + 176}Z"/>`,
    `<path class="f-rock1" opacity=".8" d="M360 ${CY + 70} 540 ${CY + 58} 470 ${CY + 170} 360 ${CY + 232}Z"/>`,
    `<path class="f-rock2" opacity=".7" d="M540 ${CY + 58} 680 ${CY + 14} 470 ${CY + 170}Z"/>`,
    `<ellipse class="f-rim" cx="${CX}" cy="${CY + 12}" rx="322" ry="${f1(ry + 2)}"/>`,
    `<ellipse class="f-grass" cx="${CX}" cy="${CY}" rx="322" ry="${f1(ry)}"/>`,
    `<ellipse class="f-grass3" opacity=".7" cx="${CX + 190}" cy="${CY + 82}" rx="74" ry="24"/>`,
    `<ellipse class="f-grass2" opacity=".7" cx="${CX - 196}" cy="${CY + 70}" rx="80" ry="22"/>`,
    `<ellipse class="f-grass3" opacity=".6" cx="${CX - 20}" cy="${CY - 104}" rx="96" ry="20"/>`,
  ];
  for (const p of g.list) {
    const k = yardScale(g, p);
    const [yx, yy] = at(g, p, 34, 0);
    parts.push(`<ellipse class="f-sand" cx="${f1(yx)}" cy="${f1(yy)}" rx="${f1(56 * k)}" ry="${f1(56 * k * 0.6)}"/>`);
    if (p.house.main) {
      const [ax, ay] = at(g, p, 70, 0);
      const d = Math.hypot(p.x, p.z);
      const [bx, by] = px(g, (p.x / d) * PLAZA * 0.8, (p.z / d) * PLAZA * 0.8);
      parts.push(`<path class="s-sand" d="M${f1(ax)} ${f1(ay)} ${f1(bx)} ${f1(by)}" stroke-width="${f1(15 * k)}" stroke-linecap="round" fill="none"/>`);
    }
  }
  const pr = PLAZA * g.u;
  parts.push(
    `<ellipse class="f-stone" cx="${CX}" cy="${CY}" rx="${f1(pr)}" ry="${f1(pr * SQUASH)}"/>`,
    `<ellipse class="s-stone" cx="${CX}" cy="${CY}" rx="${f1(pr * 0.72)}" ry="${f1(pr * 0.72 * SQUASH)}" stroke-width="2"/>`,
    `<ellipse class="s-stone" cx="${CX}" cy="${CY}" rx="${f1(pr * 0.4)}" ry="${f1(pr * 0.4 * SQUASH)}" stroke-width="2"/>`,
  );
  // 집·나무·돌은 뒤에서 앞으로 그린다.
  const things: Array<{ y: number; html: string }> = [];
  for (const p of g.list) {
    const [hx, hy] = at(g, p, HOUSE_AT, 0);
    const k = g.hs * p.scale;
    // 문이 광장 쪽을 보게, 오른쪽에 선 집은 뒤집는다.
    const flip = p.fx < -0.2 || (Math.abs(p.fx) <= 0.2 && p.x > 0) ? -1 : 1;
    things.push({
      y: hy,
      html: `<use href="#house" style="--r1:hsl(${p.hue} 62% 76%);--r2:hsl(${p.hue} 44% 62%)" transform="translate(${f1(hx)} ${f1(hy)}) scale(${(k * flip).toFixed(3)} ${k.toFixed(3)}) translate(-156 -233)"/>`,
    });
  }
  const rand = rng(hash(seed) * 7919 + 13);
  const free = (x: number, z: number, room: number): boolean => {
    if (Math.hypot(x, z) < PLAZA + room) return false;
    for (const p of g.list) {
      if (Math.hypot(x - p.x, z - p.z) < (5.4 + room) * p.scale) return false;
      const d = Math.hypot(p.x, p.z);
      const t = Math.max(0, Math.min(1, (x * p.x + z * p.z) / (d * d)));
      if (Math.hypot(x - p.x * t, z - p.z * t) < 1.6 + room) return false;
    }
    return true;
  };
  const R = 300 / g.u;
  let placed = 0;
  for (let tries = 0; tries < 500 && placed < 20; tries += 1) {
    const a = rand() * Math.PI * 2;
    // 나무는 주로 섬 가장자리에 — 집과 마당, 광장의 캐릭터를 가리지 않게.
    const r = (placed % 5 >= 3 ? Math.sqrt(0.15 + rand() * 0.7) : 0.82 + rand() * 0.14) * R;
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    const kind = placed % 5 === 3 ? "rock" : placed % 5 === 4 ? "bush" : "tree";
    const size = (0.7 + rand() * 0.4) * (0.6 + (g.hs / 0.6) * 0.4);
    if (!free(x, z, kind === "tree" ? 0.6 : 0)) continue;
    const [tx, ty] = px(g, x, z);
    things.push({ y: ty, html: `<use href="#${kind}" transform="translate(${f1(tx)} ${f1(ty)}) scale(${size.toFixed(2)})"/>` });
    placed += 1;
  }
  things.sort((a, b) => a.y - b.y);
  for (const thing of things) parts.push(thing.html);
  // 숫자와 정해진 글자로만 지은 그림이다 — 월드에서 온 글(이름·문패)은 여기에 들어가지 않는다.
  svg.innerHTML = parts.join("");
  return svg;
}
