// Cartão do OpenCode com o uso local (custo e tokens dos últimos 7 dias, do opencode.db): texto, sem barra nem
// porcentagem. Spec: .specs/features/opencode-uso (OCU-01, OCU-02, OCU-03).
import { afterAll, describe, expect, it } from 'vitest';
import type { AccountInfo } from '../../../shared/types';
import { installFakeDom, renderCards, restoreFakeDom, tipRows } from './usage-dom-fixture';
import { usageMessage } from './usage';

installFakeDom();
afterAll(restoreFakeDom);

const NOW = Date.parse('2026-10-10T16:00:00Z');
const oc = (extra: Partial<AccountInfo> = {}): AccountInfo => ({
  id: 'opencode',
  provider: 'opencode',
  short: 'OC',
  name: 'OpenCode',
  color: '#3ddc97',
  configDir: '~/.local/share/opencode',
  sessions: 1,
  usageStatus: 'ok',
  ...extra,
});
// Fixture de 7 dias: US$ 1,75; 1.500 de entrada; 300 de saída; 7.500 de cache de leitura.
const withUse = oc({
  usage: { source: 'opencode', fetchedAt: NOW, local: { days: 7, costUsd: 1.75, input: 1500, output: 300, reasoning: 50, cacheRead: 7500, cacheWrite: 300 } },
});

describe('cartão do OpenCode com uso local', () => {
  const [card] = renderCards([withUse], NOW);
  it('OCU-01: mostra o custo e os tokens de entrada e saída dos 7 dias', () => {
    const long = card!.one('ui-usage-card__msg-long').textContent;
    expect(card!.one('ui-usage-card__msg').visible).toBe(true);
    expect(long).toContain('1,75');
    expect(long).toContain('US$');
    expect(long).toContain('7 dias');
    expect(long).toContain('1,5 k ent.');
    expect(long).toContain('300 saída');
    expect(card!.one('ui-usage-card__msg-short').textContent).toContain('1,75');
    expect(long).not.toContain('sem dados de cota');
  });
  it('OCU-02: sem barra nem porcentagem de cota', () => {
    expect(card!.one('ui-usage-card__meters').visible).toBe(false);
    expect(card!.all('ui-meter').filter((m) => m.visible)).toEqual([]);
    expect(card!.all('ui-meter__pct').filter((p) => p.visible)).toEqual([]);
    expect(card!.one('ui-usage-card__msg').textContent).not.toContain('%');
    expect(card!.one('ui-usage-card__how').visible).toBe(false);
  });
  it('OCU-01: a dica detalha custo, entrada, saída e cache de leitura da janela', () => {
    const rows = Object.fromEntries(tipRows(card!));
    expect(rows['Custo (7 dias)']).toContain('1,75');
    expect(rows['Entrada (7 dias)']).toBe('1,5 k');
    expect(rows['Saída (7 dias)']).toBe('300');
    expect(rows['Cache de leitura (7 dias)']).toBe('7,5 k');
    expect(rows['Origem']).toBe('banco local do OpenCode (opencode.db)');
  });
  it('OCU-01: usageMessage devolve [longa, curta] com o custo', () => {
    const [long, short] = usageMessage(withUse);
    expect(long).toMatch(/^US\$.1,75 · 7 dias · 1,5 k ent\. · 300 saída$/);
    expect(short).toMatch(/^US\$.1,75 · 7 d$/);
  });
});

describe('cartão do OpenCode sem uso local', () => {
  it('OCU-03: sem números continua "sem dados de cota"', () => {
    expect(usageMessage(oc({ usageStatus: 'disabled' }))).toEqual(['o OpenCode não tem cota única', 'sem dados de cota']);
    const [card] = renderCards([oc({ usageStatus: 'disabled' })], NOW);
    expect(card!.one('ui-usage-card__msg-short').textContent).toBe('sem dados de cota');
    expect(Object.fromEntries(tipRows(card!))['Custo (7 dias)']).toBeUndefined();
  });
});
