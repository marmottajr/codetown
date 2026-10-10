// Cartão de uso do Antigravity: o agy tem uso (/usage), mas o Habblaud ainda não o lê; o cartão manda ver o /usage do agy e
// não oferece "Ativar" nem o passo a passo do Claude Code. Claude Code e Codex seguem como em usage-source.test.ts.
import { describe, expect, it } from 'vitest';
import { usageHowVisible, usageMessage, usageSetupVisible } from './usage';

describe('cartão de uso: Antigravity', () => {
  const ag = { usageStatus: 'ok' as const, provider: 'antigravity' as const };
  it('sem botão Ativar, mensagem neutra e sem o passo a passo da dica', () => {
    expect(usageHowVisible(ag)).toBe(false);
    expect(usageMessage(ag)).toEqual(['o uso do Antigravity fica no /usage do agy; o Habblaud ainda não mostra esse número', 'veja /usage']);
    expect(usageSetupVisible(ag)).toBe(false);
  });
  it('o Claude Code sem uso continua com o botão e a mensagem de antes', () => {
    const cl = { usageStatus: 'ok' as const, provider: 'claude' as const };
    expect(usageHowVisible(cl)).toBe(true);
    expect(usageMessage(cl)).toEqual(['sem dados de uso', 'sem dados']);
    expect(usageSetupVisible(cl)).toBe(true);
  });
});
