// 이 herdr 세션에 떠 있는 Agent World 의 주소를 찍는다(`bun run url`). 떠 있지 않으면 아무것도 찍지 않고 1 로 끝난다.
//
// 찍는 주소에는 접속 열쇠가 붙어 있다(`…/#k=열쇠`). 브라우저마다 처음 한 번은 이 주소로 열어야 한다.
//   xdg-open "$(bun run --silent url)"      ← 열쇠가 잠깐 프로세스 목록에 보인다. 혼자 쓰는 PC 가 아니면 주소를 복사해 붙여 넣는다.
import { runningServers } from "./address.ts";
import { existingKey, keyedUrl } from "./key.ts";

const [first] = await runningServers();
const key = await existingKey();
if (!first || !key) process.exit(1);
console.log(keyedUrl(first.url, key));
