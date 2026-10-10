// Cartão de uso do OpenCode no DOM: o cartão diz "sem dados de cota" e a dica explica por quê (o OpenCode não
// informa cota ao Habblaud), sem mandar instalar nada.
import { afterAll, describe, expect, it } from 'vitest';
import type { AccountInfo } from '../../../shared/types';
import { installFakeDom, renderCards, restoreFakeDom } from './usage-dom-fixture';

installFakeDom();
afterAll(restoreFakeDom);

const oc: AccountInfo = { id: 'opencode', provider: 'opencode', short: 'OC', name: 'OpenCode', color: '#3ddc97', configDir: '~/.config/opencode', sessions: 1, usageStatus: 'disabled' };

describe('cartão de uso do OpenCode', () => {
  const [card] = renderCards([oc], Date.parse('2026-10-10T16:00:00Z'));
  it('o cartão diz "sem dados de cota", sem botão "Ativar"', () => {
    expect(card!.one('ui-usage-card__msg-short').textContent).toBe('sem dados de cota');
    expect(card!.one('ui-usage-card__msg').visible).toBe(true);
    expect(card!.one('ui-usage-card__how').visible).toBe(false);
  });
  it('a dica explica que o OpenCode não informa cota ao Habblaud (e que há vários provedores), sem passo a passo', () => {
    const note = card!.one('ui-usage-tip__note');
    expect(note.visible).toBe(true);
    expect(note.textContent).toContain('o OpenCode não informa cota ao Habblaud');
    expect(note.textContent).toContain('vários provedores');
    expect(note.textContent).toContain('opencode stats');
    expect(note.textContent).toContain('OpenCode Go (5 horas, semanal e mensal, em dólares, por modelo)');
    expect(note.textContent).toContain('console do OpenCode, não em arquivo local');
    expect(note.textContent).toContain('o cartão não mostra barra');
    expect(card!.one('ui-usage-tip__setup').visible).toBe(false);
  });
});
