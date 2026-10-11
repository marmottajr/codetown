// Pedidos de aprovação do OpenCode (evento permission.asked / permission.updated, mandado por
// mod/habblaud-opencode/plugin.js): título, resumo e argumentos pelo nome da permissão do OpenCode (bash, edit, read,
// glob, grep, list, webfetch, websearch, task, external_directory, ...).
//
// O plugin manda `tool_name` = a permissão (v1: `type`) e `tool_input` = {patterns: string[], metadata?, title?}:
// - patterns: o que está sendo pedido (comando, caminho, URL...); a lista inteira vai no detalhe;
// - metadata: dados que o OpenCode junta ao pedido; só dois campos são lidos: `command` (Bash) e `filepath`/`diff`
//   (edições). O resto é ignorado.
// Tudo mascarado (maskSecrets) e cortado como no terminal.
import { describeTool, maskSecrets, truncate } from '../../shared/activity';
import { ASK_TOOL } from '../../shared/answers';
import type { AskQuestion, TerminalInputKind } from '../../shared/types';
import { describeOpencodeTool } from '../sources/opencode/activity';
import { TITLE_ARG_MAX, toolView } from '../sources/terminal';

/** Resumo de um pedido do OpenCode: o que vai em PermissionRequestInfo (title, text, icon, input, inputKind). */
export interface OpencodeToolView {
  title: string;
  text: string;
  icon: string;
  input?: string;
  inputKind?: TerminalInputKind;
  /** Só nas perguntas (AskUserQuestion): as perguntas para o cartão, como no Claude Code. */
  questions?: AskQuestion[];
}

type Rec = Record<string, unknown>;

const TEXT_MAX = 46;
/** Quantos padrões entram no detalhe. */
const PATTERNS_MAX = 20;

const rec = (v: unknown): Rec | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined);

/** Uma linha mascarada e cortada. */
function line(s: string, max: number): string {
  return truncate(maskSecrets(s.slice(0, max * 8)), max);
}

/** Texto mascarado e cortado como o terminal mostra os argumentos (o mesmo tratamento do comando do Bash). */
function shown(raw: string | undefined, inputKind: TerminalInputKind): Pick<OpencodeToolView, 'input' | 'inputKind'> {
  const input = raw?.trim() ? toolView('Bash', { command: raw }).input : undefined;
  return input ? { input, inputKind } : {};
}

/** Os padrões do pedido (só textos, em número limitado). */
export function patternsOf(input: Rec): string[] {
  const list = Array.isArray(input.patterns) ? input.patterns : typeof input.pattern === 'string' ? [input.pattern] : [];
  return list.filter((p): p is string => typeof p === 'string' && !!p.trim()).slice(0, PATTERNS_MAX);
}

/** Título, resumo e argumentos de um pedido do OpenCode. */
export function opencodeToolView(tool: string, input: Rec, cwd?: string): OpencodeToolView {
  const patterns = patternsOf(input);
  const meta = rec(input.metadata);
  const first = patterns[0] ?? str(input.title);
  const name = tool.toLowerCase();
  if (tool === ASK_TOOL) {
    // A pergunta do OpenCode (tool question), repassada pelo plugin no formato do AskUserQuestion do Claude Code.
    const desc = describeTool(ASK_TOOL, input);
    return { title: toolView(ASK_TOOL, input, cwd).title, text: desc.text, icon: desc.icon, ...('questions' in desc && desc.questions ? { questions: desc.questions } : {}) };
  }
  switch (name) {
    case 'bash': {
      const command = str(meta?.command) ?? (patterns.length ? patterns.join('\n') : undefined);
      const view = toolView('Bash', { command: command ?? '' }, cwd);
      const desc = describeTool('Bash', { command: command ?? '', description: str(meta?.description) });
      return { title: view.title, text: desc.text, icon: desc.icon, ...shown(command, 'command') };
    }
    case 'edit':
    case 'write':
    case 'patch':
    case 'apply_patch':
    case 'multiedit': {
      const file = str(meta?.filepath) ?? first;
      const diff = str(meta?.diff);
      const base = file ? (file.split('/').filter(Boolean).pop() ?? file) : '';
      return {
        title: file ? `${tool}(${line(file, TITLE_ARG_MAX)})` : tool,
        text: truncate(base ? `Editando ${line(base, TEXT_MAX)}` : 'Editando um arquivo', TEXT_MAX),
        icon: '✏️',
        ...(diff ? shown(diff, 'diff') : shown(patterns.join('\n'), 'text')),
      };
    }
    case 'external_directory':
      return { title: first ? `external_directory(${line(first, TITLE_ARG_MAX)})` : 'external_directory', text: 'Acessar uma pasta fora do projeto', icon: '📂', ...shown(patterns.join('\n'), 'text') };
    default: {
      const { desc } = describeOpencodeTool(tool, first);
      const clean = tool.replace(/[^\w.:-]/g, '').slice(0, 40) || 'ferramenta';
      return { title: first ? `${clean}(${line(first, TITLE_ARG_MAX)})` : clean, text: desc.text, icon: desc.icon, ...shown(patterns.join('\n'), 'text') };
    }
  }
}
