// 서버의 조작 엔드포인트를 부르는 얇은 층. 실패는 사람이 읽을 메시지와 herdr 의 오류 코드를 함께 던진다.
import { lang, t } from "./i18n.ts";

/** 서버가 오류 문장을 이 화면의 말로 돌려주도록, 요청마다 고른 말을 알린다. */
export const LANG_HEADER = { "x-agent-world-lang": lang };

export class ApiError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export async function post<T = Record<string, unknown>>(path: string, body: Record<string, unknown>): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { method: "POST", headers: { "content-type": "application/json", ...LANG_HEADER }, body: JSON.stringify(body) });
  } catch {
    throw new ApiError(t("서버에 닿지 못했습니다."));
  }
  const data = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
  if (!res.ok) throw new ApiError(data.error ?? `HTTP ${res.status}`, data.code, res.status);
  return data as T;
}

/** 입력창에 붙인 이미지를 서버에 맡기고, 지시를 보낼 때 쓸 이름을 받는다. */
export async function uploadImage(paneId: string, image: Blob): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`/api/image?pane=${encodeURIComponent(paneId)}`, { method: "POST", headers: { "content-type": "application/octet-stream", ...LANG_HEADER }, body: image });
  } catch {
    throw new ApiError(t("서버에 닿지 못했습니다."));
  }
  const data = (await res.json().catch(() => ({}))) as { id?: string; error?: string; code?: string };
  if (!res.ok || !data.id) throw new ApiError(data.error ?? `HTTP ${res.status}`, data.code, res.status);
  return data.id;
}

export async function get<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: LANG_HEADER });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new ApiError(data.error ?? `HTTP ${res.status}`, undefined, res.status);
  return data as T;
}

export interface KeyInput {
  text?: string;
  keys?: string[];
  /** 제어 문자·이스케이프 시퀀스를 가공 없이 넣는다. */
  raw?: boolean;
}

const queues = new Map<string, Promise<void>>();

/** pane 에 입력을 보낸다. 같은 pane 으로 가는 입력은 보낸 순서대로 하나씩 처리한다. */
export function sendInput(paneId: string, input: KeyInput): Promise<void> {
  const next = (queues.get(paneId) ?? Promise.resolve()).catch(() => {}).then(async () => {
    await post("/api/keys", { paneId, ...input });
  });
  queues.set(paneId, next);
  return next;
}
