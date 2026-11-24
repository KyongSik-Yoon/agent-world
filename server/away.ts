// 휴대폰에서 앱이 가려졌다 돌아온 기록.
//
// 휴대폰은 가려진 앱을 메모리가 모자라면 내린다. 내려간 앱은 돌아올 때 문서를 처음부터 다시 읽어, 보던 자리가 사라진다.
// 얼마나 자주 그러는지는 화면만 안다 — 가려질 때 적어 둔 표식이 새 문서에서 발견되면 그사이에 내려간 것이다(사용자가 앱을
// 직접 닫았다 연 것도 같은 모양으로 남는다). 살아서 돌아온 횟수도 함께 적어야 비율을 낼 수 있다.
import { appendFile, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { ensureStateDir, stateDir, writePrivate } from "./key.ts";

/** 이만큼 넘으면 뒤쪽 절반만 남긴다. 한 줄이 100바이트 남짓이다. */
const MAX_BYTES = 256 * 1024;

export type AwayReport = { back: "alive" | "reloaded"; awayMs: number; discarded: boolean; nav: string };

export function asAwayReport(body: unknown): AwayReport | null {
  const b = body as Partial<AwayReport> | null;
  if ((b?.back !== "alive" && b?.back !== "reloaded") || typeof b.awayMs !== "number" || !Number.isFinite(b.awayMs) || b.awayMs < 0) return null;
  return { back: b.back, awayMs: b.awayMs, discarded: b.discarded === true, nav: typeof b.nav === "string" ? b.nav.slice(0, 16) : "" };
}

let writing: Promise<void> = Promise.resolve();

/** 한 줄 보탠다: 언제, 살아 돌아왔는지, 몇 초 가려져 있었는지, 어느 기기인지. */
export function recordAway(report: AwayReport, userAgent: string, version: string): Promise<void> {
  const line = JSON.stringify({
    at: new Date().toISOString(),
    back: report.back,
    awayS: Math.round(report.awayMs / 1000),
    discarded: report.discarded,
    nav: report.nav,
    device: /Android|iPhone|iPad/.exec(userAgent)?.[0] ?? "other",
    version,
  });
  writing = writing
    .then(async () => {
      await ensureStateDir();
      const path = join(stateDir(), "away.jsonl");
      const size = await stat(path).then(
        (s) => s.size,
        () => 0,
      );
      if (size > MAX_BYTES) {
        const lines = (await readFile(path, "utf8")).split("\n");
        await writePrivate(path, lines.slice(lines.length >> 1).join("\n"));
      }
      await appendFile(path, `${line}\n`, { mode: 0o600 });
    })
    .catch(() => {});
  return writing;
}
