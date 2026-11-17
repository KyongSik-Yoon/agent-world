// 에이전트 하나를 연기하는 배우: 캐릭터 모델, 머리 위 이름표·말풍선, 상태에 따른 자리와 몸짓.
import * as THREE from "three";
import { CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";

import type { AgentStatus, AgentView } from "../../shared/types.ts";
import { bubbleText } from "../format.ts";
import { createRig, type Pose, type Rig } from "./characters.ts";
import { gateSpot, plazaSlot, restSpot, workSpots, type Layout, type Spot } from "./layout.ts";

const STATUS_COLOR: Record<AgentStatus, string> = {
  working: "#F5A524",
  done: "#2FBF71",
  blocked: "#F0506E",
  idle: "#8A93A6",
  unknown: "#8A93A6",
};

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
  private readonly label: CSS2DObject;
  private readonly tag: HTMLDivElement;
  private readonly bubble: HTMLDivElement;
  private readonly plateNum: HTMLSpanElement;
  private readonly plateName: HTMLSpanElement;
  private readonly followers: Array<{ rig: Rig; phase: number }> = [];

  private heading: number;
  private spotIndex: number;
  private nextWanderAt = 0;
  private placed = false;
  private dim = 0;
  private arrivedAt = 0;
  private inTransit = false;

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
    const plate = document.createElement("div");
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
    this.label = new CSS2DObject(this.tag);
    this.label.center.set(0.5, 1);
    this.label.position.y = this.rig.height;
    this.group.add(this.label);

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
    this.bubble.hidden = bubbleText(view) === null;
    this.syncBubble();
    this.plateNum.textContent = view.workspaceNumber ? String(view.workspaceNumber) : "·";
    if (this.plateName.textContent !== view.title) this.plateName.textContent = view.title;

    if (statusChanged) this.nextWanderAt = 0;
    this.syncFollowers();
  }

  /** 올리거나 골랐을 때, 그리고 막 끝난 직후에는 긴 말풍선을, 그 밖에는 짧은 것을 보인다. */
  private syncBubble(): void {
    const fresh = Date.now() - this.view.statusSince < FRESH_DONE_MS;
    const text = bubbleText(this.view, this.hovered || this.selected || fresh);
    if (text !== null && this.bubble.textContent !== text) this.bubble.textContent = text;
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
        return extra === 0 ? spot : { pos: spot.pos.clone().addScaledVector(plot.side, extra * 1.35), look: spot.look };
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
    this.tag.classList.toggle("far", camera.position.distanceTo(pos) > FAR_DISTANCE);
    this.tag.classList.toggle("hovered", this.hovered);
    this.tag.classList.toggle("selected", this.selected);
    this.tag.classList.toggle("muted", this.muted);
  }

  /**
   * 제 자리로 가는 길 위에 있는지. 자리에 닿았거나 거의 닿은 배우는 서로 밀지 않는다 — 자리끼리 가까우면
   * 밀려났다가 되돌아오기를 끝없이 되풀이해, 제자리에서 떠는 것처럼 보이기 때문이다.
   */
  get transit(): boolean {
    return this.inTransit;
  }

  /** 다른 배우와 겹치지 않게 살짝 밀려난다(씬이 쌍마다 부른다). */
  nudge(x: number, z: number): void {
    this.group.position.x += x;
    this.group.position.z += z;
  }

  dispose(): void {
    this.tag.remove();
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
