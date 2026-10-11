/// <reference types="node" />
// Cartão de uso do Antigravity (uma barra só) com o mesmo tamanho dos de duas linhas (5h / Sem.) e o nome inteiro ("Gemini").
// Sem DOM no vitest (ambiente node): confere as regras de CSS e o código que as aplica.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');
const src = readFileSync(new URL('./usage.ts', import.meta.url), 'utf8');
const rule = (sel: string): string => {
  const m = css.match(new RegExp(`(?:^|\\n)${sel.replace(/[.[\]]/g, '\\$&')}\\s*\\{([^}]*)\\}`));
  return m?.[1] ?? '';
};
const px = (body: string, prop: string): number => Number(body.match(new RegExp(`${prop}:\\s*([\\d.]+)px`))?.[1] ?? NaN);

describe('cartão de uso do Antigravity: tamanho', () => {
  it('altura: uma linha com a altura de duas linhas + vão dos outros cartões', () => {
    const row = px(rule('.ui-meter'), 'height');
    const gap = px(rule('.ui-usage-card__meters'), 'row-gap');
    expect(row).toBe(15);
    expect(px(rule('.ui-usage-card__meters.is-single'), 'min-height')).toBe(2 * row + gap);
  });
  it('largura: o cartão tem uma só largura (nenhuma regra própria do Antigravity)', () => {
    expect(px(rule('.ui-usage-card'), 'width')).toBe(310);
    expect(css).not.toMatch(/data-provider='antigravity'\][^{]*ui-usage-card/);
  });
  it('rótulo: a forma curta leva o nome inteiro e a coluna comporta "Gemini" (mais larga que a de "5h")', () => {
    expect(src).toContain("setText(r.week.labelShort, agy ? weekName : 'Sem.')");
    expect(src).not.toContain('weekName.slice');
    const normal = Number(rule('.ui-usage-card__meters').match(/grid-template-columns:\s*(\d+)px/)?.[1]);
    const single = Number(rule('.ui-usage-card__meters.is-single').match(/grid-template-columns:\s*(\d+)px/)?.[1]);
    expect(single).toBeGreaterThan(normal);
    expect(single).toBeGreaterThanOrEqual(44);
  });
});
