// 터미널 화면의 기호 글꼴. 휴대폰에는 Nerd Font 아이콘(사설 영역)이나 ⏵ 같은 기술 기호를 가진 글꼴이 없어 □ 로 나온다.
// 이 PC 에 깔린 글꼴을 찾아 그대로 내준다 — 저장소에 글꼴을 싣지 않는다. 화면은 unicode-range 로 그 글자가 나올 때만
// 받아 가고, 한 번 받으면 캐시에 둔다. 없으면 404 이고, 화면은 기기의 글꼴로 그린다(지금과 같다).
import { readdir } from "node:fs/promises";
import { brotliCompressSync, constants as zlibConstants } from "node:zlib";
import { homedir } from "node:os";
import { extname, join } from "node:path";

/** 앞의 것일수록 먼저 고른다. 아이콘은 한 칸 폭(Mono)판이 터미널 칸에 맞는다. */
const WANTED: Record<string, RegExp[]> = {
  nerd: [/^SymbolsNerdFontMono-Regular\.(ttf|otf)$/i, /^JetBrainsMonoNerdFontMono-Regular\.(ttf|otf)$/i, /^SymbolsNerdFont-Regular\.(ttf|otf)$/i, /^JetBrainsMonoNerdFont-Regular\.(ttf|otf)$/i, /NerdFontMono-Regular\.(ttf|otf)$/i, /NerdFont-Regular\.(ttf|otf)$/i],
  // 모든 글자가 한 칸 폭인 글꼴이 먼저다.
  symbols: [/^AdwaitaMono-Regular\.(ttf|otf)$/i, /^NotoSansSymbols2-Regular\.(ttf|otf)$/i],
};

function fontDirs(): string[] {
  const home = homedir();
  return ["/usr/share/fonts", "/usr/local/share/fonts", join(home, ".local/share/fonts"), join(home, ".fonts"), join(home, "Library/Fonts"), "/Library/Fonts"];
}

async function walk(dir: string, depth: number, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const path = join(dir, e.name);
    if (e.isDirectory()) {
      if (depth > 0) await walk(path, depth - 1, out);
    } else if (/\.(ttf|otf)$/i.test(e.name)) out.push(path);
  }
}

let found: Promise<Record<string, string | undefined>> | undefined;

/** 글꼴 폴더를 한 번 훑어 고를 파일을 정해 둔다. */
function locate(): Promise<Record<string, string | undefined>> {
  found ??= (async () => {
    const files: string[] = [];
    for (const dir of fontDirs()) await walk(dir, 3, files);
    const pick: Record<string, string | undefined> = {};
    for (const [name, patterns] of Object.entries(WANTED)) {
      for (const re of patterns) {
        pick[name] = files.find((f) => re.test(f.slice(f.lastIndexOf("/") + 1)));
        if (pick[name]) break;
      }
    }
    return pick;
  })();
  return found;
}

interface Served {
  br: Uint8Array<ArrayBuffer>;
  gz: Uint8Array<ArrayBuffer>;
  path: string;
  headers: Record<string, string>;
}

const served = new Map<string, Promise<Served | undefined>>();

/** 처음 받으러 올 때 한 번 압축해 둔다(Nerd Font 2.6MB → br 1.3MB, 0.1초쯤). 압축을 못 받는 쪽에는 파일을 그대로 흘린다. */
function load(name: string): Promise<Served | undefined> {
  let p = served.get(name);
  if (!p) {
    p = (async () => {
      const path = (await locate())[name];
      if (!path) return undefined;
      const raw = new Uint8Array(await Bun.file(path).arrayBuffer());
      const headers = {
        "content-type": extname(path).toLowerCase() === ".otf" ? "font/otf" : "font/ttf",
        "x-content-type-options": "nosniff",
        "cache-control": "public, max-age=604800",
        etag: `"${Bun.hash(raw).toString(16)}"`,
        vary: "accept-encoding",
      };
      const br = new Uint8Array(brotliCompressSync(raw, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 5 } }));
      return { br, gz: Bun.gzipSync(raw, { level: 6 }), path, headers };
    })();
    served.set(name, p);
  }
  return p;
}

/** /font/nerd, /font/symbols — 비밀이 아니므로 열쇠를 요구하지 않는다(CSS 가 부르는 주소에는 열쇠를 실을 수 없다). */
export function fontRoutes(): Record<string, { GET: (req: Request) => Promise<Response> }> {
  const routes: Record<string, { GET: (req: Request) => Promise<Response> }> = {};
  for (const name of Object.keys(WANTED)) {
    routes[`/font/${name}`] = {
      GET: async (req) => {
        const font = await load(name);
        if (!font) return new Response("no such font on this machine", { status: 404, headers: { "cache-control": "no-store" } });
        if (req.headers.get("if-none-match") === font.headers.etag) return new Response(null, { status: 304, headers: font.headers });
        const accepts = req.headers.get("accept-encoding") ?? "";
        if (/\bbr\b/.test(accepts)) return new Response(font.br, { headers: { ...font.headers, "content-encoding": "br" } });
        if (/\bgzip\b/.test(accepts)) return new Response(font.gz, { headers: { ...font.headers, "content-encoding": "gzip" } });
        return new Response(Bun.file(font.path), { headers: font.headers });
      },
    };
  }
  return routes;
}
