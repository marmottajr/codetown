// Plugin do OpenCode (mod/habblaud-opencode/plugin.js) importado sob o Node, com um cliente falso e servidores locais
// em 127.0.0.1 (nunca o OpenCode de verdade): só os 5 tipos de evento e as ferramentas são mandados (OC-15), na ordem,
// com a porta do ~/.habblaud/opencode-hook.json (HOME temporário); servidor fora do ar, lento ou com erro nunca faz o
// plugin lançar nem atrasar o OpenCode (OC-16); o arquivo só importa `node:*` e só exporta o plugin. Dados sintéticos.
import http from 'node:http';
import { createServer, type AddressInfo } from 'node:net';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AccountsService } from '../accounts/service';
import { createApiHandler } from '../http/app';
import { createRequestGuard } from '../http/guard';
import { Hub } from '../http/sse';
import { setQuiet } from '../log';
import { NameStore } from '../model/names';
import { Office } from '../model/office';
import type { OpencodeEvent } from '../sources/opencode/live';
import { tempDir } from './fixtures';

setQuiet(true);

const PLUGIN = resolve(__dirname, '../../mod/habblaud-opencode/plugin.js');
type Hooks = Record<string, (input: unknown, output?: unknown) => Promise<void>>;
const mod = (await import(pathToFileURL(PLUGIN).href)) as Record<string, (ctx: unknown) => Promise<Hooks>>;

const SES = 'ses_' + 'c'.repeat(26);
const fakeClient = {};
const start = () => mod.HabblaudPlugin({ client: fakeClient, project: {}, directory: '/p/loja', worktree: '/p/loja', $: undefined });

interface Recorder {
  port: number;
  bodies: Array<{ method?: string; url?: string; body: { event: OpencodeEvent } }>;
  close(): Promise<void>;
}

async function record(handler?: (res: http.ServerResponse) => void): Promise<Recorder> {
  const bodies: Recorder['bodies'] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      if (req.url === '/api/opencode/events') bodies.push({ method: req.method, url: req.url, body: JSON.parse(raw) }); // o registro do pedido de permissão (T16) é testado em opencode-plugin-approval.test.ts
      if (handler) return handler(res);
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}');
    });
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  return {
    port: (server.address() as AddressInfo).port,
    bodies,
    close: () =>
      new Promise((ok) => {
        server.closeAllConnections();
        server.close(() => ok());
      }),
  };
}

async function waitFor(cond: () => boolean, ms = 3_000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('tempo esgotado esperando a condição');
    await new Promise((ok) => setTimeout(ok, 15));
  }
}

async function deadPort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((ok) => s.listen(0, '127.0.0.1', ok));
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((ok) => s.close(() => ok()));
  return port;
}

let tmp: ReturnType<typeof tempDir>;
let home: string;
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
  for (const c of closers.splice(0)) await c();
  tmp.cleanup();
});

async function recorder(handler?: (res: http.ServerResponse) => void): Promise<Recorder> {
  const r = await record(handler);
  closers.push(r.close);
  writeConfig({ port: r.port });
  return r;
}

describe('plugin do OpenCode: forma do arquivo', () => {
  it('só exporta o plugin (o OpenCode chama todo export de função) e devolve os ganchos event e tool.execute.*', async () => {
    expect(Object.keys(mod)).toEqual(['HabblaudPlugin']);
    const hooks = await start();
    expect(Object.keys(hooks).sort()).toEqual(['event', 'tool.execute.after', 'tool.execute.before']);
  });

  it('só importa módulos node:* (para o arquivo copiado funcionar em qualquer lugar)', () => {
    const src = readFileSync(PLUGIN, 'utf8');
    const specs = [...src.matchAll(/^\s*import\s[^'"]*['"]([^'"]+)['"]/gm), ...src.matchAll(/import\(\s*['"]([^'"]+)['"]/g), ...src.matchAll(/require\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
    expect(specs.length).toBeGreaterThan(0);
    for (const s of specs) expect(s.startsWith('node:'), s).toBe(true);
    expect(src).not.toMatch(/\b(?:Bun|process\.binding)\b/);
  });
});

describe('plugin do OpenCode: eventos (OC-15)', () => {
  it('manda os 5 tipos permitidos para POST /api/opencode/events como {event}, na ordem', async () => {
    const r = await recorder();
    const hooks = await start();
    const events = [
      { type: 'session.status', properties: { sessionID: SES, status: { type: 'busy' } } },
      { type: 'todo.updated', properties: { sessionID: SES, todos: [{ id: '1', content: 'a', status: 'pending', priority: 'low' }] } },
      { type: 'permission.asked', properties: { id: 'per_1', sessionID: SES, permission: 'bash', patterns: ['ls'], metadata: {}, always: [] } },
      { type: 'permission.updated', properties: { id: 'per_1', sessionID: SES, type: 'bash', pattern: 'ls' } },
      { type: 'session.idle', properties: { sessionID: SES } },
    ];
    for (const event of events) await hooks.event({ event });
    await waitFor(() => r.bodies.length === events.length);
    expect(r.bodies.map((b) => [b.method, b.url])).toEqual(events.map(() => ['POST', '/api/opencode/events']));
    expect(r.bodies.map((b) => b.body)).toEqual(events.map((event) => ({ event })));
  });

  it('não manda o que não interessa: outros tipos, sem sessionID, lixo', async () => {
    const r = await recorder();
    const hooks = await start();
    for (const event of [
      { type: 'session.created', properties: { sessionID: SES } },
      { type: 'message.part.updated', properties: { sessionID: SES } },
      { type: 'file.edited', properties: { file: 'x' } },
      { type: 'session.idle', properties: {} },
      { type: 'session.idle' },
      { type: 7 },
      null,
      undefined,
      'texto',
    ]) {
      await expect(hooks.event({ event })).resolves.toBeUndefined();
    }
    await expect(hooks.event(undefined)).resolves.toBeUndefined();
    await hooks.event({ event: { type: 'session.idle', properties: { sessionID: SES } } }); // sentinela
    await waitFor(() => r.bodies.length >= 1);
    expect(r.bodies).toHaveLength(1);
    expect(r.bodies[0].body.event.type).toBe('session.idle');
  });

  it('ferramentas: o nome e um título curto dos argumentos (nunca o resultado); a ordem é mantida', async () => {
    const r = await recorder();
    const hooks = await start();
    await hooks['tool.execute.before']({ tool: 'read', sessionID: SES, callID: 'call_1' }, { args: { filePath: 'src/app.ts', offset: 3 } });
    await hooks['tool.execute.after']({ tool: 'read', sessionID: SES, callID: 'call_1', args: { filePath: 'src/app.ts' } }, { title: 'src/app.ts', output: 'SEGREDO do arquivo', metadata: {} });
    await hooks['tool.execute.before']({ tool: 'bash', sessionID: SES, callID: 'call_2' }, { args: { command: 'npm test', timeout: 5 } });
    await waitFor(() => r.bodies.length === 3);
    expect(r.bodies.map((b) => b.body.event)).toEqual([
      { type: 'tool.execute.before', properties: { sessionID: SES, tool: 'read', callID: 'call_1', title: 'src/app.ts' } },
      { type: 'tool.execute.after', properties: { sessionID: SES, tool: 'read', callID: 'call_1' } },
      { type: 'tool.execute.before', properties: { sessionID: SES, tool: 'bash', callID: 'call_2', title: 'npm test' } },
    ]);
    expect(JSON.stringify(r.bodies)).not.toContain('SEGREDO');
  });

  it('textos enormes são cortados antes de sair', async () => {
    const r = await recorder();
    const hooks = await start();
    await hooks.event({ event: { type: 'permission.asked', properties: { sessionID: SES, id: 'per_1', metadata: { diff: 'x'.repeat(50_000) } } } });
    await waitFor(() => r.bodies.length === 1);
    expect(JSON.stringify(r.bodies[0].body).length).toBeLessThan(5_000);
  });

  it('a porta vem do ~/.habblaud/opencode-hook.json; sem arquivo, de HABBLAUD_PORT', async () => {
    const r = await record();
    closers.push(r.close);
    process.env.HABBLAUD_PORT = String(r.port);
    const hooks = await start(); // sem arquivo de configuração
    await hooks.event({ event: { type: 'session.idle', properties: { sessionID: SES } } });
    await waitFor(() => r.bodies.length === 1);
    const other = await record();
    closers.push(other.close);
    writeConfig({ port: other.port }); // o arquivo vale mais que a variável
    await hooks.event({ event: { type: 'session.idle', properties: { sessionID: SES } } });
    await waitFor(() => other.bodies.length === 1);
    expect(r.bodies).toHaveLength(1);
  });
});

describe('plugin do OpenCode: nunca lança nem atrasa o OpenCode (OC-16)', () => {
  it('servidor fora do ar (porta fechada): os ganchos voltam normalmente e depressa', async () => {
    writeConfig({ port: await deadPort() });
    const hooks = await start();
    const t0 = Date.now();
    await expect(hooks.event({ event: { type: 'session.idle', properties: { sessionID: SES } } })).resolves.toBeUndefined();
    await expect(hooks['tool.execute.before']({ tool: 'bash', sessionID: SES, callID: 'c' }, { args: { command: 'ls' } })).resolves.toBeUndefined();
    await expect(hooks['tool.execute.after']({ tool: 'bash', sessionID: SES, callID: 'c' }, {})).resolves.toBeUndefined();
    expect(Date.now() - t0).toBeLessThan(500);
    await new Promise((ok) => setTimeout(ok, 600)); // deixa o envio falhar: sem rejeição solta (o vitest falharia o arquivo)
  });

  it('servidor que responde erro 500 ou lixo: engolido', async () => {
    const r = await recorder((res) => void res.writeHead(500).end('<html>quebrou</html>'));
    const hooks = await start();
    await hooks.event({ event: { type: 'session.idle', properties: { sessionID: SES } } });
    await waitFor(() => r.bodies.length === 1);
    await new Promise((ok) => setTimeout(ok, 100));
  });

  it('servidor que não responde: o gancho volta na hora (o envio não é esperado)', async () => {
    const r = await recorder(() => {}); // nunca responde
    const hooks = await start();
    const t0 = Date.now();
    await hooks.event({ event: { type: 'session.idle', properties: { sessionID: SES } } });
    expect(Date.now() - t0).toBeLessThan(300);
    await waitFor(() => r.bodies.length === 1);
  });

  it('arquivo de configuração ilegível ou porta absurda: usa o padrão, sem lançar', async () => {
    mkdirSync(join(home, '.habblaud'), { recursive: true });
    writeFileSync(join(home, '.habblaud', 'opencode-hook.json'), '{não é json');
    process.env.HABBLAUD_PORT = String(await deadPort()); // o padrão (4747) pode ter um Habblaud de verdade ouvindo
    const hooks = await start();
    await expect(hooks.event({ event: { type: 'session.idle', properties: { sessionID: SES } } })).resolves.toBeUndefined();
    writeConfig({ port: 99_999 }); // inválida: cai na variável
    await expect(hooks.event({ event: { type: 'session.idle', properties: { sessionID: SES } } })).resolves.toBeUndefined();
  });

  it('ganchos com entradas malformadas não lançam', async () => {
    const hooks = await start();
    for (const [i, o] of [[undefined, undefined], [null, null], [{}, {}], [{ tool: 1 }, { args: 3 }], ['x', 'y']] as const) {
      await expect(hooks['tool.execute.before'](i, o)).resolves.toBeUndefined();
      await expect(hooks['tool.execute.after'](i, o)).resolves.toBeUndefined();
    }
  });
});

describe('plugin do OpenCode: de ponta a ponta com a rota de verdade', () => {
  it('o evento chega à fonte ao vivo pela rota /api/opencode/events', async () => {
    const calls: OpencodeEvent[] = [];
    const office = new Office({ names: new NameStore(null), version: 't', startedAt: 0, accounts: () => [], sources: () => [], accountName: () => undefined });
    const hub = new Hub(office, { throttleMs: 10 });
    const accounts = new AccountsService({ dirs: [], home: tmp.dir, env: {}, onChange: () => {} });
    const api = createApiHandler({ office, hub, accounts, sources: () => [], version: 't', inDocker: false, opencodeEvents: true, opencodeLive: { applyHookEvent: (e) => (calls.push(e), true) } });
    const guard = createRequestGuard({ allowedHosts: new Set() });
    const server = http.createServer((req, res) => {
      if (guard(req, res)) return;
      if (!api(req, res, new URL(req.url ?? '/', 'http://x'))) res.writeHead(404).end();
    });
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    closers.push(
      () =>
        new Promise<void>((ok) => {
          hub.stop();
          server.closeAllConnections();
          server.close(() => ok());
        }),
    );
    writeConfig({ port: (server.address() as AddressInfo).port });
    const hooks = await start();
    await hooks.event({ event: { type: 'session.status', properties: { sessionID: SES, status: { type: 'busy' } } } });
    await hooks['tool.execute.before']({ tool: 'grep', sessionID: SES, callID: 'c1' }, { args: { pattern: 'TODO' } });
    await waitFor(() => calls.length === 2);
    expect(calls[0]).toEqual({ type: 'session.status', properties: { sessionID: SES, status: { type: 'busy' } } });
    expect(calls[1]).toMatchObject({ type: 'tool.execute.before', properties: { tool: 'grep', title: 'TODO' } });
  });
});
