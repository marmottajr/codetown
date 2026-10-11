// Nome da ferramenta do Antigravity (+ o texto curto que o hook extraiu dos args) -> atividade legível, com os MESMOS
// rótulos do Claude Code/Codex (shared/activity.ts). Só chegam aqui o nome e um texto curto (comando, caminho, padrão):
// o resto dos args, a saída e o transcript nunca são lidos (AG-05).
import { describeTool, truncate, type ActivityDescription } from '../../../shared/activity';

/** Atividade genérica de "trabalhando" (sem ferramenta). */
export const GENERIC_WORKING: ActivityDescription = { kind: 'other', icon: '⚙️', text: 'Trabalhando' };

/** Ferramenta do agy -> ferramenta do Claude Code e o campo da entrada que o texto curto representa. */
const TOOLS: Record<string, [claude: string, field: string]> = {
  run_command: ['Bash', 'command'],
  view_file: ['Read', 'file_path'],
  write_to_file: ['Write', 'file_path'],
  replace_file_content: ['Edit', 'file_path'],
  multi_replace_file_content: ['MultiEdit', 'file_path'],
  sed_file: ['Edit', 'file_path'],
  grep_search: ['Grep', 'pattern'],
  find_by_name: ['Glob', 'pattern'],
  list_dir: ['LS', 'path'],
  read_url_content: ['WebFetch', 'url'],
  search_web: ['WebSearch', 'query'],
  invoke_subagent: ['Agent', 'description'],
  browser_subagent: ['Agent', 'description'],
};

/** Só o que cabe num nome de ferramenta (o valor vem de fora, não é de confiança). */
function safeName(name: string): string {
  return truncate(name.replace(/[^\w.:-]/g, '').slice(0, 40), 40) || 'ferramenta';
}

/** Atividade de uma ferramenta pelo nome e texto curto; `tool` é o nome canônico (o do Claude Code, ou o próprio nome). */
export function describeAntigravityTool(name: string, head?: string): { desc: ActivityDescription; tool: string } {
  const key = name.toLowerCase();
  const known = Object.hasOwn(TOOLS, key) ? TOOLS[key] : undefined;
  if (known) {
    const [claude, field] = known;
    const value = head?.trim();
    return { desc: describeTool(claude, value ? { [field]: value } : {}), tool: claude };
  }
  const clean = safeName(name);
  return { desc: describeTool(clean, {}), tool: clean };
}
