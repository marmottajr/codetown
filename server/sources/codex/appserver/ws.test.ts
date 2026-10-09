// WebSocket mínimo do cliente do app-server: frames (tamanhos 7/16/64 bits, máscara), decodificação em
// pedaços, handshake (101 e Sec-WebSocket-Accept), fila antes do 'open', mensagens fragmentadas, ping → pong
// e close. Tudo em memória (PassThrough), sem processo nem rede.
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { acceptKey, encodeFrame, FrameDecoder, handshakeRequest, OP_BINARY, OP_CLOSE, OP_CONTINUATION, OP_PING, OP_PONG, OP_TEXT, WsConnection, type WsFrame } from './ws';

/** Servidor WebSocket de brinquedo sobre o par de streams da conexão (o lado do app-server). */
function pair() {
  const toClient = new PassThrough();
  const fromClient = new PassThrough();
  const ws = new WsConnection(toClient, fromClient);
  const decoder = new FrameDecoder();
  const frames: WsFrame[] = [];
  let request = '';
  let upgraded = false;
  fromClient.on('data', (c: Buffer) => {
    if (!upgraded) {
      request += c.toString('latin1');
      const end = request.indexOf('\r\n\r\n');
      if (end < 0) return;
      upgraded = true;
      const rest = Buffer.from(request.slice(end + 4), 'latin1');
      if (rest.length) frames.push(...decoder.push(rest));
      return;
    }
    frames.push(...decoder.push(c));
  });
  const keyOf = () => /Sec-WebSocket-Key: (\S+)/.exec(request)?.[1] ?? '';
  const accept = (extra: Buffer = Buffer.alloc(0)) =>
    toClient.write(Buffer.concat([Buffer.from(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey(keyOf())}\r\n\r\n`, 'latin1'), extra]));
  const events: string[] = [];
  const messages: string[] = [];
  ws.on('open', () => events.push('open'));
  ws.on('close', (r: string) => events.push(`close:${r}`));
  ws.on('error', () => events.push('error'));
  ws.on('message', (t: string) => messages.push(t));
  return { ws, toClient, fromClient, frames, accept, keyOf, events, messages, request: () => request };
}

const tick = () => new Promise<void>((ok) => setImmediate(ok));
const text = (s: string, opts: { fin?: boolean; opcode?: number } = {}) => encodeFrame(opts.opcode ?? OP_TEXT, Buffer.from(s, 'utf8'), { mask: false, fin: opts.fin });

describe('frames', () => {
  it('encodeFrame + FrameDecoder: 7, 16 e 64 bits de tamanho, com e sem máscara, em pedaços de 1 byte', () => {
    // Arrange
    const payloads = [Buffer.alloc(0), Buffer.from('oi'), Buffer.alloc(125, 1), Buffer.alloc(126, 2), Buffer.alloc(65_535, 3), Buffer.alloc(65_536, 4)];
    for (const mask of [false, true]) {
      const dec = new FrameDecoder();
      const got: WsFrame[] = [];

      // Act
      for (const p of payloads) {
        const bytes = encodeFrame(OP_BINARY, p, { mask });
        if (p.length < 300) for (const b of bytes) got.push(...dec.push(Buffer.from([b])));
        else got.push(...dec.push(bytes.subarray(0, 3)), ...dec.push(bytes.subarray(3)));
      }

      // Assert
      expect(got.map((f) => f.payload.length)).toEqual(payloads.map((p) => p.length));
      got.forEach((f, i) => {
        expect(f).toMatchObject({ fin: true, opcode: OP_BINARY });
        expect(f.payload.equals(payloads[i])).toBe(true);
      });
    }
  });

  it('cabeçalho: bit FIN, bit de máscara e tamanhos estendidos nos lugares certos', () => {
    const small = encodeFrame(OP_TEXT, Buffer.from('abc'), { mask: false });
    expect([...small]).toEqual([0x81, 3, 0x61, 0x62, 0x63]);
    const cont = encodeFrame(OP_CONTINUATION, Buffer.from('x'), { mask: false, fin: false });
    expect(cont[0]).toBe(0x00);
    const masked = encodeFrame(OP_TEXT, Buffer.from('abc'));
    expect(masked[1]).toBe(0x80 | 3);
    expect(masked.length).toBe(2 + 4 + 3);
    const mid = encodeFrame(OP_TEXT, Buffer.alloc(300), { mask: false });
    expect([mid[1], mid.readUInt16BE(2)]).toEqual([126, 300]);
    const big = encodeFrame(OP_TEXT, Buffer.alloc(70_000), { mask: false });
    expect([big[1], Number(big.readBigUInt64BE(2))]).toEqual([127, 70_000]);
  });

  it('frame maior que o limite: lança (o cliente fecha a conexão)', () => {
    const dec = new FrameDecoder(10);
    expect(() => dec.push(encodeFrame(OP_TEXT, Buffer.alloc(11), { mask: false }))).toThrow(/grande demais/);
  });

  it('handshakeRequest e acceptKey (exemplo da RFC 6455)', () => {
    expect(acceptKey('dGhlIHNhbXBsZSBub25jZQ==')).toBe('s3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
    const req = handshakeRequest('k', { path: '/rpc' });
    expect(req.startsWith('GET /rpc HTTP/1.1\r\n')).toBe(true);
    expect(req).toContain('Upgrade: websocket\r\n');
    expect(req).toContain('Sec-WebSocket-Key: k\r\n');
    expect(req).toContain('Sec-WebSocket-Version: 13\r\n');
    expect(req).not.toMatch(/Origin:/i);
    expect(req.endsWith('\r\n\r\n')).toBe(true);
  });
});

describe('WsConnection', () => {
  it('manda o handshake, segura os envios até o 101 e só então manda frames mascarados', async () => {
    // Arrange
    const c = pair();

    // Act
    c.ws.send('{"id":1}');
    await tick();

    // Assert: nada além do pedido de upgrade antes do 101.
    expect(c.request()).toMatch(/^GET \/rpc HTTP\/1\.1\r\n/);
    expect(c.frames).toEqual([]);
    c.accept();
    await tick();
    expect(c.events).toEqual(['open']);
    expect(c.frames.map((f) => f.payload.toString())).toEqual(['{"id":1}']);
    c.ws.send('{"id":2}');
    await tick();
    expect(c.frames.map((f) => f.payload.toString())).toEqual(['{"id":1}', '{"id":2}']);
  });

  it('o 101 e o primeiro frame no mesmo pedaço: a mensagem não se perde', async () => {
    const c = pair();
    await tick();
    c.accept(text('{"method":"thread/started"}'));
    await tick();
    expect(c.messages).toEqual(['{"method":"thread/started"}']);
  });

  it('mensagem fragmentada com um ping no meio: remonta e responde pong com o mesmo conteúdo', async () => {
    const c = pair();
    await tick();
    c.accept();
    c.toClient.write(text('{"a":', { fin: false }));
    c.toClient.write(encodeFrame(OP_PING, Buffer.from('p1'), { mask: false }));
    c.toClient.write(text('1}', { fin: true, opcode: OP_CONTINUATION }));
    await tick();
    expect(c.messages).toEqual(['{"a":1}']);
    const pong = c.frames.find((f) => f.opcode === OP_PONG)!;
    expect(pong.payload.toString()).toBe('p1');
  });

  it('handshake recusado (não 101) ou com Accept errado: fecha com erro, uma vez só', async () => {
    const c = pair();
    await tick();
    c.toClient.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    await tick();
    expect(c.events).toEqual(['error', 'close:handshake recusado: HTTP/1.1 400 Bad Request']);
    const d = pair();
    await tick();
    d.toClient.write('HTTP/1.1 101 Switching Protocols\r\nSec-WebSocket-Accept: errado\r\n\r\n');
    await tick();
    expect(d.events).toEqual(['error', 'close:handshake com Sec-WebSocket-Accept errado']);
    d.ws.send('x');
    d.ws.close();
    expect(d.events).toHaveLength(2);
  });

  it('close do servidor: devolve o close e avisa o motivo; fim do stream também fecha', async () => {
    const c = pair();
    await tick();
    c.accept();
    const payload = Buffer.concat([Buffer.from([0x03, 0xe8]), Buffer.from('tchau')]);
    c.toClient.write(encodeFrame(OP_CLOSE, payload, { mask: false }));
    await tick();
    expect(c.events).toEqual(['open', 'close:o app-server fechou a conexão (1000: tchau)']);
    expect(c.frames.at(-1)!.opcode).toBe(OP_CLOSE);
    const d = pair();
    d.toClient.end();
    await tick();
    expect(d.events).toEqual(['close:o proxy do app-server fechou a saída']);
  });

  it('sem ouvinte de "error", um erro só fecha (não derruba o processo)', async () => {
    const toClient = new PassThrough();
    const ws = new WsConnection(toClient, new PassThrough());
    const closed: string[] = [];
    ws.on('close', (r: string) => closed.push(r));
    toClient.write('HTTP/1.1 500 Erro\r\n\r\n');
    await tick();
    expect(closed).toEqual(['handshake recusado: HTTP/1.1 500 Erro']);
  });

  it('close() do cliente manda o frame de close (1000) e avisa', async () => {
    const c = pair();
    await tick();
    c.accept();
    await tick();
    c.ws.close();
    await tick();
    const last = c.frames.at(-1)!;
    expect(last.opcode).toBe(OP_CLOSE);
    expect(last.payload.readUInt16BE(0)).toBe(1000);
    expect(c.events).toEqual(['open', 'close:fechada pelo Habblaud']);
  });
});
