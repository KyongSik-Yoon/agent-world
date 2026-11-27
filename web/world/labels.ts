// 3D 위에 뜨는 이름표·말풍선·문패의 층.
//
// 장면의 한 점에 DOM 요소를 붙여 두고, 카메라가 움직일 때마다 화면 자리로 옮긴다. 두 가지를 더 한다:
//
//   - 자리가 모자라면 덜 급한 쪽이 줄어든다. 에이전트가 수십이면 이름표가 서로를, 그리고 집 문패를 덮는다.
//     급한 순서대로 자리를 잡게 하고, 밀린 이름표는 말풍선을 접고 그래도 안 되면 번호만 남긴다.
//   - 달라진 것만 쓴다. 자리가 눈에 띄게 바뀌지 않은 요소의 스타일은 건드리지 않는다 — 가만히 있는 화면에서
//     매 프레임 수십 개의 스타일을 다시 쓰면 그리는 것보다 스타일 계산이 더 든다.
//   - 매 프레임 쓰는 자리(transform·쌓는 순서·보임)는 이름표를 감싼 빈 칸에 쓴다. 이름표 자신에 쓰면 브라우저가
//     인라인 스타일만 바뀐 요소를 빨리 처리하는 길을 못 탄다(끌어 돌리는 동안 이름표 40여 개에 프레임마다 스타일
//     계산 1ms 남짓이 더 들었다).
//   - 비켜 서기(위로 올라서기·옆으로 내어 걸기)는 CSS transition 이 아니라 여기서 장면의 프레임마다 미끄러뜨린다.
//     transition 은 장면이 쉬는 화면 박자에도 한 장씩 따로 내보낸다 — 카메라를 돌리면 이름표가 쉴 새 없이 비켜 서서,
//     120Hz 화면에서 장면은 초당 57장인데 화면 출력은 110장을 넘었다.
import * as THREE from "three";

/** 요소의 가로·세로(px). */
export type Size = readonly [number, number];

export interface LabelSpec {
  el: HTMLElement;
  /** 장면 안에서 이 요소가 붙어 있는 점. */
  anchor: THREE.Object3D;
  /** 요소의 어느 점이 그 자리에 오는지(0~1). 기본은 아래 가운데 — 머리 위에 얹힌다. */
  center?: readonly [number, number];
  /** 자리를 잡는 차례. 작을수록 먼저 잡고, 겹치면 큰 쪽이 물러선다. 상태에 따라 달라지므로 매번 묻는다. */
  rank(): number;
  /** 같은 차례 안에서의 순서. 카메라가 움직여도 바뀌지 않아야 이름표가 번갈아 깜빡이지 않는다. */
  order: string;
  /** 줄여 갈 수 있는 모습들의 크기. 0 번이 다 보이는 모습이고 뒤로 갈수록 작다. */
  sizes(): readonly Size[];
  /** 그 모습으로 바꾼다. sizes 의 길이와 같은 값은 "숨김"이다(hideable 일 때만 온다). */
  setLevel?(level: number): void;
  /**
   * 제자리가 막혔을 때 위로 비켜 설 수 있는 높이들(px). 줄어들기 전에 먼저 비켜 서 본다. 칸째로 부드럽게 올린다.
   */
  lifts?: readonly number[];
  /**
   * 제자리 대신 옆으로 붙을 수 있는 자리들(제 너비의 몇 배만큼 옮기는지). 문패가 쓴다 — 기둥 가운데에 걸거나,
   * 오른쪽이나 왼쪽으로 내어 건다. 다른 이름표들이 다 펴졌을 때 덜 가리는 쪽을 고르고, 칸째로 부드럽게 옮긴다.
   */
  shifts?: readonly number[];
  /** 가장 작은 모습으로도 자리가 없으면 숨겨도 되는지. 상태에 따라 달라질 수 있어 매번 묻는다. */
  hideable?(): boolean;
  /** 지금은 줄이지 않는다(올려놓았거나 골랐다). */
  pinned?(): boolean;
}

interface Label extends LabelSpec {
  /** 이름표를 감싼 칸. 화면 자리와 쌓는 순서, 보임은 여기에 쓴다. */
  slot: HTMLElement;
  /** 지금 적용된 모습. */
  level: number;
  /** 지금 올라서 있는 높이(px). */
  lift: number;
  /** 지금 옆으로 비켜 있는 정도(제 너비의 배수). */
  shift: number;
  /** 화면에 보이는 높이와 옆자리 — 목표(lift·shift)로 미끄러져 가는 도중의 값. */
  shownLift: number;
  shownShift: number;
  /** 미끄러지기 시작한 자리와 때. 다 닿았으면 null. */
  slide: { lift: number; shift: number; at: number } | null;
  /** 더 자세한 모습으로 돌아갈 자리가 난 시각. 아직 없으면 0. */
  roomSince: number;
  shown: boolean;
  x: number;
  y: number;
  z: number;
  /** 마지막으로 스타일에 쓴 값들. */
  wroteX: number;
  wroteY: number;
  wroteZ: number;
  wroteLift: number;
  wroteShift: number;
  wroteShown: boolean;
  depth: number;
}

/** 이름표 사이에 두는 틈(px). */
const GAP = 3;
/** 이미 보이는 모습은 이만큼 겹쳐도 유지하고, 더 자세한 모습으로 돌아가려면 이만큼 여유가 더 있어야 한다. */
const STICKY = 4;
/** 자리가 난 뒤 이만큼 이어져야 더 자세한 모습으로 돌아간다 — 걸어가는 캐릭터 곁에서 깜빡이지 않게. */
const RESTORE_MS = 450;
/** 화면 밖으로 이만큼 벗어난 요소는 자리 다툼에서 뺀다. */
const OFFSCREEN = 80;

/** 옆으로 옮겨 걸어서 덜 가리게 되는 넓이가 이만큼(px²)은 돼야 옮긴다 — 엎치락뒤치락하지 않게. */
const KEEP_SHIFT = 60;
const NO_LIFT: readonly number[] = [0];
/** 비켜 서는 데 걸리는 시간(ms) — 이름표가 올라설 때와 문패가 옆으로 옮겨 걸릴 때. */
const LIFT_MS = 180;
const SHIFT_MS = 200;

/** CSS 의 ease-out(cubic-bezier(0, 0, 0.58, 1)): 흐른 비율 p 에서 옮겨 간 비율. */
function easeOut(p: number): number {
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  // x(t) = 1.74(1-t)t² + t³ 를 p 로 푸는 t 를 반 나누기로 찾고, 그 t 의 y(t) = 3(1-t)t² + t³ 를 돌려준다.
  let lo = 0;
  let hi = 1;
  let t = p;
  for (let i = 0; i < 20; i += 1) {
    const x = 1.74 * (1 - t) * t * t + t * t * t;
    if (Math.abs(x - p) < 1e-5) break;
    if (x < p) lo = t;
    else hi = t;
    t = (lo + hi) / 2;
  }
  return 3 * (1 - t) * t * t + t * t * t;
}

const DEFAULT_CENTER: readonly [number, number] = [0.5, 1];

/** 평탄한 네모 배열([l, t, r, b, ...]) 중 하나라도 겹치는지 본다. */
function overlapsAny(arr: readonly number[], l: number, t: number, r: number, b: number): boolean {
  for (let i = 0; i < arr.length; i += 4) {
    if (l < arr[i + 2]! && r > arr[i]! && t < arr[i + 3]! && b > arr[i + 1]!) return true;
  }
  return false;
}

/** 평탄한 네모 배열([l, t, r, b, ...])과 겹치는 넓이의 합. */
function overlapSum(arr: readonly number[], l: number, t: number, r: number, b: number): number {
  let sum = 0;
  for (let i = 0; i < arr.length; i += 4) {
    const w = Math.min(r, arr[i + 2]!) - Math.max(l, arr[i]!);
    if (w <= 0) continue;
    const h = Math.min(b, arr[i + 3]!) - Math.max(t, arr[i + 1]!);
    if (h > 0) sum += w * h;
  }
  return sum;
}

function comparePlacing(a: Label, b: Label): number {
  return a.rank() - b.rank() || (a.order < b.order ? -1 : a.order > b.order ? 1 : 0);
}

function compareStacked(a: Label, b: Label): number {
  const ta = a.shifts ? 99 : a.rank();
  const tb = b.shifts ? 99 : b.rank();
  return tb - ta || b.depth - a.depth;
}

const point = new THREE.Vector3();

export class LabelLayer {
  readonly domElement = document.createElement("div");
  private readonly labels = new Map<HTMLElement, Label>();
  /** attach·detach 때만 갱신하는 목록 — 매 프레임 [...this.labels.values()] 를 만들지 않는다. */
  private readonly list: Label[] = [];
  private readonly placing: Label[] = [];
  private readonly stacked: Label[] = [];
  private readonly taken: number[] = [];
  private readonly wished: number[] = [];
  private readonly measured = new Map<Element, (w: number, h: number) => void>();
  private readonly observer: ResizeObserver;
  private width = 1;
  private height = 1;
  /** 크기가 바뀌었거나 요소가 들고 났다 — 카메라가 가만히 있어도 한 번 다시 놓아야 한다. */
  dirty = true;

  constructor() {
    this.domElement.className = "labels";
    this.observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const box = entry.borderBoxSize[0];
        // 숨겨져 크기가 0 으로 온 것은 버린다 — 다시 보일 때의 크기는 마지막으로 보였을 때의 것이다.
        if (!box || box.inlineSize === 0) continue;
        this.measured.get(entry.target)?.(box.inlineSize, box.blockSize);
        this.dirty = true;
      }
    });
  }

  setSize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.dirty = true;
  }

  attach(spec: LabelSpec): void {
    const slot = document.createElement("div");
    slot.className = "label-slot";
    // 자리를 받기 전에는 보이지 않게 둔다(왼쪽 위 구석에 한 프레임 비치지 않도록).
    slot.style.visibility = "hidden";
    slot.append(spec.el);
    const label: Label = { ...spec, slot, level: 0, lift: 0, shift: 0, shownLift: 0, shownShift: 0, slide: null, roomSince: 0, shown: false, x: 0, y: 0, z: 0, wroteX: NaN, wroteY: NaN, wroteZ: NaN, wroteLift: 0, wroteShift: 0, wroteShown: false, depth: 0 };
    this.labels.set(spec.el, label);
    this.list.push(label);
    this.domElement.append(slot);
    this.dirty = true;
  }

  detach(el: HTMLElement): void {
    const label = this.labels.get(el);
    if (!label) return;
    this.labels.delete(el);
    const at = this.list.indexOf(label);
    if (at >= 0) this.list.splice(at, 1);
    this.unmeasure(el);
    label.slot.remove();
    el.remove();
    this.dirty = true;
  }

  /** 요소의 크기가 바뀔 때마다 알려 준다. 배치를 강제로 계산시키지 않고 브라우저가 알려 줄 때 받는다. */
  measure(el: Element, onSize: (w: number, h: number) => void): void {
    this.measured.set(el, onSize);
    this.observer.observe(el);
  }

  unmeasure(el: Element): void {
    this.measured.delete(el);
    this.observer.unobserve(el);
  }

  /**
   * 모든 요소를 지금 카메라에 맞춰 놓는다. 장면의 행렬은 방금 그린 프레임의 것을 쓴다.
   * 조금 뒤에 다시 불러야 하면 true 를 돌려준다(자세한 모습으로 돌아가려고 기다리는 이름표가 있다).
   */
  update(camera: THREE.Camera, now: number, ambient?: boolean): boolean {
    this.dirty = false;
    const all = this.list;
    const placing = this.placing;
    const stacked = this.stacked;
    const taken = this.taken;
    const wished = this.wished;
    placing.length = 0;
    stacked.length = 0;
    taken.length = 0;
    wished.length = 0;
    let hasShifts = false;
    for (let i = 0; i < all.length; i += 1) {
      const label = all[i]!;
      point.setFromMatrixPosition(label.anchor.matrixWorld);
      label.depth = point.distanceToSquared(camera.position);
      point.project(camera);
      label.x = (point.x * 0.5 + 0.5) * this.width;
      label.y = (-point.y * 0.5 + 0.5) * this.height;
      const shown =
        point.z >= -1 && point.z <= 1 && label.x > -OFFSCREEN && label.x < this.width + OFFSCREEN && label.y > -OFFSCREEN && label.y < this.height + OFFSCREEN * 3;
      label.shown = shown;
      if (shown) {
        placing.push(label);
        stacked.push(label);
        if (label.shifts) hasShifts = true;
      }
    }

    // 급한 것부터 자리를 잡는다.
    placing.sort(comparePlacing);
    // 옆으로 비켜 걸 수 있는 것(문패)은, 다른 이름표들이 다 펴졌을 때 차지할 자리를 미리 보고 덜 가리는 쪽에 건다.
    if (hasShifts) {
      for (let i = 0; i < placing.length; i += 1) {
        const l = placing[i]!;
        if (l.shifts) continue;
        const size = l.sizes()[0]!;
        const [cx, cy] = l.center ?? DEFAULT_CENTER;
        const pad = GAP / 2;
        const left = l.x - size[0] * cx;
        const top = l.y - size[1] * cy;
        wished.push(left - pad, top - pad, left + size[0] + pad, top + size[1] + pad);
      }
    }
    let waiting = false;
    for (let i = 0; i < placing.length; i += 1) {
      const label = placing[i]!;
      const sizes = label.sizes();
      const last = sizes.length - 1;
      const pinned = label.pinned?.() ?? false;
      const [cx, cy] = label.center ?? DEFAULT_CENTER;
      if (label.shifts) {
        // 이미 자리 잡은 것과 겹치는 쪽은 피하고, 그다음으로 펴진 이름표를 덜 가리는 쪽. 비슷하면 지금 자리를 지킨다.
        const s0 = sizes[0]!;
        const pad = GAP / 2;
        const cost = (shift: number): number => {
          const left = label.x - s0[0] * (cx - shift);
          const top = label.y - s0[1] * cy;
          const rl = left - pad;
          const rt = top - pad;
          const rr = left + s0[0] + pad;
          const rb = top + s0[1] + pad;
          return (overlapsAny(taken, rl, rt, rr, rb) ? 1e6 : 0) + overlapSum(wished, rl, rt, rr, rb);
        };
        let best = label.shift;
        let least = cost(label.shift) - KEEP_SHIFT;
        for (const shift of label.shifts) {
          const c = cost(shift);
          if (c < least) {
            least = c;
            best = shift;
          }
        }
        if (best !== label.shift) {
          label.slide = { lift: label.shownLift, shift: label.shownShift, at: now };
          label.shift = best;
        }
      }
      const lifts = label.lifts ?? NO_LIFT;
      let target = -1;
      let lift = 0;
      if (pinned) target = 0;
      // 모습마다, 제자리 → 한 칸 위 순서로 자리를 찾는다. 처음 맞는 자리에 선다.
      for (let level = 0; target < 0 && level <= last; level += 1) {
        const size = sizes[level]!;
        const left = label.x - size[0] * (cx - label.shift);
        for (let u = 0; u < lifts.length; u += 1) {
          const up = lifts[u]!;
          // 지금 그렇게 서 있으면 조금 겹쳐도 봐주고, 더 자세한 모습으로 돌아가는 데는 여유를 더 요구한다.
          const slack = level === label.level && up === label.lift ? -STICKY : level < label.level ? STICKY : 0;
          const pad = GAP / 2 + slack;
          const top = label.y - size[1] * cy - up;
          if (overlapsAny(taken, left - pad, top - pad, left + size[0] + pad, top + size[1] + pad)) continue;
          target = level;
          lift = up;
          break;
        }
      }
      // 가장 작은 모습으로도 겹친다. 숨겨도 되는 것은 숨기고, 아니면 가장 작은 모습으로 가장 덜 겹치는 높이에 둔다.
      if (target < 0) {
        target = label.hideable?.() ? last + 1 : last;
        if (target === last) {
          const size = sizes[last]!;
          const left = label.x - size[0] * (cx - label.shift);
          const pad = GAP / 2;
          let least = Number.POSITIVE_INFINITY;
          for (let u = 0; u < lifts.length; u += 1) {
            const up = lifts[u]!;
            const top = label.y - size[1] * cy - up;
            // 지금 높이는 조금 봐준다 — 비슷하게 겹치는 두 자리를 오가지 않게.
            const covered = overlapSum(taken, left - pad, top - pad, left + size[0] + pad, top + size[1] + pad) - (up === label.lift ? KEEP_SHIFT : 0);
            if (covered < least) {
              least = covered;
              lift = up;
            }
          }
        }
      }
      if (target <= last) {
        const size = sizes[target]!;
        const pad = GAP / 2;
        const left = label.x - size[0] * (cx - label.shift);
        const top = label.y - size[1] * cy - lift;
        taken.push(left - pad, top - pad, left + size[0] + pad, top + size[1] + pad);
      }
      if (target > label.level) {
        // 줄어드는 것은 바로.
        label.level = target;
        label.roomSince = 0;
        label.setLevel?.(target);
      } else if (target < label.level) {
        // 다시 펴는 것은 자리가 한동안 이어진 뒤에. 고르거나 올려놓은 것은 기다리지 않는다.
        if (label.roomSince === 0) label.roomSince = now;
        if (pinned || now - label.roomSince >= RESTORE_MS) {
          label.level = target;
          label.roomSince = 0;
          label.setLevel?.(target);
        } else waiting = true;
      } else label.roomSince = 0;
      // 올라설 높이는 그 모습이 실제로 적용됐을 때 함께 바꾼다(펴지기를 기다리는 동안에는 지금 자리를 지킨다).
      if (label.level === target && lift !== label.lift) {
        label.slide = { lift: label.shownLift, shift: label.shownShift, at: now };
        label.lift = lift;
      }
    }

    // 겹쳤을 때 위에 오는 순서: 급한 것이 위, 같은 급이면 가까운 것이 위. 옆으로 비켜 거는 것(문패)은 맨 아래다 —
    // 문패와 겹치는 것은 자리가 끝내 없어 번호만 남은 이름표뿐인데, 그 작은 번호가 문패 밑에 깔리면 반쯤 잘려 보인다.
    stacked.sort(compareStacked);
    for (let i = 0; i < stacked.length; i += 1) stacked[i]!.z = i + 1;

    // 곁눈질 화면(초당 3장, scene.ts 가 body 에 표시한다)에서는 미끄러뜨리지 않고 바로 선다 — 세 장에 걸쳐 끊겨 보일 뿐이다.
    const instant = ambient ?? document.body.hasAttribute("data-ambient");
    for (let i = 0; i < all.length; i += 1) {
      const label = all[i]!;
      if (label.slide) {
        const from = label.slide;
        const k = instant ? 1 : easeOut((now - from.at) / (label.shifts ? SHIFT_MS : LIFT_MS));
        label.shownLift = from.lift + (label.lift - from.lift) * k;
        label.shownShift = from.shift + (label.shift - from.shift) * k;
        if (k >= 1) label.slide = null;
        else waiting = true;
      }
      const visible = label.shown && label.level < label.sizes().length;
      if (visible !== label.wroteShown) {
        label.slot.style.visibility = visible ? "" : "hidden";
        label.wroteShown = visible;
      }
      if (!visible) continue;
      if (
        !(Math.abs(label.x - label.wroteX) < 0.1 && Math.abs(label.y - label.wroteY) < 0.1) ||
        label.shownLift !== label.wroteLift ||
        label.shownShift !== label.wroteShift
      ) {
        const [cx, cy] = label.center ?? DEFAULT_CENTER;
        // 옆으로 비켜 거는 것은 제 너비의 배수라 %, 올라서는 것은 px 로 화면 자리와 함께 쓴다.
        label.slot.style.transform = `translate(${(100 * (label.shownShift - cx)).toFixed(2)}%,${-100 * cy}%) translate(${label.x.toFixed(1)}px,${(label.y - label.shownLift).toFixed(1)}px)`;
        label.wroteX = label.x;
        label.wroteY = label.y;
        label.wroteLift = label.shownLift;
        label.wroteShift = label.shownShift;
      }
      if (label.z !== label.wroteZ) {
        label.slot.style.zIndex = String(label.z);
        label.wroteZ = label.z;
      }
    }
    return waiting;
  }
}

/** 장면 하나에 층도 하나다. 배우·무대·씬이 같은 층에 제 이름표를 건다. */
export const labels = new LabelLayer();
