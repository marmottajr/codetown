import { describe, expect, it } from 'vitest';
import type { AccountInfo } from '../../../shared/types';
import { cardState, codexUsageNote, showsUsageAge, sourceLabel, usageMessage, usageMeters, usageSubtitle, windowLabel } from './usage';

const MIN = 60_000;
type Acc = Pick<AccountInfo, 'usage' | 'usageStatus' | 'provider' | 'email' | 'plan' | 'configDir'>;
const codex = (over: Partial<Acc> = {}): Acc => ({ provider: 'codex', usageStatus: 'ok', configDir: '~/.codex', plan: 'Team', ...over });
const win = { utilization: 42, resetsAt: 10 * 60 * MIN };

describe('sourceLabel', () => {
  it('diz quem gravou o uso ao vivo', () => {
    expect(sourceLabel({ source: 'statusline', via: 'mod', fetchedAt: 0 })).toBe('ao vivo (mod do Habblaud)');
    expect(sourceLabel({ source: 'statusline', via: 'tap', fetchedAt: 0 })).toBe('ao vivo (statusline do Claude Code)');
    expect(sourceLabel({ source: 'statusline', fetchedAt: 0 })).toBe('ao vivo (statusline do Claude Code)');
    expect(sourceLabel({ source: 'cache', fetchedAt: 0 })).toBe('cache do /usage do Claude Code');
    expect(sourceLabel({ source: 'codex', fetchedAt: 0 })).toBe('arquivos do Codex');
  });
});

describe('cartão de uso de uma conta do Codex', () => {
  it('"sem cota" é um estado próprio (nunca 0% nem "sem dados")', () => {
    const noQuota = codex({ usage: { source: 'codex', noQuota: true, fetchedAt: 0 } });
    expect(cardState(noQuota)).toBe('noquota');
    expect(usageMessage(noQuota)).toEqual(['sem cota', 'sem cota']);
    expect(codexUsageNote(noQuota, 3 * MIN)).toMatch(/^Na última leitura \(há 3 min\), a conta estava sem cota nem créditos .*Não é 0%/);
    expect(cardState(codex({ usage: { source: 'codex', fiveHour: win, fetchedAt: 0 } }))).toBe('ok');
    expect(cardState(codex({ usage: { source: 'codex', fiveHour: win, fetchedAt: 0 }, usageStatus: 'stale' }))).toBe('stale');
    expect(cardState(codex())).toBe('empty');
  });

  it('a idade fica sempre à mostra no Codex (só se renova com sessão rodando); no Claude Code, só quando é antiga', () => {
    const fresh = { source: 'codex' as const, fiveHour: win, fetchedAt: 0 };
    expect(showsUsageAge(codex({ usage: fresh }))).toBe(true);
    expect(showsUsageAge(codex({ usage: { source: 'codex', noQuota: true, fetchedAt: 0 } }))).toBe(true);
    expect(showsUsageAge(codex())).toBe(false);
    expect(showsUsageAge({ usage: { ...fresh, source: 'statusline' }, usageStatus: 'ok' })).toBe(false);
    expect(showsUsageAge({ usage: { ...fresh, source: 'cache' }, usageStatus: 'stale' })).toBe(true);
    expect(codexUsageNote(codex({ usage: fresh }), 12 * MIN)).toBe('O Codex só grava o uso enquanto alguma sessão roda: estes números são da última leitura (há 12 min).');
  });

  it('sem números: não há o que instalar; embaixo do nome, o plano (sem e-mail)', () => {
    expect(usageMessage(codex())).toEqual(['sem dados ainda', 'sem dados']);
    expect(codexUsageNote(codex(), 0)).toBe('Não precisa instalar nada: os números chegam com a próxima sessão do Codex.');
    expect(usageSubtitle(codex())).toBe('plano Team');
    expect(usageSubtitle(codex({ plan: undefined }))).toBe('Codex');
    // Claude Code: como antes.
    expect(usageMessage({ usageStatus: 'disabled' })).toEqual(['sem dados de uso', 'sem dados']);
    expect(usageSubtitle({ email: 'a@b.c', configDir: '~/.claude' })).toBe('a@b.c');
    expect(usageSubtitle({ configDir: '~/.claude' })).toBe('~/.claude');
    expect(codexUsageNote({ usageStatus: 'ok' }, 0)).toBe('');
  });
});

describe('medidores do cartão: só as janelas que o plano tem', () => {
  const NOW = 1_800_000_000_000;
  const DAY = 24 * 60 * MIN;
  const labels = (a: Pick<AccountInfo, 'usage'>) => usageMeters(a, NOW).map((m) => [m.long, m.short, m.name, m.row]);

  it('rótulo pela duração: 300 → "5h", 10080 → "Semana" (os mesmos do Claude Code); outras em horas ou dias', () => {
    expect(windowLabel(300)).toEqual({ long: '5h', short: '5h', name: 'Sessão de 5 horas', row: 'Sessão de 5 h' });
    expect(windowLabel(10080)).toEqual({ long: 'Semana', short: 'Sem.', name: 'Semana', row: 'Semana' });
    expect(windowLabel(60)).toEqual({ long: '1h', short: '1h', name: 'Janela de 1 h', row: 'Janela de 1 h' });
    expect(windowLabel(1440)).toEqual({ long: '1d', short: '1d', name: 'Janela de 1 d', row: 'Janela de 1 d' });
    expect(windowLabel(4320).long).toBe('3d');
    expect(windowLabel(43200).long).toBe('30d');
    expect(windowLabel(90)).toEqual({ long: '1h30', short: '1h30', name: 'Janela de 1 h 30 min', row: 'Janela de 1 h 30 min' });
  });

  it('Codex só semanal: um medidor só (some o "5h —" fixo)', () => {
    const week = { utilization: 23, resetsAt: NOW + 3 * DAY };
    const a = codex({ usage: { source: 'codex', fetchedAt: NOW, sevenDay: week, windows: [{ windowMinutes: 10080, usedPercent: 23, resetsAt: week.resetsAt }] } });
    expect(labels(a)).toEqual([['Semana', 'Sem.', 'Semana', 'Semana']]);
    expect(usageMeters(a, NOW)[0].view).toMatchObject({ pct: 23, renewed: false });
  });

  it('Codex com as duas janelas e outras durações: na ordem do rate_limits, com o rótulo de cada duração', () => {
    const windows = [
      { windowMinutes: 10080, usedPercent: 40, resetsAt: NOW + 2 * DAY },
      { windowMinutes: 300, usedPercent: 5, resetsAt: NOW + 60 * MIN },
    ];
    expect(labels(codex({ usage: { source: 'codex', fetchedAt: NOW, windows } })).map((l) => l[0])).toEqual(['Semana', '5h']);
    const meters = usageMeters(codex({ usage: { source: 'codex', fetchedAt: NOW, windows: [{ windowMinutes: 4320, usedPercent: 61, resetsAt: NOW + DAY }] } }), NOW);
    expect(meters.map((m) => [m.long, m.view?.pct])).toEqual([['3d', 61]]);
    // Sem horário de reinício: a duração da própria janela diz quando os números deixam de valer.
    const old = codex({ usage: { source: 'codex', fetchedAt: NOW - 2 * 60 * MIN, windows: [{ windowMinutes: 60, usedPercent: 10 }] } });
    expect(usageMeters(old, NOW)[0].view).toMatchObject({ pct: null, renewed: true });
  });

  it('janela do plano que já reiniciou: o cartão fica com "—" (renovada), não "sem dados"', () => {
    // O rollover do servidor apaga sevenDay quando o reinício passa; windows continua dizendo o que o plano tem.
    const a = codex({ usage: { source: 'codex', fetchedAt: NOW - 10 * MIN, windows: [{ windowMinutes: 10080, usedPercent: 92, resetsAt: NOW - MIN }] } });
    expect(cardState(a)).toBe('ok');
    expect(cardState({ ...a, usageStatus: 'stale' })).toBe('stale');
    expect(usageMeters(a, NOW)).toEqual([expect.objectContaining({ long: 'Semana', view: expect.objectContaining({ pct: null, renewed: true }) })]);
    expect(showsUsageAge(a)).toBe(true);
    // Sem cota continua igual (vem antes das janelas).
    expect(cardState(codex({ usage: { source: 'codex', fetchedAt: NOW, noQuota: true } }))).toBe('noquota');
  });

  it('sem windows (Claude Code e leituras antigas do Codex): 5 h e semana, como sempre', () => {
    const claude: Pick<AccountInfo, 'usage'> = { usage: { source: 'statusline', fetchedAt: NOW, fiveHour: { utilization: 42, resetsAt: NOW + 60 * MIN } } };
    expect(labels(claude)).toEqual([
      ['5h', '5h', 'Sessão de 5 horas', 'Sessão de 5 h'],
      ['Semana', 'Sem.', 'Semana', 'Semana'],
    ]);
    const [five, week] = usageMeters(claude, NOW);
    expect(five.view).toMatchObject({ pct: 42 });
    expect(week.view).toBeNull();
    expect(labels(codex({ usage: { source: 'codex', fetchedAt: NOW, sevenDay: { utilization: 3 }, windows: [] } })).map((l) => l[0])).toEqual(['5h', 'Semana']);
    expect(usageMeters({}, NOW)).toEqual([]);
  });
});
