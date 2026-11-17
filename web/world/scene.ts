// 3D 장면: 렌더러·카메라·조작, 스냅샷을 배우들로 옮기는 일, 고르기.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

import type { AgentView, WorldSnapshot } from "../../shared/types.ts";
import { Actor } from "./actor.ts";
import { Environment, type Theme } from "./environment.ts";
import { labels } from "./labels.ts";
import { buildLayout, shellSpot, type Layout } from "./layout.ts";

export interface SceneCallbacks {
  onSelect(id: string | null): void;
  onHover(id: string | null): void;
  /** 집 문패를 눌렀다. */
  onPlot(workspaceId: string): void;
}

const FOG: Record<Theme, string> = { day: "#CBE7F6", night: "#161B33" };

/** 한 프레임에 칠할 화소 수의 상한. 4K 창에서 화소마다 그림자를 계산하면 내장 그래픽이 버티지 못한다. */
const MAX_PIXELS = 3.6e6;
/** 그리는 데 이보다 오래 걸리면 해상도를 한 단계 낮추고, 충분히 빠르면 다시 올린다(ms). */
const SLOW_RENDER_MS = 20;
const FAST_RENDER_MS = 8;
const MIN_SCALE = 0.6;
/**
 * 손대지 않고 켜 둔 동안의 최소 프레임 간격(ms). 종일 띄워 두는 화면이라 평소에는 초당 30장쯤이면 충분하다.
 * 60Hz 화면에서는 두 프레임에 한 번(약 30장)이 되고, 더 느린 주사율에서는 거르지 않는다.
 */
const IDLE_FRAME_MS = 24;
/** 마지막 조작 뒤 이만큼은 화면 주사율 그대로 그린다. */
const ACTIVE_MS = 2500;
/**
 * 한동안 손대지 않았거나 다른 창을 쓰는 중이면 "곁눈질 화면"이다 — 초당 12장쯤으로 더 줄인다.
 * 일하는 캐릭터는 늘 일터 사이를 오가므로, 걷는 동안을 예외로 두면 이 단계에 들어갈 틈이 없다.
 */
const AMBIENT_AFTER_MS = 20_000;
const AMBIENT_FRAME_MS = 80;
/** 걷는 캐릭터가 없을 때 그림자 지도를 다시 그리는 간격. */
const SHADOW_MS = 20;

export class WorldScene {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly labels = labels;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(36, 1, 0.5, 600);
  private readonly controls: OrbitControls;
  private readonly env: Environment;
  private readonly actors = new Map<string, Actor>();
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private readonly clock = new THREE.Clock();
  private layout: Layout = buildLayout([]);
  /** 지금 지어 둔 무대의 스페이스 구성. 아직 한 번도 짓지 않았으면 null — 스페이스가 하나도 없어도 섬은 지어야 한다. */
  private layoutKey: string | null = null;
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
  /** 화면 부하에 따라 조절하는 해상도 배율(1 = 기기 화소 그대로, 상한 안에서). */
  private scale = 1;
  private renderMs = 0;
  private tunedAt = 0;
  private goodStreak = 0;
  private lastFrameAt = 0;
  private lastInputAt = performance.now();
  private shadowAt = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** 다른 화면(터미널 크게 보기)에 덮여 보이지 않는다 — 그리지 않는다. */
  private covered = false;
  /** 덮여 있어 다음 프레임을 걸지 않고 멈춰 있다. */
  private parked = false;
  /** 이름표 층을 다시 놓아야 하는 프레임 수(스냅샷·크기·고르기가 바뀐 직후). */
  private labelsDirty = 3;
  /** 고른 캐릭터가 다른 자리로 가는 중이라 카메라가 따라 움직이고 있다. */
  private following = false;
  private readonly lastCamera = new THREE.Matrix4();
  /** 직전 프레임에 걸어가는 캐릭터가 있었는지. */
  private walking = false;

  constructor(
    private readonly container: HTMLElement,
    private readonly callbacks: SceneCallbacks,
  ) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    // 그림자 가장자리는 부드럽게 거른다(PCFSoft). 그냥 PCF 는 지도 한 칸이 화면 여러 화소인 가까운 거리에서 가장자리가
    // 톱니로 보이고, 캐릭터가 움직이면 그 톱니가 자글거린다. 비용 차이는 재 봐도 잡히지 않았다.
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    // 그림자 지도는 필요한 프레임에만 다시 그린다(frame 에서 직접 요청한다).
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    container.append(this.renderer.domElement);

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

    // 조작하는 동안에는 화면 주사율 그대로, 가만히 두면 느긋하게 그린다.
    const touched = (): void => {
      this.lastInputAt = performance.now();
      // 느긋하게 쉬는 중이었으면 다음 차례를 기다리지 않고 바로 그린다.
      if (this.timer !== undefined) {
        clearTimeout(this.timer);
        this.timer = undefined;
        requestAnimationFrame(this.tick);
      }
    };
    for (const type of ["pointermove", "pointerdown", "wheel", "keydown", "touchstart"]) window.addEventListener(type, touched, { passive: true });

    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    this.overview(false);
    requestAnimationFrame(this.tick);
  }

  private resize(): void {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    // 브라우저 확대/축소가 바뀌면 화소 비율도 바뀐다. 처음 값에 묶어 두면 필요 이상으로 그리거나 흐려진다.
    this.renderer.setPixelRatio(this.pixelRatio(w, h));
    this.renderer.setSize(w, h);
    this.labels.setSize(w, h);
    this.labelsDirty = 3;
  }

  /** 기기 화소 비율에 부하 배율을 곱하되, 한 프레임의 화소 수가 상한을 넘지 않게 한다. */
  private pixelRatio(w: number, h: number): number {
    const native = Math.min(window.devicePixelRatio, 2);
    return Math.min(native, Math.sqrt(MAX_PIXELS / (w * h))) * this.scale;
  }

  /** 그리는 시간을 보고 해상도 배율을 한 단계씩 조절한다. 올릴 때는 한동안 여유가 이어진 뒤에만. */
  private tune(now: number): void {
    // 처음 몇 초는 셰이더를 만드느라 느리다. 그걸 부하로 읽고 해상도를 내리지 않는다.
    if (this.tunedAt === 0) this.tunedAt = now + 4000;
    if (now - this.tunedAt < 1000) return;
    this.tunedAt = now;
    let next = this.scale;
    if (this.renderMs > SLOW_RENDER_MS) {
      next = Math.max(MIN_SCALE, this.scale * 0.85);
      this.goodStreak = 0;
    } else if (this.renderMs < FAST_RENDER_MS && this.scale < 1) {
      this.goodStreak += 1;
      if (this.goodStreak >= 3) {
        next = Math.min(1, this.scale * 1.1);
        this.goodStreak = 0;
      }
    } else this.goodStreak = 0;
    if (next !== this.scale) {
      this.scale = next;
      this.resize();
    }
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
      const first = this.layoutKey === null;
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
    this.labelsDirty = 3;
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
        if (o.userData.label instanceof HTMLElement) this.labels.detach(o.userData.label);
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
      const tag = new THREE.Object3D();
      tag.position.set(0, 1.25, 0);
      tag.userData.label = el;
      // 셸 표시는 가장 덜 급하다. 다른 이름표와 겹치면 숨는다(단말기 자체는 그대로 보이고 눌린다).
      this.labels.attach({ el, anchor: tag, center: [0.5, 0.5], order: pane.id, rank: () => 6, sizes: () => [[30, 16]], hideable: () => true });
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
    this.labelsDirty = 3;
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
    // 세로로 긴 화면(휴대폰)은 가로 시야가 좁아 같은 거리에서는 섬의 양옆이 잘린다. 좁은 만큼 물러서되,
    // 캐릭터가 점이 되지 않을 만큼만.
    const narrow = Math.min(Math.max(1, 1.6 / this.camera.aspect), 1.9);
    const distance = Math.min((this.layout.islandRadius * 2.35 + 6) * narrow, this.controls.maxDistance);
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

  /** 화면이 다른 것에 덮여 있는 동안에는 그리기를 멈추고, 걷히면 바로 이어 그린다. */
  setCovered(covered: boolean): void {
    this.covered = covered;
    if (covered || !this.parked) return;
    this.parked = false;
    requestAnimationFrame(this.tick);
  }

  /**
   * 지금 몇 ms 간격으로 그릴지: 조작 중 0(주사율 그대로), 가만히 두면 30장쯤, 곁눈질 화면이면 12장쯤.
   *
   * 고른 캐릭터를 따라가는 flight 는 고르기를 풀 때까지 남아 있으므로, flight 가 있다는 것만으로 조작 중이라고
   * 치지 않는다(그러면 캐릭터를 고른 내내 주사율대로 그린다). 다가가는 동안은 고른 입력에서 ACTIVE_MS 가 덮고,
   * 그 뒤로는 화면이 크게 움직일 때만 — 제자리로 돌아가는 중이거나, 고른 캐릭터가 먼 길을 가는 중일 때만 — 조작 중이다.
   */
  private pace(now: number): number {
    const quiet = now - this.lastInputAt;
    const sweeping = this.flight?.position !== undefined || (this.flight !== null && this.following);
    if (sweeping || quiet < ACTIVE_MS) return 0;
    return quiet > AMBIENT_AFTER_MS || !document.hasFocus() ? AMBIENT_FRAME_MS : IDLE_FRAME_MS;
  }

  /**
   * 한 프레임을 그리고 다음 차례를 잡는다.
   *
   * 쉬는 동안에는 requestAnimationFrame 을 매번 걸지 않는다 — 걸어 두면 그리지 않는 프레임에도 브라우저가
   * 초당 60번 깨어나 화면 합성까지 돈다. 쉴 만큼 타이머로 기다렸다가 그때 한 번만 건다.
   */
  private readonly tick = (): void => {
    if (this.covered) {
      this.parked = true;
      return;
    }
    this.frame();
    const now = performance.now();
    const wait = this.lastFrameAt + this.pace(now) - now;
    if (wait < 6) requestAnimationFrame(this.tick);
    else {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        requestAnimationFrame(this.tick);
      }, wait - 4);
    }
  };

  private frame(): void {
    const now = performance.now();
    this.lastFrameAt = now;

    const dt = Math.min(this.clock.getDelta(), 0.1);
    const t = this.clock.elapsedTime;

    const actors = [...this.actors.values()];
    let walking = false;
    for (const actor of actors) {
      actor.update(t, dt, this.layout, this.camera);
      walking ||= actor.moving;
    }
    this.walking = walking;
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
    this.following = selected?.transit ?? false;
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
    // 그림자 지도는 걷는 캐릭터가 있으면 매 프레임 다시 그린다 — 한 프레임만 늦어도 그림자가 발밑에서 앞뒤로 떨린다.
    // 아무도 걷지 않으면 제자리 몸짓과 수정뿐이라 SHADOW_MS 마다면 충분하다(빠른 화면에서는 두세 프레임에 한 번).
    if (this.walking || now - this.shadowAt >= SHADOW_MS) {
      this.renderer.shadowMap.needsUpdate = true;
      this.shadowAt = now;
    }
    const startedAt = performance.now();
    this.renderer.render(this.scene, this.camera);
    // 어쩌다 한 번 튀는 프레임(셰이더 컴파일, 탭 전환)에 끌려가지 않게 표본을 눌러 담는다.
    this.renderMs += (Math.min(performance.now() - startedAt, 60) - this.renderMs) * 0.1;
    // 이름표(DOM)는 카메라나 캐릭터가 움직였을 때만 다시 놓는다. 가만히 있는 동안 매 프레임 위치와 겹침 순서를
    // 다시 쓰면 그리는 것보다 스타일 계산이 더 든다.
    const cameraMoved = !this.lastCamera.equals(this.camera.matrixWorld);
    if (cameraMoved || this.walking || this.labelsDirty > 0 || this.labels.dirty) {
      // 자세한 모습으로 돌아가려고 기다리는 이름표가 있으면 다음 프레임에도 본다.
      if (this.labels.update(this.camera, now)) this.labelsDirty = Math.max(this.labelsDirty, 1);
      else if (this.labelsDirty > 0) this.labelsDirty -= 1;
      this.lastCamera.copy(this.camera.matrixWorld);
    }
    this.tune(now);
  }
}
