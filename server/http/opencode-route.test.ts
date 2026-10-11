// Rota POST /api/opencode/events pelas rotas de verdade (guard e app): só POST, só com Host e conexão locais (OC-17),
// 404 com HABBLAUD_OPENCODE=0 (rota ausente), 400 para corpo inválido (OC-18), repasse à fonte ao vivo (um falso) e o
// campo de saúde. Dados sintéticos.
import http, { type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { AccountsService } from '../accounts/service';
import { setQuiet } from '../log';
import { NameStore } from '../model/names';
import { Office } from '../model/office';
import type { OpencodeEvent, OpencodeLive } from '../sources/opencode/live';
import { tempDir } from '../test/fixtures';
import { request } from '../test/permission-server';
import { createApiHandler, type ApiDeps } from './app';
import { createRequestGuard } from './guard';
import { Hub } from './sse';

setQuiet(true);

const SES = 'ses_' + 'b'.repeat(26);
const EVENT = { event: { type: 'session.idle', properties: { sessionID: SES } } };

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

describe('POST /api/opencode/events', () => {
  it('liga: repassa o evento à fonte ao vivo e devolve {ok}', async () => {
    const calls: OpencodeEvent[] = [];
    const live: OpencodeLive = { applyHookEvent: (e) => (calls.push(e), true) };
    const base = await serve({ opencodeEvents: true, opencodeLive: live });
    expect(await request(base, '/api/opencode/events', { method: 'POST', body: EVENT })).toMatchObject({ status: 200, json: { ok: true } });
    expect(calls).toEqual([EVENT.event]);
  });

  it('sem a fonte (sem banco) mas com a integração ligada: 200 {ok: false}', async () => {
    const base = await serve({ opencodeEvents: true });
    expect(await request(base, '/api/opencode/events', { method: 'POST', body: EVENT })).toMatchObject({ status: 200, json: { ok: false } });
  });

  it('OC-10: com HABBLAUD_OPENCODE=0 a rota não existe (404), mesmo com POST válido', async () => {
    const calls: OpencodeEvent[] = [];
    const base = await serve({ opencodeLive: { applyHookEvent: (e) => (calls.push(e), true) } });
    expect((await request(base, '/api/opencode/events', { method: 'POST', body: EVENT })).status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it('OC-17: Host que não é local: 403, e a fonte não recebe nada; só POST (GET: 405)', async () => {
    const calls: OpencodeEvent[] = [];
    const base = await serve({ opencodeEvents: true, opencodeLive: { applyHookEvent: (e) => (calls.push(e), true) } });
    for (const host of ['habblaud.lan:4747', '192.168.0.10:4747']) {
      expect((await request(base, '/api/opencode/events', { method: 'POST', headers: { Host: host }, body: EVENT })).status, host).toBe(403);
    }
    expect((await request(base, '/api/opencode/events')).status).toBe(405);
    expect(calls).toHaveLength(0);
  });

  it('OC-17: conexão que não vem do loopback (Host local, endereço remoto de outra máquina): 403', async () => {
    const calls: OpencodeEvent[] = [];
    const api = parts({ opencodeEvents: true, opencodeLive: { applyHookEvent: (e) => (calls.push(e), true) } });
    const out: { status?: number; body?: string } = {};
    const res = {
      writeHead: (s: number) => void (out.status = s),
      end: (b?: string) => void (out.body = b),
    };
    const req = { method: 'POST', headers: { host: '127.0.0.1:4747', 'content-type': 'application/json' }, socket: { remoteAddress: '192.168.0.50' }, url: '/api/opencode/events' };
    expect(api(req as unknown as IncomingMessage, res as never, new URL('http://x/api/opencode/events'))).toBe(true);
    expect(out.status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it('OC-18: corpo inválido (sessionID ruim, tipo fora da lista, sem evento): 400; sem JSON: 415', async () => {
    const calls: OpencodeEvent[] = [];
    const base = await serve({ opencodeEvents: true, opencodeLive: { applyHookEvent: (e) => (calls.push(e), true) } });
    const bodies = [{}, { event: { type: 'session.idle', properties: { sessionID: 'ses_x' } } }, { event: { type: 'message.updated', properties: { sessionID: SES } } }];
    for (const body of bodies) expect((await request(base, '/api/opencode/events', { method: 'POST', body })).status, JSON.stringify(body)).toBe(400);
    expect((await request(base, '/api/opencode/events', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' })).status).toBe(415);
    expect(calls).toHaveLength(0);
  });

  it('o /api/health informa a rota de eventos do OpenCode (e não aparece sem a integração)', async () => {
    let base = await serve({ opencodeEvents: true, opencodeLive: { applyHookEvent: () => true } });
    expect((await request(base, '/api/health')).json).toMatchObject({ opencodeEvents: true, opencodeSource: true });
    base = await serve({ opencodeEvents: true });
    expect((await request(base, '/api/health')).json).toMatchObject({ opencodeEvents: true, opencodeSource: false });
    base = await serve();
    expect((await request(base, '/api/health')).json).not.toHaveProperty('opencodeEvents');
  });
});

describe('OQ-16: a rota liga o liberador de perguntas', () => {
  it('question.replied e question.rejected chamam o liberador com a sessão; outros eventos não', async () => {
    const released: string[] = [];
    const base = await serve({ opencodeEvents: true, releaseOpencodeQuestions: (s) => void released.push(s) });
    const ev = (type: string) => ({ event: { type, properties: { sessionID: SES, requestID: 'que_1' } } });
    for (const type of ['session.idle', 'question.asked', 'question.replied', 'question.rejected']) await request(base, '/api/opencode/events', { method: 'POST', body: ev(type) });
    expect(released).toEqual([SES, SES]);
  });
});
