// Pedidos 'parallel' do Codex no registro de permissões (contrato C4, spec R2.8): o canal do app-server registra o
// pedido sem prazo do hook (vale a 1ª resposta, escritório ou terminal), a decisão do escritório vai ao ParallelSink,
// o hook do Codex numa thread atendida pelo canal sai sem decidir ({skip: 'parallel'}) e a corrida hook × canal
// termina com um cartão só. Agentes e ids sintéticos.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { CodexDecision, PermissionRequestInfo } from '../../shared/types';
import { log, setQuiet } from '../log';
import { NameStore } from '../model/names';
import { Office } from '../model/office';
import { ORPHAN_MS, parseDecision, PermissionRegistry, RESOLVED_KEEP_MS, WAIT_MAX_MS, type ParallelRequestInput, type ParallelSink } from './registry';

setQuiet(true);

/** decisionOutput do hook do Codex (o que ele imprime para uma resposta da espera; undefined = sai sem decidir). */
const hook = (await import(pathToFileURL(resolve(__dirname, '../../mod/habblaud-codex/hook.mjs')).href)) as { decisionOutput(result: unknown): unknown };

const THREAD = '0199b0c0-1234-7abc-8def-0123456789ab';
const CHILD = '0199b0c0-5678-7abc-8def-0123456789ab';
const MAIN = `.codex:${THREAD}`;
const SUB = `.codex:${CHILD}`;
const KEY = '.codex:7';
const ALL: CodexDecision[] = ['accept', 'acceptForSession', 'decline', 'cancel'];

type DecideReply = Awaited<ReturnType<ParallelSink['decide']>>;

function setup(opts: { viewers?: number } = {}) {
  let now = 1_000_000;
  const clock = { now: () => now, advance: (ms: number) => (now += ms) };
  let permissions: PermissionRegistry | undefined;
  const office = new Office({
    names: new NameStore(null),
    version: 't',
    startedAt: 0,
    accounts: () => [],
    sources: () => [],
    accountName: () => undefined,
    permissions: () => permissions?.snapshot() ?? new Map(),
    now: clock.now,
  });
  office.addMain({ id: MAIN, provider: 'codex', account: '.codex', sessionId: THREAD, cwd: '/p/loja', role: 'Agente principal', startedAt: 0, status: 'working' });
  permissions = new PermissionRegistry({ office, viewers: () => opts.viewers ?? 1, now: clock.now });
  const sent: Array<[string, CodexDecision]> = [];
  const owned = new Set<string>();
  const asked: Array<[string, string]> = [];
  const state: { reply: DecideReply | Error } = { reply: 'ok' };
  const sink: ParallelSink = {
    decide: (key, decision) => {
      if (state.reply instanceof Error) throw state.reply;
      sent.push([key, decision]);
      return Promise.resolve(state.reply as DecideReply);
    },
    owns: (account, threadId) => {
      asked.push([account, threadId]);
      return owned.has(`${account}|${threadId}`);
    },
  };
  return { office, registry: permissions, clock, sent, owned, asked, state, sink };
}

function req(over: Partial<ParallelRequestInput> = {}): ParallelRequestInput {
  return {
    key: KEY,
    account: '.codex',
    threadId: THREAD,
    tool: 'exec_command',
    input: { command: 'rm -rf build' },
    cwd: '/p/loja',
    reason: 'precisa apagar a pasta build (password=hunter2)',
    decisions: ALL,
    ...over,
  };
}

function opened(r: ReturnType<PermissionRegistry['registerParallel']>): string {
  if ('skip' in r) throw new Error(`pulou: ${r.skip}`);
  return r.id;
}

/** JSON do hook PermissionRequest do Codex (mod/habblaud-codex/hook.mjs). */
function codexHook(over: Record<string, unknown> = {}) {
  return { provider: 'codex', account: '.codex', codexHome: '/u/.codex', session_id: THREAD, cwd: '/p/loja', tool_name: 'Bash', tool_input: { command: 'rm -rf build' }, timeout_ms: 25_000, ...over };
}

function registered(r: ReturnType<PermissionRegistry['register']>): string {
  if ('skip' in r) throw new Error(`pulou: ${r.skip}`);
  return r.id;
}

const snapAgent = (office: Office, id: string) => office.commit().snapshot.agents.find((a) => a.id === id);

describe('registerParallel: o pedido do canal do app-server', () => {
  it('entra sem página aberta, deixa o agente esperando e vai ao snapshot com mode, decisions e provider (sem os argumentos)', () => {
    // Arrange
    const { office, registry, clock } = setup({ viewers: 0 });
    office.commit();

    // Act
    const id = opened(registry.registerParallel(req()));

    // Assert
    const commit = office.commit();
    const a = commit.snapshot.agents.find((x) => x.id === MAIN)!;
    expect(a).toMatchObject({ status: 'waiting', waitingFor: 'aprovar um comando' });
    expect(a.permission).toMatchObject({ id, provider: 'codex', mode: 'parallel', decisions: ALL, tool: 'exec_command', title: 'Bash(rm -rf build)', createdAt: clock.now() });
    expect(a.permission!.input).toBeUndefined();
    expect(registry.detail(id)).toMatchObject({ input: 'rm -rf build', inputKind: 'command' });
    // A justificativa vai no detalhe da atividade, mascarada.
    const act = commit.feed.map((f) => f.activity).find((x) => x.tool === 'PermissionRequest')!;
    expect(act.text).toMatch(/^Pede permissão:/);
    expect(act.detail).toContain('Bash(rm -rf build) — precisa apagar a pasta build');
    expect(act.detail).not.toContain('hunter2');
    expect(commit.notices.map((n) => n.agentId)).toEqual([MAIN]);
  });

  it('a mesma key devolve o mesmo pedido (resume e reconexão reenviam os pendentes); thread que ninguém mostra: unknown-session', () => {
    const { registry } = setup();
    const id = opened(registry.registerParallel(req()));
    expect(registry.registerParallel(req({ input: { command: 'outro' } }))).toEqual({ id });
    expect(registry.size).toBe(1);
    expect(registry.registerParallel(req({ key: '.codex:8', threadId: '0199b0c0-9999-7abc-8def-0123456789ab' }))).toEqual({ skip: 'unknown-session' });
  });

  it('agente certo pela conta + thread: a conta desempata o mesmo thread; a thread do subagente vai para ele', () => {
    const { office, registry } = setup();
    office.addMain({ id: `.codex~2:${THREAD}`, provider: 'codex', account: '.codex~2', sessionId: THREAD, cwd: '/p/api', role: 'Agente principal', startedAt: 0, status: 'working' });
    office.addSub({ id: SUB, parentId: MAIN, sessionId: CHILD, role: 'worker', background: false, startedAt: 0 });
    const two = opened(registry.registerParallel(req({ account: '.codex~2' })));
    const sub = opened(registry.registerParallel(req({ key: '.codex:9', threadId: CHILD })));
    expect(snapAgent(office, `.codex~2:${THREAD}`)!.permission?.id).toBe(two);
    expect(snapAgent(office, MAIN)!.permission).toBeUndefined();
    expect(snapAgent(office, SUB)!.permission).toMatchObject({ id: sub, mode: 'parallel' });
    expect(snapAgent(office, SUB)!.permission!.subagent).toBeUndefined();
  });

  it('decisões: só as do contrato, na ordem; lista vazia = as quatro', () => {
    const { registry } = setup();
    const odd = ['decline', 'acceptWithExecpolicyAmendment', 'accept'] as unknown as CodexDecision[];
    expect(registry.detail(opened(registry.registerParallel(req({ decisions: odd }))))!.decisions).toEqual(['decline', 'accept']);
    expect(registry.detail(opened(registry.registerParallel(req({ key: '.codex:8', decisions: [] }))))!.decisions).toEqual(ALL);
  });

  it('apply_patch: título com o arquivo e o patch como diff', () => {
    const { registry } = setup();
    const patch = ['*** Begin Patch', '*** Update File: /p/loja/src/app.ts', '@@', '-antes', '+depois', '*** End Patch'].join('\n');
    const id = opened(registry.registerParallel(req({ tool: 'apply_patch', input: { patch }, reason: undefined })));
    expect(registry.detail(id)).toMatchObject({ tool: 'apply_patch', title: 'apply_patch(src/app.ts)', inputKind: 'diff', text: 'Editando app.ts' });
  });

  it('não expira pelo prazo do hook nem vira órfão; sai com o agente que saiu', () => {
    // Arrange
    const { office, registry, clock } = setup();
    const id = opened(registry.registerParallel(req()));

    // Act + Assert: muito depois do órfão, do long-poll e do prazo de qualquer hook, continua.
    for (const ms of [ORPHAN_MS + 1, WAIT_MAX_MS, 30 * 60_000]) {
      clock.advance(ms);
      registry.tick();
      expect(registry.detail(id), `+${ms} ms`).toBeDefined();
    }
    office.closeMain(MAIN);
    registry.tick();
    expect(registry.detail(id)).toBeUndefined();
    expect(registry.size).toBe(0);
  });

  it('resolveParallel (respondido no terminal ou cancelado) fecha o cartão; a key volta a valer para um pedido novo', () => {
    const { office, registry } = setup();
    const id = opened(registry.registerParallel(req()));
    registry.resolveParallel(KEY);
    expect(snapAgent(office, MAIN)!.permission).toBeUndefined();
    expect(snapAgent(office, MAIN)!.status).toBe('working');
    expect(registry.size).toBe(0);
    expect(() => registry.resolveParallel(KEY)).not.toThrow();
    // Depois de uma reconexão o app-server recomeça os requestId: a mesma key é outro pedido.
    const again = opened(registry.registerParallel(req()));
    expect(again).not.toBe(id);
  });
});

describe('decisão do escritório num pedido parallel', () => {
  it('allow → accept, allow + forSession → acceptForSession, deny → decline; o cartão fica até o resolveParallel', async () => {
    const cases: Array<[Parameters<PermissionRegistry['decide']>[1], CodexDecision, string]> = [
      [{ behavior: 'allow' }, 'accept', 'Aprovado no Habblaud'],
      [{ behavior: 'allow', forSession: true }, 'acceptForSession', 'Aprovado no Habblaud (nesta sessão)'],
      [{ behavior: 'deny', message: 'não' }, 'decline', 'Recusado no Habblaud'],
    ];
    for (const [decision, expected, text] of cases) {
      // Arrange
      const { office, registry, sent, sink } = setup();
      registry.setParallelSink(sink);
      const id = opened(registry.registerParallel(req()));

      // Act
      const r = await registry.decide(id, decision);

      // Assert
      expect(r).toBe('ok');
      expect(sent).toEqual([[KEY, expected]]);
      expect(office.detail(MAIN)!.history.map((h) => h.text)).toContain(text);
      // Vale o serverRequest/resolved (a resposta pode ter perdido a corrida para o terminal).
      expect(snapAgent(office, MAIN)!.permission?.id).toBe(id);
      expect(await registry.decide(id, { behavior: 'allow' })).toBe('conflict');
      registry.resolveParallel(KEY);
      expect(snapAgent(office, MAIN)!.permission).toBeUndefined();
      expect(registry.size).toBe(0);
    }
  });

  it('decisão que o pedido não oferece, interromper, "sempre permitir" ou responder pergunta: não envia', async () => {
    const { registry, sent, sink } = setup();
    registry.setParallelSink(sink);
    const id = opened(registry.registerParallel(req({ decisions: ['accept', 'decline'] })));
    expect(await registry.decide(id, { behavior: 'allow', forSession: true })).toBe('unsupported');
    expect(await registry.decide(id, { behavior: 'deny', interrupt: true })).toBe('unsupported');
    expect(await registry.decide(id, { behavior: 'allow', suggestion: 0 })).toBe('unsupported');
    expect(await registry.decide(id, { behavior: 'answer', answers: [{ question: 0, options: [0] }] })).toBe('invalid-answer');
    expect(sent).toEqual([]);
    expect(await registry.decide(id, { behavior: 'allow' })).toBe('ok');
  });

  it('sem canal, canal indisponível ou que lança: unavailable, e dá para tentar de novo', async () => {
    const { registry, sent, state, sink } = setup();
    const id = opened(registry.registerParallel(req()));
    expect(await registry.decide(id, { behavior: 'allow' })).toBe('unavailable');
    registry.setParallelSink(sink);
    state.reply = 'unavailable';
    expect(await registry.decide(id, { behavior: 'allow' })).toBe('unavailable');
    state.reply = new Error('socket fechado');
    expect(await registry.decide(id, { behavior: 'allow' })).toBe('unavailable');
    expect(registry.detail(id)).toBeDefined();
    state.reply = 'ok';
    expect(await registry.decide(id, { behavior: 'allow' })).toBe('ok');
    expect(sent.at(-1)).toEqual([KEY, 'accept']);
  });

  it('sink que lança: o erro vai ao log, sem a decisão nem o conteúdo do pedido, e a página recebe unavailable', async () => {
    const { registry, state, sink } = setup();
    registry.setParallelSink(sink);
    const id = opened(registry.registerParallel(req()));
    const warn = vi.spyOn(log, 'warnOnce');
    try {
      state.reply = new Error('proxy em estado inválido');
      expect(await registry.decide(id, { behavior: 'allow' })).toBe('unavailable');
      expect(warn).toHaveBeenCalledTimes(1);
      const [key, text] = warn.mock.calls[0];
      expect(`${key} ${text}`).toContain('proxy em estado inválido');
      expect(`${key} ${text}`).not.toMatch(/hunter2|rm -rf/);
    } finally {
      warn.mockRestore();
    }
  });

  it('gone (já respondido ou cancelado no app-server): o cartão fecha e a página recebe not-found', async () => {
    const { office, registry, state, sink } = setup();
    registry.setParallelSink(sink);
    const id = opened(registry.registerParallel(req()));
    state.reply = 'gone';
    expect(await registry.decide(id, { behavior: 'allow' })).toBe('not-found');
    expect(snapAgent(office, MAIN)!.permission).toBeUndefined();
    expect(office.detail(MAIN)!.history.map((h) => h.text)).not.toContain('Aprovado no Habblaud');
  });

  it('duas decisões ao mesmo tempo (duas abas): a segunda é conflict e só uma vai ao canal', async () => {
    const { registry, sent, sink } = setup();
    registry.setParallelSink(sink);
    const id = opened(registry.registerParallel(req()));
    const [a, b] = await Promise.all([registry.decide(id, { behavior: 'allow' }), registry.decide(id, { behavior: 'deny' })]);
    expect([a, b]).toEqual(['ok', 'conflict']);
    expect(sent).toEqual([[KEY, 'accept']]);
  });

  it('"responder no terminal" só fecha no escritório (nada vai ao canal); um resolveParallel atrasado não quebra nada', async () => {
    const { office, registry, sent, sink } = setup();
    registry.setParallelSink(sink);
    const id = opened(registry.registerParallel(req()));
    expect(await registry.decide(id, { behavior: 'terminal' })).toBe('ok');
    expect(sent).toEqual([]);
    expect(snapAgent(office, MAIN)!.permission).toBeUndefined();
    expect(() => registry.resolveParallel(KEY)).not.toThrow();
  });

  it('decidido aqui e sem a confirmação do app-server por RESOLVED_KEEP_MS: o cartão fecha sozinho', async () => {
    const { registry, clock, sink } = setup();
    registry.setParallelSink(sink);
    const id = opened(registry.registerParallel(req()));
    await registry.decide(id, { behavior: 'allow' });
    clock.advance(RESOLVED_KEEP_MS - 1);
    registry.tick();
    expect(registry.detail(id)).toBeDefined();
    clock.advance(1);
    registry.tick();
    expect(registry.detail(id)).toBeUndefined();
  });

  it('pedido do demo em modo parallel: as mesmas regras antes de ir ao demoDecide', async () => {
    const { office } = setup();
    const demo: PermissionRequestInfo = { id: 'demo:1', provider: 'codex', mode: 'parallel', decisions: ['accept', 'decline'], tool: 'exec_command', title: 'Bash(ls)', text: 'Listando', icon: '💻', createdAt: 0, expiresAt: 1 };
    const got: unknown[] = [];
    const registry = new PermissionRegistry({ office, viewers: () => 1, demoDetail: (id) => (id === demo.id ? demo : undefined), demoDecide: (_id, d) => got.push(d) > 0 });
    expect(await registry.decide(demo.id, { behavior: 'allow', forSession: true })).toBe('unsupported');
    expect(await registry.decide(demo.id, { behavior: 'allow' })).toBe('ok');
    expect(got).toEqual([{ behavior: 'allow' }]);
  });
});

describe('hook do Codex × canal paralelo', () => {
  it('thread atendida pelo canal (sink.owns pela conta e pela thread da chamada): {skip: "parallel"}, mesmo sem página, e nada é registrado', () => {
    // Arrange
    const { office, registry, owned, asked, sink } = setup({ viewers: 0 });
    office.addSub({ id: SUB, parentId: MAIN, sessionId: CHILD, role: 'worker', background: false, startedAt: 0 });
    registry.setParallelSink(sink);
    owned.add(`.codex|${THREAD}`);
    owned.add(`.codex|${CHILD}`);

    // Act + Assert
    expect(registry.register(codexHook())).toEqual({ skip: 'parallel' });
    expect(registry.register(codexHook({ agent_id: CHILD, agent_type: 'worker' }))).toEqual({ skip: 'parallel' });
    expect(asked).toEqual([
      ['.codex', THREAD],
      ['.codex', CHILD],
    ]);
    expect(registry.size).toBe(0);
  });

  it('a conta conferida é a do Habblaud (codexAccount pela pasta CODEX_HOME)', () => {
    const { office, owned, asked, sink } = setup();
    const registry = new PermissionRegistry({ office, viewers: () => 1, codexAccount: (_a, home) => (home === '/u/.codex-dois' ? '.codex~2' : undefined) });
    registry.setParallelSink(sink);
    owned.add(`.codex~2|${THREAD}`);
    expect(registry.register(codexHook({ account: '.codex-dois', codexHome: '/u/.codex-dois' }))).toEqual({ skip: 'parallel' });
    expect(asked).toEqual([['.codex~2', THREAD]]);
  });

  it('thread que o canal não atende: o hook segue como hoje (bloqueante, sem mode)', () => {
    const { office, registry, sink } = setup();
    registry.setParallelSink(sink);
    const id = registered(registry.register(codexHook()));
    expect(snapAgent(office, MAIN)!.permission).toMatchObject({ id, provider: 'codex' });
    expect(snapAgent(office, MAIN)!.permission!.mode).toBeUndefined();
  });

  it('com um pedido parallel aberto no agente, o hook sai sem decidir (um cartão só), mesmo que o canal não diga que é dono', () => {
    const { registry } = setup();
    opened(registry.registerParallel(req()));
    expect(registry.register(codexHook())).toEqual({ skip: 'parallel' });
    expect(registry.size).toBe(1);
  });

  it('corrida: o hook chegou antes e espera; o registerParallel da mesma thread libera o hook (sai sem decidir) e o cartão vira parallel', async () => {
    // Arrange
    const { office, registry, sent, sink } = setup();
    registry.setParallelSink(sink);
    const hookId = registered(registry.register(codexHook()));
    const w = registry.wait(hookId, 25_000)!;

    // Act
    const id = opened(registry.registerParallel(req()));

    // Assert: o hook recebe "liberado" e o hook.mjs não imprime decisão nenhuma.
    const result = await w.result;
    expect(result).toEqual({ status: 'released', reason: 'replaced' });
    expect(hook.decisionOutput(result)).toBeUndefined();
    expect(registry.size).toBe(1);
    const a = snapAgent(office, MAIN)!;
    expect(a.permission).toMatchObject({ id, mode: 'parallel' });
    expect(a.permission!.queued).toBeUndefined();
    // A resposta do escritório vai pelo canal paralelo.
    expect(await registry.decide(id, { behavior: 'allow' })).toBe('ok');
    expect(sent).toEqual([[KEY, 'accept']]);
  });

  it('o hook de outra thread do mesmo agente não é liberado', async () => {
    const { office, registry } = setup();
    office.addSub({ id: SUB, parentId: MAIN, sessionId: CHILD, role: 'worker', background: false, startedAt: 0 });
    const subHook = registered(registry.register(codexHook({ agent_id: CHILD, agent_type: 'worker' })));
    opened(registry.registerParallel(req()));
    expect(registry.detail(subHook)).toBeDefined();
    expect(snapAgent(office, SUB)!.permission?.id).toBe(subHook);
  });
});

describe('forSession fora do canal paralelo', () => {
  it('parseDecision guarda forSession só com allow e true', () => {
    expect(parseDecision({ behavior: 'allow', forSession: true })).toEqual({ behavior: 'allow', forSession: true });
    expect(parseDecision({ behavior: 'allow', forSession: 'sim' })).toEqual({ behavior: 'allow' });
    expect(parseDecision({ behavior: 'deny', forSession: true })).toEqual({ behavior: 'deny' });
  });

  it('pedido do hook do Codex: unsupported; pedido do Claude Code: invalid', () => {
    const { office, registry } = setup();
    const codex = registered(registry.register(codexHook()));
    expect(registry.decide(codex, { behavior: 'allow', forSession: true })).toBe('unsupported');
    office.addMain({ id: 'acc:1', account: 'acc', sessionId: 'sess-1', cwd: '/p/loja', role: 'Agente principal', startedAt: 0, status: 'working' });
    const claude = registered(registry.register({ session_id: 'sess-1', tool_name: 'Bash', tool_input: { command: 'ls' } }));
    expect(registry.detail(claude)!.mode).toBeUndefined();
    expect(registry.decide(claude, { behavior: 'allow', forSession: true })).toBe('invalid');
    expect(registry.decide(claude, { behavior: 'allow' })).toBe('ok');
  });
});
