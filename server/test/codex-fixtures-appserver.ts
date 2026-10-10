// App-server do Codex FALSO para os testes do cliente (e do serviço do canal paralelo): responde ao handshake
// WebSocket e fala JSON-RPC como o daemon do 0.160.1, sobre um par de streams em memória (o lado do proxy).
// Nenhum teste roda o codex nem abre socket. Ids e conteúdos sintéticos.
import { PassThrough } from 'node:stream';
import { acceptKey, encodeFrame, FrameDecoder, OP_CLOSE, OP_PING, OP_TEXT } from '../sources/codex/appserver/ws';

type Rec = Record<string, unknown>;
/** Um FakeHandler que devolve isto não responde (o pedido do cliente fica pendente). */
export const NO_REPLY = Symbol('sem resposta');
/** Resposta a um pedido do cliente: o `result`, NO_REPLY, ou lança (`rpcFail`) para responder erro JSON-RPC. */
export type FakeHandler = (params: Rec, msg: Rec) => unknown;

export class FakeAppServer {
  /** Bytes do servidor para o cliente: o `input` do CodexAppServerClient (o stdout do proxy). */
  readonly toClient = new PassThrough();
  /** Bytes do cliente para o servidor: o `output` do CodexAppServerClient (o stdin do proxy). */
  readonly fromClient = new PassThrough();
  /** Mensagens JSON recebidas do cliente (pedidos, notificações e respostas), na ordem. */
  readonly received: Rec[] = [];
  readonly handlers = new Map<string, FakeHandler>();
  /** Tudo o que chegou antes do 101 (o pedido de upgrade e qualquer byte mandado cedo demais). */
  head = '';
  /** O cliente mandou o frame de close. */
  clientClosed = false;
  private upgraded = false;
  private readonly decoder = new FrameDecoder();

  /** `handshake`: 'accept' (padrão) responde o 101 na hora; 'refuse' responde 403; 'manual' espera `acceptHandshake()`. */
  constructor(private readonly opts: { handshake?: 'accept' | 'refuse' | 'manual' } = {}) {
    this.handlers.set('initialize', () => ({ userAgent: 'codex-falso/0.160.1' }));
    this.handlers.set('thread/loaded/list', () => ({ data: [], nextCursor: null }));
    this.handlers.set('thread/resume', (p) => ({ thread: { id: p.threadId, source: 'cli' } }));
    this.handlers.set('thread/unsubscribe', () => ({ status: 'unsubscribed' }));
    this.fromClient.on('data', (c: Buffer) => this.onData(c));
  }

  /** Mensagens recebidas com este método. */
  calls(method: string): Rec[] {
    return this.received.filter((m) => m.method === method);
  }

  /** Respostas do cliente a pedidos do servidor (sem `method`). */
  responses(): Rec[] {
    return this.received.filter((m) => m.method === undefined && ('result' in m || 'error' in m));
  }

  notify(method: string, params: Rec): void {
    this.send({ method, params });
  }

  /** Pedido do servidor ao cliente (aprovação etc.), com o id como veio (número ou string). */
  request(id: number | string, method: string, params: Rec): void {
    this.send({ id, method, params });
  }

  ping(data = 'p'): void {
    this.toClient.write(encodeFrame(OP_PING, Buffer.from(data), { mask: false }));
  }

  /** Frame de close do servidor (1000). */
  closeWs(): void {
    this.toClient.write(encodeFrame(OP_CLOSE, Buffer.from([0x03, 0xe8]), { mask: false }));
  }

  /** O proxy saiu sem close (daemon reiniciado): fim do stdout. */
  end(): void {
    this.toClient.end();
  }

  /** Responde o 101 (modo 'manual') e processa o que tiver chegado depois do pedido de upgrade. */
  acceptHandshake(): void {
    const end = this.head.indexOf('\r\n\r\n');
    if (this.upgraded || end < 0) return;
    this.upgraded = true;
    const key = /Sec-WebSocket-Key: (\S+)/.exec(this.head)?.[1] ?? '';
    this.toClient.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`);
    const rest = Buffer.from(this.head.slice(end + 4), 'latin1');
    if (rest.length) this.onFrames(rest);
  }

  private send(obj: Rec): void {
    this.toClient.write(encodeFrame(OP_TEXT, Buffer.from(JSON.stringify(obj), 'utf8'), { mask: false }));
  }

  private onData(chunk: Buffer): void {
    if (this.upgraded) return this.onFrames(chunk);
    const wasComplete = this.head.includes('\r\n\r\n');
    this.head += chunk.toString('latin1');
    if (wasComplete || !this.head.includes('\r\n\r\n')) return;
    const mode = this.opts.handshake ?? 'accept';
    if (mode === 'refuse') this.toClient.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    else if (mode === 'accept') this.acceptHandshake();
  }

  private onFrames(chunk: Buffer): void {
    for (const f of this.decoder.push(chunk)) {
      if (f.opcode === OP_CLOSE) this.clientClosed = true;
      if (f.opcode !== OP_TEXT) continue;
      const msg = JSON.parse(f.payload.toString('utf8')) as Rec;
      this.received.push(msg);
      if (typeof msg.method !== 'string' || msg.id === undefined) continue;
      const handler = this.handlers.get(msg.method);
      if (!handler) {
        this.send({ id: msg.id, error: { code: -32601, message: `método desconhecido: ${msg.method}` } });
        continue;
      }
      try {
        const result = handler((msg.params ?? {}) as Rec, msg);
        if (result !== NO_REPLY) this.send({ id: msg.id, result: result ?? {} });
      } catch (err) {
        const e = err as { code?: number; message?: string };
        this.send({ id: msg.id, error: { code: e.code ?? -32603, message: e.message ?? 'erro' } });
      }
    }
  }
}

/** Para um FakeHandler responder erro JSON-RPC. */
export function rpcFail(code: number, message: string): never {
  throw Object.assign(new Error(message), { code });
}

/** Espera a condição (laço de 5 ms), ou falha em `ms`. */
export async function until(cond: () => boolean, ms = 2_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('condição não aconteceu a tempo');
    await new Promise((ok) => setTimeout(ok, 5));
  }
}
