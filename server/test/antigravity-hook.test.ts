// Hook do Antigravity (mod/habblaud-antigravity/hook.mjs) rodado como processo de verdade contra um servidor HTTP de
// teste: manda os cinco eventos no formato capturado num agy 1.3.3 real, nunca o texto do pedido nem a saída (AG-05) e
// SEMPRE sai com 0 sem imprimir nada, com o Habblaud fora do ar, travado ou o stdin ruim (AG-16). HOME temporário.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tempDir } from './fixtures';

const HOOK = resolve(__dirname, '../../mod/habblaud-antigravity/hook.mjs');
interface HookModule {
  readPort(env: NodeJS.ProcessEnv): number;
  headOf(args: unknown): string | undefined;
  eventBody(event: string, input: unknown): Record<string, unknown> | undefined;
}
const hook = (await import(pathToFileURL(HOOK).href)) as HookModule;

const CONV = '08a163a1-c091-4c62-8146-ac8553c45d55';
// Campos reais do stdin de um agy 1.3.3 (spike S0), mais campos que o hook não pode repassar.
const COMMON = {
  artifactDirectoryPath: `/home/ana/.gemini/antigravity-cli/brain/${CONV}`,
  conversationId: CONV,
  modelName: 'gemini-3.8-flash-high',
  transcriptPath: `/home/ana/.gemini/antigravity-cli/brain/${CONV}/.system_generated/logs/transcript_full.jsonl`,
  workspacePaths: ['/home/ana/loja'],
};
const PRE_TOOL = { ...COMMON, stepIdx: 2, toolCall: { name: 'run_command', args: { CommandLine: 'npm test', Cwd: '/home/ana/loja', WaitMsBeforeAsync: 5000, toolAction: 'Rodando', toolSummary: 'Rodar os testes' } } };

let tmp: ReturnType<typeof tempDir>;
let home: string;
let server: http.Server | undefined;
let requests: Array<{ url?: string; method?: string; body: unknown }>;
let mode: 'ok' | 'hang' = 'ok';

beforeEach(() => {
  tmp = tempDir('habblaud-agyhook-');
  home = tmp.dir;
  requests = [];
  mode = 'ok';
});
afterEach(async () => {
  tmp.cleanup();
  if (server) await new Promise<void>((ok) => (server!.closeAllConnections(), server!.close(() => ok())));
  server = undefined;
});

async function serve(): Promise<number> {
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      requests.push({ url: req.url, method: req.method, body: JSON.parse(raw || 'null') });
      if (mode === 'ok') res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}');
    });
  });
  await new Promise<void>((ok) => server!.listen(0, '127.0.0.1', ok));
  return (server.address() as AddressInfo).port;
}

function runHook(args: string[], stdin: string, port: number | undefined): Promise<{ code: number | null; stdout: string; ms: number }> {
  return new Promise((ok) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, [HOOK, ...args], { env: { ...process.env, HOME: home, ...(port ? { HABBLAUD_PORT: String(port) } : {}) } });
    let stdout = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.on('close', (code) => ok({ code, stdout, ms: Date.now() - t0 }));
    child.stdin.end(stdin);
  });
}

describe('hook do Antigravity: o que manda', () => {
  it('cada um dos cinco eventos chega à rota com o corpo mínimo, e a saída é vazia com código 0', async () => {
    const port = await serve();
    const stdins: Array<[string, object]> = [
      ['PreInvocation', { ...COMMON, invocationNum: 0, initialNumSteps: 1 }],
      ['PreToolUse', PRE_TOOL],
      ['PostToolUse', { ...PRE_TOOL, error: '' }],
      ['PostInvocation', { ...COMMON, invocationNum: 0, initialNumSteps: 1 }],
      ['Stop', { ...COMMON, executionNum: 0, fullyIdle: true, terminationReason: 'NO_TOOL_CALL', error: '' }],
    ];
    for (const [event, input] of stdins) {
      const r = await runHook([event], JSON.stringify(input), port);
      expect(r, event).toMatchObject({ code: 0, stdout: '' });
    }
    expect(requests.map((r) => [r.method, r.url])).toEqual(Array(5).fill(['POST', '/api/antigravity/events']));
    expect(requests.map((r) => (r.body as { event: string }).event)).toEqual(['PreInvocation', 'PreToolUse', 'PostToolUse', 'PostInvocation', 'Stop']);
    expect(requests[1].body).toEqual({ event: 'PreToolUse', conversationId: CONV, workspacePaths: ['/home/ana/loja'], stepIdx: 2, tool: { name: 'run_command', head: 'npm test' } });
    expect(requests[4].body).toEqual({ event: 'Stop', conversationId: CONV, workspacePaths: ['/home/ana/loja'], fullyIdle: true });
  });

  it('AG-05: transcriptPath, artifactDirectoryPath, modelName, args extras e erro nunca saem do hook', async () => {
    const port = await serve();
    await runHook(['PreToolUse'], JSON.stringify({ ...PRE_TOOL, prompt: 'segredo do pedido', output: 'saida da ferramenta' }), port);
    const sent = JSON.stringify(requests[0].body);
    for (const forbidden of ['transcript', 'artifact', 'gemini-3.8', 'segredo', 'saida', 'Cwd', 'WaitMs', 'Rodando', 'brain']) expect(sent, forbidden).not.toContain(forbidden);
  });

  it('o texto curto vem do primeiro campo conhecido, em uma linha e cortado', () => {
    expect(hook.headOf({ AbsolutePath: '/a/b.ts', toolSummary: 'x' })).toBe('/a/b.ts');
    expect(hook.headOf({ toolSummary: 'Resumo do agy' })).toBe('Resumo do agy');
    expect(hook.headOf({ CommandLine: 'echo a\necho b' })).toBe('echo a');
    expect(hook.headOf({ CommandLine: 'x'.repeat(500) })?.length).toBe(200);
    expect(hook.headOf({ CommandLine: '  ' })).toBeUndefined();
    expect(hook.headOf(undefined)).toBeUndefined();
    expect(hook.headOf({ CommandLine: 42 })).toBeUndefined();
  });

  it('só o PreToolUse leva a ferramenta; evento fora dos cinco ou sem conversationId não gera corpo', () => {
    expect(hook.eventBody('PostToolUse', PRE_TOOL)).not.toHaveProperty('tool');
    expect(hook.eventBody('SessionStart', COMMON)).toBeUndefined();
    expect(hook.eventBody('Stop', { workspacePaths: ['/a'] })).toBeUndefined();
    expect(hook.eventBody('Stop', 'texto')).toBeUndefined();
  });

  it('a porta vem do arquivo do instalador, depois de HABBLAUD_PORT, depois do padrão', () => {
    mkdirSync(`${home}/.habblaud`);
    expect(hook.readPort({ HOME: home })).toBe(4747);
    expect(hook.readPort({ HOME: home, HABBLAUD_PORT: '5000' })).toBe(5000);
    writeFileSync(`${home}/.habblaud/antigravity-hook.json`, JSON.stringify({ port: 4800 }));
    expect(hook.readPort({ HOME: home, HABBLAUD_PORT: '5000' })).toBe(4800);
    writeFileSync(`${home}/.habblaud/antigravity-hook.json`, '{ quebrado');
    expect(hook.readPort({ HOME: home, HABBLAUD_PORT: '5000' })).toBe(5000);
  });
});

describe('hook do Antigravity: nunca atrapalha o agy (AG-16)', () => {
  it('Habblaud fora do ar: sai com 0, sem imprimir, rápido', async () => {
    const r = await runHook(['PreToolUse'], JSON.stringify(PRE_TOOL), 1); // porta 1: ninguém escuta
    expect(r).toMatchObject({ code: 0, stdout: '' });
    expect(r.ms).toBeLessThan(2_500);
  });

  it('Habblaud travado (aceita e não responde): desiste em ~1,5 s e sai com 0 sem imprimir', async () => {
    const port = await serve();
    mode = 'hang';
    const r = await runHook(['PreToolUse'], JSON.stringify(PRE_TOOL), port);
    expect(r).toMatchObject({ code: 0, stdout: '' });
    expect(r.ms).toBeGreaterThanOrEqual(1_400);
    expect(r.ms).toBeLessThan(3_500);
  });

  it('stdin vazio, quebrado ou sem JSON de objeto, e evento ausente ou desconhecido: 0, nada impresso, nada mandado', async () => {
    const port = await serve();
    for (const [args, stdin] of [
      [['PreToolUse'], ''],
      [['PreToolUse'], '{ nao json'],
      [['PreToolUse'], '[1,2]'],
      [[], JSON.stringify(PRE_TOOL)],
      [['SessionStart'], JSON.stringify(PRE_TOOL)],
    ] as Array<[string[], string]>) {
      expect(await runHook(args, stdin, port), `${args} ${stdin}`).toMatchObject({ code: 0, stdout: '' });
    }
    expect(requests).toHaveLength(0);
  });

  it('só usa módulos node: (nenhuma dependência)', async () => {
    const src = (await import('node:fs')).readFileSync(HOOK, 'utf8');
    const imports = [...src.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1]);
    expect(imports.length).toBeGreaterThan(0);
    for (const i of imports) expect(i.startsWith('node:'), i).toBe(true);
  });
});
