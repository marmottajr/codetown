// Hook do Codex (mod/habblaud-codex/hook.mjs) rodado como processo de verdade contra o servidor de teste (rotas de
// verdade e uma fonte do Codex falsa): eventos de observação (sem saída), a conta pelo CODEX_HOME, pelo
// transcript_path ou ~/.codex, a configuração em ~/.habblaud/codex-hook.json, e o PermissionRequest (aprovar, recusar,
// terminal, tempo esgotado, Habblaud fora do ar). A chave local do hook (~/.habblaud/codex-hook.key, server/codex/key.ts):
// cada chamada leva nonce e prova, e só vale um 201 ou uma decisão com a prova do servidor; servidores falsos ("porta
// ocupada", prova errada) nunca decidem, e sem chave o hook sai sem decidir. Também as rotas de permissão com a guarda
// do hook do Codex (no Docker, de fora do loopback, só com prova). HOME e CODEX_HOME sempre em pastas temporárias;
// stdin e chaves sintéticos.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { createServer, type AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createProofChecker, keyProof, NONCE_HEADER, PROOF_HEADER } from '../codex/key';
import { setQuiet } from '../log';
import { tempDir } from './fixtures';
import { CODEX_MAIN, CODEX_THREAD, hookJson, servePermissions, type PermissionServer } from './permission-server';

setQuiet(true);

const HOOK = resolve(__dirname, '../../mod/habblaud-codex/hook.mjs');
/** Chave local do hook (sintética) e uma outra, de quem não é o Habblaud desta máquina. */
const KEY = Buffer.alloc(32, 7);
const OTHER_KEY = Buffer.alloc(32, 8);
/** Endereço do gateway do Docker: é de onde o hook (no host) chega ao container pela porta publicada. */
const GATEWAY = '172.17.0.1';
/** Cabeçalho do servidor de teste que troca o endereço de quem conecta (server/test/permission-server.ts). */
const REMOTE = 'x-test-remote';
const ALLOW = { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } };

/** Funções exportadas pelo hook (JavaScript puro, sem tipos). */
interface HookModule {
  readConfig(env: NodeJS.ProcessEnv): { port: number; waitMs: number };
  readKey(env: NodeJS.ProcessEnv): Buffer | undefined;
  keyProof(key: Buffer, role: 'hook' | 'server', nonce: string): string;
  provesServer(key: Buffer, nonce: string, header: unknown): boolean;
  codexHomeOf(env: NodeJS.ProcessEnv, input: unknown): string;
  accountOf(codexHome: string): string;
  eventBody(input: Record<string, unknown>, account: string, codexHome: string): Record<string, unknown>;
  permissionBody(input: Record<string, unknown>, account: string, codexHome: string, timeoutMs: number): Record<string, unknown>;
  decisionOutput(result: unknown): unknown;
  run(env: NodeJS.ProcessEnv, stdinText: string): Promise<unknown>;
}
const hook = (await import(pathToFileURL(HOOK).href)) as HookModule;

/** Fonte do Codex falsa: guarda os eventos recebidos. */
class FakeLive {
  calls: Array<{ account: string | undefined; input: Record<string, unknown> }> = [];
  applyHookEvent(account: string | undefined, input: Record<string, unknown>): boolean {
    this.calls.push({ account, input });
    return true;
  }
}

interface HookRun {
  code: number | null;
  stdout: string;
  stderr: string;
  ms: number;
}

let tmp: ReturnType<typeof tempDir>;
let home: string;
let codexHome: string;
let srv: PermissionServer | undefined;
let fake: FakeHabblaud | undefined;
let live: FakeLive;

beforeEach(() => {
  tmp = tempDir();
  home = join(tmp.dir, 'home');
  codexHome = join(home, '.codex-trabalho');
  mkdirSync(codexHome, { recursive: true });
  writeKey(KEY);
  live = new FakeLive();
});
afterEach(async () => {
  await srv?.close();
  srv = undefined;
  await fake?.close();
  fake = undefined;
  tmp.cleanup();
});

/** ~/.habblaud/codex-hook.json no HOME falso. */
function writeConfig(cfg: Record<string, unknown>): void {
  mkdirSync(join(home, '.habblaud'), { recursive: true });
  writeFileSync(join(home, '.habblaud', 'codex-hook.json'), JSON.stringify(cfg));
}

/** ~/.habblaud/codex-hook.key no HOME falso (o servidor de verdade cria; aqui, sintética). */
function writeKey(key: Buffer): void {
  mkdirSync(join(home, '.habblaud'), { recursive: true });
  writeFileSync(join(home, '.habblaud', 'codex-hook.key'), key);
}

/** Servidor de teste com o agente do Codex, a fonte falsa e a mesma chave do HOME falso. */
function serve(opts: Parameters<typeof servePermissions>[0] = {}): Promise<PermissionServer> {
  return servePermissions({ codex: true, codexLive: live, codexHookKey: KEY, ...opts });
}

function runHook(stdin: string, env: NodeJS.ProcessEnv = {}): Promise<HookRun> {
  return new Promise((ok, fail) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, [HOOK], { env: { PATH: process.env.PATH, HOME: home, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (c: string) => (stdout += c));
    child.stderr.setEncoding('utf8').on('data', (c: string) => (stderr += c));
    const kill = setTimeout(() => child.kill('SIGKILL'), 25_000);
    child.on('error', fail);
    child.on('close', (code) => {
      clearTimeout(kill);
      ok({ code, stdout, stderr, ms: Date.now() - t0 });
    });
    child.stdin.end(stdin);
  });
}

/** JSON (sintético) de um evento de hook do Codex. */
function codexEvent(event: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    session_id: CODEX_THREAD,
    turn_id: 'turn-1',
    transcript_path: null,
    cwd: '/p/loja',
    hook_event_name: event,
    model: 'gpt-teste',
    permission_mode: 'default',
    ...over,
  };
}

const permission = (over: Record<string, unknown> = {}) => codexEvent('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'npm test', description: 'Rodar os testes' }, ...over });

async function pendingId(s: PermissionServer): Promise<string> {
  for (let i = 0; i < 200; i++) {
    const id = s.registry!.snapshot().get(CODEX_MAIN)?.id;
    if (id) return id;
    await new Promise((ok) => setTimeout(ok, 25));
  }
  throw new Error('o hook não registrou o pedido');
}

async function deadPort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((ok) => s.listen(0, '127.0.0.1', ok));
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((ok) => s.close(() => ok()));
  return port;
}

const nonceAt = (at = Date.now()) => `${at}.${randomBytes(16).toString('hex')}`;
const signed = (nonce: string, key = KEY, role: 'hook' | 'server' = 'hook') => ({ [NONCE_HEADER]: nonce, [PROOF_HEADER]: keyProof(key, role, nonce) });
const header = (v: string | string[] | undefined) => (typeof v === 'string' ? v : undefined);

/**
 * Como a prova vem na resposta do servidor falso: a certa; nenhuma; a do próprio hook devolvida (papel "hook"); a de
 * outra chave; ou a certa de outro nonce (uma prova capturada antes, repetida).
 */
type ProofMode = 'right' | 'none' | 'echo' | 'other-key' | 'other-nonce';
type FakeRoute = 'event' | 'register' | 'wait';

interface FakeHabblaud {
  port: number;
  /** Chamadas recebidas, na ordem: rota e os cabeçalhos de prova que o hook mandou. */
  hits: Array<{ route: FakeRoute | 'other'; nonce?: string; proof?: string }>;
  close(): Promise<void>;
}

/**
 * Servidor que finge ser o Habblaud na porta do hook: evento 200 {ok}, registro 201 {id} e espera com `waitResult`
 * (padrão: aprovado). `proveOn` = em que respostas vai a prova (padrão: todas), do jeito de `mode`.
 */
async function fakeHabblaud(mode: ProofMode, opts: { proveOn?: FakeRoute[]; waitResult?: unknown } = {}): Promise<FakeHabblaud> {
  const hits: FakeHabblaud['hits'] = [];
  const proveOn = opts.proveOn ?? ['event', 'register', 'wait'];
  const server = http.createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0];
    const route: FakeRoute | 'other' =
      req.method === 'POST' && path === '/api/codex/events' ? 'event' : req.method === 'POST' && path === '/api/permissions' ? 'register' : path.endsWith('/wait') ? 'wait' : 'other';
    const nonce = header(req.headers[NONCE_HEADER]);
    const proof = header(req.headers[PROOF_HEADER]);
    hits.push({ route, nonce, proof });
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (route !== 'other' && proveOn.includes(route) && nonce) {
      const answer =
        mode === 'right'
          ? keyProof(KEY, 'server', nonce)
          : mode === 'echo'
            ? proof
            : mode === 'other-key'
              ? keyProof(OTHER_KEY, 'server', nonce)
              : mode === 'other-nonce'
                ? keyProof(KEY, 'server', nonceAt())
                : undefined;
      if (answer) headers[PROOF_HEADER] = answer;
    }
    const [status, body] =
      route === 'event'
        ? [200, { ok: true }]
        : route === 'register'
          ? [201, { id: 'p-falso', expiresAt: Date.now() + 30_000 }]
          : route === 'wait'
            ? [200, opts.waitResult ?? { status: 'decided', behavior: 'allow' }]
            : [404, { error: 'rota desconhecida' }];
    req.resume();
    req.on('end', () => res.writeHead(status, headers).end(JSON.stringify(body)));
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  return {
    port: (server.address() as AddressInfo).port,
    hits,
    close: () =>
      new Promise((ok) => {
        server.closeAllConnections();
        server.close(() => ok());
      }),
  };
}

/** Requisição crua que devolve também a prova do servidor (x-habblaud-proof) da resposta. */
function hit(
  base: string,
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: unknown,
): Promise<{ status: number; json: unknown; proof?: string }> {
  const u = new URL(base);
  const data = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((ok, fail) => {
    const req = http.request(
      { host: u.hostname, port: u.port, path, method, headers: { ...(data !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers } },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => (text += c));
        res.on('end', () => {
          let json: unknown;
          try {
            json = JSON.parse(text);
          } catch {
            json = undefined;
          }
          ok({ status: res.statusCode ?? 0, json, proof: header(res.headers[PROOF_HEADER]) });
        });
      },
    );
    req.on('error', fail);
    req.end(data);
  });
}

/** Corpo do POST /api/permissions do hook do Codex (como o permissionBody do hook.mjs). */
const codexBody = (over: Record<string, unknown> = {}) => ({
  provider: 'codex',
  account: '.codex',
  codexHome: '/u/.codex',
  session_id: CODEX_THREAD,
  cwd: '/p/loja',
  tool_name: 'Bash',
  tool_input: { command: 'npm test' },
  timeout_ms: 25_000,
  ...over,
});

describe('hook.mjs do Codex (processo)', () => {
  it('evento de observação: vai para /api/codex/events com a conta e o CODEX_HOME; nada no stdout', async () => {
    srv = await serve();
    writeConfig({ port: srv.port });
    const input = codexEvent('PreToolUse', { tool_name: 'Bash', tool_use_id: 'call-1', tool_input: { command: 'ls' } });
    const r = await runHook(JSON.stringify(input), { CODEX_HOME: codexHome });
    expect(r).toMatchObject({ code: 0, stdout: '' });
    expect(r.ms).toBeLessThan(3_000);
    expect(live.calls).toEqual([{ account: '.codex-trabalho', input }]);
    expect(srv.registry!.size).toBe(0);
  });

  it('a conta sai do transcript_path quando o CODEX_HOME não chega (o ambiente do hook é o do daemon); senão ~/.codex', async () => {
    srv = await serve();
    writeConfig({ port: srv.port });
    const transcript = join(codexHome, 'sessions', '2026', '10', '09', `rollout-2026-10-09T09-00-00-${CODEX_THREAD}.jsonl`);
    await runHook(JSON.stringify(codexEvent('Stop', { transcript_path: transcript, last_assistant_message: 'pronto' })));
    await runHook(JSON.stringify(codexEvent('SessionEnd', { reason: 'other' })));
    expect(live.calls.map((c) => c.account)).toEqual(['.codex-trabalho', '.codex']);
  });

  it('textos enormes (saída de comando no PostToolUse) vão cortados, cabendo no limite do servidor', async () => {
    srv = await serve();
    writeConfig({ port: srv.port });
    const big = codexEvent('PostToolUse', { tool_name: 'Bash', tool_use_id: 'c', tool_input: { command: 'cat x' }, tool_response: { output: 'x'.repeat(600_000) } });
    const r = await runHook(JSON.stringify(big), { CODEX_HOME: codexHome });
    expect(r).toMatchObject({ code: 0, stdout: '' });
    expect(live.calls).toHaveLength(1);
    expect((live.calls[0].input.tool_response as { output: string }).output.length).toBe(8_000);
  });

  it('PermissionRequest aprovado no Habblaud: manda o evento, registra e imprime allow (só isso)', async () => {
    srv = await serve();
    writeConfig({ port: srv.port, permissionTimeoutS: 30 });
    const run = runHook(JSON.stringify(permission()), { CODEX_HOME: codexHome });
    const id = await pendingId(srv);
    expect(live.calls.map((c) => c.input.hook_event_name)).toEqual(['PermissionRequest']);
    const info = srv.registry!.detail(id)!;
    expect(info).toMatchObject({ provider: 'codex', tool: 'Bash', title: 'Bash(npm test)' });
    // A espera do arquivo (30 s) vira o prazo do pedido no escritório.
    expect(info.expiresAt - info.createdAt).toBeGreaterThan(25_000);
    expect(info.expiresAt - info.createdAt).toBeLessThanOrEqual(30_000);
    expect(srv.registry!.decide(id, { behavior: 'allow' })).toBe('ok');
    const r = await run;
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}\n');
  });

  it('recusado com motivo: deny com a mensagem (sem interrupt); "responder no terminal": nada no stdout', async () => {
    srv = await serve();
    writeConfig({ port: srv.port });
    let run = runHook(JSON.stringify(permission()), { CODEX_HOME: codexHome });
    expect(srv.registry!.decide(await pendingId(srv), { behavior: 'deny', message: 'use pnpm' })).toBe('ok');
    let r = await run;
    expect(JSON.parse(r.stdout)).toEqual({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'Recusado pelo usuário no Habblaud: use pnpm' } } });
    run = runHook(JSON.stringify(permission()), { CODEX_HOME: codexHome });
    srv.registry!.decide(await pendingId(srv), { behavior: 'terminal' });
    r = await run;
    expect(r).toMatchObject({ code: 0, stdout: '' });
  });

  it('HABBLAUD_PORT vale como reserva quando o arquivo não tem a porta', async () => {
    srv = await serve();
    const run = runHook(JSON.stringify(permission()), { CODEX_HOME: codexHome, HABBLAUD_PORT: String(srv.port) });
    srv.registry!.decide(await pendingId(srv), { behavior: 'allow' });
    expect(JSON.parse((await run).stdout).hookSpecificOutput.decision).toEqual({ behavior: 'allow' });
  });

  it('Habblaud fora do ar, sem página aberta ou sessão desconhecida: sai rápido, sem decisão', async () => {
    writeConfig({ port: await deadPort() });
    let r = await runHook(JSON.stringify(permission()), { CODEX_HOME: codexHome });
    expect(r).toMatchObject({ code: 0, stdout: '' });
    expect(r.ms).toBeLessThan(3_000);
    srv = await serve({ viewers: 0 });
    writeConfig({ port: srv.port });
    r = await runHook(JSON.stringify(permission()), { CODEX_HOME: codexHome });
    expect(r).toMatchObject({ code: 0, stdout: '' });
    r = await runHook(JSON.stringify(permission({ session_id: '0199ffff-0000-7000-8000-000000000000' })), { CODEX_HOME: codexHome });
    expect(r).toMatchObject({ code: 0, stdout: '' });
    expect(r.ms).toBeLessThan(3_000);
    expect(srv.registry!.size).toBe(0);
  });

  it('espera esgotada (permissionTimeoutS: 5): desiste e sai sem decisão (o Codex segue a aprovação normal)', async () => {
    srv = await serve({ registry: { orphanMs: 300 } });
    writeConfig({ port: srv.port, permissionTimeoutS: 5 });
    const r = await runHook(JSON.stringify(permission()), { CODEX_HOME: codexHome });
    expect(r).toMatchObject({ code: 0, stdout: '' });
    expect(r.ms).toBeGreaterThanOrEqual(4_500);
    expect(r.ms).toBeLessThan(10_000);
  }, 20_000);

  it('stdin inválido ou evento que o Habblaud não usa: nada é mandado', async () => {
    srv = await serve();
    writeConfig({ port: srv.port });
    for (const stdin of ['', 'não é json', '[]', JSON.stringify({ hook_event_name: 'Stop' }), JSON.stringify(codexEvent('PreCompact', { trigger: 'auto' }))]) {
      const r = await runHook(stdin, { CODEX_HOME: codexHome });
      expect(r, stdin).toMatchObject({ code: 0, stdout: '' });
    }
    expect(live.calls).toHaveLength(0);
  });
});

describe('hook.mjs do Codex: a prova do servidor (chave local do hook)', () => {
  const env = (port: number): NodeJS.ProcessEnv => ({ HOME: home, CODEX_HOME: codexHome, HABBLAUD_PORT: String(port) });

  it('cada chamada leva um nonce novo e a prova do hook, que o conferente do servidor aceita; com a prova do servidor em tudo, a decisão vale', async () => {
    fake = await fakeHabblaud('right');
    expect(await hook.run(env(fake.port), JSON.stringify(codexEvent('UserPromptSubmit', { prompt: 'oi' })))).toBeUndefined();
    expect(await hook.run(env(fake.port), JSON.stringify(permission()))).toEqual(ALLOW);
    expect(fake.hits.map((h) => h.route)).toEqual(['event', 'event', 'register', 'wait']);
    // Um conferente só, como o do servidor: todas valem, e nenhum nonce se repete.
    const check = createProofChecker(KEY);
    for (const h of fake.hits) {
      expect(h.nonce).toMatch(/^\d+\.[0-9a-f]{32}$/);
      expect(h.proof).toBe(keyProof(KEY, 'hook', h.nonce!));
      expect(check(h.nonce, h.proof), h.route).toBe(true);
    }
  });

  it('"porta ocupada" (responde evento, 201 e allow sem prova): nenhuma decisão, sem nem registrar, em menos de 1 s', async () => {
    fake = await fakeHabblaud('none');
    const t0 = Date.now();
    expect(await hook.run(env(fake.port), JSON.stringify(permission()))).toBeUndefined();
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(fake.hits.map((h) => h.route)).toEqual(['event']);
  });

  it.each<ProofMode>(['echo', 'other-key', 'other-nonce'])('prova errada (%s): nenhuma decisão', async (mode) => {
    fake = await fakeHabblaud(mode);
    expect(await hook.run(env(fake.port), JSON.stringify(permission()))).toBeUndefined();
    expect(fake.hits.map((h) => h.route)).toEqual(['event']);
  });

  it('cada resposta precisa da prova: 201 sem prova (evento provado) e decisão ou "pending" sem prova (201 provado) → nenhuma decisão', async () => {
    fake = await fakeHabblaud('right', { proveOn: ['event'] });
    expect(await hook.run(env(fake.port), JSON.stringify(permission()))).toBeUndefined();
    expect(fake.hits.map((h) => h.route)).toEqual(['event', 'register']);
    await fake.close();
    fake = await fakeHabblaud('right', { proveOn: ['event', 'register'] });
    expect(await hook.run(env(fake.port), JSON.stringify(permission()))).toBeUndefined();
    expect(fake.hits.map((h) => h.route)).toEqual(['event', 'register', 'wait']);
    await fake.close();
    // "pending" sem prova: não pergunta de novo.
    fake = await fakeHabblaud('right', { proveOn: ['event', 'register'], waitResult: { status: 'pending' } });
    expect(await hook.run(env(fake.port), JSON.stringify(permission()))).toBeUndefined();
    expect(fake.hits.map((h) => h.route)).toEqual(['event', 'register', 'wait']);
  });

  it('sem a chave, com chave de tamanho errado ou ilegível: o evento vai sem nonce nem prova, e o hook sai sem decidir em menos de 1 s', async () => {
    fake = await fakeHabblaud('right');
    const keyFile = join(home, '.habblaud', 'codex-hook.key');
    const cases: Array<[string, () => void]> = [
      ['ausente', () => rmSync(keyFile)],
      ['16 bytes', () => writeFileSync(keyFile, randomBytes(16))],
      ['pasta no lugar do arquivo', () => (rmSync(keyFile), mkdirSync(keyFile))],
    ];
    for (const [name, setup] of cases) {
      setup();
      const t0 = Date.now();
      expect(await hook.run(env(fake.port), JSON.stringify(permission())), name).toBeUndefined();
      expect(Date.now() - t0, name).toBeLessThan(1_000);
    }
    expect(fake.hits).toEqual([
      { route: 'event', nonce: undefined, proof: undefined },
      { route: 'event', nonce: undefined, proof: undefined },
      { route: 'event', nonce: undefined, proof: undefined },
    ]);
  });

  it('servidor de verdade sem a chave do hook (chave trocada ou ilegível lá): o 201 vem sem prova e nada é decidido', async () => {
    srv = await servePermissions({ codex: true, codexLive: live });
    expect(await hook.run(env(srv.port), JSON.stringify(permission()))).toBeUndefined();
    expect(live.calls).toHaveLength(1);
    expect(srv.registry!.size).toBe(0);
  });

  it('{skip: "parallel"} (thread do canal do app-server): sai na hora sem decidir, depois de registrar com prova; fora do canal, registra e decide', async () => {
    srv = await serve();
    let parallel = true;
    const asked: string[] = [];
    srv.registry!.setParallelSink({
      decide: () => Promise.resolve('ok'),
      owns: (account, threadId) => (asked.push(`${account}|${threadId}`), parallel && threadId === CODEX_THREAD),
    });
    const t0 = Date.now();
    expect(await hook.run(env(srv.port), JSON.stringify(permission()))).toBeUndefined();
    expect(Date.now() - t0).toBeLessThan(1_000);
    // O hook passou pela chave e pela prova do evento e chegou ao registro, que respondeu {skip: "parallel"}.
    expect(asked).toEqual([`.codex-trabalho|${CODEX_THREAD}`]);
    expect(srv.registry!.size).toBe(0);
    // Controle: a thread deixa de ser do canal; o mesmo pedido registra e a decisão do escritório vale.
    parallel = false;
    const run = hook.run(env(srv.port), JSON.stringify(permission()));
    expect(srv.registry!.decide(await pendingId(srv), { behavior: 'allow' })).toBe('ok');
    expect(await run).toEqual(ALLOW);
  });
});

describe('rotas de permissão: guarda do hook do Codex', () => {
  it('Docker, de fora do loopback: registro do Codex sem prova, com prova de outra chave, de papel "server" ou só o nonce → 403 sem cartão; com a prova → 201 com a do servidor', async () => {
    srv = await serve({ inDocker: true });
    const n = nonceAt();
    const wrong: Array<Record<string, string>> = [{}, signed(n, OTHER_KEY), signed(n, KEY, 'server'), { [NONCE_HEADER]: n }];
    for (const headers of wrong) {
      expect((await hit(srv.base, 'POST', '/api/permissions', { [REMOTE]: GATEWAY, ...headers }, codexBody())).status, JSON.stringify(headers)).toBe(403);
    }
    expect(srv.registry!.size).toBe(0);
    expect(srv.registry!.snapshot().get(CODEX_MAIN)).toBeUndefined();
    const ok = await hit(srv.base, 'POST', '/api/permissions', { [REMOTE]: GATEWAY, ...signed(n) }, codexBody());
    expect(ok).toMatchObject({ status: 201, proof: keyProof(KEY, 'server', n) });
    expect(srv.registry!.size).toBe(1);
  });

  it('Docker: a espera de um pedido do Codex, mesmo já decidido, só com prova (e a decisão volta com a do servidor); o hook do Claude segue sem prova', async () => {
    srv = await serve({ inDocker: true });
    const reg = await hit(srv.base, 'POST', '/api/permissions', { [REMOTE]: GATEWAY, ...signed(nonceAt()) }, codexBody());
    const id = encodeURIComponent((reg.json as { id: string }).id);
    expect(srv.registry!.decide((reg.json as { id: string }).id, { behavior: 'allow' })).toBe('ok');
    expect((await hit(srv.base, 'GET', `/api/permissions/${id}/wait?timeout=0.1`, { [REMOTE]: GATEWAY })).status).toBe(403);
    const n = nonceAt();
    expect(await hit(srv.base, 'GET', `/api/permissions/${id}/wait?timeout=0.1`, { [REMOTE]: GATEWAY, ...signed(n) })).toMatchObject({
      status: 200,
      json: { status: 'decided', behavior: 'allow' },
      proof: keyProof(KEY, 'server', n),
    });
    // Hook do Claude: no Docker também chega pelo gateway e nunca manda prova; segue a trava de sempre.
    const claude = await hit(srv.base, 'POST', '/api/permissions', { [REMOTE]: GATEWAY }, hookJson());
    expect(claude).toMatchObject({ status: 201, proof: undefined });
    const claudeId = encodeURIComponent((claude.json as { id: string }).id);
    expect(await hit(srv.base, 'GET', `/api/permissions/${claudeId}/wait?timeout=0.1`, { [REMOTE]: GATEWAY })).toMatchObject({ status: 200, json: { status: 'pending' }, proof: undefined });
  });

  it('fora do Docker: de fora do loopback é 403 mesmo com prova; pelo loopback sem prova (hook antigo) vale, sem a prova do servidor', async () => {
    srv = await serve();
    expect((await hit(srv.base, 'POST', '/api/permissions', { [REMOTE]: '192.168.0.20', ...signed(nonceAt()) }, codexBody())).status).toBe(403);
    expect(srv.registry!.size).toBe(0);
    expect(await hit(srv.base, 'POST', '/api/permissions', {}, codexBody())).toMatchObject({ status: 201, proof: undefined });
  });
});

describe('hook.mjs do Codex (funções)', () => {
  it('readConfig: arquivo, reserva HABBLAUD_PORT, padrões e limites da espera', () => {
    expect(hook.readConfig({ HOME: home })).toEqual({ port: 4747, waitMs: 25_000 });
    expect(hook.readConfig({ HOME: home, HABBLAUD_PORT: '4851' })).toEqual({ port: 4851, waitMs: 25_000 });
    writeConfig({ port: 4900, permissionTimeoutS: 60 });
    expect(hook.readConfig({ HOME: home, HABBLAUD_PORT: '4851' })).toEqual({ port: 4900, waitMs: 60_000 });
    writeConfig({ port: 'x', permissionTimeoutS: 1 });
    expect(hook.readConfig({ HOME: home })).toEqual({ port: 4747, waitMs: 5_000 });
    writeConfig({ permissionTimeoutS: 999 });
    expect(hook.readConfig({ HOME: home })).toEqual({ port: 4747, waitMs: 120_000 });
    writeFileSync(join(home, '.habblaud', 'codex-hook.json'), '{ quebrado');
    expect(hook.readConfig({ HOME: home })).toEqual({ port: 4747, waitMs: 25_000 });
  });

  it('readKey/keyProof/provesServer: só a chave de 32 bytes; a mesma prova do servidor; só a prova do servidor para este nonce', () => {
    expect(hook.readKey({ HOME: home })).toEqual(KEY);
    writeKey(randomBytes(31));
    expect(hook.readKey({ HOME: home })).toBeUndefined();
    expect(hook.readKey({ HOME: join(tmp.dir, 'sem-habblaud') })).toBeUndefined();
    const n = nonceAt();
    expect(hook.keyProof(KEY, 'hook', n)).toBe(keyProof(KEY, 'hook', n));
    expect(hook.keyProof(KEY, 'server', n)).toBe(keyProof(KEY, 'server', n));
    expect(hook.provesServer(KEY, n, keyProof(KEY, 'server', n))).toBe(true);
    for (const bad of [undefined, '', 'zz', keyProof(KEY, 'hook', n), keyProof(OTHER_KEY, 'server', n), keyProof(KEY, 'server', nonceAt()), keyProof(KEY, 'server', n).toUpperCase(), ['a']]) {
      expect(hook.provesServer(KEY, n, bad), String(bad)).toBe(false);
    }
  });

  it('codexHomeOf/accountOf: CODEX_HOME (com ~), transcript_path (sessions/ ou archived_sessions/) e ~/.codex', () => {
    // resolve/join como o hook: no Windows, com a letra do drive e `\`.
    expect(hook.codexHomeOf({ HOME: '/u', CODEX_HOME: '~/.codex-b/' }, {})).toBe(resolve('/u/.codex-b'));
    expect(hook.codexHomeOf({ HOME: '/u' }, { transcript_path: `/x/.codex-c/sessions/2026/10/09/rollout-a-${CODEX_THREAD}.jsonl` })).toBe(resolve('/x/.codex-c'));
    expect(hook.codexHomeOf({ HOME: '/u' }, { transcript_path: `/x/.codex-d/archived_sessions/rollout-a.jsonl` })).toBe(resolve('/x/.codex-d'));
    expect(hook.codexHomeOf({ HOME: '/u' }, { transcript_path: 'relativo/sessions/2026/10/09/r.jsonl' })).toBe(join('/u', '.codex'));
    expect(hook.codexHomeOf({ HOME: '/u' }, { transcript_path: null })).toBe(join('/u', '.codex'));
    expect(hook.accountOf('/u/.codex')).toBe('.codex');
  });

  it('permissionBody: provider codex, conta e só o que o Habblaud usa', () => {
    const body = hook.permissionBody(permission({ agent_id: 'filho', agent_type: 'worker', tool_input: { command: 'y'.repeat(20_000) } }), '.codex', '/u/.codex', 25_000);
    expect(Object.keys(body).sort()).toEqual(['account', 'agent_id', 'agent_type', 'codexHome', 'cwd', 'provider', 'session_id', 'timeout_ms', 'tool_input', 'tool_name', 'turn_id']);
    expect(body).toMatchObject({ provider: 'codex', account: '.codex', codexHome: '/u/.codex', session_id: CODEX_THREAD, tool_name: 'Bash', timeout_ms: 25_000 });
    expect((body.tool_input as { command: string }).command.length).toBe(8_000);
    expect(JSON.stringify(hook.eventBody(codexEvent('Stop'), '.codex', '/u/.codex'))).toContain('"hook_event_name":"Stop"');
  });

  it('decisionOutput: só allow e deny (+message); nunca updatedInput, updatedPermissions nem interrupt', () => {
    const allow = hook.decisionOutput({ status: 'decided', behavior: 'allow', suggestion: 0 });
    expect(allow).toEqual({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } });
    expect(hook.decisionOutput({ status: 'decided', behavior: 'deny', interrupt: true })).toEqual({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: 'Recusado pelo usuário no Habblaud.' } },
    });
    expect(hook.decisionOutput({ status: 'decided', behavior: 'answer', answers: [] })).toBeUndefined();
    expect(hook.decisionOutput({ status: 'released', reason: 'terminal' })).toBeUndefined();
    expect(hook.decisionOutput({ status: 'pending' })).toBeUndefined();
    expect(hook.decisionOutput(undefined)).toBeUndefined();
  });
});
