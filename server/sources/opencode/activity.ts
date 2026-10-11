// Nome da ferramenta do OpenCode (+ `state.title`) -> atividade legível, com os MESMOS rótulos do Claude Code/Codex
// (shared/activity.ts). Só chegam aqui o tipo da parte, o nome da ferramenta e o título curto (`state.title`, que o
// OpenCode preenche com o arquivo, o padrão, a URL ou o comando): a entrada completa e a saída nunca são lidas.
import { describeTool, SPECIAL, truncate, type ActivityDescription } from '../../../shared/activity';
import type { OcPart } from './files';

/** Atividade genérica de "trabalhando" (parte sem `state`, tipo desconhecido). */
export const GENERIC_WORKING: ActivityDescription = { kind: 'other', icon: '⚙️', text: 'Trabalhando' };

/** Ferramenta do OpenCode (minúsculas) -> ferramenta do Claude Code e o campo da entrada que o título representa. */
const TOOLS: Record<string, [claude: string, field: string]> = {
  bash: ['Bash', 'command'],
  read: ['Read', 'file_path'],
  edit: ['Edit', 'file_path'],
  multiedit: ['MultiEdit', 'file_path'],
  patch: ['Edit', 'file_path'],
  apply_patch: ['Edit', 'file_path'],
  write: ['Write', 'file_path'],
  grep: ['Grep', 'pattern'],
  glob: ['Glob', 'pattern'],
  list: ['LS', 'path'],
  ls: ['LS', 'path'],
  webfetch: ['WebFetch', 'url'],
  websearch: ['WebSearch', 'query'],
  codesearch: ['WebSearch', 'query'],
  task: ['Agent', 'description'],
  todowrite: ['TodoWrite', 'todos'],
  todoread: ['TodoWrite', 'todos'],
  skill: ['Skill', 'skill'],
};

/** Só o que cabe num nome de ferramenta (o valor vem do banco, não é de confiança). */
function safeName(name: string): string {
  return truncate(name.replace(/[^\w.:-]/g, '').slice(0, 40), 40) || 'ferramenta';
}

/** Atividade de uma ferramenta pelo nome e título; `tool` é o nome canônico (o do Claude Code, ou o próprio nome). */
export function describeOpencodeTool(name: string, title?: string): { desc: ActivityDescription; tool: string } {
  const known = Object.hasOwn(TOOLS, name.toLowerCase()) ? TOOLS[name.toLowerCase()] : undefined;
  if (known) {
    const [claude, field] = known;
    const value = title?.trim();
    // TodoWrite não tem texto no título que sirva de lista de tarefas: sem entrada.
    const input = value && field !== 'todos' ? { [field]: value } : {};
    return { desc: describeTool(claude, input), tool: claude };
  }
  const clean = safeName(name);
  return { desc: describeTool(clean, {}), tool: clean };
}

/**
 * Atividade da última parte de uma sessão que está trabalhando: `tool` -> a ferramenta; `reasoning` -> "Pensando…";
 * `text` -> "Escrevendo a resposta"; parte `tool` sem `state` ou tipo desconhecido -> o genérico "Trabalhando".
 */
export function describeOpencodePart(part: Pick<OcPart, 'type' | 'tool' | 'title' | 'hasState'> | undefined): { desc: ActivityDescription; tool?: string } {
  if (!part) return { desc: GENERIC_WORKING };
  if (part.type === 'tool') {
    if (!part.tool || !part.hasState) return { desc: GENERIC_WORKING };
    return describeOpencodeTool(part.tool, part.title);
  }
  if (part.type === 'reasoning') return { desc: SPECIAL.think() };
  if (part.type === 'text') return { desc: SPECIAL.respond() };
  return { desc: GENERIC_WORKING };
}
