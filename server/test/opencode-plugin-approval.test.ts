// Aprovação pelo escritório no plugin do OpenCode (mod/habblaud-opencode/plugin.js): em permission.asked (ou
// permission.updated, nas versões antigas) registra o pedido em /api/permissions (rotas de verdade, provider
// "opencode"), espera a decisão e responde pelo cliente falso do plugin: allow = "once", deny = "reject" com o
// motivo, nunca "always" (OC-20); tempo esgotado, sem página aberta ou Habblaud fora do ar = nada é feito (OC-21);
// o id do pedido é validado antes de ir para uma URL. HOME temporário; nunca o OpenCode de verdade. Dados sintéticos.
import http from 'node:http';
import { createServer, type AddressInfo } from 'node:net';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
const PER = 'per_0123456789abcdefABCDEF';

interface Call {
  path: { id: string; permissionID: string };
  body: { response: string; message?: string };
}

/** Cliente v1 falso: guarda as respostas de permissão. */
function fakeClient(over: Record<string, unknown> = {}) {
  const calls: Call[] = [];
  return {
    calls,
    client: {
      postSessionIdPermissionsPermissionId: async (arg: Call) => {
        calls.push(arg);
        return { data: true };
      },
      ...over,
    },
  };
}

const asked = (over: Record<string, unknown> = {}) => ({
  type: 'permission.asked',
  properties: { id: PER, sessionID: SES, permission: 'bash', patterns: ['git status'], metadata: { command: 'git status' }, always: ['git status'], ...over },
});

let tmp: ReturnType<typeof tempDir>;
let home: string;
let srv: PermissionServer | undefined;
let saved: Record<string, string | undefined>;
const closers: Array<() => Promise<void>> = [];

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
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await srv?.close();
  srv = undefined;
  for (const c of closers.splice(0)) await c();
  tmp.cleanup();
});

async function serve(opts: { viewers?: number; wait?: number } = {}): Promise<PermissionServer> {
  srv = await servePermissions({ viewers: opts.viewers });
  srv.office.addMain({ id: OC_MAIN, provider: 'opencode', account: 'opencode', sessionId: SES, cwd: '/p/loja', role: 'Agente principal (OpenCode)', startedAt: Date.now(), status: 'working' });
  writeConfig({ port: srv.port, permissionTimeoutS: opts.wait ?? 30 });
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
const start = (client: unknown) => mod.HabblaudPlugin({ client, directory: '/p/loja' });

describe('plugin do OpenCode: aprovação pelo escritório', () => {
  it('OC-20: allow no escritório responde "once" ao OpenCode, com a sessão e o id do pedido', async () => {
    const s = await serve();
    const { client, calls } = fakeClient();
    const hooks = await start(client);
    await hooks.event({ event: asked() });
    const id = await pendingId(s);
    expect(s.registry!.snapshot().get(OC_MAIN)).toMatchObject({ provider: 'opencode', tool: 'bash', title: 'Bash(git status)' });
    expect((await decide(s, id, { behavior: 'allow' })).status).toBe(200);
    await waitFor(() => calls.length === 1);
    expect(calls).toEqual([{ path: { id: SES, permissionID: PER }, body: { response: 'once' } }]);
  });

  it('OC-20: deny leva o motivo digitado ("reject" + mensagem); sem motivo, só a frase padrão', async () => {
    const s = await serve();
    const { client, calls } = fakeClient();
    const hooks = await start(client);
    await hooks.event({ event: asked() });
    await decide(s, await pendingId(s), { behavior: 'deny', message: 'Use o branch de teste' });
    await waitFor(() => calls.length === 1);
    expect(calls[0].body).toEqual({ response: 'reject', message: 'Recusado pelo usuário no Habblaud: Use o branch de teste' });
    await hooks.event({ event: asked({ id: 'per_segundo' }) });
    await decide(s, await waitFor(() => s.registry!.snapshot().get(OC_MAIN)?.id), { behavior: 'deny' });
    await waitFor(() => calls.length === 2);
    expect(calls[1].body).toEqual({ response: 'reject', message: 'Recusado pelo usuário no Habblaud.' });
  });

  it('nunca responde "always", mesmo com always no evento; "responder no terminal" não responde nada', async () => {
    const s = await serve();
    const { client, calls } = fakeClient();
    const hooks = await start(client);
    await hooks.event({ event: asked({ always: ['*'] }) });
    const id = await pendingId(s);
    expect((await decide(s, id, { behavior: 'allow', suggestion: 0 })).status).toBe(400); // "sempre permitir" não existe aqui
    await decide(s, id, { behavior: 'terminal' });
    await settle();
    expect(calls).toEqual([]);
    await hooks.event({ event: asked({ id: 'per_dois', always: ['*'] }) });
    await decide(s, await pendingId(s), { behavior: 'allow' });
    await waitFor(() => calls.length === 1);
    for (const c of calls) expect(['once', 'reject']).toContain(c.body.response);
  });

  it('permission.updated (formato v1: type, pattern, title) também vale, e o mesmo pedido em dois eventos é tratado uma vez', async () => {
    const s = await serve();
    const { client, calls } = fakeClient();
    const hooks = await start(client);
    const v1 = { type: 'permission.updated', properties: { id: PER, type: 'edit', pattern: 'src/app.ts', sessionID: SES, messageID: 'msg_x', title: 'Editar src/app.ts', metadata: { filepath: '/p/loja/src/app.ts', diff: '-a\n+b' } } };
    await hooks.event({ event: v1 });
    await hooks.event({ event: asked() }); // mesmo id (outra versão do evento)
    const id = await pendingId(s);
    expect(s.registry!.snapshot().get(OC_MAIN)).toMatchObject({ tool: 'edit', title: 'edit(/p/loja/src/app.ts)' });
    expect(s.registry!.size).toBe(1);
    await decide(s, id, { behavior: 'allow' });
    await waitFor(() => calls.length === 1);
    await settle();
    expect(calls).toHaveLength(1);
  });

  it('OC-21: sem página aberta, o pedido não é desviado e nada é respondido', async () => {
    await serve({ viewers: 0 });
    const { client, calls } = fakeClient();
    const hooks = await start(client);
    await hooks.event({ event: asked() });
    await settle(400);
    expect(calls).toEqual([]);
    expect(srv!.registry!.size).toBe(0);
  });

  it('OC-21: sessão que o Habblaud não mostra = nada é respondido', async () => {
    const s = await serve();
    const { client, calls } = fakeClient();
    const hooks = await start(client);
    await hooks.event({ event: asked({ sessionID: ocId('ses', 99) }) });
    await settle(400);
    expect(calls).toEqual([]);
    expect(s.registry!.size).toBe(0);
  });

  it('OC-21: passou a espera do arquivo (permissionTimeoutS) sem decisão: nada é respondido e o pedido do OpenCode fica', async () => {
    const s = await serve({ wait: 5 });
    const { client, calls } = fakeClient();
    const hooks = await start(client);
    const t0 = Date.now();
    await hooks.event({ event: asked() });
    await pendingId(s);
    await new Promise((ok) => setTimeout(ok, 5_600 - (Date.now() - t0)));
    expect(calls).toEqual([]);
    // uma decisão tardia não faz o plugin responder (ele já desistiu)
    await decide(s, await pendingId(s).catch(() => ''), { behavior: 'allow' }).catch(() => undefined);
    await settle(300);
    expect(calls).toEqual([]);
  }, 15_000);

  it('OC-21/OC-16: Habblaud fora do ar: o gancho volta normalmente e nada é respondido', async () => {
    const probe = createServer();
    await new Promise<void>((ok) => probe.listen(0, '127.0.0.1', ok));
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>((ok) => probe.close(() => ok()));
    writeConfig({ port });
    const { client, calls } = fakeClient();
    const hooks = await start(client);
    await expect(hooks.event({ event: asked() })).resolves.toBeUndefined();
    await settle(400);
    expect(calls).toEqual([]);
  });

  it('o id do pedido é validado antes de ir para uma URL: ids com / .. ? espaço ou enormes são ignorados', async () => {
    const hits: string[] = [];
    const server = http.createServer((req, res) => {
      hits.push(`${req.method} ${req.url}`);
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}');
    });
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    closers.push(() => new Promise<void>((ok) => (server.closeAllConnections(), server.close(() => ok()))));
    writeConfig({ port: (server.address() as AddressInfo).port });
    const { client, calls } = fakeClient();
    const hooks = await start(client);
    for (const id of ['../../etc/passwd', 'per/1', 'per?x=1', 'per 1', 'per#1', '', 'p'.repeat(101), '%2e%2e', 5, null]) await hooks.event({ event: asked({ id }) });
    await hooks.event({ event: asked({ sessionID: 'ses_../x' }) });
    await settle(500);
    expect(hits.filter((h) => h.includes('/api/permissions'))).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('o corpo do registro: provider opencode, sessão, permissão, padrões e só os campos de metadata usados', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        if (req.url === '/api/permissions') bodies.push(JSON.parse(raw));
        res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"skip":"no-viewers"}');
      });
    });
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    closers.push(() => new Promise<void>((ok) => (server.closeAllConnections(), server.close(() => ok()))));
    writeConfig({ port: (server.address() as AddressInfo).port, permissionTimeoutS: 40 });
    const hooks = await start(fakeClient().client);
    await hooks.event({ event: asked({ metadata: { command: 'git status', description: 'Ver o estado', segredo: 'NAO-ENVIAR', diff: 'x'.repeat(100_000) } }) });
    await waitFor(() => bodies.length === 1);
    const b = bodies[0] as { tool_input: { metadata: Record<string, string> }; timeout_ms: number };
    expect(b).toMatchObject({ provider: 'opencode', session_id: SES, tool_name: 'bash', cwd: '/p/loja', timeout_ms: 40_000, tool_input: { patterns: ['git status'] } });
    expect(Object.keys(b.tool_input.metadata).sort()).toEqual(['command', 'description', 'diff']);
    expect(JSON.stringify(b)).not.toContain('NAO-ENVIAR');
    expect(b.tool_input.metadata.diff.length).toBeLessThanOrEqual(8_000);
    expect(JSON.stringify(b)).not.toContain('"always"');
  });
});

describe('plugin do OpenCode: vias de resposta', () => {
  it('sem o método v1, responde por POST /permission/{id}/reply do cliente HTTP dele', async () => {
    const s = await serve();
    const posts: Array<{ url: string; path: unknown; body: unknown }> = [];
    const client = { _client: { post: async (o: { url: string; path: unknown; body: unknown }) => (posts.push(o), { data: true }) } };
    const hooks = await start(client);
    await hooks.event({ event: asked() });
    await decide(s, await pendingId(s), { behavior: 'deny', message: 'não' });
    await waitFor(() => posts.length === 1);
    expect(posts[0]).toMatchObject({ url: '/permission/{requestID}/reply', path: { requestID: PER }, body: { reply: 'reject', message: 'Recusado pelo usuário no Habblaud: não' } });
  });

  it('se o v1 devolve erro, tenta o POST /permission/{id}/reply pela URL base do cliente', async () => {
    const s = await serve();
    const seen: Array<{ url?: string; body: unknown }> = [];
    const oc = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        seen.push({ url: req.url, body: JSON.parse(raw) });
        res.writeHead(200, { 'Content-Type': 'application/json' }).end('true');
      });
    });
    await new Promise<void>((ok) => oc.listen(0, '127.0.0.1', ok));
    closers.push(() => new Promise<void>((ok) => (oc.closeAllConnections(), oc.close(() => ok()))));
    const base = `http://127.0.0.1:${(oc.address() as AddressInfo).port}`;
    const { client, calls } = fakeClient({ postSessionIdPermissionsPermissionId: async (a: Call) => (calls.push(a), { error: { name: 'NotFound' } }), _client: { getConfig: () => ({ baseUrl: base }) } });
    const hooks = await start(client);
    await hooks.event({ event: asked() });
    await decide(s, await pendingId(s), { behavior: 'allow' });
    await waitFor(() => seen.length === 1);
    expect(calls).toHaveLength(1);
    expect(seen[0]).toEqual({ url: `/permission/${PER}/reply`, body: { reply: 'once' } });
  });

  it('sem nenhuma via de resposta (cliente vazio): engole e deixa o pedido no OpenCode', async () => {
    const s = await serve();
    const hooks = await start({});
    await hooks.event({ event: asked() });
    await expect(decide(s, await pendingId(s), { behavior: 'allow' })).resolves.toMatchObject({ status: 200 });
    await settle(300);
    const hooks2 = await start(undefined);
    await expect(hooks2.event({ event: asked({ id: 'per_x' }) })).resolves.toBeUndefined();
  });

  it('cliente que lança: engolido', async () => {
    const s = await serve();
    const hooks = await start({
      postSessionIdPermissionsPermissionId: async () => {
        throw new Error('quebrou');
      },
    });
    await hooks.event({ event: asked() });
    await decide(s, await pendingId(s), { behavior: 'allow' });
    await settle(300);
  });
});
