// JSON-RPC do app-server do Codex: mensagens sem o campo "jsonrpc", uma por mensagem WebSocket. Separa
// respostas (dos nossos pedidos, ids numéricos), notificações (sem id) e pedidos do servidor (com id, que
// pode ser número ou string: a resposta precisa levar o id ORIGINAL).
export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'RpcError';
  }
}

interface Waiting {
  ok: (result: unknown) => void;
  fail: (err: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

type Rec = Record<string, unknown>;

function rec(v: unknown): Rec | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : undefined;
}

export class RpcPeer {
  private nextId = 1;
  private readonly waiting = new Map<number, Waiting>();
  private notificationCb?: (method: string, params: unknown) => void;
  private requestCb?: (id: number | string, method: string, params: unknown) => void;
  private closedReason?: string;
  private readonly timeoutMs: number;

  constructor(
    private readonly send: (text: string) => void,
    opts: { timeoutMs?: number } = {},
  ) {
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  /** Pedido nosso; rejeita com RpcError (code + message) quando o servidor responde erro. */
  request(method: string, params?: unknown): Promise<unknown> {
    if (this.closedReason !== undefined) return Promise.reject(new Error(`conexão encerrada: ${this.closedReason}`));
    const id = this.nextId++;
    return new Promise((ok, fail) => {
      const w: Waiting = { ok, fail };
      if (this.timeoutMs > 0) {
        w.timer = setTimeout(() => {
          this.waiting.delete(id);
          fail(new Error(`sem resposta para ${method} em ${this.timeoutMs} ms`));
        }, this.timeoutMs);
        w.timer.unref?.();
      }
      this.waiting.set(id, w);
      try {
        this.send(JSON.stringify(params === undefined ? { id, method } : { id, method, params }));
      } catch (err) {
        this.settle(id);
        fail(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.closedReason !== undefined) return;
    this.send(JSON.stringify(params === undefined ? { method } : { method, params }));
  }

  /** Resposta a um pedido do servidor (o primeiro que responder vence; um atrasado é ignorado por ele). */
  respond(id: number | string, result: unknown): void {
    if (this.closedReason !== undefined) return;
    this.send(JSON.stringify({ id, result }));
  }

  onNotification(cb: (method: string, params: unknown) => void): void {
    this.notificationCb = cb;
  }

  onRequest(cb: (id: number | string, method: string, params: unknown) => void): void {
    this.requestCb = cb;
  }

  /** Uma mensagem recebida (texto de um frame). JSON inválido ou formato desconhecido: ignorado. */
  handle(text: string): void {
    if (this.closedReason !== undefined) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return;
    }
    const m = rec(parsed);
    if (!m) return;
    const id = m.id;
    if (typeof m.method === 'string') {
      if (typeof id === 'number' || typeof id === 'string') this.requestCb?.(id, m.method, m.params);
      else if (id === undefined) this.notificationCb?.(m.method, m.params);
      return;
    }
    if (typeof id !== 'number') return;
    const w = this.settle(id);
    if (!w) return;
    const e = rec(m.error);
    if (e) w.fail(new RpcError(typeof e.code === 'number' ? e.code : 0, typeof e.message === 'string' ? e.message : 'erro do app-server', e.data));
    else w.ok(m.result);
  }

  /** Conexão caiu: rejeita os pedidos em aberto e ignora o que vier depois. */
  close(reason: string): void {
    if (this.closedReason !== undefined) return;
    this.closedReason = reason;
    const all = [...this.waiting.values()];
    this.waiting.clear();
    for (const w of all) {
      if (w.timer) clearTimeout(w.timer);
      w.fail(new Error(`conexão encerrada: ${reason}`));
    }
  }

  private settle(id: number): Waiting | undefined {
    const w = this.waiting.get(id);
    if (!w) return undefined;
    this.waiting.delete(id);
    if (w.timer) clearTimeout(w.timer);
    return w;
  }
}
