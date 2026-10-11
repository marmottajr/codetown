// Entrega de mensagens no plugin do OpenCode (mod/habblaud-opencode/plugin.js): o plugin busca em
// POST /api/opencode/bridge/poll só as mensagens das sessões que ele serve (as que viu pelos eventos ou pela lista do
// próprio cliente), entrega com client.session.promptAsync({path:{id}, body:{parts:[{type:'text', text}]}}) e confirma
// em /api/opencode/bridge/ack (OC-24); nunca busca nem entrega nada de sessão que não é dele; nunca lança, não
// segura o processo vivo (timer unref) e para quando o OpenCode encerra a instância. Rotas de verdade (Office +
// MessageRegistry) em 127.0.0.1, HOME temporário, cliente falso; nunca o OpenCode de verdade. Dados sintéticos.
import { spawn } from 'node:child_process';
import http from 'node:http';
import { createServer, type AddressInfo } from 'node:net';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { OfficeSnapshot } from '../../shared/types';
import { AccountsService } from '../accounts/service';
import { createApiHandler } from '../http/app';
import { createRequestGuard } from '../http/guard';
import { Hub } from '../http/sse';
import { setQuiet } from '../log';
import { createMessageRoutes } from '../messages/http';
import { MessageRegistry } from '../messages/registry';
import { NameStore } from '../model/names';
import { Office } from '../model/office';
import { tempDir } from './fixtures';
import { ocId } from './opencode-fixtures';
import { request } from './permission-server';

setQuiet(true);

const PLUGIN = resolve(__dirname, '../../mod/habblaud-opencode/plugin.js');
type Hooks = { event: (input: unknown) => Promise<void> };
const mod = (await import(pathToFileURL(PLUGIN).href)) as { HabblaudPlugin: (ctx: unknown) => Promise<Hooks> };

const SES_A = ocId('ses', 11);
const SES_B = ocId('ses', 12);
const A = `opencode:${SES_A}`;
const B = `opencode:${SES_B}`;

interface Prompt {
  path: { id: string };
  body: { parts: Array<{ type: string; text: string }> };
}

/** Cliente v1 falso: guarda os promptAsync; `list` devolve as sessões que o OpenCode diria ser dele. */
function fakeClient(over: { prompt?: (p: Prompt) => Promise<unknown>; list?: unknown } = {}) {
  const prompts: Prompt[] = [];
  const client = {
    session: {
      promptAsync: async (p: Prompt) => {
        prompts.push(p);
        return over.prompt ? over.prompt(p) : { data: undefined, response: { ok: true } };
      },
      ...(over.list ? { list: async () => ({ data: over.list }) } : {}),
    },
  };
  return { client, prompts };
}

let tmp: ReturnType<typeof tempDir>;
let home: string;
let saved: Record<string, string | undefined>;
const closers: Array<() => Promise<void>> = [];

const writeConfig = (cfg: Record<string, unknown>): void => {
  mkdirSync(join(home, '.habblaud'), { recursive: true });
  writeFileSync(join(home, '.habblaud', 'opencode-hook.json'), JSON.stringify(cfg));
};
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
async function waitFor<T>(get: () => T | undefined | false, ms = 6_000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = get();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('tempo esgotado esperando a condição');
    await sleep(20);
  }
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
  for (const h of started.splice(0)) await h.event({ event: { type: 'server.instance.disposed', properties: {} } });
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  for (const c of closers.splice(0)) await c();
  tmp.cleanup();
});

/** Habblaud de verdade (rotas das mensagens) com os agentes principais A e B do OpenCode; guarda o que o plugin pede. */
async function serve() {
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
  const registry = new MessageRegistry({ office, opencode: true, tickMs: 50 });
  late.registry = registry;
  registry.start();
  const accounts = new AccountsService({ dirs: [], home: tmp.dir, env: {}, onChange: () => {} });
  const api = createApiHandler({ office, hub, accounts, sources: () => [], version: 't', inDocker: false, terminal: true, messages: createMessageRoutes(registry) });
  const guard = createRequestGuard({ allowedHosts: new Set(['habblaud.lan']) });
  const polled: string[] = [];
  const rawPoll = registry.opencodePoll.bind(registry);
  registry.opencodePoll = (raw: unknown) => {
    polled.push((raw as { session?: string })?.session ?? '?');
    return rawPoll(raw);
  };
  const server = http.createServer((req, res) => {
    if (guard(req, res)) return;
    if (!api(req, res, new URL(req.url ?? '/', 'http://x'))) res.writeHead(404).end();
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const port = (server.address() as AddressInfo).port;
  const add = (id: string, sessionId: string, cwd: string) =>
    office.addMain({ id, provider: 'opencode', account: 'opencode', sessionId, cwd, role: 'Agente principal (OpenCode)', startedAt: Date.now(), status: 'idle' });
  add(A, SES_A, '/p/loja');
  add(B, SES_B, '/p/api');
  closers.push(
    () =>
      new Promise((ok) => {
        registry.stop();
        hub.stop();
        server.closeAllConnections();
        server.close(() => ok());
      }),
  );
  writeConfig({ port });
  const base = `http://127.0.0.1:${port}`;
  return {
    base,
    port,
    polled,
    /** Busca de outro plugin (não conta em `polled`). */
    rawPoll,
    registry,
    send: (agentId: string, text: string) => request(base, '/api/messages', { method: 'POST', body: { agentId, text } }),
    status: async (id: string) => ((await request(base, `/api/messages/${id}`)).json as { status: string; error?: string }),
    snapshot: async () => (await request(base, '/api/snapshot')).json as OfficeSnapshot,
  };
}

const started: Hooks[] = [];
/** Inicia o plugin; o afterEach o encerra (server.instance.disposed) para nenhum timer atravessar os testes. */
const start = async (client: unknown): Promise<Hooks> => {
  const hooks = await mod.HabblaudPlugin({ client, directory: '/p/loja' });
  started.push(hooks);
  return hooks;
};
const status = (sessionID: string) => ({ event: { type: 'session.status', properties: { sessionID, status: { type: 'busy' } } } });

describe('plugin do OpenCode: mensagens (OC-23, OC-24)', () => {
  it('busca a sessão que serve, entrega com promptAsync no formato exato e confirma; o escritório vê o agente conectado e a mensagem entregue', async () => {
    const s = await serve();
    const { client, prompts } = fakeClient();
    const hooks = await start(client);
    await hooks.event(status(SES_A));
    // plugin conectado (OC-23): o snapshot passa a dizer canMessage
    await waitFor(() => s.registry.canMessage(A));
    expect((await s.snapshot()).agents.find((a) => a.id === A)?.canMessage).toBe(true);

    const sent = await s.send(A, '  faça o teste\n');
    expect(sent.status).toBe(201);
    const id = (sent.json as { id: string }).id;
    await waitFor(() => prompts.length === 1);
    expect(prompts).toEqual([{ path: { id: SES_A }, body: { parts: [{ type: 'text', text: '  faça o teste\n' }] } }]);
    await waitFor(() => s.registry.get(id)?.status === 'delivered');
  });

  it('promptAsync que recusa ou lança: confirma com erro e a mensagem falha com o motivo', async () => {
    const s = await serve();
    const { client } = fakeClient({ prompt: async () => ({ error: { name: 'x' }, response: { ok: false } }) });
    const hooks = await start(client);
    await hooks.event(status(SES_A));
    await waitFor(() => s.registry.canMessage(A));
    const id = ((await s.send(A, 'oi')).json as { id: string }).id;
    await waitFor(() => s.registry.get(id)?.status === 'failed');
    expect(s.registry.get(id)?.error).toBeTruthy();

    await hooks.event({ event: { type: 'server.instance.disposed', properties: {} } }); // um plugin só por vez nesta sessão
    const thrower = fakeClient({
      prompt: async () => {
        throw new Error('sessão trancada');
      },
    });
    const hooks2 = await start(thrower.client);
    await hooks2.event(status(SES_A));
    const id2 = ((await s.send(A, 'de novo')).json as { id: string }).id;
    await waitFor(() => s.registry.get(id2)?.status === 'failed');
    expect(s.registry.get(id2)?.error).toMatch(/sessão trancada/);
  });

  it('só busca e entrega as sessões que serve: a mensagem do agente B nunca passa pelo plugin que só viu a sessão A', async () => {
    const s = await serve();
    const { client, prompts } = fakeClient();
    const hooks = await start(client);
    await hooks.event(status(SES_A));
    await waitFor(() => s.registry.canMessage(A));
    // B tem outro plugin conectado (simulado pelo registro): a mensagem dele fica na fila
    s.rawPoll({ session: SES_B });
    const idb = ((await s.send(B, 'para B')).json as { id: string }).id;
    const ida = ((await s.send(A, 'para A')).json as { id: string }).id;
    await waitFor(() => prompts.length >= 1);
    await sleep(1_800);
    expect(prompts.map((p) => [p.path.id, p.body.parts[0].text])).toEqual([[SES_A, 'para A']]);
    expect(s.registry.get(idb)?.status).toBe('queued');
    expect(s.registry.get(ida)?.status).toBe('delivered');
    expect(new Set(s.polled)).toEqual(new Set([SES_A]));
  }, 20_000);

  it('sessões que não casam com ses_<26> nunca são buscadas (eventos de fora, ids estranhos)', async () => {
    const s = await serve();
    const { client } = fakeClient();
    const hooks = await start(client);
    await hooks.event(status('../../etc/passwd'));
    await hooks.event(status('ses_curto'));
    await hooks.event(status(SES_A));
    await waitFor(() => s.polled.length >= 1);
    await sleep(1_800);
    expect(new Set(s.polled)).toEqual(new Set([SES_A]));
  }, 20_000);

  it('sem eventos ainda, as sessões da lista do próprio cliente já são servidas', async () => {
    const s = await serve();
    const { client, prompts } = fakeClient({ list: [{ id: SES_B }, { id: 'lixo' }] });
    await start(client);
    await waitFor(() => s.registry.canMessage(B));
    const id = ((await s.send(B, 'pela lista')).json as { id: string }).id;
    await waitFor(() => prompts.length === 1);
    expect(prompts[0].path.id).toBe(SES_B);
    await waitFor(() => s.registry.get(id)?.status === 'delivered');
    expect(s.registry.canMessage(A)).toBe(false);
  });

  it('Habblaud fora do ar: nada lança, o OpenCode não espera e a busca volta quando ele volta', async () => {
    const dead = createServer();
    await new Promise<void>((ok) => dead.listen(0, '127.0.0.1', ok));
    const port = (dead.address() as AddressInfo).port;
    await new Promise<void>((ok) => dead.close(() => ok()));
    writeConfig({ port });
    const { client, prompts } = fakeClient();
    const hooks = await start(client);
    await expect(hooks.event(status(SES_A))).resolves.toBeUndefined();
    await sleep(1_900);
    expect(prompts).toEqual([]);
  }, 20_000);

  it('o timer não segura o processo (unref): um processo com o plugin e o servidor fora do ar termina sozinho', async () => {
    const dead = createServer();
    await new Promise<void>((ok) => dead.listen(0, '127.0.0.1', ok));
    const port = (dead.address() as AddressInfo).port;
    await new Promise<void>((ok) => dead.close(() => ok()));
    writeConfig({ port });
    const code = `
      const m = await import(${JSON.stringify(pathToFileURL(PLUGIN).href)});
      const hooks = await m.HabblaudPlugin({ client: {}, directory: '/p' });
      await hooks.event({ event: { type: 'session.status', properties: { sessionID: ${JSON.stringify(SES_A)}, status: { type: 'busy' } } } });
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, HOME: home }, stdio: 'ignore' });
    const exit = await new Promise<number | 'timeout'>((ok) => {
      const t = setTimeout(() => {
        child.kill('SIGKILL');
        ok('timeout');
      }, 8_000);
      child.on('exit', (c) => {
        clearTimeout(t);
        ok(c ?? -1);
      });
    });
    expect(exit).toBe(0);
  }, 15_000);

  it('server.instance.disposed encerra a busca (para limpo)', async () => {
    const s = await serve();
    const { client } = fakeClient();
    const hooks = await start(client);
    await hooks.event(status(SES_A));
    await waitFor(() => s.polled.length >= 1);
    await hooks.event({ event: { type: 'server.instance.disposed', properties: { directory: '/p/loja' } } });
    await sleep(100);
    const n = s.polled.length;
    await sleep(1_800);
    expect(s.polled.length).toBe(n);
  }, 20_000);
});
