// 입력창에 붙여넣은 이미지를 맡아 두는 곳.
//
// 브라우저(휴대폰일 수도 있다)의 이미지를 에이전트가 읽으려면 이 PC 의 파일이어야 한다. 받은 바이트를 캐시
// 폴더에 적고, 지시를 보낼 때 그 경로를 pane 에 넣는다. 이름은 서버가 짓고, 내용이 실제로 이미지인지는
// 첫 바이트로 확인한다 — 요청이 준 이름이나 형식은 믿지 않는다.
import { mkdir, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_IMAGES = 8;
/** 이보다 오래된 이미지는 다음 업로드 때 지운다. */
const KEEP_MS = 7 * 24 * 3600_000;
const NAME = /^[0-9a-z]{6,12}-[0-9a-f]{12}\.(png|jpg|gif|webp)$/;

function dir(): string {
  return join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "agent-world", "images");
}

function sniff(b: Uint8Array): "png" | "jpg" | "gif" | "webp" | null {
  const at = (offset: number, ...bytes: number[]) => bytes.every((v, i) => b[offset + i] === v);
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "png";
  if (at(0, 0xff, 0xd8, 0xff)) return "jpg";
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return "gif";
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "webp";
  return null;
}

async function prune(): Promise<void> {
  const cutoff = Date.now() - KEEP_MS;
  for (const name of await readdir(dir()).catch(() => [] as string[])) {
    if (!NAME.test(name)) continue;
    const path = join(dir(), name);
    try {
      if ((await stat(path)).mtimeMs < cutoff) await unlink(path);
    } catch {
      // 그새 사라졌으면 그만이다.
    }
  }
}

/** 이미지를 적어 두고 그 이름을 돌려준다. PNG·JPEG·GIF·WebP 가 아니면 null. */
export async function saveImage(bytes: Uint8Array): Promise<string | null> {
  const ext = sniff(bytes);
  if (!ext) return null;
  await mkdir(dir(), { recursive: true, mode: 0o700 });
  void prune();
  const random = [...crypto.getRandomValues(new Uint8Array(6))].map((v) => v.toString(16).padStart(2, "0")).join("");
  const name = `${Date.now().toString(36)}-${random}.${ext}`;
  await writeFile(join(dir(), name), bytes, { mode: 0o600 });
  return name;
}

/** 맡아 둔 이미지의 경로. 이 서버가 지은 이름이 아니거나 파일이 없으면 null. */
export async function imagePath(name: string): Promise<string | null> {
  if (!NAME.test(name)) return null;
  const path = join(dir(), name);
  try {
    return (await stat(path)).isFile() ? path : null;
  } catch {
    return null;
  }
}
