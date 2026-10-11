// Uso do Antigravity (AG-27): `quota` do statusline do agy -> AccountUsage. Dados no formato capturado num agy 1.3.3 real.
import { describe, expect, it } from 'vitest';
import { rollover, STALE_AFTER_MS, UsageStore, usageFromAntigravity } from './usage';

const NOW = Date.parse('2026-10-10T16:00:00Z');
const QUOTA = {
  '3p-weekly': { remaining_fraction: 1, reset_time: '2026-10-17T16:37:57Z', reset_in_seconds: 604770 },
  'gemini-weekly': { remaining_fraction: 0.8337216, reset_time: '2026-10-17T14:54:02Z', reset_in_seconds: 598535 },
};

describe('usageFromAntigravity', () => {
  it('a barra principal é a gemini-weekly: usado = (1 - restante) * 100, reset da reset_time; a outra vai em extra', () => {
    const u = usageFromAntigravity(QUOTA, NOW)!;
    expect(u.source).toBe('antigravity');
    expect(u.fetchedAt).toBe(NOW);
    expect(u.sevenDay!.utilization).toBeCloseTo(16.62784, 4);
    expect(u.sevenDay!.resetsAt).toBe(Date.parse('2026-10-17T14:54:02Z'));
    expect(u.labels).toEqual({ sevenDay: 'Gemini' });
    expect(u.extra).toEqual([{ label: 'Terceiros', window: { utilization: 0, resetsAt: Date.parse('2026-10-17T16:37:57Z') } }]);
    expect(u.fiveHour).toBeUndefined();
  });

  it('sem a gemini-weekly, a primeira cota é a principal, com o nome da chave', () => {
    const u = usageFromAntigravity({ 'claude-weekly': { remaining_fraction: 0.25 } }, NOW)!;
    expect(u.sevenDay!.utilization).toBe(75);
    expect(u.sevenDay!.resetsAt).toBeUndefined();
    expect(u.labels).toEqual({ sevenDay: 'Claude' });
    expect(u.extra).toBeUndefined();
  });

  it('o usado fica entre 0 e 100 mesmo com fração fora do intervalo ou em texto', () => {
    expect(usageFromAntigravity({ a: { remaining_fraction: -0.5 } }, NOW)!.sevenDay!.utilization).toBe(100);
    expect(usageFromAntigravity({ a: { remaining_fraction: 7 } }, NOW)!.sevenDay!.utilization).toBe(0);
    expect(usageFromAntigravity({ a: { remaining_fraction: '0.5' } }, NOW)!.sevenDay!.utilization).toBe(50);
  });

  it('entrada inválida: undefined (cota sem número, lista, texto, vazio)', () => {
    for (const bad of [undefined, null, 'x', 5, [], {}, { a: {} }, { a: { remaining_fraction: 'abc' } }, { a: 'x' }]) expect(usageFromAntigravity(bad, NOW), JSON.stringify(bad)).toBeUndefined();
  });

  it('chave estranha vira um nome limpo e curto; mais de 12 cotas são cortadas', () => {
    const u = usageFromAntigravity({ '<b>x-weekly': { remaining_fraction: 0.5 } }, NOW)!;
    expect(u.labels!.sevenDay).toBe('Bx');
    const many = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${i}-weekly`, { remaining_fraction: 0.5 }]));
    expect(usageFromAntigravity(many, NOW)!.extra).toHaveLength(11);
  });
});

describe('uso do Antigravity na exibição', () => {
  it('rollover: a cota cujo reset passou some (a principal e as extras), e extra vazio sai', () => {
    const u = usageFromAntigravity(QUOTA, NOW)!;
    expect(rollover(u, NOW).sevenDay).toBeDefined();
    expect(rollover(u, NOW).extra).toHaveLength(1);
    const after = rollover(u, Date.parse('2026-10-17T15:00:00Z'));
    expect(after.sevenDay).toBeUndefined();
    expect(after.extra).toHaveLength(1);
    const later = rollover(u, Date.parse('2026-10-17T17:00:00Z'));
    expect(later.extra).toBeUndefined();
  });

  it('a loja mostra ok com números recentes e stale depois de 30 min', () => {
    const store = new UsageStore();
    store.set('antigravity', usageFromAntigravity(QUOTA, NOW)!);
    expect(store.view('antigravity', NOW + 1_000)).toMatchObject({ status: 'ok', usage: { source: 'antigravity' } });
    expect(store.view('antigravity', NOW + STALE_AFTER_MS + 1).status).toBe('stale');
  });
});
