// Idiomas da interface. O português (pt-BR) continua sendo a língua de origem: cada texto é escrito em PT
// e passa por tr(), que devolve a tradução do idioma ativo ou, na falta dela, o próprio texto em PT.
// Assim nada muda para quem usa em português, e uma tradução incompleta nunca quebra a interface.
//
// Escolha do idioma (uma vez, ao carregar este módulo):
// - navegador: preferência salva (Configurações > Idioma), senão os idiomas do navegador;
// - servidor: HABBLAUD_LANG, senão o idioma do sistema (LANG / LC_ALL / Intl).
// Os textos de atividade são montados pelo servidor, então seguem o idioma do servidor.
import { FR } from './locales/fr';

export type Locale = 'pt-BR' | 'fr';

export const LOCALES: { id: Locale; name: string }[] = [
  { id: 'pt-BR', name: 'Português' },
  { id: 'fr', name: 'Français' },
];

/** Chave da preferência salva no navegador. */
export const LOCALE_STORAGE_KEY = 'habblaud:locale';

const DICTS: Record<Locale, Readonly<Record<string, string>> | undefined> = {
  'pt-BR': undefined,
  fr: FR,
};

/** "fr-FR", "fr_CA.UTF-8", "pt", "pt_BR"... -> idioma suportado; undefined se não for nenhum deles. */
export function normalizeLocale(v: string | null | undefined): Locale | undefined {
  const s = (v ?? '').trim().toLowerCase().replace('_', '-');
  if (!s) return undefined;
  if (s === 'fr' || s.startsWith('fr-')) return 'fr';
  if (s === 'pt' || s.startsWith('pt-')) return 'pt-BR';
  return undefined;
}

function detect(): Locale {
  const g = globalThis as {
    window?: unknown;
    localStorage?: { getItem(k: string): string | null };
    navigator?: { languages?: readonly string[]; language?: string };
    process?: { env?: Record<string, string | undefined> };
  };
  if (g.window !== undefined) {
    try {
      const saved = normalizeLocale(g.localStorage?.getItem(LOCALE_STORAGE_KEY));
      if (saved) return saved;
    } catch {
      // localStorage bloqueado (modo privado, iframe): segue para os idiomas do navegador.
    }
    for (const l of g.navigator?.languages ?? [g.navigator?.language ?? '']) {
      const n = normalizeLocale(l);
      if (n) return n;
    }
    return 'pt-BR';
  }
  const env = g.process?.env ?? {};
  // Os testes comparam textos em PT: ficam em PT mesmo numa máquina em outro idioma.
  if (env.VITEST) return normalizeLocale(env.HABBLAUD_LANG_TEST) ?? 'pt-BR';
  for (const v of [env.HABBLAUD_LANG, env.LC_ALL, env.LC_MESSAGES, env.LANG]) {
    const n = normalizeLocale(v);
    if (n) return n;
  }
  try {
    return normalizeLocale(Intl.DateTimeFormat().resolvedOptions().locale) ?? 'pt-BR';
  } catch {
    return 'pt-BR';
  }
}

let current: Locale = detect();

export function getLocale(): Locale {
  return current;
}

/** Troca o idioma ativo (testes; no navegador, a troca pela interface recarrega a página). */
export function setLocale(l: Locale): void {
  current = l;
}

/**
 * Traduz um texto escrito em PT. Lacunas numeradas ({0}, {1}...) recebem `args` na ordem; a tradução pode
 * reordená-las. Sem tradução para o idioma ativo, devolve o texto original.
 */
export function tr(src: string, args?: readonly unknown[]): string {
  const dict = DICTS[current];
  const s = (dict && dict[src]) || src;
  if (!args || args.length === 0) return s;
  return s.replace(/\{(\d+)\}/g, (m, i: string) => (Number(i) < args.length ? String(args[Number(i)]) : m));
}

/** Idioma no formato do Intl (datas, números). */
export function intlLocale(): string {
  return current === 'fr' ? 'fr-FR' : 'pt-BR';
}
