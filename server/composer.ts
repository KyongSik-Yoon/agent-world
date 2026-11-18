// 하네스 화면에서 입력창을 읽는다. 월드가 입력창에 무엇을 넣기 전후로, 거기에 무엇이 들어 있는지 보는 데 쓴다.

/** Claude Code 입력창의 위아래 가로줄. */
const RULE = /^\s*─{20,}/;

export function squash(s: string): string {
  return s.replace(/\s+/g, "");
}

/** Claude Code 화면에서 입력창(맨 아래 가로줄 두 개 사이)의 글. 아직 그리지 않았으면 undefined. */
export function claudeComposer(screen: string): string | undefined {
  const lines = screen.split("\n");
  const rules = lines.flatMap((l, i) => (RULE.test(l) ? [i] : []));
  if (rules.length < 2) return undefined;
  return lines.slice(rules[rules.length - 2]! + 1, rules[rules.length - 1]).join("\n");
}
