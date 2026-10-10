// Máscara e corte do texto livre do rollout. O único caminho do texto do rollout até a tela é o maskedCut: mascara os
// segredos ANTES de qualquer corte. Aqui também ficam o texto cifrado do Codex (nunca vai à tela) e a máscara das
// entradas de ferramenta que caem no describeTool.
import { maskSecrets, truncate } from '../../../shared/activity';
import { rec, str, type Rec } from './rollout-util';

/**
 * Teto (em caracteres) do texto que passa pela máscara antes de qualquer corte visível. É alto e fixo de propósito: o
 * que aparece na tela vem de muito além do tamanho visível (a máscara encolhe um token de 300 caracteres para 6 e os
 * brancos colapsam), então um recorte "proporcional" ao tamanho visível deixaria um pedaço de token sem máscara.
 */
const MASK_CEILING = 16 * 1024;
const BLANK = /\s/;
/** Tamanho visível do texto de uma atividade (o mesmo corte do shared/activity.ts), para um texto montado aqui. */
export const ACTIVITY_TEXT_MAX = 46;

/**
 * O único caminho do texto livre do rollout até a tela: mascara os segredos ANTES de qualquer corte (um token cortado
 * ao meio não casa com a máscara e o começo dele vazaria) e só então trunca para o tamanho visível `max`; sem `max`,
 * devolve o texto mascarado inteiro, para quem corta adiante. O recorte prévio só evita rodar as expressões sobre
 * blocos enormes: acima do teto vai no último espaço em branco antes dele (não deixa um token pela metade no fim);
 * sem nenhum espaço, corta no próprio teto.
 */
export function maskedCut(text: string, max?: number): string {
  let head = text;
  if (text.length > MASK_CEILING) {
    let end = MASK_CEILING;
    while (end > 0 && !BLANK.test(text[end])) end--;
    head = text.slice(0, end > 0 ? end : MASK_CEILING);
  }
  const masked = maskSecrets(head);
  return max === undefined ? masked : truncate(masked, max);
}

/**
 * Entradas das descrições compartilhadas (`describeTool`, `SPECIAL`): o shared/activity.ts corta o texto que recebe
 * (`truncate(q, 28)`, `slice(0, 368)`, `slice(0, 1200)`...) ANTES de mascarar, então o texto livre do modelo tem de
 * chegar já mascarado. Só texto livre: caminhos e URLs passam como vieram.
 */
export function maskedText(v: unknown): string | undefined {
  return typeof v === 'string' ? maskedCut(v) : undefined;
}

const maskedValue = (v: unknown): unknown => (typeof v === 'string' ? maskedCut(v) : v);

/** Texto cifrado pelo Codex (0.160.1: a mensagem do multiagente vem como token Fernet, `gAAAAA` + base64 url-safe). */
const ENCRYPTED = /^gAAAAA[A-Za-z0-9_-]{20,}={0,2}$/;

/** O texto é cifrado (ilegível): nunca vai à tela, nem como título, atividade ou entrada do terminal. */
export function isEncryptedText(text: string): boolean {
  return ENCRYPTED.test(text.trim());
}

/** O texto, se for legível: nem vazio, nem cifrado. */
export function plainText(v: unknown): string | undefined {
  const s = str(v);
  return s && !isEncryptedText(s) ? s : undefined;
}

/** `questions` de um AskUserQuestion com pergunta, cabeçalho e opções (rótulo e descrição) mascarados; as posições ficam. */
export function maskedQuestions(raw: unknown): unknown {
  if (!Array.isArray(raw)) return raw;
  return raw.map((q) => {
    const question = rec(q);
    if (!question) return q;
    const options = Array.isArray(question.options)
      ? question.options.map((o) => {
          const option = rec(o);
          return option ? { ...option, label: maskedValue(option.label), description: maskedValue(option.description) } : o;
        })
      : question.options;
    return { ...question, question: maskedValue(question.question), header: maskedValue(question.header), options };
  });
}

/** Chaves cujo valor é caminho ou URL (não é texto livre). */
const PATH_KEYS = new Set(['file_path', 'notebook_path', 'path', 'url']);

/** Entrada de uma ferramenta que cai no `describeTool` pelo nome: cada texto livre (1º nível) e as perguntas, mascarados. */
export function maskedInput(input: Rec): Rec {
  const out: Rec = {};
  for (const [key, value] of Object.entries(input)) out[key] = key === 'questions' ? maskedQuestions(value) : PATH_KEYS.has(key) ? value : maskedValue(value);
  return out;
}
