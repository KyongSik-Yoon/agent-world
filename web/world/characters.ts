// 벤더별 캐릭터 모델.
//
// Claude 의 Clawd 와 Antigravity 의 아치는 직접 그린 상태줄 로고(SVG)의 실루엣을 그대로 3D 로 옮긴
// 것이다 — Clawd 는 같은 42×42 격자의 몸통·팔·다리 4개를 상자로, AGY 는 같은 아치 경로를 압출해서.
// (Collie 의 것이 아니다. Collie 에서 온 것은 brands.ts 의 브랜드 글리프와 색뿐이다.)
// 그 밖의 벤더는 브랜드 마크를 얼굴에 띄운 로봇이 된다.
import * as THREE from "three";
import { SVGLoader } from "three/addons/loaders/SVGLoader.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

import { brandFor, brandKey, claudeTier, type Brand, type ClaudeTier, type Look } from "../brands.ts";

export type Pose = "walk" | "work" | "idle" | "sleep" | "cheer" | "alert";

export interface Rig {
  /** 원점이 발밑(지면)인 그룹. */
  group: THREE.Group;
  /** 이름표를 띄울 높이. 차림(setLook)에 따라 달라진다. */
  height: number;
  animate(pose: Pose, t: number): void;
  /** 0(원래 색)…1(가라앉은 색). 쉬는 에이전트를 물러나 보이게 한다. */
  setDim(amount: number): void;
  /** 그 주민의 차림으로 바꾼다(Clawd 만): Code Mode 면 얼굴에 띠와 `>_`, 모델 계열마다 머리 위에 얹는 것. */
  setLook?(look: Look): void;
  dispose(): void;
}

const DIM_TARGET = new THREE.Color("#7f8696");

/** 재질을 만들어 주고, 원래 색을 기억했다가 한꺼번에 가라앉히거나 되돌린다. */
class Paint {
  private readonly entries: Array<{ mat: THREE.MeshStandardMaterial; base: THREE.Color }> = [];
  /** 마지막으로 가라앉힌 정도 — 나중에 만든 재질(차림을 바꿀 때 생기는 것)도 같은 빛깔로 시작하게. */
  private amount = 0;

  mat(color: string, opts: THREE.MeshStandardMaterialParameters = {}): THREE.MeshStandardMaterial {
    const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.78, metalness: 0.02, flatShading: true, ...opts });
    const base = mat.color.clone();
    this.entries.push({ mat, base });
    if (this.amount) mat.color.copy(base).lerp(DIM_TARGET, this.amount * 0.62);
    return mat;
  }

  dim(amount: number): void {
    this.amount = amount;
    for (const { mat, base } of this.entries) mat.color.copy(base).lerp(DIM_TARGET, amount * 0.62);
  }

  dispose(): void {
    for (const { mat } of this.entries) mat.dispose();
  }
}

/** 깜빡임: 대부분 1, 몇 초에 한 번 잠깐 0 에 가깝게. */
function blink(t: number, offset: number): number {
  const phase = (t + offset) % 4.3;
  return phase < 0.13 ? 0.12 : 1;
}

// ── Clawd ────────────────────────────────────────────────────────────────────────────────────────
// 상태줄 로고의 42×42 격자: 몸통 x8..34 y11..27, 팔 y19..23, 다리 y27..31, 눈 y14.6..19.2.
// 20px = 1 단위로 옮긴다.

const CLAWD_LEG_H = 0.27;
const CLAWD_BODY_W = 1.3;
const CLAWD_BODY_H = 0.8;
const CLAWD_BODY_D = 0.86;
const CLAWD_LEG_X = [-0.5875, -0.3875, 0.3875, 0.5875] as const;

interface ClawdGeos {
  torso: THREE.BufferGeometry;
  cap: THREE.BufferGeometry;
  arm: THREE.BufferGeometry;
  legA: THREE.BufferGeometry;
  legB: THREE.BufferGeometry;
  eyes: THREE.BufferGeometry;
  glints: THREE.BufferGeometry;
  visor?: THREE.BufferGeometry;
  prompt?: THREE.BufferGeometry;
  spark?: THREE.BufferGeometry;
}

let clawdGeosCache: ClawdGeos | undefined;

/** 여러 임시 지오메트리를 하나로 합치고 원본을 정리한다. 모든 같은 종 캐릭터가 공유해 장당 그리기 호출과 버퍼를 아낀다. */
function mergeOwned(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const merged = mergeGeometries(parts)!;
  for (const p of parts) p.dispose();
  return merged;
}

function clawdGeos(): ClawdGeos {
  if (clawdGeosCache) return clawdGeosCache;
  // 다리 1·3 과 2·4 는 걷기·웅크리기 높이·비율이 항상 같아 쌍마다 한 덩어리로 합쳐 그린다.
  const pair = (indices: readonly [number, number], z: number): THREE.BufferGeometry =>
    mergeOwned(indices.map((idx) => new THREE.BoxGeometry(0.13, CLAWD_LEG_H + 0.04, 0.13).translate(CLAWD_LEG_X[idx]!, 0, z)));
  clawdGeosCache = {
    torso: new THREE.BoxGeometry(CLAWD_BODY_W, CLAWD_BODY_H, CLAWD_BODY_D),
    cap: new THREE.BoxGeometry(CLAWD_BODY_W - 0.14, 0.05, CLAWD_BODY_D - 0.14),
    arm: new THREE.BoxGeometry(0.22, 0.2, 0.32),
    legA: pair([0, 2], 0.2),
    legB: pair([1, 3], -0.2),
    eyes: mergeOwned([-1, 1].map((side) => new THREE.BoxGeometry(0.14, 0.23, 0.04).translate(side * 0.39, 0, 0))),
    glints: mergeOwned([-1, 1].map((side) => new THREE.BoxGeometry(0.05, 0.05, 0.02).translate(side * 0.39 - 0.035, 0.07, 0.025))),
  };
  return clawdGeosCache;
}

function clawdFaceGeos(): { visor: THREE.BufferGeometry; prompt: THREE.BufferGeometry } {
  const g = clawdGeos();
  if (!g.visor) g.visor = new THREE.BoxGeometry(CLAWD_BODY_W + 0.03, 0.39, CLAWD_BODY_D + 0.03);
  if (!g.prompt) {
    const strokes = [-1, 1].map((side) => new THREE.BoxGeometry(0.22, 0.09, 0.04).rotateZ(side * -0.524).translate(-0.33, side * 0.055, 0));
    g.prompt = mergeOwned([...strokes, new THREE.BoxGeometry(0.29, 0.11, 0.04).translate(0.315, -0.095, 0)]);
  }
  return { visor: g.visor, prompt: g.prompt };
}

function clawdSparkGeo(): THREE.BufferGeometry {
  const g = clawdGeos();
  if (g.spark) return g.spark;
  // 타일 로고의 네 갈래 별 둘(큰 것과 곁의 작은 것). 납작한 별 두 장을 엇갈려 세워, 돌아도 어느 쪽에서나 별로 보인다.
  const R = 0.2;
  const r = 0.06;
  const shape = new THREE.Shape([[0, R], [r, r], [R, 0], [r, -r], [0, -R], [-r, -r], [-R, 0], [-r, r]].map(([x, y]) => new THREE.Vector2(x, y)));
  // 엇갈린 두 장은 한 덩어리로 합쳐 별 하나를 한 번에 그린다.
  const blade = new THREE.ExtrudeGeometry(shape, { depth: 0.05, bevelEnabled: false }).translate(0, 0, -0.025);
  const crossed = blade.clone().rotateY(Math.PI / 2);
  g.spark = mergeOwned([blade, crossed]);
  return g.spark;
}

function clawd(seed: number): Rig {
  const paint = new Paint();
  const geos = clawdGeos();
  const group = new THREE.Group();
  const root = new THREE.Group();
  group.add(root);

  const LEG_H = CLAWD_LEG_H;
  const BODY_W = CLAWD_BODY_W;
  const BODY_H = CLAWD_BODY_H;
  const BODY_D = CLAWD_BODY_D;

  const bodyMat = paint.mat("#D77757");
  const armMat = paint.mat("#C4603F");
  const legMat = paint.mat("#9C4128");
  const eyeMat = paint.mat("#0B0B0E", { roughness: 0.35 });
  const glintMat = paint.mat("#FFF5EE", { roughness: 0.3, emissive: "#FFF5EE", emissiveIntensity: 0.25 });

  const body = new THREE.Group();
  body.position.y = LEG_H;
  root.add(body);

  const torso = new THREE.Mesh(geos.torso, bodyMat);
  torso.castShadow = true;
  torso.position.y = BODY_H / 2;
  body.add(torso);
  // 윗면의 밝은 베벨 띠 — 로고의 하이라이트 면.
  const cap = new THREE.Mesh(geos.cap, paint.mat("#F09676"));
  cap.castShadow = true;
  cap.position.y = BODY_H + 0.012;
  body.add(cap);

  const arms: THREE.Group[] = [];
  for (const side of [-1, 1]) {
    const arm = new THREE.Group();
    arm.position.set(side * (BODY_W / 2 + 0.09), 0.3, 0);
    const mesh = new THREE.Mesh(geos.arm, armMat);
    mesh.castShadow = true;
    arm.add(mesh);
    body.add(arm);
    arms.push(arm);
  }

  const eyes = new THREE.Group();
  eyes.position.set(0, 0.505, BODY_D / 2 + 0.012);
  const plain = new THREE.Group();
  eyes.add(plain);
  // Code Mode 의 얼굴: 로고(logos.ts 의 CLAWD_CODE)처럼 눈높이에 어두운 띠를 두르고 그 앞에 `>` 와 `_` 를 밝힌다.
  // 띠는 몸을 한 바퀴 돌아, 뒤돌아 있거나 멀리서 내려다볼 때도 구분된다. 글자는 눈과 한 묶음이라 같이 깜빡인다.
  // Code Mode 주민에게만 만든다. `>` 두 획과 `_` 는 한 덩어리로 합쳐 한 번에 그린다 — 띠와 글자 둘이 눈 넷을 대신해 그리기가 오히려 준다.
  let face: { visor: THREE.Mesh; prompt: THREE.Mesh } | undefined;
  const faceOf = (): { visor: THREE.Mesh; prompt: THREE.Mesh } => {
    if (face) return face;
    const fg = clawdFaceGeos();
    const visor = new THREE.Mesh(fg.visor, paint.mat("#15171E", { roughness: 0.5 }));
    visor.position.y = 0.495;
    body.add(visor);
    const prompt = new THREE.Mesh(fg.prompt, paint.mat("#7DF5C0", { roughness: 0.4, emissive: "#7DF5C0", emissiveIntensity: 0.55 }));
    prompt.position.set(0, -0.01, 0.012);
    eyes.add(prompt);
    face = { visor, prompt };
    return face;
  };
  const eyeMesh = new THREE.Mesh(geos.eyes, eyeMat);
  const glintMesh = new THREE.Mesh(geos.glints, glintMat);
  plain.add(eyeMesh, glintMesh);
  body.add(eyes);

  // 다리 4개(1·3 과 2·4 쌍으로 병합): 로고와 같은 x 위치에 앞뒤로 엇갈려 서서 번갈아 걷는다.
  const legA = new THREE.Mesh(geos.legA, legMat);
  legA.castShadow = true;
  legA.position.y = LEG_H / 2;
  const legB = new THREE.Mesh(geos.legB, legMat);
  legB.castShadow = true;
  legB.position.y = LEG_H / 2;
  root.add(legA, legB);

  // 모델 계열은 체급과 빠르기로 가른다(타일 로고 logos.ts 와 같은 규칙): 작고 재빠른 haiku, 조금 작은 sonnet, 기본 크기의 opus,
  // 가장 크고 느긋한 fable. fable 은 머리 위에 금빛 반짝임이 돈다 — 쓰게 될 때 만든다.
  const BUILD: Record<ClaudeTier, { scale: number; tempo: number }> = {
    haiku: { scale: 0.68, tempo: 1.35 },
    sonnet: { scale: 0.8, tempo: 1.12 },
    opus: { scale: 1, tempo: 1 },
    fable: { scale: 1.15, tempo: 0.88 },
  };
  const SPARK_Y = BODY_H + 0.34;
  let tempo = 1;
  let spark: THREE.Group | undefined;
  const sparkOf = (): THREE.Group => {
    if (spark) return spark;
    const geo = clawdSparkGeo();
    const star = (mat: THREE.Material, size: number, x: number, y: number): THREE.Mesh => {
      const made = new THREE.Mesh(geo, mat);
      made.scale.setScalar(size);
      made.position.set(x, y, 0);
      return made;
    };
    spark = new THREE.Group();
    spark.add(
      star(paint.mat("#FFD766", { roughness: 0.35, emissive: "#FFC93C", emissiveIntensity: 0.6 }), 1, 0, 0),
      star(paint.mat("#FFE9A6", { roughness: 0.35, emissive: "#FFD766", emissiveIntensity: 0.6 }), 0.42, 0.33, 0.1),
    );
    spark.position.y = SPARK_Y;
    body.add(spark);
    return spark;
  };
  const BASE_HEIGHT = LEG_H + BODY_H + 0.12;

  const rig: Rig = {
    group,
    height: BASE_HEIGHT,
    animate(pose, t) {
      const tt = t * tempo + seed;
      if (spark?.visible) {
        spark.children[0]!.rotation.y = t * 1.6;
        spark.children[1]!.rotation.y = -t * 2.3;
        spark.position.y = SPARK_Y + Math.sin(t * 2.2 + seed) * 0.03;
      }
      let bob = 0;
      let lift = 0;
      let tilt = 0;
      let armL = 0;
      let armR = 0;
      let armY = 0;
      let stepA = 0;
      let stepB = 0;
      let crouch = 0;
      let eyeY = blink(tt, seed);

      if (pose === "walk") {
        const p = tt * 10.5;
        stepA = Math.max(0, Math.sin(p)) * 0.1;
        stepB = Math.max(0, Math.sin(p + Math.PI)) * 0.1;
        bob = Math.abs(Math.sin(p)) * 0.035;
        tilt = Math.sin(p) * 0.035;
        armL = Math.sin(p) * 0.5;
        armR = -Math.sin(p) * 0.5;
      } else if (pose === "work") {
        // 망치질: 오른팔이 크게 오르내리고 몸이 박자에 맞춰 눌린다.
        const p = tt * 9;
        armR = -1.1 + Math.sin(p) * 0.75;
        armL = -0.25 + Math.sin(p * 0.5) * 0.12;
        bob = Math.max(0, -Math.sin(p)) * 0.045;
        tilt = Math.sin(p * 0.5) * 0.02;
      } else if (pose === "cheer") {
        const p = tt * 4.2;
        lift = Math.abs(Math.sin(p)) * 0.34;
        armY = 0.26 + Math.sin(tt * 9) * 0.05;
        tilt = Math.sin(p) * 0.05;
        stepA = stepB = lift > 0.05 ? 0.06 : 0;
      } else if (pose === "alert") {
        const p = tt * 7.5;
        lift = Math.abs(Math.sin(p)) * 0.2;
        tilt = Math.sin(tt * 15) * 0.07;
        armY = 0.3;
      } else if (pose === "sleep") {
        crouch = 1;
        bob = Math.sin(tt * 1.4) * 0.012;
        eyeY = 0.12;
      } else {
        bob = Math.sin(tt * 1.8) * 0.012;
        armL = armR = Math.sin(tt * 1.8) * 0.05;
      }

      root.position.y = lift;
      root.rotation.z = tilt;
      body.position.y = LEG_H * (1 - crouch * 0.62) + bob;
      arms[0]!.rotation.x = armL;
      arms[1]!.rotation.x = armR;
      arms[0]!.position.y = arms[1]!.position.y = 0.3 + armY;
      eyes.scale.y = eyeY;
      const legScale = 1 - crouch * 0.6;
      const legBaseY = (LEG_H / 2) * legScale;
      legA.scale.y = legB.scale.y = legScale;
      legA.position.y = legBaseY + stepA;
      legB.position.y = legBaseY + stepB;
    },
    setDim: (a) => paint.dim(a),
    setLook(look) {
      const code = look.codeMode === true;
      plain.visible = !code;
      if (code) faceOf().visor.visible = faceOf().prompt.visible = true;
      else if (face) face.visor.visible = face.prompt.visible = false;
      const tier = claudeTier(look.model);
      const build = BUILD[tier ?? "opus"];
      tempo = build.tempo;
      root.scale.setScalar(build.scale);
      if (tier === "fable") sparkOf().visible = true;
      else if (spark) spark.visible = false;
      rig.height = (BASE_HEIGHT + (tier === "fable" ? 0.5 : 0)) * build.scale;
    },
    dispose: () => paint.dispose(),
  };
  return rig;
}

// ── Antigravity ──────────────────────────────────────────────────────────────────────────────────

const AGY_ARCH_PATH =
  "M89.6992 93.695C94.3659 97.195 101.366 94.8617 94.9492 88.445C75.6992 69.7783 79.7825 18.445 55.8659 18.445C31.9492 18.445 36.0325 69.7783 16.7825 88.445C9.78251 95.445 17.3658 97.195 22.0325 93.695C40.1159 81.445 38.9492 59.8617 55.8659 59.8617C72.7825 59.8617 71.6159 81.445 89.6992 93.695Z";

// 로고의 색 겹: 파란 바탕 위에 방사형 그라디언트 넷(SVG 좌표, 반지름, 중심 불투명도).
const AGY_BASE = new THREE.Color("#4285F4");
const AGY_BLOBS: Array<{ x: number; y: number; r: number; color: THREE.Color; alpha: number }> = [
  { x: 31, y: 71, r: 28, color: new THREE.Color("#34A853"), alpha: 0.95 },
  { x: 37, y: 50, r: 27, color: new THREE.Color("#FBBC04"), alpha: 1 },
  { x: 74, y: 48, r: 30, color: new THREE.Color("#9358F7"), alpha: 0.85 },
  { x: 56, y: 24, r: 38, color: new THREE.Color("#EA4335"), alpha: 1 },
];
const AGY_SCALE = 1.25 / 78;

let agyArch: THREE.BufferGeometry | undefined;

/** 아치 경로를 압출하고 정점마다 로고의 색을 칠한다. 모든 AGY 캐릭터가 한 지오메트리를 같이 쓴다. */
function agyGeometry(): THREE.BufferGeometry {
  if (agyArch) return agyArch;
  const svg = new SVGLoader().parse(`<svg xmlns="http://www.w3.org/2000/svg"><path d="${AGY_ARCH_PATH}"/></svg>`);
  const shapes = svg.paths.flatMap((p) => SVGLoader.createShapes(p));
  const geo = new THREE.ExtrudeGeometry(shapes, {
    depth: 15,
    bevelEnabled: true,
    bevelThickness: 3.2,
    bevelSize: 2.6,
    bevelSegments: 3,
    curveSegments: 18,
  });
  const pos = geo.getAttribute("position");
  const colors = new Float32Array(pos.count * 3);
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i += 1) {
    c.copy(AGY_BASE);
    for (const blob of AGY_BLOBS) {
      const d = Math.hypot(pos.getX(i) - blob.x, pos.getY(i) - blob.y) / blob.r;
      if (d < 1) c.lerp(blob.color, blob.alpha * (1 - d) ** 0.85);
    }
    colors.set([c.r, c.g, c.b], i * 3);
  }
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  // SVG 는 y 가 아래로 자란다 — x 축으로 반 바퀴 돌려 세우고(면 방향이 뒤집히지 않는다) 발밑을 원점에 맞춘다.
  geo.translate(-56, -96, -7.5);
  geo.rotateX(Math.PI);
  geo.scale(AGY_SCALE, AGY_SCALE, AGY_SCALE);
  geo.computeVertexNormals();
  agyArch = geo;
  return geo;
}

function agyPoint(x: number, y: number, z: number): THREE.Vector3 {
  return new THREE.Vector3((x - 56) * AGY_SCALE, (96 - y) * AGY_SCALE, z * AGY_SCALE);
}

let agyPartGeosCache: { eyes: THREE.BufferGeometry; pupils: THREE.BufferGeometry; mote: THREE.BufferGeometry } | undefined;

function agyPartGeos(): { eyes: THREE.BufferGeometry; pupils: THREE.BufferGeometry; mote: THREE.BufferGeometry } {
  if (agyPartGeosCache) return agyPartGeosCache;
  const xs = [49.5, 62.5];
  agyPartGeosCache = {
    eyes: mergeOwned(xs.map((x) => { const at = agyPoint(x, 37, 11.2); return new THREE.SphereGeometry(0.062, 12, 10).translate(at.x, at.y, at.z); })),
    pupils: mergeOwned(xs.map((x) => { const at = agyPoint(x, 37, 11.2); return new THREE.SphereGeometry(0.034, 10, 8).translate(at.x, at.y, at.z + 0.04); })),
    mote: new THREE.SphereGeometry(0.045, 8, 6),
  };
  return agyPartGeosCache;
}

function antigravity(seed: number): Rig {
  const paint = new Paint();
  const partGeos = agyPartGeos();
  const group = new THREE.Group();
  const root = new THREE.Group();
  group.add(root);

  const arch = new THREE.Mesh(agyGeometry(), paint.mat("#FFFFFF", { vertexColors: true, flatShading: false, roughness: 0.34, metalness: 0.08 }));
  arch.castShadow = true;
  root.add(arch);

  const eyeMat = paint.mat("#FFFFFF", { roughness: 0.3, flatShading: false });
  const pupilMat = paint.mat("#16233F", { roughness: 0.3, flatShading: false });
  const eyes = new THREE.Group();
  eyes.add(new THREE.Mesh(partGeos.eyes, eyeMat), new THREE.Mesh(partGeos.pupils, pupilMat));
  root.add(eyes);

  // 반중력 광입자: 아치 아래에서 떠오르며 사라진다.
  const moteMat = paint.mat("#8AB4F8", { emissive: "#669DF6", emissiveIntensity: 1.4, flatShading: false });
  const motes = [0, 1, 2].map((i) => {
    const mote = new THREE.Mesh(partGeos.mote, moteMat);
    mote.userData.phase = i / 3;
    mote.userData.x = (i - 1) * 0.16;
    group.add(mote);
    return mote;
  });

  return {
    group,
    height: 1.25 + 0.42,
    animate(pose, t) {
      const tt = t + seed;
      let hover = 0.2 + Math.sin(tt * 1.75) * 0.06;
      let pitch = 0;
      let roll = 0;
      let yaw = 0;
      let eyeY = blink(tt, seed);
      let moteSpeed = 0.35;

      if (pose === "walk") {
        pitch = 0.2;
        hover = 0.24 + Math.sin(tt * 6) * 0.04;
        moteSpeed = 1.1;
      } else if (pose === "work") {
        yaw = Math.sin(tt * 3.2) * 0.55;
        hover = 0.22 + Math.abs(Math.sin(tt * 6.4)) * 0.07;
        moteSpeed = 1.5;
      } else if (pose === "cheer") {
        yaw = tt * 5.5;
        hover = 0.3 + Math.abs(Math.sin(tt * 4.2)) * 0.3;
        moteSpeed = 1.8;
      } else if (pose === "alert") {
        roll = Math.sin(tt * 15) * 0.13;
        hover = 0.24 + Math.abs(Math.sin(tt * 7.5)) * 0.18;
        moteSpeed = 1.2;
      } else if (pose === "sleep") {
        hover = 0.03;
        roll = 0.16;
        eyeY = 0.12;
        moteSpeed = 0;
      }

      root.position.y = hover;
      root.rotation.set(pitch, yaw, roll);
      eyes.scale.y = eyeY;
      for (const mote of motes) {
        if (moteSpeed === 0) {
          mote.visible = false;
          continue;
        }
        mote.visible = true;
        const life = (tt * moteSpeed * 0.5 + (mote.userData.phase as number)) % 1;
        mote.position.set(mote.userData.x as number, life * 0.55, 0);
        mote.scale.setScalar(Math.sin(life * Math.PI));
      }
    },
    setDim: (a) => paint.dim(a),
    dispose: () => paint.dispose(),
  };
}

// ── 그 밖의 벤더: 브랜드 마크를 얼굴에 띄운 로봇 ───────────────────────────────────────────────────

function faceTexture(brand: Brand): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = brand.bg;
  ctx.fillRect(0, 0, size, size);
  const scale = (size * 0.62) / 24;
  ctx.translate(size / 2, size / 2);
  ctx.scale(scale, scale);
  ctx.translate(-12, -12);
  const path = new Path2D(brand.d ?? "");
  let paintStyle: string | CanvasGradient = brand.fg;
  if (brand.grad) {
    const g = ctx.createLinearGradient(0, 0, 24, 24);
    brand.grad.forEach((stop, i) => g.addColorStop(i / (brand.grad!.length - 1), stop));
    paintStyle = g;
  }
  if (brand.mode === "stroke") {
    ctx.strokeStyle = paintStyle;
    ctx.lineWidth = 2;
    ctx.stroke(path);
  } else {
    ctx.fillStyle = paintStyle;
    ctx.fill(path);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

const robotFaceMats = new Map<string, THREE.MeshBasicMaterial>();
interface RobotGeos {
  leg: THREE.BufferGeometry;
  torso: THREE.BufferGeometry;
  skull: THREE.BufferGeometry;
  face: THREE.BufferGeometry;
  antenna: THREE.BufferGeometry;
  bulb: THREE.BufferGeometry;
  arm: THREE.BufferGeometry;
}
let robotGeosCache: RobotGeos | undefined;
const ROBOT_LEG_H = 0.22;

function robotGeos(): RobotGeos {
  if (robotGeosCache) return robotGeosCache;
  robotGeosCache = {
    leg: new THREE.BoxGeometry(0.16, ROBOT_LEG_H + 0.04, 0.18),
    torso: new THREE.BoxGeometry(0.66, 0.42, 0.5),
    skull: new THREE.BoxGeometry(0.96, 0.7, 0.72),
    face: new THREE.PlaneGeometry(0.6, 0.6),
    antenna: new THREE.BoxGeometry(0.04, 0.2, 0.04),
    bulb: new THREE.SphereGeometry(0.07, 10, 8),
    arm: new THREE.BoxGeometry(0.14, 0.34, 0.16),
  };
  return robotGeosCache;
}

function robotFaceMat(vendor: string, brand: Brand): THREE.MeshBasicMaterial {
  const key = brandKey(vendor);
  let mat = robotFaceMats.get(key);
  if (!mat) {
    mat = new THREE.MeshBasicMaterial({ map: faceTexture(brand) });
    robotFaceMats.set(key, mat);
  }
  return mat;
}

function robot(vendor: string, seed: number): Rig {
  const brand = brandFor(vendor);
  const paint = new Paint();
  const geos = robotGeos();
  const group = new THREE.Group();
  const root = new THREE.Group();
  group.add(root);

  // 검정 계열 브랜드는 껍데기까지 검게 칠하면 밤 장면에서 사라진다 — 껍데기는 은빛으로 두고
  // 브랜드 색은 얼굴 화면에만 쓴다. 흰 브랜드는 반대로 살짝 눌러 하늘에 묻히지 않게 한다.
  const shell = new THREE.Color(brand.bg);
  const hsl = { h: 0, s: 0, l: 0 };
  shell.getHSL(hsl);
  if (hsl.l < 0.16) shell.set("#D5D9E4");
  else if (hsl.l > 0.9) shell.setHSL(hsl.h, hsl.s, 0.84);
  const shellHex = `#${shell.getHexString()}`;
  const accent = brand.accent ?? "#C9D1E3";

  const LEG_H = ROBOT_LEG_H;
  const shellMat = paint.mat(shellHex, { roughness: 0.55 });
  const jointMat = paint.mat("#3A4052");
  const accentMat = paint.mat(accent, { emissive: accent, emissiveIntensity: 0.9 });

  const legL = new THREE.Mesh(geos.leg, jointMat);
  legL.castShadow = true;
  legL.position.set(-0.2, LEG_H / 2, 0);
  const legR = new THREE.Mesh(geos.leg, jointMat);
  legR.castShadow = true;
  legR.position.set(0.2, LEG_H / 2, 0);
  root.add(legL, legR);

  const body = new THREE.Group();
  body.position.y = LEG_H;
  root.add(body);
  const torso = new THREE.Mesh(geos.torso, shellMat);
  torso.castShadow = true;
  torso.position.y = 0.21;
  body.add(torso);

  const head = new THREE.Group();
  head.position.y = 0.46;
  body.add(head);
  const skull = new THREE.Mesh(geos.skull, shellMat);
  skull.castShadow = true;
  skull.position.y = 0.35;
  head.add(skull);
  const face = new THREE.Mesh(geos.face, robotFaceMat(vendor, brand));
  face.position.set(0, 0.35, 0.365);
  head.add(face);
  const antenna = new THREE.Mesh(geos.antenna, jointMat);
  antenna.castShadow = true;
  antenna.position.y = 0.8;
  const bulb = new THREE.Mesh(geos.bulb, accentMat);
  bulb.position.y = 0.94;
  head.add(antenna, bulb);

  const arms = [-1, 1].map((side) => {
    const arm = new THREE.Group();
    arm.position.set(side * 0.42, 0.34, 0);
    const mesh = new THREE.Mesh(geos.arm, jointMat);
    mesh.castShadow = true;
    mesh.position.y = -0.13;
    arm.add(mesh);
    body.add(arm);
    return arm;
  });

  return {
    group,
    height: LEG_H + 0.46 + 0.7 + 0.38,
    animate(pose, t) {
      const tt = t + seed;
      let lift = 0;
      let bob = Math.sin(tt * 1.8) * 0.012;
      let tilt = 0;
      let armL = 0;
      let armR = 0;
      let armRoll = 0;
      let stepA = 0;
      let stepB = 0;
      let nod = 0;
      let crouch = 0;
      let glow = 0.9;

      if (pose === "walk") {
        const p = tt * 10;
        stepA = Math.max(0, Math.sin(p)) * 0.09;
        stepB = Math.max(0, Math.sin(p + Math.PI)) * 0.09;
        bob = Math.abs(Math.sin(p)) * 0.03;
        armL = Math.sin(p) * 0.6;
        armR = -Math.sin(p) * 0.6;
      } else if (pose === "work") {
        const p = tt * 9;
        armR = -1.3 + Math.sin(p) * 0.7;
        armL = -0.3;
        nod = 0.12 + Math.sin(p) * 0.05;
        glow = 1.2 + Math.sin(p) * 0.8;
      } else if (pose === "cheer") {
        lift = Math.abs(Math.sin(tt * 4.2)) * 0.32;
        armRoll = 2.5 + Math.sin(tt * 9) * 0.25;
        glow = 2;
      } else if (pose === "alert") {
        lift = Math.abs(Math.sin(tt * 7.5)) * 0.18;
        tilt = Math.sin(tt * 15) * 0.07;
        armRoll = 2.2;
        glow = 1 + Math.sin(tt * 12) * 1;
      } else if (pose === "sleep") {
        crouch = 1;
        nod = 0.3;
        glow = 0.12;
      }

      root.position.y = lift;
      root.rotation.z = tilt;
      body.position.y = LEG_H * (1 - crouch * 0.6) + bob;
      head.rotation.x = nod;
      arms[0]!.rotation.set(armL, 0, -armRoll);
      arms[1]!.rotation.set(armR, 0, armRoll);
      accentMat.emissiveIntensity = glow;
      const legScale = 1 - crouch * 0.6;
      const legBaseY = (LEG_H / 2) * legScale;
      legL.scale.y = legR.scale.y = legScale;
      legL.position.y = legBaseY + stepA;
      legR.position.y = legBaseY + stepB;
    },
    setDim: (a) => paint.dim(a),
    dispose: () => paint.dispose(),
  };
}

/** 벤더에 맞는 캐릭터를 만든다. seed 는 같은 종끼리 박자가 겹치지 않게 어긋내는 값이다. */
export function createRig(vendor: string, seed: number): Rig {
  switch (brandKey(vendor)) {
    case "claude":
      return clawd(seed);
    case "agy":
      return antigravity(seed);
    default:
      return robot(vendor, seed);
  }
}
