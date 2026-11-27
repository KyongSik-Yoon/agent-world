// 마을의 배치. 위치가 곧 상태다:
//   작업 중 → 자기 워크스페이스 집터의 마당에서 일한다
//   완료    → 가운데 광장으로 걸어 나와 기다린다
//   확인 필요 → 집터 대문 앞(광장 쪽)에 나와 선다
//   대기    → 집 옆에서 쉰다
import * as THREE from "three";

export const PLAZA_RADIUS = 7.6;
const PLOT_ARC = 6.6;
const MIN_RING = 16.5;
/** 별채의 크기(본채 대비)와 별채 한 채가 고리 위에서 차지하는 폭. */
export const ANNEX_SCALE = 0.7;
const ANNEX_ARC = PLOT_ARC * ANNEX_SCALE;

export interface Plot {
  id: string;
  index: number;
  /** 집터 중심. */
  center: THREE.Vector3;
  /** 광장에서 집터를 바라보는 방향(단위 벡터). */
  out: THREE.Vector3;
  /** 그 방향에 수직인, 집터의 가로 방향. */
  side: THREE.Vector3;
  /** 집이 광장을 바라보도록 돌릴 각도(y 축). */
  facing: number;
  hue: number;
  /** 본채는 1, 별채는 ANNEX_SCALE. 집과 마당의 일터·쉼터가 모두 이 비율로 줄어든다. */
  scale: number;
  /** 홀로 선 집(solo), 저장소 집터의 본채(main), 그 옆의 워크트리 별채(annex). */
  role: "solo" | "main" | "annex";
}

/**
 * 고리 위의 집터 한 칸. 저장소 하나에 스페이스가 여럿이면 본채 하나와 별채들이 한 칸을 같이 쓴다.
 * 본체 체크아웃 스페이스가 닫혀 있으면 본채는 비어 있다(`empty`) — 그 Plot 은 plots 에 없다(아무도 거기 살지 않는다).
 */
export interface Lot {
  key: string;
  /** 왼쪽에서 오른쪽(시계 방향) 차례로 놓인 집들. */
  houses: Plot[];
  main: Plot;
  /** 본채가 비어 있으면 문패에 쓸 저장소 이름. */
  empty?: { name: string };
  /** 집터 양 끝 사이의 각도 범위(라디안). */
  from: number;
  to: number;
}

export interface Layout {
  ringRadius: number;
  islandRadius: number;
  /** 스페이스 id → 그 스페이스의 집(본채든 별채든). */
  plots: Map<string, Plot>;
  lots: Lot[];
}

export { groupLots, hueOf, lotsKey, type LotSpec } from "../../shared/lots.ts";
import { hueOf, type LotSpec } from "../../shared/lots.ts";

export function buildLayout(specs: readonly LotSpec[]): Layout {
  const widths = specs.map((l) => PLOT_ARC + l.annexes.length * ANNEX_ARC);
  const total = Math.max(
    widths.reduce((a, b) => a + b, 0),
    PLOT_ARC,
  );
  const ringRadius = Math.max(MIN_RING, total / (Math.PI * 2));
  const plots = new Map<string, Plot>();
  const lots: Lot[] = [];
  const plot = (id: string, index: number, angle: number, hue: number, scale: number, role: Plot["role"]): Plot => {
    const out = new THREE.Vector3(Math.cos(angle), 0, Math.sin(angle));
    return {
      id,
      index,
      center: out.clone().multiplyScalar(ringRadius),
      out,
      side: new THREE.Vector3(-out.z, 0, out.x),
      facing: Math.atan2(-out.x, -out.z),
      hue,
      scale,
      role,
    };
  };
  // 1번 집터가 화면 왼쪽 앞에서 시작해 시계 방향으로 돈다. 집터마다 제 폭만큼 고리를 나눠 갖는다
  // (모두 홀로 선 집이면 예전처럼 같은 간격이다).
  let along = -widths[0]! / 2;
  let index = 0;
  specs.forEach((spec, i) => {
    const width = widths[i]!;
    const start = along;
    along += width;
    const angleAt = (arc: number) => Math.PI * 0.75 + (arc / total) * Math.PI * 2;
    if (spec.annexes.length === 0 && spec.main) {
      const p = plot(spec.main, index++, angleAt(start + width / 2), hueOf(spec.main), 1, "solo");
      plots.set(spec.main, p);
      lots.push({ key: spec.key, houses: [p], main: p, from: angleAt(start), to: angleAt(start + width) });
      return;
    }
    // 본채를 가운데에 두고 별채를 오른쪽·왼쪽 번갈아 붙인다.
    const hue = hueOf(spec.key);
    const right = spec.annexes.filter((_, k) => k % 2 === 0);
    const left = spec.annexes.filter((_, k) => k % 2 === 1).reverse();
    const order: Array<{ id: string; main: boolean }> = [...left.map((id) => ({ id, main: false })), { id: spec.main ?? spec.key, main: true }, ...right.map((id) => ({ id, main: false }))];
    let cursor = start;
    const houses: Plot[] = [];
    let main: Plot | undefined;
    for (const item of order) {
      const w = item.main ? PLOT_ARC : ANNEX_ARC;
      const p = plot(item.id, item.main && !spec.main ? -1 : index++, angleAt(cursor + w / 2), hue, item.main ? 1 : ANNEX_SCALE, item.main ? "main" : "annex");
      cursor += w;
      houses.push(p);
      if (item.main) main = p;
      if (!item.main || spec.main) plots.set(item.id, p);
    }
    lots.push({ key: spec.key, houses, main: main!, empty: spec.main ? undefined : { name: spec.name ?? "" }, from: angleAt(start), to: angleAt(start + width) });
  });
  return { ringRadius, islandRadius: ringRadius + 7.5, plots, lots };
}

function at(plot: Plot, outward: number, sideways: number): THREE.Vector3 {
  return plot.center.clone().addScaledVector(plot.out, outward * plot.scale).addScaledVector(plot.side, sideways * plot.scale);
}

export interface Spot {
  pos: THREE.Vector3;
  /** 그 자리에 서서 바라볼 곳. */
  look: THREE.Vector3;
}

const workSpotsCache = new WeakMap<Plot, readonly Spot[]>();
const PLAZA_RINGS = [
  { r: 3.9, count: 8 },
  { r: 6.0, count: 12 },
  { r: 8.6, count: 18 },
] as const;

/**
 * 마당의 일터들: 작업대, 텃밭, 문 앞, 마당 한가운데. 일하는 에이전트는 이 사이를 오간다.
 * 좌표는 environment.ts 가 놓는 소품의 자리와 맞춰져 있다(집터 안에서 x = 가로, z = -바깥쪽).
 * Plot 은 배치가 바뀌기 전까지 불변이므로 한 번 계산해 두고 재사용한다.
 */
export function workSpots(plot: Plot): readonly Spot[] {
  let cached = workSpotsCache.get(plot);
  if (!cached) {
    cached = [
      { pos: at(plot, -0.25, -1.7), look: at(plot, -0.25, -2.55) },
      { pos: at(plot, -1.3, 1.25), look: at(plot, -1.3, 2.3) },
      { pos: at(plot, 0.85, -0.55), look: at(plot, 2.7, -0.55) },
      { pos: at(plot, -1.9, 0.2), look: at(plot, -6, 0.2) },
    ];
    workSpotsCache.set(plot, cached);
  }
  return cached;
}

/** 집 옆 쉼터. 같은 집터의 k 번째 대기 에이전트 자리 — 집 양옆으로 번갈아 앉는다. */
export function restSpot(plot: Plot, k: number): THREE.Vector3 {
  const sideSign = k % 2 === 0 ? -1 : 1;
  return at(plot, 1.7 - Math.floor(k / 4) * 1.35, sideSign * (2.45 + Math.floor((k % 4) / 2) * 1.35));
}

/** 셸 pane 의 단말기가 서는 자리 — 마당 앞쪽 가장자리에 나란히. */
export function shellSpot(plot: Plot, k: number): THREE.Vector3 {
  return at(plot, -2.3, 3.0 + k * 0.95);
}

/** 대문 앞(광장 쪽). 확인이 필요한 에이전트가 나와 서는 곳. */
export function gateSpot(plot: Plot, k: number): THREE.Vector3 {
  return at(plot, -3.6, (k % 2 === 0 ? 1 : -1) * Math.ceil(k / 2) * 1.4);
}

/** 광장의 k 번째 자리. 안쪽 고리가 차면 바깥 고리로 넘어간다. */
export function plazaSlot(k: number): THREE.Vector3 {
  let i = k;
  for (const ring of PLAZA_RINGS) {
    if (i < ring.count) {
      const a = Math.PI / 2 + (i % 2 === 0 ? 1 : -1) * Math.ceil(i / 2) * ((Math.PI * 2) / ring.count);
      return new THREE.Vector3(Math.cos(a) * ring.r, 0, Math.sin(a) * ring.r);
    }
    i -= ring.count;
  }
  const a = i * 0.7;
  return new THREE.Vector3(Math.cos(a) * 10.4, 0, Math.sin(a) * 10.4);
}
