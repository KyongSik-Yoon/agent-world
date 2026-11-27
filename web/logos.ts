// Claude 와 Antigravity 의 타일 로고. 이 프로젝트 작성자가 상태줄용으로 직접 만든 벡터 로고를 옮긴 것이다
// (Clawd 는 42×42, 아치는 112×112 좌표). 쉬는 동안에는 멈춘 그림이고, 일하는 중일 때만 움직인다.
//
// 움직임을 SVG 안의 CSS 애니메이션 그대로 돌리면 프레임마다 벡터를 다시 칠해서, 로고 8개에 CPU 가 코어의 30% 에서
// 63% 로 뛰었다(will-change 로도 줄지 않았다). 그래서 한 바퀴를 미리 그림 띠로 구워 두고, 그 띠를 한 칸씩 옮겨
// 보여 준다 — 옮기는 일은 합성기가 하므로 다시 칠하지 않는다. 칸은 장면이 그리는 프레임에 맞춰 넘긴다(beat.ts).

const NS = "http://www.w3.org/2000/svg";

const CLAWD_BODY = "M8 11H34V19H38V23H34V31H31.5V27H30V31H27.5V27H14.5V31H12V27H10.5V31H8V23H4V19H8Z";
const AGY_ARCH =
  "M89.6992 93.695C94.3659 97.195 101.366 94.8617 94.9492 88.445C75.6992 69.7783 79.7825 18.445 55.8659 18.445C31.9492 18.445 36.0325 69.7783 16.7825 88.445C9.78251 95.445 17.3658 97.195 22.0325 93.695C40.1159 81.445 38.9492 59.8617 55.8659 59.8617C72.7825 59.8617 71.6159 81.445 89.6992 93.695Z";

/** 모든 로고가 같이 쓰는 그라디언트·필터·오려 내기. 문서에 한 번만 둔다. */
const DEFS = `
<clipPath id="lg-clawd-torso"><path d="M8 11H34V27H8Z"/></clipPath>
<filter id="lg-clawd-glow" x="-35%" y="-35%" width="170%" height="170%"><feGaussianBlur stdDeviation="2.4"/></filter>
<linearGradient id="lg-clawd-body" x1="8" y1="11" x2="34" y2="27" gradientUnits="userSpaceOnUse"><stop offset="0%" stop-color="#F09676"/><stop offset="52%" stop-color="#D77757"/><stop offset="100%" stop-color="#B55437"/></linearGradient>
<linearGradient id="lg-clawd-arm" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#DF8160"/><stop offset="100%" stop-color="#9E442A"/></linearGradient>
<linearGradient id="lg-clawd-leg" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#9C4128"/><stop offset="32%" stop-color="#BC583B"/><stop offset="100%" stop-color="#7E2E1A"/></linearGradient>
<linearGradient id="lg-clawd-sheen" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#FFF5EE" stop-opacity="0"/><stop offset="35%" stop-color="#FFF5EE" stop-opacity="0.16"/><stop offset="50%" stop-color="#FFFFFF" stop-opacity="0.54"/><stop offset="68%" stop-color="#FFD6C2" stop-opacity="0.16"/><stop offset="100%" stop-color="#FFF5EE" stop-opacity="0"/></linearGradient>
<clipPath id="lg-agy-clip"><path d="${AGY_ARCH}"/></clipPath>
<filter id="lg-agy-glow" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="6"/></filter>
<radialGradient id="lg-agy-red" cx="56" cy="24" r="38" gradientUnits="userSpaceOnUse"><stop offset="0%" stop-color="#EA4335"/><stop offset="48%" stop-color="#EA4335" stop-opacity="0.72"/><stop offset="100%" stop-color="#EA4335" stop-opacity="0"/></radialGradient>
<radialGradient id="lg-agy-yellow" cx="37" cy="50" r="27" gradientUnits="userSpaceOnUse"><stop offset="0%" stop-color="#FBBC04"/><stop offset="50%" stop-color="#FBBC04" stop-opacity="0.68"/><stop offset="100%" stop-color="#FBBC04" stop-opacity="0"/></radialGradient>
<radialGradient id="lg-agy-green" cx="31" cy="71" r="28" gradientUnits="userSpaceOnUse"><stop offset="0%" stop-color="#34A853" stop-opacity="0.95"/><stop offset="55%" stop-color="#34A853" stop-opacity="0.5"/><stop offset="100%" stop-color="#34A853" stop-opacity="0"/></radialGradient>
<radialGradient id="lg-agy-violet" cx="74" cy="48" r="30" gradientUnits="userSpaceOnUse"><stop offset="0%" stop-color="#9358F7" stop-opacity="0.85"/><stop offset="55%" stop-color="#7B61FF" stop-opacity="0.4"/><stop offset="100%" stop-color="#4285F4" stop-opacity="0"/></radialGradient>
<linearGradient id="lg-agy-sheen" x1="0" y1="0" x2="1" y2="0"><stop offset="0%" stop-color="#FFFFFF" stop-opacity="0"/><stop offset="32%" stop-color="#FFFFFF" stop-opacity="0.16"/><stop offset="50%" stop-color="#FFFFFF" stop-opacity="0.82"/><stop offset="68%" stop-color="#D2E3FC" stop-opacity="0.22"/><stop offset="100%" stop-color="#FFFFFF" stop-opacity="0"/></linearGradient>
<radialGradient id="lg-agy-glint" cx="0.5" cy="0.5" r="0.5"><stop offset="0%" stop-color="#FFFFFF" stop-opacity="0.68"/><stop offset="42%" stop-color="#FFF8E1" stop-opacity="0.28"/><stop offset="100%" stop-color="#FFFFFF" stop-opacity="0"/></radialGradient>`;

const CLAWD = `
<ellipse class="logo-clawd-shadow" cx="21" cy="33.6" rx="13.5" ry="2.1" fill="#2A120A" opacity="0.22"/>
<path d="${CLAWD_BODY}" fill="#E07A57" filter="url(#lg-clawd-glow)" opacity="0.46"/>
<g class="logo-clawd-float">
  <g class="logo-clawd-legs-a">
    <rect x="8" y="25.8" width="2.5" height="5.2" rx="0.35" fill="url(#lg-clawd-leg)"/><rect x="8" y="27" width="2.5" height="1" fill="#742B17" opacity="0.55"/>
    <rect x="27.5" y="25.8" width="2.5" height="5.2" rx="0.35" fill="url(#lg-clawd-leg)"/><rect x="27.5" y="27" width="2.5" height="1" fill="#742B17" opacity="0.55"/>
  </g>
  <g class="logo-clawd-legs-b">
    <rect x="12" y="25.8" width="2.5" height="5.2" rx="0.35" fill="url(#lg-clawd-leg)"/><rect x="12" y="27" width="2.5" height="1" fill="#742B17" opacity="0.55"/>
    <rect x="31.5" y="25.8" width="2.5" height="5.2" rx="0.35" fill="url(#lg-clawd-leg)"/><rect x="31.5" y="27" width="2.5" height="1" fill="#742B17" opacity="0.55"/>
  </g>
  <g class="logo-clawd-arm-l">
    <rect x="4" y="19" width="4.5" height="4" rx="0.35" fill="url(#lg-clawd-arm)"/><rect x="4" y="19" width="4" height="0.9" fill="#F5AE93" opacity="0.7"/><rect x="4" y="22.1" width="4" height="0.9" fill="#7E2F1A" opacity="0.72"/>
  </g>
  <g class="logo-clawd-arm-r">
    <rect x="33.5" y="19" width="4.5" height="4" rx="0.35" fill="url(#lg-clawd-arm)"/><rect x="34" y="19" width="4" height="0.9" fill="#F5AE93" opacity="0.48"/><rect x="37.1" y="19" width="0.9" height="4" fill="#7E2F1A" opacity="0.68"/><rect x="34" y="22.1" width="4" height="0.9" fill="#7E2F1A" opacity="0.78"/>
  </g>
  <g clip-path="url(#lg-clawd-torso)">
    <rect x="8" y="11" width="26" height="16" fill="url(#lg-clawd-body)"/>
    <path d="M8 11H34L32.4 12.6H9.6Z" fill="#FAD8C8" opacity="0.62"/><path d="M8 11L9.6 12.6V25.4L8 27Z" fill="#F5AE93" opacity="0.42"/>
    <path d="M34 11V27L32.4 25.4V12.6Z" fill="#8B3720" opacity="0.58"/><path d="M9.6 25.4H32.4L34 27H8Z" fill="#7E2F1A" opacity="0.64"/>
    <g transform="rotate(-24 21 19)"><rect class="logo-clawd-sheen" opacity="0" x="-26" y="3" width="14" height="32" fill="url(#lg-clawd-sheen)"/></g>
  </g>
  <g class="logo-clawd-eyes">
    <rect x="11.75" y="14.6" width="2.8" height="4.6" rx="0.35" fill="#09090B"/><rect x="27.45" y="14.6" width="2.8" height="4.6" rx="0.35" fill="#09090B"/>
    <rect x="12.15" y="15.05" width="0.95" height="0.95" rx="0.18" fill="#FFF5EE" opacity="0.88"/><rect x="27.85" y="15.05" width="0.95" height="0.95" rx="0.18" fill="#FFF5EE" opacity="0.88"/>
  </g>
</g>`;

// Code Mode(실험 기능)로 뜬 Clawd: 얼굴에 어두운 터미널 띠를 두르고 눈 자리에 프롬프트 `>_` 를 밝힌다 — 도구를 하나씩 부르는
// 대신 REPL 에 코드를 쓰는 세션이다. 표정만 바꾸면 목록 크기(26px)와 섬에서 구분이 안 되어, 색(어두운 띠 + 민트)으로 가른다.
// 글자는 눈과 같은 묶음(logo-clawd-eyes)이라 곁눈질과 깜빡임을 그대로 한다 — 곁눈질(±1.7)에도 띠 밖으로 나가지 않는 자리다.
const CLAWD_CODE = CLAWD.replace(
  /<g class="logo-clawd-eyes">[\s\S]*?<\/g>/,
  `<rect x="8" y="13.2" width="26" height="7.8" fill="#15171E"/><rect x="8" y="13.2" width="26" height="0.8" fill="#3B4150"/><rect x="8" y="20.2" width="26" height="0.8" fill="#07080B"/>
  <g class="logo-clawd-eyes">
    <path d="M12.6 14.9L16.2 17.1L12.6 19.3" fill="none" stroke="#7DF5C0" stroke-width="1.8" stroke-linecap="square"/>
    <rect x="24.4" y="17.9" width="5.8" height="2.2" fill="#7DF5C0"/>
  </g>`,
);

// 모델 계열은 체급으로 가른다 — 작고 빠른 haiku, 조금 작은 sonnet, 지금 크기의 opus(모르는 모델도), 가장 높은 fable.
// 타일은 더 키울 수 없어 fable 은 opus 크기에 머리 위 금빛 반짝임을 띄운다. 섬의 캐릭터(world/characters.ts)도 같은 규칙이다.
const CLAWD_SCALE: Record<string, number> = { haiku: 0.68, sonnet: 0.8 };
// 몸과 같이 뜨도록 logo-clawd-float 안에 넣는다. 몸이 가장 떴을 때(-1.4)에도 타일 위(y 3.5)로 거의 잘리지 않는 높이다.
const CLAWD_SPARK = `<path d="M21 4.9L21.9 6.8L23.8 7.7L21.9 8.6L21 10.5L20.1 8.6L18.2 7.7L20.1 6.8Z" fill="#FFD766"/><path d="M27.6 4.6L28.1 5.7L29.2 6.2L28.1 6.7L27.6 7.8L27.1 6.7L26 6.2L27.1 5.7Z" fill="#FFE9A6"/>`;

/** 차림을 입힌 Clawd. 열쇠는 `claude`, `claude-code`, 그 뒤에 `+fable` 같은 모델 계열(brands.ts 의 tileLook). */
function clawd(key: string): string {
  const [base, tier] = key.split("+");
  let body = base === "claude-code" ? CLAWD_CODE : CLAWD;
  if (tier === "fable") {
    const end = body.lastIndexOf("</g>");
    body = `${body.slice(0, end)}${CLAWD_SPARK}${body.slice(end)}`;
  }
  // 발밑(21, 31)을 붙든 채 줄인다 — 작은 모델도 같은 바닥에 선다.
  const scale = tier ? CLAWD_SCALE[tier] : undefined;
  return scale ? `<g transform="translate(21 31) scale(${scale}) translate(-21 -31)">${body}</g>` : body;
}

const AGY_FILL = `<path d="${AGY_ARCH}" fill="#4285F4"/><path d="${AGY_ARCH}" fill="url(#lg-agy-green)"/><path d="${AGY_ARCH}" fill="url(#lg-agy-yellow)"/><path d="${AGY_ARCH}" fill="url(#lg-agy-violet)"/><path d="${AGY_ARCH}" fill="url(#lg-agy-red)"/>`;
const AGY = `
<g class="logo-agy-halo" opacity="0.48" filter="url(#lg-agy-glow)">${AGY_FILL}</g>
<circle class="logo-agy-mote-a" opacity="0" cx="50" cy="90" r="2.6" fill="#669DF6"/><circle class="logo-agy-mote-b" opacity="0" cx="62" cy="92" r="2.1" fill="#8AB4F8"/>
<g class="logo-agy-levitate">
  <g clip-path="url(#lg-agy-clip)">
    <rect width="112" height="112" fill="#4285F4"/><rect width="112" height="112" fill="url(#lg-agy-green)"/><rect width="112" height="112" fill="url(#lg-agy-yellow)"/>
    <rect width="112" height="112" fill="url(#lg-agy-violet)"/><rect width="112" height="112" fill="url(#lg-agy-red)"/>
    <circle class="logo-agy-glint" opacity="0.32" cx="56" cy="40" r="28" fill="url(#lg-agy-glint)"/>
    <g transform="rotate(-24 56 56)"><rect class="logo-agy-sheen" opacity="0" x="-92" y="-28" width="52" height="168" fill="url(#lg-agy-sheen)"/></g>
  </g>
  <path d="${AGY_ARCH}" fill="none" stroke="#FFFFFF" stroke-opacity="0.28" stroke-width="2.4"/>
</g>`;

/**
 * 한 바퀴의 움직임. 원본의 박자를 한 바퀴 길이에 맞췄다(Clawd 는 걸음 네 번 = 3.84초, 아치는 3.6초).
 * 두 로고 모두 한 칸이 240ms 다(beat.ts 의 LOGO_STEP_MS). Clawd 의 한 걸음(0.96초)이 꼭 네 칸이라, 칸마다
 * 원본 keyframes 의 꼭짓점(다리가 가장 올라간 때, 몸이 가장 뜬 때)이 그대로 찍힌다. 눈을 감는 두 순간은 칸 사이에
 * 떨어지면 찍히지 않으므로(원본은 31%·65%) 가장 가까운 칸의 시각(31.25%·62.5%)으로 옮겨 두었다.
 * 프레임을 구울 때만 쓴다: --t 로 시각을 정하고 멈춰 둔 채 그린다.
 */
// perf-ok-block: 멈춰 둔 채(paused) 그림 띠로 굽는 데만 쓴다 — 화면에서 돌지 않는다(beat.ts 가 칸을 넘긴다)
const MOTION: Record<string, string> = {
  claude: `
*{animation-play-state:paused!important}
.logo-clawd-shadow{transform-box:view-box;transform-origin:21px 33.6px;animation:shadow .96s ease-in-out var(--t) infinite}
.logo-clawd-float{transform-box:view-box;transform-origin:21px 21px;animation:float .96s ease-in-out var(--t) infinite}
.logo-clawd-legs-a,.logo-clawd-legs-b{transform-box:view-box;transform-origin:21px 27px;animation:step .96s ease-in-out var(--t) infinite}
.logo-clawd-legs-b{animation-delay:calc(var(--t) - .48s)}
.logo-clawd-arm-l{transform-box:view-box;transform-origin:8px 21px;animation:arm-l .96s ease-in-out var(--t) infinite}
.logo-clawd-arm-r{transform-box:view-box;transform-origin:34px 21px;animation:arm-r .96s ease-in-out var(--t) infinite}
.logo-clawd-eyes{transform-box:view-box;transform-origin:21px 16.9px;animation:gaze 3.84s ease-in-out var(--t) infinite}
.logo-clawd-sheen{transform-box:view-box;opacity:1;animation:sheen 3.84s cubic-bezier(.4,0,.2,1) var(--t) infinite}
@keyframes shadow{0%,50%,100%{transform:scaleX(1);opacity:.24}25%,75%{transform:scaleX(.86);opacity:.15}}
@keyframes float{0%,50%,100%{transform:translateY(0)}25%,75%{transform:translateY(-1.4px)}}
@keyframes step{0%,100%{transform:translate(0,.2px)}25%{transform:translate(.25px,-1.7px)}50%{transform:translate(-.15px,.6px)}75%{transform:translate(0,.4px)}}
@keyframes arm-l{0%,100%{transform:translateY(-.55px) rotate(3.5deg)}50%{transform:translateY(.65px) rotate(-3.5deg)}}
@keyframes arm-r{0%,100%{transform:translateY(.65px) rotate(3.5deg)}50%{transform:translateY(-.55px) rotate(-3.5deg)}}
@keyframes gaze{0%,28%,68%,100%{transform:translateX(0) scaleY(1)}31.25%{transform:translateX(0) scaleY(.12)}34%,46%{transform:translateX(1.7px) scaleY(1)}50%,59.5%{transform:translateX(-1.7px) scaleY(1)}62.5%{transform:translateX(-1.7px) scaleY(.12)}}
@keyframes sheen{0%{transform:translateX(0)}52%,100%{transform:translateX(72px)}}`,
  agy: `
*{animation-play-state:paused!important}
.logo-agy-levitate{transform-box:view-box;transform-origin:56px 56px;animation:levitate 3.6s ease-in-out var(--t) infinite}
.logo-agy-halo{transform-box:view-box;transform-origin:56px 56px;animation:halo 3.6s ease-in-out var(--t) infinite}
.logo-agy-glint{transform-box:view-box;opacity:1;animation:glint 3.6s ease-in-out var(--t) infinite}
.logo-agy-sheen{transform-box:view-box;opacity:1;animation:sheen 3.6s cubic-bezier(.4,0,.2,1) var(--t) infinite}
.logo-agy-mote-a,.logo-agy-mote-b{transform-box:view-box;animation:mote 1.8s ease-out var(--t) infinite}
.logo-agy-mote-b{animation-delay:calc(var(--t) - .9s)}
@keyframes levitate{0%,100%{transform:translateY(2px)}50%{transform:translateY(-3.2px)}}
@keyframes halo{0%,100%{opacity:.44;transform:scale(.95)}50%{opacity:.86;transform:scale(1.08)}}
@keyframes glint{0%,100%{transform:translate(-22px,22px)}25%,75%{transform:translate(0,-12px)}50%{transform:translate(22px,22px)}}
@keyframes sheen{0%{transform:translateX(0)}48%,100%{transform:translateX(244px)}}
@keyframes mote{0%{transform:translateY(4px);opacity:0}30%{opacity:.85}100%{transform:translateY(-24px);opacity:0}}`,
};
// perf-ok-end

interface Logo {
  /** 타일을 채우도록 둘레의 빈 곳을 조금 잘라 본다(좌표계는 그대로다). */
  viewBox: string;
  body: string;
  /** 한 바퀴의 길이(초)와 그것을 나눈 칸 수 — 한 칸이 240ms. */
  seconds: number;
  frames: number;
  /** 한 바퀴의 움직임(MOTION 의 열쇠). */
  motion: string;
}

const LOGOS = new Map<string, Logo>([["agy", { viewBox: "2 4 108 108", body: AGY, seconds: 3.6, frames: 15, motion: "agy" }]]);

/** 그 열쇠의 로고. Clawd 는 차림(Code Mode, 모델 계열)마다 따로 만들어 둔다 — 띠도 차림마다 따로 굽는다. */
function logoOf(key: string): Logo | undefined {
  let logo = LOGOS.get(key);
  if (!logo && /^claude(-code)?(\+\w+)?$/.test(key)) {
    logo = { viewBox: "2 3.5 38 38", body: clawd(key), seconds: 3.84, frames: 16, motion: "claude" };
    LOGOS.set(key, logo);
  }
  return logo;
}

/** 띠의 한 칸 크기(px). 가장 큰 타일(46px)을 2배 밀도로 그릴 만큼. */
const FRAME_PX = 92;

let defsReady = false;
const protos = new Map<string, SVGSVGElement>();
/** 구워 둔 띠의 주소. 굽는 중이면 그 약속. */
const strips = new Map<string, string | Promise<string | null>>();
const stillness = matchMedia("(prefers-reduced-motion: reduce)");

function ensureDefs(): void {
  if (defsReady) return;
  defsReady = true;
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("aria-hidden", "true");
  // display:none 으로 두면 일부 브라우저가 그 안의 필터와 오려 내기를 못 쓴다. 크기만 없앤다.
  svg.setAttribute("style", "position:absolute;width:0;height:0;overflow:hidden");
  svg.innerHTML = `<defs>${DEFS}</defs>`;
  document.body.append(svg);
}

/** 직접 만든 로고가 있는 벤더인가. */
export function hasLogo(key: string): boolean {
  return logoOf(key) !== undefined;
}

/**
 * 한 바퀴를 칸칸이 그려 가로로 이어 붙인 띠를 만든다. 그리지 못하면 null — 그때는 멈춘 그림으로 남는다.
 * 칸마다 data: SVG 를 따로 디코드하면 Blink 가 칸 수만큼(차림 5종이면 79개) SVG 문서를 만들어 MemoryCache 에
 * 붙들어 두고, Oilpan(cppgc) + V8 Major GC 가 뒤따라 CPU 를 쓴다. 한 띠의 모든 칸을 중첩 <svg> 한 장으로 묶어
 * blob URL 로 디코드한 뒤 즉시 해제해 SVG 문서를 띠당 1개로 줄이고 캐시 잔류를 없앤다.
 */
async function bake(key: string): Promise<string | null> {
  const logo = logoOf(key)!;
  try {
    const canvas = document.createElement("canvas");
    canvas.width = FRAME_PX * logo.frames;
    canvas.height = FRAME_PX;
    const ctx = canvas.getContext("2d")!;
    let cells = "";
    for (let i = 0; i < logo.frames; i += 1) {
      const t = ((i / logo.frames) * logo.seconds).toFixed(4);
      cells += `<svg x="${i * FRAME_PX}" y="0" width="${FRAME_PX}" height="${FRAME_PX}" viewBox="${logo.viewBox}" style="--t:-${t}s">${logo.body}</svg>`;
    }
    const sheet = `<svg xmlns="${NS}" width="${canvas.width}" height="${FRAME_PX}"><defs>${DEFS}</defs><style>${MOTION[logo.motion]}</style>${cells}</svg>`;
    const svgUrl = URL.createObjectURL(new Blob([sheet], { type: "image/svg+xml;charset=utf-8" }));
    try {
      const img = new Image();
      img.src = svgUrl;
      await img.decode();
      ctx.drawImage(img, 0, 0, canvas.width, FRAME_PX);
      img.src = "";
    } finally {
      URL.revokeObjectURL(svgUrl);
    }
    const blob = await new Promise<Blob | null>((done) => canvas.toBlob(done));
    return blob ? URL.createObjectURL(blob) : null;
  } catch {
    return null;
  }
}

/** 지금 몇 번째 칸인가. 모든 로고가 같이 넘어간다. */
let step = 0;
/** 문서에 붙은 활성 띠들 — 매 박자 querySelectorAll 로 전체 DOM 을 훑지 않는다. */
const activeStrips = new Set<HTMLElement>();
/** 목록 서랍(#roster)이 화면에 보이는지. 휴대폰에서 서랍이 닫혀 있는 동안은 안의 띠 transform 을 건드리지 않는다. */
let rosterVisible = true;
let rosterEl: HTMLElement | null = null;
let detailEl: HTMLElement | null = null;

/** 띠를 지금의 칸에 놓는다. */
function place(strip: HTMLElement): void {
  const frames = Number(strip.dataset.frames);
  strip.style.transform = `translateX(${-((step % frames) / frames) * 100}%)`;
}

/** 목록 서랍이 열리고 닫힐 때 알린다. 열리면 쉬던 동안 밀린 칸을 바로 맞춘다. */
export function setRosterVisible(visible: boolean): void {
  if (visible === rosterVisible) return;
  rosterVisible = visible;
  if (!visible) return;
  for (const strip of activeStrips) {
    if (!strip.isConnected) {
      activeStrips.delete(strip);
      continue;
    }
    place(strip);
  }
}

/** 상태 창(#detail) 안에 움직이는 로고 띠가 붙어 있는지. solo 박자가 전체 DOM 을 훑지 않게 한다. */
export function hasDetailStrip(): boolean {
  if (activeStrips.size === 0) return false;
  detailEl ??= document.getElementById("detail");
  if (!detailEl || detailEl.hidden) return false;
  for (const strip of activeStrips) {
    if (!strip.isConnected) {
      activeStrips.delete(strip);
      continue;
    }
    if (detailEl.contains(strip)) return true;
  }
  return false;
}

/** 모든 로고를 한 칸 넘긴다. 장면이 그리는 프레임 안에서 불린다(beat.ts). */
export function stepLogos(): void {
  step += 1;
  if (activeStrips.size === 0) return;
  detailEl ??= document.getElementById("detail");
  if (!rosterVisible && (!detailEl || detailEl.hidden)) return;
  const hiddenRoster = rosterVisible ? null : (rosterEl ??= document.getElementById("roster"));
  for (const strip of activeStrips) {
    if (!strip.isConnected) {
      activeStrips.delete(strip);
      continue;
    }
    if (hiddenRoster?.contains(strip)) continue;
    place(strip);
  }
}

/** 움직이는 띠를 타일에 얹는다. 칸은 다른 로고와 같이 센다 — 새로 만든 타일이 처음부터 다시 시작하지 않고 이어서 움직인다. */
function play(tile: HTMLElement, key: string, url: string): void {
  if (!tile.hasAttribute("data-active") || tile.querySelector(".logo-strip")) return;
  const strip = document.createElement("span");
  strip.className = "logo-strip";
  strip.style.backgroundImage = `url(${url})`;
  const frames = logoOf(key)!.frames;
  strip.dataset.frames = String(frames);
  strip.style.width = `${frames * 100}%`;
  place(strip);
  tile.append(strip);
  activeStrips.add(strip);
}

/** 타일 자리에 놓을 로고. active 면 움직인다. */
export function logoTile(key: string, size: number, active: boolean): HTMLElement {
  ensureDefs();
  let proto = protos.get(key);
  if (!proto) {
    proto = document.createElementNS(NS, "svg");
    proto.setAttribute("viewBox", logoOf(key)!.viewBox);
    proto.setAttribute("aria-hidden", "true");
    proto.innerHTML = logoOf(key)!.body;
    protos.set(key, proto);
  }
  const tile = document.createElement("span");
  tile.className = "brand-tile brand-logo";
  tile.dataset.logo = key;
  tile.style.width = tile.style.height = `${size}px`;
  tile.append(proto.cloneNode(true));
  setLogoActive(tile, active);
  return tile;
}

/** 로고의 움직임을 켜고 끈다. 로고가 아닌 타일에는 아무 일도 하지 않는다. */
export function setLogoActive(tile: Element, active: boolean): void {
  if (!(tile instanceof HTMLElement) || !tile.classList.contains("brand-logo")) return;
  const on = active && !stillness.matches;
  if (on === tile.hasAttribute("data-active")) return;
  tile.toggleAttribute("data-active", on);
  if (!on) {
    const existing = tile.querySelector<HTMLElement>(".logo-strip");
    if (existing) {
      activeStrips.delete(existing);
      existing.remove();
    }
    return;
  }
  const key = tile.dataset.logo!;
  let strip = strips.get(key);
  if (!strip) {
    strip = bake(key).then((url) => {
      if (url) strips.set(key, url);
      return url;
    });
    strips.set(key, strip);
  }
  if (typeof strip === "string") play(tile, key, strip);
  else void strip.then((url) => url && play(tile, key, url));
}
