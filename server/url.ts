// 이 herdr 세션에 떠 있는 Agent World 의 주소를 찍는다(`bun run url`). 떠 있지 않으면 아무것도 찍지 않고 1 로 끝난다.
//
// 서버가 제 포트를 못 잡아 옆 포트로 옮겨 떴거나 herdr 가 대신 띄웠을 때, 주소를 알아내는 길이다:
//   xdg-open "$(bun run --silent url)"
import { readFile } from "node:fs/promises";

import { addressFile } from "./seen.ts";

interface Address {
  url: string;
  socket: string;
}

for (const readonly of [false, true]) {
  try {
    const address = JSON.parse(await readFile(addressFile(readonly), "utf8")) as Address;
    // 적어 둔 뒤에 죽었을 수 있다. 정말 그 주소에서 이 세션의 서버가 답하는지 본다.
    const res = await fetch(`${address.url}/api/identity`, { signal: AbortSignal.timeout(1000) });
    const identity = (await res.json()) as { app?: string; socket?: string };
    if (identity.app === "agent-world" && identity.socket === address.socket) {
      console.log(address.url);
      process.exit(0);
    }
  } catch {
    // 적어 둔 것이 없거나 답이 없다 — 다음 것을 본다.
  }
}
process.exit(1);
