// Cliente WebSocket mínimo (RFC 6455), sem dependências, sobre um par de streams: o stdin/stdout do
// `codex app-server proxy`, que repassa bytes ao socket AF_UNIX do daemon do Codex (o Node no Windows não
// abre AF_UNIX). Só o que o app-server usa: handshake `GET /rpc` (espera o 101 antes de qualquer frame),
// frames de texto mascarados (cliente), mensagens fragmentadas, ping → pong e close.
import { createHash, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
export const OP_CONTINUATION = 0x0;
export const OP_TEXT = 0x1;
export const OP_BINARY = 0x2;
export const OP_CLOSE = 0x8;
export const OP_PING = 0x9;
export const OP_PONG = 0xa;
/** Maior frame (e maior mensagem remontada) aceito: o app-server anuncia 16 MiB sem fragmentar. */
export const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
/** Resposta do handshake maior que isto não é um app-server. */
const MAX_HANDSHAKE_BYTES = 16 * 1024;

/** Um frame pronto para escrever. Cliente → servidor: `mask` (padrão true); `fin` padrão true. */
export function encodeFrame(opcode: number, payload: Buffer, opts: { mask?: boolean; fin?: boolean } = {}): Buffer {
  const mask = opts.mask ?? true;
  const fin = opts.fin ?? true;
  const len = payload.length;
  const head = len < 126 ? 2 : len < 65_536 ? 4 : 10;
  const out = Buffer.allocUnsafe(head + (mask ? 4 : 0) + len);
  out[0] = (fin ? 0x80 : 0) | (opcode & 0x0f);
  const maskBit = mask ? 0x80 : 0;
  if (len < 126) out[1] = maskBit | len;
  else if (len < 65_536) {
    out[1] = maskBit | 126;
    out.writeUInt16BE(len, 2);
  } else {
    out[1] = maskBit | 127;
    out.writeBigUInt64BE(BigInt(len), 2);
  }
  if (!mask) {
    payload.copy(out, head);
    return out;
  }
  const key = randomBytes(4);
  key.copy(out, head);
  const start = head + 4;
  for (let i = 0; i < len; i++) out[start + i] = payload[i] ^ key[i & 3];
  return out;
}

export interface WsFrame {
  fin: boolean;
  opcode: number;
  payload: Buffer;
}

/** Junta os pedaços do fluxo e devolve os frames completos (desmascarados). Frame grande demais: lança. */
export class FrameDecoder {
  private buf: Buffer = Buffer.alloc(0);

  constructor(private readonly maxBytes = MAX_MESSAGE_BYTES) {}

  push(chunk: Buffer): WsFrame[] {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const out: WsFrame[] = [];
    for (;;) {
      const b = this.buf;
      if (b.length < 2) break;
      const masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (b.length < 4) break;
        len = b.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (b.length < 10) break;
        const big = b.readBigUInt64BE(2);
        if (big > BigInt(this.maxBytes)) throw new Error(`frame WebSocket grande demais (${big} bytes)`);
        len = Number(big);
        off = 10;
      }
      if (len > this.maxBytes) throw new Error(`frame WebSocket grande demais (${len} bytes)`);
      const keyAt = off;
      if (masked) off += 4;
      if (b.length < off + len) break;
      const payload = Buffer.from(b.subarray(off, off + len));
      if (masked) for (let i = 0; i < len; i++) payload[i] ^= b[keyAt + (i & 3)];
      out.push({ fin: (b[0] & 0x80) !== 0, opcode: b[0] & 0x0f, payload });
      this.buf = b.subarray(off + len);
    }
    return out;
  }
}

/** Pedido de upgrade (sem Origin: o app-server recusa pedidos com Origin, que vêm de navegadores). */
export function handshakeRequest(key: string, opts: { path?: string; host?: string } = {}): string {
  return [
    `GET ${opts.path ?? '/rpc'} HTTP/1.1`,
    `Host: ${opts.host ?? 'localhost'}`,
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Key: ${key}`,
    'Sec-WebSocket-Version: 13',
    '',
    '',
  ].join('\r\n');
}

/** Sec-WebSocket-Accept esperado para a chave do pedido. */
export function acceptKey(key: string): string {
  return createHash('sha1').update(`${key}${GUID}`).digest('base64');
}

/** Motivo da recusa do handshake (texto até o \r\n\r\n), ou undefined se for um 101 válido. */
function handshakeError(text: string, key: string): string | undefined {
  const [status = '', ...lines] = text.split('\r\n');
  if (!/^HTTP\/1\.1 101\b/.test(status)) return `handshake recusado: ${status.slice(0, 120)}`;
  for (const line of lines) {
    const i = line.indexOf(':');
    if (i > 0 && line.slice(0, i).trim().toLowerCase() === 'sec-websocket-accept') {
      return line.slice(i + 1).trim() === acceptKey(key) ? undefined : 'handshake com Sec-WebSocket-Accept errado';
    }
  }
  return 'handshake sem Sec-WebSocket-Accept';
}

/**
 * Conexão WebSocket de cliente sobre `input` (bytes do servidor) e `output` (bytes para o servidor).
 * Eventos: 'open', 'message'(text), 'close'(reason) — uma vez só — e 'error'(err), só se houver ouvinte
 * (o erro também fecha a conexão). `send` antes do 'open' fica na fila.
 */
export class WsConnection extends EventEmitter {
  private state: 'connecting' | 'open' | 'closed' = 'connecting';
  private readonly key = randomBytes(16).toString('base64');
  private readonly decoder = new FrameDecoder();
  private head: Buffer = Buffer.alloc(0);
  private queue: string[] = [];
  private parts: Buffer[] = [];
  private partsBytes = 0;
  private partsText = false;
  private fragmented = false;
  private closeSent = false;

  constructor(
    private readonly input: NodeJS.ReadableStream,
    private readonly output: NodeJS.WritableStream,
    opts: { path?: string } = {},
  ) {
    super();
    input.on('data', this.onData);
    input.on('end', this.onEnd);
    input.on('error', this.onStreamError);
    output.on('error', this.onStreamError);
    // No próximo tick: quem criou a conexão ainda vai pôr os ouvintes ('open', 'close'...), e um par de
    // streams em memória pode responder o 101 na mesma pilha.
    const request = handshakeRequest(this.key, { path: opts.path });
    process.nextTick(() => {
      if (this.state === 'connecting') this.write(request);
    });
  }

  get isOpen(): boolean {
    return this.state === 'open';
  }

  send(text: string): void {
    if (this.state === 'closed') return;
    if (this.state === 'connecting') {
      this.queue.push(text);
      return;
    }
    this.sendFrame(OP_TEXT, Buffer.from(text, 'utf8'));
  }

  close(): void {
    if (this.state === 'closed') return;
    if (this.state === 'open' && !this.closeSent) {
      const code = Buffer.alloc(2);
      code.writeUInt16BE(1000, 0);
      this.sendFrame(OP_CLOSE, code);
    }
    this.finish('fechada pelo Habblaud');
  }

  private onData = (chunk: Buffer | string): void => {
    if (this.state === 'closed') return;
    let data = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    if (this.state === 'connecting') {
      this.head = Buffer.concat([this.head, data]);
      const end = this.head.indexOf('\r\n\r\n');
      if (end < 0) {
        if (this.head.length > MAX_HANDSHAKE_BYTES) this.fail(new Error('resposta do handshake grande demais'));
        return;
      }
      const err = handshakeError(this.head.subarray(0, end).toString('latin1'), this.key);
      data = this.head.subarray(end + 4);
      this.head = Buffer.alloc(0);
      if (err) return this.fail(new Error(err));
      this.state = 'open';
      const queued = this.queue;
      this.queue = [];
      for (const text of queued) this.sendFrame(OP_TEXT, Buffer.from(text, 'utf8'));
      this.emit('open');
      // O primeiro frame pode ter vindo no mesmo pedaço do 101.
      if (!data.length) return;
    }
    let frames: WsFrame[];
    try {
      frames = this.decoder.push(data);
    } catch (err) {
      return this.fail(err as Error);
    }
    for (const f of frames) {
      if (this.state !== 'open') return;
      this.onFrame(f);
    }
  };

  private onEnd = (): void => this.finish('o proxy do app-server fechou a saída');

  private onStreamError = (err: Error): void => this.fail(err);

  private onFrame(f: WsFrame): void {
    switch (f.opcode) {
      case OP_PING:
        this.sendFrame(OP_PONG, f.payload);
        return;
      case OP_PONG:
        return;
      case OP_CLOSE: {
        const code = f.payload.length >= 2 ? f.payload.readUInt16BE(0) : 1005;
        const why = f.payload.subarray(2).toString('utf8');
        if (!this.closeSent) this.sendFrame(OP_CLOSE, f.payload.subarray(0, 2));
        this.finish(`o app-server fechou a conexão (${code}${why ? `: ${why}` : ''})`);
        return;
      }
      case OP_TEXT:
      case OP_BINARY:
        if (this.fragmented) return this.fail(new Error('frame de dados no meio de uma mensagem fragmentada'));
        if (f.fin) {
          if (f.opcode === OP_TEXT) this.emit('message', f.payload.toString('utf8'));
          return;
        }
        this.fragmented = true;
        this.partsText = f.opcode === OP_TEXT;
        this.parts = [f.payload];
        this.partsBytes = f.payload.length;
        return;
      case OP_CONTINUATION: {
        if (!this.fragmented) return this.fail(new Error('continuação sem mensagem começada'));
        this.partsBytes += f.payload.length;
        if (this.partsBytes > MAX_MESSAGE_BYTES) return this.fail(new Error('mensagem WebSocket grande demais'));
        this.parts.push(f.payload);
        if (!f.fin) return;
        const msg = Buffer.concat(this.parts);
        this.parts = [];
        this.fragmented = false;
        if (this.partsText) this.emit('message', msg.toString('utf8'));
        return;
      }
      default:
        this.fail(new Error(`opcode WebSocket desconhecido (${f.opcode})`));
    }
  }

  private sendFrame(opcode: number, payload: Buffer): void {
    if (opcode === OP_CLOSE) this.closeSent = true;
    this.write(encodeFrame(opcode, payload, { mask: true }));
  }

  private write(data: string | Buffer): void {
    try {
      this.output.write(data);
    } catch (err) {
      this.fail(err as Error);
    }
  }

  private fail(err: Error): void {
    if (this.state === 'closed') return;
    if (this.listenerCount('error') > 0) this.emit('error', err);
    this.finish(err.message);
  }

  private finish(reason: string): void {
    if (this.state === 'closed') return;
    this.state = 'closed';
    this.queue = [];
    this.parts = [];
    this.input.removeListener('data', this.onData);
    this.input.removeListener('end', this.onEnd);
    this.emit('close', reason);
  }
}
