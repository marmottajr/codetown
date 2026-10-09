// Integração da fonte do Codex: um CODEX_HOME temporário (rollouts e locks sintéticos), o AccountsService e o Office.
import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { describeShellJob } from '../../../shared/activity';
import type { AgentInfo, Notice, PermissionRequestInfo } from '../../../shared/types';
import { AccountsService } from '../../accounts/service';
import { setQuiet } from '../../log';
import { NameStore } from '../../model/names';
import { DONE_GRACE_MS, Office } from '../../model/office';
import { PermissionRegistry } from '../../permissions/registry';
import { codexHome, R, SOURCES, threadId } from '../../test/codex-fixtures';
import { appendRaw, bigTurn, fakeLockProber } from '../../test/codex-fixtures-source';
import { B, commandParsed, forkRollout, grandchildSource, Q, S } from '../../test/codex-fixtures-source-ii';
import { writeLines } from '../../test/fixtures';
import { readLocks, RolloutIndex } from './files';
import { CodexSource, LOCK_SETTLE_MS, MAIN_GONE_GRACE_MS, scanPrefix, SHELL_EXPIRE_MS, SUB_FOLLOWUP_GRACE_MS, USAGE_RESCAN_MS } from './source';

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
function setup(
  opts: {
    names?: string[];
    noLocks?: boolean;
    locks?: 'held' | 'exists';
    env?: (dirs: string[]) => NodeJS.ProcessEnv;
    permissions?: () => ReadonlyMap<string, PermissionRequestInfo>;
    onTurn?: (account: string, threadId: string, open: boolean) => void;
  } = {},
) {
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
    permissions: opts.permissions,
    now,
  });
  late.office = office;
  const dirs = homes.map((h) => h.dir);
  const source = new CodexSource({ accounts, office, dirs, env: opts.env?.(dirs) ?? {}, home: home.home, now, watch: false, lockProber: locks.prober, onTurn: opts.onTurn });
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
    // Lock sumiu com o turno aberto: ele pode voltar com o mesmo id (followup_task); entrega e sai depois da graça.
    ctx.home.unlock(C);
    ctx.poll();
    expect(ctx.agent(`.codex:${C}`)?.status).toBe('working');
    ctx.advance(2_000);
    ctx.poll();
    expect(ctx.agent(`.codex:${C}`)?.status).toBe('working');
    ctx.advance(SUB_FOLLOWUP_GRACE_MS);
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

  it('conta sem sessão aberta: relê o uso a cada 60 s (uma sessão que rodou e já foi arquivada conta), e o mais novo vence pelo horário da linha, nunca pelo mtime', () => {
    const ctx = setup();
    const old = ctx.now() - 2 * 3600_000;
    ctx.home.rollout(T, [R.meta(T, { at: old }), R.tokens({ input: 1, output: 1, at: old, rateLimits: { primary: { used: 10 }, plan: 'plus' } })], { mtime: old });
    ctx.source.boot();
    const usage = () => ctx.accounts.list(new Map())[0].usage;
    expect(usage()).toMatchObject({ fetchedAt: old, fiveHour: { utilization: 10 } });
    // Um `codex exec` curto rodou e foi arquivado entre dois ciclos: só aparece na releitura de 60 s.
    const recent = ctx.now() - 60_000;
    const T3 = threadId(3);
    ctx.home.rollout(T3, [R.meta(T3, { at: recent }), R.tokens({ input: 1, output: 1, at: recent, rateLimits: { primary: { used: 55 }, plan: 'plus' } })], { archived: true, mtime: recent });
    ctx.advance(USAGE_RESCAN_MS - 1_000);
    ctx.poll();
    expect(usage()?.fetchedAt).toBe(old);
    ctx.advance(1_000);
    ctx.poll();
    expect(usage()).toMatchObject({ fetchedAt: recent, fiveHour: { utilization: 55 } });
    // Um rollout mexido agora (mtime mais novo) com números mais velhos não volta o uso.
    const T4 = threadId(4);
    ctx.home.rollout(T4, [R.meta(T4, { at: old }), R.tokens({ input: 1, output: 1, at: old - 60_000, rateLimits: { primary: { used: 99 }, plan: 'plus' } })], { date: '2026/01/02', mtime: ctx.now() + 60_000 });
    ctx.advance(USAGE_RESCAN_MS);
    ctx.poll();
    expect(usage()).toMatchObject({ fetchedAt: recent, fiveHour: { utilization: 55 } });
  });

  it.each([
    ['mais velha que o uso atual', -60_000],
    ['entre o uso atual e o mais novo', 30 * 60_000],
  ])('conta sem sessão aberta: na mesma releitura, um rollout de mtime mais novo com a linha %s não esconde o uso mais novo de outro', (_, offset) => {
    const ctx = setup();
    const old = ctx.now() - 2 * 3600_000;
    ctx.home.rollout(T, [R.meta(T, { at: old }), R.tokens({ input: 1, output: 1, at: old, rateLimits: { primary: { used: 10 }, plan: 'plus' } })], { mtime: old });
    ctx.source.boot();
    const usage = () => ctx.accounts.list(new Map())[0].usage;
    expect(usage()).toMatchObject({ fetchedAt: old, fiveHour: { utilization: 10 } });
    // Entre dois ciclos: uma sessão curta arquivada (uso mais novo) e um rollout mexido agora (mtime mais novo) com uma
    // linha de uso mais velha. O mtime só ordena o que abrir: vence o horário da linha.
    const recent = ctx.now() - 60_000;
    const T3 = threadId(3);
    ctx.home.rollout(T3, [R.meta(T3, { at: recent }), R.tokens({ input: 1, output: 1, at: recent, rateLimits: { primary: { used: 55 }, plan: 'plus' } })], { archived: true, mtime: recent });
    const T4 = threadId(4);
    ctx.home.rollout(T4, [R.meta(T4, { at: old }), R.tokens({ input: 1, output: 1, at: old + offset, rateLimits: { primary: { used: 99 }, plan: 'plus' } })], { date: '2026/01/02', mtime: ctx.now() + 60_000 });
    ctx.advance(USAGE_RESCAN_MS);
    ctx.poll();
    expect(usage()).toMatchObject({ fetchedAt: recent, fiveHour: { utilization: 55 } });
  });

  it('conta com sessão aberta: a releitura de 60 s fica de fora (o uso vem da própria sessão)', () => {
    const ctx = setup();
    const at = ctx.now() - 60_000;
    ctx.home.rollout(T, [R.meta(T, { at }), R.tokens({ input: 1, output: 1, at, rateLimits: { primary: { used: 20 } } })]);
    ctx.home.lock(T, at);
    ctx.source.boot();
    expect(ctx.agent()).toBeDefined();
    const T3 = threadId(3);
    ctx.home.rollout(T3, [R.meta(T3, { at: at + 30_000 }), R.tokens({ input: 1, output: 1, at: at + 30_000, rateLimits: { primary: { used: 70 } } })], { archived: true });
    ctx.advance(USAGE_RESCAN_MS);
    ctx.poll();
    expect(ctx.accounts.list(new Map())[0].usage).toMatchObject({ fetchedAt: at, fiveHour: { utilization: 20 } });
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

  /** Turno antigo com os dois pares (function_call + CommandExecution de mesmo call_id) e, depois, um turno aberto de mais de 1 MB. */
  function oldPairsThenBigTurn(t0: number): string[] {
    return [
      R.meta(T, { at: t0, cwd: '/projetos/loja' }),
      R.taskStarted('turn0', t0),
      R.functionCall('call_9', 'exec_command', { cmd: 'Get-Content src/soma.ts' }, t0 + 1_000),
      commandParsed(T, 'turn0', 'call_9', 'Get-Content src/soma.ts', read, t0 + 2_000),
      R.functionCall('call_8', 'exec_command', { cmd: 'npm test' }, t0 + 3_000),
      commandParsed(T, 'turn0', 'call_8', 'npm test', [{ type: 'unknown', cmd: 'npm test' }], t0 + 4_000),
      R.taskComplete('turn0', t0 + 5_000),
      R.taskStarted('p1', t0 + 6_000),
      ...bigTurn(T, 'p1', 1_100_000, t0 + 7_000),
    ];
  }

  it('começo de um rollout grande (lido em segundo plano): o par de mesmo call_id entra uma vez só no histórico longo, reclassificado no horário do function_call; sem reclassificação fica o primeiro', async () => {
    const ctx = setup();
    const t0 = ctx.now() - 30 * 60_000;
    ctx.home.rollout(T, oldPairsThenBigTurn(t0));
    ctx.home.lock(T, t0);
    ctx.source.boot();
    await ctx.source.idle();
    const history = ctx.office.detail(KEY)!.history;
    const nine = history.filter((a) => a.id === `${KEY}#call_9`);
    expect(nine).toHaveLength(1);
    expect(nine[0]).toMatchObject({ kind: 'read', text: 'Lendo soma.ts', at: t0 + 1_000 });
    const eight = history.filter((a) => a.id === `${KEY}#call_8`);
    expect(eight).toHaveLength(1);
    expect(eight[0].at).toBe(t0 + 3_000);
  });

  it('scanPrefix: as `keep` atividades guardadas são distintas (o par não ocupa duas vagas)', async () => {
    const ctx = setup();
    const t0 = ctx.now() - 30 * 60_000;
    const path = ctx.home.rollout(T, [
      R.meta(T, { at: t0, cwd: '/projetos/loja' }),
      R.taskStarted('turn0', t0),
      R.functionCall('call_7', 'exec_command', { cmd: 'Get-Content src/a.ts' }, t0 + 1_000),
      commandParsed(T, 'turn0', 'call_7', 'Get-Content src/a.ts', [{ type: 'read', cmd: 'Get-Content src/a.ts', name: 'a.ts', path: 'src/a.ts' }], t0 + 2_000),
      R.functionCall('call_9', 'exec_command', { cmd: 'Get-Content src/soma.ts' }, t0 + 3_000),
      commandParsed(T, 'turn0', 'call_9', 'Get-Content src/soma.ts', read, t0 + 4_000),
    ]);
    const { activities } = await scanPrefix(path, statSync(path).size, KEY, 2);
    expect(activities.map((a) => a.id)).toEqual([`${KEY}#call_7`, `${KEY}#call_9`]);
    expect(activities.map((a) => a.kind)).toEqual(['read', 'read']);
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

describe('fonte do Codex: pergunta do request_user_input (P9)', () => {
  const QUESTION = 'responder uma pergunta';
  const perm = (extra: Record<string, unknown> = {}) => ({
    hook_event_name: 'PermissionRequest',
    session_id: T,
    cwd: '/projetos/loja',
    transcript_path: null,
    turn_id: 'turn1',
    tool_name: 'Bash',
    tool_input: { command: 'rm -rf dist' },
    ...extra,
  });

  it('pergunta sem output: o principal espera você ("responder uma pergunta"); a resposta volta a trabalhar', () => {
    const ctx = setup();
    const at = ctx.now() - 10_000;
    const path = ctx.home.rollout(T, [R.meta(T, { at }), R.taskStarted('turn1', at), R.user(T, 'turn1', 'u1', 'Arrume o build', at + 100)]);
    ctx.home.lock(T, at);
    ctx.source.boot();
    expect(ctx.agent()?.status).toBe('working');
    ctx.advance(1_000);
    ctx.home.append(path, [Q.ask('call_ask', 'Posso apagar a pasta dist?', ctx.now())]);
    ctx.poll();
    expect(ctx.agent()).toMatchObject({ status: 'waiting', waitingFor: QUESTION });
    expect(ctx.notices.some((n) => n.text.includes(QUESTION))).toBe(true);
    ctx.advance(1_000);
    ctx.home.append(path, [Q.answer('call_ask', ctx.now())]);
    ctx.poll();
    expect(ctx.agent()?.status).toBe('working');
    expect(ctx.agent()?.waitingFor).toBeUndefined();
  });

  it('duas perguntas abertas: responder uma não tira a espera (a outra segue sem resposta); responder a outra volta a trabalhar', () => {
    const ctx = setup();
    const at = ctx.now() - 10_000;
    const path = ctx.home.rollout(T, [R.meta(T, { at }), R.taskStarted('turn1', at), Q.ask('call_a', 'Qual banco usar?', at + 1_000), Q.ask('call_b', 'Posso migrar?', at + 1_100)]);
    ctx.home.lock(T, at);
    ctx.source.boot();
    expect(ctx.agent()).toMatchObject({ status: 'waiting', waitingFor: QUESTION });
    ctx.advance(1_000);
    ctx.home.append(path, [Q.answer('call_a', ctx.now())]);
    ctx.poll();
    expect(ctx.agent()).toMatchObject({ status: 'waiting', waitingFor: QUESTION });
    ctx.advance(1_000);
    ctx.home.append(path, [Q.answer('call_b', ctx.now())]);
    ctx.poll();
    expect(ctx.agent()?.status).toBe('working');
    expect(ctx.agent()?.waitingFor).toBeUndefined();
  });

  it('boot no meio de uma pergunta: o principal e o subagente que pergunta já saem esperando', () => {
    const ctx = setup();
    const at = ctx.now() - 60_000;
    ctx.home.rollout(T, [R.meta(T, { at }), R.taskStarted('p1', at), Q.ask('call_p', 'Qual banco usar?', at + 1_000)]);
    ctx.home.rollout(C, [R.meta(C, { at, sessionId: T, source: SOURCES.sub(T) }), R.taskStarted('s1', at), Q.ask('call_s', 'Sigo com o Postgres?', at + 2_000)]);
    ctx.home.lock(T, at);
    ctx.home.lock(C, at);
    ctx.source.boot();
    expect(ctx.agent()).toMatchObject({ status: 'waiting', waitingFor: QUESTION });
    expect(ctx.agent(`.codex:${C}`)).toMatchObject({ kind: 'sub', status: 'waiting', waitingFor: QUESTION });
  });

  it('a pergunta não atropela a espera por aprovação do hook, e a resposta não a tira; o comando andar tira', () => {
    const ctx = setup();
    const at = ctx.now() - 10_000;
    const path = ctx.home.rollout(T, [R.meta(T, { at }), R.taskStarted('turn1', at)]);
    ctx.home.lock(T, at);
    ctx.source.boot();
    expect(ctx.hook(perm())).toBe(true);
    expect(ctx.agent()).toMatchObject({ status: 'waiting', waitingFor: 'aprovar um comando' });
    ctx.advance(1_000);
    ctx.home.append(path, [Q.ask('call_ask', 'Posso apagar a pasta dist?', ctx.now())]);
    ctx.poll();
    expect(ctx.agent()).toMatchObject({ status: 'waiting', waitingFor: 'aprovar um comando' });
    ctx.advance(1_000);
    ctx.home.append(path, [Q.answer('call_ask', ctx.now())]);
    ctx.poll();
    expect(ctx.agent()).toMatchObject({ status: 'waiting', waitingFor: 'aprovar um comando' });
    ctx.advance(1_000);
    ctx.home.append(path, [R.command(T, 'turn1', 'call_rm', 'rm -rf dist', { at: ctx.now() })]);
    ctx.poll();
    expect(ctx.agent()?.status).toBe('working');
  });

  it('com a pergunta aberta, um pedido de aprovação vale por cima; a resposta da pergunta não tira essa espera, e o comando andar volta à pergunta se ela seguir aberta', () => {
    const ctx = setup();
    const at = ctx.now() - 10_000;
    const path = ctx.home.rollout(T, [R.meta(T, { at }), R.taskStarted('turn1', at), Q.ask('call_a', 'Qual banco usar?', at + 1_000), Q.ask('call_b', 'Posso migrar?', at + 1_100)]);
    ctx.home.lock(T, at);
    ctx.source.boot();
    expect(ctx.agent()).toMatchObject({ status: 'waiting', waitingFor: QUESTION });
    ctx.hook(perm());
    expect(ctx.agent()).toMatchObject({ status: 'waiting', waitingFor: 'aprovar um comando' });
    ctx.advance(1_000);
    ctx.home.append(path, [Q.answer('call_a', ctx.now())]);
    ctx.poll();
    expect(ctx.agent()).toMatchObject({ status: 'waiting', waitingFor: 'aprovar um comando' });
    // Aprovado: o comando concluiu, mas a outra pergunta continua sem resposta.
    ctx.advance(1_000);
    ctx.home.append(path, [R.command(T, 'turn1', 'call_rm', 'rm -rf dist', { at: ctx.now() })]);
    ctx.poll();
    expect(ctx.agent()).toMatchObject({ status: 'waiting', waitingFor: QUESTION });
    // Fim do turno com a pergunta aberta: ninguém mais espera a resposta.
    ctx.advance(1_000);
    ctx.home.append(path, [R.taskComplete('turn1', ctx.now())]);
    ctx.poll();
    expect(ctx.agent()?.status).toBe('idle');
  });

  it('pedido do canal paralelo (só no registro, sem o hook): a pergunta não passa por cima dele, antes ou depois; fechado o pedido, volta a pergunta', () => {
    const late: { registry?: PermissionRegistry } = {};
    const ctx = setup({ permissions: () => late.registry?.snapshot() ?? new Map() });
    const registry = (late.registry = new PermissionRegistry({ office: ctx.office, viewers: () => 1, now: ctx.now }));
    const parallel = (key: string) => registry.registerParallel({ key, account: '.codex', threadId: T, tool: 'exec_command', input: { command: 'rm -rf dist' }, decisions: [] });
    const at = ctx.now() - 10_000;
    const path = ctx.home.rollout(T, [R.meta(T, { at }), R.taskStarted('turn1', at)]);
    ctx.home.lock(T, at);
    ctx.source.boot();
    // Pedido antes da pergunta.
    expect(parallel('.codex:1')).toHaveProperty('id');
    ctx.advance(1_000);
    ctx.home.append(path, [Q.ask('call_ask', 'Posso apagar a pasta dist?', ctx.now())]);
    ctx.poll();
    expect(ctx.agent()).toMatchObject({ status: 'waiting', waitingFor: 'aprovar um comando' });
    registry.resolveParallel('.codex:1');
    expect(ctx.agent()).toMatchObject({ status: 'waiting', waitingFor: QUESTION });
    // Pergunta (ainda aberta) antes do pedido.
    expect(parallel('.codex:2')).toHaveProperty('id');
    expect(ctx.agent()).toMatchObject({ status: 'waiting', waitingFor: 'aprovar um comando' });
  });
});

describe('fonte do Codex: título do filho pelo spawn_agent (P11)', () => {
  const SUB = `.codex:${C}`;

  it('o filho que aparece depois do spawn ganha o título do spawn_agent do pai (mais que o 1º texto dele), mascarado', () => {
    const ctx = setup();
    const at = ctx.now() - 10_000;
    const token = 'gh' + 'p_' + 'A1'.repeat(18);
    ctx.home.rollout(T, [
      R.meta(T, { at }),
      R.taskStarted('p1', at),
      S.spawnAgent('call_sp', `Revise os testes de soma ${token}`, at + 1_000, 'revisar_testes'),
      S.started(T, 'p1', 'call_sp', C, at + 1_100, 'revisar_testes'),
    ]);
    ctx.home.lock(T, at);
    ctx.source.boot();
    expect(ctx.agent(SUB)).toBeUndefined();
    // O filho aparece (lock e rollout dele): o 1º texto dele é outro, mas vale a tarefa que o pai deu.
    ctx.home.rollout(C, [R.meta(C, { at: at + 1_200, sessionId: T, source: SOURCES.sub(T) }), R.taskStarted('s1', at + 1_200), R.user(C, 's1', 'su', 'Texto do próprio filho', at + 1_300)]);
    ctx.home.lock(C, at + 1_200);
    ctx.advance(3_100);
    ctx.poll();
    expect(ctx.agent(SUB)).toMatchObject({ kind: 'sub', parentId: KEY, title: 'Revise os testes de soma gh*_***', status: 'working' });
  });

  it('boot com pai e filho juntos: o filho entra com o título do spawn; filho sem spawn com o id dele fica com o próprio texto', () => {
    const ctx = setup();
    const at = ctx.now() - 10_000;
    const C3 = threadId(3);
    ctx.home.rollout(T, [R.meta(T, { at }), R.taskStarted('p1', at), S.spawnAgent('call_sp', 'Documente o módulo de soma', at + 1_000), S.started(T, 'p1', 'call_sp', C, at + 1_100)]);
    ctx.home.rollout(C, [R.meta(C, { at: at + 1_200, sessionId: T, source: SOURCES.sub(T) }), R.taskStarted('s1', at + 1_200), R.user(C, 's1', 'su', 'Outro texto', at + 1_300)]);
    ctx.home.rollout(C3, [R.meta(C3, { at: at + 1_200, sessionId: T, source: SOURCES.sub(T) }), R.taskStarted('s3', at + 1_200), R.user(C3, 's3', 'su3', 'Liste os arquivos de src', at + 1_300)]);
    ctx.home.lock(T, at);
    ctx.home.lock(C, at);
    ctx.home.lock(C3, at);
    ctx.source.boot();
    expect(ctx.agent(SUB)?.title).toBe('Documente o módulo de soma');
    expect(ctx.agent(`.codex:${C3}`)?.title).toBe('Liste os arquivos de src');
  });
});

describe('fonte do Codex: neto (P13)', () => {
  /**
   * Ids do principal (T), do pai (C) e do neto (G) em todas as ordens de nome: no NTFS o readdir dos locks segue o nome
   * (é a ordem em que a fonte processa os threads); no ext4 a ordem vem do hash. O resultado não pode depender dela.
   */
  const ORDERS: Array<[string, number, number, number]> = [
    ['T-C-G', 1, 2, 3],
    ['T-G-C', 1, 3, 2],
    ['C-T-G', 2, 1, 3],
    ['G-T-C', 2, 3, 1],
    ['C-G-T', 3, 1, 2],
    ['G-C-T', 3, 2, 1],
  ];
  function tree(t: number, c: number, g: number) {
    const ids = { T: threadId(t), C: threadId(c), G: threadId(g) };
    return { ...ids, MAIN: `.codex:${ids.T}`, SUB: `.codex:${ids.C}`, NETO: `.codex:${ids.G}` };
  }

  it.each(ORDERS)('neto (depth 2) trabalhando com o pai já concluído entra ligado ao principal da árvore (nomes %s)', (_, t, c, g) => {
    const { T, C, G, MAIN, SUB, NETO } = tree(t, c, g);
    const ctx = setup();
    const at = ctx.now() - 10_000;
    ctx.home.rollout(T, [R.meta(T, { at }), R.taskStarted('p1', at)]);
    ctx.home.rollout(C, [R.meta(C, { at, sessionId: T, source: SOURCES.sub(T) }), R.taskStarted('s1', at), R.taskComplete('s1', at + 500)]);
    ctx.home.rollout(G, [R.meta(G, { at: at + 100, sessionId: T, source: grandchildSource(C) }), R.taskStarted('g1', at + 100), R.user(G, 'g1', 'gu', 'Conte as linhas de src', at + 200)]);
    ctx.home.lock(T, at);
    ctx.home.lock(C, at);
    ctx.home.lock(G, at);
    ctx.source.boot();
    expect(ctx.agent(SUB)).toBeUndefined();
    expect(ctx.agent(NETO)).toMatchObject({ kind: 'sub', parentId: MAIN, status: 'working', title: 'Conte as linhas de src' });
  });

  it.each(ORDERS)('pai e neto que aparecem juntos com o principal aberto: o neto entra ligado ao pai que trabalha (nomes %s)', (_, t, c, g) => {
    const { T, C, G, MAIN, SUB, NETO } = tree(t, c, g);
    const ctx = setup();
    const at = ctx.now() - 10_000;
    ctx.home.rollout(T, [R.meta(T, { at }), R.taskStarted('p1', at)]);
    ctx.home.lock(T, at);
    ctx.source.boot();
    expect(ctx.agent(MAIN)?.status).toBe('working');
    ctx.home.rollout(C, [R.meta(C, { at: ctx.now(), sessionId: T, source: SOURCES.sub(T) }), R.taskStarted('s1', ctx.now())]);
    ctx.home.rollout(G, [R.meta(G, { at: ctx.now() + 100, sessionId: T, source: grandchildSource(C) }), R.taskStarted('g1', ctx.now() + 100)]);
    ctx.home.lock(C, ctx.now());
    ctx.home.lock(G, ctx.now());
    ctx.advance(LOCK_SETTLE_MS + 100);
    ctx.poll();
    expect(ctx.agent(SUB)).toMatchObject({ kind: 'sub', parentId: MAIN, status: 'working' });
    expect(ctx.agent(NETO)).toMatchObject({ kind: 'sub', parentId: SUB, status: 'working' });
  });

  it.each(ORDERS)('neto presente não vira done quando o pai conclui, segue depois que o pai sai do escritório e sai quando o principal fecha (nomes %s)', (_, t, c, g) => {
    const { T, C, G, MAIN, SUB, NETO } = tree(t, c, g);
    const ctx = setup();
    const at = ctx.now() - 10_000;
    ctx.home.rollout(T, [R.meta(T, { at }), R.taskStarted('p1', at)]);
    const child = ctx.home.rollout(C, [R.meta(C, { at, sessionId: T, source: SOURCES.sub(T) }), R.taskStarted('s1', at)]);
    ctx.home.rollout(G, [R.meta(G, { at: at + 100, sessionId: T, source: grandchildSource(C) }), R.taskStarted('g1', at + 100)]);
    ctx.home.lock(T, at);
    ctx.home.lock(C, at);
    ctx.home.lock(G, at);
    ctx.source.boot();
    expect(ctx.agent(NETO)).toMatchObject({ parentId: SUB, status: 'working' });
    // O pai conclui o turno: entrega; o neto continua trabalhando.
    ctx.advance(1_000);
    ctx.home.append(child, [R.taskComplete('s1', ctx.now())]);
    ctx.poll();
    expect(ctx.agent(SUB)?.status).toBe('done');
    expect(ctx.agent(NETO)?.status).toBe('working');
    // O pai sai do escritório (fim da graça de quem entregou): o neto fica.
    ctx.advance(DONE_GRACE_MS + 1_000);
    ctx.poll();
    expect(ctx.agent(SUB)).toBeUndefined();
    expect(ctx.agent(NETO)?.status).toBe('working');
    // O principal fecha: o neto sai junto.
    ctx.home.unlock(T);
    ctx.poll();
    ctx.advance(MAIN_GONE_GRACE_MS);
    ctx.poll();
    expect(ctx.agent(MAIN)?.status).toBe('offline');
    expect(ctx.agent(NETO)?.status).toBe('done');
  });
});

describe('fonte do Codex: comandos em segundo plano (status shell)', () => {
  const SUB = `.codex:${C}`;
  const DEV = describeShellJob('Bash', { command: 'npm run dev' }).label;
  const said = (ctx: ReturnType<typeof setup>, re: RegExp) => ctx.notices.some((n) => re.test(n.text));

  /** Principal trabalhando (boot) que acabou de subir o dev server em segundo plano (sessão 7 do unified exec). */
  function devServer() {
    const ctx = setup();
    const at = ctx.now() - 10_000;
    const path = ctx.home.rollout(T, [R.meta(T, { at }), R.taskStarted('turn1', at), R.user(T, 'turn1', 'u1', 'Suba o servidor', at + 100)]);
    ctx.home.lock(T, at);
    ctx.source.boot();
    ctx.advance(1_000);
    ctx.home.append(path, [B.exec('call_dev', 'npm run dev', ctx.now()), B.running('call_dev', 7, ctx.now() + 10)]);
    ctx.poll();
    return { ctx, path };
  }

  it('o turno acaba com o dev server rodando: "shell" (aviso de espera, sem "concluiu"); o fim dele depois do turno dá ShellDone e volta a idle', () => {
    const { ctx, path } = devServer();
    expect(ctx.agent()).toMatchObject({ status: 'working', shells: [{ id: 'call_dev', label: DEV, command: 'npm run dev', background: true, kind: 'shell' }] });
    ctx.advance(1_000);
    ctx.home.append(path, [R.agent(T, 'turn1', 'a1', 'Servidor no ar', ctx.now()), R.taskComplete('turn1', ctx.now() + 1)]);
    ctx.poll();
    expect(ctx.agent()?.status).toBe('shell');
    expect(ctx.agent()?.activity?.text).toBe(`Esperando o shell: ${DEV}`);
    expect(said(ctx, /esperando o shell/)).toBe(true);
    expect(said(ctx, /concluiu/)).toBe(false);
    // O processo termina depois do turno (item_completed CommandExecution com o process_id).
    ctx.advance(60_000);
    ctx.home.append(path, [B.procDone(T, 'turn1', 'call_dev', 7, 0, ctx.now())]);
    ctx.poll();
    expect(ctx.agent()?.status).toBe('idle');
    expect(ctx.agent()?.shells).toBeUndefined();
    expect(ctx.agent()?.activity?.text).toMatch(/^Shell terminou: /);
    expect(said(ctx, /shell terminou/)).toBe(true);
    expect(said(ctx, /concluiu/)).toBe(false);
  });

  it('dentro do turno: o write_stdin que ainda vê o processo não muda nada; o que vê "Process exited with code 1" dá "Shell falhou" com o código de saída; o fim do turno conclui', () => {
    const { ctx, path } = devServer();
    ctx.advance(1_000);
    ctx.home.append(path, [B.stdin('call_poll', 7, ctx.now()), B.running('call_poll', 7, ctx.now() + 10)]);
    ctx.poll();
    expect(ctx.agent()?.shells).toHaveLength(1);
    ctx.advance(1_000);
    ctx.home.append(path, [B.stdin('call_end', 7, ctx.now()), B.exited('call_end', 1, ctx.now() + 10)]);
    ctx.poll();
    expect(ctx.agent()?.shells).toBeUndefined();
    expect(ctx.agent()?.activity).toMatchObject({ text: `Shell falhou: ${DEV}`, detail: 'Código de saída 1 — npm run dev' });
    expect(said(ctx, /shell falhou/)).toBe(true);
    ctx.advance(1_000);
    ctx.home.append(path, [R.taskComplete('turn1', ctx.now())]);
    ctx.poll();
    expect(ctx.agent()?.status).toBe('idle');
    expect(said(ctx, /concluiu/)).toBe(true);
  });

  it('code mode: a célula que segue rodando deixa o agente em "shell"; o próximo task_started encerra a espera sem ShellDone', () => {
    const ctx = setup();
    const at = ctx.now() - 10_000;
    const path = ctx.home.rollout(T, [R.meta(T, { at }), R.taskStarted('turn1', at)]);
    ctx.home.lock(T, at);
    ctx.source.boot();
    ctx.advance(1_000);
    ctx.home.append(path, [
      B.code('call_js', 'await tools.exec_command({ cmd: "npm run dev" });', ctx.now()),
      B.codeOutput('call_js', 'Script running with cell ID 3\nWall time: 10.0 seconds', ctx.now() + 10),
      R.taskComplete('turn1', ctx.now() + 20),
    ]);
    ctx.poll();
    expect(ctx.agent()).toMatchObject({ status: 'shell', shells: [{ id: 'call_js', label: 'Rodando script' }] });
    ctx.advance(60_000);
    ctx.home.append(path, [R.taskStarted('turn2', ctx.now())]);
    ctx.poll();
    expect(ctx.agent()?.status).toBe('working');
    expect(ctx.agent()?.shells).toBeUndefined();
    ctx.advance(1_000);
    ctx.home.append(path, [R.taskComplete('turn2', ctx.now())]);
    ctx.poll();
    expect(ctx.agent()?.status).toBe('idle');
    expect(said(ctx, /shell (terminou|falhou)/)).toBe(false);
  });

  it('a espera expira SHELL_EXPIRE_MS depois do fim do turno (não do início do processo), sem aviso', () => {
    const { ctx, path } = devServer();
    // Turno longo: 40 min depois de o servidor subir, o turno acaba e a espera começa agora.
    ctx.advance(40 * 60_000);
    ctx.home.append(path, [R.taskComplete('turn1', ctx.now())]);
    ctx.poll();
    expect(ctx.agent()?.status).toBe('shell');
    ctx.advance(SHELL_EXPIRE_MS - 1_000);
    ctx.poll();
    expect(ctx.agent()?.status).toBe('shell');
    ctx.advance(2_000);
    ctx.poll();
    expect(ctx.agent()?.status).toBe('idle');
    expect(ctx.agent()?.shells).toBeUndefined();
    expect(said(ctx, /shell (terminou|falhou)|concluiu/)).toBe(false);
  });

  it('boot: turno acabado há pouco com o processo vivo sai em "shell"; acabado há mais de SHELL_EXPIRE_MS sai idle', () => {
    const ctx = setup();
    const C3 = threadId(3);
    const at = ctx.now() - 5 * 60_000;
    const old = ctx.now() - SHELL_EXPIRE_MS - 5 * 60_000;
    ctx.home.rollout(T, [R.meta(T, { at }), R.taskStarted('turn1', at), B.exec('call_dev', 'npm run dev', at + 1_000), B.running('call_dev', 7, at + 2_000), R.taskComplete('turn1', at + 3_000)]);
    ctx.home.rollout(C3, [R.meta(C3, { at: old }), R.taskStarted('turn1', old), B.exec('call_dev', 'npm run dev', old + 1_000), B.running('call_dev', 9, old + 2_000), R.taskComplete('turn1', old + 3_000)]);
    ctx.home.lock(T, at);
    ctx.home.lock(C3, old);
    ctx.source.boot();
    expect(ctx.agent()).toMatchObject({ status: 'shell', shells: [{ id: 'call_dev' }] });
    expect(ctx.agent(`.codex:${C3}`)?.status).toBe('idle');
    expect(ctx.agent(`.codex:${C3}`)?.shells).toBeUndefined();
  });

  it('o shell de um subagente que entregou passa para o principal ocioso ("shell"); o subagente fechar encerra a espera', () => {
    const ctx = setup();
    const at = ctx.now() - 10_000;
    ctx.home.rollout(T, [R.meta(T, { at }), R.taskStarted('p1', at), R.taskComplete('p1', at + 500)]);
    const sub = ctx.home.rollout(C, [R.meta(C, { at, sessionId: T, source: SOURCES.sub(T) }), R.taskStarted('s1', at + 600)]);
    ctx.home.lock(T, at);
    ctx.home.lock(C, at);
    ctx.source.boot();
    expect(ctx.agent(SUB)?.status).toBe('working');
    ctx.advance(1_000);
    ctx.home.append(sub, [B.exec('call_w', 'npm run watch', ctx.now()), B.running('call_w', 11, ctx.now() + 10)]);
    ctx.poll();
    expect(ctx.agent(SUB)?.shells).toMatchObject([{ id: 'call_w' }]);
    expect(ctx.agent()).toMatchObject({ status: 'idle' });
    expect(ctx.agent()?.shells).toBeUndefined();
    ctx.advance(1_000);
    ctx.home.append(sub, [R.taskComplete('s1', ctx.now())]);
    ctx.poll();
    expect(ctx.agent(SUB)?.status).toBe('done');
    expect(ctx.agent()).toMatchObject({ status: 'shell', shells: [{ id: 'call_w' }] });
    // O subagente fecha (lock solto): o processo vai junto.
    ctx.home.unlock(C);
    ctx.poll();
    ctx.advance(2_000);
    ctx.poll();
    expect(ctx.agent()?.status).toBe('idle');
    expect(ctx.agent()?.shells).toBeUndefined();
  });

  it('principal e subagente com a mesma sessão 7: o fim do processo do principal não fecha o do subagente', () => {
    const ctx = setup();
    const at = ctx.now() - 10_000;
    const main = ctx.home.rollout(T, [R.meta(T, { at }), R.taskStarted('p1', at)]);
    const sub = ctx.home.rollout(C, [R.meta(C, { at, sessionId: T, source: SOURCES.sub(T) }), R.taskStarted('s1', at)]);
    ctx.home.lock(T, at);
    ctx.home.lock(C, at);
    ctx.source.boot();
    ctx.advance(1_000);
    ctx.home.append(main, [B.exec('call_m', 'npm run dev', ctx.now()), B.running('call_m', 7, ctx.now() + 10)]);
    ctx.home.append(sub, [B.exec('call_s', 'npm run watch', ctx.now()), B.running('call_s', 7, ctx.now() + 10)]);
    ctx.poll();
    expect(ctx.agent()?.shells).toMatchObject([{ id: 'call_m' }]);
    expect(ctx.agent(SUB)?.shells).toMatchObject([{ id: 'call_s' }]);
    ctx.advance(1_000);
    ctx.home.append(main, [B.stdin('call_me', 7, ctx.now()), B.exited('call_me', 0, ctx.now() + 10)]);
    ctx.poll();
    expect(ctx.agent()?.shells).toBeUndefined();
    expect(ctx.agent(SUB)?.shells).toMatchObject([{ id: 'call_s' }]);
  });

  it('a sessão de um processo encerrado pelo task_started que volta num exec novo é outro processo, e aparece', () => {
    const { ctx, path } = devServer();
    ctx.advance(1_000);
    ctx.home.append(path, [R.taskComplete('turn1', ctx.now()), R.taskStarted('turn2', ctx.now() + 1_000)]);
    ctx.poll();
    expect(ctx.agent()?.shells).toBeUndefined();
    ctx.advance(2_000);
    ctx.home.append(path, [B.exec('call_dev2', 'npm run dev', ctx.now()), B.running('call_dev2', 7, ctx.now() + 10)]);
    ctx.poll();
    expect(ctx.agent()?.shells).toMatchObject([{ id: 'call_dev2' }]);
  });
});

describe('fonte do Codex: thread revertido com dois rollouts (G7)', () => {
  /**
   * Dois rollouts de T: o original, com a última linha há 10 min e o mtime de ontem (no Windows o mtime fica parado), e
   * o revertido, com a última linha há 2 h e o mtime de agora. `lastAt` dá o horário da última linha do revertido.
   */
  function twoRollouts(ctx: ReturnType<typeof setup>, o: { revertedLastAt?: number } = {}) {
    const now = ctx.now();
    const born = now - 5 * 3600_000;
    const original = ctx.home.rollout(T, [R.meta(T, { at: born }), R.taskStarted('t1', now - 11 * 60_000), R.user(T, 't1', 'u1', 'Versão original', now - 10 * 60_000)], { mtime: now - 86_400_000 });
    const last = o.revertedLastAt ?? now - 2 * 3600_000;
    const reverted = join(ctx.home.dir, 'sessions', '2026', '10', '09', `rollout-2026-10-09T10-00-00-${T}_${threadId(99)}.jsonl`);
    writeLines(reverted, [R.meta(T, { at: born }), R.taskStarted('t1', last - 2_000), R.user(T, 't1', 'u1', 'Versão revertida', last - 1_000), R.taskComplete('t1', last)]);
    ctx.home.touch(reverted, now);
    return { original, reverted };
  }

  it('RolloutIndex: vale o de última linha mais nova, não o de mtime mais novo (na busca e na lista dos recentes)', () => {
    const ctx = setup();
    const { original } = twoRollouts(ctx);
    expect(new RolloutIndex(ctx.home.dir, ctx.now).find(T)).toBe(original);
    // Sem pasta de locks: a lista dos recentes (pelo mtime, só o revertido) também guarda o caminho do thread.
    const index = new RolloutIndex(ctx.home.dir, ctx.now);
    expect(index.recentlyModified(30 * 60_000).map((r) => r.threadId)).toEqual([T]);
    expect(index.find(T)).toBe(original);
  });

  it('última linha com o mesmo horário: o mtime desempata', () => {
    const ctx = setup();
    const { reverted } = twoRollouts(ctx, { revertedLastAt: ctx.now() - 10 * 60_000 });
    expect(new RolloutIndex(ctx.home.dir, ctx.now).find(T)).toBe(reverted);
  });

  it('a fonte abre o rollout de última linha mais nova: título e turno aberto dele', () => {
    const ctx = setup();
    const { original } = twoRollouts(ctx);
    ctx.home.lock(T, ctx.now() - 60_000);
    ctx.source.boot();
    expect(ctx.source.transcriptPathOf(KEY)).toBe(original);
    expect(ctx.agent()).toMatchObject({ title: 'Versão original', status: 'working' });
  });
});

describe('fonte do Codex: terminal com o session_meta do cabeçalho (C2)', () => {
  it('subagente com fork e o cabeçalho fora da janela do fim: nenhuma entrada herdada do pai, caminhos pelo cwd do filho', () => {
    const ctx = setup();
    const at = ctx.now() - 10_000;
    ctx.home.rollout(T, [R.meta(T, { at, cwd: '/projetos/pai' }), R.taskStarted('p1', at), R.user(T, 'p1', 'u', 'Delegue os testes', at)]);
    const fork = forkRollout(C, T, at + 1_000);
    ctx.home.rollout(C, [fork.header, ...fork.rest]);
    ctx.home.lock(T, at);
    ctx.home.lock(C, at + 1_000);
    ctx.source.boot();
    // A janela que o terminal lê do fim não tem o cabeçalho: começa na cópia do session_meta do pai.
    const parser = ctx.source.terminalParser(`.codex:${C}`)!;
    const tools = fork.rest.flatMap((l) => parser.push(l)).flatMap((e) => (e.kind === 'tool' ? [e.title] : []));
    expect(tools).toEqual(['Bash(npm test)', 'Edit(src/a.ts)']);
  });
});

describe('fonte do Codex: corte de inatividade (C3)', () => {
  it('só existência: 31 min sem escrita → idle → linha nova do turno ainda aberto → working (com pergunta aberta, waiting)', () => {
    const ctx = setup({ locks: 'exists' });
    const at = ctx.now() - 60_000;
    const path = ctx.home.rollout(T, [R.meta(T, { at }), R.taskStarted('t', at), R.user(T, 't', 'u', 'rode a migração longa', at)]);
    ctx.home.lock(T, at);
    ctx.source.boot();
    expect(ctx.agent()?.status).toBe('working');
    ctx.advance(31 * 60_000);
    ctx.poll();
    expect(ctx.agent()?.status).toBe('idle');
    // O comando longo volta a escrever: o turno nunca fechou.
    ctx.advance(1_000);
    ctx.home.append(path, [R.command(T, 't', 'call_1', 'npm run migrate', { at: ctx.now(), output: 'ok' })]);
    ctx.poll();
    expect(ctx.agent()?.status).toBe('working');
    // De novo calado, agora com uma pergunta aberta antes do corte: a linha nova volta a esperar a resposta.
    ctx.advance(1_000);
    ctx.home.append(path, [Q.ask('call_q', 'Posso seguir?', ctx.now())]);
    ctx.poll();
    expect(ctx.agent()?.status).toBe('waiting');
    ctx.hook({ hook_event_name: 'Stop', session_id: T, cwd: '/projetos/loja', turn_id: 't' });
    expect(ctx.agent()?.status).toBe('idle');
    ctx.advance(1_000);
    ctx.home.append(path, [R.command(T, 't', 'call_2', 'npm run migrate -- --resume', { at: ctx.now(), output: 'ok' })]);
    ctx.poll();
    expect(ctx.agent()).toMatchObject({ status: 'waiting', waitingFor: 'responder uma pergunta' });
  });

  it('Stop do hook e depois a resposta final e o task_complete, lidos no mesmo ciclo: termina idle, com um "concluiu" só', () => {
    const ctx = setup();
    const at = ctx.now() - 10_000;
    const path = ctx.home.rollout(T, [R.meta(T, { at }), R.taskStarted('t', at), R.user(T, 't', 'u', 'oi', at)]);
    ctx.home.lock(T, at);
    ctx.source.boot();
    expect(ctx.agent()?.status).toBe('working');
    ctx.advance(1_000);
    ctx.hook({ hook_event_name: 'Stop', session_id: T, cwd: '/projetos/loja', turn_id: 't' });
    ctx.advance(10);
    ctx.home.append(path, [R.agent(T, 't', 'a', 'Pronto.', ctx.now()), R.taskComplete('t', ctx.now() + 1)]);
    ctx.poll();
    expect(ctx.agent()?.status).toBe('idle');
    expect(ctx.notices.filter((n) => n.text.includes('concluiu'))).toHaveLength(1);
  });

  it('só existência: subagente 31 min sem escrita → idle (entrega); voltou a escrever no mesmo turno → working', () => {
    const ctx = setup({ locks: 'exists' });
    const at = ctx.now() - 60_000;
    const SUB = `.codex:${C}`;
    const parent = ctx.home.rollout(T, [R.meta(T, { at }), R.taskStarted('p1', at), R.user(T, 'p1', 'u', 'Delegue a suíte', at)]);
    const sub = ctx.home.rollout(C, [R.meta(C, { at, sessionId: T, source: SOURCES.sub(T, 'worker') }), R.taskStarted('s1', at), R.user(C, 's1', 'su', 'Rode a suíte longa', at)]);
    ctx.home.lock(T, at);
    ctx.home.lock(C, at);
    ctx.source.boot();
    expect(ctx.agent(SUB)?.status).toBe('working');
    // O principal segue escrevendo; o subagente fica calado.
    ctx.advance(31 * 60_000);
    ctx.home.append(parent, [R.command(T, 'p1', 'call_p', 'git status', { at: ctx.now(), output: 'ok' })]);
    ctx.poll();
    expect(ctx.agent()?.status).toBe('working');
    expect(ctx.agent(SUB)?.status).toBe('done');
    ctx.advance(1_000);
    ctx.home.append(sub, [R.command(C, 's1', 'call_s', 'npm test', { at: ctx.now(), output: 'ok' })]);
    ctx.poll();
    expect(ctx.agent(SUB)?.status).toBe('working');
  });

  it('sem thread-writer-locks/: subagente presente pelo mtime e sem escrita há 31 min sai, como o principal (o reconcile final usa o motivo da presença)', () => {
    const ctx = setup({ noLocks: true });
    const at = ctx.now() - 60_000;
    const SUB = `.codex:${C}`;
    const parent = ctx.home.rollout(T, [R.meta(T, { at }), R.taskStarted('p1', at), R.user(T, 'p1', 'u', 'Delegue a dúvida', at)]);
    const sub = ctx.home.rollout(C, [R.meta(C, { at, sessionId: T, source: SOURCES.sub(T, 'worker') }), R.taskStarted('s1', at), Q.ask('call_q', 'Qual banco?', at + 1_000)]);
    ctx.source.boot();
    expect(ctx.agent(SUB)).toMatchObject({ status: 'waiting', waitingFor: 'responder uma pergunta' });
    // Os dois arquivos tocados agora (mtime novo, sem conteúdo novo no subagente); o principal escreve.
    ctx.advance(31 * 60_000);
    ctx.home.append(parent, [R.command(T, 'p1', 'call_p', 'git status', { at: ctx.now(), output: 'ok' })]);
    ctx.home.touch(parent, ctx.now());
    ctx.home.touch(sub, ctx.now());
    ctx.poll();
    expect(ctx.agent()?.status).toBe('working');
    expect(ctx.agent(SUB)?.status).toBe('done');
  });

  it('só existência: subagente com lock de 13 h e sem escrita há 13 h sai, como o principal (o reconcile final usa o motivo da presença)', () => {
    const ctx = setup({ locks: 'exists' });
    const at = ctx.now() - 60_000;
    const SUB = `.codex:${C}`;
    const parent = ctx.home.rollout(T, [R.meta(T, { at }), R.taskStarted('p1', at), R.user(T, 'p1', 'u', 'Delegue a dúvida', at)]);
    ctx.home.rollout(C, [R.meta(C, { at, sessionId: T, source: SOURCES.sub(T, 'worker') }), R.taskStarted('s1', at), Q.ask('call_q', 'Qual banco?', at + 1_000)]);
    ctx.home.lock(T, at);
    ctx.home.lock(C, at);
    ctx.source.boot();
    expect(ctx.agent(SUB)?.status).toBe('waiting');
    ctx.advance(13 * 3600_000);
    ctx.home.append(parent, [R.command(T, 'p1', 'call_p', 'git status', { at: ctx.now(), output: 'ok' })]);
    ctx.poll();
    expect(ctx.agent()?.status).toBe('working');
    expect(ctx.agent(SUB)?.status).toBe('done');
  });
});

describe('fonte do Codex: subagente que volta em followup_task (G1)', () => {
  const SUB = `.codex:${C}`;

  /** Principal e subagente trabalhando (travas seguras); devolve o rollout do subagente. */
  function bootWithSub(ctx: ReturnType<typeof setup>): string {
    const at = ctx.now() - 10_000;
    ctx.home.rollout(T, [R.meta(T, { at }), R.taskStarted('p1', at), R.user(T, 'p1', 'u', 'Delegue a revisão', at)]);
    const sub = ctx.home.rollout(C, [R.meta(C, { at, sessionId: T, source: SOURCES.sub(T, 'worker') }), R.taskStarted('s1', at), R.user(C, 's1', 'su', 'Revise o módulo', at)]);
    ctx.home.lock(T, at);
    ctx.home.lock(C, at);
    ctx.source.boot();
    expect(ctx.agent(SUB)?.status).toBe('working');
    return sub;
  }

  it('trava some com o turno aberto: segue presente aos 60 s (e volta sem entregar), sai SUB_FOLLOWUP_GRACE_MS depois de sumir de novo', () => {
    const ctx = setup();
    bootWithSub(ctx);
    ctx.home.unlock(C);
    ctx.poll();
    ctx.advance(60_000);
    ctx.poll();
    expect(ctx.agent(SUB)?.status).toBe('working');
    // Voltou com o mesmo id dentro da graça: o mesmo subagente, sem "entregou".
    ctx.home.lock(C, ctx.now() - 10_000);
    ctx.poll();
    expect(ctx.agent(SUB)?.status).toBe('working');
    expect(ctx.notices.some((n) => n.text.includes('entregou'))).toBe(false);
    ctx.home.unlock(C);
    ctx.poll();
    ctx.advance(SUB_FOLLOWUP_GRACE_MS - 1);
    ctx.poll();
    expect(ctx.agent(SUB)?.status).toBe('working');
    expect(ctx.source.terminalParser(SUB)).toBeDefined();
    ctx.advance(1);
    ctx.poll();
    expect(ctx.agent(SUB)?.status).toBe('done');
    expect(ctx.source.terminalParser(SUB)).toBeUndefined();
    expect(SUB_FOLLOWUP_GRACE_MS).toBe(120_000);
  });

  it('concluído: sai como antes, 1,5 s depois de a trava sumir', () => {
    const ctx = setup();
    const sub = bootWithSub(ctx);
    ctx.advance(1_000);
    ctx.home.append(sub, [R.agent(C, 's1', 'sa', 'Revisado.', ctx.now()), R.taskComplete('s1', ctx.now() + 1)]);
    ctx.poll();
    expect(ctx.agent(SUB)?.status).toBe('done');
    ctx.home.unlock(C);
    ctx.poll();
    ctx.advance(1_500);
    ctx.poll();
    expect(ctx.source.terminalParser(SUB)).toBeUndefined();
  });
});

describe('fonte do Codex: turno aberto e fechado para o canal paralelo (onTurn, C1)', () => {
  type Turn = [account: string, threadId: string, open: boolean];
  function recorder() {
    const calls: Turn[] = [];
    return { calls, onTurn: (account: string, threadId: string, open: boolean) => void calls.push([account, threadId, open]) };
  }

  it('no boot sai o estado do turno de cada thread (aberto e fechado); depois só as mudanças ao vivo, sem repetir', () => {
    const rec = recorder();
    const ctx = setup({ onTurn: rec.onTurn });
    const at = ctx.now() - 60_000;
    const path = ctx.home.rollout(T, [R.meta(T, { at }), R.taskStarted('t1', at), R.user(T, 't1', 'u', 'oi', at), R.taskComplete('t1', at + 1_000)]);
    ctx.home.rollout(C, [R.meta(C, { at, sessionId: T, source: SOURCES.sub(T, 'worker') }), R.taskStarted('s1', at), R.user(C, 's1', 'su', 'Revise o módulo', at)]);
    ctx.home.lock(T, at);
    ctx.home.lock(C, at);
    ctx.source.boot();
    expect(rec.calls).toEqual(expect.arrayContaining([['.codex', T, false], ['.codex', C, true]]));
    expect(rec.calls).toHaveLength(2);
    rec.calls.length = 0;
    // Abre, anda (sem repetir), fecha (o turn_aborted logo depois não repete), abre e é interrompido.
    ctx.advance(1_000);
    ctx.home.append(path, [R.taskStarted('t2', ctx.now()), R.user(T, 't2', 'u2', 'de novo', ctx.now())]);
    ctx.poll();
    ctx.advance(1_000);
    ctx.home.append(path, [R.command(T, 't2', 'call_1', 'npm test', { at: ctx.now(), output: 'ok' })]);
    ctx.poll();
    ctx.advance(1_000);
    ctx.home.append(path, [R.taskComplete('t2', ctx.now()), R.turnAborted('t2', ctx.now() + 1)]);
    ctx.poll();
    ctx.advance(1_000);
    ctx.home.append(path, [R.taskStarted('t3', ctx.now()), R.turnAborted('t3', ctx.now() + 1)]);
    ctx.poll();
    expect(rec.calls).toEqual([
      ['.codex', T, true],
      ['.codex', T, false],
      ['.codex', T, true],
      ['.codex', T, false],
    ]);
  });

  it('SessionEnd do hook e a saída do escritório fecham o turno; thread só com o lock (sem rollout) sai fechada e abre quando o rollout chega', () => {
    const rec = recorder();
    const ctx = setup({ onTurn: rec.onTurn });
    const at = ctx.now() - 60_000;
    const E = threadId(5);
    ctx.home.rollout(T, [R.meta(T, { at }), R.taskStarted('t1', at), R.user(T, 't1', 'u', 'oi', at)]);
    ctx.home.rollout(C, [R.meta(C, { at, cwd: '/projetos/api' }), R.taskStarted('c1', at), R.user(C, 'c1', 'u', 'outra sessão', at)]);
    ctx.home.lock(T, at);
    ctx.home.lock(C, at);
    ctx.home.lock(E, at);
    ctx.source.boot();
    expect(rec.calls).toEqual(expect.arrayContaining([['.codex', T, true], ['.codex', C, true], ['.codex', E, false]]));
    expect(rec.calls).toHaveLength(3);
    rec.calls.length = 0;
    // SessionEnd: fecha na hora, com o lock ainda lá.
    expect(ctx.hook({ hook_event_name: 'SessionEnd', session_id: T, cwd: '/projetos/loja', reason: 'other' })).toBe(true);
    expect(rec.calls).toEqual([['.codex', T, false]]);
    // C sai do escritório com o turno aberto (lock sumiu, fim da graça do principal).
    ctx.home.unlock(C);
    ctx.poll();
    ctx.advance(MAIN_GONE_GRACE_MS);
    ctx.poll();
    expect(ctx.agent(`.codex:${C}`)?.status).toBe('offline');
    expect(rec.calls).toEqual([
      ['.codex', T, false],
      ['.codex', C, false],
    ]);
    // E: o primeiro prompt cria o rollout, com o turno aberto.
    ctx.home.rollout(E, [R.meta(E, { at: ctx.now(), cwd: '/projetos/web' }), R.taskStarted('e1', ctx.now()), R.user(E, 'e1', 'u', 'Comece', ctx.now())]);
    ctx.advance(3_100);
    ctx.poll();
    expect(rec.calls.at(-1)).toEqual(['.codex', E, true]);
    expect(rec.calls).toHaveLength(3);
  });

  it('subagente com o turno aberto que some: fechado quando sai, depois da graça do followup_task', () => {
    const rec = recorder();
    const ctx = setup({ onTurn: rec.onTurn });
    const at = ctx.now() - 10_000;
    ctx.home.rollout(T, [R.meta(T, { at }), R.taskStarted('p1', at), R.user(T, 'p1', 'u', 'Delegue', at)]);
    ctx.home.rollout(C, [R.meta(C, { at, sessionId: T, source: SOURCES.sub(T, 'worker') }), R.taskStarted('s1', at), R.user(C, 's1', 'su', 'Revise', at)]);
    ctx.home.lock(T, at);
    ctx.home.lock(C, at);
    ctx.source.boot();
    rec.calls.length = 0;
    ctx.home.unlock(C);
    ctx.poll();
    ctx.advance(SUB_FOLLOWUP_GRACE_MS - 1);
    ctx.poll();
    expect(rec.calls).toEqual([]);
    ctx.advance(1);
    ctx.poll();
    expect(rec.calls).toEqual([['.codex', C, false]]);
  });

  it('o id vai como o Codex o grava (o id do session_meta), mesmo com o lock e o arquivo em maiúsculas', () => {
    const rec = recorder();
    const ctx = setup({ onTurn: rec.onTurn });
    const U = '0199B0C0-0000-7000-8000-0000000000AB';
    const at = ctx.now() - 60_000;
    ctx.home.rollout(U, [R.meta(U, { at }), R.taskStarted('t1', at), R.user(U, 't1', 'u', 'oi', at)]);
    ctx.home.lock(U, at);
    ctx.source.boot();
    expect(ctx.agent(`.codex:${U.toLowerCase()}`)?.status).toBe('working');
    expect(rec.calls).toEqual([['.codex', U, true]]);
  });
});
