// AG-28 no DOM: o cartão de uso do Antigravity montado de verdade (UsageCards num DOM mínimo; o vitest do repo roda em
// node). Derivado da spec: sem a barra de "5h", a barra leva o nome da cota ("Gemini"), as outras cotas semanais
// ficam na dica, o número é o do /usage do agy e, sem números, o cartão manda rodar o instalador com --uso.
import { afterAll, describe, expect, it } from 'vitest';
import type { AccountInfo } from '../../../shared/types';
import { installFakeDom, renderCards, restoreFakeDom, tipRows } from './usage-dom-fixture';

// Instala já na carga do arquivo: os describe montam os cartões na coleta.
installFakeDom();
afterAll(restoreFakeDom);

const HOUR = 3_600_000;
const NOW = Date.parse('2026-10-10T16:00:00Z');
const base = { color: '#6c8cff', configDir: '~/.gemini', sessions: 1, usageStatus: 'ok' as const };
const agy = (over: Partial<AccountInfo> = {}): AccountInfo => ({ ...base, id: 'antigravity', provider: 'antigravity', short: 'AG', name: 'Antigravity', ...over });
const claude = (over: Partial<AccountInfo> = {}): AccountInfo => ({ ...base, id: '.claude', short: 'C', name: 'Conta C', configDir: '~/.claude', ...over });
const week = { utilization: 17, resetsAt: NOW + 5 * 24 * HOUR };

describe('cartão do Antigravity com números (AG-28)', () => {
  const usage = { source: 'antigravity' as const, fetchedAt: NOW - 60_000, sevenDay: week, labels: { sevenDay: 'Gemini' }, extra: [{ label: '3p', window: { utilization: 40, resetsAt: NOW + 4 * 24 * HOUR } }] };
  const [card] = renderCards([agy({ usage })], NOW) as [ReturnType<typeof renderCards>[number]];
  const meters = card.all('ui-meter');

  it('não mostra a barra de 5h; só a semanal, com o nome da cota inteiro nas duas formas do rótulo', () => {
    const [five, wk] = meters as [(typeof meters)[number], (typeof meters)[number]];
    expect(five.visible).toBe(false);
    expect(wk.visible).toBe(true);
    expect(wk.one('ui-meter__label-long').textContent).toBe('Gemini');
    expect(wk.one('ui-meter__label-short').textContent).toBe('Gemini');
    expect(wk.one('ui-meter__pct').textContent).toBe('17%');
  });

  it('a coluna do rótulo se alarga para a barra única (is-single)', () => {
    expect(card.one('ui-usage-card__meters').classList.contains('is-single')).toBe(true);
  });

  it('a dica traz a cota principal e as outras como linhas "(semana)", a origem do agy e nenhuma pasta nem sessão de 5 h', () => {
    const rows = tipRows(card);
    const labels = rows.map(([k]) => k);
    expect(rows.find(([k]) => k === 'Gemini (semana)')?.[1]).toMatch(/^17% usado/);
    expect(rows.find(([k]) => k === '3p (semana)')?.[1]).toMatch(/^40% usado/);
    expect(rows.find(([k]) => k === 'Origem')?.[1]).toBe('ao vivo (statusline do agy)');
    expect(labels).not.toContain('Pasta');
    expect(labels).not.toContain('Sessão de 5 h');
    expect(labels).not.toContain('Semana');
  });

  it('a nota da dica diz que é o número do /usage do agy; o passo a passo do Claude Code não aparece', () => {
    const note = card.one('ui-usage-tip__note');
    expect(note.visible).toBe(true);
    expect(note.textContent).toContain('/usage do agy');
    expect(card.one('ui-usage-tip__setup').visible).toBe(false);
  });

  it('as cotas semanais são medidas contra a janela de uma semana, não a de 5 h (leitura de 6 h atrás sem reinício informado segue valendo)', () => {
    const old = { source: 'antigravity' as const, fetchedAt: NOW - 6 * HOUR, sevenDay: { utilization: 25 }, labels: { sevenDay: 'Gemini' }, extra: [{ label: '3p', window: { utilization: 60 } }] };
    const [c] = renderCards([agy({ usage: old, usageStatus: 'stale' })], NOW);
    expect(c!.all('ui-meter')[1]!.one('ui-meter__pct').textContent).toBe('25%');
    const rows = tipRows(c!);
    expect(rows.find(([k]) => k === 'Gemini (semana)')?.[1]).toBe('25% usado');
    expect(rows.find(([k]) => k === '3p (semana)')?.[1]).toBe('60% usado');
  });
});

describe('cartão do Antigravity sem números (AG-28)', () => {
  const [card] = renderCards([agy({ usage: undefined, usageStatus: 'disabled' })], NOW);
  it('manda rodar o instalador com --uso e não oferece "Ativar"', () => {
    expect(card!.one('ui-usage-card__msg').visible).toBe(true);
    expect(card!.one('ui-usage-card__msg-long').textContent).toContain('npm run antigravity:install -- --uso');
    expect(card!.one('ui-usage-card__how').visible).toBe(false);
    expect(card!.one('ui-usage-card__meters').visible).toBe(false);
  });
  it('a dica repete o comando e não mostra o passo a passo do Claude Code', () => {
    expect(card!.one('ui-usage-tip__note').textContent).toContain('npm run antigravity:install -- --uso');
    expect(card!.one('ui-usage-tip__setup').visible).toBe(false);
  });
});

describe('o Claude Code segue como antes', () => {
  const usage = { source: 'statusline' as const, fetchedAt: NOW - 1_000, fiveHour: { utilization: 10, resetsAt: NOW + HOUR }, sevenDay: week };
  const [card] = renderCards([claude({ usage })], NOW);
  it('duas barras (5h e Semana), sem is-single, e as linhas de sempre na dica', () => {
    const [five, wk] = card!.all('ui-meter');
    expect(five!.visible).toBe(true);
    expect(five!.one('ui-meter__label-long').textContent).toBe('5h');
    expect(wk!.one('ui-meter__label-long').textContent).toBe('Semana');
    expect(wk!.one('ui-meter__label-short').textContent).toBe('Sem.');
    expect(card!.one('ui-usage-card__meters').classList.contains('is-single')).toBe(false);
    const labels = tipRows(card!).map(([k]) => k);
    expect(labels).toEqual(expect.arrayContaining(['Pasta', 'Sessão de 5 h', 'Semana']));
    expect(tipRows(card!).find(([k]) => k === 'Origem')?.[1]).toBe('ao vivo (statusline do Claude Code)');
  });
});
