// 서버의 조작 엔드포인트를 부르는 얇은 층. 실패는 사람이 읽을 메시지와 herdr 의 오류 코드를 함께 던진다.
import { lang, t } from "./i18n.ts";
import { key } from "./key.ts";

/** 요청마다 싣는 머리말: 접속 열쇠와, 서버가 오류 문장을 이 화면의 말로 돌려주도록 고른 말. */
export function headers(): Record<string, string> {
  return { "x-agent-world-key": key, "x-agent-world-lang": lang };
}

/** 이 브라우저의 열쇠가 서버에 통하는지. 서버에 닿지 못하면 null. */
export async function hasAccess(): Promise<boolean | null> {
  try {
    const res = await fetch("/api/identity", { headers: headers() });
    return res.status !== 401;
  } catch {
    return null;
  }
}

/** 서버가 지금 내주는 화면의 판. 알 수 없으면(개발 중이거나 닿지 못하면) undefined. */
export async function serverBuild(): Promise<string | undefined> {
  try {
    const res = await fetch("/api/identity", { headers: headers() });
    return res.ok ? ((await res.json()) as { build?: string }).build : undefined;
  } catch {
    return undefined;
  }
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

/** keepalive 는 페이지가 닫히는 중에도 요청을 마저 보낸다(pagehide). */
export async function post<T = Record<string, unknown>>(path: string, body: Record<string, unknown>, keepalive = false): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { method: "POST", headers: { "content-type": "application/json", ...headers() }, body: JSON.stringify(body), keepalive });
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
    res = await fetch(`/api/image?pane=${encodeURIComponent(paneId)}`, { method: "POST", headers: { "content-type": "application/octet-stream", ...headers() }, body: image });
  } catch {
    throw new ApiError(t("서버에 닿지 못했습니다."));
  }
  const data = (await res.json().catch(() => ({}))) as { id?: string; error?: string; code?: string };
  if (!res.ok || !data.id) throw new ApiError(data.error ?? `HTTP ${res.status}`, data.code, res.status);
  return data.id;
}

export async function get<T>(path: string): Promise<T> {
  const res = await fetch(path, { headers: headers() });
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

function enqueue(paneId: string, run: () => Promise<unknown>): Promise<void> {
  const next = (queues.get(paneId) ?? Promise.resolve()).catch(() => {}).then(async () => {
    await run();
  });
  queues.set(paneId, next);
  return next;
}

/** pane 에 입력을 보낸다. 같은 pane 으로 가는 입력은 보낸 순서대로 하나씩 처리한다. */
export function sendInput(paneId: string, input: KeyInput): Promise<void> {
  return enqueue(paneId, () => post("/api/keys", { paneId, ...input }));
}

/**
 * 위로 넘겨 둔 앱 화면(스크롤백 없는 에이전트)을 맨 아래로 돌린다. 앞서 보낸 키 뒤에 간다. pages 는 이 화면이 넘긴 쪽 수 —
 * 화면에서 넘긴 정도를 읽을 수 없는 앱에만 쓴다.
 */
export function sendToBottom(paneId: string, pages: number): Promise<void> {
  return enqueue(paneId, () => post("/api/term/bottom", { paneId, pages }));
}
