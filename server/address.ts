// 떠 있는 서버의 주소를 적어 두고 찾는 곳.
//
// 서버는 제 포트가 차 있으면 옆 포트로 옮겨 뜨고, herdr 가 플러그인으로 대신 띄우면 그 출력은 아무도 보지 않는다.
// 그래서 서버가 뜰 때 주소를 상태 폴더에 적어 두고, 주소가 필요한 쪽(`bun run url`, 플러그인 동작)이 여기서 읽는다.
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { herdrSessionTag } from "./herdr.ts";
import { stateDir } from "./seen.ts";

export interface Address {
  url: string;
  port: number;
  pid: number;
  socket: string;
  session: string | null;
  readonly: boolean;
}

/** 서버가 제 주소를 적어 두는 파일 — herdr 세션마다, 그리고 조작용과 보기 전용이 따로. */
export function addressFile(readonly: boolean): string {
  const tag = herdrSessionTag();
  return join(stateDir(), `server${tag ? `-${tag}` : ""}${readonly ? ".readonly" : ""}.json`);
}

/**
 * 이 herdr 세션에 지금 떠 있는 서버들(조작용 먼저, 그다음 보기 전용). 적어 둔 뒤에 죽었을 수 있으므로,
 * 정말 그 주소에서 이 세션의 서버가 답하는 것만 돌려준다.
 */
export async function runningServers(): Promise<Address[]> {
  const found: Address[] = [];
  for (const readonly of [false, true]) {
    try {
      const address = JSON.parse(await readFile(addressFile(readonly), "utf8")) as Address;
      const res = await fetch(`${address.url}/api/identity`, { signal: AbortSignal.timeout(1000) });
      const identity = (await res.json()) as { app?: string; socket?: string };
      if (identity.app === "agent-world" && identity.socket === address.socket) found.push(address);
    } catch {
      // 적어 둔 것이 없거나 답이 없다.
    }
  }
  return found;
}
