// 마을의 배치. 위치가 곧 상태다:
//   작업 중 → 자기 워크스페이스 집터의 마당에서 일한다
//   완료    → 가운데 광장으로 걸어 나와 기다린다
//   확인 필요 → 집터 대문 앞(광장 쪽)에 나와 선다
//   대기    → 집 옆에서 쉰다
import * as THREE from "three";

export const PLAZA_RADIUS = 7.6;
const PLOT_ARC = 6.6;
const MIN_RING = 16.5;

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
}

export interface Layout {
  ringRadius: number;
  islandRadius: number;
  plots: Map<string, Plot>;
}

/** 워크스페이스 id 로 정해지는 색상 — 순서가 바뀌어도 같은 집은 같은 지붕색을 갖는다. */
export function hueOf(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i += 1) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return ((h >>> 0) % 360) / 360;
}

export function buildLayout(workspaceIds: readonly string[]): Layout {
  const n = Math.max(workspaceIds.length, 1);
  const ringRadius = Math.max(MIN_RING, (n * PLOT_ARC) / (Math.PI * 2));
  const plots = new Map<string, Plot>();
  workspaceIds.forEach((id, index) => {
    // 1번 집터가 화면 왼쪽 앞에서 시작해 시계 방향으로 돈다.
    const angle = Math.PI * 0.75 + (index / n) * Math.PI * 2;
    const out = new THREE.Vector3(Math.cos(angle), 0, Math.sin(angle));
    plots.set(id, {
      id,
      index,
      center: out.clone().multiplyScalar(ringRadius),
      out,
      side: new THREE.Vector3(-out.z, 0, out.x),
      facing: Math.atan2(-out.x, -out.z),
      hue: hueOf(id),
    });
  });
  return { ringRadius, islandRadius: ringRadius + 7.5, plots };
}

function at(plot: Plot, outward: number, sideways: number): THREE.Vector3 {
  return plot.center.clone().addScaledVector(plot.out, outward).addScaledVector(plot.side, sideways);
}

export interface Spot {
  pos: THREE.Vector3;
  /** 그 자리에 서서 바라볼 곳. */
  look: THREE.Vector3;
}

/**
 * 마당의 일터들: 작업대, 텃밭, 문 앞, 마당 한가운데. 일하는 에이전트는 이 사이를 오간다.
 * 좌표는 environment.ts 가 놓는 소품의 자리와 맞춰져 있다(집터 안에서 x = 가로, z = -바깥쪽).
 */
export function workSpots(plot: Plot): Spot[] {
  return [
    { pos: at(plot, -0.25, -1.7), look: at(plot, -0.25, -2.55) },
    { pos: at(plot, -1.3, 1.25), look: at(plot, -1.3, 2.3) },
    { pos: at(plot, 0.85, -0.55), look: at(plot, 2.7, -0.55) },
    { pos: at(plot, -1.9, 0.2), look: at(plot, -6, 0.2) },
  ];
}

/** 집 옆 쉼터. 같은 집터의 k 번째 대기 에이전트 자리 — 집 양옆으로 번갈아 앉는다. */
export function restSpot(plot: Plot, k: number): THREE.Vector3 {
  const sideSign = k % 2 === 0 ? -1 : 1;
  return at(plot, 1.7 - Math.floor(k / 4) * 1.25, sideSign * (2.45 + Math.floor((k % 4) / 2) * 1.05));
}

/** 셸 pane 의 단말기가 서는 자리 — 마당 앞쪽 가장자리에 나란히. */
export function shellSpot(plot: Plot, k: number): THREE.Vector3 {
  return at(plot, -2.3, 3.0 + k * 0.95);
}

/** 대문 앞(광장 쪽). 확인이 필요한 에이전트가 나와 서는 곳. */
export function gateSpot(plot: Plot, k: number): THREE.Vector3 {
  return at(plot, -3.6, (k % 2 === 0 ? 1 : -1) * Math.ceil(k / 2) * 1.2);
}

/** 광장의 k 번째 자리. 안쪽 고리가 차면 바깥 고리로 넘어간다. */
export function plazaSlot(k: number): THREE.Vector3 {
  const rings = [
    { r: 3.9, count: 8 },
    { r: 6.0, count: 12 },
    { r: 8.6, count: 18 },
  ];
  let i = k;
  for (const ring of rings) {
    if (i < ring.count) {
      const a = Math.PI / 2 + (i % 2 === 0 ? 1 : -1) * Math.ceil(i / 2) * ((Math.PI * 2) / ring.count);
      return new THREE.Vector3(Math.cos(a) * ring.r, 0, Math.sin(a) * ring.r);
    }
    i -= ring.count;
  }
  const a = i * 0.7;
  return new THREE.Vector3(Math.cos(a) * 10.4, 0, Math.sin(a) * 10.4);
}
