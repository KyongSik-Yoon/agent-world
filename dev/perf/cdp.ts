// 프레임 검사가 크롬을 모는 작은 CDP 클라이언트. 의존성을 늘리지 않으려고 직접 쓴다.
export class CDP {
  private id = 0;
  private readonly pending = new Map<number, (m: { error?: { message: string }; result?: unknown }) => void>();
  private readonly handlers = new Map<string, (params: any) => void>();

  private constructor(private readonly ws: WebSocket) {
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data));
      if (m.id) {
        this.pending.get(m.id)?.(m);
        this.pending.delete(m.id);
      } else this.handlers.get(m.method)?.(m.params);
    };
  }

  static async connect(url: string): Promise<CDP> {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = reject;
    });
    return new CDP(ws);
  }

  send<T = any>(method: string, params: object = {}): Promise<T> {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) =>
      this.pending.set(id, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result as T))),
    );
  }

  /** 이벤트 하나에 처리기 하나 — 다시 부르면 바꾼다. */
  on(method: string, handler: (params: any) => void): void {
    this.handlers.set(method, handler);
  }

  async eval<T = any>(expression: string): Promise<T> {
    const r = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`페이지에서 실패: ${JSON.stringify(r.exceptionDetails.exception?.description ?? r.exceptionDetails)}`);
    return r.result.value as T;
  }

  close(): void {
    this.ws.close();
  }
}
