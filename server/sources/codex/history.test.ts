// Histórico do terminal do Codex: listagem dos rollouts recentes e a sessão resolvida com segurança.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { setQuiet } from '../../log';
import { codexHome, R, SOURCES, threadId } from '../../test/codex-fixtures';
import { forkRollout } from '../../test/codex-fixtures-source-ii';
import { symlinkOrSkip, tempDir, writeLines } from '../../test/fixtures';
import { CodexHistory } from './history';

setQuiet(true);

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
});

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** "Agora" fixo, às 15h locais: longe da meia-noite (a pasta do dia do Codex usa a hora local de quem grava). */
const NOW = new Date(2026, 9, 9, 15, 0, 0).getTime();

/** UUIDv7 sintético criado em `at` (os 48 bits de cima são o epoch em ms); `n` distingue ids do mesmo instante. */
function uuidv7(at: number, n: number): string {
  const h = at.toString(16).padStart(12, '0');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-7000-8000-${String(n).padStart(12, '0')}`;
}

/** Pasta do dia local de `at`, no formato de codexHome().rollout ('AAAA/MM/DD'). */
function day(at: number): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;
}

// threadId(n) tem o tempo v7 de 2025-10 (fora da janela): esses ids só entram pela pasta do dia ou pelas linhas.
const [A, B, SUB, OLD, C] = [1, 2, 3, 4, 6].map(threadId);
const ARCH = uuidv7(NOW - 60_000, 5);

function setup(o: { limit?: number } = {}) {
  const home = codexHome();
  cleanups.push(home.cleanup);
  const now = NOW;
  const open = new Set<string>();
  const history = new CodexHistory({
    accounts: () => [{ id: '.codex', dir: home.dir }],
    openAgentOf: (acc, sid) => (open.has(sid) ? `${acc}:${sid}` : undefined),
    now: () => now,
    ...o,
  });
  return { home, history, now, open };
}

describe('histórico do Codex', () => {
  it('lista os rollouts dos últimos 7 dias (sessions/ e archived_sessions/), sem subagentes e internos', async () => {
    const { home, history, now, open } = setup();
    home.rollout(A, [R.meta(A, { at: now - 3_600_000, cwd: '/projetos/loja' }), R.user(A, 't', 'u', 'Arrume o checkout', now - 3_590_000), R.agent(A, 't', 'a', 'ok', now - 3_000_000)]);
    home.rollout(B, [R.meta(B, { at: now - 7_200_000, cwd: '/projetos/api', history: null }), R.legacyUser('pergunta antiga', now - 7_100_000)], { date: '2026/10/08' });
    home.rollout(SUB, [R.meta(SUB, { at: now - 1_000, sessionId: A, source: SOURCES.sub(A) }), R.user(SUB, 't', 'u', 'sub', now - 900)]);
    home.rollout(OLD, [R.meta(OLD, { at: now - 10 * 86_400_000 })], { mtime: now - 10 * 86_400_000 });
    home.rollout(ARCH, [R.meta(ARCH, { at: now - 60_000, cwd: '/projetos/loja', source: 'vscode' }), R.user(ARCH, 't', 'u', 'arquivada', now - 50_000)], { archived: true });
    open.add(A);
    const list = await history.list();
    expect(list.map((s) => s.sessionId)).toEqual([ARCH, A, B]);
    expect(list[1]).toMatchObject({
      account: '.codex',
      provider: 'codex',
      sessionId: A,
      project: '/projetos/loja',
      projectDir: '-projetos-loja',
      title: 'Arrume o checkout',
      open: true,
      agentId: `.codex:${A}`,
      firstAt: now - 3_600_000,
      lastAt: now - 3_000_000,
    });
    expect(list[2]).toMatchObject({ title: 'pergunta antiga', open: false });
    expect(list[2].agentId).toBeUndefined();
  });

  it('subagentes e internos saem pela 1ª linha antes do corte: o limite vale só para as conversas principais', async () => {
    const { home, history } = setup({ limit: 2 });
    const mains = [5, 4, 3].map((h, i) => ({ id: uuidv7(NOW - h * HOUR, i + 1), at: NOW - h * HOUR }));
    for (const [i, m] of mains.entries()) {
      home.rollout(m.id, [R.meta(m.id, { at: m.at }), R.user(m.id, 't', 'u', `Tarefa ${i}`, m.at + 1_000)], { date: day(m.at), mtime: m.at + 1_000 });
    }
    // Mais novos que as principais (no mtime e nas linhas): cortar antes de filtrar deixaria a lista vazia.
    const sides = [SOURCES.sub(mains[0].id), SOURCES.guardian(), SOURCES.internal(), SOURCES.review()];
    for (const [i, source] of sides.entries()) {
      const at = NOW - 30 * MIN + i * MIN;
      const id = uuidv7(at, 10 + i);
      home.rollout(id, [R.meta(id, { at, source }), R.user(id, 't', 'u', 'interno', at + 1_000)], { date: day(at), mtime: at + 1_000 });
    }
    expect((await history.list()).map((s) => s.sessionId)).toEqual([mains[2].id, mains[1].id]);
  });

  it('janela de 7 dias pela pasta do dia e pelo UUIDv7, nunca pelo mtime: a última linha decide', async () => {
    const { home, history } = setup();
    // Pasta de ontem com o mtime parado há 30 dias (no Windows ele às vezes não acompanha as escritas): entra.
    const yesterday = NOW - DAY;
    home.rollout(A, [R.meta(A, { at: yesterday }), R.user(A, 't', 'u', 'Pasta recente', yesterday + 1_000)], { date: day(yesterday), mtime: NOW - 30 * DAY });
    // archived_sessions/ não tem pasta do dia: vale o tempo do UUIDv7 do nome.
    const arch = uuidv7(NOW - 2 * DAY, 7);
    home.rollout(arch, [R.meta(arch, { at: NOW - 2 * DAY }), R.user(arch, 't', 'u', 'Arquivada recente', NOW - 2 * DAY + 1_000)], { archived: true, date: day(NOW - 2 * DAY), mtime: NOW - 30 * DAY });
    // Criada há 10 dias, última linha há 9, mtime de agora (arquivo tocado): o mtime só faz abrir; fica de fora.
    const old = NOW - 10 * DAY;
    home.rollout(OLD, [R.meta(OLD, { at: old }), R.user(OLD, 't', 'u', 'Antiga', old + 1_000), R.agent(OLD, 't', 'a', 'ok', NOW - 9 * DAY)], { date: day(old), mtime: NOW });
    // Arquivada com UUIDv7 e mtime velhos: fora.
    const archOld = uuidv7(NOW - 20 * DAY, 8);
    home.rollout(archOld, [R.meta(archOld, { at: NOW - 20 * DAY })], { archived: true, date: day(NOW - 20 * DAY), mtime: NOW - 20 * DAY });
    const list = await history.list();
    expect(list.map((s) => [s.sessionId, s.lastAt])).toEqual([
      [A, yesterday + 1_000],
      [arch, NOW - 2 * DAY + 1_000],
    ]);
  });

  it('conversa antiga retomada entra pela última linha: aberta no escritório, já na 1ª listagem; fechada, quando o arquivo cresce', async () => {
    const { home, history, open } = setup();
    const born = NOW - 12 * DAY;
    const start = (id: string) => [R.meta(id, { at: born }), R.user(id, 't1', 'u', 'Começa a migração', born + 1_000)];
    const pa = home.rollout(A, start(A), { date: day(born), mtime: born + MIN });
    const pb = home.rollout(B, start(B), { date: day(born), mtime: born + MIN });
    // A foi retomada e está aberta no escritório; o mtime não acompanhou a escrita.
    home.append(pa, [R.user(A, 't2', 'u2', 'Continua', NOW - HOUR)]);
    home.touch(pa, born + MIN);
    open.add(A);
    expect((await history.list()).map((s) => [s.sessionId, s.lastAt, s.open])).toEqual([[A, NOW - HOUR, true]]);
    // B, fechada: crescer entre duas listagens basta, mesmo com a pasta velha e o mtime parado.
    home.append(pb, [R.user(B, 't2', 'u2', 'Continua também', NOW - 30 * MIN)]);
    home.touch(pb, born + MIN);
    const list = await history.list();
    expect(list.map((s) => s.sessionId)).toEqual([B, A]);
    expect(list[0]).toMatchObject({ title: 'Começa a migração', firstAt: born, lastAt: NOW - 30 * MIN, open: false });
  });

  it('título pelo session_index.jsonl (a última linha da thread vence, mascarado antes de cortar); sem nome, a 1ª instrução', async () => {
    const { home, history } = setup();
    const at = NOW - HOUR;
    const prompts: Array<[string, string]> = [
      [A, 'Arrume o checkout'],
      [B, 'Crie a rota de login'],
      [C, 'Revise o CSS'],
    ];
    for (const [id, text] of prompts) home.rollout(id, [R.meta(id, { at }), R.user(id, 't', 'u', text, at + 1_000)]);
    const name = `${'Revisar o deploy da loja. '.repeat(3)}Chave sk-abcdefghijklmnop`;
    const entry = (id: string, threadName: string) => JSON.stringify({ id, thread_name: threadName, updated_at: '2026-10-09T12:00:00.000Z' });
    const index = join(home.dir, 'session_index.jsonl');
    writeFileSync(index, `${[entry(A, 'Nome antigo'), entry(B, 'Nome provisório'), '{quebrada', entry(A, name), entry(B, '')].join('\n')}\n`);
    const titles = async () => new Map((await history.list()).map((s) => [s.sessionId, s.title]));
    const first = await titles();
    // Cortar antes de mascarar deixaria "sk-ab…" (curto demais para o padrão da chave) no título.
    expect(first.get(A)).toBe(`${'Revisar o deploy da loja. '.repeat(3)}Chave sk-***`);
    // Nome apagado (thread_name vazio na última linha) e thread sem entrada: a 1ª instrução.
    expect(first.get(B)).toBe('Crie a rota de login');
    expect(first.get(C)).toBe('Revise o CSS');
    // O índice cresceu: relido.
    appendFileSync(index, `${entry(C, 'Estilos do carrinho')}\n`);
    expect((await titles()).get(C)).toBe('Estilos do carrinho');
  });

  it('cache pelo tamanho, não pelo mtime: mesmo tamanho não relê; crescer relê o fim, mas não a 1ª linha', async () => {
    const { home, history } = setup();
    const at = NOW - HOUR;
    const path = home.rollout(A, [R.meta(A, { at, cwd: '/projetos/loja' }), R.user(A, 't', 'u', 'Arrume o checkout', at + 1_000)]);
    expect((await history.list())[0]).toMatchObject({ title: 'Arrume o checkout', project: '/projetos/loja' });
    // Outro conteúdo com o mesmo tamanho e outro mtime: nada é relido.
    writeFileSync(path, readFileSync(path, 'utf8').replace('Arrume o checkout', 'Arrume o carrinho'));
    home.touch(path, NOW - 5 * MIN);
    expect((await history.list())[0].title).toBe('Arrume o checkout');
    // Cresceu: o fim é relido (última atividade); a classificação e o projeto (1ª linha) ficam os do cache.
    writeFileSync(path, readFileSync(path, 'utf8').replace('/projetos/loja', '/projetos/lojb'));
    home.append(path, [R.agent(A, 't', 'a', 'Feito', NOW - MIN)]);
    expect((await history.list())[0]).toMatchObject({ project: '/projetos/loja', lastAt: NOW - MIN });
  });

  it('1ª linha ainda sendo gravada: não entra nem fica no cache; a conversa aparece quando o cabeçalho termina', async () => {
    const { home, history } = setup();
    const at = NOW - HOUR;
    const main = [R.meta(A, { at }), R.user(A, 't', 'u', 'Começa agora', at + 1_000)];
    const sub = [R.meta(SUB, { at, source: SOURCES.sub(A) }), R.user(SUB, 't', 'u', 'interno', at + 1_000)];
    const pa = home.rollout(A, []);
    const ps = home.rollout(SUB, []);
    writeFileSync(pa, main[0].slice(0, 80));
    writeFileSync(ps, sub[0].slice(0, 80));
    expect(await history.list()).toEqual([]);
    writeLines(pa, main);
    writeLines(ps, sub);
    expect((await history.list()).map((s) => s.sessionId)).toEqual([A]);
  });

  it('a mesma thread em dois rollouts (revertida): fica o de atividade mais recente, não o de mtime mais novo', async () => {
    const { home, history } = setup();
    home.rollout(A, [R.meta(A, { at: NOW - 5 * HOUR }), R.user(A, 't', 'u', 'Versão original', NOW - 2 * HOUR)], { mtime: NOW });
    const reverted = join(home.dir, 'sessions', ...day(NOW).split('/'), `rollout-2026-10-09T10-00-00-${A}_${uuidv7(NOW, 99)}.jsonl`);
    writeLines(reverted, [R.meta(A, { at: NOW - 5 * HOUR }), R.user(A, 't', 'u', 'Versão revertida', NOW - 10 * MIN)]);
    home.touch(reverted, NOW - DAY);
    const list = await history.list();
    expect(list.map((s) => [s.sessionId, s.title, s.lastAt])).toEqual([[A, 'Versão revertida', NOW - 10 * MIN]]);
  });

  it('resolve com a mesma thread em dois rollouts (revertida): vale o de última linha mais nova, não o de mtime mais novo; horário igual, o mtime desempata', () => {
    const { home, history } = setup();
    const resolved = (id: string) => {
      const r = history.resolve('.codex', id);
      return 'path' in r ? basename(r.path) : r;
    };
    // A: o original tem a última linha mais nova e o mtime de ontem (no Windows o mtime fica parado).
    const original = home.rollout(A, [R.meta(A, { at: NOW - 5 * HOUR }), R.user(A, 't', 'u', 'Versão original', NOW - 10 * MIN)], { mtime: NOW - DAY });
    const reverted = join(home.dir, 'sessions', ...day(NOW).split('/'), `rollout-2026-10-09T10-00-00-${A}_${uuidv7(NOW, 99)}.jsonl`);
    writeLines(reverted, [R.meta(A, { at: NOW - 5 * HOUR }), R.user(A, 't', 'u', 'Versão revertida', NOW - 2 * HOUR)]);
    home.touch(reverted, NOW);
    expect(resolved(A)).toBe(basename(original));
    // B: as duas últimas linhas com o mesmo horário; vale o mtime mais novo.
    home.rollout(B, [R.meta(B, { at: NOW - 5 * HOUR }), R.user(B, 't', 'u', 'Original', NOW - 10 * MIN)], { mtime: NOW - DAY });
    const tie = join(home.dir, 'sessions', ...day(NOW).split('/'), `rollout-2026-10-09T10-00-00-${B}_${uuidv7(NOW, 98)}.jsonl`);
    writeLines(tie, [R.meta(B, { at: NOW - 5 * HOUR }), R.user(B, 't', 'u', 'Revertida', NOW - 10 * MIN)]);
    home.touch(tie, NOW);
    expect(resolved(B)).toBe(basename(tie));
  });

  it('resolve: só dentro da pasta da conta, com o parser do Codex; id inválido 400; .zst e desconhecida 404', ({ skip }) => {
    const { home, history } = setup();
    const path = home.rollout(A, [R.meta(A), R.user(A, 't', 'u', 'oi')]);
    const r = history.resolve('.codex', A);
    expect('path' in r && r.path).toContain(`rollout-2026-10-09T09-00-00-${A}.jsonl`);
    if ('path' in r) expect(r.createParser().push(R.user(A, 't', 'u2', 'olá'))[0]).toMatchObject({ kind: 'user', text: 'olá' });
    expect(path).toBeTruthy();
    expect(history.resolve('.codex', '../../etc/passwd')).toEqual({ status: 400, error: 'id de sessão inválido' });
    expect(history.resolve('.outra', A)).toEqual({ status: 404, error: 'conta desconhecida' });
    expect(history.resolve('.codex', B)).toMatchObject({ status: 404 });
    const dir = join(home.dir, 'sessions', '2026', '10', '01');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `rollout-2026-10-01T09-00-00-${B}.jsonl.zst`), 'zst');
    expect(history.resolve('.codex', B)).toMatchObject({ status: 404, error: expect.stringContaining('.zst') });
    // Link para fora da pasta da conta: não serve.
    const outside = tempDir();
    cleanups.push(outside.cleanup);
    writeFileSync(join(outside.dir, 'x.jsonl'), R.meta(SUB));
    symlinkOrSkip(skip, join(outside.dir, 'x.jsonl'), join(dir, `rollout-2026-10-01T09-00-00-${SUB}.jsonl`));
    expect(history.resolve('.codex', SUB)).toMatchObject({ status: 404 });
  });

  it('resolve de subagente com fork e o cabeçalho fora da janela do fim: o parser já vem com o session_meta (nada herdado do pai, caminhos pelo cwd do filho)', () => {
    const { home, history } = setup();
    const fork = forkRollout(SUB, A, NOW - HOUR);
    home.rollout(SUB, [fork.header, ...fork.rest]);
    const r = history.resolve('.codex', SUB);
    if (!('path' in r)) throw new Error(r.error);
    // A janela que o terminal lê do fim não tem o cabeçalho: começa na cópia do session_meta do pai.
    const parser = r.createParser();
    const tools = fork.rest.flatMap((l) => parser.push(l)).flatMap((e) => (e.kind === 'tool' ? [e.title] : []));
    expect(tools).toEqual(['Bash(npm test)', 'Edit(src/a.ts)']);
  });

  it('cache: o rollout só é relido quando muda', async () => {
    const { home, history, now } = setup();
    const path = home.rollout(A, [R.meta(A, { at: now - 1_000 }), R.user(A, 't', 'u', 'primeiro', now - 900)]);
    expect((await history.list())[0].title).toBe('primeiro');
    home.append(path, [R.agent(A, 't', 'a', 'resposta', now - 100)]);
    expect((await history.list())[0].lastAt).toBe(now - 100);
  });
});
