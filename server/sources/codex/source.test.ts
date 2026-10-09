// Integração da fonte do Codex: um CODEX_HOME temporário (rollouts e locks sintéticos), o AccountsService e o Office.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentInfo, Notice } from '../../../shared/types';
import { AccountsService } from '../../accounts/service';
import { setQuiet } from '../../log';
import { NameStore } from '../../model/names';
import { Office } from '../../model/office';
import { codexHome, R, SOURCES, threadId } from '../../test/codex-fixtures';
import { appendRaw, bigTurn, fakeLockProber } from '../../test/codex-fixtures-source';
import { readLocks } from './files';
import { CodexSource } from './source';

setQuiet(true);

const T = threadId(1);
const C = threadId(2);
const KEY = `.codex:${T}`;

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

/**
 * `locks`: como a sondagem vê os locks do fixture (arquivos vazios que ninguém trava). 'held' (padrão) = Windows/Linux
 * com a trava segura; 'exists' = macOS/Docker (só a existência, estado 'unknown'). `ctx.locks.set` muda uma thread.
 */
function setup(opts: { names?: string[]; noLocks?: boolean; locks?: 'held' | 'exists'; env?: (dirs: string[]) => NodeJS.ProcessEnv } = {}) {
  const locks = fakeLockProber(opts.locks === 'exists' ? 'exists' : 'win32');
  const homes = (opts.names ?? ['.codex']).map((n) => codexHome(n));
  const home = homes[0];
  cleanups.push(...homes.map((h) => h.cleanup));
  if (opts.noLocks) rmSync(join(home.dir, 'thread-writer-locks'), { recursive: true });
  let clock = Date.now();
  const now = () => clock;
  const late: { office?: Office } = {};
  const accounts = new AccountsService({ dirs: [], home: home.home, env: {}, now, onChange: () => late.office?.markDirty() });
  const office = new Office({
    names: new NameStore(null),
    version: 'teste',
    startedAt: clock,
    accounts: (s) => accounts.list(s),
    sources: () => [],
    accountName: (id) => accounts.find(id)?.detected.name,
    now,
  });
  late.office = office;
  const dirs = homes.map((h) => h.dir);
  const source = new CodexSource({ accounts, office, dirs, env: opts.env?.(dirs) ?? {}, home: home.home, now, watch: false, lockProber: locks.prober });
  // Para antes de apagar as pastas (nenhum ciclo agendado roda depois).
  cleanups.unshift(() => source.stop());
  const notices: Notice[] = [];
  return {
    home,
    homes,
    accounts,
    office,
    source,
    notices,
    locks,
    advance(ms: number) {
      clock += ms;
    },
    now,
    poll() {
      source.poll();
      office.tick();
      notices.push(...office.commit().notices);
    },
    agents(): AgentInfo[] {
      return office.commit().snapshot.agents;
    },
    agent(id = KEY): AgentInfo | undefined {
      return office.commit().snapshot.agents.find((a) => a.id === id);
    },
    hook(input: Record<string, unknown>, account?: string): boolean {
      return source.applyHookEvent(account, input);
    },
  };
}

describe('fonte do Codex: presença pelos locks', () => {
  it('lock + rollout: agente principal na sala do projeto, com título, modelo, branch, tokens e status', () => {
    const ctx = setup();
    const t0 = ctx.now();
    const path = ctx.home.rollout(T, [
      R.meta(T, { at: t0 - 50_000, cwd: '/projetos/loja', branch: 'feat/x' }),
      R.turnContext({ at: t0 - 49_000, model: 'gpt-teste-codex' }),
      R.taskStarted('turn1', t0 - 48_000),
      R.user(T, 'turn1', 'u1', 'Rode os testes da loja', t0 - 47_000),
      R.command(T, 'turn1', 'call_1', 'npm test', { at: t0 - 46_000, output: 'ok' }),
      R.tokens({ input: 2_000, cached: 1_500, output: 300, at: t0 - 45_000 }),
    ]);
    ctx.home.lock(T, t0 - 60_000);
    ctx.source.boot();
    const a = ctx.agent()!;
    expect(a).toMatchObject({
      kind: 'main',
      provider: 'codex',
      account: '.codex',
      sessionId: T,
      roomId: '/projetos/loja',
      role: 'Agente principal (Codex)',
      status: 'working',
      title: 'Rode os testes da loja',
      model: 'gpt-teste-codex',
      gitBranch: 'feat/x',
    });
    expect(a.stats).toMatchObject({ tokensIn: 2_000, tokensOut: 300, toolCalls: 1 });
    expect(a.activity?.text).toBe('Rodando testes');
    expect(ctx.source.sources()).toEqual([{ label: '.codex', provider: 'codex', path: ctx.home.dir, sessions: 1, ok: true }]);
    expect(ctx.source.transcriptPathOf(KEY)).toBe(path);
    expect(ctx.source.terminalParser(KEY)).toBeDefined();
    expect(ctx.accounts.list(new Map())[0]).toMatchObject({ id: '.codex', provider: 'codex', name: 'Codex', short: 'X' });

    // Turno concluído: ociosa.
    ctx.advance(1_000);
    ctx.home.append(path, [R.agent(T, 'turn1', 'a1', 'Todos passaram.', ctx.now()), R.taskComplete('turn1', ctx.now() + 1)]);
    ctx.poll();
    expect(ctx.agent()?.status).toBe('idle');
    expect(ctx.agent()?.activity?.kind).toBe('done');

    // Sem lock: fecha (depois da graça de 5 s do principal).
    ctx.home.unlock(T);
    ctx.poll();
    expect(ctx.agent()?.status).toBe('idle');
    ctx.advance(4_000);
    ctx.poll();
    expect(ctx.agent()?.status).toBe('idle');
    ctx.advance(1_000);
    ctx.poll();
    expect(ctx.agent()?.status).toBe('offline');
    expect(ctx.notices.some((n) => n.text.includes('encerrou'))).toBe(true);
  });

  it('lock rápido (manutenção) não vira sessão; o que persiste uns segundos, vira', () => {
    const ctx = setup();
    ctx.home.rollout(T, [R.meta(T, { at: ctx.now() - 3_600_000 }), R.user(T, 't', 'u', 'antiga', ctx.now() - 3_600_000)], { mtime: ctx.now() - 3_600_000 });
    ctx.source.boot();
    ctx.home.lock(T, ctx.now());
    ctx.poll();
    ctx.advance(1_000);
    ctx.poll();
    expect(ctx.agent()).toBeUndefined();
    ctx.home.unlock(T);
    ctx.advance(1_000);
    ctx.poll();
    expect(ctx.agent()).toBeUndefined();
    // Retomada de verdade: o lock fica.
    ctx.home.lock(T, ctx.now());
    ctx.poll();
    expect(ctx.agent()).toBeUndefined();
    ctx.advance(3_500);
    ctx.poll();
    expect(ctx.agent()?.status).toBe('idle');
  });

  it('só existência (macOS/Docker): lock velho de crash (última linha há mais de 12 h, sem hook) fica fora; escrita nova reabre', () => {
    const ctx = setup({ locks: 'exists' });
    const old = ctx.now() - 13 * 3600_000;
    const path = ctx.home.rollout(T, [R.meta(T, { at: old }), R.taskStarted('t', old), R.user(T, 't', 'u', 'oi', old)], { mtime: old });
    ctx.home.lock(T, old);
    ctx.source.boot();
    expect(ctx.agent()).toBeUndefined();
    ctx.advance(1_000);
    ctx.home.append(path, [R.taskStarted('t2', ctx.now()), R.user(T, 't2', 'u2', 'voltei', ctx.now())]);
    ctx.poll();
    expect(ctx.agent()).toMatchObject({ status: 'working' });
  });

  it('só existência (macOS/Docker): thread antigo retomado agora (lock novo, rollout parado há dias) aparece', () => {
    const ctx = setup({ locks: 'exists' });
    const old = ctx.now() - 3 * 86_400_000;
    ctx.home.rollout(T, [R.meta(T, { at: old, cwd: '/projetos/velho' }), R.user(T, 't', 'u', 'antigo', old), R.taskComplete('t', old + 10)], { mtime: old });
    ctx.home.lock(T, ctx.now() - 30_000);
    ctx.source.boot();
    expect(ctx.agent()).toMatchObject({ roomId: '/projetos/velho', status: 'idle', title: 'antigo' });
    // Lock sem rollout esquecido há mais de 12 h (crash antes do primeiro prompt): fora.
    ctx.home.lock(C, ctx.now() - 13 * 3600_000);
    ctx.poll();
    expect(ctx.agent(`.codex:${C}`)).toBeUndefined();
  });

  it('lock sem rollout (CLI aberta, ainda sem mensagem): fica fora até o projeto aparecer e entra direto na sala dele', () => {
    const ctx = setup();
    ctx.home.lock(T, ctx.now() - 20_000);
    ctx.source.boot();
    // O lock não diz a pasta: sem projeto, sem sala (nada de sala provisória).
    expect(ctx.agent()).toBeUndefined();
    expect(ctx.office.commit().snapshot.rooms).toEqual([]);
    ctx.home.rollout(T, [R.meta(T, { at: ctx.now(), cwd: '/projetos/api' }), R.taskStarted('t1', ctx.now()), R.user(T, 't1', 'u1', 'Comece', ctx.now())]);
    ctx.advance(3_100);
    ctx.poll();
    expect(ctx.agent()).toMatchObject({ roomId: '/projetos/api', status: 'working', title: 'Comece' });
    const rooms = ctx.office.commit().snapshot.rooms.map((r) => r.id);
    expect(rooms).toEqual(['/projetos/api']);
  });

  it('lock sem rollout: um hook que diz o projeto faz o agente entrar na hora, já na sala certa', () => {
    const ctx = setup();
    ctx.source.boot();
    ctx.home.lock(T, ctx.now() - 60_000);
    ctx.poll();
    expect(ctx.agent()).toBeUndefined();
    expect(ctx.hook({ hook_event_name: 'SessionStart', session_id: T, cwd: '/projetos/api', transcript_path: null, model: 'gpt-teste-codex', source: 'startup' })).toBe(true);
    expect(ctx.agent()).toMatchObject({ roomId: '/projetos/api', status: 'idle', provider: 'codex' });
  });

  it('threads internos (guardian, revisão) ficam fora', () => {
    const ctx = setup();
    const at = ctx.now() - 5_000;
    ctx.home.rollout(T, [R.meta(T, { at, source: SOURCES.guardian() }), R.taskStarted('t', at)]);
    ctx.home.rollout(C, [R.meta(C, { at, source: SOURCES.review() }), R.taskStarted('t', at)]);
    ctx.home.lock(T, at);
    ctx.home.lock(C, at);
    ctx.source.boot();
    expect(ctx.agents()).toEqual([]);
  });

  it('sem thread-writer-locks/: presença pelo rollout modificado nos últimos 30 min', () => {
    const ctx = setup({ noLocks: true });
    const old = ctx.now() - 2 * 3600_000;
    ctx.home.rollout(T, [R.meta(T, { at: ctx.now() - 60_000 }), R.user(T, 't', 'u', 'recente', ctx.now() - 60_000)]);
    ctx.home.rollout(C, [R.meta(C, { at: old }), R.user(C, 't', 'u', 'velha', old)], { mtime: old });
    ctx.source.boot();
    expect(ctx.agents().map((a) => a.id)).toEqual([KEY]);
  });
});

describe('fonte do Codex: sondagem da trava, leitura até a fronteira e mtime fora das decisões', () => {
  it('readLocks devolve o estado da sondagem de cada lock (o .coordination.lock fica de fora); sem a pasta, null', () => {
    const ctx = setup();
    ctx.home.lock(T, ctx.now() - 60_000);
    ctx.home.lock(C, ctx.now() - 30_000);
    writeFileSync(join(ctx.home.dir, 'thread-writer-locks', '.coordination.lock'), '');
    ctx.locks.set(C, 'free');
    const locks = readLocks(ctx.home.dir, ctx.locks.prober);
    expect(Object.fromEntries([...locks!].map(([id, l]) => [id, l.state]))).toEqual({ [T]: 'held', [C]: 'free' });
    rmSync(join(ctx.home.dir, 'thread-writer-locks'), { recursive: true });
    expect(readLocks(ctx.home.dir, ctx.locks.prober)).toBeNull();
  });

  it('trava segura (held): sessão aberta há mais de 12 h, com o rollout e o mtime parados há 13 h, continua presente', () => {
    const ctx = setup();
    const old = ctx.now() - 13 * 3600_000;
    ctx.home.rollout(T, [R.meta(T, { at: old, cwd: '/projetos/desktop' }), R.taskStarted('t', old), R.user(T, 't', 'u', 'oi', old), R.taskComplete('t', old + 1_000)], { mtime: old + 1_000 });
    ctx.home.lock(T, old);
    ctx.source.boot();
    expect(ctx.agent()).toMatchObject({ roomId: '/projetos/desktop', status: 'idle' });
    ctx.advance(60_000);
    ctx.poll();
    expect(ctx.agent()?.status).toBe('idle');
  });

  it('trava órfã (free: o arquivo existe e ninguém segura) sai como lock sumido, depois da graça de 5 s do principal', () => {
    const ctx = setup();
    const at = ctx.now() - 60_000;
    ctx.home.rollout(T, [R.meta(T, { at }), R.taskStarted('t', at), R.user(T, 't', 'u', 'oi', at)]);
    ctx.home.rollout(C, [R.meta(C, { at }), R.user(C, 't', 'u', 'órfã desde o boot', at)]);
    ctx.home.lock(T, at);
    ctx.home.lock(C, at);
    ctx.locks.set(C, 'free');
    ctx.source.boot();
    // Órfã no boot: nem entra.
    expect(ctx.agent(`.codex:${C}`)).toBeUndefined();
    expect(ctx.agent()?.status).toBe('working');
    ctx.locks.set(T, 'free');
    ctx.poll();
    ctx.advance(4_000);
    ctx.poll();
    expect(ctx.agent()?.status).toBe('working');
    ctx.advance(1_000);
    ctx.poll();
    expect(ctx.agent()?.status).toBe('offline');
    expect(ctx.notices.some((n) => n.text.includes('encerrou'))).toBe(true);
  });

  it('trava segura e turno aberto: 31 min sem escrever continua trabalhando (sem o "concluiu" falso)', () => {
    const ctx = setup();
    const at = ctx.now() - 60_000;
    ctx.home.rollout(T, [R.meta(T, { at }), R.taskStarted('t', at), R.user(T, 't', 'u', 'rode a migração longa', at)]);
    ctx.home.lock(T, at);
    ctx.source.boot();
    expect(ctx.agent()?.status).toBe('working');
    ctx.advance(31 * 60_000);
    ctx.poll();
    expect(ctx.agent()?.status).toBe('working');
    expect(ctx.notices.some((n) => n.text.includes('concluiu'))).toBe(false);
  });

  it('trava segura: boot com o turno aberto e a última linha de 40 min atrás sai trabalhando', () => {
    const ctx = setup();
    const at = ctx.now() - 40 * 60_000;
    ctx.home.rollout(T, [R.meta(T, { at }), R.taskStarted('t', at), R.user(T, 't', 'u', 'compile tudo', at)], { mtime: at });
    ctx.home.lock(T, at);
    ctx.source.boot();
    expect(ctx.agent()?.status).toBe('working');
  });

  it('só existência (macOS/Docker): sem como saber se o processo vive, o corte de 30 min sem escrita continua (no boot e ao vivo)', () => {
    const ctx = setup({ locks: 'exists' });
    const old = ctx.now() - 40 * 60_000;
    const at = ctx.now() - 60_000;
    ctx.home.rollout(T, [R.meta(T, { at: old }), R.taskStarted('t', old), R.user(T, 't', 'u', 'compile tudo', old)], { mtime: old });
    ctx.home.rollout(C, [R.meta(C, { at }), R.taskStarted('t', at), R.user(C, 't', 'u', 'rode a migração', at)]);
    ctx.home.lock(T, old);
    ctx.home.lock(C, at);
    ctx.source.boot();
    expect(ctx.agent()?.status).toBe('idle');
    expect(ctx.agent(`.codex:${C}`)?.status).toBe('working');
    ctx.advance(31 * 60_000);
    ctx.poll();
    expect(ctx.agent(`.codex:${C}`)?.status).toBe('idle');
  });

  it('só existência: lock de 13 h com o turno aberto e a última linha de 13 h fica fora, mesmo com o mtime de agora', () => {
    const ctx = setup({ locks: 'exists' });
    const old = ctx.now() - 13 * 3600_000;
    // O mtime é o de agora (o arquivo acabou de ser gravado): não pode segurar o órfão.
    ctx.home.rollout(T, [R.meta(T, { at: old }), R.taskStarted('t', old), R.user(T, 't', 'u', 'oi', old + 1_000)]);
    ctx.home.lock(T, old);
    ctx.source.boot();
    expect(ctx.agent()).toBeUndefined();
    ctx.advance(1_000);
    ctx.poll();
    expect(ctx.agent()).toBeUndefined();
  });

  it('só existência: lock de 13 h com o mtime parado há 13 h e a última linha de 20 min continua presente', () => {
    const ctx = setup({ locks: 'exists' });
    const old = ctx.now() - 13 * 3600_000;
    const recent = ctx.now() - 20 * 60_000;
    ctx.home.rollout(
      T,
      [
        R.meta(T, { at: old, cwd: '/projetos/desktop' }),
        R.taskStarted('t1', old),
        R.taskComplete('t1', old + 1_000),
        R.taskStarted('t2', recent - 1_000),
        R.user(T, 't2', 'u2', 'e agora?', recent - 1_000),
        R.taskComplete('t2', recent),
      ],
      { mtime: old },
    );
    ctx.home.lock(T, old);
    ctx.source.boot();
    expect(ctx.agent()).toMatchObject({ roomId: '/projetos/desktop', status: 'idle' });
  });

  it('boot no meio de um turno de mais de 1 MB: principal e subagente trabalhando (a leitura vai até o task_started)', async () => {
    const ctx = setup();
    const start = ctx.now() - 20 * 60_000;
    // Última linha uns 17 min atrás: a regra do legacy (escreveu há menos de 90 s) não salvaria.
    const parent = bigTurn(T, 'p1', 1_200_000, start + 2_000);
    ctx.home.rollout(T, [R.meta(T, { at: start, cwd: '/projetos/loja' }), R.taskStarted('p1', start), R.user(T, 'p1', 'u', 'Refatore o módulo de pedidos', start + 1_000), ...parent]);
    const sub = bigTurn(C, 's1', 1_100_000, start + 5_000);
    ctx.home.rollout(C, [
      R.meta(C, { at: start + 3_000, sessionId: T, source: SOURCES.sub(T, 'worker') }),
      R.taskStarted('s1', start + 3_000),
      R.user(C, 's1', 'su', 'Ajuste os testes de pedidos', start + 4_000),
      ...sub,
    ]);
    ctx.home.lock(T, start);
    ctx.home.lock(C, start + 3_000);
    ctx.source.boot();
    expect(ctx.agent()).toMatchObject({ status: 'working', title: 'Refatore o módulo de pedidos', roomId: '/projetos/loja' });
    expect(ctx.agent(`.codex:${C}`)).toMatchObject({ kind: 'sub', parentId: KEY, status: 'working' });
    // O começo (antes da varredura) chega em segundo plano sem contar nada duas vezes.
    await ctx.source.idle();
    expect(ctx.agent()?.stats.toolCalls).toBe(parent.length);
  });

  it('sessão ociosa com rollout de mais de 1 MB: o boot lê pelo menos 1 MB do fim (os números do último turno vêm na hora)', async () => {
    const ctx = setup();
    const start = ctx.now() - 30 * 60_000;
    const turn = bigTurn(T, 't1', 1_100_000, start + 2_000);
    ctx.home.rollout(T, [
      R.meta(T, { at: start }),
      R.taskStarted('t1', start),
      R.user(T, 't1', 'u', 'Revise o relatório', start + 1_000),
      ...turn,
      R.tokens({ input: 5_000, output: 700, at: ctx.now() - 60_000 }),
      R.taskComplete('t1', ctx.now() - 59_000),
    ]);
    ctx.home.lock(T, start);
    ctx.source.boot();
    // Parar na fronteira mais recente (o task_complete do fim) deixaria os tokens em 0: o começo não os soma.
    expect(ctx.agent()).toMatchObject({ status: 'idle', stats: { tokensIn: 5_000, tokensOut: 700 } });
    await ctx.source.idle();
    expect(ctx.agent()?.stats).toMatchObject({ tokensIn: 5_000, tokensOut: 700, toolCalls: turn.length });
  });

  it('attach com a última linha pela metade: sem exceção, e a atividade sai uma vez só quando a linha completa chega', () => {
    const ctx = setup();
    const at = ctx.now() - 10_000;
    const path = ctx.home.rollout(T, [
      R.meta(T, { at }),
      R.taskStarted('t1', at),
      R.user(T, 't1', 'u1', 'Gere o build', at + 1_000),
      R.command(T, 't1', 'call_1', 'npm test', { at: at + 2_000, output: 'ok' }),
    ]);
    const last = R.command(T, 't1', 'call_2', 'npm run build', { at: ctx.now() - 1_000, output: 'pronto' });
    const cut = Math.floor(last.length / 2);
    appendRaw(path, last.slice(0, cut));
    ctx.home.lock(T, at);
    expect(() => ctx.source.boot()).not.toThrow();
    const build = () => ctx.office.detail(KEY)!.history.filter((a) => a.id === `${KEY}#call_2`);
    expect(ctx.agent()?.status).toBe('working');
    expect(ctx.office.detail(KEY)!.history.some((a) => a.id === `${KEY}#call_1`)).toBe(true);
    expect(build()).toHaveLength(0);
    ctx.advance(500);
    ctx.poll();
    expect(build()).toHaveLength(0);
    appendRaw(path, `${last.slice(cut)}\n`);
    ctx.advance(500);
    ctx.poll();
    expect(build()).toHaveLength(1);
    ctx.advance(500);
    ctx.poll();
    expect(build()).toHaveLength(1);
  });

  it('sem thread-writer-locks/: o mtime só escolhe o que abrir; rollout com a última linha de 2 h fica fora até crescer', () => {
    const ctx = setup({ noLocks: true });
    const old = ctx.now() - 2 * 3600_000;
    // mtime de agora, conteúdo de 2 h atrás.
    const path = ctx.home.rollout(T, [R.meta(T, { at: old }), R.user(T, 't', 'u', 'velha', old)]);
    ctx.source.boot();
    expect(ctx.agent()).toBeUndefined();
    ctx.advance(1_000);
    ctx.home.append(path, [R.taskStarted('t2', ctx.now()), R.user(T, 't2', 'u2', 'voltei', ctx.now())]);
    ctx.poll();
    expect(ctx.agent()).toMatchObject({ status: 'working' });
  });
});

describe('fonte do Codex: subagentes', () => {
  it('subagente entra como sub do pai enquanto trabalha e entrega ao concluir o turno', () => {
    const ctx = setup();
    const at = ctx.now() - 10_000;
    ctx.home.rollout(T, [R.meta(T, { at }), R.taskStarted('p1', at), R.user(T, 'p1', 'u', 'Investigue com ajuda', at)]);
    const sub = ctx.home.rollout(C, [
      R.meta(C, { at: at + 1_000, sessionId: T, source: SOURCES.sub(T, 'explorer') }),
      R.taskStarted('s1', at + 1_000),
      R.user(C, 's1', 'su', 'Procure onde o login é validado', at + 1_100),
    ]);
    ctx.home.lock(T, at);
    ctx.home.lock(C, at + 1_000);
    ctx.source.boot();
    expect(ctx.agent(`.codex:${C}`)).toMatchObject({
      kind: 'sub',
      provider: 'codex',
      parentId: KEY,
      sessionId: C,
      role: 'Explorer',
      title: 'Procure onde o login é validado',
      status: 'working',
      roomId: '/projetos/loja',
    });
    ctx.advance(1_000);
    ctx.home.append(sub, [R.agent(C, 's1', 'sa', 'Está em auth.ts', ctx.now()), R.taskComplete('s1', ctx.now() + 1)]);
    ctx.poll();
    expect(ctx.agent(`.codex:${C}`)?.status).toBe('done');
    expect(ctx.notices.some((n) => n.text.includes('entregou'))).toBe(true);
    // Volta a trabalhar (o pai mandou outra tarefa).
    ctx.advance(1_000);
    ctx.home.append(sub, [R.taskStarted('s2', ctx.now())]);
    ctx.poll();
    expect(ctx.agent(`.codex:${C}`)?.status).toBe('working');
    // Lock sumiu: entrega e sai.
    ctx.home.unlock(C);
    ctx.poll();
    expect(ctx.agent(`.codex:${C}`)?.status).toBe('working');
    ctx.advance(2_000);
    ctx.poll();
    expect(ctx.agent(`.codex:${C}`)?.status).toBe('done');
    expect(ctx.agent()?.status).toBe('working');
  });

  it('subagente já ocioso ao subir não aparece', () => {
    const ctx = setup();
    const at = ctx.now() - 10_000;
    ctx.home.rollout(T, [R.meta(T, { at })]);
    ctx.home.rollout(C, [R.meta(C, { at, sessionId: T, source: SOURCES.sub(T) }), R.taskStarted('s', at), R.taskComplete('s', at + 10)]);
    ctx.home.lock(T, at);
    ctx.home.lock(C, at);
    ctx.source.boot();
    expect(ctx.agents().map((a) => a.id)).toEqual([KEY]);
  });
});

describe('fonte do Codex: uso do plano', () => {
  it('o rate_limits mais recente entre as sessões vai para a conta, com o plano; sem cota', () => {
    const ctx = setup();
    const at = ctx.now() - 60_000;
    ctx.home.rollout(T, [R.meta(T, { at }), R.tokens({ input: 1, output: 1, at, rateLimits: { primary: { used: 30 }, plan: 'pro' } })]);
    ctx.home.rollout(C, [R.meta(C, { at: at - 1_000 }), R.tokens({ input: 1, output: 1, at: at - 1_000, rateLimits: { primary: { used: 99 } } })]);
    ctx.home.lock(T, at);
    ctx.home.lock(C, at);
    ctx.source.boot();
    const acc = ctx.accounts.list(new Map())[0];
    expect(acc).toMatchObject({ id: '.codex', plan: 'Pro', usageStatus: 'ok', usage: { source: 'codex', fetchedAt: at, fiveHour: { utilization: 30 } } });
    const path = ctx.home.rollout(T, []);
    ctx.home.append(path, [R.tokens({ input: 1, output: 1, at: ctx.now(), rateLimits: { primary: null, secondary: null, reached: 'workspace_owner_credits_depleted' } })]);
    ctx.poll();
    expect(ctx.accounts.list(new Map())[0].usage).toEqual({ source: 'codex', fetchedAt: ctx.now(), noQuota: true });
  });

  it('conta sem sessão aberta: o uso do último rollout (com a idade dele)', () => {
    const ctx = setup();
    const at = ctx.now() - 2 * 3600_000;
    ctx.home.rollout(T, [R.meta(T, { at }), R.tokens({ input: 1, output: 1, at, rateLimits: { plan: 'plus' } })], { mtime: at });
    ctx.source.boot();
    expect(ctx.agents()).toEqual([]);
    expect(ctx.accounts.list(new Map())[0]).toMatchObject({ plan: 'Plus', usageStatus: 'stale', usage: { fetchedAt: at } });
  });

  it('conta sem sessão aberta: pula o rollout mais recente sem números e acha o uso numa pasta de data antiga', () => {
    const ctx = setup();
    const at = ctx.now() - 5 * 3600_000;
    // Sessão retomada: o arquivo fica na pasta da criação (antiga), mas foi mexido há pouco.
    ctx.home.rollout(T, [R.meta(T, { at }), R.tokens({ input: 1, output: 1, at, rateLimits: { plan: 'team' } })], { date: '2026/01/02', mtime: at });
    // Arquivada depois, sem nenhum token_count: é a mais recente, mas não diz nada do uso.
    const T3 = threadId(3);
    ctx.home.rollout(T3, [R.meta(T3, { at: at + 60_000 })], { archived: true, mtime: at + 60_000 });
    ctx.source.boot();
    expect(ctx.accounts.list(new Map())[0]).toMatchObject({ plan: 'Team', usageStatus: 'stale', usage: { source: 'codex', fetchedAt: at } });
  });
});

describe('fonte do Codex: eventos de hook', () => {
  const ev = (name: string, extra: Record<string, unknown> = {}) => ({
    hook_event_name: name,
    session_id: T,
    cwd: '/projetos/api',
    transcript_path: null,
    model: 'gpt-teste-codex',
    permission_mode: 'default',
    turn_id: 'turn1',
    ...extra,
  });

  it('SessionStart: o agente aparece já, na sala do cwd do evento, antes do lock e do rollout', () => {
    const ctx = setup();
    ctx.source.boot();
    expect(ctx.hook(ev('SessionStart', { source: 'startup' }))).toBe(true);
    expect(ctx.agent()).toMatchObject({ roomId: '/projetos/api', provider: 'codex', status: 'idle' });
  });

  it('prompt, ferramenta (sem duplicar com o item concluído), aprovação e fim do turno', () => {
    const ctx = setup();
    ctx.source.boot();
    expect(ctx.hook(ev('UserPromptSubmit', { prompt: 'rode os testes' }))).toBe(true);
    expect(ctx.agent()?.status).toBe('working');
    expect(ctx.hook(ev('PreToolUse', { tool_name: 'Bash', tool_use_id: 'call_7', tool_input: { command: 'npm test' } }))).toBe(true);
    expect(ctx.agent()?.activity).toMatchObject({ id: `${KEY}#call_7`, text: 'Rodando testes', tool: 'Bash' });
    expect(ctx.hook(ev('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'npm test', description: 'x' } }))).toBe(true);
    expect(ctx.agent()).toMatchObject({ status: 'waiting', waitingFor: 'aprovar um comando' });
    // O rollout aparece com a linha antiga do turno: não desfaz a espera.
    ctx.advance(10);
    const path = ctx.home.rollout(T, [R.meta(T, { at: ctx.now() - 5_000, cwd: '/projetos/api' }), R.taskStarted('turn1', ctx.now() - 4_000)]);
    ctx.home.lock(T, ctx.now() - 5_000);
    ctx.advance(3_100);
    ctx.poll();
    expect(ctx.agent()?.status).toBe('waiting');
    // Aprovou no terminal: o comando concluiu (mesmo call_id: não duplica a atividade).
    ctx.home.append(path, [R.command(T, 'turn1', 'call_7', 'npm test', { at: ctx.now(), output: 'ok' })]);
    ctx.poll();
    expect(ctx.agent()?.status).toBe('working');
    const recent = ctx.office.detail(KEY)!.history.filter((a) => a.id === `${KEY}#call_7`);
    expect(recent).toHaveLength(1);
    expect(ctx.hook(ev('PostToolUse', { tool_name: 'Bash', tool_use_id: 'call_7', tool_input: {}, tool_response: {} }))).toBe(true);
    expect(ctx.hook(ev('Stop', { stop_hook_active: false, last_assistant_message: 'ok' }))).toBe(true);
    expect(ctx.agent()?.status).toBe('idle');
  });

  it('apply_patch e MCP: as mesmas atividades do Claude Code', () => {
    const ctx = setup();
    ctx.source.boot();
    ctx.hook(ev('PreToolUse', { tool_name: 'apply_patch', tool_use_id: 'c1', tool_input: { command: '*** Begin Patch\n*** Update File: src/app.ts\n@@\n-a\n+b\n*** End Patch' } }));
    expect(ctx.agent()?.activity).toMatchObject({ text: 'Editando app.ts', tool: 'Edit' });
    ctx.hook(ev('PreToolUse', { tool_name: 'mcp__github__merge_pull_request', tool_use_id: 'c2', tool_input: { pullNumber: 3 } }));
    expect(ctx.agent()?.activity).toMatchObject({ text: 'GitHub: merge pull request', tool: 'mcp__github__merge_pull_request' });
  });

  it('agent_id vs session_id: o evento de subagente vai para o filho, que entra como sub do pai', () => {
    const ctx = setup();
    ctx.source.boot();
    ctx.hook(ev('SessionStart'));
    expect(ctx.hook(ev('SubagentStart', { agent_id: C, agent_type: 'worker' }))).toBe(true);
    expect(ctx.agent(`.codex:${C}`)).toMatchObject({ kind: 'sub', parentId: KEY, role: 'Worker', status: 'working' });
    expect(ctx.hook(ev('PreToolUse', { agent_id: C, agent_type: 'worker', tool_name: 'Bash', tool_use_id: 'c9', tool_input: { command: 'ls' } }))).toBe(true);
    expect(ctx.agent(`.codex:${C}`)?.activity?.id).toBe(`.codex:${C}#c9`);
    expect(ctx.agent()?.activity?.id).not.toBe(`${KEY}#c9`);
    expect(ctx.hook(ev('PermissionRequest', { agent_id: C, tool_name: 'Bash', tool_input: { command: 'rm x' } }))).toBe(true);
    expect(ctx.agent(`.codex:${C}`)?.status).toBe('waiting');
    expect(ctx.agent()?.status).not.toBe('waiting');
    expect(ctx.hook(ev('SubagentStop', { agent_id: C, agent_type: 'worker', stop_hook_active: false, agent_transcript_path: null }))).toBe(true);
    expect(ctx.agent(`.codex:${C}`)?.status).toBe('done');
  });

  it('evento desconhecido, sessão inválida ou sem conta que case: false', () => {
    const ctx = setup({ names: ['.codex', '.codex-trabalho'] });
    ctx.source.boot();
    expect(ctx.hook(ev('Desconhecido'))).toBe(false);
    expect(ctx.hook(ev('SessionStart', { session_id: 'nao-e-uuid' }))).toBe(false);
    // Duas contas e nada que diga qual: não casa.
    expect(ctx.hook(ev('SessionStart'))).toBe(false);
    // Pelo id da conta, pela pasta ou pelo transcript_path.
    expect(ctx.hook(ev('SessionStart'), '.codex-trabalho')).toBe(true);
    expect(ctx.agent(`.codex-trabalho:${T}`)?.account).toBe('.codex-trabalho');
    expect(ctx.hook(ev('SessionStart', { session_id: C }), ctx.homes[0].dir)).toBe(true);
    expect(ctx.agent(`.codex:${C}`)).toBeDefined();
    const T3 = threadId(3);
    const tp = join(ctx.homes[1].dir, 'sessions', '2026', '10', '09', `rollout-2026-10-09T09-00-00-${T3}.jsonl`);
    expect(ctx.hook(ev('SessionStart', { session_id: T3, transcript_path: tp }))).toBe(true);
    expect(ctx.agent(`.codex-trabalho:${T3}`)).toBeDefined();
    // SessionEnd de sessão que ninguém conhece: false.
    expect(ctx.hook(ev('SessionEnd', { session_id: threadId(4), reason: 'other' }), '.codex')).toBe(false);
  });

  it('subagente cujo primeiro evento é um pedido de aprovação entra já esperando', () => {
    const ctx = setup();
    ctx.source.boot();
    ctx.hook(ev('SessionStart'));
    expect(ctx.hook(ev('PermissionRequest', { agent_id: C, agent_type: 'worker', tool_name: 'Bash', tool_input: { command: 'rm -rf build' } }))).toBe(true);
    expect(ctx.agent(`.codex:${C}`)).toMatchObject({ kind: 'sub', parentId: KEY, status: 'waiting', waitingFor: 'aprovar um comando' });
  });

  it('Docker: o hook roda no host e casa a conta pela pasta do HOST (configDir) ou pelo transcript_path de lá', () => {
    const ctx = setup({
      names: ['.codex', '.codex-b'],
      env: (dirs) => ({
        HABBLAUD_ACCOUNTS: JSON.stringify([
          { id: '.codex', provider: 'codex', configDir: '/Users/host/.codex', mountDir: dirs[0], short: 'CX', name: 'Codex CX', color: '#111111' },
          { id: '.codex-b', provider: 'codex', configDir: '/Users/host/.codex-b', mountDir: dirs[1], short: 'CB', name: 'Codex CB', color: '#222222' },
        ]),
      }),
    });
    ctx.source.boot();
    expect(ctx.accounts.list(new Map()).map((a) => [a.id, a.configDir, a.short])).toEqual([
      ['.codex', '/Users/host/.codex', 'CX'],
      ['.codex-b', '/Users/host/.codex-b', 'CB'],
    ]);
    expect(ctx.source.sources().map((s) => s.path)).toEqual(['/Users/host/.codex', '/Users/host/.codex-b']);
    expect(ctx.hook(ev('SessionStart'), '/Users/host/.codex-b')).toBe(true);
    expect(ctx.agent(`.codex-b:${T}`)).toBeDefined();
    const tp = `/Users/host/.codex/sessions/2026/10/09/rollout-2026-10-09T09-00-00-${C}.jsonl`;
    expect(ctx.hook(ev('SessionStart', { session_id: C, transcript_path: tp }))).toBe(true);
    expect(ctx.agent(`.codex:${C}`)).toBeDefined();
  });

  it('a presença do hook dura 60 s sem lock; SessionEnd fecha', () => {
    const ctx = setup();
    ctx.source.boot();
    ctx.hook(ev('SessionStart'));
    ctx.advance(30_000);
    ctx.poll();
    expect(ctx.agent()?.status).toBe('idle');
    ctx.advance(31_000);
    ctx.poll();
    ctx.advance(5_000);
    ctx.poll();
    expect(ctx.agent()?.status).toBe('offline');
    // De novo, agora com lock: SessionEnd fecha quando o lock some (ou depois de 5 s).
    ctx.advance(30_000);
    ctx.poll();
    ctx.hook(ev('SessionStart'));
    ctx.home.lock(T, ctx.now() - 10_000);
    ctx.poll();
    expect(ctx.agent()?.status).toBe('idle');
    expect(ctx.hook(ev('SessionEnd', { reason: 'other' }))).toBe(true);
    ctx.poll();
    expect(ctx.agent()?.status).toBe('idle');
    ctx.advance(6_000);
    ctx.poll();
    expect(ctx.agent()?.status).toBe('offline');
  });

  it('Docker sem a pasta de locks montada: o hook dá presença; sem eventos por 60 s, sai', () => {
    const ctx = setup({ noLocks: true });
    ctx.source.boot();
    ctx.hook(ev('UserPromptSubmit', { prompt: 'x' }));
    expect(ctx.agent()?.status).toBe('working');
    ctx.advance(61_000);
    ctx.poll();
    ctx.advance(5_000);
    ctx.poll();
    expect(ctx.agent()?.status).toBe('offline');
  });
});

describe('fonte do Codex: parsed_cmd reclassifica o comando que já estava no escritório', () => {
  /** CommandExecution do pwsh com o parsed_cmd dado (o R.command grava sempre `zsh -lc` e parsed unknown). */
  function execParsed(id: string, script: string, parsed: unknown[], at: number): string {
    const j = JSON.parse(R.command(T, 'turn1', id, script, { at, output: 'ok' }));
    j.payload.item.command = ['pwsh.exe', '-Command', script];
    j.payload.item.parsed_cmd = parsed;
    return JSON.stringify(j);
  }
  const read = [{ type: 'read', cmd: 'Get-Content src/soma.ts', name: 'soma.ts', path: 'src/soma.ts' }];
  const ofCall = (ctx: ReturnType<typeof setup>) => ctx.office.detail(KEY)!.history.filter((a) => a.id === `${KEY}#call_9`);

  it('ao vivo: function_call exec_command e depois o CommandExecution de mesmo id viram uma leitura, sem duplicar', () => {
    const ctx = setup();
    const t0 = ctx.now();
    const path = ctx.home.rollout(T, [R.meta(T, { at: t0 - 5_000, cwd: '/projetos/loja' }), R.taskStarted('turn1', t0 - 4_000)]);
    ctx.home.lock(T, t0 - 5_000);
    ctx.source.boot();
    ctx.home.append(path, [R.functionCall('call_9', 'exec_command', { cmd: 'Get-Content src/soma.ts', workdir: '/projetos/loja' }, ctx.now())]);
    ctx.poll();
    expect(ctx.agent()?.activity).toMatchObject({ id: `${KEY}#call_9`, kind: 'run' });
    ctx.advance(1_000);
    ctx.home.append(path, [execParsed('call_9', 'Get-Content src/soma.ts', read, ctx.now())]);
    ctx.poll();
    expect(ctx.agent()?.activity).toMatchObject({ id: `${KEY}#call_9`, kind: 'read', text: 'Lendo soma.ts', tool: 'Bash' });
    expect(ofCall(ctx)).toHaveLength(1);
    expect(ofCall(ctx)[0]).toMatchObject({ kind: 'read', at: t0 });
    expect(ctx.office.recentFeed(50).filter((f) => f.id === `${KEY}#call_9`)).toHaveLength(1);
  });

  it('carga inicial (backlog): a mesma sequência já gravada também termina como leitura', () => {
    const ctx = setup();
    const t0 = ctx.now();
    ctx.home.rollout(T, [
      R.meta(T, { at: t0 - 5_000, cwd: '/projetos/loja' }),
      R.taskStarted('turn1', t0 - 4_000),
      R.functionCall('call_9', 'exec_command', { cmd: 'Get-Content src/soma.ts' }, t0 - 3_000),
      execParsed('call_9', 'Get-Content src/soma.ts', read, t0 - 2_000),
    ]);
    ctx.home.lock(T, t0 - 5_000);
    ctx.source.boot();
    expect(ofCall(ctx)).toHaveLength(1);
    expect(ofCall(ctx)[0]).toMatchObject({ kind: 'read', text: 'Lendo soma.ts' });
  });

  it('com o hook: PreToolUse chega antes do rollout e o item concluído ainda reclassifica', () => {
    const ctx = setup();
    ctx.source.boot();
    ctx.hook({ hook_event_name: 'SessionStart', session_id: T, cwd: '/projetos/loja', transcript_path: null, model: 'gpt-teste-codex', source: 'startup' });
    ctx.hook({ hook_event_name: 'PreToolUse', session_id: T, cwd: '/projetos/loja', transcript_path: null, turn_id: 'turn1', tool_name: 'Bash', tool_use_id: 'call_9', tool_input: { command: 'Get-Content src/soma.ts' } });
    expect(ctx.agent()?.activity).toMatchObject({ id: `${KEY}#call_9`, kind: 'run' });
    ctx.advance(10);
    const path = ctx.home.rollout(T, [R.meta(T, { at: ctx.now() - 5_000, cwd: '/projetos/loja' }), R.taskStarted('turn1', ctx.now() - 4_000)]);
    ctx.home.lock(T, ctx.now() - 5_000);
    ctx.advance(3_100);
    ctx.poll();
    ctx.home.append(path, [R.functionCall('call_9', 'exec_command', { cmd: 'Get-Content src/soma.ts' }, ctx.now()), execParsed('call_9', 'Get-Content src/soma.ts', read, ctx.now() + 1)]);
    ctx.poll();
    expect(ctx.agent()?.activity).toMatchObject({ id: `${KEY}#call_9`, kind: 'read', text: 'Lendo soma.ts' });
    expect(ofCall(ctx)).toHaveLength(1);
  });

  it('comando sem reclassificação (parsed unknown) continua com a atividade que chegou primeiro', () => {
    const ctx = setup();
    const t0 = ctx.now();
    const path = ctx.home.rollout(T, [R.meta(T, { at: t0 - 5_000, cwd: '/projetos/loja' }), R.taskStarted('turn1', t0 - 4_000)]);
    ctx.home.lock(T, t0 - 5_000);
    ctx.source.boot();
    ctx.home.append(path, [R.functionCall('call_9', 'exec_command', { cmd: 'npm test' }, ctx.now())]);
    ctx.poll();
    const first = ofCall(ctx)[0];
    ctx.advance(1_000);
    ctx.home.append(path, [execParsed('call_9', 'npm test', [{ type: 'unknown', cmd: 'npm test' }], ctx.now())]);
    ctx.poll();
    expect(ofCall(ctx)).toEqual([first]);
  });
});

describe('fonte do Codex: contas', () => {
  it('duas contas: nomes "Codex X", letras e cores sem colidir; ids devolvidos pelo AccountsService', () => {
    const ctx = setup({ names: ['.codex', '.codex-trabalho'] });
    const list = ctx.accounts.list(new Map());
    expect(list.map((a) => [a.id, a.provider, a.short, a.name])).toEqual([
      ['.codex', 'codex', 'X', 'Codex X'],
      ['.codex-trabalho', 'codex', 'T', 'Codex T'],
    ]);
    expect(new Set(list.map((a) => a.color)).size).toBe(2);
    expect(ctx.source.accountEntries().map((e) => e.id)).toEqual(['.codex', '.codex-trabalho']);
  });

  it('rollout compactado (.zst) sozinho: ignorado (com aviso no log), a sessão fica fora por falta de projeto', () => {
    const ctx = setup();
    const dir = join(ctx.home.dir, 'sessions', '2026', '10', '01');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `rollout-2026-10-01T09-00-00-${T}.jsonl.zst`), Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0, 1, 2]));
    ctx.home.lock(T, ctx.now() - 60_000);
    ctx.source.boot();
    // Sem o rollout legível não há projeto: fica fora (um hook com o cwd o traria).
    expect(ctx.agent()).toBeUndefined();
    expect(ctx.source.transcriptPathOf(KEY)).toBeUndefined();
  });
});
