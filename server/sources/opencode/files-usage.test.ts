// OpenCode: uso local (custo e tokens dos últimos 7 dias) lido do opencode.db sintético. Spec: .specs/features/opencode-uso.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildOpencodeDb, HAS_SQLITE, type OcFixture } from '../../test/opencode-fixtures';
import { openDb, usageTotals, USAGE_WINDOW_MS, type OcDb } from './files';

const SENTINEL = 'SEGREDO-NAO-PODE-VAZAR';
const NOW = 1_800_000_000_000;
const DAY = 86_400_000;

interface Reply {
  at: number;
  cost: number;
  input: number;
  output: number;
  reasoning?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

describe.skipIf(!HAS_SQLITE)('uso local do opencode.db (OCU)', () => {
  let fx: OcFixture;
  let db: OcDb | undefined;
  const open = async (onError?: (e: unknown) => void): Promise<OcDb> => {
    const r = await openDb(fx.dir, { onError });
    if (typeof r === 'string') throw new Error(`openDb: ${r}`);
    db = r;
    return r;
  };
  /** Resposta do assistente no formato do OpenCode (`time.created` em epoch ms, `tokens` com cache aninhado). */
  const reply = (session: string, r: Reply, extra: Record<string, unknown> = {}): void => {
    fx.addMessage({
      session,
      role: 'assistant',
      created: r.at,
      rawData: JSON.stringify({
        role: 'assistant',
        time: { created: r.at, completed: r.at + 1000 },
        cost: r.cost,
        tokens: { total: 0, input: r.input, output: r.output, reasoning: r.reasoning ?? 0, cache: { read: r.cacheRead ?? 0, write: r.cacheWrite ?? 0 } },
        ...extra,
      }),
    });
  };
  afterEach(() => {
    db?.close();
    db = undefined;
    fx?.cleanup();
  });

  // Cenário da fixture: duas respostas dentro dos 7 dias, uma fora (8 dias), uma mensagem do usuário dentro da janela.
  const scenario = (): void => {
    fx = buildOpencodeDb();
    const s = fx.addSession({ updated: NOW });
    reply(s, { at: NOW - DAY, cost: 1.5, input: 1000, output: 200, reasoning: 50, cacheRead: 5000, cacheWrite: 300 });
    reply(s, { at: NOW - 6 * DAY - 23 * 3_600_000, cost: 0.25, input: 500, output: 100, cacheRead: 2500 });
    reply(s, { at: NOW - 8 * DAY, cost: 10, input: 9_000_000, output: 9_000, reasoning: 900, cacheRead: 90_000_000, cacheWrite: 9_000 });
    fx.addMessage({ session: s, role: 'user', created: NOW - DAY, text: SENTINEL });
  };

  it('OCU-01/OCU-05: soma custo e tokens só das respostas do assistente dentro dos últimos 7 dias', async () => {
    scenario();
    const d = await open();
    expect(usageTotals(d, NOW - USAGE_WINDOW_MS, NOW)).toEqual({
      costUsd: 1.75,
      input: 1500,
      output: 300,
      reasoning: 50,
      cacheRead: 7500,
      cacheWrite: 300,
      responses: 2,
      at: NOW,
    });
    expect(USAGE_WINDOW_MS).toBe(7 * DAY);
  });

  it('OCU-05: a soma bate com a de um oráculo independente (o que `opencode stats` faz: somar cost e tokens por resposta)', async () => {
    fx = buildOpencodeDb();
    const s = fx.addSession({ updated: NOW });
    const replies: Reply[] = Array.from({ length: 40 }, (_, i) => ({
      at: NOW - i * 6 * 3_600_000,
      cost: (i % 7) * 0.125,
      input: 100 * i + 7,
      output: 10 * i + 1,
      reasoning: i % 3,
      cacheRead: 1000 * i,
      cacheWrite: i % 5,
    }));
    for (const r of replies) reply(s, r);
    const since = NOW - USAGE_WINDOW_MS;
    const inside = replies.filter((r) => r.at >= since);
    expect(inside.length).toBeGreaterThan(0);
    expect(inside.length).toBeLessThan(replies.length);
    const sum = (f: (r: Reply) => number) => inside.reduce((acc, r) => acc + f(r), 0);
    const d = await open();
    const got = usageTotals(d, since, NOW)!;
    expect(got.costUsd).toBe(sum((r) => r.cost));
    expect(got.input).toBe(sum((r) => r.input));
    expect(got.output).toBe(sum((r) => r.output));
    expect(got.reasoning).toBe(sum((r) => r.reasoning!));
    expect(got.cacheRead).toBe(sum((r) => r.cacheRead!));
    expect(got.cacheWrite).toBe(sum((r) => r.cacheWrite!));
    expect(got.responses).toBe(inside.length);
  });

  it('OCU-01: janela sem respostas devolve zeros (não é "sem dados")', async () => {
    fx = buildOpencodeDb();
    const d = await open();
    expect(usageTotals(d, NOW - USAGE_WINDOW_MS, NOW)).toEqual({ costUsd: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, responses: 0, at: NOW });
  });

  it('OCU-01: resposta em andamento (sem cost nem tokens) e com `data` malformado não quebram a soma', async () => {
    fx = buildOpencodeDb();
    const s = fx.addSession({ updated: NOW });
    reply(s, { at: NOW - DAY, cost: 2, input: 10, output: 5 });
    fx.addMessage({ session: s, role: 'assistant', created: NOW - 1000 }); // sem cost/tokens: o turno ainda roda
    fx.addMessage({ session: s, role: 'assistant', created: NOW - 500, rawData: '{isto não é json' });
    const d = await open();
    expect(usageTotals(d, NOW - USAGE_WINDOW_MS, NOW)).toMatchObject({ costUsd: 2, input: 10, output: 5 });
  });

  it('OCU-06: só pede json_extract de role, time.created, cost e tokens; nada de part nem de texto, e o texto não chega ao resultado', async () => {
    scenario();
    const s = fx.addSession({ updated: NOW });
    const m = fx.addMessage({ session: s, role: 'assistant', created: NOW - 1000, text: SENTINEL });
    fx.addPart({ message: m, session: s, created: NOW - 1000, data: { type: 'text', text: SENTINEL } });
    fx.addPart({ message: m, session: s, created: NOW - 999, data: { type: 'reasoning', text: SENTINEL } });
    fx.addPart({ message: m, session: s, created: NOW - 998, data: { type: 'tool', tool: 'bash', state: { status: 'completed', output: SENTINEL } } });
    const d = await open();
    const prepare = vi.spyOn(d.raw, 'prepare');
    const got = usageTotals(d, NOW - USAGE_WINDOW_MS, NOW);
    expect(prepare).toHaveBeenCalled();
    const allowed = new Set(['$.role', '$.time.created', '$.cost', '$.tokens.input', '$.tokens.output', '$.tokens.reasoning', '$.tokens.cache.read', '$.tokens.cache.write']);
    for (const [sql] of prepare.mock.calls) {
      const paths = [...String(sql).matchAll(/json_extract\(data,\s*'([^']+)'\)/g)].map((x) => x[1]!);
      expect(paths.length).toBeGreaterThan(0);
      expect(paths.filter((p) => !allowed.has(p))).toEqual([]);
      expect(String(sql)).not.toMatch(/\bpart\b/i);
      expect(String(sql)).not.toMatch(/SELECT\s+(?:\w+\.)?data\b|,\s*data\s*(?:,|FROM|AS)/i);
    }
    expect(JSON.stringify(got)).not.toContain(SENTINEL);
  });

  it('OCU-07: abre somente leitura (escrever falha) e a leitura não altera o banco', async () => {
    scenario();
    const d = await open();
    const count = () => (fx.db.prepare('SELECT count(*) AS n FROM message').get() as { n: number }).n;
    const before = count();
    usageTotals(d, NOW - USAGE_WINDOW_MS, NOW);
    expect(() => d.raw.exec("DELETE FROM message")).toThrow(/readonly/i);
    expect(count()).toBe(before);
  });

  it('OCU-04: leitura que falha devolve o último valor bom (com o `at` dele) e avisa onError; volta ao normal depois', async () => {
    scenario();
    const onError = vi.fn();
    const d = await open(onError);
    const good = usageTotals(d, NOW - USAGE_WINDOW_MS, NOW);
    expect(good?.costUsd).toBe(1.75);
    fx.db.exec('ALTER TABLE message RENAME TO message_fora'); // o esquema some por um instante: a consulta falha
    expect(usageTotals(d, NOW - USAGE_WINDOW_MS, NOW + 60_000)).toEqual(good);
    expect(onError).toHaveBeenCalledTimes(1);
    fx.db.exec('ALTER TABLE message_fora RENAME TO message');
    expect(usageTotals(d, NOW - USAGE_WINDOW_MS, NOW + 120_000)).toEqual({ ...good, at: NOW + 120_000 });
  });

  it('OCU-04: falha na primeira leitura (sem valor bom ainda) devolve undefined, não zeros', async () => {
    scenario();
    const onError = vi.fn();
    const d = await open(onError);
    fx.db.exec('ALTER TABLE message RENAME TO message_fora');
    expect(usageTotals(d, NOW - USAGE_WINDOW_MS, NOW)).toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
