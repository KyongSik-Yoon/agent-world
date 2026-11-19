// 터미널 미러의 글꼴을 사용자의 터미널(ghostty) 설정에 맞춘다.
//
// 색만 맞추고 글꼴은 따로 두면 같은 화면이 다른 글씨로 보인다 — 한글은 다른 글꼴을 두 칸에 늘려 성기고, 굵은 글씨는
// 터미널보다 두껍다. ghostty 설정의 font-family(차례대로 대체 글꼴), font-family-bold, font-variation-bold 의 wght,
// font-codepoint-map(글자 범위별 글꼴)을 읽어, 그 글꼴 파일을 이 PC 에서 찾아 내주고 그것을 쓰는 CSS 를 만든다.
// 휴대폰처럼 그 글꼴이 없는 기기도 같은 글씨가 된다. 설정이 없거나 fontconfig(fc-match)가 없으면 빈 CSS 다 — 화면은
// 스타일시트의 기본 글꼴을 쓴다.
import { brotliCompressSync, constants as zlibConstants } from "node:zlib";
import { extname } from "node:path";

import { ghosttyEntries } from "./termtheme.ts";

/** 이보다 큰 글꼴(한중일 통합 글꼴 등)은 내주지 않는다 — 이 PC 에서는 이름으로 쓰고, 다른 기기는 기본 글꼴로 돌아간다. */
const MAX_FONT_BYTES = 8 * 1024 * 1024;
/** 글자 범위별 글꼴은 이만큼까지만 받는다. */
const MAX_MAPS = 16;

interface Face {
  path: string;
}

interface TermFonts {
  css: string;
  /** 주소의 번호 → 글꼴 파일. */
  files: Face[];
}

/** fontconfig 로 그 이름의 글꼴 파일을 찾는다. 없는 이름에는 fc-match 가 아무 글꼴이나 돌려주므로 이름을 맞춰 본다. */
async function fcMatch(family: string, bold: boolean): Promise<string | undefined> {
  try {
    const proc = Bun.spawn(["fc-match", "-f", "%{file}\n%{family}", `${family.replace(/[:,\\-]/g, "\\$&")}${bold ? ":bold" : ""}`], { stdout: "pipe", stderr: "ignore" });
    const [file, families] = (await new Response(proc.stdout).text()).split("\n");
    if ((await proc.exited) !== 0 || !file) return undefined;
    return (families ?? "").split(",").some((f) => f.trim().toLowerCase() === family.toLowerCase()) ? file : undefined;
  } catch {
    return undefined;
  }
}

/** 브라우저에 내줄 수 있는 파일인지: 글꼴 하나짜리 ttf·otf 이고 너무 크지 않은 것. */
function servable(path: string | undefined): path is string {
  return path !== undefined && /\.(ttf|otf)$/i.test(path) && Bun.file(path).size <= MAX_FONT_BYTES;
}

const quote = (name: string): string => `"${name.replace(/["\\]/g, "")}"`;
const RANGES = /^U\+[0-9A-F]{1,6}(-U\+[0-9A-F]{1,6})?(,U\+[0-9A-F]{1,6}(-U\+[0-9A-F]{1,6})?)*$/i;

async function build(): Promise<TermFonts> {
  const regular: string[] = [];
  const bold: string[] = [];
  const maps: Array<{ ranges: string; family: string }> = [];
  let boldWeight: number | undefined;
  for (const [key, value] of await ghosttyEntries()) {
    // 빈 값은 그때까지 적은 목록을 비운다(ghostty 의 규칙).
    if (key === "font-family") value ? regular.push(value) : (regular.length = 0);
    else if (key === "font-family-bold") value ? bold.push(value) : (bold.length = 0);
    else if (key === "font-variation-bold") {
      const m = /^wght\s*=\s*(\d+(?:\.\d+)?)$/.exec(value);
      if (m && Number(m[1]) >= 100 && Number(m[1]) <= 900) boldWeight = Number(m[1]);
    } else if (key === "font-codepoint-map") {
      const eq = value.lastIndexOf("=");
      const ranges = value.slice(0, eq).replace(/\s+/g, "");
      if (eq > 0 && RANGES.test(ranges)) maps.push({ ranges: ranges.replace(/-U\+/gi, "-"), family: value.slice(eq + 1).trim() });
    }
  }
  if (regular.length === 0) return { css: "", files: [] };

  const files: Face[] = [];
  const face = (alias: string, path: string, rest: string): string => {
    files.push({ path });
    return `@font-face{font-family:${quote(alias)};src:url("term/${files.length - 1}");font-display:swap;${rest}}`;
  };
  const rules: string[] = [];
  const stack: string[] = [];
  // 글자 범위별 글꼴이 먼저다. 같은 글자를 두 줄이 가리키면 뒤에 적은 줄이 이긴다 — 뒤의 것을 앞에 세운다.
  for (const [i, map] of maps.slice(-MAX_MAPS).entries()) {
    const path = await fcMatch(map.family, false);
    if (!servable(path)) continue;
    rules.push(face(`AW Term Map ${i}`, path, `unicode-range:${map.ranges}`));
    stack.unshift(quote(`AW Term Map ${i}`));
  }
  // 대체 글꼴의 차례대로. 굵은 글씨는 같은 자리의 굵은 글꼴로 — 굵기 500–900 을 다 맡겨, 가변 글꼴이면 설정한 굵기(wght)로 그려진다.
  for (const [i, family] of regular.entries()) {
    const path = await fcMatch(family, false);
    if (servable(path)) {
      rules.push(face(`AW Term ${i}`, path, "font-weight:100 499"));
      const heavy = bold[i] ? await fcMatch(bold[i], true) : undefined;
      rules.push(face(`AW Term ${i}`, servable(heavy) ? heavy : path, "font-weight:500 900"));
      stack.push(quote(`AW Term ${i}`));
    }
    // 내주지 못한 글꼴도 이 PC 에서는 이름으로 잡힌다.
    stack.push(quote(family));
  }
  const vars = [`--term-mono:${stack.join(",")},var(--mono)`, ...(boldWeight ? [`--term-bold:${boldWeight}`] : [])];
  return { css: `${rules.join("\n")}\n:root{${vars.join(";")}}\n`, files };
}

let fonts: Promise<TermFonts> | undefined;
const packedFiles = new Map<string, Promise<{ br: Uint8Array<ArrayBuffer>; raw: Uint8Array<ArrayBuffer>; headers: Record<string, string> }>>();

/** /font/term.css 와 /font/term/<번호>. 글꼴은 비밀이 아니고 CSS 가 부르는 주소에는 열쇠를 실을 수 없어 열쇠를 요구하지 않는다. */
export function termFontRoutes(): Record<string, { GET: (req: Request) => Promise<Response> }> {
  return {
    "/font/term.css": {
      GET: async () => {
        // 설정은 서버를 띄울 때의 것을 쓴다(글꼴을 바꿨으면 서버를 다시 띄운다).
        const { css } = await (fonts ??= build());
        return new Response(css, { headers: { "content-type": "text/css; charset=utf-8", "x-content-type-options": "nosniff", "cache-control": "no-cache" } });
      },
    },
    "/font/term/*": {
      GET: async (req) => {
        const n = Number(new URL(req.url).pathname.slice("/font/term/".length));
        const path = (await (fonts ??= build())).files[n]?.path;
        if (!path) return new Response("no such font", { status: 404, headers: { "cache-control": "no-store" } });
        let packed = packedFiles.get(path);
        if (!packed) {
          packed = (async () => {
            const raw = new Uint8Array(await Bun.file(path).arrayBuffer());
            const headers = {
              "content-type": extname(path).toLowerCase() === ".otf" ? "font/otf" : "font/ttf",
              "x-content-type-options": "nosniff",
              "cache-control": "public, max-age=86400",
              etag: `"${Bun.hash(raw).toString(16)}"`,
              vary: "accept-encoding",
            };
            return { raw, br: new Uint8Array(brotliCompressSync(raw, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 5 } })), headers };
          })();
          packedFiles.set(path, packed);
        }
        const font = await packed;
        if (req.headers.get("if-none-match") === font.headers.etag) return new Response(null, { status: 304, headers: font.headers });
        if (/\bbr\b/.test(req.headers.get("accept-encoding") ?? "")) return new Response(font.br, { headers: { ...font.headers, "content-encoding": "br" } });
        return new Response(font.raw, { headers: font.headers });
      },
    },
  };
}
