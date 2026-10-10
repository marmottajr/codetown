// rollover com as janelas do Codex (`windows`): números sintéticos.
import { describe, expect, it } from 'vitest';
import type { AccountUsage } from '../../shared/types';
import { rollover } from './usage';

const NOW = Date.parse('2026-10-09T12:00:00Z');

describe('rollover × windows (Codex)', () => {
  it('apaga o sevenDay vencido e mantém `windows` inteiro, inclusive a janela que já reiniciou (o cliente mostra "—" nela)', () => {
    const fiveResets = NOW - 60_000; // já reiniciou
    const weekResets = NOW + 3 * 24 * 3600_000;
    const usage: AccountUsage = {
      source: 'codex',
      fetchedAt: NOW - 2 * 3600_000,
      fiveHour: { utilization: 80, resetsAt: fiveResets },
      sevenDay: { utilization: 40, resetsAt: weekResets },
      windows: [
        { windowMinutes: 300, usedPercent: 80, resetsAt: fiveResets },
        { windowMinutes: 10080, usedPercent: 40, resetsAt: weekResets },
      ],
    };
    const r = rollover(usage, NOW);
    expect(r.fiveHour).toBeUndefined();
    expect(r.sevenDay).toEqual({ utilization: 40, resetsAt: weekResets });
    expect(r.windows).toEqual(usage.windows);

    // Depois da semana também: os campos fixos somem, `windows` fica.
    const later = rollover(usage, weekResets);
    expect(later.sevenDay).toBeUndefined();
    expect(later.windows).toHaveLength(2);
    expect(later).toMatchObject({ source: 'codex', fetchedAt: usage.fetchedAt });
  });
});
