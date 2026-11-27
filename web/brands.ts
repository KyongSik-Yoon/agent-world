// 벤더(하네스)별 브랜드 표식. 24×24 단일 경로 글리프와 타일 색.
//
// 글리프(Codex·pi·opencode·oh-my-pi·Grok·Muse)와 타일 색은 Collie(MIT, © 2026 Altan Sarisin)의
// web/src/components/agent-icon-data.ts 에서 가져왔다. 각 마크는 해당 프로젝트의 것이고, 여기서는 어떤 하네스인지
// 알리는 데만 쓴다. Claude 와 Antigravity 는 글리프 대신 직접 만든 로고를 쓴다(logos.ts).

import { hasLogo, logoTile } from "./logos.ts";

export interface Brand {
  name: string;
  /** 타일 배경 — 브랜드 색. */
  bg: string;
  /** 타일 위 마크 색. */
  fg: string;
  /** 우리 바탕 위에 칠할 때의 브랜드 색. 검정 계열 브랜드에는 없다. */
  accent?: string;
  mode: "fill" | "stroke";
  grad?: string[];
  /** 24×24 글리프. 직접 만든 로고를 쓰는 벤더에는 없다. */
  d?: string;
}

const BRANDS: Record<string, Brand> = {
  "claude": {
    "name": "Claude Code",
    "bg": "#D97757",
    "fg": "#FFFFFF",
    "accent": "#D97757",
    "mode": "fill"
  },
  "codex": {
    "name": "Codex",
    "bg": "#000000",
    "fg": "#FFFFFF",
    "mode": "fill",
    "d": "M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z"
  },
  "pi": {
    "name": "pi",
    "bg": "#09090B",
    "fg": "#FFFFFF",
    "mode": "fill",
    "d": "M0 0v24h6v-6h6v-6H6V6h6v6h6V0Zm18 12v12h6V12Z"
  },
  "opencode": {
    "name": "opencode",
    "bg": "#080808",
    "fg": "#FFFFFF",
    "mode": "stroke",
    "d": "M8.75 8.75V2.75H21.25V15.25H15.25M15.25 8.75H2.75V21.25H15.25V8.75Z"
  },
  "agy": {
    "name": "Antigravity",
    "bg": "#1A73E8",
    "fg": "#FFFFFF",
    "accent": "#1A73E8",
    "mode": "fill"
  },
  "omp": {
    "name": "oh-my-pi",
    "bg": "#0F0A14",
    "fg": "#9B4DFF",
    "accent": "#9B4DFF",
    "mode": "fill",
    "grad": [
      "#ED4ABF",
      "#9B4DFF",
      "#5AD8E6"
    ],
    "d": "M1.2 0h21.6v4.8h-6v19.2h-4.8V4.8H8.4v13.2H3.6V4.8H1.2z"
  },
  "grok": {
    "name": "Grok",
    "bg": "#050505",
    "fg": "#FCFCFC",
    "mode": "fill",
    "d": "M9.269 15.406L17.248 9.263C17.639 8.962 18.198 9.079 18.384 9.547C19.365 12.014 18.927 14.978 16.976 17.014C15.024 19.049 12.308 19.496 9.826 18.479L7.115 19.788C11.004 22.56 15.726 21.875 18.677 18.795C21.018 16.354 21.743 13.026 21.065 10.025L21.071 10.032C20.088 5.624 21.313 3.862 23.822 0.258C23.881 0.173 23.941 0.088 24 0L20.699 3.443V3.432L9.267 15.408ZM7.623 16.898C4.831 14.118 5.312 9.814 7.694 7.332C9.455 5.495 12.341 4.746 14.86 5.848L17.565 4.545C17.078 4.178 16.453 3.783 15.736 3.505C12.497 2.114 8.618 2.806 5.984 5.551C3.451 8.193 2.654 12.255 4.022 15.722C5.044 18.312 3.369 20.145 1.681 21.994C1.083 22.65 0.483 23.306 0 24L7.62 16.901Z"
  },
  "muse": {
    "name": "Muse",
    "bg": "#FFFFFF",
    "fg": "#0064E0",
    "accent": "#0064E0",
    "mode": "fill",
    "grad": [
      "#0040DC",
      "#0064E0",
      "#0082FB"
    ],
    "d": "M5.91 3.869C6.777 3.869 7.396 4.546 7.396 5.607C7.396 6.669 7.225 7.626 6.941 9.659C6.738 11.084 6.389 13.258 6.243 14.162C6.523 13.628 7.178 12.378 7.294 12.144C8.666 9.375 10.096 6.901 10.508 6.246C11.054 5.372 11.535 5.021 12.278 5.021C12.664 5.022 13.124 5.217 13.352 5.477C13.66 5.829 13.725 6.398 13.714 7.019C13.698 7.97 13.574 9.486 13.405 11.177C13.33 11.929 13.185 13.466 13.087 14.496C13.965 12.925 15.591 10.035 16.246 9.025C16.817 8.146 17.392 7.579 18.164 7.579C18.83 7.579 19.651 8.05 19.603 9.302C19.531 11.149 19.264 15.174 19.143 16.979C19.96 15.79 21.033 14.029 21.436 13.367C21.842 12.698 22.26 12.157 22.894 12.139C23.544 12.12 23.979 12.562 23.999 13.244C24.019 13.927 23.612 14.694 23.072 15.565C22.486 16.511 21.831 17.523 21.033 18.468C20.236 19.413 19.502 20.131 18.384 20.131C17.382 20.131 16.677 19.465 16.628 18.246C16.602 17.607 16.723 16.234 16.814 15.16C16.92 13.917 17.048 12.717 17.137 11.923C16.256 13.535 14.402 16.912 13.568 18.23C12.752 19.52 12.355 19.974 11.493 19.975C10.631 19.975 10.253 19.354 10.241 18.42C10.227 17.407 10.988 11.324 11.246 9.297C10.828 10.191 9.801 12.385 9.157 13.69C8.534 14.953 7.489 17.135 6.73 18.393C6.184 19.298 5.57 19.975 4.66 19.975C3.75 19.975 3.236 19.363 3.236 18.379C3.236 17.395 3.521 15.756 3.827 13.723C3.98 12.739 4.155 11.667 4.352 10.53C4.496 9.708 4.746 8.26 4.9 7.371C4.2 8.461 2.941 10.423 2.558 11.014C2.131 11.671 1.749 12.15 1.115 12.15C0.416 12.15 0 11.605 0 10.971C0 10.337 0.322 9.848 0.846 8.988C1.518 7.883 2.726 6.377 3.388 5.586C4.168 4.654 4.947 3.869 5.91 3.869Z"
  }
};

const FALLBACK: Brand & { d: string } = {
  name: "Agent",
  bg: "#5B6478",
  fg: "#FFFFFF",
  mode: "fill",
  d: "M5 3.5h14A3.5 3.5 0 0 1 22.5 7v8a3.5 3.5 0 0 1-3.5 3.5h-6.5L7 22.5v-4H5A3.5 3.5 0 0 1 1.5 15V7A3.5 3.5 0 0 1 5 3.5zM6.5 9a1 1 0 0 0 0 2h11a1 1 0 0 0 0-2zM6.5 13a1 1 0 0 0 0 2h6a1 1 0 0 0 0-2z",
};

export function brandKey(vendor: string): string {
  const v = vendor.toLowerCase();
  if (v.startsWith("claude")) return "claude";
  if (v.startsWith("agy") || v.startsWith("antigravity")) return "agy";
  if (v.startsWith("codex")) return "codex";
  return v;
}

export function brandFor(vendor: string): Brand {
  return BRANDS[brandKey(vendor)] ?? { ...FALLBACK, name: vendor || FALLBACK.name };
}

/** Claude 의 모델 계열 — 캐릭터의 체급을 가른다: 작고 빠른 haiku, 조금 작은 sonnet, 기본 크기의 opus, 가장 크고 반짝이는 fable. */
export type ClaudeTier = "fable" | "opus" | "sonnet" | "haiku";
export function claudeTier(model: string | undefined): ClaudeTier | undefined {
  const m = /fable|mythos|opus|sonnet|haiku/.exec(model?.toLowerCase() ?? "")?.[0];
  return m === "mythos" ? "fable" : (m as ClaudeTier | undefined);
}

/**
 * Antigravity(Gemini 4) 모델 계열 — 원소 체급(빠름→깊음: flash < hydrogen < argon < neon < carbon)과 Orchestrator 여부.
 * 원소 이름이 없는 Orchestrator(`gemini-pro-orchestrator`)는 Carbon 기반이다.
 */
export type AgyTier = "flash" | "hydrogen" | "argon" | "neon" | "carbon";
export interface AgyLook {
  tier?: AgyTier;
  orchestrator: boolean;
}
export function agyLook(model: string | undefined): AgyLook {
  const m = model?.toLowerCase() ?? "";
  const orchestrator = m.includes("orchestrator");
  const found = /carbon|neon|argon|hydrogen|flash/.exec(m)?.[0] as AgyTier | undefined;
  return { tier: found ?? (orchestrator ? "carbon" : undefined), orchestrator };
}

/** 캐릭터의 차림을 가르는 것: Code Mode 로 떴는지, 어느 모델인지. AgentView 를 그대로 넘기면 된다. */
export interface Look {
  vendor: string;
  codeMode?: boolean;
  model?: string;
}

/** 그 차림의 타일 열쇠(logos.ts). 차림이 바뀌었는지도 이것으로 견준다. */
export function tileLook(a: Look): string {
  const key = brandKey(a.vendor);
  if (key === "claude") {
    const tier = claudeTier(a.model);
    // opus 는 모르는 모델과 같은 기본 모습이다.
    return `claude${a.codeMode ? "-code" : ""}${tier && tier !== "opus" ? `+${tier}` : ""}`;
  }
  if (key === "agy") {
    const { tier, orchestrator } = agyLook(a.model);
    return `agy${orchestrator ? "-orch" : ""}${tier ? `+${tier}` : ""}`;
  }
  return key;
}

/** 브랜드 타일을 SVG 요소로 만든다(로스터 행, 상세 패널 머리). working 이면 직접 만든 로고가 움직인다. look 을 주면 그 주민의 차림을 한다. */
export function brandTile(vendor: string, size: number, working = false, look?: Look): Element {
  const key = look ? tileLook(look) : brandKey(vendor);
  if (hasLogo(key)) return logoTile(key, size, working);
  const brand = brandFor(vendor);
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.classList.add("brand-tile");
  const rect = document.createElementNS(ns, "rect");
  rect.setAttribute("width", "24");
  rect.setAttribute("height", "24");
  rect.setAttribute("rx", "6");
  rect.setAttribute("fill", brand.bg);
  const g = document.createElementNS(ns, "g");
  g.setAttribute("transform", "translate(12 12) scale(0.62) translate(-12 -12)");
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", brand.d ?? FALLBACK.d);
  if (brand.mode === "stroke") {
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", brand.fg);
    path.setAttribute("stroke-width", "2");
  } else {
    path.setAttribute("fill", brand.fg);
  }
  g.append(path);
  svg.append(rect, g);
  return svg;
}
