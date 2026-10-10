// Rota POST /api/antigravity/events pelas rotas de verdade (guard e app): só POST, só com Host e conexão locais (AG-06),
// 404 com HABBLAUD_ANTIGRAVITY=0 (rota ausente, AG-09), 400 para corpo inválido (AG-07), repasse à fonte ao vivo (um
// falso) e o campo de saúde. Dados sintéticos no formato capturado num agy real.
import http, { type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { AccountsService } from '../accounts/service';
import { setQuiet } from '../log';
import { NameStore } from '../model/names';
import { Office } from '../model/office';
import type { AntigravityEvent, AntigravityLive } from '../sources/antigravity/live';
import { tempDir } from '../test/fixtures';
import { request } from '../test/permission-server';
import { createApiHandler, type ApiDeps } from './app';
import { createRequestGuard } from './guard';
import { Hub } from './sse';

setQuiet(true);

const CONV = '08a163a1-c091-4c62-8146-ac8553c45d55';
const BODY = { event: 'PreToolUse', conversationId: CONV, workspacePaths: ['/p/loja'], stepIdx: 2, tool: { name: 'run_command', head: 'npm test' } };

let cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

function parts(extra: Partial<ApiDeps> = {}) {
  const tmp = tempDir();
  const office = new Office({ names: new NameStore(null), version: 't', startedAt: 0, accounts: () => [], sources: () => [], accountName: () => undefined });
  const hub = new Hub(office, { throttleMs: 10 });
  const accounts = new AccountsService({ dirs: [], home: tmp.dir, env: {}, onChange: () => {} });
  const api = createApiHandler({ office, hub, accounts, sources: () => [], version: 't', inDocker: false, ...extra });
  cleanups.push(() => {
    hub.stop();
    tmp.cleanup();
  });
  return api;
}

async function serve(extra: Partial<ApiDeps> = {}): Promise<string> {
  const api = parts(extra);
  const guard = createRequestGuard({ allowedHosts: new Set(['habblaud.lan']) });
  const server = http.createServer((req, res) => {
    if (guard(req, res)) return;
    if (!api(req, res, new URL(req.url ?? '/', 'http://x'))) res.writeHead(404).end();
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  cleanups.push(
    () =>
      new Promise<void>((ok) => {
        server.closeAllConnections();
        server.close(() => ok());
      }),
  );
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const live = (calls: AntigravityEvent[]): AntigravityLive => ({ applyHookEvent: (e) => (calls.push(e), true) });

describe('POST /api/antigravity/events', () => {
  it('liga: repassa o evento à fonte ao vivo e devolve {ok}', async () => {
    const calls: AntigravityEvent[] = [];
    const base = await serve({ antigravityEvents: true, antigravityLive: live(calls) });
    expect(await request(base, '/api/antigravity/events', { method: 'POST', body: BODY })).toMatchObject({ status: 200, json: { ok: true } });
    expect(calls).toEqual([BODY]);
  });

  it('sem a fonte mas com a integração ligada: 200 {ok: false}', async () => {
    const base = await serve({ antigravityEvents: true });
    expect(await request(base, '/api/antigravity/events', { method: 'POST', body: BODY })).toMatchObject({ status: 200, json: { ok: false } });
  });

  it('AG-09: com HABBLAUD_ANTIGRAVITY=0 a rota não existe (404), mesmo com POST válido', async () => {
    const calls: AntigravityEvent[] = [];
    const base = await serve({ antigravityLive: live(calls) });
    expect((await request(base, '/api/antigravity/events', { method: 'POST', body: BODY })).status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it('AG-06: Host que não é local: 403 e a fonte não recebe nada; só POST (GET: 405)', async () => {
    const calls: AntigravityEvent[] = [];
    const base = await serve({ antigravityEvents: true, antigravityLive: live(calls) });
    for (const host of ['habblaud.lan:4747', '192.168.0.10:4747']) {
      expect((await request(base, '/api/antigravity/events', { method: 'POST', headers: { Host: host }, body: BODY })).status, host).toBe(403);
    }
    expect((await request(base, '/api/antigravity/events')).status).toBe(405);
    expect(calls).toHaveLength(0);
  });

  it('AG-06: conexão que não vem do loopback (Host local, endereço remoto): 403', async () => {
    const calls: AntigravityEvent[] = [];
    const api = parts({ antigravityEvents: true, antigravityLive: live(calls) });
    const out: { status?: number; body?: string } = {};
    const res = {
      writeHead: (s: number) => void (out.status = s),
      end: (b?: string) => void (out.body = b),
    };
    const req = { method: 'POST', headers: { host: '127.0.0.1:4747', 'content-type': 'application/json' }, socket: { remoteAddress: '192.168.0.50' }, url: '/api/antigravity/events' };
    expect(api(req as unknown as IncomingMessage, res as never, new URL('http://x/api/antigravity/events'))).toBe(true);
    expect(out.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it('AG-07: corpo inválido (conversationId ruim, evento fora dos cinco, sem evento): 400; sem JSON: 415', async () => {
    const calls: AntigravityEvent[] = [];
    const base = await serve({ antigravityEvents: true, antigravityLive: live(calls) });
    const bodies = [{}, { ...BODY, conversationId: 'abc' }, { ...BODY, event: 'SessionStart' }, { ...BODY, conversationId: undefined }, 'texto'];
    for (const body of bodies) expect((await request(base, '/api/antigravity/events', { method: 'POST', body })).status, JSON.stringify(body)).toBe(400);
    expect((await request(base, '/api/antigravity/events', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' })).status).toBe(415);
    expect(calls).toHaveLength(0);
  });

  it('só repassa o que o contrato define: campos extras (texto do pedido, saída) são descartados', async () => {
    const calls: AntigravityEvent[] = [];
    const base = await serve({ antigravityEvents: true, antigravityLive: live(calls) });
    await request(base, '/api/antigravity/events', { method: 'POST', body: { ...BODY, prompt: 'segredo', output: 'saida', tool: { ...BODY.tool, args: { x: 1 } } } });
    expect(calls).toEqual([BODY]);
  });

  it('o /api/health informa a rota de eventos do Antigravity (e não aparece sem a integração)', async () => {
    let base = await serve({ antigravityEvents: true, antigravityLive: { applyHookEvent: () => true } });
    expect((await request(base, '/api/health')).json).toMatchObject({ antigravityEvents: true, antigravitySource: true });
    base = await serve({ antigravityEvents: true });
    expect((await request(base, '/api/health')).json).toMatchObject({ antigravityEvents: true, antigravitySource: false });
    base = await serve();
    expect((await request(base, '/api/health')).json).not.toHaveProperty('antigravityEvents');
  });
});
