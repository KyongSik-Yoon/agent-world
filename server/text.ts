// 서버가 사람에게 건네는 말. 화면마다 고른 말이 다를 수 있어서(한국어가 바탕, 영어를 고를 수 있다) 문장을 두 말로
// 함께 적어 두고, 건넬 때 고른다 — 요청에 답할 때는 그 요청이 알려 준 말로, 터미널에 찍을 때는 서버의 기본 말로.
export type Lang = "ko" | "en";

/** 두 말로 적은 문장. */
export interface Text {
  ko: string;
  en: string;
}

/** 서버의 기본 말. 화면이 따로 고르지 않았을 때와 터미널 출력에 쓴다. `AGENT_WORLD_LANG=en` 이면 영어. */
export const DEFAULT_LANG: Lang = process.env.AGENT_WORLD_LANG === "en" ? "en" : "ko";

export function L(ko: string, en: string): Text {
  return { ko, en };
}

/** 남이 만든 말(herdr 의 오류 문장, 예외의 메시지)은 옮길 수 없으니 두 말에 그대로 싣는다. */
export function asText(text: Text | string): Text {
  return typeof text === "string" ? { ko: text, en: text } : text;
}

export function say(text: Text | string, lang: Lang = DEFAULT_LANG): string {
  return typeof text === "string" ? text : text[lang];
}

/** 이 요청을 보낸 화면이 쓰는 말. 화면이 `x-agent-world-lang` 으로 알려 준다. */
export function langOf(req: Request): Lang {
  const asked = req.headers.get("x-agent-world-lang");
  return asked === "en" || asked === "ko" ? asked : DEFAULT_LANG;
}
