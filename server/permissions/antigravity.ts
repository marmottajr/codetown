// Pedidos de aprovação do Antigravity (hook PreToolUse de mod/habblaud-antigravity/hook.mjs, só com `--aprovar` e só
// para `run_command`): título, resumo e argumentos como o Bash do Claude Code. O hook manda `tool_name` = `run_command` e
// `tool_input` = {command, cwd?}; o resto dos args do agy não é repassado. Tudo mascarado (maskSecrets) e cortado como no
// terminal. Outras ferramentas (não chegam do hook hoje) viram um resumo genérico.
import { describeTool } from '../../shared/activity';
import type { TerminalInputKind } from '../../shared/types';
import { describeAntigravityTool } from '../sources/antigravity/activity';
import { toolView } from '../sources/terminal';

/** Resumo de um pedido do Antigravity: o que vai em PermissionRequestInfo (title, text, icon, input, inputKind). */
export interface AntigravityToolView {
  title: string;
  text: string;
  icon: string;
  input?: string;
  inputKind?: TerminalInputKind;
}

type Rec = Record<string, unknown>;

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined);

/** Título, resumo e argumentos de um pedido do Antigravity. */
export function antigravityToolView(tool: string, input: Rec, cwd?: string): AntigravityToolView {
  const name = tool.toLowerCase();
  if (name === 'run_command') {
    const command = str(input.command) ?? '';
    const view = toolView('Bash', { command }, cwd);
    const desc = describeTool('Bash', { command });
    return { title: view.title, text: desc.text, icon: desc.icon, ...(view.input ? { input: view.input, inputKind: view.inputKind } : {}) };
  }
  const { desc, tool: clean } = describeAntigravityTool(tool, str(input.command));
  return { title: clean, text: desc.text, icon: desc.icon };
}
