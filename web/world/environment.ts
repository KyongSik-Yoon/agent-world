// 섬, 광장, 집터, 나무와 구름 — 배우들이 서는 무대.
import * as THREE from "three";

import type { WorkspaceView } from "../../shared/types.ts";
import { labels } from "./labels.ts";
import { PLAZA_RADIUS, type Layout, type Plot } from "./layout.ts";

export type Theme = "day" | "night";

/**
 * 잔디(0) 위에 겹쳐 까는 평평한 층들의 높이.
 *
 * 색이 다른 층이 겹치는 곳은 층마다 높이가 달라야 하고, 그 차이는 가장 멀리서 볼 때의 깊이 정밀도
 * (거리 130 에서 약 0.002)보다 넉넉해야 한다. 모자라면 겹친 자리가 카메라를 움직일 때마다 줄무늬로 깜빡인다.
 */
const GROUND_STEP = 0.008;
const GROUND = { step: GROUND_STEP, patch: GROUND_STEP, patchLight: GROUND_STEP * 2, path: GROUND_STEP * 3, yard: GROUND_STEP * 4 };
/** 광장 바닥돌의 윗면. */
const PLAZA_TOP = 0.13;

/** 결정적 난수 — 새로 고쳐도 나무가 같은 자리에 선다. */
function mulberry(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 여러 메시를 꼭짓점 배열 하나로 합친다. 행렬은 합쳐질 메시가 놓일 좌표계 기준이다. */
function mergeParts(parts: ReadonlyArray<{ geo: THREE.BufferGeometry; matrix: THREE.Matrix4 }>): { geometry: THREE.BufferGeometry; counts: number[] } {
  const flat = parts.map((p) => (p.geo.index ? p.geo.toNonIndexed() : p.geo));
  const counts = flat.map((g) => g.getAttribute("position").count);
  const total = counts.reduce((a, b) => a + b, 0);
  const position = new Float32Array(total * 3);
  const normal = new Float32Array(total * 3);
  const v = new THREE.Vector3();
  const normalMatrix = new THREE.Matrix3();
  let at = 0;
  flat.forEach((g, i) => {
    const pos = g.getAttribute("position");
    const nor = g.getAttribute("normal");
    const matrix = parts[i]!.matrix;
    normalMatrix.getNormalMatrix(matrix);
    for (let k = 0; k < pos.count; k += 1) {
      v.fromBufferAttribute(pos, k).applyMatrix4(matrix).toArray(position, (at + k) * 3);
      if (nor) v.fromBufferAttribute(nor, k).applyMatrix3(normalMatrix).normalize().toArray(normal, (at + k) * 3);
    }
    at += pos.count;
    if (g !== parts[i]!.geo) g.dispose();
  });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(position, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(normal, 3));
  return { geometry, counts };
}

interface Themed {
  mat: THREE.MeshStandardMaterial;
  day: THREE.Color;
  night: THREE.Color;
  /** 밤에만 켜지는 불빛 세기(창문, 등불). */
  glow?: number;
}

/** 문패가 기둥에 걸리는 자리: 가운데, 오른쪽으로 내어 걸기, 왼쪽으로 내어 걸기. */
const SIGN_SHIFTS = [0, 0.5, -0.5] as const;

export class Environment {
  readonly group = new THREE.Group();
  readonly sun = new THREE.DirectionalLight("#FFF1D6", 2.6);
  readonly sky = new THREE.HemisphereLight("#CFE6FF", "#7FA36B", 1.15);
  readonly plazaLight = new THREE.PointLight("#FFD9A0", 0, 26, 1.6);
  /** 광장 한가운데의 수정. 기다리는 에이전트가 있으면 그 색으로 빛난다. */
  readonly crystal: THREE.Mesh;
  readonly crystalMat: THREE.MeshStandardMaterial;

  private themed: Themed[] = [];
  /** 합친 메시의 꼭짓점 색 구간 — 낮/밤이 바뀌면 이 구간들을 다시 칠한다. */
  private ranges: Array<{ attr: THREE.BufferAttribute; start: number; count: number; day: THREE.Color; night: THREE.Color }> = [];
  /** 합친 메시 가운데 밤에 빛나는 것(창문, 등불)의 재질. */
  private glows: Array<{ mat: THREE.MeshStandardMaterial; glow: number }> = [];
  private readonly staticGroup = new THREE.Group();
  private plotGroup = new THREE.Group();
  private readonly clouds: THREE.Group[] = [];
  private readonly signs = new Map<string, HTMLElement>();
  private theme: Theme = "day";
  private islandRadius = 0;

  constructor(private readonly onPlotClick: (workspaceId: string) => void) {
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.03;
    this.group.add(this.sun, this.sun.target, this.sky, this.plazaLight, this.staticGroup, this.plotGroup);
    this.plazaLight.position.set(0, 3.4, 0);

    this.crystalMat = new THREE.MeshStandardMaterial({ color: "#DCEBFF", emissive: "#7FB2FF", emissiveIntensity: 0.4, roughness: 0.2, flatShading: true });
    this.crystal = new THREE.Mesh(new THREE.OctahedronGeometry(0.55, 0), this.crystalMat);
    this.crystal.position.y = 3.5;
    this.crystal.castShadow = true;
  }

  private mat(day: string, night: string, opts: THREE.MeshStandardMaterialParameters & { glow?: number } = {}): THREE.MeshStandardMaterial {
    const { glow, ...rest } = opts;
    const mat = new THREE.MeshStandardMaterial({ color: day, roughness: 0.92, flatShading: true, ...rest });
    this.themed.push({ mat, day: new THREE.Color(day), night: new THREE.Color(night), glow });
    return mat;
  }

  private mesh(geo: THREE.BufferGeometry, mat: THREE.Material, parent: THREE.Object3D, opts: { cast?: boolean; receive?: boolean } = {}): THREE.Mesh {
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = opts.cast ?? true;
    mesh.receiveShadow = opts.receive ?? false;
    parent.add(mesh);
    return mesh;
  }

  /** 배치가 바뀌면(워크스페이스가 늘거나 줄면) 무대를 다시 짓는다. */
  rebuild(layout: Layout, workspaces: readonly WorkspaceView[]): void {
    this.disposeTree(this.staticGroup);
    this.disposeTree(this.plotGroup);
    this.themed = [];
    this.ranges = [];
    for (const g of this.glows) g.mat.dispose();
    this.glows = [];
    this.clouds.length = 0;
    this.signs.clear();
    this.islandRadius = layout.islandRadius;

    this.buildIsland(layout);
    this.buildPlaza();
    for (const ws of workspaces) {
      const plot = layout.plots.get(ws.id);
      if (plot) this.buildPlot(plot, ws);
    }
    this.buildNature(layout);
    this.batch();

    const reach = layout.islandRadius + 4;
    const cam = this.sun.shadow.camera;
    cam.left = cam.bottom = -reach;
    cam.right = cam.top = reach;
    cam.near = 1;
    cam.far = reach * 4;
    cam.updateProjectionMatrix();
    this.sun.position.set(reach * 0.75, reach * 1.25, reach * 0.55);
    this.setTheme(this.theme);
  }

  /**
   * 움직이지 않는 것들(땅, 집, 나무, 바위 …)을 몇 개의 메시로 합친다.
   *
   * 하나하나가 그리기 호출이라, 집과 나무가 늘수록 한 프레임에 수백 번을 부르게 된다(그림자까지 두 번씩).
   * 그림자 설정과 재질 성질이 같은 것끼리 꼭짓점을 모으고, 색은 꼭짓점마다 칠해 재질 하나로 그린다.
   */
  private batch(): void {
    this.group.updateMatrixWorld(true);
    const toLocal = this.staticGroup.matrixWorld.clone().invert();
    const moving = new Set<THREE.Object3D>();
    for (const cloud of this.clouds) cloud.traverse((o) => moving.add(o));
    const themedOf = new Map(this.themed.map((t) => [t.mat as THREE.Material, t]));

    interface Part {
      mesh: THREE.Mesh;
      themed: Themed;
    }
    const buckets = new Map<string, Part[]>();
    for (const root of [this.staticGroup, this.plotGroup]) {
      root.traverse((o) => {
        if (!(o instanceof THREE.Mesh) || o === this.crystal || moving.has(o) || Array.isArray(o.material)) return;
        const themed = themedOf.get(o.material);
        if (!themed) return;
        const m = themed.mat;
        const key = [o.castShadow, o.receiveShadow, m.roughness, m.metalness, m.flatShading, m.transparent, m.opacity, m.side, m.emissive.getHex(), themed.glow ?? ""].join("|");
        const list = buckets.get(key);
        if (list) list.push({ mesh: o, themed });
        else buckets.set(key, [{ mesh: o, themed }]);
      });
    }

    const gone = new Set<THREE.Material>();
    for (const parts of buckets.values()) {
      const first = parts[0]!;
      const { geometry, counts } = mergeParts(parts.map((p) => ({ geo: p.mesh.geometry, matrix: new THREE.Matrix4().multiplyMatrices(toLocal, p.mesh.matrixWorld) })));
      const color = new THREE.BufferAttribute(new Float32Array(geometry.getAttribute("position").count * 3), 3);
      geometry.setAttribute("color", color);
      let start = 0;
      parts.forEach((p, i) => {
        this.ranges.push({ attr: color, start, count: counts[i]!, day: p.themed.day, night: p.themed.night });
        start += counts[i]!;
        p.mesh.removeFromParent();
        p.mesh.geometry.dispose();
        gone.add(p.themed.mat);
      });
      const src = first.themed.mat;
      const mat = new THREE.MeshStandardMaterial({
        vertexColors: true,
        roughness: src.roughness,
        metalness: src.metalness,
        flatShading: src.flatShading,
        transparent: src.transparent,
        opacity: src.opacity,
        side: src.side,
        emissive: src.emissive.clone(),
        emissiveIntensity: src.emissiveIntensity,
      });
      if (first.themed.glow !== undefined) this.glows.push({ mat, glow: first.themed.glow });
      const merged = new THREE.Mesh(geometry, mat);
      merged.castShadow = first.mesh.castShadow;
      merged.receiveShadow = first.mesh.receiveShadow;
      this.staticGroup.add(merged);
    }
    // 합쳐져 더는 쓰이지 않는 재질은 치운다. 남은 것(구름 등)만 재질 색으로 테마를 따른다.
    this.themed = this.themed.filter((t) => !gone.has(t.mat));
    for (const mat of gone) mat.dispose();
  }

  private disposeTree(root: THREE.Object3D): void {
    root.traverse((o) => {
      if (o.userData.label instanceof HTMLElement) labels.detach(o.userData.label);
      if (o instanceof THREE.Mesh && o !== this.crystal) {
        o.geometry.dispose();
        // 합친 메시의 재질은 여기서만 쓰인다(테마 목록의 재질은 rebuild 가 목록째 버린다).
        if (o.material instanceof THREE.MeshStandardMaterial && o.material.vertexColors) o.material.dispose();
      }
    });
    root.clear();
  }

  private buildIsland(layout: Layout): void {
    const R = layout.islandRadius;
    const grass = this.mat("#8CCB6B", "#2F5A55");
    const top = this.mesh(new THREE.CylinderGeometry(R, R - 0.6, 0.7, 72), grass, this.staticGroup, { cast: false, receive: true });
    top.position.y = -0.35;
    const cliff = this.mesh(new THREE.CylinderGeometry(R - 0.6, R * 0.62, 5, 24), this.mat("#B08B62", "#3A3148"), this.staticGroup, { cast: false });
    cliff.position.y = -3.2;
    const under = this.mesh(new THREE.ConeGeometry(R * 0.62, 7, 12), this.mat("#8E6E50", "#2C2638"), this.staticGroup, { cast: false });
    under.position.y = -9.2;
    under.rotation.x = Math.PI;

    // 잔디 얼룩 — 넓은 평면이 밋밋해 보이지 않게.
    // 색이 다른 얼룩끼리는 높이를 달리한다. 같은 높이에서 겹치면 어느 쪽이 앞인지가 화소마다 갈려, 카메라를 움직일 때 깜빡인다.
    const rng = mulberry(7);
    const patchMat = this.mat("#7CBF5C", "#2A524E");
    const patchMat2 = this.mat("#9DD67B", "#36645C");
    for (let i = 0; i < 46; i += 1) {
      const r = Math.sqrt(rng()) * (R - 2.5);
      const a = rng() * Math.PI * 2;
      const patch = this.mesh(new THREE.CircleGeometry(0.9 + rng() * 2.2, 9), i % 2 ? patchMat : patchMat2, this.staticGroup, { cast: false, receive: true });
      patch.rotation.x = -Math.PI / 2;
      patch.position.set(Math.cos(a) * r, i % 2 ? GROUND.patch : GROUND.patchLight, Math.sin(a) * r);
    }
  }

  private buildPlaza(): void {
    const g = this.staticGroup;
    const stone = this.mat("#E8DFCF", "#55506B");
    const stoneDark = this.mat("#CFC3AE", "#454059");
    const base = this.mesh(new THREE.CylinderGeometry(PLAZA_RADIUS, PLAZA_RADIUS + 0.25, 0.16, 48), stone, g, { cast: false, receive: true });
    base.position.y = PLAZA_TOP - 0.08;
    for (const [inner, outer] of [
      [2.3, 2.55],
      [4.9, 5.1],
      [7.1, 7.3],
    ] as const) {
      const ring = this.mesh(new THREE.RingGeometry(inner, outer, 48), stoneDark, g, { cast: false, receive: true });
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = PLAZA_TOP + GROUND.step;
    }
    // 가운데 기단과 수정.
    const plinth = this.mesh(new THREE.CylinderGeometry(0.95, 1.2, 0.5, 8), stoneDark, g, { receive: true });
    plinth.position.y = 0.38;
    const pillar = this.mesh(new THREE.CylinderGeometry(0.34, 0.5, 2.1, 6), stone, g);
    pillar.position.y = 1.68;
    const cup = this.mesh(new THREE.CylinderGeometry(0.62, 0.36, 0.22, 6), stoneDark, g);
    cup.position.y = 2.82;
    g.add(this.crystal);
  }

  private buildPlot(plot: Plot, ws: WorkspaceView): void {
    const g = new THREE.Group();
    g.position.copy(plot.center);
    g.rotation.y = plot.facing;
    this.plotGroup.add(g);
    // 이 그룹 안에서는 -z 가 집 뒤(섬 바깥), +z 가 광장 쪽이다.

    const roofDay = new THREE.Color().setHSL(plot.hue, 0.62, 0.56);
    const roofNight = new THREE.Color().setHSL(plot.hue, 0.45, 0.3);
    const roofMat = this.mat(`#${roofDay.getHexString()}`, `#${roofNight.getHexString()}`);
    const wall = this.mat("#FBF3E4", "#8A85A6");
    const wood = this.mat("#A9794F", "#4B3B45");
    const woodDark = this.mat("#7F5738", "#392C38");

    // 마당.
    const yard = this.mesh(new THREE.CircleGeometry(3.5, 20), this.mat("#DCCB9C", "#565470"), g, { cast: false, receive: true });
    yard.rotation.x = -Math.PI / 2;
    yard.position.set(0, GROUND.yard, 0.5);

    // 집.
    const house = new THREE.Group();
    house.position.set(0, 0, -2.7);
    g.add(house);
    const walls = this.mesh(new THREE.BoxGeometry(2.7, 1.7, 2.1), wall, house, { receive: true });
    walls.position.y = 0.85;
    const roof = this.mesh(new THREE.ConeGeometry(2.25, 1.35, 4), roofMat, house);
    roof.position.y = 2.37;
    roof.rotation.y = Math.PI / 4;
    roof.scale.set(1, 1, 0.82);
    const chimney = this.mesh(new THREE.BoxGeometry(0.32, 0.8, 0.32), woodDark, house);
    chimney.position.set(0.75, 2.5, -0.2);
    const door = this.mesh(new THREE.BoxGeometry(0.56, 1.02, 0.08), woodDark, house, { cast: false });
    door.position.set(-0.55, 0.51, 1.07);
    const windowMat = this.mat("#9FD3F2", "#FFD98A", { emissive: "#FFC867", emissiveIntensity: 0, glow: 1.5, roughness: 0.3 });
    const win = this.mesh(new THREE.BoxGeometry(0.72, 0.62, 0.08), windowMat, house, { cast: false });
    win.position.set(0.55, 1.0, 1.07);
    const sideWin = this.mesh(new THREE.BoxGeometry(0.08, 0.56, 0.62), windowMat, house, { cast: false });
    sideWin.position.set(1.36, 1.0, 0);
    const sideWin2 = sideWin.clone();
    sideWin2.position.x = -1.36;
    house.add(sideWin2);

    // 작업대(일하는 에이전트가 망치질하는 곳)와 상자.
    const bench = new THREE.Group();
    bench.position.set(-2.55, 0, 0.25);
    g.add(bench);
    const benchTop = this.mesh(new THREE.BoxGeometry(0.6, 0.12, 1.2), wood, bench, { receive: true });
    benchTop.position.y = 0.62;
    for (const z of [-0.48, 0.48]) {
      const leg = this.mesh(new THREE.BoxGeometry(0.5, 0.56, 0.1), woodDark, bench);
      leg.position.set(0, 0.28, z);
    }
    const anvil = this.mesh(new THREE.BoxGeometry(0.26, 0.2, 0.42), this.mat("#6B7385", "#3B4050", { roughness: 0.5 }), bench);
    anvil.position.set(0, 0.78, 0.1);
    const crate = this.mesh(new THREE.BoxGeometry(0.55, 0.55, 0.55), wood, g);
    crate.position.set(-2.5, 0.275, -1.1);
    crate.rotation.y = 0.4;

    // 텃밭.
    const soil = this.mesh(new THREE.BoxGeometry(1.5, 0.14, 1.1), this.mat("#8A6444", "#3A2E3A"), g, { cast: false, receive: true });
    soil.position.set(2.3, 0.07, 1.3);
    const sprout = this.mat("#58B368", "#2F6B58");
    for (let i = 0; i < 6; i += 1) {
      const leaf = this.mesh(new THREE.ConeGeometry(0.11, 0.3, 5), sprout, g);
      leaf.position.set(1.8 + (i % 3) * 0.5, 0.29, 1.05 + Math.floor(i / 3) * 0.5);
    }

    // 등불.
    const lampPost = this.mesh(new THREE.CylinderGeometry(0.05, 0.07, 1.5, 6), woodDark, g);
    lampPost.position.set(1.7, 0.75, 3.3);
    const lamp = this.mesh(
      new THREE.SphereGeometry(0.17, 10, 8),
      this.mat("#FFF4D2", "#FFE2A3", { emissive: "#FFC867", emissiveIntensity: 0, glow: 2.4, flatShading: false }),
      g,
      { cast: false },
    );
    lamp.position.set(1.7, 1.6, 3.3);

    // 광장으로 이어지는 길.
    const pathLen = plot.center.length() - PLAZA_RADIUS - 3.2;
    const path = this.mesh(new THREE.PlaneGeometry(1.5, pathLen), this.mat("#E3D6B4", "#5F5C78"), g, { cast: false, receive: true });
    path.rotation.x = -Math.PI / 2;
    path.position.set(0, GROUND.path, 3.4 + pathLen / 2);

    // 문패.
    const post = this.mesh(new THREE.BoxGeometry(0.1, 1.1, 0.1), woodDark, g);
    post.position.set(-1.6, 0.55, 3.3);
    const el = document.createElement("button");
    el.type = "button";
    el.className = "plot-sign";
    el.style.setProperty("--hue", String(Math.round(plot.hue * 360)));
    el.addEventListener("click", () => this.onPlotClick(ws.id));
    const sign = new THREE.Object3D();
    sign.position.set(-1.6, 1.25, 3.3);
    sign.userData.label = el;
    g.add(sign);
    // 문패는 줄어들지 않는다. 일하거나 쉬는 에이전트의 이름표가 문패를 덮지 않고 비켜 간다.
    const size: [number, number] = [96, 22];
    labels.attach({ el, anchor: sign, order: ws.id, rank: () => 1, sizes: () => [size], shifts: SIGN_SHIFTS });
    labels.measure(el, (w, h) => {
      size[0] = w;
      size[1] = h;
    });
    this.signs.set(ws.id, el);
    this.labelSign(ws);
  }

  /** 문패 글자를 갱신한다(워크스페이스 이름이 바뀌거나 herdr 의 초점이 옮겨 갔을 때). */
  labelSign(ws: WorkspaceView): void {
    const el = this.signs.get(ws.id);
    if (!el) return;
    el.textContent = ws.number ? `${ws.number} · ${ws.label}` : ws.label;
    el.classList.toggle("focused", ws.focused);
    el.title = ws.topic ? `${ws.label} — ${ws.topic}` : ws.label;
  }

  private buildNature(layout: Layout): void {
    const g = this.staticGroup;
    const rng = mulberry(layout.plots.size * 131 + 5);
    const trunk = this.mat("#8B6243", "#3A2D38");
    const leaves = [this.mat("#4FA65B", "#28625A"), this.mat("#6DBB5F", "#327060"), this.mat("#3F9467", "#245859")];
    const rock = this.mat("#AEB3BD", "#4A4D62");
    const plots = [...layout.plots.values()];
    const free = (x: number, z: number): boolean => {
      const r = Math.hypot(x, z);
      if (r < PLAZA_RADIUS + 1.6 || r > layout.islandRadius - 1.2) return false;
      for (const p of plots) {
        if (Math.hypot(x - p.center.x, z - p.center.z) < 5.4) return false;
        // 집터와 광장을 잇는 길 위에도 심지 않는다.
        const along = x * p.out.x + z * p.out.z;
        const across = Math.abs(x * p.side.x + z * p.side.z);
        if (along > 0 && along < layout.ringRadius && across < 1.5) return false;
      }
      return true;
    };
    let placed = 0;
    for (let tries = 0; tries < 900 && placed < 70; tries += 1) {
      const r = PLAZA_RADIUS + rng() * (layout.islandRadius - PLAZA_RADIUS);
      const a = rng() * Math.PI * 2;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      if (!free(x, z)) continue;
      placed += 1;
      if (rng() < 0.2) {
        const stone = this.mesh(new THREE.DodecahedronGeometry(0.3 + rng() * 0.4, 0), rock, g, { receive: true });
        stone.position.set(x, 0.18, z);
        stone.rotation.set(rng() * 3, rng() * 3, rng() * 3);
        continue;
      }
      const tree = new THREE.Group();
      const s = 0.8 + rng() * 0.75;
      tree.position.set(x, 0, z);
      tree.scale.setScalar(s);
      g.add(tree);
      const stem = this.mesh(new THREE.CylinderGeometry(0.14, 0.2, 0.9, 6), trunk, tree);
      stem.position.y = 0.45;
      const leaf = leaves[Math.floor(rng() * leaves.length)]!;
      if (rng() < 0.55) {
        for (let k = 0; k < 3; k += 1) {
          const cone = this.mesh(new THREE.ConeGeometry(0.95 - k * 0.22, 1.1, 7), leaf, tree);
          cone.position.y = 1.2 + k * 0.62;
        }
      } else {
        const crown = this.mesh(new THREE.IcosahedronGeometry(0.95, 0), leaf, tree);
        crown.position.y = 1.65;
        crown.rotation.set(rng(), rng(), rng());
      }
    }

    // 구름: 섬을 둘러싼 운해. 카메라와 마을 사이를 가리지 않게 지면보다 낮게 깐다.
    const cloudMat = this.mat("#FFFFFF", "#6F7396", { roughness: 1, transparent: true, opacity: 0.92 });
    for (let i = 0; i < 16; i += 1) {
      const cloud = new THREE.Group();
      const puffs = 3 + Math.floor(rng() * 3);
      // 구름 한 덩이는 송이 여럿이지만 함께 움직이므로 메시 하나로 합쳐 그린다.
      const parts: Array<{ geo: THREE.BufferGeometry; matrix: THREE.Matrix4 }> = [];
      for (let k = 0; k < puffs; k += 1) {
        const geo = new THREE.IcosahedronGeometry(1.6 + rng() * 1.5, 1);
        const at = new THREE.Vector3(k * 2.1 - puffs * 1.05, rng() * 0.7, rng() * 1.8);
        parts.push({ geo, matrix: new THREE.Matrix4().compose(at, new THREE.Quaternion(), new THREE.Vector3(1, 0.55, 1)) });
      }
      this.mesh(mergeParts(parts).geometry, cloudMat, cloud, { cast: false });
      for (const part of parts) part.geo.dispose();
      cloud.userData.radius = layout.islandRadius * (1.12 + rng() * 0.75);
      cloud.userData.angle = (i / 16) * Math.PI * 2 + rng() * 0.3;
      cloud.userData.speed = 0.006 + rng() * 0.01;
      cloud.position.y = -7.5 + rng() * 5;
      g.add(cloud);
      this.clouds.push(cloud);
    }
  }

  setTheme(theme: Theme): void {
    this.theme = theme;
    const night = theme === "night";
    for (const t of this.themed) {
      t.mat.color.copy(night ? t.night : t.day);
      if (t.glow !== undefined) t.mat.emissiveIntensity = night ? t.glow : 0;
    }
    const touched = new Set<THREE.BufferAttribute>();
    for (const r of this.ranges) {
      const c = night ? r.night : r.day;
      const data = r.attr.array as Float32Array;
      for (let i = r.start * 3, end = (r.start + r.count) * 3; i < end; i += 3) {
        data[i] = c.r;
        data[i + 1] = c.g;
        data[i + 2] = c.b;
      }
      touched.add(r.attr);
    }
    for (const attr of touched) attr.needsUpdate = true;
    for (const g of this.glows) g.mat.emissiveIntensity = night ? g.glow : 0;
    this.sun.color.set(night ? "#B4C6FF" : "#FFF1D6");
    this.sun.intensity = night ? 1.9 : 2.6;
    this.sky.color.set(night ? "#7083D6" : "#CFE6FF");
    this.sky.groundColor.set(night ? "#2C3760" : "#7FA36B");
    this.sky.intensity = night ? 1.9 : 1.15;
    this.plazaLight.intensity = night ? 30 : 0;
  }

  /** 광장 수정의 색: 확인 필요가 있으면 빨강, 완료가 기다리면 초록, 아니면 차분한 파랑. */
  setSignal(blocked: number, done: number): void {
    const color = blocked > 0 ? "#FF5D7A" : done > 0 ? "#4BE38F" : "#7FB2FF";
    this.crystalMat.emissive.set(color);
    this.crystal.userData.urgent = blocked > 0 ? 2 : done > 0 ? 1 : 0;
  }

  update(t: number, dt: number): void {
    const urgent = (this.crystal.userData.urgent as number | undefined) ?? 0;
    this.crystal.rotation.y = t * (0.5 + urgent * 0.5);
    this.crystal.position.y = 3.5 + Math.sin(t * 1.6) * 0.12;
    this.crystalMat.emissiveIntensity = urgent === 0 ? 0.45 : 1.2 + Math.sin(t * (urgent === 2 ? 7 : 3.2)) * 0.8;
    for (const cloud of this.clouds) {
      cloud.userData.angle = (cloud.userData.angle as number) + (cloud.userData.speed as number) * dt;
      const r = cloud.userData.radius as number;
      cloud.position.x = Math.cos(cloud.userData.angle as number) * r;
      cloud.position.z = Math.sin(cloud.userData.angle as number) * r;
    }
    void this.islandRadius;
  }
}
