// 이 herdr 세션에 떠 있는 Agent World 의 주소를 찍는다(`bun run url`). 떠 있지 않으면 아무것도 찍지 않고 1 로 끝난다.
//
//   xdg-open "$(bun run --silent url)"
import { runningServers } from "./address.ts";

const [first] = await runningServers();
if (!first) process.exit(1);
console.log(first.url);
