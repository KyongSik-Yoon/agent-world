// 3D 위에 뜨는 이름표·말풍선·문패의 층.
//
// 장면의 한 점에 DOM 요소를 붙여 두고, 카메라가 움직일 때마다 화면 자리로 옮긴다. 두 가지를 더 한다:
//
//   - 자리가 모자라면 덜 급한 쪽이 줄어든다. 에이전트가 수십이면 이름표가 서로를, 그리고 집 문패를 덮는다.
//     급한 순서대로 자리를 잡게 하고, 밀린 이름표는 말풍선을 접고 그래도 안 되면 번호만 남긴다.
//   - 달라진 것만 쓴다. 자리가 눈에 띄게 바뀌지 않은 요소의 스타일은 건드리지 않는다 — 가만히 있는 화면에서
//     매 프레임 수십 개의 스타일을 다시 쓰면 그리는 것보다 스타일 계산이 더 든다.
//   - 매 프레임 쓰는 자리(transform·쌓는 순서·보임)는 이름표를 감싼 빈 칸에 쓴다. 이름표 자신에는 비켜 서기의
//     transition 과 `--lift`·`--shift` 가 있어, 거기에 자리를 쓰면 브라우저가 인라인 스타일만 바뀐 요소를 빨리
//     처리하는 길을 못 탄다(끌어 돌리는 동안 이름표 40여 개에 프레임마다 스타일 계산 1ms 남짓이 더 들었다).
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
   * 제자리가 막혔을 때 위로 비켜 설 수 있는 높이들(px). 줄어들기 전에 먼저 비켜 서 본다.
   * 얼마나 올라섰는지는 요소의 `--lift` 로 알려 준다 — 스타일시트가 그만큼 부드럽게 올린다.
   */
  lifts?: readonly number[];
  /**
   * 제자리 대신 옆으로 붙을 수 있는 자리들(제 너비의 몇 배만큼 옮기는지). 문패가 쓴다 — 기둥 가운데에 걸거나,
   * 오른쪽이나 왼쪽으로 내어 건다. 다른 이름표들이 다 펴졌을 때 덜 가리는 쪽을 고르고, `--shift` 로 알려 준다.
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

type Rect = [number, number, number, number];

/** 두 네모가 겹치는 넓이. */
function overlap(a: Rect, b: Rect): number {
  const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
  const h = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  return w > 0 && h > 0 ? w * h : 0;
}

const point = new THREE.Vector3();

export class LabelLayer {
  readonly domElement = document.createElement("div");
  private readonly labels = new Map<HTMLElement, Label>();
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
    this.labels.set(spec.el, { ...spec, slot, level: 0, lift: 0, shift: 0, roomSince: 0, shown: false, x: 0, y: 0, z: 0, wroteX: NaN, wroteY: NaN, wroteZ: NaN, wroteShown: false, depth: 0 });
    this.domElement.append(slot);
    this.dirty = true;
  }

  detach(el: HTMLElement): void {
    const label = this.labels.get(el);
    if (!label) return;
    this.labels.delete(el);
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
  update(camera: THREE.Camera, now: number): boolean {
    this.dirty = false;
    const all = [...this.labels.values()];
    for (const label of all) {
      point.setFromMatrixPosition(label.anchor.matrixWorld);
      label.depth = point.distanceToSquared(camera.position);
      point.project(camera);
      label.x = (point.x * 0.5 + 0.5) * this.width;
      label.y = (-point.y * 0.5 + 0.5) * this.height;
      label.shown =
        point.z >= -1 && point.z <= 1 && label.x > -OFFSCREEN && label.x < this.width + OFFSCREEN && label.y > -OFFSCREEN && label.y < this.height + OFFSCREEN * 3;
    }

    // 급한 것부터 자리를 잡는다.
    const placing = all.filter((l) => l.shown).sort((a, b) => a.rank() - b.rank() || (a.order < b.order ? -1 : a.order > b.order ? 1 : 0));
    const taken: Rect[] = [];
    // 옆으로 비켜 걸 수 있는 것(문패)은, 다른 이름표들이 다 펴졌을 때 차지할 자리를 미리 보고 덜 가리는 쪽에 건다.
    const wished = placing.some((l) => l.shifts) ? placing.filter((l) => !l.shifts).map((l) => this.rect(l, l.sizes()[0]!, 0)) : [];
    let waiting = false;
    for (const label of placing) {
      const sizes = label.sizes();
      const last = sizes.length - 1;
      const pinned = label.pinned?.() ?? false;
      const overlaps = (r: Rect): boolean => taken.some((t) => r[0] < t[2] && r[2] > t[0] && r[1] < t[3] && r[3] > t[1]);
      if (label.shifts) {
        // 이미 자리 잡은 것과 겹치는 쪽은 피하고, 그다음으로 펴진 이름표를 덜 가리는 쪽. 비슷하면 지금 자리를 지킨다.
        const cost = (shift: number): number => {
          const r = this.rect(label, sizes[0]!, 0, 0, shift);
          return (overlaps(r) ? 1e6 : 0) + wished.reduce((sum, w) => sum + overlap(r, w), 0);
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
          label.shift = best;
          label.el.style.setProperty("--shift", `${best * 100}%`);
        }
      }
      const lifts = label.lifts ?? NO_LIFT;
      let target = -1;
      let lift = 0;
      if (pinned) target = 0;
      // 모습마다, 제자리 → 한 칸 위 순서로 자리를 찾는다. 처음 맞는 자리에 선다.
      for (let level = 0; target < 0 && level <= last; level += 1) {
        for (const up of lifts) {
          // 지금 그렇게 서 있으면 조금 겹쳐도 봐주고, 더 자세한 모습으로 돌아가는 데는 여유를 더 요구한다.
          const slack = level === label.level && up === label.lift ? -STICKY : level < label.level ? STICKY : 0;
          if (overlaps(this.rect(label, sizes[level]!, slack, up, label.shift))) continue;
          target = level;
          lift = up;
          break;
        }
      }
      // 가장 작은 모습으로도 겹친다. 숨겨도 되는 것은 숨기고, 아니면 가장 작은 모습으로 가장 덜 겹치는 높이에 둔다.
      if (target < 0) {
        target = label.hideable?.() ? last + 1 : last;
        if (target === last) {
          let least = Number.POSITIVE_INFINITY;
          for (const up of lifts) {
            const r = this.rect(label, sizes[last]!, 0, up, label.shift);
            // 지금 높이는 조금 봐준다 — 비슷하게 겹치는 두 자리를 오가지 않게.
            const covered = taken.reduce((sum, t) => sum + overlap(r, t), 0) - (up === label.lift ? KEEP_SHIFT : 0);
            if (covered < least) {
              least = covered;
              lift = up;
            }
          }
        }
      }
      if (target <= last) taken.push(this.rect(label, sizes[target]!, 0, lift, label.shift));
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
        label.lift = lift;
        label.el.style.setProperty("--lift", `${-lift}px`);
      }
    }

    // 겹쳤을 때 위에 오는 순서: 급한 것이 위, 같은 급이면 가까운 것이 위. 옆으로 비켜 거는 것(문패)은 맨 아래다 —
    // 문패와 겹치는 것은 자리가 끝내 없어 번호만 남은 이름표뿐인데, 그 작은 번호가 문패 밑에 깔리면 반쯤 잘려 보인다.
    const tier = (l: Label): number => (l.shifts ? 99 : l.rank());
    const stacked = all.filter((l) => l.shown).sort((a, b) => tier(b) - tier(a) || b.depth - a.depth);
    stacked.forEach((label, i) => {
      label.z = i + 1;
    });

    for (const label of all) {
      const visible = label.shown && label.level < label.sizes().length;
      if (visible !== label.wroteShown) {
        label.slot.style.visibility = visible ? "" : "hidden";
        label.wroteShown = visible;
      }
      if (!visible) continue;
      if (!(Math.abs(label.x - label.wroteX) < 0.1 && Math.abs(label.y - label.wroteY) < 0.1)) {
        const [cx, cy] = label.center ?? [0.5, 1];
        label.slot.style.transform = `translate(${-100 * cx}%,${-100 * cy}%) translate(${label.x.toFixed(1)}px,${label.y.toFixed(1)}px)`;
        label.wroteX = label.x;
        label.wroteY = label.y;
      }
      if (label.z !== label.wroteZ) {
        label.slot.style.zIndex = String(label.z);
        label.wroteZ = label.z;
      }
    }
    return waiting;
  }

  /** 그 크기로, lift 만큼 올라서고 shift 만큼 옆으로 비켜 놓였을 때 화면에서 차지하는 네모(틈 포함). slack 이 양수면 그만큼 더 넓게 본다. */
  private rect(label: Label, size: Size, slack: number, lift = 0, shift = 0): Rect {
    const [cx, cy] = label.center ?? [0.5, 1];
    const pad = GAP / 2 + slack;
    const left = label.x - size[0] * (cx - shift);
    const top = label.y - size[1] * cy - lift;
    return [left - pad, top - pad, left + size[0] + pad, top + size[1] + pad];
  }
}

/** 장면 하나에 층도 하나다. 배우·무대·씬이 같은 층에 제 이름표를 건다. */
export const labels = new LabelLayer();
