// Pedidos de aprovação do OpenCode no registro de permissões (provider "opencode", mandado pelo plugin): registro só
// com sessão conhecida e página aberta (OC-19, OC-21), decisão allow/deny com motivo, sem interromper nem "sempre
// permitir", o resumo por nome de permissão, e as rotas de verdade (/api/permissions). Dados sintéticos.
import { afterEach, describe, expect, it } from 'vitest';
import { setQuiet } from '../log';
import { NameStore } from '../model/names';
import { Office } from '../model/office';
import { ocId } from '../test/opencode-fixtures';
import { request, servePermissions, type PermissionServer } from '../test/permission-server';
import { opencodeToolView } from './opencode';
import type { PermissionAnswer } from '../../shared/types';
import { PermissionRegistry, type WaitResult } from './registry';

setQuiet(true);

const SES = ocId('ses', 1);
const SUBSES = ocId('ses', 2);
const OC_MAIN = `opencode:${SES}`;
const OC_SUB = `opencode:${SUBSES}`;
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
  office.addMain({ id: OC_MAIN, provider: 'opencode', account: 'opencode', sessionId: SES, cwd: '/p/loja', role: 'Agente principal (OpenCode)', startedAt: 0, status: 'working' });
  office.addSub({ id: OC_SUB, parentId: OC_MAIN, sessionId: SUBSES, role: 'Subagente (OpenCode)', background: false, startedAt: 0 });
  office.addMain({ id: CLAUDE_MAIN, account: 'acc', sessionId: 'sess-claude', cwd: '/p/loja', role: 'Agente principal', startedAt: 0, status: 'working' });
  let viewers = opts.viewers ?? 1;
  permissions = new PermissionRegistry({ office, viewers: () => viewers, now: () => now });
  return { office, registry: permissions, setViewers: (n: number) => (viewers = n), advance: (ms: number) => (now += ms) };
}

const body = (over: Record<string, unknown> = {}) => ({
  provider: 'opencode',
  session_id: SES,
  tool_name: 'bash',
  tool_input: { patterns: ['git status'], metadata: {} },
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

describe('registro de permissões: OpenCode (OC-19, OC-21)', () => {
  it('sessão conhecida: registra e devolve {id, expiresAt}; o agente fica waiting com provider opencode', () => {
    const { office, registry } = setup();
    const r = registry.register(body());
    expect(r).toMatchObject({ id: expect.stringMatching(/^p-/), expiresAt: expect.any(Number) });
    const a = office.commit().snapshot.agents.find((x) => x.id === OC_MAIN)!;
    expect(a.status).toBe('waiting');
    expect(a.waitingFor).toBe('aprovar uma permissão');
    expect(a.permission).toMatchObject({ id: idOf(r), tool: 'bash', provider: 'opencode', title: 'Bash(git status)' });
    expect(a.permission!.suggestions).toBeUndefined();
    expect(a.permission!.questions).toBeUndefined();
  });

  it('sem página aberta, sessão desconhecida ou sessão de outro provider: skip, nada registrado', () => {
    const { registry, setViewers } = setup({ viewers: 0 });
    expect(registry.register(body())).toEqual({ skip: 'no-viewers' });
    setViewers(1);
    expect(registry.register(body({ session_id: ocId('ses', 77) }))).toEqual({ skip: 'unknown-session' });
    expect(registry.register(body({ session_id: 'sess-claude' }))).toEqual({ skip: 'unknown-session' });
    expect(registry.size).toBe(0);
  });

  it('a sessão filha (subagente mostrado) recebe o próprio pedido', () => {
    const { office, registry } = setup();
    idOf(registry.register(body({ session_id: SUBSES })));
    const snap = office.commit().snapshot;
    expect(snap.agents.find((x) => x.id === OC_SUB)?.status).toBe('waiting');
    expect(snap.agents.find((x) => x.id === OC_MAIN)?.permission).toBeUndefined();
  });

  it('um pedido do Claude Code não casa com um agente do OpenCode (nem o contrário)', () => {
    const { registry } = setup();
    expect(registry.register({ session_id: SES, tool_name: 'Bash', tool_input: { command: 'ls' }, timeout_ms: 30_000 })).toEqual({ skip: 'unknown-session' });
    expect(registry.register({ session_id: 'sess-claude', tool_name: 'Bash', tool_input: { command: 'ls' }, timeout_ms: 30_000 })).toMatchObject({ id: expect.any(String) });
  });

  it('allow chega ao plugin como decided/allow; deny leva o motivo digitado', async () => {
    const { registry } = setup();
    const a = idOf(registry.register(body()));
    expect(registry.decide(a, { behavior: 'allow' })).toBe('ok');
    expect(registry.decide(a, { behavior: 'deny' })).toBe('conflict');
    expect(await result(registry, a)).toEqual({ status: 'decided', behavior: 'allow' });
    const b = idOf(registry.register(body({ tool_input: { patterns: ['rm -rf build'] } })));
    expect(registry.decide(b, { behavior: 'deny', message: 'Não apague a pasta build' })).toBe('ok');
    expect(await result(registry, b)).toEqual({ status: 'decided', behavior: 'deny', message: 'Não apague a pasta build' });
  });

  it('interromper e sugestão ("sempre permitir") são recusadas como no Codex; o pedido continua pendente', () => {
    const { registry } = setup();
    const id = idOf(registry.register(body()));
    expect(registry.decide(id, { behavior: 'deny', interrupt: true })).toBe('unsupported');
    expect(registry.decide(id, { behavior: 'allow', suggestion: 0 })).toBe('unsupported');
    expect(registry.decide(id, { behavior: 'answer', answers: [{ question: 0, options: [0] }] })).toBe('invalid-answer');
    expect(registry.size).toBe(1);
    expect(registry.decide(id, { behavior: 'terminal' })).toBe('ok');
  });

  it('tempo esgotado: o pedido é liberado (o plugin deixa o OpenCode perguntar)', async () => {
    const { registry, advance } = setup();
    const id = idOf(registry.register(body({ timeout_ms: 5_000 })));
    advance(5_000 + 5_001);
    registry.tick();
    expect(await result(registry, id)).toEqual({ status: 'released', reason: 'expired' });
  });

  it('agente que saiu do escritório: o pedido é liberado', async () => {
    const { office, registry } = setup();
    const id = idOf(registry.register(body()));
    office.closeMain(OC_MAIN);
    registry.tick();
    expect(await result(registry, id)).toMatchObject({ status: 'released' });
  });

  it('corpo com provider desconhecido cai no caminho do Claude Code (sem agente OpenCode)', () => {
    const { registry } = setup();
    expect(registry.register(body({ provider: 'outro' }))).toEqual({ skip: 'unknown-session' });
  });
});

describe('opencodeToolView', () => {
  it('bash: usa metadata.command, senão os padrões; mascara segredos; o detalhe é o comando', () => {
    const a = opencodeToolView('bash', { patterns: ['git *'], metadata: { command: 'curl -H "Authorization: Bearer abcdef123456" https://api.x' } });
    expect(a.title).toMatch(/^Bash\(curl/);
    expect(a.title).not.toContain('abcdef123456');
    expect(a).toMatchObject({ inputKind: 'command' });
    expect(a.input).toContain('Authorization: ***');
    expect(opencodeToolView('bash', { patterns: ['npm test'] }).title).toBe('Bash(npm test)');
  });

  it('edit: arquivo de metadata.filepath (ou do padrão) e o diff como detalhe', () => {
    const v = opencodeToolView('edit', { patterns: ['src/app.ts'], metadata: { filepath: '/p/loja/src/app.ts', diff: '--- a\n+++ b\n-um\n+dois' } });
    expect(v).toMatchObject({ title: 'edit(/p/loja/src/app.ts)', text: 'Editando app.ts', icon: '✏️', inputKind: 'diff' });
    expect(v.input).toContain('+dois');
    expect(opencodeToolView('edit', { patterns: ['src/x.ts'] }).title).toBe('edit(src/x.ts)');
  });

  it('outras permissões: nome(padrão) e o rótulo do Claude Code; external_directory; entrada vazia ou hostil não quebra', () => {
    expect(opencodeToolView('read', { patterns: ['src/a.ts'] })).toMatchObject({ title: 'read(src/a.ts)', icon: '📖' });
    expect(opencodeToolView('webfetch', { patterns: ['https://x.dev'] }).title).toBe('webfetch(https://x.dev)');
    expect(opencodeToolView('external_directory', { patterns: ['/etc/*'] })).toMatchObject({ title: 'external_directory(/etc/*)', icon: '📂' });
    for (const input of [{}, { patterns: 'x' }, { patterns: [1, null, {}] }, { patterns: ['a'], metadata: 7 }]) {
      for (const tool of ['bash', 'edit', 'read', 'zzz', 'a b/c']) expect(() => opencodeToolView(tool, input as Record<string, unknown>), `${tool} ${JSON.stringify(input)}`).not.toThrow();
    }
    expect(opencodeToolView('weird tool/\x00', { patterns: ['x'] }).title).toMatch(/^weirdtool\(x\)$/);
  });
});

describe('POST /api/permissions com provider "opencode" (rotas de verdade)', () => {
  let srv: PermissionServer | undefined;
  afterEach(async () => {
    await srv?.close();
    srv = undefined;
  });

  it('registra, espera e recebe allow/deny; sem página aberta {skip}; interromper: 400', async () => {
    srv = await servePermissions();
    srv.office.addMain({ id: OC_MAIN, provider: 'opencode', account: 'opencode', sessionId: SES, cwd: '/p/loja', role: 'Agente principal (OpenCode)', startedAt: Date.now(), status: 'working' });
    const reg = await request(srv.base, '/api/permissions', { method: 'POST', body: body() });
    expect(reg.status).toBe(201);
    const id = (reg.json as { id: string }).id;
    expect((await request(srv.base, `/api/permissions/${id}/decision`, { method: 'POST', body: { behavior: 'deny', interrupt: true } })).status).toBe(400);
    const wait = request(srv.base, `/api/permissions/${id}/wait?timeout=5`);
    expect((await request(srv.base, `/api/permissions/${id}/decision`, { method: 'POST', body: { behavior: 'deny', message: 'agora não' } })).status).toBe(200);
    expect((await wait).json).toEqual({ status: 'decided', behavior: 'deny', message: 'agora não' });
    srv.setViewers(0);
    expect((await request(srv.base, '/api/permissions', { method: 'POST', body: body() })).json).toEqual({ skip: 'no-viewers' });
  });
});

const QUESTIONS = [
  { question: 'Qual banco usar?', header: 'Banco', multiSelect: false, options: [{ label: 'Postgres', description: 'Já usado' }, { label: 'SQLite' }] },
  { question: 'Quais testes rodar?', header: 'Testes', multiSelect: true, options: [{ label: 'Unidade' }, { label: 'E2E' }] },
];
const ask = (over: Record<string, unknown> = {}) => body({ tool_name: 'AskUserQuestion', tool_input: { questions: QUESTIONS }, ...over });

describe('perguntas do OpenCode no registro de permissões (OQ-10, OQ-11, OQ-16)', () => {
  it('OQ-10: pergunta de sessão conhecida registra, devolve {id, expiresAt} e o cartão leva as perguntas', () => {
    const { office, registry } = setup();
    const r = registry.register(ask());
    expect(r).toMatchObject({ id: expect.stringMatching(/^p-/), expiresAt: expect.any(Number) });
    const a = office.commit().snapshot.agents.find((x) => x.id === OC_MAIN)!;
    expect(a).toMatchObject({ status: 'waiting', waitingFor: 'responder uma pergunta' });
    expect(a.permission).toMatchObject({ id: idOf(r), tool: 'AskUserQuestion', provider: 'opencode', icon: '❓' });
    expect(a.permission!.questions!.map((q) => q.index)).toEqual([0, 1]);
    expect(a.permission!.questions![1]).toMatchObject({ multiSelect: true, options: [{ index: 0, label: 'Unidade' }, { index: 1, label: 'E2E' }] });
  });

  it('OQ-11: sem página aberta ou sessão desconhecida: skip; pergunta que não cabe inteira (mais de 4): skip', () => {
    const { registry, setViewers } = setup({ viewers: 0 });
    expect(registry.register(ask())).toEqual({ skip: 'no-viewers' });
    setViewers(1);
    expect(registry.register(ask({ session_id: ocId('ses', 77) }))).toEqual({ skip: 'unknown-session' });
    const five = Array.from({ length: 5 }, (_, i) => ({ question: `P${i}`, options: [{ label: 'a' }] }));
    expect(registry.register(ask({ tool_input: { questions: five } }))).toEqual({ skip: 'unsupported-tool' });
    expect(registry.size).toBe(0);
  });

  it('OQ-10: answer resolve com as respostas validadas (posições do original); contagem errada ou opção inexistente: inválida', async () => {
    const { registry } = setup();
    const id = idOf(registry.register(ask()));
    expect(registry.decide(id, { behavior: 'answer', answers: [{ question: 0, options: [1] }] })).toBe('invalid-answer');
    expect(registry.decide(id, { behavior: 'answer', answers: [{ question: 0, options: [9] }, { question: 1, options: [0] }] })).toBe('invalid-answer');
    expect(registry.decide(id, { behavior: 'allow' })).toBe('invalid-answer');
    expect(registry.size).toBe(1);
    expect(registry.decide(id, { behavior: 'answer', answers: [{ question: 1, options: [1, 0], other: ' lint ' }, { question: 0, options: [1] }] })).toBe('ok');
    expect(await result(registry, id)).toEqual({
      status: 'decided',
      behavior: 'answer',
      answers: [
        { question: 0, options: [1] },
        { question: 1, options: [0, 1], other: 'lint' },
      ],
    });
  });

  it('deny e terminal valem para a pergunta; interromper segue recusado', async () => {
    const { registry } = setup();
    const a = idOf(registry.register(ask()));
    expect(registry.decide(a, { behavior: 'deny', interrupt: true })).toBe('unsupported');
    expect(registry.decide(a, { behavior: 'deny' })).toBe('ok');
    expect(await result(registry, a)).toEqual({ status: 'decided', behavior: 'deny' });
    const b = idOf(registry.register(ask()));
    expect(registry.decide(b, { behavior: 'terminal' })).toBe('ok');
    expect(await result(registry, b)).toEqual({ status: 'released', reason: 'terminal' });
  });

  it('OQ-16: releaseOpencodeQuestions libera só as perguntas pendentes daquela sessão', async () => {
    const { office, registry } = setup();
    const q1 = idOf(registry.register(ask()));
    const q2 = idOf(registry.register(ask()));
    const other = idOf(registry.register(ask({ session_id: SUBSES })));
    const perm = idOf(registry.register(body()));
    expect(registry.releaseOpencodeQuestions(SES)).toBe(2);
    expect(await result(registry, q1)).toEqual({ status: 'released', reason: 'answered' });
    expect(await result(registry, q2)).toEqual({ status: 'released', reason: 'answered' });
    expect(registry.size).toBe(2);
    expect(registry.decide(other, { behavior: 'terminal' })).toBe('ok');
    expect(registry.decide(perm, { behavior: 'allow' })).toBe('ok');
    expect(registry.releaseOpencodeQuestions(SES)).toBe(0);
    expect(office.commit().snapshot.agents.find((x) => x.id === OC_MAIN)?.permission).toBeUndefined();
  });

  it('OQ-16: releaseOpencodeQuestions não solta pergunta de outro provider da MESMA sessão', async () => {
    const { office, registry } = setup();
    office.addMain({ id: 'acc:2', account: 'acc', sessionId: SES, cwd: '/p/loja', role: 'Agente principal', startedAt: 0, status: 'working' });
    const claude = idOf(registry.register({ session_id: SES, tool_name: 'AskUserQuestion', tool_input: { questions: QUESTIONS }, cwd: '/p/loja', timeout_ms: 30_000 }));
    const oc = idOf(registry.register(ask()));
    expect(registry.releaseOpencodeQuestions(SES)).toBe(1);
    expect(await result(registry, oc)).toEqual({ status: 'released', reason: 'answered' });
    expect(registry.decide(claude, { behavior: 'deny' })).toBe('ok'); // continua pendente
    expect(registry.releaseOpencodeQuestions(SES)).toBe(0);
  });

  it('opencodeToolView: AskUserQuestion devolve título, texto e as perguntas mascaradas; entrada hostil não quebra', () => {
    const v = opencodeToolView('AskUserQuestion', { questions: [{ question: 'Use Authorization: Bearer abcdef123456?', options: [{ label: 'Sim' }] }] });
    expect(v).toMatchObject({ icon: '❓', questions: [{ index: 0, options: [{ index: 0, label: 'Sim' }] }] });
    expect(JSON.stringify(v)).not.toContain('abcdef123456');
    for (const input of [{}, { questions: 'x' }, { questions: [1, null] }]) expect(() => opencodeToolView('AskUserQuestion', input as Record<string, unknown>)).not.toThrow();
  });
});

// O corpo é o que client/src/ui/permission.ts (buildAnswers) monta para este cartão; o teste do cartão
// (client/src/ui/permission-card.test.ts, "contrato") exige o mesmo literal. Mexer num sem o outro quebra um dos dois.
describe('contrato cliente x servidor: a resposta que o cartão monta é a que o registro aceita (pergunta do OpenCode)', () => {
  it('o corpo {behavior:"answer", answers} no formato do buildAnswers resolve como "decided"/"answer"', async () => {
    const { registry } = setup();
    const id = idOf(registry.register(ask()));
    const answers: PermissionAnswer[] = [{ question: 0, options: [1] }, { question: 1, options: [0], other: 'lint' }];
    expect(registry.decide(id, { behavior: 'answer', answers })).toBe('ok');
    expect(await result(registry, id)).toEqual({ status: 'decided', behavior: 'answer', answers });
  });
});
