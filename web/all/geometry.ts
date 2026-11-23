// 전체 보기의 섬 하나를 어떻게 놓는지: 집터의 자리와, 상태마다 캐릭터가 서는 자리.
//
// 3D 월드(web/world/layout.ts)와 같은 수(집터 한 칸의 폭, 별채 비율, 광장 반지름)로 고리 위에 집을 놓되, 위에서 비스듬히
// 본 그림 한 장이라 두 가지가 다르다. 섬 앞쪽 가운데는 비우고(앞에 선 집이 광장의 캐릭터를 가린다), 마당은 광장 쪽으로
// 열되 화면 위로는 향하지 않는다(집이 제 마당의 캐릭터 앞을 가린다).
import { hueOf } from "../../shared/lots.ts";
import type { DigestHouse, DigestStatus, WorldDigest } from "../../shared/types.ts";

export const VW = 720;
export const VH = 520;
export const CX = 360;
export const CY = 250;
export const SQUASH = 0.46;
export const PLAZA = 7.6;
const PLOT_ARC = 6.6;
const ANNEX = 0.7;
const MIN_RING = 16.5;
const SWEEP = (290 * Math.PI) / 180;
/** 집 그림이 가장 클 때의 배율. 마당 안의 자리는 이때의 화소로 적는다. */
const HOUSE_MAX = 0.6;

export interface Plot {
  house: DigestHouse;
  x: number;
  z: number;
  /** 마당이 열리는 쪽과 그 옆(화면 아래를 본다). */
  fx: number;
  fz: number;
  sx: number;
  sz: number;
  scale: number;
  /** 지붕 색상(0–360). 한 집터의 집들은 같은 색이다. */
  hue: number;
}

export interface Geo {
  /** 월드 좌표 1 이 그림에서 몇 화소인지. */
  u: number;
  plots: Map<string, Plot>;
  list: Plot[];
  /** 집 그림의 배율 — 집이 많아 이웃이 가까우면 줄어든다. */
  hs: number;
}

export function geometry(lots: WorldDigest["lots"]): Geo {
  const widths = lots.map((l) => l.houses.reduce((w, h) => w + PLOT_ARC * (h.main ? 1 : ANNEX), 0));
  const total = Math.max(
    PLOT_ARC,
    widths.reduce((a, b) => a + b, 0),
  );
  const ring = Math.max(MIN_RING, total / SWEEP);
  // 집이 적으면 뒤쪽 가운데로 모으되 조금 벌려 놓는다.
  const used = Math.min(SWEEP, (total / ring) * 1.6);
  const u = 300 / (ring + 7.2);
  const plots = new Map<string, Plot>();
  const list: Plot[] = [];
  let along = 0;
  for (const lot of lots) {
    const hue = Math.round(hueOf(lot.key) * 360);
    for (const house of lot.houses) {
      const w = PLOT_ARC * (house.main ? 1 : ANNEX);
      const a = Math.PI * 1.5 - used / 2 + ((along + w / 2) / total) * used;
      along += w;
      let fx = -Math.cos(a);
      let fz = Math.max(0, -Math.sin(a));
      const len = Math.hypot(fx, fz) || 1;
      fx /= len;
      fz /= len;
      let sx = fz;
      let sz = -fx;
      if (sz < 0) {
        sx = -sx;
        sz = -sz;
      }
      const p: Plot = { house, x: Math.cos(a) * ring, z: Math.sin(a) * ring, fx, fz, sx, sz, scale: house.main ? 1 : ANNEX, hue };
      plots.set(house.id, p);
      list.push(p);
    }
  }
  let gap = Infinity;
  for (let i = 1; i < list.length; i += 1) {
    const a = list[i - 1]!;
    const b = list[i]!;
    gap = Math.min(gap, Math.hypot((a.x - b.x) * u, (a.z - b.z) * u * SQUASH) / ((a.scale + b.scale) / 2));
  }
  return { u, plots, list, hs: Math.max(0.3, Math.min(HOUSE_MAX, gap / 140)) };
}

/** 월드 좌표를 그림의 화소로. */
export const px = (g: Geo, x: number, z: number): [number, number] => [CX + x * g.u, CY + z * g.u * SQUASH];

/** 집 그림은 실제 비율보다 크게 그린다. 그래서 마당 안의 자리도 월드 좌표가 아니라 집 그림의 크기를 따라간다. */
export const yardScale = (g: Geo, p: Plot): number => (g.hs / HOUSE_MAX) * p.scale;

/** 집터 안의 자리. front 는 마당이 열리는 쪽, side 는 그 옆 — 단위는 집 그림이 가장 클 때의 화소다. */
export function at(g: Geo, p: Plot, front: number, side: number): [number, number] {
  const [x, y] = px(g, p.x, p.z);
  const k = yardScale(g, p);
  return [x + (p.fx * front + p.sx * side) * k, y + (p.fz * front + p.sz * side) * k * 0.62];
}

/** 집이 서는 자리(마당 뒤). */
export const HOUSE_AT = -14;

const WORK: Array<[number, number]> = [
  [36, -22],
  [54, 18],
  [32, 12],
  [60, -6],
];
const PLAZA_RINGS = [
  { r: 3.6, n: 8 },
  { r: 5.9, n: 12 },
  { r: 8.4, n: 18 },
];

/**
 * 상태마다 서는 자리 — 월드와 같은 뜻이다: 일하면 제 마당, 확인이 필요하면 마당 앞(대문), 끝내면 광장, 쉬면 집 옆.
 * k 는 같은 자리 묶음 안에서의 차례.
 */
export function spot(g: Geo, p: Plot | undefined, s: DigestStatus, k: number): [number, number] {
  if (s === "done" || !p) {
    let i = k;
    for (const ring of PLAZA_RINGS) {
      if (i < ring.n) {
        const a = Math.PI / 2 + (i % 2 === 0 ? 1 : -1) * Math.ceil(i / 2) * ((Math.PI * 2) / ring.n);
        return px(g, Math.cos(a) * ring.r, Math.sin(a) * ring.r);
      }
      i -= ring.n;
    }
    return px(g, Math.cos(i * 0.7) * 10, Math.sin(i * 0.7) * 10);
  }
  if (s === "blocked") return at(g, p, 80, (k % 2 === 0 ? 1 : -1) * Math.ceil(k / 2) * 17);
  if (s === "working") {
    const [f, sd] = WORK[k % WORK.length]!;
    const lap = Math.floor(k / WORK.length);
    return at(g, p, f + lap * 9, sd + lap * 7);
  }
  // 옆 방향이 화면 아래를 보면 그쪽에만 선다(집 뒤로 숨지 않게). 아니면 집 양옆에 번갈아.
  if (p.sz > 0.5) return at(g, p, 2 + (k % 2) * 16, 36 + Math.floor(k / 2) * 14);
  return at(g, p, 14 + (Math.floor(k / 2) % 2) * 14, (k % 2 === 0 ? -1 : 1) * (36 + Math.floor(k / 4) * 14));
}
