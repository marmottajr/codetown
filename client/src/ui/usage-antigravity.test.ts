// Cartão de uso do Antigravity: o agy não tem cota única, então o cartão diz "sem cota" e não oferece "Ativar" nem o
// passo a passo do Claude Code (igual ao OpenCode). Claude Code e Codex seguem como em usage-source.test.ts.
import { describe, expect, it } from 'vitest';
import { usageHowVisible, usageMessage, usageSetupVisible } from './usage';

describe('cartão de uso: Antigravity', () => {
  const ag = { usageStatus: 'ok' as const, provider: 'antigravity' as const };
  it('sem botão Ativar, mensagem neutra e sem o passo a passo da dica', () => {
    expect(usageHowVisible(ag)).toBe(false);
    expect(usageMessage(ag)).toEqual(['o Antigravity não tem cota única', 'sem cota']);
    expect(usageSetupVisible(ag)).toBe(false);
  });
  it('o Claude Code sem uso continua com o botão e a mensagem de antes', () => {
    const cl = { usageStatus: 'ok' as const, provider: 'claude' as const };
    expect(usageHowVisible(cl)).toBe(true);
    expect(usageMessage(cl)).toEqual(['sem dados de uso', 'sem dados']);
    expect(usageSetupVisible(cl)).toBe(true);
  });
});
