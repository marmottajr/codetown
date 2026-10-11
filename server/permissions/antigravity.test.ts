// Pedidos de aprovação do Antigravity no registro de permissões (provider "antigravity", mandado pelo hook com
// `--aprovar`): registro só com conversa conhecida e página aberta (AG-20, AG-22), decisão allow/deny com motivo, sem
// interromper nem "sempre permitir", e o resumo do run_command. Dados sintéticos.
import { describe, expect, it } from 'vitest';
import { setQuiet } from '../log';
import { NameStore } from '../model/names';
import { Office } from '../model/office';
import { antigravityToolView } from './antigravity';
import { PermissionRegistry, type WaitResult } from './registry';

setQuiet(true);

const CONV = '08a163a1-c091-4c62-8146-ac8553c45d55';
const AG_MAIN = `antigravity:${CONV}`;
const CLAUDE_MAIN = 'acc:1';

function setup(opts: { viewers?: number } = {}) {
  let now = 1_000_000;
  let permissions: PermissionRegistry | undefined;
  const office = new Office({
    names: new NameStore(null),
    version: 't',
    startedAt: 0,
    accounts: () => [],
    sources: () => [],
    accountName: () => undefined,
    permissions: () => permissions?.snapshot() ?? new Map(),
    now: () => now,
  });
  office.addMain({ id: AG_MAIN, provider: 'antigravity', account: 'antigravity', sessionId: CONV, cwd: '/p/loja', role: 'Agente principal (Antigravity)', startedAt: 0, status: 'working' });
  office.addMain({ id: CLAUDE_MAIN, account: 'acc', sessionId: 'sess-claude', cwd: '/p/loja', role: 'Agente principal', startedAt: 0, status: 'working' });
  let viewers = opts.viewers ?? 1;
  permissions = new PermissionRegistry({ office, viewers: () => viewers, now: () => now });
  return { office, registry: permissions, setViewers: (n: number) => (viewers = n), advance: (ms: number) => (now += ms) };
}

const body = (over: Record<string, unknown> = {}) => ({
  provider: 'antigravity',
  session_id: CONV,
  tool_name: 'run_command',
  tool_input: { command: 'npm test' },
  cwd: '/p/loja',
  timeout_ms: 30_000,
  ...over,
});

const idOf = (r: ReturnType<PermissionRegistry['register']>): string => {
  if ('skip' in r) throw new Error(`pulou: ${r.skip}`);
  return r.id;
};

async function result(registry: PermissionRegistry, id: string): Promise<WaitResult> {
  return registry.wait(id, 1_000)!.result;
}

describe('registro de permissões: Antigravity (AG-20, AG-22)', () => {
  it('conversa conhecida: registra e devolve {id, expiresAt}; o agente fica waiting, "aprovar um comando"', () => {
    const { office, registry } = setup();
    const r = registry.register(body());
    expect(r).toMatchObject({ id: expect.stringMatching(/^p-/), expiresAt: expect.any(Number) });
    const a = office.commit().snapshot.agents.find((x) => x.id === AG_MAIN)!;
    expect(a.status).toBe('waiting');
    expect(a.waitingFor).toBe('aprovar um comando');
    expect(a.permission).toMatchObject({ id: idOf(r), tool: 'run_command', provider: 'antigravity', title: 'Bash(npm test)' });
    expect(a.permission!.suggestions).toBeUndefined();
    expect(a.permission!.questions).toBeUndefined();
  });

  it('sem página aberta, conversa desconhecida ou de outro provider: skip, nada registrado', () => {
    const { registry, setViewers } = setup({ viewers: 0 });
    expect(registry.register(body())).toEqual({ skip: 'no-viewers' });
    setViewers(1);
    expect(registry.register(body({ session_id: 'a0a0a0a0-c091-4c62-8146-ac8553c45d55' }))).toEqual({ skip: 'unknown-session' });
    expect(registry.register(body({ session_id: 'sess-claude' }))).toEqual({ skip: 'unknown-session' });
    expect(registry.size).toBe(0);
  });

  it('um pedido do Claude Code não casa com um agente do Antigravity', () => {
    const { registry } = setup();
    expect(registry.register({ session_id: CONV, tool_name: 'Bash', tool_input: { command: 'ls' }, timeout_ms: 30_000 })).toEqual({ skip: 'unknown-session' });
  });

  it('AG-21: allow chega ao hook como decided/allow; deny leva o motivo digitado', async () => {
    const { registry } = setup();
    const a = idOf(registry.register(body()));
    expect(registry.decide(a, { behavior: 'allow' })).toBe('ok');
    expect(registry.decide(a, { behavior: 'deny' })).toBe('conflict');
    expect(await result(registry, a)).toEqual({ status: 'decided', behavior: 'allow' });
    const b = idOf(registry.register(body({ tool_input: { command: 'rm -rf build' } })));
    expect(registry.decide(b, { behavior: 'deny', message: 'Não apague a pasta build' })).toBe('ok');
    expect(await result(registry, b)).toEqual({ status: 'decided', behavior: 'deny', message: 'Não apague a pasta build' });
  });

  it('interromper e sugestão ("sempre permitir") são recusadas; o pedido continua pendente', () => {
    const { registry } = setup();
    const id = idOf(registry.register(body()));
    expect(registry.decide(id, { behavior: 'deny', interrupt: true })).toBe('unsupported');
    expect(registry.decide(id, { behavior: 'allow', suggestion: 0 })).toBe('unsupported');
    expect(registry.decide(id, { behavior: 'answer', answers: [{ question: 0, options: [0] }] })).toBe('invalid-answer');
    expect(registry.size).toBe(1);
    expect(registry.decide(id, { behavior: 'terminal' })).toBe('ok');
  });

  it('AG-22: tempo esgotado libera o pedido (o hook não imprime nada e o agy pergunta)', async () => {
    const { registry, advance } = setup();
    const id = idOf(registry.register(body({ timeout_ms: 5_000 })));
    advance(5_000 + 5_001);
    registry.tick();
    expect(await result(registry, id)).toEqual({ status: 'released', reason: 'expired' });
  });

  it('agente que saiu do escritório: o pedido é liberado', async () => {
    const { office, registry } = setup();
    const id = idOf(registry.register(body()));
    office.closeMain(AG_MAIN);
    registry.tick();
    expect(await result(registry, id)).toMatchObject({ status: 'released' });
  });

  it('uma "pergunta" (AskUserQuestion) do Antigravity não vira cartão de pergunta', () => {
    const { registry } = setup();
    const r = registry.register(body({ tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'x?', options: [{ label: 'a' }] }] } }));
    expect(r).toMatchObject({ id: expect.any(String) });
    const id = idOf(r);
    expect(registry.decide(id, { behavior: 'answer', answers: [{ question: 0, options: [0] }] })).toBe('invalid-answer');
  });
});

describe('antigravityToolView', () => {
  it('run_command: o título é o Bash do comando, mascara segredos, o detalhe é o comando', () => {
    const a = antigravityToolView('run_command', { command: 'curl -H "Authorization: Bearer abcdef123456" https://api.x' });
    expect(a.title).toMatch(/^Bash\(curl/);
    expect(a.title).not.toContain('abcdef123456');
    expect(a).toMatchObject({ inputKind: 'command' });
    expect(a.input).toContain('Authorization: ***');
    expect(antigravityToolView('run_command', { command: 'npm test' }).title).toBe('Bash(npm test)');
  });

  it('outra ferramenta: resumo genérico, sem derrubar; sem comando fica sem detalhe', () => {
    expect(antigravityToolView('view_file', { command: '/a/b.ts' }).title).toBe('Read');
    expect(antigravityToolView('run_command', {}).input).toBeUndefined();
  });
});
