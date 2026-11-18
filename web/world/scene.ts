// 3D 장면: 렌더러·카메라·조작, 스냅샷을 배우들로 옮기는 일, 고르기.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

import type { AgentView, WorldSnapshot } from "../../shared/types.ts";
import { beat } from "../beat.ts";
import { t } from "../i18n.ts";
import { Actor, PICK_LAYER } from "./actor.ts";
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
 * 장면 밖에서 온 일(목록의 줄에 올려놓기, 걸러 보기)에 캐릭터가 반응하는 동안 — 커지고 밝아지는 전환이 끝날 때까지 —
 * 주사율 그대로 그리는 시간. 가장 느린 전환(밝기, 시정수 약 170ms)이 눈에 띄지 않을 만큼 가라앉는 데 맞췄다.
 */
const EASE_MS = 800;
/**
 * 한동안 손대지 않았거나 다른 창을 쓰는 중이면 "곁눈질 화면"이다 — 초당 12장쯤으로 더 줄인다.
 * 일하는 캐릭터는 늘 일터 사이를 오가므로, 걷는 동안을 예외로 두면 이 단계에 들어갈 틈이 없다.
 */
const AMBIENT_AFTER_MS = 20_000;
const AMBIENT_FRAME_MS = 80;
/** 고른 캐릭터가 가려졌을 때 돌아 볼 각도들(도). 덜 도는 쪽부터 본다. */
const VIEW_TURNS = [0, 25, -25, 50, -50, 80, -80, 115, -115, 150, -150, 180];
/** 캐릭터가 보이는지 확인하는 높이들 — 발치, 몸통, 머리. */
const VIEW_HEIGHTS = [0.35, 0.9, 1.4];
const UP = new THREE.Vector3(0, 1, 0);
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
  /** 고른 캐릭터까지 시야가 트였는지 보는 광선. */
  private readonly sight = new THREE.Raycaster();
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
  /** 쉬는 동안 다음 프레임을 그리려는 때. 0 이면 시각표가 없다(조작 중이거나 방금 깨어났다). */
  private dueAt = 0;
  /** 바로 앞 프레임의 requestAnimationFrame 시각. 연달아 온 프레임 사이의 간격으로 화면 주사율을 잰다. */
  private lastStamp = 0;
  /** 연달아 그린 프레임 사이의 간격 표본(ms). 가운데 값이 화면이 한 번 바뀌는 간격이다. */
  private readonly refreshSamples: number[] = [];
  private refreshMs = 1000 / 60;
  /** 장면을 직접 건드린(끌기·휠·단축키·고르기) 마지막 때. 이 뒤 ACTIVE_MS 는 주사율 그대로 그린다. */
  private lastInputAt = performance.now();
  /** 화면 어디든 손이 닿은 마지막 때 — 곁눈질 화면으로 내려갈지만 정한다. */
  private lastSeenAt = performance.now();
  /** 이때까지는 장면 안에서 전환이 진행 중이라 주사율 그대로 그린다. */
  private easeUntil = 0;
  private shadowAt = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** 다른 화면(터미널 크게 보기)에 덮여 보이지 않는다 — 그리지 않는다. */
  private covered = false;
  /** 덮여 있어 다음 프레임을 걸지 않고 멈춰 있다. */
  private parked = false;
  /** 이번 프레임이 앞 프레임에서 곧바로 이어 건 것이다(타이머로 쉬었다 온 것이 아니다). */
  private chained = false;
  /** 이름표 층을 다시 놓아야 하는 프레임 수(스냅샷·크기·고르기가 바뀐 직후). */
  private labelsDirty = 3;
  /** 고른 캐릭터가 다른 자리로 가는 중이라 카메라가 따라 움직이고 있다. */
  private following = false;
  private readonly lastCamera = new THREE.Matrix4();
  /** 직전 프레임에 걸어가는 캐릭터가 있었는지. */
  private walking = false;
  /**
   * 화면 좌우를 덮고 있는 패널의 폭(px) — 목록과 상태 창. 장면의 한가운데가 창의 한가운데가 아니라 패널 사이
   * 빈 자리의 한가운데에 오도록 시야를 그만큼 옆으로 민다. 창이 좁을수록(화면 절반에 띄운 창) 차이가 크다.
   */
  private inset = { left: 0, right: 0 };
  /** 지금 시야가 옆으로 밀려 있는 정도(px). inset 을 부드럽게 따라간다. */
  private shiftX = 0;

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

    this.raycaster.layers.set(PICK_LAYER);
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
    const touched = (e: Event): void => {
      const now = performance.now();
      this.lastSeenAt = now;
      // 목록·위쪽 막대·입력란에서 온 입력은 장면을 움직이지 않는다. 그것까지 조작으로 치면 목록 위에서 포인터만
      // 움직여도, 지시를 타이핑만 해도 장면을 주사율 그대로 그린다(4K 60Hz 실측: 코어의 71~95%, 가만히 둘 때 33%).
      // 곁눈질 화면으로 내려가지만 않게 하고, 장면이 반응할 일이 생기면(올려놓기·고르기) 그쪽에서 따로 깨운다.
      if (!this.aimedAtScene(e)) return;
      this.lastInputAt = now;
      this.wake();
    };
    for (const type of ["pointermove", "pointerdown", "wheel", "keydown", "touchstart"]) window.addEventListener(type, touched, { passive: true });

    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    this.overview(false);
    requestAnimationFrame(this.tick);
  }

  /** 좌우 패널이 덮은 폭을 알려 준다. 시야는 다음 프레임들에 걸쳐 부드럽게 옮겨 간다. */
  setInsets(left: number, right: number): void {
    if (left === this.inset.left && right === this.inset.right) return;
    this.inset = { left, right };
    if (this.layoutKey === null) {
      // 아직 아무것도 그리기 전이면 미끄러져 들어오지 않고 처음부터 제자리에서 시작한다.
      this.shiftX = (left - right) / 2;
      this.applyShift();
      return;
    }
    // 옮겨 가는 동안은 화면 전체가 움직인다 — 주사율 그대로 그린다.
    this.lastInputAt = performance.now();
    this.wake();
  }

  /** 패널에 덮이지 않은 자리의 가로세로 비. 처음 화면의 거리를 여기에 맞춘다. */
  private freeAspect(): number {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    return Math.max(w - this.inset.left - this.inset.right, w * 0.4) / h;
  }

  /** 시야를 패널 사이 빈 자리의 한가운데로 민다. */
  private applyShift(): void {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    if (Math.abs(this.shiftX) < 0.5) this.camera.clearViewOffset();
    else this.camera.setViewOffset(w, h, -this.shiftX, 0, w, h);
    this.labelsDirty = Math.max(this.labelsDirty, 1);
  }

  private resize(): void {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.applyShift();
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
      el.title = `${t("셸 {id}", { id: pane.id })}${pane.label ? ` · ${pane.label}` : ""}`;
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
    // 고르는 것은 어떻게 골랐든(목록에서 키보드로, 알림을 눌러서) 조작이다 — 다가가는 동안은 주사율 그대로 그린다.
    // 포인터나 키 입력만 조작으로 치면 그 밖의 길로 고른 때는 카메라가 초당 30장으로 끊겨 움직인다.
    if (fly) {
      this.lastInputAt = performance.now();
      this.wake();
    } else if (id !== before) this.ease();
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
      const target = actor.group.position.clone().setY(0.9);
      const distance = Math.min(this.distance(), 17);
      this.flight = { target, distance, position: this.clearView(actor, target, distance) };
    } else if (id && fly) {
      const shell = this.shells.get(id);
      if (shell) this.flight = { target: shell.position.clone().setY(0.8), distance: Math.min(this.distance(), 17) };
      else if (id.startsWith("ws:")) this.flyToPlot(id.slice(3));
    }
  }

  /**
   * 고른 캐릭터가 가려지지 않는 카메라 자리. 지금 보는 방향 그대로 다가가도 보이면 undefined.
   *
   * 다가가는 방향에 집이나 나무가 서 있으면 고른 캐릭터가 그 뒤에 숨는다(특히 문 앞에서 일하는 캐릭터가 지붕 뒤로).
   * 지금 방향에서 좌우로 조금씩 돌려 가며 캐릭터까지 시야가 트였는지 광선으로 확인하고, 가장 덜 돌아도 되는 자리를 고른다.
   * 고를 때 한 번 하는 일이라 광선 수십 개의 비용은 문제가 되지 않는다.
   */
  private clearView(actor: Actor, target: THREE.Vector3, distance: number): THREE.Vector3 | undefined {
    const offset = this.camera.position.clone().sub(this.controls.target);
    if (offset.lengthSq() < 1e-6) return undefined;
    offset.normalize();
    const blockers: THREE.Object3D[] = [];
    this.env.group.traverse((o) => {
      if (o instanceof THREE.Mesh) blockers.push(o);
    });
    const feet = actor.group.position;
    const marks = VIEW_HEIGHTS.map((y) => new THREE.Vector3(feet.x, y, feet.z));
    const eye = new THREE.Vector3();
    const dir = new THREE.Vector3();
    let best: THREE.Vector3 | undefined;
    let least = Number.POSITIVE_INFINITY;
    for (const degrees of VIEW_TURNS) {
      eye.copy(offset).applyAxisAngle(UP, (degrees * Math.PI) / 180).multiplyScalar(distance).add(target);
      let hidden = 0;
      for (const mark of marks) {
        dir.copy(mark).sub(eye);
        const reach = dir.length();
        this.sight.set(eye, dir.divideScalar(reach));
        // 캐릭터 바로 곁의 소품(작업대, 텃밭)은 가리는 것으로 치지 않는다.
        this.sight.far = reach - 0.9;
        if (this.sight.intersectObjects(blockers, false).length > 0) hidden += 1;
      }
      if (hidden < least) {
        least = hidden;
        best = degrees === 0 ? undefined : eye.clone();
        if (hidden === 0) break;
      }
    }
    return best;
  }

  /** 로스터 필터: 통과하지 못한 배우를 흐리게 한다. null 이면 모두 또렷하게. */
  setFilter(pass: ((view: AgentView) => boolean) | null): void {
    let changed = false;
    for (const actor of this.actors.values()) {
      const muted = pass ? !pass(actor.view) : false;
      changed ||= muted !== actor.muted;
      actor.muted = muted;
    }
    // 걸러진 이름표는 자리 차례에서 밀린다 — 아무도 걷지 않는 화면에서도 바로 다시 놓는다.
    this.labelsDirty = 3;
    // 검색어를 치는 동안 걸러지는 캐릭터가 그대로면 장면에는 바뀌는 것이 없다.
    if (changed) this.ease();
  }

  setExternalHover(id: string | null): void {
    this.setHover(id, false);
  }

  private setHover(id: string | null, notify = true): void {
    if (id === this.hoveredId) return;
    this.hoveredId = id;
    for (const [actorId, actor] of this.actors) actor.hovered = actorId === id;
    // 올려놓은 이름표는 접혀 있었어도 다 펴져야 한다 — 카메라도 캐릭터도 가만히 있는 화면에서도.
    this.labelsDirty = 3;
    this.renderer.domElement.style.cursor = id ? "pointer" : "";
    this.ease();
    if (notify) this.callbacks.onHover(id);
  }

  /**
   * 이 입력이 장면을 움직이는가: 장면 위의 포인터·휠, 글을 치는 중이 아닐 때의 키(단축키·Space 로 밀기), 그리고 누르기.
   * 누르기는 어디서 눌렀든 친다 — 단추 하나가 장면을 움직이는 일(한눈에 보기, 낮밤 바꾸기, 패널 여닫기)이 많고,
   * 주사율을 붙들던 것은 누르기가 아니라 포인터가 지나가는 것과 휠, 타이핑이었다.
   */
  private aimedAtScene(e: Event): boolean {
    if (e.type === "pointerdown" || e.type === "touchstart") return true;
    const target = e.target instanceof Element ? e.target : null;
    if (e.type === "keydown") return target?.closest("input, textarea, select, [contenteditable], dialog") == null;
    return target !== null && this.container.contains(target);
  }

  /** 느긋하게 쉬는 중이었으면 다음 차례를 기다리지 않고 바로 그린다. */
  private wake(): void {
    if (this.timer === undefined) return;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.dueAt = 0;
    requestAnimationFrame(this.tick);
  }

  /** 캐릭터의 크기·밝기가 바뀌어 가는 동안은 주사율 그대로 그린다 — 장면 밖에서 시킨 일이어도 전환은 매끄러워야 한다. */
  private ease(): void {
    this.easeUntil = performance.now() + EASE_MS;
    this.wake();
  }

  private distance(): number {
    return this.camera.position.distanceTo(this.controls.target);
  }

  /** 처음 화면으로 돌아간다: 마을 전체가 보이는 자리·배율·각도. */
  overview(animate = true): void {
    this.home = null;
    // 세로로 긴 화면(휴대폰)은 가로 시야가 좁아 같은 거리에서는 섬의 양옆이 잘린다. 좁은 만큼 물러서되,
    // 캐릭터가 점이 되지 않을 만큼만.
    const narrow = Math.min(Math.max(1, 1.6 / this.freeAspect()), 1.9);
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
    const sweeping = this.flight?.position !== undefined || (this.flight !== null && this.following);
    if (sweeping || now - this.lastInputAt < ACTIVE_MS || now < this.easeUntil) return 0;
    const quiet = now - Math.max(this.lastInputAt, this.lastSeenAt);
    return quiet > AMBIENT_AFTER_MS || !document.hasFocus() ? AMBIENT_FRAME_MS : IDLE_FRAME_MS;
  }

  /**
   * 한 프레임을 그리고 다음 차례를 잡는다.
   *
   * 쉬는 동안에는 requestAnimationFrame 을 매번 걸지 않는다 — 걸어 두면 그리지 않는 프레임에도 브라우저가
   * 초당 60번 깨어나 화면 합성까지 돈다. 쉴 만큼 타이머로 기다렸다가 그때 한 번만 건다.
   *
   * 쉬는 간격은 화면이 바뀌는 간격의 배수로 맞추고, 지난 프레임이 아니라 시각표(dueAt)에서 센다. 화면에 따로 도는
   * 애니메이션이 없으면 브라우저는 다음 화면 박자를 기다리지 않고 요청받은 즉시 그리므로, "조금 일찍 걸면 다음 박자에
   * 그려진다"에 기대면 간격이 타이머만큼으로 줄고(60Hz 에서 30장이 50장이 됐다) 박자와도 어긋나 걸음이 떨린다.
   */
  private readonly tick = (stamp?: number): void => {
    if (this.covered) {
      this.parked = true;
      this.dueAt = 0;
      return;
    }
    const chained = this.chained;
    this.chained = false;
    this.frame();
    const now = performance.now();
    const pace = this.pace(now);
    if (pace === 0) {
      // 연달아 온 프레임 사이의 간격이 화면이 바뀌는 간격이다. 창을 다른 모니터로 옮기면 따라 바뀐다.
      if (chained && stamp !== undefined && this.lastStamp > 0) this.sampleRefresh(stamp - this.lastStamp);
      this.lastStamp = stamp ?? 0;
      this.dueAt = 0;
      this.chained = true;
      requestAnimationFrame(this.tick);
      return;
    }
    this.lastStamp = 0;
    // 간격을 화면 박자의 배수로 올림한다: 60Hz 에서 24ms → 두 박자(30장), 80ms → 다섯 박자(12장).
    const period = Math.ceil((pace - 1) / this.refreshMs) * this.refreshMs;
    // 시각표를 이어 간다. 처음이거나 한 주기 넘게 밀렸으면(탭이 가려졌다 돌아왔다) 이 프레임에서 다시 센다.
    const base = this.dueAt > 0 && Math.abs(this.lastFrameAt - this.dueAt) < period ? this.dueAt : this.lastFrameAt;
    this.dueAt = base + period;
    // requestAnimationFrame 이 알려 주는 시각은 화면 박자 위에 있다. 시각표를 그 박자에 붙여 두면, 브라우저가 박자를
    // 기다려 그리는 때와 즉시 그리는 때(이름표가 미끄러지는 transition 이 도는 동안은 기다린다)가 섞여도 간격이 고르다.
    if (stamp !== undefined) this.dueAt = stamp + Math.round((this.dueAt - stamp) / this.refreshMs) * this.refreshMs;
    const wait = this.dueAt - now;
    if (wait < 6) requestAnimationFrame(this.tick);
    else {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        requestAnimationFrame(this.tick);
      }, wait - 4);
    }
  };

  private sampleRefresh(ms: number): void {
    // 한두 프레임을 거른 간격이나 탭 전환 뒤의 긴 간격은 버린다(30Hz~360Hz).
    if (ms < 2.5 || ms > 34) return;
    const samples = this.refreshSamples;
    samples.push(ms);
    if (samples.length > 31) samples.shift();
    if (samples.length >= 9) this.refreshMs = [...samples].sort((x, y) => x - y)[samples.length >> 1]!;
  }

  private frame(): void {
    const now = performance.now();
    // 이름표의 깜빡임과 일하는 로고는 이 프레임에 묻어 넘어간다 — 따로 화면을 내보내지 않게.
    beat(now, Math.min(now - this.lastFrameAt, AMBIENT_FRAME_MS));
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
      if (this.camera.position.distanceTo(this.flight.position) < 0.03) {
        // 고른 캐릭터에게 돌아 들어간 것이면, 닿은 뒤로는 그 캐릭터를 따라간다.
        this.flight = selected ? { target: this.flight.target, distance: this.flight.distance } : null;
      }
    } else if (this.flight) {
      const k = 1 - Math.exp(-dt * 4.2);
      const offset = this.camera.position.clone().sub(this.controls.target);
      const distance = offset.length() + (this.flight.distance - offset.length()) * k;
      this.controls.target.lerp(this.flight.target, k);
      this.camera.position.copy(this.controls.target).addScaledVector(offset.normalize(), distance);
      if (!selected && this.controls.target.distanceTo(this.flight.target) < 0.02 && Math.abs(distance - this.flight.distance) < 0.05) this.flight = null;
    }

    // 패널이 열리고 닫히면 시야의 한가운데를 빈 자리 쪽으로 부드럽게 옮긴다.
    const wantShift = (this.inset.left - this.inset.right) / 2;
    if (Math.abs(wantShift - this.shiftX) > 0.25) {
      this.shiftX += (wantShift - this.shiftX) * (1 - Math.exp(-dt * 7));
      if (Math.abs(wantShift - this.shiftX) <= 0.25) this.shiftX = wantShift;
      this.applyShift();
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
