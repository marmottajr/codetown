// Roteamento JSON-RPC do app-server do Codex: respostas × notificações × pedidos do servidor, erro com
// code/message, id original (número ou string) na resposta, tempo limite e conexão encerrada.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RpcError, RpcPeer } from './rpc';

afterEach(() => vi.useRealTimers());

function peer(opts: { timeoutMs?: number } = {}) {
  const sent: Array<Record<string, unknown>> = [];
  const rpc = new RpcPeer((text) => sent.push(JSON.parse(text) as Record<string, unknown>), opts);
  return { rpc, sent };
}

describe('RpcPeer', () => {
  it('pedido sem "jsonrpc", ids crescentes; a resposta resolve o pedido certo', async () => {
    // Arrange
    const { rpc, sent } = peer();

    // Act
    const a = rpc.request('thread/loaded/list', {});
    const b = rpc.request('initialized-sem-params');
    rpc.handle(JSON.stringify({ id: 2, result: 'b' }));
    rpc.handle(JSON.stringify({ id: 1, result: { data: [] } }));

    // Assert
    await expect(a).resolves.toEqual({ data: [] });
    await expect(b).resolves.toBe('b');
    expect(sent).toEqual([{ id: 1, method: 'thread/loaded/list', params: {} }, { id: 2, method: 'initialized-sem-params' }]);
  });

  it('erro do servidor vira RpcError com code e message (as duas -32600 do resume se distinguem pela mensagem)', async () => {
    const { rpc } = peer();
    const p = rpc.request('thread/resume', { threadId: 't' });
    rpc.handle(JSON.stringify({ id: 1, error: { code: -32600, message: 'no rollout found for thread id t' } }));
    const err = await p.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RpcError);
    expect(err).toMatchObject({ code: -32600, message: 'no rollout found for thread id t' });
  });

  it('notificações e pedidos do servidor vão para os callbacks; o id original volta na resposta', () => {
    const { rpc, sent } = peer();
    const notes: unknown[] = [];
    const reqs: unknown[] = [];
    rpc.onNotification((method, params) => notes.push([method, params]));
    rpc.onRequest((id, method, params) => reqs.push([id, method, params]));
    rpc.handle(JSON.stringify({ method: 'serverRequest/resolved', params: { threadId: 't', requestId: 0 } }));
    rpc.handle(JSON.stringify({ id: 0, method: 'item/commandExecution/requestApproval', params: { threadId: 't' } }));
    rpc.handle(JSON.stringify({ id: 'abc', method: 'item/fileChange/requestApproval', params: {} }));
    expect(notes).toEqual([['serverRequest/resolved', { threadId: 't', requestId: 0 }]]);
    expect(reqs).toEqual([
      [0, 'item/commandExecution/requestApproval', { threadId: 't' }],
      ['abc', 'item/fileChange/requestApproval', {}],
    ]);
    rpc.respond(0, { decision: 'accept' });
    rpc.respond('abc', { decision: 'decline' });
    rpc.notify('initialized');
    expect(sent).toEqual([{ id: 0, result: { decision: 'accept' } }, { id: 'abc', result: { decision: 'decline' } }, { method: 'initialized' }]);
  });

  it('lixo, resposta de id desconhecido ou com id string: ignorados', () => {
    const { rpc } = peer();
    expect(() => {
      rpc.handle('não é json');
      rpc.handle('[1,2]');
      rpc.handle(JSON.stringify({ id: 99, result: 1 }));
      rpc.handle(JSON.stringify({ id: 'x', result: 1 }));
    }).not.toThrow();
  });

  it('tempo limite: rejeita e esquece o pedido', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { rpc } = peer({ timeoutMs: 1_000 });
    const p = rpc.request('thread/resume', {});
    const caught = p.catch((e: Error) => e.message);
    vi.advanceTimersByTime(1_000);
    await expect(caught).resolves.toMatch(/sem resposta para thread\/resume/);
    rpc.handle(JSON.stringify({ id: 1, result: 'tarde' }));
  });

  it('close rejeita os pendentes e recusa pedidos novos; respostas e envios depois são ignorados', async () => {
    const { rpc, sent } = peer();
    const p = rpc.request('thread/loaded/list');
    rpc.close('o proxy saiu');
    await expect(p).rejects.toThrow('conexão encerrada: o proxy saiu');
    await expect(rpc.request('x')).rejects.toThrow(/encerrada/);
    rpc.respond(1, {});
    rpc.notify('initialized');
    expect(sent).toHaveLength(1);
  });
});
