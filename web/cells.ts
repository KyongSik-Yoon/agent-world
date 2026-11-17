// 터미널 화면에서 글꼴 대신 칸에 직접 그리는 글자들: 블록 문자(U+2580–259F), 상자 테두리 문자(U+2500–257F),
// 육분할·쐐기 블록(U+1FB00–1FB67).
//
// 휴대폰 글꼴의 이 글자들은 줄 높이(1.22em)를 다 채우지 못해 줄 사이가 끊기고, 글꼴에 없으면 다른 글꼴이 대신 그려
// 굵기·모양·폭이 어긋난다 — Claude Code 의 캐릭터와 상자 테두리가 깨진다. 데스크톱 터미널도 이 글자들은 직접 그린다.
// 칸(1칸 × 줄 높이)을 사방 0.5px 씩 넓혀 이웃 칸·줄과 겹쳐 그리므로(CSS .blk), 경계가 소수점 픽셀에 걸려도 틈이 없다.
// 글자마다 규칙을 한 번 깔고 클래스로 고른다 — 칸마다 인라인 스타일을 적는 것보다 빠르다.

// ── 블록 문자 ────────────────────────────────────────────────────────────────────────────────

/**
 * 칸을 8×8 로 보고 글자 모양을 다각형 하나로 적는다(빈 배열은 칸 전체, 수는 음영의 진하기). 조각 여러 개를 깔면 조각마다
 * 따로 픽셀에 맞춰져 그 사이에 1px 틈이 생기므로, 조각이 둘 이상인 사분면(▙▚▛▜▞▟)은 한 덩어리로 오려 낸다(clip-path).
 * 네모 하나인 글자는 배경 한 장으로 깐다(오리기는 칸마다 무거워, 블록이 많은 화면에서 느려진다).
 */
const BLOCKS: Record<string, number[] | number> = (() => {
  const rect = (l: number, t: number, r: number, b: number) => [l, t, r, t, r, b, l, b];
  const map: Record<string, number[] | number> = {
    "▀": rect(0, 0, 8, 4),
    "█": [],
    "▐": rect(4, 0, 8, 8),
    "░": 0.25,
    "▒": 0.5,
    "▓": 0.75,
    "▔": rect(0, 0, 8, 1),
    "▕": rect(7, 0, 8, 8),
    "▖": rect(0, 4, 4, 8),
    "▗": rect(4, 4, 8, 8),
    "▘": rect(0, 0, 4, 4),
    "▙": [0, 0, 4, 0, 4, 4, 8, 4, 8, 8, 0, 8],
    "▚": [0, 0, 4, 0, 4, 4, 8, 4, 8, 8, 4, 8, 4, 4, 0, 4],
    "▛": [0, 0, 8, 0, 8, 4, 4, 4, 4, 8, 0, 8],
    "▜": [0, 0, 8, 0, 8, 8, 4, 8, 4, 4, 0, 4],
    "▝": rect(4, 0, 8, 4),
    "▞": [4, 0, 8, 0, 8, 4, 4, 4, 4, 8, 0, 8, 0, 4, 4, 4],
    "▟": [4, 0, 8, 0, 8, 8, 0, 8, 0, 4, 4, 4],
  };
  // ▁▂▃▄▅▆▇: 아래에서 n/8, ▉▊▋▌▍▎▏: 왼쪽에서 (8-n)/8.
  for (let n = 1; n <= 7; n += 1) {
    map[String.fromCharCode(0x2580 + n)] = rect(0, 8 - n, 8, 8);
    map[String.fromCharCode(0x2588 + n)] = rect(0, 0, 8 - n, 8);
  }
  return map;
})();

function blockRule(spec: number[] | number): string {
  if (typeof spec === "number") return `background:color-mix(in srgb,currentColor ${spec * 100}%,transparent)`;
  if (spec.length === 0) return "background:currentColor";
  if (spec.length === 8) {
    const [l, t, , , r, b] = spec as [number, number, number, number, number, number];
    const at = (start: number, size: number) => (size >= 8 ? 0 : (start / (8 - size)) * 100);
    return `background:linear-gradient(currentColor,currentColor) ${at(l, r - l)}% ${at(t, b - t)}%/${((r - l) / 8) * 100}% ${((b - t) / 8) * 100}% no-repeat`;
  }
  const points: string[] = [];
  for (let i = 0; i < spec.length; i += 2) points.push(`${(spec[i]! / 8) * 100}% ${(spec[i + 1]! / 8) * 100}%`);
  return `background:currentColor;clip-path:polygon(${points.join(",")})`;
}

// ── 상자 테두리 문자 ──────────────────────────────────────────────────────────────────────────

/**
 * 가운데에서 위·오른쪽·아래·왼쪽으로 뻗는 선의 굵기(0 없음, 1 가는, 2 굵은, 3 겹선). U+2500 부터 차례로, 점선·둥근 모서리·
 * 대각선처럼 이 꼴로 적을 수 없는 글자는 "-" 로 두고 SPECIAL 에 따로 적는다.
 */
const ARMS =
  "0101 0202 1010 2020 - - - - - - - - 0110 0210 0120 0220 0011 0012 0021 0022 1100 1200 2100 2200 1001 1002 2001 2002 " +
  "1110 1210 2110 1120 2120 2210 1220 2220 1011 1012 2011 1021 2021 2012 1022 2022 0111 0112 0211 0212 0121 0122 0221 0222 " +
  "1101 1102 1201 1202 2101 2102 2201 2202 1111 1112 1211 1212 2111 1121 2121 2112 2211 1122 1221 2212 1222 2122 2221 2222 " +
  "- - - - 0303 3030 0310 0130 0330 0013 0031 0033 1300 3100 3300 1003 3001 3003 1310 3130 3330 1013 3031 3033 " +
  "0313 0131 0333 1303 3101 3303 1313 3131 3333 - - - - - - - 0001 1000 0100 0010 0002 2000 0200 0020 0201 1020 0102 2010";

/** 줄 굵기(px) — 칸 크기와 상관없이 같다. 가는 1, 굵은 2. 겹선은 1px 두 줄 사이 1px(바깥 폭 3). */
const WIDTH = [0, 1, 2, 3];

const C = 0.5;

/** 점선(가는·굵은, 가로·세로, 세 토막·네 토막·두 토막), 둥근 모서리, 대각선 — 마스크 그림으로 그린다. 칸은 0–1 로 본다. */
function dashes(n: number, vertical: boolean): string {
  // 토막과 틈을 2:1 로, 칸 경계를 가운데로 하는 틈 반쪽씩을 양 끝에 둔다(이웃 칸의 점선과 같은 간격으로 이어진다).
  const step = 1 / n;
  const gap = step / 3;
  let d = "";
  for (let i = 0; i < n; i += 1) {
    const a = i * step + gap / 2;
    const b = a + step - gap;
    d += vertical ? `M${C} ${a}V${b}` : `M${a} ${C}H${b}`;
  }
  return d;
}

const SPECIAL: Record<number, { d: string; w: number; cap?: string }> = {
  0x2504: { d: dashes(3, false), w: 1, cap: "butt" },
  0x2505: { d: dashes(3, false), w: 2, cap: "butt" },
  0x2506: { d: dashes(3, true), w: 1, cap: "butt" },
  0x2507: { d: dashes(3, true), w: 2, cap: "butt" },
  0x2508: { d: dashes(4, false), w: 1, cap: "butt" },
  0x2509: { d: dashes(4, false), w: 2, cap: "butt" },
  0x250a: { d: dashes(4, true), w: 1, cap: "butt" },
  0x250b: { d: dashes(4, true), w: 2, cap: "butt" },
  0x254c: { d: dashes(2, false), w: 1, cap: "butt" },
  0x254d: { d: dashes(2, false), w: 2, cap: "butt" },
  0x254e: { d: dashes(2, true), w: 1, cap: "butt" },
  0x254f: { d: dashes(2, true), w: 2, cap: "butt" },
  // 둥근 모서리: 가운데에서 두 변의 가운데로 이어지는 사분원(칸이 길쭉해 타원이 된다).
  0x256d: { d: `M1 ${C}A${C} ${C} 0 0 0 ${C} 1`, w: 1, cap: "butt" },
  0x256e: { d: `M0 ${C}A${C} ${C} 0 0 1 ${C} 1`, w: 1, cap: "butt" },
  0x256f: { d: `M${C} 0A${C} ${C} 0 0 1 0 ${C}`, w: 1, cap: "butt" },
  0x2570: { d: `M${C} 0A${C} ${C} 0 0 0 1 ${C}`, w: 1, cap: "butt" },
  0x2571: { d: "M1 0L0 1", w: 1 },
  0x2572: { d: "M0 0L1 1", w: 1 },
  0x2573: { d: "M1 0L0 1M0 0L1 1", w: 1 },
};

const SVG_HEAD = "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1 1' preserveAspectRatio='none'>";
const STROKE = "fill='none' stroke='#000' vector-effect='non-scaling-stroke'";

/** 점선·둥근 모서리·대각선 하나의 마스크 규칙. 칸에 맞춰 늘어나도 선 굵기는 그대로다(non-scaling-stroke). */
function specialRule(special: { d: string; w: number; cap?: string }): string {
  const svg = `${SVG_HEAD}<path d='${special.d}' ${STROKE} stroke-width='${special.w}' stroke-linecap='${special.cap ?? "square"}'/></svg>`;
  const url = `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
  return `background:currentColor;-webkit-mask:${url} 0 0/100% 100% no-repeat;mask:${url} 0 0/100% 100% no-repeat`;
}

/**
 * 선으로 된 글자(─│┌┼ ═║╔╬ …, 가장 흔하다)는 배경 그라디언트로 칠한다 — 마스크 그림(칸마다 래스터로 만들어 늘린다)보다
 * 2–3배 가볍고 끝이 번지지 않는다. 테두리로 긋는 방식도 재 봤지만 칸마다 상자가 둘 더 생겨 느렸다.
 * 토막마다 "가운데에서 얼마나 넘어와 시작하는가(k px)"를 정한다. 가는·굵은 토막은 맞닿는 줄의 바깥 가장자리까지 와서
 * 꺾이는 곳을 채우고, 겹선(1px 두 줄, 사이 1px)은 맞은편으로 열리는 쪽 줄은 안쪽에서 멈추고 닫히는 쪽 줄은 바깥까지 간다.
 */
function lineRule(sel: string, arms: string): string {
  const w = [...arms].map(Number) as [number, number, number, number]; // 위·오른쪽·아래·왼쪽
  const thick = (x: number) => (x === 3 ? 3 : WIDTH[x]!);
  const layers: string[] = [];
  const line = "linear-gradient(currentColor,currentColor)";
  /** 가로 토막: 가운데 + y px 에 굵기 t, x 는 가운데 − k 에서 오른쪽 끝까지(right) 또는 왼쪽 끝에서 가운데 + k 까지. */
  const h = (right: boolean, k: number, y: number, t: number) =>
    layers.push(`${line} ${right ? "100%" : "0"} calc(50% + ${y}px)/calc(50% + ${k}px) ${t}px no-repeat`);
  const v = (down: boolean, k: number, x: number, t: number) =>
    layers.push(`${line} calc(50% + ${x}px) ${down ? "100%" : "0"}/${t}px calc(50% + ${k}px) no-repeat`);
  // 같은 축의 두 토막이 같은 가는·굵은 줄이면 한 줄로 끝까지 긋는다(가운데에서 끊기지 않게).
  const through = (a: number, b: number) => a === b && (a === 1 || a === 2);
  for (const axis of [0, 1] as const) {
    // axis 0: 가로(오른쪽 1, 왼쪽 3), 수직 짝은 위 0·아래 2. axis 1: 세로(위 0, 아래 2), 수직 짝은 왼쪽 3·오른쪽 1.
    const [a, b] = axis === 0 ? [1, 3] : [2, 0];
    const [p1, p2] = axis === 0 ? [w[0], w[2]] : [w[3], w[1]]; // 음(-1) 쪽, 양(+1) 쪽 수직 짝
    const draw = axis === 0 ? h : v;
    if (through(w[a]!, w[b]!)) {
      const t = WIDTH[w[a]!]!;
      layers.push(axis === 0 ? `${line} 0 50%/100% ${t}px no-repeat` : `${line} 50% 0/${t}px 100% no-repeat`);
      continue;
    }
    for (const [dir, toEnd] of [[a, true], [b, false]] as const) {
      const weight = w[dir]!;
      if (!weight) continue;
      if (weight === 3) {
        for (const side of [-1, 1] as const) {
          const near = side < 0 ? p1 : p2;
          const far = side < 0 ? p2 : p1;
          let k: number;
          if (near === 3) k = -0.5; // 그쪽 겹선 통로로 열린다 — 안쪽 줄에서 멈춘다.
          else if (near) k = thick(near) / 2; // 가는 줄에 맞닿는다.
          else if (far === 3) k = 1.5; // 맞은편 겹선의 바깥 줄까지 가서 모서리를 닫는다.
          else if (far) k = thick(far) / 2;
          else k = 1.5;
          draw(toEnd, k, side, 1);
        }
      } else {
        const t = WIDTH[weight]!;
        let k: number;
        if (p1 === 3 || p2 === 3) k = p1 === 3 && p2 === 3 ? -0.5 : 1.5; // 겹선이 지나가면 가까운 줄에서, 꺾이면 먼 줄까지.
        else k = Math.max(thick(p1), thick(p2), t) / 2;
        draw(toEnd, k, 0, t);
      }
    }
  }
  return `.term .${sel}{background:${layers.join(",")}}`;
}

// ── 레거시 컴퓨팅 블록(U+1FB00–) ─────────────────────────────────────────────────────────────

/**
 * 칸을 0–1 로 본 다각형. 육분할(🬀–🬻)은 칸을 2×3 으로 나눈 조각들, 쐐기(🬼–🭧)는 칸 가장자리의 두 점을 잇는 사선으로
 * 자른 한쪽이다. 상태줄의 캐릭터 그림(다리 🬁, 둥근 몸통 🭇🭆🭑🬼)이 쓰는데, 휴대폰 글꼴에는 거의 없어 □ 로 나온다.
 */
const MOSAIC: Array<[string, number[]]> = (() => {
  const out: Array<[string, number[]]> = [];
  // 육분할: 조각 번호 1–6 이 위에서 아래로 왼쪽·오른쪽 차례이고, 글자는 그 비트 조합의 차례다. 왼쪽 세로 반(▌)·오른쪽 세로
  // 반(▐)·빈칸·꽉 찬 칸은 이미 있는 글자를 쓰므로 건너뛴다.
  let code = 0x1fb00;
  for (let bits = 1; bits < 63; bits += 1) {
    if (bits === 0b010101 || bits === 0b101010) continue;
    out.push([String.fromCodePoint(code), sextant(bits)]);
    code += 1;
  }
  // 쐐기: 사선이 지나는 두 점(가장자리의 왼쪽·가운데·오른쪽 × 위·위 1/3·아래 1/3·아래)과 칠하는 모서리.
  const X = { L: 0, C: 0.5, R: 1 } as const;
  const Y = { U: 0, u: 1 / 3, l: 2 / 3, D: 1 } as const;
  type P = `${keyof typeof Y}${keyof typeof X}`;
  const at = (p: P): [number, number] => [X[p[1] as keyof typeof X], Y[p[0] as keyof typeof Y]];
  const WEDGES: Array<[corner: P, from: P, to: P]> = [
    ["DL", "lL", "DC"], ["DL", "lL", "DR"], ["DL", "uL", "DC"], ["DL", "uL", "DR"], ["DL", "UL", "DC"],
    ["DR", "uL", "UC"], ["DR", "uL", "UR"], ["DR", "lL", "UC"], ["DR", "lL", "UR"], ["DR", "DL", "UC"],
    ["DR", "lL", "uR"], ["DR", "DC", "lR"], ["DR", "DL", "lR"], ["DR", "DC", "uR"], ["DR", "DL", "uR"], ["DR", "DC", "UR"],
    ["DL", "UC", "uR"], ["DL", "UL", "uR"], ["DL", "UC", "lR"], ["DL", "UL", "lR"], ["DL", "UC", "DR"], ["DL", "uL", "lR"],
    ["UR", "lL", "DC"], ["UR", "lL", "DR"], ["UR", "uL", "DC"], ["UR", "uL", "DR"], ["UR", "UL", "DC"],
    ["UL", "uL", "UC"], ["UL", "uL", "UR"], ["UL", "lL", "UC"], ["UL", "lL", "UR"], ["UL", "DL", "UC"],
    ["UL", "lL", "uR"], ["UL", "DC", "lR"], ["UL", "DL", "lR"], ["UL", "DC", "uR"], ["UL", "DL", "uR"], ["UL", "DC", "UR"],
    ["UR", "UC", "uR"], ["UR", "UL", "uR"], ["UR", "UC", "lR"], ["UR", "UL", "lR"], ["UR", "UC", "DR"], ["UR", "uL", "lR"],
  ];
  WEDGES.forEach(([corner, from, to], i) => out.push([String.fromCodePoint(0x1fb3c + i), cut(at(from), at(to), at(corner))]));
  return out;
})();

/** 육분할 조각들을 한 다각형으로. 떨어진 조각은 폭 없는 다리로 잇는다(오려 낼 때 다리는 넓이가 없어 보이지 않는다). */
function sextant(bits: number): number[] {
  const rows = [0, 1 / 3, 2 / 3, 1];
  // 줄마다 칠한 가로 구간을 이어 붙인 덩어리를, 위 줄과 같은 구간이면 세로로 합친다.
  const rects: Array<[number, number, number, number]> = [];
  for (let r = 0; r < 3; r += 1) {
    const left = (bits >> (r * 2)) & 1;
    const right = (bits >> (r * 2 + 1)) & 1;
    const span: [number, number] | undefined = left && right ? [0, 1] : left ? [0, 0.5] : right ? [0.5, 1] : undefined;
    if (!span) continue;
    const last = rects[rects.length - 1];
    if (last && last[0] === span[0] && last[2] === span[1] && last[3] === rows[r]) last[3] = rows[r + 1]!;
    else rects.push([span[0], rows[r]!, span[1], rows[r + 1]!]);
  }
  // 첫 조각을 돌고 그 첫 점으로 돌아온 뒤, 다음 조각의 첫 점으로 건너가 돌고 그 첫 점으로 돌아온다. 다음 조각은 다시 첫
  // 조각의 첫 점에서 건너간다 — 마지막 조각에서 닫히는 변이 건너간 길을 되짚으므로 다리마다 넓이가 0 이다.
  const points: number[] = [];
  for (const [l, t, r, b] of rects) {
    if (points.length) points.push(points[0]!, points[1]!);
    points.push(l, t, r, t, r, b, l, b);
    if (rects.length > 1) points.push(l, t);
  }
  return points;
}

/** 칸(0–1)을 두 점을 지나는 직선으로 자른 조각 가운데 keep 쪽. */
function cut(a: [number, number], b: [number, number], keep: [number, number]): number[] {
  const side = (p: [number, number]) => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
  const sign = Math.sign(side(keep));
  const square: Array<[number, number]> = [[0, 0], [1, 0], [1, 1], [0, 1]];
  const out: number[] = [];
  square.forEach((p, i) => {
    const q = square[(i + 1) % 4]!;
    const sp = side(p) * sign;
    const sq = side(q) * sign;
    if (sp >= 0) out.push(p[0], p[1]);
    if ((sp > 0 && sq < 0) || (sp < 0 && sq > 0)) {
      const t = sp / (sp - sq);
      out.push(p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t);
    }
  });
  return out;
}

/** 다각형 하나를 칠하는 규칙. 네모 하나면 배경 한 장(오리기보다 가볍다), 아니면 오려 낸다. */
function mosaicRule(points: number[]): string {
  const pct = (v: number) => `${+(v * 100).toFixed(3)}%`;
  if (points.length === 8) {
    const xs = [points[0]!, points[2]!, points[4]!, points[6]!];
    const ys = [points[1]!, points[3]!, points[5]!, points[7]!];
    const [l, r, t, b] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const isRect = xs.every((x) => x === l || x === r) && ys.every((y) => y === t || y === b);
    if (isRect) {
      const at = (start: number, size: number) => (size >= 1 ? 0 : start / (1 - size));
      return `background:linear-gradient(currentColor,currentColor) ${pct(at(l, r - l))} ${pct(at(t, b - t))}/${pct(r - l)} ${pct(b - t)} no-repeat`;
    }
  }
  const list: string[] = [];
  for (let i = 0; i < points.length; i += 2) list.push(`${pct(points[i]!)} ${pct(points[i + 1]!)}`);
  return `background:currentColor;clip-path:polygon(${list.join(",")})`;
}

// ── 고르기 ──────────────────────────────────────────────────────────────────────────────────

/** 글자 → 붙일 클래스. 규칙은 sheet 에 한 번 깐다. */
const classes = new Map<string, string>();
const sheet: string[] = [];
for (const [ch, spec] of Object.entries(BLOCKS)) {
  const sel = `b${ch.charCodeAt(0).toString(16)}`;
  // 음영은 반투명이라 이웃과 겹치면 겹친 줄이 진해진다 — 겹치지 않게 둔다(.shade).
  classes.set(ch, `blk ${sel}${typeof spec === "number" ? " shade" : ""}`);
  sheet.push(`.term .${sel}{${blockRule(spec)}}`);
}
for (let code = 0x2500; code <= 0x257f; code += 1) {
  const sel = `b${code.toString(16)}`;
  const special = SPECIAL[code];
  const arms = ARMS.split(" ")[code - 0x2500];
  const rule = special ? `.term .${sel}{${specialRule(special)}}` : arms && arms !== "-" ? lineRule(sel, arms) : undefined;
  if (!rule) continue;
  classes.set(String.fromCharCode(code), `blk ${sel}`);
  sheet.push(rule);
}

for (const [ch, points] of MOSAIC) {
  const sel = `b${ch.codePointAt(0)!.toString(16)}`;
  classes.set(ch, `blk ${sel}`);
  sheet.push(`.term .${sel}{${mosaicRule(points)}}`);
}

/** 직접 그리는 글자면 붙일 클래스, 아니면 undefined(글꼴로 그린다). */
export function drawnClass(cell: string): string | undefined {
  return classes.get(cell);
}

const style = document.createElement("style");
style.textContent = sheet.join("\n");
document.head.append(style);
