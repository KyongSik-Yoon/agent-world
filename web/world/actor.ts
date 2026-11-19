// 에이전트 하나를 연기하는 배우: 캐릭터 모델, 머리 위 이름표·말풍선, 상태에 따른 자리와 몸짓.
import * as THREE from "three";

import type { AgentStatus, AgentView } from "../../shared/types.ts";
import { icon } from "../dom.ts";
import { bubbleParts } from "../format.ts";
import { createRig, type Pose, type Rig } from "./characters.ts";
import { labels, type Size } from "./labels.ts";
import { gateSpot, plazaSlot, restSpot, workSpots, type Layout, type Spot } from "./layout.ts";

const STATUS_COLOR: Record<AgentStatus, string> = {
  working: "#F5A524",
  done: "#2FBF71",
  blocked: "#F0506E",
  idle: "#8A93A6",
  unknown: "#8A93A6",
};

/** 클릭을 받는 상자들이 사는 층. 그리는 카메라는 보지 않고, 고를 때 쏘는 광선만 본다. */
export const PICK_LAYER = 1;

const WALK_SPEED = 1.9;
const RUN_SPEED = 5.2;
const PILLAR_HEIGHT = 6.5;

let beam: THREE.CanvasTexture | undefined;

/** 빛기둥의 세로 농도: 바닥에서 부드럽게 차올라 캐릭터 키 언저리에서 가장 짙고, 위로 갈수록 사라진다. */
function beamTexture(): THREE.CanvasTexture {
  if (beam) return beam;
  const canvas = document.createElement("canvas");
  canvas.width = 4;
  canvas.height = 256;
  const ctx = canvas.getContext("2d")!;
  // 캔버스의 아래쪽이 기둥의 바닥이다.
  const fade = ctx.createLinearGradient(0, 256, 0, 0);
  fade.addColorStop(0, "rgba(255,255,255,0)");
  fade.addColorStop(0.04, "rgba(255,255,255,0.7)");
  fade.addColorStop(0.2, "rgba(255,255,255,0.5)");
  fade.addColorStop(0.6, "rgba(255,255,255,0.16)");
  fade.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = fade;
  ctx.fillRect(0, 0, 4, 256);
  beam = new THREE.CanvasTexture(canvas);
  beam.colorSpace = THREE.SRGBColorSpace;
  return beam;
}

/** 제 자리에서 이만큼 안으로 들어오면 "거의 다 왔다"고 본다. */
const TRANSIT_DISTANCE = 1.5;
const MAX_FOLLOWERS = 4;
/** 완료 직후 이 시간 동안은 응답 첫 줄을 말풍선에 그대로 보여 준다. */
const FRESH_DONE_MS = 90_000;
/** 카메라가 이보다 멀면 쉬거나 기다리는 에이전트의 이름을 접고 번호만 남긴다. */
const FAR_DISTANCE = 50;
/** 이름표의 모습: 말풍선과 이름 → 이름만 → 번호만. 자리가 모자라면 뒤쪽으로 줄어든다. */
const LOD_CLASS = ["", "lod1", "lod2"];
/**
 * 자리 다툼에서의 차례 — 나를 부르는 쪽이 먼저 자리를 잡는다. 문패는 1 이다(environment): 확인이 필요한 에이전트는
 * 바로 문패 옆 대문에 서는데, 빛기둥과 고리로 이미 눈에 띄므로 말풍선이 문패를 덮기보다 문패를 비켜 접힌다.
 */
const RANK: Record<AgentStatus, number> = { blocked: 2, done: 3, working: 4, idle: 5, unknown: 5 };
/** 제자리가 막혔을 때 이름표가 비켜 올라설 수 있는 높이(px) — 문패 한 줄 높이씩 세 줄까지. */
const LIFTS = [0, 28, 56, 84] as const;
/** 크기를 아직 재지 못했을 때 쓰는 어림값(px). */
const GUESS = { bubble: [118, 28], plate: [112, 21], compact: [34, 21] } as const satisfies Record<string, Size>;

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967296;
}

function turnToward(current: number, target: number, amount: number): number {
  const diff = Math.atan2(Math.sin(target - current), Math.cos(target - current));
  return current + diff * amount;
}

/** 배우가 자리를 정할 때 필요한, 무리 안에서의 순번. 씬이 스냅샷마다 계산해 넘긴다. */
export interface Placement {
  /** 광장에서 기다리는 순번(완료 상태일 때). */
  plaza: number;
  /** 같은 집터 안에서 같은 상태인 에이전트들 사이의 순번. */
  inPlot: number;
}

export class Actor {
  readonly group = new THREE.Group();
  readonly hit: THREE.Mesh;
  view: AgentView;
  placement: Placement = { plaza: 0, inPlot: 0 };
  hovered = false;
  selected = false;
  /** 로스터 필터에 걸러졌는지 — 걸러진 배우는 흐려진다. */
  muted = false;

  private rig: Rig;
  private readonly seed: number;
  private readonly ring: THREE.Mesh;
  private readonly ringMat: THREE.MeshBasicMaterial;
  private readonly pillar: THREE.Mesh;
  private readonly pillarMat: THREE.MeshBasicMaterial;
  private readonly anchor = new THREE.Object3D();
  private readonly tag: HTMLDivElement;
  private readonly bubble: HTMLDivElement;
  private readonly plate: HTMLDivElement;
  /** 브라우저가 알려 준 조각들의 크기. 이름표가 겹치는지는 이 값으로 셈한다. */
  private bubbleSize: Size = GUESS.bubble;
  /** 말풍선에 지금 그려 둔 그림과 글 — 같으면 다시 짓지 않는다. */
  private bubbleKey = "";
  private plateSize: Size = GUESS.plate;
  private compactSize: Size = GUESS.compact;
  private lod = 0;
  private far = false;
  /** 마지막으로 이름표에 적어 둔 표시들 — 달라졌을 때만 클래스를 고친다. */
  private shownAs = "";
  private readonly plateNum: HTMLSpanElement;
  private readonly plateName: HTMLSpanElement;
  private readonly followers: Array<{ rig: Rig; phase: number }> = [];

  private heading: number;
  private spotIndex: number;
  private nextWanderAt = 0;
  private placed = false;
  private dim = 0;
  private arrivedAt = 0;
  private bubbleFor: AgentView | undefined;
  private bubbleFull = false;
  private inTransit = false;
  private isMoving = false;

  constructor(view: AgentView, onSelect: (id: string) => void, onHover: (id: string | null) => void) {
    this.view = view;
    this.seed = hash(view.id) * 100;
    this.heading = hash(`${view.id}h`) * Math.PI * 2;
    this.spotIndex = Math.floor(hash(`${view.id}s`) * 4);

    this.rig = createRig(view.vendor, this.seed);
    this.group.add(this.rig.group);

    // 클릭을 받는 넉넉한 투명 상자 — 가느다란 다리나 아치 사이를 눌러도 잡힌다.
    this.hit = new THREE.Mesh(
      new THREE.BoxGeometry(1.7, 2.0, 1.4),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, colorWrite: false }),
    );
    this.hit.position.y = 1.0;
    this.hit.userData.actorId = view.id;
    // 고르기 전용 층에 둔다. 카메라는 이 층을 그리지 않는다 — 보이지 않는 상자를 배우마다 한 번씩 더 그리지 않게.
    this.hit.layers.set(PICK_LAYER);
    this.group.add(this.hit);

    this.ringMat = new THREE.MeshBasicMaterial({ color: STATUS_COLOR[view.status], transparent: true, opacity: 0.85, depthWrite: false });
    this.ring = new THREE.Mesh(new THREE.RingGeometry(0.78, 0.95, 40), this.ringMat);
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.position.y = 0.16;
    this.group.add(this.ring);

    // 멀리서도 보이는 빛기둥 — 완료와 확인 필요만 세운다. 발밑에서 올라와 위로 갈수록 옅어진다.
    // (머리 위 허공에서 시작하면 캐릭터와 따로 떠 있는 막대처럼 보인다.)
    this.pillarMat = new THREE.MeshBasicMaterial({
      color: STATUS_COLOR[view.status],
      map: beamTexture(),
      transparent: true,
      opacity: 0.3,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });
    this.pillar = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.78, PILLAR_HEIGHT, 24, 1, true), this.pillarMat);
    this.pillar.position.y = PILLAR_HEIGHT / 2 + 0.05;
    this.pillar.renderOrder = 2;
    this.group.add(this.pillar);

    this.tag = document.createElement("div");
    this.tag.className = "tag";
    this.bubble = document.createElement("div");
    this.bubble.className = "bubble";
    const plate = (this.plate = document.createElement("div"));
    plate.className = "plate";
    const dot = document.createElement("span");
    dot.className = "dot";
    this.plateNum = document.createElement("span");
    this.plateNum.className = "num";
    this.plateName = document.createElement("span");
    this.plateName.className = "name";
    plate.append(dot, this.plateNum, this.plateName);
    this.tag.append(this.bubble, plate);
    this.tag.addEventListener("click", (e) => {
      e.stopPropagation();
      onSelect(this.view.id);
    });
    this.tag.addEventListener("pointerenter", () => onHover(this.view.id));
    this.tag.addEventListener("pointerleave", () => onHover(null));
    this.anchor.position.y = this.rig.height;
    this.group.add(this.anchor);
    labels.attach({
      el: this.tag,
      anchor: this.anchor,
      order: view.id,
      rank: () => (this.hovered || this.selected ? 0 : this.muted ? 8 : RANK[this.view.status]),
      pinned: () => this.hovered || this.selected,
      sizes: () => this.sizes(),
      lifts: LIFTS,
      // 번호만 남기고도 겹치면 숨는다(캐릭터와 발밑 고리는 그대로 보이고, 올리거나 고르면 다시 나온다).
      // 나를 부르는 에이전트(확인 필요, 완료)는 숨기지 않는다 — 겹치더라도 번호는 남긴다.
      hideable: () => this.view.status !== "blocked" && this.view.status !== "done",
      setLevel: (level) => {
        this.lod = level;
      },
    });
    labels.measure(this.bubble, (w, h) => {
      this.bubbleSize = [w, h];
    });
    labels.measure(plate, (w, h) => {
      // 이름을 접은 동안에 잰 것은 번호만 남은 모습의 크기다.
      if (this.nameHidden()) this.compactSize = [w, h];
      else this.plateSize = [w, h];
    });

    this.apply(view);
  }

  /** 새 스냅샷의 값을 반영한다. */
  apply(view: AgentView): void {
    const statusChanged = view.status !== this.view.status;
    this.view = view;
    const color = STATUS_COLOR[view.status];
    this.ringMat.color.set(color);
    this.pillarMat.color.set(color);
    this.pillar.visible = view.status === "done" || view.status === "blocked";

    this.tag.dataset.status = view.status;
    this.bubble.hidden = bubbleParts(view) === null;
    this.syncBubble();
    this.plateNum.textContent = view.workspaceNumber ? String(view.workspaceNumber) : "·";
    if (this.plateName.textContent !== view.title) this.plateName.textContent = view.title;

    if (statusChanged) this.nextWanderAt = 0;
    this.syncFollowers();
  }

  /** 올리거나 골랐을 때, 그리고 막 끝난 직후에는 긴 말풍선을, 그 밖에는 짧은 것을 보인다. */
  private syncBubble(): void {
    const full = this.hovered || this.selected || Date.now() - this.view.statusSince < FRESH_DONE_MS;
    // 매 프레임 불리지만 말풍선 글은 스냅샷이 오거나 고르기·올리기가 바뀔 때만 달라진다.
    if (this.bubbleFor === this.view && this.bubbleFull === full) return;
    this.bubbleFor = this.view;
    this.bubbleFull = full;
    const parts = bubbleParts(this.view, full);
    if (parts === null) return;
    const key = `${parts.icon ?? ""}\n${parts.text}`;
    if (this.bubbleKey === key) return;
    this.bubbleKey = key;
    const text = document.createElement("span");
    text.textContent = parts.text;
    this.bubble.replaceChildren(...(parts.icon ? [icon(parts.icon)] : []), text);
  }

  /** 멀리서는 쉬거나 끝난 에이전트의 이름을 접는다(스타일시트의 .far 규칙과 같은 조건). */
  private farFolds(): boolean {
    const status = this.view.status;
    return this.far && !this.hovered && !this.selected && status !== "working" && status !== "blocked";
  }

  private nameHidden(): boolean {
    return this.lod >= 2 || this.farFolds();
  }

  /** 이름표가 줄어들 수 있는 모습들의 크기: 말풍선과 이름 → 이름만 → 번호만. */
  private sizes(): readonly Size[] {
    const plate = this.farFolds() ? this.compactSize : this.plateSize;
    const gap = 4;
    const foot = 6;
    const full: Size = this.bubble.hidden ? [plate[0], plate[1] + foot] : [Math.max(this.bubbleSize[0], plate[0]), this.bubbleSize[1] + gap + plate[1] + foot];
    return [full, [plate[0], plate[1] + foot], [this.compactSize[0], this.compactSize[1] + foot]];
  }

  private syncFollowers(): void {
    const want = this.view.status === "working" ? Math.min(this.view.subagents, MAX_FOLLOWERS) : 0;
    while (this.followers.length < want) {
      const rig = createRig(this.view.vendor, this.seed + this.followers.length * 7.3);
      rig.group.scale.setScalar(0.38);
      this.group.add(rig.group);
      this.followers.push({ rig, phase: this.followers.length });
    }
    while (this.followers.length > want) {
      const gone = this.followers.pop()!;
      this.group.remove(gone.rig.group);
      gone.rig.dispose();
    }
  }

  /** 지금 상태에서 가 있어야 할 자리. */
  private goal(layout: Layout, t: number): Spot {
    const plot = layout.plots.get(this.view.workspaceId);
    const center = new THREE.Vector3();
    if (!plot) return { pos: plazaSlot(20 + this.placement.plaza), look: center };
    switch (this.view.status) {
      case "done":
        return { pos: plazaSlot(this.placement.plaza), look: center };
      case "blocked":
        return { pos: gateSpot(plot, this.placement.inPlot), look: center };
      case "working": {
        const spots = workSpots(plot);
        if (t >= this.nextWanderAt) {
          // 같은 집터에서 여럿이 일하면 서로 다른 일터에서 시작해 돌아가며 옮긴다.
          this.spotIndex = (this.spotIndex + 1 + Math.floor(hash(`${this.view.id}${Math.floor(t)}`) * 2)) % spots.length;
          this.nextWanderAt = t + 7 + hash(`${this.view.id}w${Math.floor(t)}`) * 9;
        }
        const spot = spots[(this.spotIndex + this.placement.inPlot) % spots.length]!;
        // 일터보다 일꾼이 많으면 같은 일터의 옆자리에 선다.
        const extra = Math.floor(this.placement.inPlot / spots.length);
        return extra === 0 ? spot : { pos: spot.pos.clone().addScaledVector(plot.side, extra * 1.35 * plot.scale), look: spot.look };
      }
      default:
        return { pos: restSpot(plot, this.placement.inPlot), look: center };
    }
  }

  update(t: number, dt: number, layout: Layout, camera: THREE.Camera): void {
    const goal = this.goal(layout, t);
    const pos = this.group.position;
    if (!this.placed) {
      // 처음 나타날 때는 걸어오지 않고 제자리에서 시작한다.
      pos.copy(goal.pos);
      this.placed = true;
    }
    const dx = goal.pos.x - pos.x;
    const dz = goal.pos.z - pos.z;
    const dist = Math.hypot(dx, dz);
    this.inTransit = dist > TRANSIT_DISTANCE;
    this.isMoving = dist > 0.08;
    let pose: Pose;
    let face: number;
    const status = this.view.status;

    if (dist > 0.08) {
      const speed = dist > 5 || status === "done" || status === "blocked" ? RUN_SPEED : WALK_SPEED;
      const step = Math.min(dist, speed * dt);
      pos.x += (dx / dist) * step;
      pos.z += (dz / dist) * step;
      face = Math.atan2(dx, dz);
      pose = "walk";
      this.arrivedAt = t;
    } else {
      if (status === "done" || status === "blocked") {
        // 기다리는 에이전트는 화면 쪽을 바라본다.
        face = Math.atan2(camera.position.x - pos.x, camera.position.z - pos.z);
      } else {
        face = Math.atan2(goal.look.x - pos.x, goal.look.z - pos.z);
      }
      if (status === "working") pose = "work";
      else if (status === "blocked") pose = "alert";
      else if (status === "done") pose = t - this.arrivedAt < 6 || this.hovered || this.selected ? "cheer" : "idle";
      else pose = "sleep";
    }
    this.heading = turnToward(this.heading, face, 1 - Math.exp(-dt * 9));
    this.rig.group.rotation.y = this.heading;
    this.rig.animate(pose, t);

    const resting = status === "idle" || status === "unknown";
    const dimTarget = this.muted ? 0.95 : resting && !this.hovered && !this.selected ? 0.75 : 0;
    if (Math.abs(dimTarget - this.dim) > 0.005) {
      this.dim += (dimTarget - this.dim) * (1 - Math.exp(-dt * 6));
      this.rig.setDim(this.dim);
      for (const f of this.followers) f.rig.setDim(this.dim);
    }

    const grow = this.selected ? 1.12 : this.hovered ? 1.07 : 1;
    const s = this.rig.group.scale.x + (grow - this.rig.group.scale.x) * (1 - Math.exp(-dt * 12));
    this.rig.group.scale.setScalar(s);

    // 발밑 고리: 상태마다 다른 박자로 뛴다. 쉬는 에이전트는 고르거나 올렸을 때만 보인다.
    const beat = status === "blocked" ? 7 : status === "done" ? 3 : 1.6;
    const pulse = 0.5 + 0.5 * Math.sin(t * beat + this.seed);
    this.ring.visible = !resting || this.selected || this.hovered;
    this.ring.scale.setScalar((this.selected ? 1.18 : 1) + (status === "blocked" ? pulse * 0.16 : status === "done" ? pulse * 0.07 : 0));
    this.ringMat.opacity = this.muted ? 0.15 : this.selected ? 0.95 : status === "working" ? 0.45 + pulse * 0.25 : 0.55 + pulse * 0.35;
    this.ring.rotation.z = t * 0.6;
    if (this.pillar.visible) this.pillarMat.opacity = this.muted ? 0.04 : (status === "blocked" ? 0.3 : 0.2) + pulse * 0.1;

    this.followers.forEach((f, i) => {
      const a = t * 1.3 + (i / Math.max(1, this.followers.length)) * Math.PI * 2;
      f.rig.group.position.set(Math.cos(a) * 1.25, 0, Math.sin(a) * 1.25);
      f.rig.group.rotation.y = -a;
      f.rig.animate("walk", t + i);
    });

    this.syncBubble();
    this.far = camera.position.distanceTo(pos) > FAR_DISTANCE;
    // 매 프레임 불리지만 표시는 드물게 바뀐다. 달라졌을 때만 DOM 을 건드린다.
    const shownAs = `tag${this.far ? " far" : ""}${this.hovered ? " hovered" : ""}${this.selected ? " selected" : ""}${this.muted ? " muted" : ""} ${LOD_CLASS[this.lod] ?? "lod2"}`;
    if (shownAs !== this.shownAs) {
      this.tag.className = shownAs;
      this.shownAs = shownAs;
    }
  }

  /**
   * 제 자리로 가는 길 위에 있는지. 자리에 닿았거나 거의 닿은 배우는 서로 밀지 않는다 — 자리끼리 가까우면
   * 밀려났다가 되돌아오기를 끝없이 되풀이해, 제자리에서 떠는 것처럼 보이기 때문이다.
   */
  get transit(): boolean {
    return this.inTransit;
  }

  /** 지금 걸어가는 중인지(자리에 닿으면 false). */
  get moving(): boolean {
    return this.isMoving;
  }

  /** 다른 배우와 겹치지 않게 살짝 밀려난다(씬이 쌍마다 부른다). */
  nudge(x: number, z: number): void {
    this.group.position.x += x;
    this.group.position.z += z;
  }

  dispose(): void {
    labels.unmeasure(this.bubble);
    labels.unmeasure(this.plate);
    labels.detach(this.tag);
    this.rig.dispose();
    for (const f of this.followers) f.rig.dispose();
    this.hit.geometry.dispose();
    (this.hit.material as THREE.Material).dispose();
    this.ring.geometry.dispose();
    this.ringMat.dispose();
    this.pillar.geometry.dispose();
    this.pillarMat.dispose();
  }
}
