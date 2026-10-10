// Máscara e corte do texto livre do rollout. O único caminho do texto do rollout até a tela é o maskedCut: mascara os
// segredos ANTES de qualquer corte. Aqui também ficam o texto cifrado do Codex (nunca vai à tela) e a máscara das
// entradas de ferramenta que caem no describeTool.
import { maskedCut } from '../../../shared/activity';
import { rec, str, type Rec } from './rollout-util';

// O maskedCut (máscara antes de qualquer corte, com teto fixo) mora no shared/activity.ts, o mesmo do lado do Claude.
export { maskedCut };

/** Tamanho visível do texto de uma atividade (o mesmo corte do shared/activity.ts), para um texto montado aqui. */
export const ACTIVITY_TEXT_MAX = 46;

/**
 * Entradas das descrições compartilhadas (`describeTool`, `SPECIAL`): o texto livre do modelo chega a elas já mascarado
 * pelo maskedCut (o shared/activity.ts também mascara antes de cortar; aqui fica a garantia do lado do Codex). Só texto
 * livre: caminhos e URLs passam como vieram.
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
