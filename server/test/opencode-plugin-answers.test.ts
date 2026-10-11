// Responder perguntas do OpenCode pelo escritório (mod/habblaud-opencode/plugin.js, OQ-10 a OQ-15 e OQ-17): em
// question.asked o plugin registra em /api/permissions (rotas de verdade, provider "opencode", AskUserQuestion), espera
// a decisão numa tarefa própria e responde por client._client.post em /question/{id}/reply|reject (cliente falso; o
// cliente v1 não tem métodos de pergunta). Servidores locais em 127.0.0.1 e HOME temporário; nunca o OpenCode de
// verdade. Dados sintéticos.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setQuiet } from '../log';
import { tempDir } from './fixtures';
import { ocId } from './opencode-fixtures';
import { request, servePermissions, type PermissionServer } from './permission-server';

setQuiet(true);

const PLUGIN = resolve(__dirname, '../../mod/habblaud-opencode/plugin.js');
type Hooks = { event: (input: unknown) => Promise<void> };
const mod = (await import(pathToFileURL(PLUGIN).href)) as { HabblaudPlugin: (ctx: unknown) => Promise<Hooks> };

const SES = ocId('ses', 5);
const OC_MAIN = `opencode:${SES}`;
const QID = 'que_0123456789abcdef';

interface PostArg {
  url: string;
  path: { requestID: string };
  body?: { answers: string[][] };
  headers?: Record<string, string>;
}

/** Cliente falso: só `_client.post` (o v1 não tem métodos de pergunta). `reply` devolve o que o teste quiser. */
function fakeClient(result: (arg: PostArg) => unknown = () => ({ data: true }), extra: Record<string, unknown> = {}) {
  const calls: PostArg[] = [];
  return {
    calls,
    client: {
      _client: {
        post: async (arg: PostArg) => {
          calls.push(arg);
          return result(arg);
        },
        ...extra,
      },
    },
  };
}

const QUESTIONS = [
  { question: 'Qual banco?', header: 'Banco', options: [{ label: 'Postgres', description: 'remoto' }, { label: 'SQLite', description: 'local' }] },
  { question: 'Quais testes?', header: 'Testes', multiple: true, options: [{ label: 'Unidade', description: 'u' }, { label: 'E2E', description: 'e' }, { label: 'Lint', description: 'l' }] },
  { question: 'Nome do serviço?', header: 'Nome', options: [{ label: 'api', description: 'a' }] },
];
const asked = (over: Record<string, unknown> = {}) => ({ type: 'question.asked', properties: { id: QID, sessionID: SES, questions: QUESTIONS, tool: { messageID: 'msg_1', callID: 'call_1' }, ...over } });

let tmp: ReturnType<typeof tempDir>;
let home: string;
let srv: PermissionServer | undefined;
let saved: Record<string, string | undefined>;
const closers: Array<() => Promise<void>> = [];
const hooksToStop: Hooks[] = [];

function writeConfig(cfg: Record<string, unknown>): void {
  mkdirSync(join(home, '.habblaud'), { recursive: true });
  writeFileSync(join(home, '.habblaud', 'opencode-hook.json'), JSON.stringify(cfg));
}

beforeEach(() => {
  tmp = tempDir();
  home = join(tmp.dir, 'home');
  mkdirSync(home, { recursive: true });
  saved = { HOME: process.env.HOME, HABBLAUD_PORT: process.env.HABBLAUD_PORT };
  process.env.HOME = home;
  delete process.env.HABBLAUD_PORT;
});
afterEach(async () => {
  vi.restoreAllMocks();
  for (const h of hooksToStop.splice(0)) await h.event({ event: { type: 'server.instance.disposed', properties: {} } });
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await srv?.close();
  srv = undefined;
  for (const c of closers.splice(0)) await c();
  tmp.cleanup();
});

async function serve(opts: { viewers?: number } = {}): Promise<PermissionServer> {
  srv = await servePermissions({ viewers: opts.viewers });
  srv.office.addMain({ id: OC_MAIN, provider: 'opencode', account: 'opencode', sessionId: SES, cwd: '/p/loja', role: 'Agente principal (OpenCode)', startedAt: Date.now(), status: 'working' });
  writeConfig({ port: srv.port, permissionTimeoutS: 30 });
  return srv;
}

async function waitFor<T>(get: () => T | undefined | false, ms = 4_000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = get();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('tempo esgotado esperando a condição');
    await new Promise((ok) => setTimeout(ok, 15));
  }
}

const pendingId = (s: PermissionServer) => waitFor(() => s.registry!.snapshot().get(OC_MAIN)?.id);
const decide = (s: PermissionServer, id: string, body: Record<string, unknown>) => request(s.base, `/api/permissions/${id}/decision`, { method: 'POST', body });
const settle = (ms = 250) => new Promise((ok) => setTimeout(ok, ms));
const start = async (client: unknown) => {
  const h = await mod.HabblaudPlugin({ client, directory: '/p/loja' });
  hooksToStop.push(h);
  return h;
};

/** Habblaud falso (só para ver o que o plugin manda): guarda os corpos e responde como o teste pedir. */
async function fakeHabblaud(onWait: () => unknown = () => ({ status: 'pending' })) {
  const seen: Array<{ method: string; url: string; body: unknown }> = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', body: raw ? JSON.parse(raw) : undefined });
      const send = (status: number, json: unknown) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(json));
      if (req.url === '/api/permissions') return send(201, { id: 'p-fake-1', expiresAt: Date.now() + 700_000 });
      if (req.url?.includes('/wait')) return send(200, onWait());
      send(200, { ok: true, messages: [] });
    });
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  closers.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((ok) => server.close(() => ok()));
  });
  const port = (server.address() as AddressInfo).port;
  writeConfig({ port });
  return { seen, port };
}

describe('plugin do OpenCode: perguntas respondidas pelo escritório', () => {
  it('OQ-10: registra em /api/permissions como AskUserQuestion, com as perguntas na ordem original e o prazo de 600 s', async () => {
    const f = await fakeHabblaud();
    const { client } = fakeClient();
    const hooks = await start(client);
    await hooks.event({ event: asked() });
    const reg = await waitFor(() => f.seen.find((s) => s.url === '/api/permissions'));
    expect(reg.method).toBe('POST');
    expect(reg.body).toEqual({
      provider: 'opencode',
      session_id: SES,
      tool_name: 'AskUserQuestion',
      tool_input: {
        questions: [
          { question: 'Qual banco?', header: 'Banco', options: [{ label: 'Postgres', description: 'remoto' }, { label: 'SQLite', description: 'local' }], multiSelect: false },
          { question: 'Quais testes?', header: 'Testes', options: [{ label: 'Unidade', description: 'u' }, { label: 'E2E', description: 'e' }, { label: 'Lint', description: 'l' }], multiSelect: true },
          { question: 'Nome do serviço?', header: 'Nome', options: [{ label: 'api', description: 'a' }], multiSelect: false },
        ],
      },
      timeout_ms: 600_000,
      cwd: '/p/loja',
    });
  });

  it('OQ-12: answer vira reply com string[][] de rótulos na ordem (uma opção; várias na mesma lista; texto livre como digitado)', async () => {
    const s = await serve();
    const { client, calls } = fakeClient();
    const hooks = await start(client);
    await hooks.event({ event: asked() });
    const id = await pendingId(s);
    const card = s.registry!.snapshot().get(OC_MAIN)!;
    expect(card).toMatchObject({ tool: 'AskUserQuestion', provider: 'opencode' });
    expect(card.questions!.map((q) => q.index)).toEqual([0, 1, 2]);
    const answers = [
      { question: 2, other: 'meu-servico' },
      { question: 1, options: [2, 0], other: 'extra' },
      { question: 0, options: [1] },
    ];
    expect((await decide(s, id, { behavior: 'answer', answers })).status).toBe(200);
    await waitFor(() => calls.length === 1);
    expect(calls[0]).toEqual({
      url: '/question/{requestID}/reply',
      path: { requestID: QID },
      body: { answers: [['SQLite'], ['Unidade', 'Lint', 'extra'], ['meu-servico']] },
      headers: { 'Content-Type': 'application/json' },
    });
  });

  it('OQ-12: uma pergunta de escolha única respondida só com texto livre manda o texto no lugar da opção', async () => {
    const s = await serve();
    const { client, calls } = fakeClient();
    const hooks = await start(client);
    await hooks.event({ event: asked({ questions: [QUESTIONS[0]] }) });
    await decide(s, await pendingId(s), { behavior: 'answer', answers: [{ question: 0, other: 'MariaDB' }] });
    await waitFor(() => calls.length === 1);
    expect(calls[0].body).toEqual({ answers: [['MariaDB']] });
  });

  it('OQ-13: deny (não responder) chama reject, sem corpo', async () => {
    const s = await serve();
    const { client, calls } = fakeClient();
    const hooks = await start(client);
    await hooks.event({ event: asked() });
    await decide(s, await pendingId(s), { behavior: 'deny' });
    await waitFor(() => calls.length === 1);
    expect(calls[0]).toEqual({ url: '/question/{requestID}/reject', path: { requestID: QID } });
    expect('body' in calls[0]).toBe(false);
  });

  it('OQ-14: "responder no terminal" não faz nada; a resposta do OpenCode (replied) libera o cartão e a espera termina', async () => {
    const s = await serve();
    const { client, calls } = fakeClient();
    const hooks = await start(client);
    await hooks.event({ event: asked() });
    await decide(s, await pendingId(s), { behavior: 'terminal' });
    await settle();
    expect(calls).toEqual([]);
    await hooks.event({ event: asked({ id: 'que_dois' }) });
    await pendingId(s);
    s.registry!.releaseOpencodeQuestions(SES);
    await settle();
    expect(calls).toEqual([]);
    expect(s.registry!.size).toBe(0);
  });

  it('OQ-14: passados 600 s (relógio adiantado) sem decisão, o plugin para de esperar e não responde nada', async () => {
    let waits = 0;
    const real = Date.now.bind(Date);
    let offset = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => real() + offset);
    const f = await fakeHabblaud(() => {
      waits++;
      offset += 601_000; // o relógio passa dos 600 s durante a primeira espera
      return { status: 'pending' };
    });
    const { client, calls } = fakeClient();
    const hooks = await start(client);
    await hooks.event({ event: asked() });
    await waitFor(() => waits >= 1);
    await settle(300);
    expect(waits).toBe(1);
    expect(calls).toEqual([]);
    const waitUrl = f.seen.find((x) => x.url.includes('/wait'))!.url;
    expect(Number(new URL(waitUrl, 'http://x').searchParams.get('timeout'))).toBeLessThanOrEqual(25);
  });

  it('OQ-11: sem página aberta, sessão desconhecida ou mais de 4 perguntas: nada é desviado nem respondido', async () => {
    const s = await serve({ viewers: 0 });
    const { client, calls } = fakeClient();
    const hooks = await start(client);
    await hooks.event({ event: asked() });
    await settle(300);
    expect(s.registry!.size).toBe(0);
    s.setViewers(1);
    await hooks.event({ event: asked({ id: 'que_outra', sessionID: ocId('ses', 99) }) });
    const five = Array.from({ length: 5 }, (_, i) => ({ question: `P${i}`, header: 'h', options: [{ label: 'a', description: 'a' }] }));
    await hooks.event({ event: asked({ id: 'que_cinco', questions: five }) });
    await settle(300);
    expect(s.registry!.size).toBe(0);
    expect(calls).toEqual([]);
  });

  it('OQ-15: 404 no reply ou no reject é ignorado (sem erro e sem tentar de novo pela URL base)', async () => {
    const s = await serve();
    const notFound = () => ({ error: { _tag: 'QuestionNotFoundError' }, response: { status: 404 } });
    const { client, calls } = fakeClient(notFound);
    const hooks = await start(client);
    await hooks.event({ event: asked() });
    await decide(s, await pendingId(s), { behavior: 'answer', answers: [{ question: 0, options: [0] }, { question: 1, options: [1] }, { question: 2, options: [0] }] });
    await waitFor(() => calls.length === 1);
    await hooks.event({ event: asked({ id: 'que_dois' }) });
    await decide(s, await pendingId(s), { behavior: 'deny' });
    await waitFor(() => calls.length === 2);
    await settle();
    expect(calls).toHaveLength(2);
  });

  it('OQ-17: id fora de ^[A-Za-z0-9_-]{1,64}$ não vira URL: nem registro, nem reply', async () => {
    const s = await serve();
    const { client, calls } = fakeClient();
    const hooks = await start(client);
    for (const id of ['../etc', 'a/b', 'a b', '', 'q'.repeat(65), 'que?x=1', 'que\n1', 42]) await hooks.event({ event: asked({ id }) });
    await settle(400);
    expect(s.registry!.size).toBe(0);
    expect(calls).toEqual([]);
    // o limite (64) vale
    await hooks.event({ event: asked({ id: 'q'.repeat(64), questions: [QUESTIONS[0]] }) });
    await decide(s, await pendingId(s), { behavior: 'answer', answers: [{ question: 0, options: [0] }] });
    await waitFor(() => calls.length === 1);
    expect(calls[0].path.requestID).toBe('q'.repeat(64));
  });

  it('OQ-17: sem _client.post, responde pela URL base do cliente (POST /question/{id}/reply) e nunca lança', async () => {
    const hits: Array<{ url: string; body: string }> = [];
    const oc = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        hits.push({ url: req.url ?? '', body: raw });
        res.writeHead(200, { 'Content-Type': 'application/json' }).end('true');
      });
    });
    await new Promise<void>((ok) => oc.listen(0, '127.0.0.1', ok));
    closers.push(async () => {
      oc.closeAllConnections();
      await new Promise<void>((ok) => oc.close(() => ok()));
    });
    const baseUrl = `http://127.0.0.1:${(oc.address() as AddressInfo).port}`;
    const s = await serve();
    const hooks = await start({ _client: { getConfig: () => ({ baseUrl }) } });
    await hooks.event({ event: asked() });
    await decide(s, await pendingId(s), { behavior: 'answer', answers: [{ question: 0, options: [0] }, { question: 1, options: [1] }, { question: 2, options: [0] }] });
    await waitFor(() => hits.length === 1);
    expect(hits[0].url).toBe(`/question/${QID}/reply`);
    expect(JSON.parse(hits[0].body)).toEqual({ answers: [['Postgres'], ['E2E'], ['api']] });
    await hooks.event({ event: asked({ id: 'que_dois' }) });
    await decide(s, await pendingId(s), { behavior: 'deny' });
    await waitFor(() => hits.length === 2);
    expect(hits[1]).toEqual({ url: '/question/que_dois/reject', body: '' });
  });

  /** Servidor do OpenCode falso que sempre responde 404 QuestionNotFoundError e conta os pedidos. */
  async function opencode404() {
    const hits: string[] = [];
    const oc = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        hits.push(`${req.method} ${req.url}`);
        res.writeHead(404, { 'Content-Type': 'application/json' }).end(JSON.stringify({ _tag: 'QuestionNotFoundError' }));
      });
    });
    await new Promise<void>((ok) => oc.listen(0, '127.0.0.1', ok));
    closers.push(async () => {
      oc.closeAllConnections();
      await new Promise<void>((ok) => oc.close(() => ok()));
    });
    return { hits, baseUrl: `http://127.0.0.1:${(oc.address() as AddressInfo).port}` };
  }

  it('OQ-15: 404 do _client.post não cai na URL base (nenhum pedido a mais) e os eventos seguintes fluem', async () => {
    const oc = await opencode404();
    const s = await serve();
    const { client, calls } = fakeClient(() => ({ error: { _tag: 'QuestionNotFoundError' }, response: { status: 404 } }), { getConfig: () => ({ baseUrl: oc.baseUrl }) });
    const hooks = await start(client);
    await hooks.event({ event: asked() });
    await decide(s, await pendingId(s), { behavior: 'answer', answers: [{ question: 0, options: [0] }, { question: 1, options: [1] }, { question: 2, options: [0] }] });
    await waitFor(() => calls.length === 1);
    await hooks.event({ event: asked({ id: 'que_dois' }) });
    await decide(s, await pendingId(s), { behavior: 'deny' });
    await waitFor(() => calls.length === 2);
    await settle();
    expect(calls).toHaveLength(2);
    expect(oc.hits).toEqual([]); // 404 é definitivo: sem segunda tentativa
    await hooks.event({ event: asked({ id: 'que_tres' }) });
    await pendingId(s); // o plugin segue vivo
  });

  it('OQ-15: _client.post que rejeita tenta a URL base uma vez por rota; o 404 de lá é ignorado, sem repetir', async () => {
    const oc = await opencode404();
    const s = await serve();
    const { client, calls } = fakeClient(() => {
      throw new Error('404 não encontrado');
    }, { getConfig: () => ({ baseUrl: oc.baseUrl }) });
    const hooks = await start(client);
    await hooks.event({ event: asked() });
    await decide(s, await pendingId(s), { behavior: 'answer', answers: [{ question: 0, options: [0] }, { question: 1, options: [1] }, { question: 2, options: [0] }] });
    await waitFor(() => oc.hits.length === 1);
    await hooks.event({ event: asked({ id: 'que_dois' }) });
    await decide(s, await pendingId(s), { behavior: 'deny' });
    await waitFor(() => oc.hits.length === 2);
    await settle();
    expect(calls).toHaveLength(2);
    expect(oc.hits).toEqual([`POST /question/${QID}/reply`, 'POST /question/que_dois/reject']);
    await hooks.event({ event: asked({ id: 'que_tres' }) });
    await pendingId(s);
  });

  it('OQ-15: 404 na URL base (sem _client.post) é ignorado: um pedido por rota, sem repetir, e os eventos seguintes fluem', async () => {
    const oc = await opencode404();
    const s = await serve();
    const hooks = await start({ _client: { getConfig: () => ({ baseUrl: oc.baseUrl }) } });
    await hooks.event({ event: asked() });
    await decide(s, await pendingId(s), { behavior: 'answer', answers: [{ question: 0, options: [0] }, { question: 1, options: [1] }, { question: 2, options: [0] }] });
    await waitFor(() => oc.hits.length === 1);
    await hooks.event({ event: asked({ id: 'que_dois' }) });
    await decide(s, await pendingId(s), { behavior: 'deny' });
    await waitFor(() => oc.hits.length === 2);
    await settle(400);
    expect(oc.hits).toEqual([`POST /question/${QID}/reply`, 'POST /question/que_dois/reject']);
    await hooks.event({ event: asked({ id: 'que_tres' }) });
    await pendingId(s);
  });

  it('o cliente que lança não derruba o plugin; Habblaud fora do ar não faz nada', async () => {
    const s = await serve();
    const { client, calls } = fakeClient(() => {
      throw new Error('quebrou');
    });
    const hooks = await start(client);
    await expect(hooks.event({ event: asked() })).resolves.toBeUndefined();
    await decide(s, await pendingId(s), { behavior: 'deny' });
    await waitFor(() => calls.length === 1);
    await settle();
    await s.close();
    srv = undefined;
    await expect(hooks.event({ event: asked({ id: 'que_tres' }) })).resolves.toBeUndefined();
    await settle(300);
    expect(calls).toHaveLength(1);
  });

  it('a espera de uma pergunta não trava os outros eventos nem a fila (session.idle segue saindo) e duas perguntas têm ids próprios', async () => {
    const f = await fakeHabblaud();
    const { client } = fakeClient();
    const hooks = await start(client);
    const t0 = Date.now();
    await hooks.event({ event: asked() });
    await hooks.event({ event: asked({ id: 'que_dois', questions: [QUESTIONS[0]] }) });
    await hooks.event({ event: { type: 'session.idle', properties: { sessionID: SES } } });
    expect(Date.now() - t0).toBeLessThan(500);
    await waitFor(() => f.seen.some((x) => x.url === '/api/opencode/events' && (x.body as { event: { type: string } }).event.type === 'session.idle'));
    await waitFor(() => f.seen.filter((x) => x.url === '/api/permissions').length === 2);
    expect(f.seen.filter((x) => x.url === '/api/permissions').map((x) => (x.body as { tool_input: { questions: unknown[] } }).tool_input.questions.length)).toEqual([3, 1]);
    // o mesmo id repetido não registra de novo
    await hooks.event({ event: asked() });
    await settle(200);
    expect(f.seen.filter((x) => x.url === '/api/permissions')).toHaveLength(2);
  });

  it('custom: false descarta o texto livre (só rótulos escolhidos); sem rótulo nenhum, nada é respondido', async () => {
    const s = await serve();
    const { client, calls } = fakeClient();
    const hooks = await start(client);
    const q = { ...QUESTIONS[1], custom: false };
    await hooks.event({ event: asked({ questions: [q] }) });
    await decide(s, await pendingId(s), { behavior: 'answer', answers: [{ question: 0, options: [1], other: 'solto' }] });
    await waitFor(() => calls.length === 1);
    expect(calls[0].body).toEqual({ answers: [['E2E']] });
    await hooks.event({ event: asked({ id: 'que_dois', questions: [{ ...QUESTIONS[0], custom: false }] }) });
    await decide(s, await pendingId(s), { behavior: 'answer', answers: [{ question: 0, other: 'so texto' }] });
    await settle();
    expect(calls).toHaveLength(1);
  });
});
