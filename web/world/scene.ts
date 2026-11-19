// 3D 장면: 렌더러·카메라·조작, 스냅샷을 배우들로 옮기는 일, 고르기.
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

import type { AgentView, WorldSnapshot } from "../../shared/types.ts";
import { beat } from "../beat.ts";
import { t } from "../i18n.ts";
import { Actor, PICK_LAYER } from "./actor.ts";
import { Environment, type Theme } from "./environment.ts";
import { labels } from "./labels.ts";
import { buildLayout, groupLots, lotsKey, shellSpot, type Layout, type Plot } from "./layout.ts";

export interface SceneCallbacks {
  onSelect(id: string | null): void;
  onHover(id: string | null): void;
  /** 집 문패를 눌렀다. */
  onPlot(workspaceId: string): void;
}

const FOG: Record<Theme, string> = { day: "#CBE7F6", night: "#161B33" };

/**
 * 한 프레임에 칠할 화소 수의 상한. 4K 창에서 화소마다 그림자를 계산하면 내장 그래픽이 버티지 못한다.
 * 그리는 시간을 보고 해상도를 오르내리던 조절은 걷어냈다: 그 시간은 화소 수가 아니라 다른 프로그램의 부하를 따라
 * 움직여서(배율 1.0·0.6 을 번갈아 재도 차이가 부하 변동에 묻혔다), 다른 일로 바쁠 때마다 화면만 흐려졌다가 3초마다
 * 한 단계씩 돌아오며 그때마다 캔버스가 비어 번쩍였다.
 */
const MAX_PIXELS = 3.6e6;
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
 * 한동안 손대지 않았거나 다른 창을 쓰는 중이면 "곁눈질 화면"이다 — 초당 3장으로 줄인다.
 * 일하는 캐릭터는 늘 일터 사이를 오가므로, 걷는 동안을 예외로 두면 이 단계에 들어갈 틈이 없다.
 * 실제 세션(4K 60Hz, 17명) 실측: 12장 20%, 6장 15%, 3장 11.5%, 1장 9.7% — 3장 밑으로는 얻는 것이 적다.
 * 333ms 는 로고 한 칸(240ms)보다 길어 로고는 장마다 한 칸씩 고르게 넘어간다.
 */
const AMBIENT_AFTER_MS = 20_000;
const AMBIENT_FRAME_MS = 333;
/** 한 장 사이에 흐르게 둘 시간의 상한(초). 곁눈질 화면의 간격보다 길어야 그 동안에도 캐릭터가 제 속도로 걷는다. */
const MAX_STEP_S = 0.4;
/** 고른 캐릭터가 가려졌을 때 돌아 볼 각도들(도). 덜 도는 쪽부터 본다. */
const VIEW_TURNS = [0, 25, -25, 50, -50, 80, -80, 115, -115, 150, -150, 180];
/** 캐릭터가 보이는지 확인하는 높이들 — 발치, 몸통, 머리. */
const VIEW_HEIGHTS = [0.35, 0.9, 1.4];
const UP = new THREE.Vector3(0, 1, 0);
/** 카메라가 옮겨 가는 데 쓰는 시간의 상한. 시정수 약 240ms 라 2초면 남은 거리가 천분의 일 아래다. */
const FLIGHT_MAX_MS = 5000;
/** 고른 뒤 이 안에 창이 열려 빈 자리가 달라지면 비추는 거리를 다시 잡는다. */
const RESTAGE_MS = 1200;
/** 집터 중심에서 마당 끝(대문 앞, 쉼터)까지의 거리 — 본채 기준. 별채는 Plot.scale 만큼 줄어든다. */
const YARD_REACH = 5;
/** 광장 한가운데에서 완료한 캐릭터들이 서는 바깥 고리까지. */
const PLAZA_REACH = 9;
/** 자리를 비출 때의 거리: 홀로 선 집(reach 5)이 21 — 문패를 눌러 집을 볼 때의 거리와 같다. */
const STAGE_BASE = 13.5;
/** 집터 전체를 한 화면에 담는 한계. 이보다 넓으면 고른 캐릭터의 집 하나만 비춘다. */
const LOT_REACH_MAX = 10;
const STAGE_PER_REACH = 1.5;
/** 작은 별채를 비출 때도 이보다 다가가지 않는다 — 이웃한 일터와 동거인이 같이 보이는 거리. */
const STAGE_MIN = 21;
/** 고른 것이 "이미 보인다"고 칠 때 빈 자리의 가장자리에서 떨어져 있어야 하는 거리(px)와 위쪽 막대 아래의 여유. */
const FREE_MARGIN = 56;
const FREE_TOP = 120;
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
  /** 지금 곁눈질 화면(초당 3장)으로 그리는 중이다. */
  private ambient = false;
  private readonly probe = new THREE.Vector3();
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
   * at 은 떠난 시각(performance.now). 옮겨 가는 양은 그 뒤에 흐른 시간만큼만 센다 — 아래 frame() 참고.
   */
  private flight: { target: THREE.Vector3; distance: number; position?: THREE.Vector3; at: number } | null = null;
  /** 무언가를 고르기 직전의 시점 — 고르기를 풀면 여기로 돌아간다. */
  private home: { target: THREE.Vector3; position: THREE.Vector3 } | null = null;
  private downAt: { x: number; y: number } | null = null;
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
  private readonly lastCamera = new THREE.Matrix4();
  /** 직전 프레임에 걸어가는 캐릭터가 있었는지. */
  private walking = false;
  /**
   * 화면 좌우를 덮고 있는 패널의 폭(px) — 목록과 상태 창. 장면의 한가운데가 창의 한가운데가 아니라 패널 사이
   * 빈 자리의 한가운데에 오도록 시야를 그만큼 옆으로 민다. 창이 좁을수록(화면 절반에 띄운 창) 차이가 크다.
   */
  private inset = { left: 0, right: 0, bottom: 0 };
  /** 지금 시야가 옆으로 밀려 있는 정도(px). inset 을 부드럽게 따라간다. */
  private shiftX = 0;
  /** 가운데 아래의 무대(터미널 화면)가 덮은 만큼 시야를 위로 올린 정도(px). */
  private shiftY = 0;

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
    el.addEventListener("pointerleave", (e) => e.pointerType !== "touch" && this.setHover(null));

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
    // 다른 창에서 돌아오면 다시 보기 시작한 것이다 — 곁눈질 화면의 긴 간격(333ms)을 기다리지 않고 바로 평소 박자로 올린다.
    window.addEventListener("focus", () => {
      this.lastSeenAt = performance.now();
      this.wake();
    });

    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    this.overview(false);
    requestAnimationFrame(this.tick);
  }

  /** 좌우 패널이 덮은 폭과 가운데 아래 무대가 덮은 높이를 알려 준다. 시야는 다음 프레임들에 걸쳐 부드럽게 옮겨 간다. */
  setInsets(left: number, right: number, bottom = 0): void {
    if (left === this.inset.left && right === this.inset.right && bottom === this.inset.bottom) return;
    this.inset = { left, right, bottom };
    if (this.layoutKey === null) {
      // 아직 아무것도 그리기 전이면 미끄러져 들어오지 않고 처음부터 제자리에서 시작한다.
      this.shiftX = (left - right) / 2;
      this.shiftY = bottom / 2;
      this.applyShift();
      return;
    }
    // 옮겨 가는 동안은 화면 전체가 움직인다 — 주사율 그대로 그린다.
    this.lastInputAt = performance.now();
    this.wake();
    // 고르면 상태 창과 무대가 한두 프레임 뒤에 열린다. 그 전의 빈 자리로 잰 거리로 떠났으면 열린 뒤의 자리로 고쳐 잡는다 —
    // 안 그러면 같은 집이 처음 고를 때와 다른 주민에서 옮겨 올 때 다른 크기로 보인다.
    if (this.selectedId && this.flight && performance.now() - this.flight.at < RESTAGE_MS && !this.selectedId.startsWith("ws:")) this.restage();
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
    if (Math.abs(this.shiftX) < 0.5 && Math.abs(this.shiftY) < 0.5) this.camera.clearViewOffset();
    else this.camera.setViewOffset(w, h, -this.shiftX, this.shiftY, w, h);
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

  /** 기기 화소 비율을 따르되, 한 프레임의 화소 수가 상한을 넘지 않게 한다. */
  private pixelRatio(w: number, h: number): number {
    const native = Math.min(window.devicePixelRatio, 2);
    return Math.min(native, Math.sqrt(MAX_PIXELS / (w * h)));
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
    // 집터의 구성(어느 스페이스가 어느 저장소의 본채·별채인지)이 바뀔 때만 무대를 다시 짓는다.
    const lots = groupLots(snapshot.workspaces);
    const key = lotsKey(lots);
    if (key !== this.layoutKey) {
      const first = this.layoutKey === null;
      this.layoutKey = key;
      this.layout = buildLayout(lots);
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
        const was = actor.view.status;
        const stage = view.id === this.selectedId && view.status !== was ? this.stageOf(actor) : null;
        actor.apply(view);
        // 고른 캐릭터가 다른 자리로 간다(광장의 완료가 일하러 집으로, 일을 마치고 광장으로). 떠나는 자리를 보고 있었으면
        // 가는 자리를 비춘다 — 따라가지 않아도 그리로 걸어 들어온다. 다른 데를 보고 있었으면 그대로 둔다.
        if (stage) {
          const next = this.stageOf(actor);
          const aim = this.flight?.target ?? this.controls.target;
          if (next.target.distanceTo(stage.target) > 0.5 && aim.distanceTo(stage.target) < stage.reach) {
            this.flight = { target: next.target, distance: next.distance, at: performance.now() };
            this.lastInputAt = performance.now();
            this.wake();
          }
        }
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

  /** 고른 에이전트를 표시하고, fly 면 카메라가 그 자리를 비춘다. 고른 것을 다시 고르면(다른 데를 보다가) 다시 비춘다. */
  select(id: string | null, fly = true): void {
    const before = this.selectedId;
    if (id === before && !(id && fly)) return;
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
        this.flight = { target: this.home.target, position: this.home.position, distance: this.home.position.distanceTo(this.home.target), at: performance.now() };
      }
      this.home = null;
    }
    for (const [actorId, actor] of this.actors) actor.selected = actorId === id;
    const actor = id ? this.actors.get(id) : undefined;
    if (id && fly) this.restage();
  }

  /** 고른 것이 있는 자리를 비춘다. */
  private restage(): void {
    const id = this.selectedId;
    if (!id) return;
    const actor = this.actors.get(id);
    const shell = this.shells.get(id);
    if (actor) this.showStage(this.stageOf(actor), actor);
    else if (shell) this.showStage(this.stageAt(this.plotNear(shell.position)), undefined, shell.position);
    else if (id.startsWith("ws:")) this.flyToPlot(id.slice(3));
  }

  /**
   * 고른 캐릭터가 있는(있게 될) 자리 — 그 집터 전체나 광장 — 와 그것이 다 들어오는 거리.
   *
   * 캐릭터 하나에 바짝 다가가지 않고 사는 곳을 비춘다. 한 사람만 크게 보이는 화면은 옆 창들이 이미 말하는 것을 되풀이할
   * 뿐이고, 고를 때마다 카메라가 섬을 가로질러 다가갔다 따라다녀 어지러웠다. 집터를 비추면 같은 집의 다른 주민을 골라도
   * 카메라는 그대로다. 걷는 중이면 가고 있는 곳을 비춘다 — 따라가지 않아도 캐릭터가 화면 안으로 걸어 들어온다.
   */
  private stageOf(actor: Actor): { target: THREE.Vector3; distance: number; reach: number } {
    const plot = actor.view.status === "done" ? undefined : this.layout.plots.get(actor.view.workspaceId);
    return this.stageAt(plot);
  }

  private stageAt(plot: Plot | undefined): { target: THREE.Vector3; distance: number; reach: number } {
    let target = new THREE.Vector3(0, 0.8, 0);
    // 광장의 바깥 고리까지.
    let reach = PLAZA_REACH;
    if (plot) {
      const span = (houses: readonly Plot[]): void => {
        target = houses.reduce((sum, house) => sum.add(house.center), new THREE.Vector3()).divideScalar(houses.length).setY(0.8);
        reach = Math.max(...houses.map((house) => house.center.distanceTo(target) + YARD_REACH * house.scale));
      };
      span(this.layout.lots.find((lot) => lot.houses.includes(plot))?.houses ?? [plot]);
      // 별채가 여럿 늘어선 집터는 다 담으면 캐릭터가 점이 된다 — 그때는 그 집만 비춘다.
      if (reach > LOT_REACH_MAX) span([plot]);
    }
    // 패널과 무대에 덮이지 않은 자리가 좁을수록 같은 것을 담으려면 더 물러서야 한다.
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    const free = Math.min((w - this.inset.left - this.inset.right) / w / 0.5, (h - this.inset.bottom) / h / 0.7);
    const distance = Math.max(STAGE_MIN, STAGE_BASE + reach * STAGE_PER_REACH) / Math.min(1, Math.max(free, 0.55));
    return { target, distance: Math.min(distance, this.controls.maxDistance), reach };
  }

  private plotNear(at: THREE.Vector3): Plot | undefined {
    let best: Plot | undefined;
    for (const plot of this.layout.plots.values()) if (!best || plot.center.distanceTo(at) < best.center.distanceTo(at)) best = plot;
    return best;
  }

  /** 이 자리가 패널과 무대에 덮이지 않은 화면 안쪽에 보이는가. */
  private inFreeView(at: THREE.Vector3): boolean {
    const p = this.probe.copy(at).setY(0.9).project(this.camera);
    if (p.z > 1) return false;
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    const x = (p.x * 0.5 + 0.5) * w;
    const y = (0.5 - p.y * 0.5) * h;
    return x > this.inset.left + FREE_MARGIN && x < w - this.inset.right - FREE_MARGIN && y > FREE_TOP && y < h - this.inset.bottom - FREE_MARGIN;
  }

  /**
   * 자리를 비춘다. 이미 그 자리를 보고 있고 고른 것이 가려지지 않았으면 카메라를 움직이지 않는다.
   * 무대(터미널 화면)가 열리며 시야가 위로 올라가는 중이면 그 뒤의 자리로 따진다 — 지금은 보여도 곧 무대 밑으로 들어간다.
   */
  private showStage(stage: { target: THREE.Vector3; distance: number; reach: number }, actor?: Actor, at: THREE.Vector3 = actor!.group.position): void {
    const now = performance.now();
    // 같은 자리로 가는 중이면 가던 길을 그대로 간다. 그새 창이 열려 빈 자리가 달라졌으면 거리만 고친다.
    if (this.flight && this.flight.target.distanceTo(stage.target) < 0.5) {
      this.flight.position?.sub(this.flight.target).setLength(stage.distance).add(this.flight.target);
      this.flight.distance = stage.distance;
      return;
    }
    const distance = this.distance();
    const settled = Math.abs(this.shiftY - this.inset.bottom / 2) < 1 && Math.abs(this.shiftX - (this.inset.left - this.inset.right) / 2) < 1;
    const here = !this.flight && settled && this.controls.target.distanceTo(stage.target) < stage.reach && distance <= stage.distance * 1.35 && this.inFreeView(at);
    if (here) {
      const position = actor ? this.clearView(actor, this.controls.target, distance) : undefined;
      if (position) this.flight = { target: this.controls.target.clone(), distance, position, at: now };
      return;
    }
    this.flight = { target: stage.target, distance: stage.distance, position: actor ? this.clearView(actor, stage.target, stage.distance) : undefined, at: now };
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
      this.flight = { target, distance, position, at: performance.now() };
      return;
    }
    this.controls.target.copy(target);
    this.camera.position.copy(position);
    this.controls.update();
  }

  private flyToPlot(workspaceId: string): void {
    const plot = this.layout.plots.get(workspaceId);
    if (plot) this.flight = { target: plot.center.clone().setY(0.8), distance: 21, at: performance.now() };
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
    if (e.buttons !== 0 || e.pointerType === "touch") return;
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
    this.clock.getDelta(); // 덮여 있던 동안은 흐르지 않은 것으로 친다 — 걷히는 순간 캐릭터가 건너뛰지 않게.
    requestAnimationFrame(this.tick);
  }

  /**
   * 지금 몇 ms 간격으로 그릴지: 조작 중 0(주사율 그대로), 가만히 두면 30장쯤, 곁눈질 화면이면 3장.
   * 카메라가 옮겨 가는 중(flight)이면 조작 중이다 — 닿으면 flight 는 지워진다.
   */
  private pace(now: number): number {
    if (this.flight !== null || now - this.lastInputAt < ACTIVE_MS || now < this.easeUntil) return 0;
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
    // 곁눈질 화면에서는 이름표가 비켜 서는 transition 을 끈다(스타일시트의 body[data-ambient]). 장면은 초당 3장으로 끊어
    // 그리는데 transition 은 0.18초 동안 화면 박자마다 한 장씩 내보내, 걷는 캐릭터의 이름표가 한 번 비켜 설 때마다 11장이 더 나갔다.
    if ((pace === AMBIENT_FRAME_MS) !== this.ambient) {
      this.ambient = !this.ambient;
      document.body.toggleAttribute("data-ambient", this.ambient);
    }
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
    // 간격을 화면 박자의 배수로 올림한다: 60Hz 에서 24ms → 두 박자(30장), 333ms → 스무 박자(3장).
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

    const dt = Math.min(this.clock.getDelta(), MAX_STEP_S);
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

    // 카메라는 고른 캐릭터를 따라다니지 않는다 — 그 캐릭터가 사는 자리를 비추고(showStage) 닿으면 멈춘다.
    // 카메라가 옮겨 가는 양은 떠난 뒤에 흐른 시간으로만 센다. 곁눈질 화면(초당 3장)에서 상태가 바뀌어 떠나면 첫 장의
    // dt 는 쉬던 동안(최대 MAX_STEP_S)이라, 그대로 쓰면 한 장에 80% 를 건너뛰어 화면이 번쩍 바뀐다. 캐릭터는 dt 그대로 걷는다.
    // 닿지 못하는 목표(조작 한계에 걸린 거리 등)를 붙들고 주사율대로 그리기를 이어 가지 않는다.
    if (this.flight && now - this.flight.at > FLIGHT_MAX_MS) this.flight = null;
    const flown = this.flight ? Math.min(dt, Math.max(0, now - this.flight.at) / 1000) : 0;
    if (this.flight?.position) {
      const k = 1 - Math.exp(-flown * 4.2);
      this.controls.target.lerp(this.flight.target, k);
      this.camera.position.lerp(this.flight.position, k);
      if (this.camera.position.distanceTo(this.flight.position) < 0.03) this.flight = null;
    } else if (this.flight) {
      const k = 1 - Math.exp(-flown * 4.2);
      const offset = this.camera.position.clone().sub(this.controls.target);
      const distance = offset.length() + (this.flight.distance - offset.length()) * k;
      this.controls.target.lerp(this.flight.target, k);
      this.camera.position.copy(this.controls.target).addScaledVector(offset.normalize(), distance);
      if (this.controls.target.distanceTo(this.flight.target) < 0.02 && Math.abs(distance - this.flight.distance) < 0.05) this.flight = null;
    }

    // 패널이 열리고 닫히면 시야의 한가운데를 빈 자리 쪽으로 부드럽게 옮긴다.
    const wantShift = (this.inset.left - this.inset.right) / 2;
    const wantLift = this.inset.bottom / 2;
    if (Math.abs(wantShift - this.shiftX) > 0.25 || Math.abs(wantLift - this.shiftY) > 0.25) {
      const k = 1 - Math.exp(-dt * 7);
      this.shiftX += (wantShift - this.shiftX) * k;
      this.shiftY += (wantLift - this.shiftY) * k;
      if (Math.abs(wantShift - this.shiftX) <= 0.25) this.shiftX = wantShift;
      if (Math.abs(wantLift - this.shiftY) <= 0.25) this.shiftY = wantLift;
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
    this.renderer.render(this.scene, this.camera);
    // 이름표(DOM)는 카메라나 캐릭터가 움직였을 때만 다시 놓는다. 가만히 있는 동안 매 프레임 위치와 겹침 순서를
    // 다시 쓰면 그리는 것보다 스타일 계산이 더 든다.
    const cameraMoved = !this.lastCamera.equals(this.camera.matrixWorld);
    if (cameraMoved || this.walking || this.labelsDirty > 0 || this.labels.dirty) {
      // 자세한 모습으로 돌아가려고 기다리는 이름표가 있으면 다음 프레임에도 본다.
      if (this.labels.update(this.camera, now)) this.labelsDirty = Math.max(this.labelsDirty, 1);
      else if (this.labelsDirty > 0) this.labelsDirty -= 1;
      this.lastCamera.copy(this.camera.matrixWorld);
    }
  }
}
