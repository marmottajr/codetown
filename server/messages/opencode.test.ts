// Mensagens ao OpenCode (OC-23..OC-26): o registro enfileira para os agentes PRINCIPAIS do OpenCode, o plugin
// (mod/habblaud-opencode/plugin.js) busca em POST /api/opencode/bridge/poll só as da própria sessão, entrega com
// promptAsync e confirma em /api/opencode/bridge/ack; sem confirmação em 20 s a mensagem falha. Dados sintéticos,
// relógio injetado, rotas de verdade (guard + app + server/messages/http.ts) numa porta local.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentInfo, OfficeSnapshot } from '../../shared/types';
import { AccountsService } from '../accounts/service';
import { createApiHandler } from '../http/app';
import { createRequestGuard } from '../http/guard';
import { Hub } from '../http/sse';
import { setQuiet } from '../log';
import { NameStore } from '../model/names';
import { Office } from '../model/office';
import { tempDir } from '../test/fixtures';
import { request } from '../test/permission-server';
import { createMessageRoutes } from './http';
import { ERR_OPENCODE_NOT_CONFIRMED, MAX_TEXT, MessageRegistry, type SendResult } from './registry';

setQuiet(true);

const SES_A = 'ses_' + 'a'.repeat(26);
const SES_B = 'ses_' + 'b'.repeat(26);
const A = `opencode:${SES_A}`;
const B = `opencode:${SES_B}`;
const SUB = `opencode:ses_${'c'.repeat(26)}`;
/** Prazo sem confirmação do OpenCode (OC-25) e janela de "plugin conectado" (OC-23). */
const ACK_MS = 20_000;
const PRESENCE_MS = 15_000;

function setup(opts: { opencode?: boolean } = {}) {
  let now = 1_000_000;
  const clock = { now: () => now, advance: (ms: number) => (now += ms) };
  let registry: MessageRegistry | undefined;
  const office = new Office({
    names: new NameStore(null),
    version: 't',
    startedAt: 0,
    accounts: () => [],
    sources: () => [],
    accountName: () => undefined,
    messages: () => registry?.reachable() ?? new Set(),
    now: clock.now,
  });
  const add = (id: string, sessionId: string, cwd: string) =>
    office.addMain({ id, provider: 'opencode', account: 'opencode', sessionId, cwd, role: 'Agente principal', startedAt: 0, status: 'idle' });
  add(A, SES_A, '/p/loja');
  add(B, SES_B, '/p/api');
  office.addSub({ id: SUB, parentId: A, sessionId: SUB.slice('opencode:'.length), role: 'Subagente', background: false, startedAt: 0 });
  registry = new MessageRegistry({ office, now: clock.now, ...(opts.opencode === false ? {} : { opencode: true }) });
  return { office, registry, clock };
}

const snapAgent = (office: Office, id: string): AgentInfo | undefined => office.commit().snapshot.agents.find((a) => a.id === id);
const sentId = (r: SendResult): string => {
  if (!('message' in r)) throw new Error(`recusada: ${JSON.stringify(r)}`);
  return r.message.id;
};
const text = (m: { text: string }) => m.text;

describe('mensagens ao OpenCode: presença do plugin (OC-23)', () => {
  it('sem o plugin buscando, o agente do OpenCode não recebe mensagens e o motivo diz como instalar', () => {
    const { registry } = setup();
    expect(registry.canMessage(A)).toBe(false);
    expect(registry.opencodeAvailable()).toBe(false);
    const r = registry.send({ agentId: A, text: 'oi' });
    expect(r).toMatchObject({ error: 'unavailable' });
    expect((r as { reason: string }).reason).toMatch(/opencode:install/);
  });

  it('a busca do plugin liga canMessage só do agente da sessão que ele serve, e vence 15 s depois', () => {
    const { office, registry, clock } = setup();
    office.commit();
    expect(office.commit().changed).toBe(false);
    expect(registry.opencodePoll({ session: SES_A })).toEqual([]);
    expect(registry.canMessage(A)).toBe(true);
    expect(registry.canMessage(B)).toBe(false);
    expect(registry.opencodeAvailable()).toBe(true);
    expect(registry.reachable()).toEqual(new Set([A]));
    expect(snapAgent(office, A)?.canMessage).toBe(true);
    expect(snapAgent(office, B)?.canMessage).toBeUndefined();

    clock.advance(PRESENCE_MS - 1);
    expect(registry.canMessage(A)).toBe(true);
    clock.advance(1);
    expect(registry.canMessage(A)).toBe(false);
    expect(registry.opencodeAvailable()).toBe(false);
    registry.tick();
    expect(snapAgent(office, A)?.canMessage).toBeUndefined();
  });

  it('sessão desconhecida, de outra ferramenta ou subagente: nenhuma mensagem e nenhuma presença', () => {
    const { registry } = setup();
    expect(registry.opencodePoll({ session: 'ses_' + 'z'.repeat(26) })).toEqual([]);
    expect(registry.opencodePoll({ session: SUB.slice('opencode:'.length) })).toEqual([]);
    expect(registry.opencodeAvailable()).toBe(false);
  });

  it('subagente nunca recebe mensagens (só o principal)', () => {
    const { registry } = setup();
    registry.opencodePoll({ session: SES_A });
    const r = registry.send({ agentId: SUB, text: 'oi' });
    expect(r).toMatchObject({ error: 'unavailable' });
    expect((r as { reason: string }).reason).toMatch(/subagentes/);
  });

  it('HABBLAUD_OPENCODE=0 (sem a opção): a busca não marca presença nem entrega nada', () => {
    const { registry } = setup({ opencode: false });
    expect(registry.opencodePoll({ session: SES_A })).toEqual([]);
    expect(registry.canMessage(A)).toBe(false);
    expect(registry.opencodeAvailable()).toBe(false);
    expect(registry.send({ agentId: A, text: 'oi' })).toMatchObject({ error: 'unavailable' });
  });
});

describe('mensagens ao OpenCode: validação (OC-26, mesmos limites do Codex)', () => {
  it('vazia, sem agente ou além de 20.000 caracteres: 400 (InvalidRequest)', () => {
    const { registry } = setup();
    registry.opencodePoll({ session: SES_A });
    expect(() => registry.send({ agentId: A, text: '   ' })).toThrow(/vazia/);
    expect(() => registry.send({ agentId: A })).toThrow(/esperado/);
    expect(() => registry.send({ agentId: A, text: 'x'.repeat(MAX_TEXT + 1) })).toThrow(/20\.000/);
    expect(MAX_TEXT).toBe(20_000);
    expect(registry.send({ agentId: A, text: 'x'.repeat(MAX_TEXT) })).toHaveProperty('message');
  });

  it('o corpo da busca e da confirmação é validado', () => {
    const { registry } = setup();
    expect(() => registry.opencodePoll({})).toThrow();
    expect(() => registry.opencodePoll({ session: 'sess-1' })).toThrow();
    expect(() => registry.opencodePoll('x')).toThrow();
    expect(() => registry.opencodeAck({ results: [] })).toThrow();
    expect(() => registry.opencodeAck({ session: SES_A })).toThrow();
  });
});

describe('mensagens ao OpenCode: entrega e confirmação (OC-24)', () => {
  it('a sessão A só recebe as mensagens do agente A, uma vez; o texto vai como foi digitado', () => {
    const { registry } = setup();
    registry.opencodePoll({ session: SES_A });
    registry.opencodePoll({ session: SES_B });
    const ida = sentId(registry.send({ agentId: A, text: '  faça X\n' }));
    const idb = sentId(registry.send({ agentId: B, text: 'faça Y' }));
    expect(registry.get(ida)?.status).toBe('queued');

    const gotB = registry.opencodePoll({ session: SES_B });
    expect(gotB.map(text)).toEqual(['faça Y']);
    expect(gotB[0].id).toBe(idb);
    const gotA = registry.opencodePoll({ session: SES_A });
    expect(gotA.map(text)).toEqual(['  faça X\n']);
    expect(registry.get(ida)?.status).toBe('sent');
    expect(registry.opencodePoll({ session: SES_A })).toEqual([]);
  });

  it('confirmação ok: entregue e com a atividade no feed; o texto não sai na resposta', () => {
    const { registry, office } = setup();
    registry.opencodePoll({ session: SES_A });
    const id = sentId(registry.send({ agentId: A, text: 'segredo-do-usuario' }));
    registry.opencodePoll({ session: SES_A });
    registry.opencodeAck({ session: SES_A, results: [{ id, ok: true }] });
    const m = registry.get(id);
    expect(m?.status).toBe('delivered');
    expect(JSON.stringify(m)).not.toContain('segredo');
    expect(snapAgent(office, A)?.recent.length).toBeGreaterThan(0);
  });

  it('confirmação com erro: falha com o motivo; id de outra sessão ou desconhecido é ignorado', () => {
    const { registry } = setup();
    registry.opencodePoll({ session: SES_A });
    const id = sentId(registry.send({ agentId: A, text: 'oi' }));
    registry.opencodePoll({ session: SES_A });
    registry.opencodeAck({ session: SES_B, results: [{ id, ok: true }] });
    expect(registry.get(id)?.status).toBe('sent');
    registry.opencodeAck({ session: SES_A, results: [{ id: 'nao-existe', ok: true }, { id, ok: false, error: 'promptAsync recusou' }] });
    expect(registry.get(id)).toMatchObject({ status: 'failed', error: 'promptAsync recusou' });
  });

  it('as rotas do Claude Code e do Codex nunca entregam nem confirmam mensagens do OpenCode', () => {
    const { registry } = setup();
    registry.opencodePoll({ session: SES_A });
    const id = sentId(registry.send({ agentId: A, text: 'oi' }));
    expect(registry.inbox({ session: SES_A })).toEqual([]);
    expect(registry.codexPoll({})).toEqual([]);
    expect(registry.get(id)?.status).toBe('queued');
    registry.opencodePoll({ session: SES_A });
    registry.ack({ session: SES_A, results: [{ id, ok: true }] });
    registry.codexAck({ results: [{ id, ok: true }] });
    expect(registry.get(id)?.status).toBe('sent');
  });
});

describe('mensagens ao OpenCode: prazo de 20 s (OC-25)', () => {
  it('sem confirmação em 20 s a mensagem falha; uma confirmação atrasada ainda corrige', () => {
    const { registry, clock } = setup();
    registry.opencodePoll({ session: SES_A });
    const id = sentId(registry.send({ agentId: A, text: 'oi' }));
    registry.opencodePoll({ session: SES_A });
    clock.advance(ACK_MS - 1);
    registry.tick();
    expect(registry.get(id)?.status).toBe('sent');
    clock.advance(1);
    registry.tick();
    expect(registry.get(id)).toMatchObject({ status: 'failed', error: ERR_OPENCODE_NOT_CONFIRMED });
    registry.opencodeAck({ session: SES_A, results: [{ id, ok: true }] });
    expect(registry.get(id)?.status).toBe('delivered');
  });

  it('mensagem que o plugin nunca buscou também falha (fila)', () => {
    const { registry, clock } = setup();
    registry.opencodePoll({ session: SES_A });
    const id = sentId(registry.send({ agentId: A, text: 'oi' }));
    clock.advance(61_000);
    registry.tick();
    expect(registry.get(id)?.status).toBe('failed');
    expect(registry.get(id)?.error).toMatch(/opencode/i);
  });
});

describe('rotas /api/opencode/bridge/*', () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  async function serve() {
    const tmp = tempDir();
    const late: { registry?: MessageRegistry } = {};
    const office = new Office({
      names: new NameStore(null),
      version: 't',
      startedAt: Date.now(),
      accounts: () => [],
      sources: () => [],
      accountName: () => undefined,
      messages: () => late.registry?.reachable() ?? new Set(),
    });
    const hub = new Hub(office, { throttleMs: 10 });
    const registry = new MessageRegistry({ office, opencode: true });
    late.registry = registry;
    const accounts = new AccountsService({ dirs: [], home: tmp.dir, env: {}, onChange: () => {} });
    const api = createApiHandler({ office, hub, accounts, sources: () => [], version: 't', inDocker: false, terminal: true, messages: createMessageRoutes(registry) });
    const guard = createRequestGuard({ allowedHosts: new Set(['habblaud.lan']) });
    const server = http.createServer((req, res) => {
      if (guard(req, res)) return;
      if (!api(req, res, new URL(req.url ?? '/', 'http://x'))) res.writeHead(404).end();
    });
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    office.addMain({ id: A, provider: 'opencode', account: 'opencode', sessionId: SES_A, cwd: '/p/loja', role: 'Agente principal', startedAt: Date.now(), status: 'idle' });
    close = () =>
      new Promise((ok) => {
        hub.stop();
        server.closeAllConnections();
        server.close(() => {
          tmp.cleanup();
          ok();
        });
      });
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  it('fluxo completo: página manda, o plugin busca, confirma e a página vê entregue; o snapshot diz canMessage', async () => {
    const base = await serve();
    const poll = (session: string) => request(base, '/api/opencode/bridge/poll', { method: 'POST', body: { session } });
    expect((await poll(SES_A)).json).toEqual({ messages: [] });
    const snap = (await request(base, '/api/snapshot')).json as OfficeSnapshot;
    expect(snap.agents.find((a) => a.id === A)?.canMessage).toBe(true);

    const sent = await request(base, '/api/messages', { method: 'POST', body: { agentId: A, text: 'oi opencode' } });
    expect(sent.status).toBe(201);
    const id = (sent.json as { id: string }).id;
    expect(((await poll(SES_B)).json as { messages: unknown[] }).messages).toEqual([]);
    expect((await poll(SES_A)).json).toEqual({ messages: [{ id, text: 'oi opencode' }] });
    const ack = await request(base, '/api/opencode/bridge/ack', { method: 'POST', body: { session: SES_A, results: [{ id, ok: true }] } });
    expect(ack.json).toEqual({ ok: true });
    expect(((await request(base, `/api/messages/${id}`)).json as { status: string }).status).toBe('delivered');
  });

  it('400 com corpo inválido, 405 fora do POST, 403 com Host que não é local', async () => {
    const base = await serve();
    expect((await request(base, '/api/opencode/bridge/poll', { method: 'POST', body: { session: 'x' } })).status).toBe(400);
    expect((await request(base, '/api/opencode/bridge/ack', { method: 'POST', body: { results: [] } })).status).toBe(400);
    expect((await request(base, '/api/opencode/bridge/poll')).status).toBe(405);
    expect((await request(base, '/api/opencode/bridge/ack')).status).toBe(405);
    for (const path of ['/api/opencode/bridge/poll', '/api/opencode/bridge/ack']) {
      const r = await request(base, path, { method: 'POST', body: { session: SES_A, results: [] }, headers: { Host: 'habblaud.lan' } });
      expect(r.status, path).toBe(403);
    }
  });
});
