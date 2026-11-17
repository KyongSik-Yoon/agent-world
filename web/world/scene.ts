// 3D 장면: 렌더러·카메라·조작, 스냅샷을 배우들로 옮기는 일, 고르기.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { CSS2DObject, CSS2DRenderer } from "three/addons/renderers/CSS2DRenderer.js";

import type { AgentView, WorldSnapshot } from "../../shared/types.ts";
import { Actor } from "./actor.ts";
import { Environment, type Theme } from "./environment.ts";
import { buildLayout, shellSpot, type Layout } from "./layout.ts";

export interface SceneCallbacks {
  onSelect(id: string | null): void;
  onHover(id: string | null): void;
  /** 집 문패를 눌렀다. */
  onPlot(workspaceId: string): void;
}

const FOG: Record<Theme, string> = { day: "#CBE7F6", night: "#161B33" };

export class WorldScene {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly labels = new CSS2DRenderer();
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(36, 1, 0.5, 600);
  private readonly controls: OrbitControls;
  private readonly env: Environment;
  private readonly actors = new Map<string, Actor>();
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private readonly clock = new THREE.Clock();
  private layout: Layout = buildLayout([]);
  private layoutKey = "";
  /** 에이전트 없는 셸 pane 들 — 집 앞의 작은 단말기로 세운다. */
  private readonly shells = new Map<string, THREE.Group>();
  private shellKey = "";
  private selectedId: string | null = null;
  private hoveredId: string | null = null;
  /**
   * 카메라가 부드럽게 옮겨 갈 목표. 사용자가 직접 움직이면 지운다.
   * position 이 있으면 바라보는 방향까지 그 자리로 되돌린다(고르기 전 시점으로 돌아갈 때).
   */
  private flight: { target: THREE.Vector3; distance: number; position?: THREE.Vector3 } | null = null;
  /** 무언가를 고르기 직전의 시점 — 고르기를 풀면 여기로 돌아간다. */
  private home: { target: THREE.Vector3; position: THREE.Vector3 } | null = null;
  private downAt: { x: number; y: number } | null = null;

  constructor(
    private readonly container: HTMLElement,
    private readonly callbacks: SceneCallbacks,
  ) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    container.append(this.renderer.domElement);

    this.labels.domElement.className = "labels";
    container.append(this.labels.domElement);

    this.scene.fog = new THREE.Fog(FOG.day, 70, 210);
    this.env = new Environment((workspaceId) => this.callbacks.onPlot(workspaceId));
    this.scene.add(this.env.group);

    this.camera.position.set(0, 34, 44);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.09;
    this.controls.minDistance = 7;
    this.controls.maxDistance = 130;
    this.controls.minPolarAngle = 0.2;
    this.controls.maxPolarAngle = 1.36;
    this.controls.target.set(0, 0.5, 0);
    // 이동은 땅과 나란히 — 화면 기준으로 밀면 카메라가 기울어 있을 때 땅속으로 파고든다.
    this.controls.screenSpacePanning = false;
    // 휠 버튼(가운데)과 오른쪽 버튼 드래그는 맵 이동이다. 휠 굴리기는 그대로 확대·축소.
    this.controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.PAN };
    this.controls.addEventListener("start", () => {
      this.flight = null;
    });

    const el = this.renderer.domElement;
    // 이름표·말풍선·문패 위에서 굴린 휠(터치패드의 두 손가락 벌리기 포함)도 카메라로 보낸다.
    // 그러지 않으면 그 위에서는 카메라가 꿈쩍도 않고, 벌리기 동작은 브라우저가 페이지를 확대해 버린다.
    this.labels.domElement.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        el.dispatchEvent(new WheelEvent("wheel", e));
      },
      { passive: false },
    );
    el.addEventListener("pointermove", (e) => this.onPointerMove(e));
    el.addEventListener("pointerdown", (e) => {
      this.downAt = { x: e.clientX, y: e.clientY };
    });
    el.addEventListener("pointerup", (e) => this.onPointerUp(e));
    el.addEventListener("pointerleave", () => this.setHover(null));

    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    this.overview(false);
    this.renderer.setAnimationLoop(() => this.frame());
  }

  private resize(): void {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    // 브라우저 확대/축소가 바뀌면 화소 비율도 바뀐다. 처음 값에 묶어 두면 필요 이상으로 그리거나 흐려진다.
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(w, h);
    this.labels.setSize(w, h);
  }

  setTheme(theme: Theme): void {
    this.env.setTheme(theme);
    (this.scene.fog as THREE.Fog).color.set(FOG[theme]);
  }

  /** Space 를 누르고 있는 동안에는 왼쪽 드래그가 회전이 아니라 맵 이동이다(Figma 식). */
  setPanMode(on: boolean): void {
    this.controls.mouseButtons.LEFT = on ? THREE.MOUSE.PAN : THREE.MOUSE.ROTATE;
    this.container.classList.toggle("panning", on);
  }

  /** 스냅샷을 장면에 반영한다: 배치가 바뀌었으면 무대를 다시 짓고, 배우를 만들고 치우고 갱신한다. */
  sync(snapshot: WorldSnapshot): void {
    const key = snapshot.workspaces.map((w) => w.id).join("|");
    if (key !== this.layoutKey) {
      const first = this.layoutKey === "";
      this.layoutKey = key;
      this.layout = buildLayout(snapshot.workspaces.map((w) => w.id));
      this.env.rebuild(this.layout, snapshot.workspaces);
      if (first) this.overview(false);
    } else {
      for (const ws of snapshot.workspaces) this.env.labelSign(ws);
    }

    const seen = new Set<string>();
    for (const view of snapshot.agents) {
      seen.add(view.id);
      const actor = this.actors.get(view.id);
      if (actor && actor.view.vendor === view.vendor) {
        actor.apply(view);
        continue;
      }
      if (actor) this.removeActor(view.id);
      const created = new Actor(
        view,
        (id) => this.callbacks.onSelect(id),
        (id) => this.setHover(id),
      );
      created.selected = view.id === this.selectedId;
      this.actors.set(view.id, created);
      this.scene.add(created.group);
    }
    for (const id of [...this.actors.keys()]) if (!seen.has(id)) this.removeActor(id);

    this.syncShells(snapshot);
    this.place(snapshot.agents);
    const blocked = snapshot.agents.filter((a) => a.status === "blocked").length;
    const done = snapshot.agents.filter((a) => a.status === "done").length;
    this.env.setSignal(blocked, done);
  }

  /** 셸 pane 마다 집 앞에 단말기를 하나 세운다. 누르면 그 셸의 터미널을 본다. */
  private syncShells(snapshot: WorldSnapshot): void {
    const shells = snapshot.panes.filter((p) => !p.agentId && this.layout.plots.has(p.workspaceId));
    const key = `${this.layoutKey}#${shells.map((p) => p.id).join("|")}`;
    if (key === this.shellKey) return;
    this.shellKey = key;
    for (const group of this.shells.values()) {
      this.scene.remove(group);
      group.traverse((o) => {
        if (o instanceof CSS2DObject) o.element.remove();
        if (o instanceof THREE.Mesh) {
          o.geometry.dispose();
          (o.material as THREE.Material).dispose();
        }
      });
    }
    this.shells.clear();
    const perPlot = new Map<string, number>();
    for (const pane of shells) {
      const plot = this.layout.plots.get(pane.workspaceId)!;
      const k = perPlot.get(pane.workspaceId) ?? 0;
      perPlot.set(pane.workspaceId, k + 1);
      const group = new THREE.Group();
      group.position.copy(shellSpot(plot, k));
      group.rotation.y = plot.facing;
      const stand = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.5, 0.42), new THREE.MeshStandardMaterial({ color: "#3a4256", roughness: 0.7 }));
      stand.position.y = 0.25;
      stand.castShadow = true;
      const screen = new THREE.Mesh(
        new THREE.BoxGeometry(0.7, 0.46, 0.06),
        new THREE.MeshStandardMaterial({ color: "#10141f", emissive: "#3ddc97", emissiveIntensity: 0.55, roughness: 0.4 }),
      );
      screen.position.set(0, 0.76, 0);
      screen.rotation.x = -0.22;
      screen.castShadow = true;
      const el = document.createElement("button");
      el.type = "button";
      el.className = "shell-tag";
      el.textContent = ">_";
      el.title = `셸 ${pane.id}${pane.label ? ` · ${pane.label}` : ""}`;
      el.addEventListener("click", () => this.callbacks.onSelect(pane.id));
      const tag = new CSS2DObject(el);
      tag.position.set(0, 1.25, 0);
      group.add(stand, screen, tag);
      this.shells.set(pane.id, group);
      this.scene.add(group);
    }
  }

  /** 광장 순번과 집터 안 순번을 매긴다 — 먼저 끝난 에이전트가 광장 앞자리에 선다. */
  private place(agents: readonly AgentView[]): void {
    const done = agents.filter((a) => a.status === "done").sort((a, b) => a.statusSince - b.statusSince || a.id.localeCompare(b.id));
    done.forEach((a, i) => {
      const actor = this.actors.get(a.id);
      if (actor) actor.placement = { plaza: i, inPlot: 0 };
    });
    const groups = new Map<string, AgentView[]>();
    for (const a of agents) {
      if (a.status === "done") continue;
      const bucket = a.status === "unknown" ? "idle" : a.status;
      const k = `${a.workspaceId}|${bucket}`;
      groups.set(k, [...(groups.get(k) ?? []), a]);
    }
    for (const list of groups.values()) {
      list.sort((a, b) => a.id.localeCompare(b.id));
      list.forEach((a, i) => {
        const actor = this.actors.get(a.id);
        if (actor) actor.placement = { plaza: 0, inPlot: i };
      });
    }
  }

  private removeActor(id: string): void {
    const actor = this.actors.get(id);
    if (!actor) return;
    this.scene.remove(actor.group);
    actor.dispose();
    this.actors.delete(id);
    if (this.hoveredId === id) this.hoveredId = null;
  }

  /** 고른 에이전트를 표시하고, fly 면 카메라가 따라간다. */
  select(id: string | null, fly = true): void {
    const before = this.selectedId;
    if (id && !before && fly) {
      // 돌아오는 중에 다시 골랐으면, 가던 곳이 돌아갈 자리다.
      const returning = this.flight?.position ? this.flight : null;
      this.home = { target: (returning?.target ?? this.controls.target).clone(), position: (returning?.position ?? this.camera.position).clone() };
    }
    this.selectedId = id;
    if (!id) {
      // 고르기를 풀면 다가가기 전에 보던 자리와 배율로 돌아간다.
      if (before && this.home && fly) {
        this.flight = { target: this.home.target, position: this.home.position, distance: this.home.position.distanceTo(this.home.target) };
      }
      this.home = null;
    }
    for (const [actorId, actor] of this.actors) actor.selected = actorId === id;
    const actor = id ? this.actors.get(id) : undefined;
    if (actor && fly) {
      this.flight = { target: actor.group.position.clone().setY(0.9), distance: Math.min(this.distance(), 17) };
    } else if (id && fly) {
      const shell = this.shells.get(id);
      if (shell) this.flight = { target: shell.position.clone().setY(0.8), distance: Math.min(this.distance(), 17) };
      else if (id.startsWith("ws:")) this.flyToPlot(id.slice(3));
    }
  }

  /** 로스터 필터: 통과하지 못한 배우를 흐리게 한다. null 이면 모두 또렷하게. */
  setFilter(pass: ((view: AgentView) => boolean) | null): void {
    for (const actor of this.actors.values()) actor.muted = pass ? !pass(actor.view) : false;
  }

  setExternalHover(id: string | null): void {
    this.setHover(id, false);
  }

  private setHover(id: string | null, notify = true): void {
    if (id === this.hoveredId) return;
    this.hoveredId = id;
    for (const [actorId, actor] of this.actors) actor.hovered = actorId === id;
    this.renderer.domElement.style.cursor = id ? "pointer" : "";
    if (notify) this.callbacks.onHover(id);
  }

  private distance(): number {
    return this.camera.position.distanceTo(this.controls.target);
  }

  /** 처음 화면으로 돌아간다: 마을 전체가 보이는 자리·배율·각도. */
  overview(animate = true): void {
    this.home = null;
    const distance = this.layout.islandRadius * 2.35 + 6;
    const target = new THREE.Vector3(0, 0.5, 1.5);
    const position = target.clone().addScaledVector(new THREE.Vector3(0, 0.72, 0.7).normalize(), distance);
    if (animate) {
      this.flight = { target, distance, position };
      return;
    }
    this.controls.target.copy(target);
    this.camera.position.copy(position);
    this.controls.update();
  }

  private flyToPlot(workspaceId: string): void {
    const plot = this.layout.plots.get(workspaceId);
    if (plot) this.flight = { target: plot.center.clone().setY(0.8), distance: 21 };
  }

  private pick(e: PointerEvent): string | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObjects(
      [...this.actors.values()].map((a) => a.hit),
      false,
    );
    return (hits[0]?.object.userData.actorId as string | undefined) ?? null;
  }

  private onPointerMove(e: PointerEvent): void {
    if (e.buttons !== 0) return;
    this.setHover(this.pick(e));
  }

  private onPointerUp(e: PointerEvent): void {
    const down = this.downAt;
    this.downAt = null;
    // 끌어서 카메라를 돌린 것은 클릭이 아니다.
    if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5 || e.button !== 0) return;
    this.callbacks.onSelect(this.pick(e));
  }

  private frame(): void {
    const dt = Math.min(this.clock.getDelta(), 0.1);
    const t = this.clock.elapsedTime;

    const actors = [...this.actors.values()];
    for (const actor of actors) actor.update(t, dt, this.layout, this.camera);
    // 걸어가는 동안에는 서로 겹치지 않게 살짝 비켜 간다. 자리에 닿은 배우는 밀지도 밀리지도 않는다.
    for (let i = 0; i < actors.length; i += 1) {
      for (let j = i + 1; j < actors.length; j += 1) {
        const moving = Number(actors[i]!.transit) + Number(actors[j]!.transit);
        if (moving === 0) continue;
        const a = actors[i]!.group.position;
        const b = actors[j]!.group.position;
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const d = Math.hypot(dx, dz);
        if (d >= 1.25 || d < 1e-4) continue;
        // 한쪽만 걷는 중이면 걷는 쪽이 다 비킨다.
        const push = (((1.25 - d) / d) * Math.min(1, dt * 8)) / moving;
        if (actors[i]!.transit) actors[i]!.nudge(-dx * push, -dz * push);
        if (actors[j]!.transit) actors[j]!.nudge(dx * push, dz * push);
      }
    }

    // 고른 에이전트가 걸어가면 카메라의 목표도 같이 간다.
    const selected = this.selectedId ? this.actors.get(this.selectedId) : undefined;
    if (selected && this.flight) this.flight.target.copy(selected.group.position).setY(0.9);
    if (this.flight?.position) {
      const k = 1 - Math.exp(-dt * 4.2);
      this.controls.target.lerp(this.flight.target, k);
      this.camera.position.lerp(this.flight.position, k);
      if (this.camera.position.distanceTo(this.flight.position) < 0.03) this.flight = null;
    } else if (this.flight) {
      const k = 1 - Math.exp(-dt * 4.2);
      const offset = this.camera.position.clone().sub(this.controls.target);
      const distance = offset.length() + (this.flight.distance - offset.length()) * k;
      this.controls.target.lerp(this.flight.target, k);
      this.camera.position.copy(this.controls.target).addScaledVector(offset.normalize(), distance);
      if (!selected && this.controls.target.distanceTo(this.flight.target) < 0.02 && Math.abs(distance - this.flight.distance) < 0.05) this.flight = null;
    }

    this.env.update(t, dt);
    this.controls.update();
    // 맵을 밀다가 섬을 잃어버리지 않게, 바라보는 곳이 섬 언저리를 벗어나지 않게 한다.
    const target = this.controls.target;
    const away = Math.hypot(target.x, target.z);
    const limit = this.layout.islandRadius + 4;
    if (away > limit) {
      const dx = target.x * (limit / away - 1);
      const dz = target.z * (limit / away - 1);
      target.x += dx;
      target.z += dz;
      this.camera.position.x += dx;
      this.camera.position.z += dz;
    }
    this.renderer.render(this.scene, this.camera);
    this.labels.render(this.scene, this.camera);
  }
}
