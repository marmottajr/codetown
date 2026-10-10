import { afterEach, describe, expect, it } from 'vitest';
import { getLocale, intlLocale, normalizeLocale, setLocale, tr } from './i18n';
import { FR } from './locales/fr';

const placeholders = (s: string) => new Set(s.match(/\{\w+\}/g) ?? []);

describe('i18n', () => {
  afterEach(() => setLocale('pt-BR'));

  it('os testes rodam em PT, qualquer que seja o idioma da máquina', () => {
    expect(getLocale()).toBe('pt-BR');
  });

  it('reconhece os formatos de idioma do navegador e do sistema', () => {
    expect(normalizeLocale('fr')).toBe('fr');
    expect(normalizeLocale('fr-CA')).toBe('fr');
    expect(normalizeLocale('fr_FR.UTF-8')).toBe('fr');
    expect(normalizeLocale('pt')).toBe('pt-BR');
    expect(normalizeLocale('pt_PT')).toBe('pt-BR');
    expect(normalizeLocale('en-US')).toBeUndefined();
    expect(normalizeLocale('')).toBeUndefined();
    expect(normalizeLocale(null)).toBeUndefined();
  });

  it('em PT devolve o próprio texto, com as lacunas preenchidas', () => {
    expect(tr('Lendo {0}', ['app.ts'])).toBe('Lendo app.ts');
    expect(tr('Texto que ninguém traduziu')).toBe('Texto que ninguém traduziu');
  });

  it('em francês traduz e pode reordenar as lacunas', () => {
    setLocale('fr');
    expect(tr('Lendo {0}', ['app.ts'])).toBe('Lit app.ts');
    expect(tr('Texto que ninguém traduziu')).toBe('Texto que ninguém traduziu');
    expect(intlLocale()).toBe('fr-FR');
  });

  it('lacunas sem argumento ficam como estão (as nomeadas são preenchidas por quem chama)', () => {
    expect(tr('Ganhei de {a} a {b}! 🏆')).toBe('Ganhei de {a} a {b}! 🏆');
    expect(tr('{0} e {1}', ['um'])).toBe('um e {1}');
  });

  it('a tradução francesa não inventa lacunas que o texto original não tem', () => {
    for (const [pt, fr] of Object.entries(FR)) {
      expect(fr.trim(), pt).not.toBe('');
      const original = placeholders(pt);
      for (const p of placeholders(fr)) expect(original.has(p), `${pt} -> ${fr}`).toBe(true);
    }
  });
});
