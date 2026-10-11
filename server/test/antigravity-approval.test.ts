// Aprovar pelo escritório no hook do Antigravity (mod/habblaud-antigravity/hook.mjs com `approvals: true`), rodado como
// processo de verdade contra o servidor de teste (rotas de permissões de verdade): aprovar imprime exatamente `{}`,
// recusar imprime o deny com o motivo, e sem resposta, sem página, fora do ar ou fora do `run_command` não imprime nada
// (AG-20..AG-23). HOME temporário; stdin no formato capturado num agy 1.3.3.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setQuiet } from '../log';
import { tempDir } from './fixtures';
import { servePermissions, type PermissionServer } from './permission-server';

setQuiet(true);

const HOOK = resolve(__dirname, '../../mod/habblaud-antigravity/hook.mjs');
interface HookModule {
  readConfig(env: NodeJS.ProcessEnv): { port: number; approvals: boolean; waitMs: number };
  decisionOutput(result: unknown): unknown;
  permissionBody(input: Record<string, unknown>, timeoutMs: number): Record<string, unknown>;
}
const hook = (await import(pathToFileURL(HOOK).href)) as HookModule;

const CONV = '08a163a1-c091-4c62-8146-ac8553c45d55';
const AG_MAIN = `antigravity:${CONV}`;
const COMMON = {
  artifactDirectoryPath: `/home/ana/.gemini/antigravity-cli/brain/${CONV}`,
  conversationId: CONV,
  modelName: 'gemini-3.8-flash-high',
  transcriptPath: `/home/ana/.gemini/antigravity-cli/brain/${CONV}/.system_generated/logs/transcript_full.jsonl`,
  workspacePaths: ['/p/loja'],
};
const preTool = (name = 'run_command', args: Record<string, unknown> = { CommandLine: 'npm test', Cwd: '/p/loja', toolSummary: 'Rodar os testes' }) => ({ ...COMMON, stepIdx: 2, toolCall: { name, args } });

let tmp: ReturnType<typeof tempDir>;
let home: string;
let srv: PermissionServer | undefined;

beforeEach(() => {
  tmp = tempDir('habblaud-agyappr-');
  home = tmp.dir;
});
afterEach(async () => {
  await srv?.close();
  srv = undefined;
  tmp.cleanup();
});

function writeConfig(cfg: Record<string, unknown>): void {
  mkdirSync(join(home, '.habblaud'), { recursive: true });
  writeFileSync(join(home, '.habblaud', 'antigravity-hook.json'), JSON.stringify(cfg));
}

async function serve(opts: { viewers?: number } = {}): Promise<PermissionServer> {
  srv = await servePermissions({ viewers: opts.viewers });
  srv.office.addMain({ id: AG_MAIN, provider: 'antigravity', account: 'antigravity', sessionId: CONV, cwd: '/p/loja', role: 'Agente principal (Antigravity)', startedAt: Date.now(), status: 'working' });
  return srv;
}

function runHook(stdin: unknown, port: number): Promise<{ code: number | null; stdout: string; ms: number }> {
  return new Promise((ok) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, [HOOK, 'PreToolUse'], { env: { ...process.env, HOME: home, HABBLAUD_PORT: String(port) } });
    let stdout = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.on('close', (code) => ok({ code, stdout, ms: Date.now() - t0 }));
    child.stdin.end(JSON.stringify(stdin));
  });
}

async function pendingId(s: PermissionServer): Promise<string> {
  for (let i = 0; i < 200; i++) {
    const id = s.registry!.snapshot().get(AG_MAIN)?.id;
    if (id) return id;
    await new Promise((ok) => setTimeout(ok, 25));
  }
  throw new Error('o hook não registrou o pedido');
}

async function deadPort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((ok) => s.listen(0, '127.0.0.1', ok));
  const port = (s.address() as { port: number }).port;
  await new Promise<void>((ok) => s.close(() => ok()));
  return port;
}

describe('hook do Antigravity com aprovações (processo)', () => {
  it('AG-20/AG-21: aprovado no escritório imprime exatamente {} e sai com 0; o cartão tem o comando completo', async () => {
    const s = await serve();
    writeConfig({ port: s.port, approvals: true, permissionTimeoutS: 30 });
    const run = runHook(preTool(), s.port);
    const id = await pendingId(s);
    const info = s.registry!.detail(id)!;
    expect(info).toMatchObject({ provider: 'antigravity', tool: 'run_command', title: 'Bash(npm test)' });
    expect(info.expiresAt - info.createdAt).toBeGreaterThan(25_000);
    expect(info.expiresAt - info.createdAt).toBeLessThanOrEqual(30_000);
    expect(s.registry!.decide(id, { behavior: 'allow' })).toBe('ok');
    const r = await run;
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('{}');
  });

  it('AG-21: recusado com motivo imprime o deny com o motivo (sem texto de aprovação); sem motivo, o motivo padrão', async () => {
    const s = await serve();
    writeConfig({ port: s.port, approvals: true, permissionTimeoutS: 30 });
    let run = runHook(preTool(), s.port);
    expect(s.registry!.decide(await pendingId(s), { behavior: 'deny', message: 'use pnpm' })).toBe('ok');
    let r = await run;
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ decision: 'deny', reason: 'Recusado pelo usuário no Habblaud: use pnpm' });
    run = runHook(preTool(), s.port);
    expect(s.registry!.decide(await pendingId(s), { behavior: 'deny' })).toBe('ok');
    r = await run;
    expect(JSON.parse(r.stdout)).toEqual({ decision: 'deny', reason: 'Recusado pelo usuário no Habblaud.' });
  });

  it('AG-22: "responder no terminal" não imprime nada (o agy pergunta)', async () => {
    const s = await serve();
    writeConfig({ port: s.port, approvals: true, permissionTimeoutS: 30 });
    const run = runHook(preTool(), s.port);
    s.registry!.decide(await pendingId(s), { behavior: 'terminal' });
    expect(await run).toMatchObject({ code: 0, stdout: '' });
  });

  it('AG-22: sem página aberta o pedido é pulado: nada impresso e sem esperar', async () => {
    const s = await serve({ viewers: 0 });
    writeConfig({ port: s.port, approvals: true, permissionTimeoutS: 30 });
    const r = await runHook(preTool(), s.port);
    expect(r).toMatchObject({ code: 0, stdout: '' });
    expect(r.ms).toBeLessThan(3_000);
    expect(s.registry!.size).toBe(0);
  });

  it('AG-22: Habblaud fora do ar: nada impresso, rápido', async () => {
    writeConfig({ approvals: true, permissionTimeoutS: 30 });
    const r = await runHook(preTool(), await deadPort());
    expect(r).toMatchObject({ code: 0, stdout: '' });
    expect(r.ms).toBeLessThan(3_000);
  });

  it('AG-22: sem resposta até a espera, nada impresso e o pedido deixa de estar pendente', async () => {
    const s = await serve();
    writeConfig({ port: s.port, approvals: true, permissionTimeoutS: 5 });
    const r = await runHook(preTool(), s.port);
    expect(r).toMatchObject({ code: 0, stdout: '' });
    expect(r.ms).toBeGreaterThanOrEqual(4_500);
    expect(r.ms).toBeLessThan(8_000);
  }, 20_000);

  it('AG-23: sem `approvals` na configuração nada é segurado nem registrado (run_command passa direto)', async () => {
    const s = await serve();
    writeConfig({ port: s.port });
    const r = await runHook(preTool(), s.port);
    expect(r).toMatchObject({ code: 0, stdout: '' });
    expect(r.ms).toBeLessThan(3_000);
    expect(s.registry!.size).toBe(0);
  });

  it('AG-23: com aprovações, outras ferramentas passam direto (nada registrado, nada impresso)', async () => {
    const s = await serve();
    writeConfig({ port: s.port, approvals: true, permissionTimeoutS: 30 });
    for (const name of ['view_file', 'write_to_file', 'grep_search', 'call_mcp_tool']) {
      const r = await runHook(preTool(name, { AbsolutePath: '/a/b.ts' }), s.port);
      expect(r, name).toMatchObject({ code: 0, stdout: '' });
      expect(r.ms, name).toBeLessThan(3_000);
    }
    expect(s.registry!.size).toBe(0);
  });

  it('AG-23: com aprovações, os outros eventos nunca seguram o agente', async () => {
    const s = await serve();
    writeConfig({ port: s.port, approvals: true, permissionTimeoutS: 30 });
    for (const event of ['PostToolUse', 'PreInvocation', 'PostInvocation', 'Stop']) {
      const r = await new Promise<{ code: number | null; stdout: string; ms: number }>((ok) => {
        const t0 = Date.now();
        const child = spawn(process.execPath, [HOOK, event], { env: { ...process.env, HOME: home, HABBLAUD_PORT: String(s.port) } });
        let stdout = '';
        child.stdout.on('data', (c) => (stdout += c));
        child.on('close', (code) => ok({ code, stdout, ms: Date.now() - t0 }));
        child.stdin.end(JSON.stringify(preTool()));
      });
      expect(r, event).toMatchObject({ code: 0, stdout: '' });
      expect(r.ms, event).toBeLessThan(3_000);
    }
    expect(s.registry!.size).toBe(0);
  });
});

describe('hook do Antigravity: peças puras das aprovações', () => {
  it('decisionOutput: allow = {}; deny = decision deny + reason; o resto = nada', () => {
    expect(hook.decisionOutput({ status: 'decided', behavior: 'allow', suggestion: 0 })).toEqual({});
    expect(hook.decisionOutput({ status: 'decided', behavior: 'deny', message: '  não  ' })).toEqual({ decision: 'deny', reason: 'Recusado pelo usuário no Habblaud: não' });
    expect(hook.decisionOutput({ status: 'decided', behavior: 'deny', message: 'x'.repeat(5_000) })).toMatchObject({ reason: expect.stringMatching(/^Recusado pelo usuário no Habblaud: x{1000}$/) });
    expect(hook.decisionOutput({ status: 'decided', behavior: 'terminal' })).toBeUndefined();
    expect(hook.decisionOutput({ status: 'decided', behavior: 'answer', answers: [] })).toBeUndefined();
    expect(hook.decisionOutput({ status: 'released', reason: 'expired' })).toBeUndefined();
    expect(hook.decisionOutput({ status: 'pending' })).toBeUndefined();
    expect(hook.decisionOutput(undefined)).toBeUndefined();
  });

  it('permissionBody leva só o comando, a pasta, a conversa e o prazo (nada do transcript, do modelo nem dos outros args)', () => {
    const body = hook.permissionBody({ ...preTool(), prompt: 'segredo' }, 12_000);
    expect(body).toEqual({ provider: 'antigravity', session_id: CONV, tool_name: 'run_command', tool_input: { command: 'npm test' }, timeout_ms: 12_000, cwd: '/p/loja' });
    expect(JSON.stringify(body)).not.toMatch(/transcript|gemini|segredo|toolSummary|Rodar/);
    expect((hook.permissionBody(preTool('run_command', { CommandLine: 'x'.repeat(20_000) }), 1).tool_input as { command: string }).command).toHaveLength(8_000);
  });

  it('readConfig: approvals só com true; a espera fica entre 5 e 120 s', () => {
    mkdirSync(join(home, '.habblaud'), { recursive: true });
    const read = () => hook.readConfig({ HOME: home });
    expect(read()).toMatchObject({ approvals: false, waitMs: 25_000 });
    for (const [cfg, expected] of [
      [{ approvals: true }, { approvals: true, waitMs: 25_000 }],
      [{ approvals: 'sim' }, { approvals: false, waitMs: 25_000 }],
      [{ approvals: true, permissionTimeoutS: 1 }, { approvals: true, waitMs: 5_000 }],
      [{ approvals: true, permissionTimeoutS: 999 }, { approvals: true, waitMs: 120_000 }],
      [{ approvals: true, permissionTimeoutS: 40 }, { approvals: true, waitMs: 40_000 }],
    ] as const) {
      writeConfig(cfg);
      expect(read(), JSON.stringify(cfg)).toMatchObject(expected);
    }
  });
});
