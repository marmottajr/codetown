// Rota dos eventos dos hooks do Codex (POST /api/codex/events) pelas rotas de verdade (guard e app): repassa à fonte
// do Codex ao vivo (um falso) com a conta certa (pela pasta CODEX_HOME), só com Host local, só POST com JSON, corpo até
// 256 KB; sem a fonte, {ok: false}. De fora do loopback (no Docker, o gateway) só com nonce e prova da chave local do
// hook; fora do Docker, nunca. Dados e chaves sintéticos.
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { AccountsService } from '../accounts/service';
import { type ApiDeps, createApiHandler, sendJson } from '../http/app';
import { createRequestGuard } from '../http/guard';
import { Hub } from '../http/sse';
import { setQuiet } from '../log';
import { NameStore } from '../model/names';
import { Office } from '../model/office';
import type { CodexLive } from '../sources/codex/live';
import { tempDir } from '../test/fixtures';
import { request } from '../test/permission-server';
import { codexAccountOf, parseCodexEvent, verifyHookCall } from './http';
import { keyProof, NONCE_HEADER, PROOF_HEADER } from './key';

setQuiet(true);

const EVENT = { session_id: '0199b0c0-1234-7abc-8def-0123456789ab', hook_event_name: 'UserPromptSubmit', cwd: '/p/loja', prompt: 'oi' };
const KEY = Buffer.alloc(32, 7);
const OTHER_KEY = Buffer.alloc(32, 8);
/** Endereço do gateway do Docker: é de onde o hook (no host) chega ao container pela porta publicada. */
const GATEWAY = '172.17.0.1';
/** Cabeçalho só do servidor de teste: simula o endereço de quem conecta. */
const REMOTE = 'x-test-remote';

const nonceAt = (at = Date.now()) => `${at}.${randomBytes(16).toString('hex')}`;
const signed = (nonce: string, key = KEY, role: 'hook' | 'server' = 'hook') => ({ [NONCE_HEADER]: nonce, [PROOF_HEADER]: keyProof(key, role, nonce) });

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

/** POST com JSON e cabeçalhos livres; devolve também a prova do servidor (x-habblaud-proof) da resposta. */
function post(base: string, path: string, headers: Record<string, string>, body: unknown = { event: EVENT }): Promise<{ status: number; json: unknown; proof?: string }> {
  const u = new URL(base);
  const data = JSON.stringify(body);
  return new Promise((ok, fail) => {
    const req = http.request({ host: u.hostname, port: u.port, path, method: 'POST', headers: { 'Content-Type': 'application/json', ...headers } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (text += c));
      res.on('end', () => {
        const proof = res.headers[PROOF_HEADER];
        ok({ status: res.statusCode ?? 0, json: text ? JSON.parse(text) : undefined, proof: typeof proof === 'string' ? proof : undefined });
      });
    });
    req.on('error', fail);
    req.end(data);
  });
}

async function serve(
  live?: CodexLive,
  opts: { inDocker?: boolean; codexHookKey?: Buffer; permissions?: ApiDeps['permissions'] } = {},
): Promise<{ base: string; accounts: AccountsService }> {
  const tmp = tempDir();
  const office = new Office({ names: new NameStore(null), version: 't', startedAt: 0, accounts: () => [], sources: () => [], accountName: () => undefined });
  const hub = new Hub(office, { throttleMs: 10 });
  const accounts = new AccountsService({ dirs: [], home: tmp.dir, env: {}, onChange: () => {} });
  // Conta do Codex desambiguada (".codex~2"): o caminho do host é o que vale.
  accounts.setProviderAccounts('codex', [
    { dir: '/montada/a', detected: { id: '.codex', configDir: '/Users/x/.codex', short: 'X', name: 'Codex X', color: '#000' } },
    { dir: '/montada/b', detected: { id: '.codex', configDir: '/Volumes/y/.codex', short: 'Y', name: 'Codex Y', color: '#111' } },
  ]);
  const api = createApiHandler({
    office,
    hub,
    accounts,
    sources: () => [],
    version: 't',
    inDocker: opts.inDocker ?? false,
    codexLive: live,
    codexHookKey: opts.codexHookKey,
    permissions: opts.permissions,
  });
  const guard = createRequestGuard({ allowedHosts: new Set(['habblaud.lan']) });
  const server = http.createServer((req, res) => {
    // O servidor escuta no 127.0.0.1; o cabeçalho de teste troca o endereço de quem conecta. Vale a cada requisição,
    // porque o keep-alive reaproveita o socket.
    const remote = req.headers[REMOTE];
    Object.defineProperty(req.socket, 'remoteAddress', { value: typeof remote === 'string' ? remote : '127.0.0.1', configurable: true });
    if (guard(req, res)) return;
    if (!api(req, res, new URL(req.url ?? '/', 'http://x'))) res.writeHead(404).end();
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  close = () =>
    new Promise((ok) => {
      hub.stop();
      server.closeAllConnections();
      server.close(() => {
        tmp.cleanup();
        ok();
      });
    });
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, accounts };
}

describe('POST /api/codex/events', () => {
  it('repassa o evento à fonte do Codex com a conta da pasta CODEX_HOME (ou a do hook) e devolve {ok}', async () => {
    const calls: Array<[string | undefined, Record<string, unknown>]> = [];
    const { base } = await serve({ applyHookEvent: (a, e) => (calls.push([a, e]), true) });
    let r = await request(base, '/api/codex/events', { method: 'POST', body: { account: '.codex', codexHome: '/Volumes/y/.codex', event: EVENT } });
    expect(r).toMatchObject({ status: 200, json: { ok: true } });
    r = await request(base, '/api/codex/events', { method: 'POST', body: { account: '.codex', codexHome: '/montada/a/', event: EVENT } });
    r = await request(base, '/api/codex/events', { method: 'POST', body: { account: '.codex-nova', codexHome: '/outra/.codex-nova', event: EVENT } });
    r = await request(base, '/api/codex/events', { method: 'POST', body: { event: EVENT } });
    expect(calls).toEqual([
      ['.codex~2', EVENT],
      ['.codex', EVENT],
      ['.codex-nova', EVENT],
      [undefined, EVENT],
    ]);
  });

  it('sem a fonte do Codex (ou se ela falha): 200 {ok: false}', async () => {
    let s = await serve();
    expect(await request(s.base, '/api/codex/events', { method: 'POST', body: { event: EVENT } })).toMatchObject({ status: 200, json: { ok: false } });
    await close!();
    s = await serve({
      applyHookEvent: () => {
        throw new Error('quebrou');
      },
    });
    expect(await request(s.base, '/api/codex/events', { method: 'POST', body: { event: EVENT } })).toMatchObject({ status: 200, json: { ok: false } });
  });

  it('Host que não é local: 403; GET: 405; sem JSON: 415; corpo inválido: 400; acima de 256 KB: 413', async () => {
    const calls: unknown[] = [];
    const { base } = await serve({ applyHookEvent: (_a, e) => (calls.push(e), true) });
    for (const host of ['habblaud.lan:4747', '192.168.0.10:4747']) {
      const r = await request(base, '/api/codex/events', { method: 'POST', headers: { Host: host }, body: { event: EVENT } });
      expect(r.status, host).toBe(403);
    }
    expect((await request(base, '/api/codex/events')).status).toBe(405);
    expect((await request(base, '/api/codex/events', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' })).status).toBe(415);
    for (const body of [{}, { event: 'x' }, { event: { session_id: 's' } }, []]) {
      expect((await request(base, '/api/codex/events', { method: 'POST', body })).status, JSON.stringify(body)).toBe(400);
    }
    const big = { event: { ...EVENT, prompt: 'x'.repeat(300 * 1024) } };
    expect((await request(base, '/api/codex/events', { method: 'POST', body: big })).status).toBe(413);
    expect(calls).toHaveLength(0);
  });

  it('peças puras: parseCodexEvent e codexAccountOf', () => {
    expect(parseCodexEvent({ account: ' .codex ', codexHome: '/u/.codex', event: EVENT })).toEqual({ account: '.codex', codexHome: '/u/.codex', event: EVENT });
    expect(() => parseCodexEvent({ event: {} })).toThrow();
    expect(codexAccountOf([], '.codex', 'relativo/.codex')).toBe('.codex');
  });
});

describe('POST /api/codex/events: chave local do hook (no Docker, tudo chega pelo gateway)', () => {
  const PATH = '/api/codex/events';

  it('Docker, de fora do loopback: sem prova, prova de papel "server", de outra chave ou só o nonce → 403 sem tocar a fonte; prova válida → 200 com a prova do servidor', async () => {
    const calls: unknown[] = [];
    const { base } = await serve({ applyHookEvent: (_a, e) => (calls.push(e), true) }, { inDocker: true, codexHookKey: KEY });
    for (const remote of [GATEWAY, '::ffff:192.168.65.1', '10.0.0.5']) {
      expect((await post(base, PATH, { [REMOTE]: remote })).status, remote).toBe(403);
    }
    const n = nonceAt();
    const wrong: Array<Record<string, string>> = [signed(n, KEY, 'server'), signed(n, OTHER_KEY), { [NONCE_HEADER]: n }, { [PROOF_HEADER]: keyProof(KEY, 'hook', n) }];
    for (const headers of wrong) {
      expect((await post(base, PATH, { [REMOTE]: GATEWAY, ...headers })).status, JSON.stringify(headers)).toBe(403);
    }
    expect(calls).toHaveLength(0);
    // As recusas não queimaram o nonce: a prova certa passa, e a resposta prova que é o Habblaud (papel "server").
    const r = await post(base, PATH, { [REMOTE]: GATEWAY, ...signed(n) });
    expect(r).toMatchObject({ status: 200, json: { ok: true }, proof: keyProof(KEY, 'server', n) });
    expect(calls).toEqual([EVENT]);
  });

  it('Docker: nonce repetido ou velho → 403; corpo inválido de fora sem prova → 403 (a guarda vem antes do corpo)', async () => {
    const calls: unknown[] = [];
    const { base } = await serve({ applyHookEvent: (_a, e) => (calls.push(e), true) }, { inDocker: true, codexHookKey: KEY });
    const n = nonceAt();
    expect((await post(base, PATH, { [REMOTE]: GATEWAY, ...signed(n) })).status).toBe(200);
    expect((await post(base, PATH, { [REMOTE]: GATEWAY, ...signed(n) })).status).toBe(403);
    const old = nonceAt(Date.now() - 61_000);
    expect((await post(base, PATH, { [REMOTE]: GATEWAY, ...signed(old) })).status).toBe(403);
    expect((await post(base, PATH, { [REMOTE]: GATEWAY }, {})).status).toBe(403);
    // Com prova válida, aí sim o corpo é lido (e recusado).
    expect((await post(base, PATH, { [REMOTE]: GATEWAY, ...signed(nonceAt()) }, {})).status).toBe(400);
    expect(calls).toHaveLength(1);
  });

  it('Docker sem a chave montada: de fora, sempre 403; pelo loopback (o próprio container) continua valendo sem prova', async () => {
    const calls: unknown[] = [];
    const { base } = await serve({ applyHookEvent: (_a, e) => (calls.push(e), true) }, { inDocker: true });
    expect((await post(base, PATH, { [REMOTE]: GATEWAY, ...signed(nonceAt()) })).status).toBe(403);
    expect(await post(base, PATH, {})).toMatchObject({ status: 200, json: { ok: true }, proof: undefined });
    expect(calls).toHaveLength(1);
  });

  it('fora do Docker: de fora do loopback é 403 mesmo com prova válida; pelo loopback vale sem prova, e com prova válida a resposta leva a do servidor', async () => {
    const calls: unknown[] = [];
    const { base } = await serve({ applyHookEvent: (_a, e) => (calls.push(e), true) }, { codexHookKey: KEY });
    expect((await post(base, PATH, { [REMOTE]: '192.168.0.20', ...signed(nonceAt()) })).status).toBe(403);
    expect(await post(base, PATH, {})).toMatchObject({ status: 200, proof: undefined });
    expect(await post(base, PATH, { [REMOTE]: '::1', ...signed(nonceAt(), OTHER_KEY) })).toMatchObject({ status: 200, proof: undefined });
    const n = nonceAt();
    expect(await post(base, PATH, { [REMOTE]: '::ffff:127.0.0.1', ...signed(n) })).toMatchObject({ status: 200, proof: keyProof(KEY, 'server', n) });
    expect(calls).toHaveLength(3);
  });

  it('as rotas de permissão recebem a mesma guarda (4º argumento): um nonce usado nos eventos não vale lá', async () => {
    const seen: string[] = [];
    const permissions: ApiDeps['permissions'] = (req, res, _path, codexHook) => {
      const r = verifyHookCall(req, res, codexHook);
      seen.push(r);
      req.resume();
      sendJson(res, r === 'denied' ? 403 : 200, { r });
    };
    const { base } = await serve({ applyHookEvent: () => true }, { inDocker: true, codexHookKey: KEY, permissions });
    const n = nonceAt();
    expect((await post(base, PATH, { [REMOTE]: GATEWAY, ...signed(n) })).status).toBe(200);
    expect((await post(base, '/api/permissions', { [REMOTE]: GATEWAY, ...signed(n) }, {})).status).toBe(403);
    const n2 = nonceAt();
    expect(await post(base, '/api/permissions', { [REMOTE]: GATEWAY, ...signed(n2) }, {})).toMatchObject({ status: 200, json: { r: 'proof' }, proof: keyProof(KEY, 'server', n2) });
    expect(await post(base, '/api/permissions', {}, {})).toMatchObject({ status: 200, json: { r: 'loopback' }, proof: undefined });
    expect(seen).toEqual(['denied', 'proof', 'loopback']);
  });
});
