// Comandos em segundo plano do Codex, lidos das linhas cruas do rollout (status 'shell'). O C7 não tem sinal de shell,
// então este detector anda ao lado dele, linha a linha, e só diz quando um processo começa a rodar sozinho e quando
// ele termina; quem guarda os processos vivos é o ShellTracker da fonte (o mesmo do Claude).
//
// Unified exec: o exec_command cuja saída diz "Process running with session ID N" (no cabeçalho, antes de
// "\nOutput:\n") deixou o processo N rodando depois de devolver a vez ao modelo; o write_stdin na sessão N cuja saída
// diz "Process exited with code X" e o item_completed CommandExecution com `process_id: "N"` dizem que ele acabou.
// Code mode: o exec (custom tool com JS) cuja saída diz "Script running with cell ID N" deixou a célula N rodando; o
// wait {cell_id: N} cuja saída já não diz "Script running" diz como ela acabou ("Script failed", "Script terminated"
// ou o resto). Um exec_command que termina na própria saída rodou em primeiro plano: não é shell.
//
// O processo é identificado pelo call_id do início (único), nunca pelo número da sessão ou da célula, que se repete
// entre threads e pode voltar depois que o processo morre. Só sai o fim de um processo que este scan viu começar: quase
// todo comando tem um CommandExecution com `process_id`, inclusive os de primeiro plano.
//
// As linhas herdadas de um fork (ordinal < subagent_history_start_ordinal) não contam: o processo é do pai.
import { describeShellJob } from '../../../shared/activity';
import { commandText, contentText, parseArguments } from './rollout';

export type CodexShellStatus = 'completed' | 'failed' | 'killed';

/** `callId` = o call_id da chamada que deixou o processo rodando; `taskId` = "proc:N" (sessão) ou "cell:N" (célula). */
export type CodexShellEvent =
  | { type: 'start'; callId: string; taskId: string; label: string; command?: string }
  | { type: 'end'; callId: string; taskId: string; status: CodexShellStatus; summary?: string };

interface ShellCall {
  name: 'exec_command' | 'write_stdin' | 'wait' | 'exec';
  /** exec_command: o comando desembrulhado. */
  command?: string;
  /** write_stdin: a sessão; wait: a célula. */
  ref?: string;
}

export interface CodexShellScan {
  /** Chamadas de shell ainda sem saída, por call_id (no máximo CALLS_MAX; a mais velha sai). */
  calls: Map<string, ShellCall>;
  /** Processos que este scan viu começar e ainda não viu acabar: "proc:N"/"cell:N" → call_id do início. */
  open: Map<string, string>;
}

const CALLS_MAX = 256;
/** Só as linhas que podem interessar passam pelo JSON.parse. */
const PREFILTER = /"(?:function_call|custom_tool_call|function_call_output|custom_tool_call_output)"|"process_id"/;
const PROC_RUNNING = /^Process running with session ID (\d+)/m;
const PROC_EXITED = /^Process exited with code (-?\d+)/m;
const CELL_RUNNING = /^Script running with cell ID (\S+)/;

type Rec = Record<string, unknown>;

const rec = (v: unknown): Rec | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const idOf = (v: unknown): string | undefined => (typeof v === 'number' && Number.isFinite(v) ? String(v) : str(v)?.trim() || undefined);

export function createShellScan(): CodexShellScan {
  return { calls: new Map(), open: new Map() };
}

/** Texto da saída de uma ferramenta: string, lista de blocos ({type: 'input_text', text}) ou objeto com content/output/body. */
function outputText(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) return contentText(raw).text;
  const o = rec(raw);
  return o ? outputText(o.content ?? o.output ?? o.body ?? '') : '';
}

/** O cabeçalho do unified exec (Chunk ID, Wall time, Process ...), sem a saída do processo. */
function header(text: string): string {
  const cut = text.indexOf('\nOutput:\n');
  return (cut >= 0 ? text.slice(0, cut) : text).slice(0, 2_000);
}

/** Mapa com teto: a entrada nova (ou renovada) vai para o fim e a mais velha sai. */
function capped<T>(map: Map<string, T>, key: string, value: T): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > CALLS_MAX) map.delete(map.keys().next().value as string);
}

function remember(scan: CodexShellScan, callId: string, call: ShellCall): void {
  capped(scan.calls, callId, call);
}

/** Processo que começou a rodar sozinho. A mesma sessão de novo é outro processo (o anterior morreu sem aviso). */
function started(scan: CodexShellScan, callId: string, taskId: string, label: string, command?: string): CodexShellEvent[] {
  capped(scan.open, taskId, callId);
  const ev: CodexShellEvent = { type: 'start', callId, taskId, label };
  if (command) ev.command = command;
  return [ev];
}

/** Fim de um processo: só o de um que este scan viu começar. */
function ended(scan: CodexShellScan, taskId: string, status: CodexShellStatus, summary?: string): CodexShellEvent[] {
  const callId = scan.open.get(taskId);
  if (!callId) return [];
  scan.open.delete(taskId);
  const ev: CodexShellEvent = { type: 'end', callId, taskId, status };
  if (summary) ev.summary = summary;
  return [ev];
}

function onCall(scan: CodexShellScan, p: Rec): void {
  const callId = str(p.call_id);
  const name = str(p.name);
  if (!callId || !name) return;
  if (p.type === 'custom_tool_call') {
    if (name === 'exec') remember(scan, callId, { name: 'exec' });
    return;
  }
  if (name !== 'exec_command' && name !== 'write_stdin' && name !== 'wait') return;
  const args = parseArguments(p.arguments);
  if (name === 'exec_command') {
    const command = commandText(args.cmd);
    remember(scan, callId, command ? { name, command } : { name });
    return;
  }
  // write_stdin {session_id}; wait {cell_id} (o wait do multiagente v1, com `ids`, não é do code mode)
  const ref = idOf(name === 'write_stdin' ? args.session_id : args.cell_id);
  if (ref) remember(scan, callId, { name, ref });
}

function onOutput(scan: CodexShellScan, p: Rec): CodexShellEvent[] {
  const callId = str(p.call_id);
  const call = callId ? scan.calls.get(callId) : undefined;
  if (!callId || !call) return [];
  scan.calls.delete(callId);
  const text = outputText(p.output);
  switch (call.name) {
    case 'exec_command': {
      const session = PROC_RUNNING.exec(header(text))?.[1];
      if (!session) return [];
      const job = describeShellJob('Bash', { command: call.command ?? '' });
      return started(scan, callId, `proc:${session}`, job.label, job.command);
    }
    case 'write_stdin': {
      const code = PROC_EXITED.exec(header(text))?.[1];
      if (code === undefined) return [];
      return ended(scan, `proc:${call.ref}`, Number(code) === 0 ? 'completed' : 'failed', `exit code ${Number(code)}`);
    }
    case 'exec': {
      const cell = CELL_RUNNING.exec(text.trimStart())?.[1];
      return cell ? started(scan, callId, `cell:${cell}`, 'Rodando script') : [];
    }
    case 'wait': {
      const head = text.trimStart();
      if (CELL_RUNNING.test(head)) return [];
      const status: CodexShellStatus = head.startsWith('Script terminated') ? 'killed' : head.startsWith('Script failed') ? 'failed' : 'completed';
      return ended(scan, `cell:${call.ref}`, status);
    }
  }
}

/** item_completed CommandExecution com process_id: o processo da sessão N acabou. */
function onItem(scan: CodexShellScan, p: Rec): CodexShellEvent[] {
  const item = rec(p.item);
  const session = idOf(item?.process_id);
  if (!item || item.type !== 'CommandExecution' || !session) return [];
  const exit = typeof item.exit_code === 'number' && Number.isFinite(item.exit_code) ? item.exit_code : undefined;
  const failed = item.status === 'failed' || (exit !== undefined && exit !== 0);
  return ended(scan, `proc:${session}`, failed ? 'failed' : 'completed', exit !== undefined ? `exit code ${exit}` : undefined);
}

/**
 * Eventos de shell de uma linha crua do rollout. `historyStart` é o subagent_history_start_ordinal do thread (as
 * linhas com ordinal menor são herança do pai). Linha inválida ou sem interesse devolve [].
 */
export function scanShellLine(scan: CodexShellScan, raw: string, opts: { historyStart?: number } = {}): CodexShellEvent[] {
  if (!PREFILTER.test(raw)) return [];
  let j: Rec | undefined;
  try {
    j = rec(JSON.parse(raw));
  } catch {
    return [];
  }
  if (!j) return [];
  const ordinal = typeof j.ordinal === 'number' ? j.ordinal : undefined;
  if (opts.historyStart !== undefined && ordinal !== undefined && ordinal < opts.historyStart) return [];
  const p = rec(j.payload);
  if (!p) return [];
  if (j.type === 'event_msg') return p.type === 'item_completed' ? onItem(scan, p) : [];
  if (j.type !== 'response_item') return [];
  if (p.type === 'function_call' || p.type === 'custom_tool_call') {
    onCall(scan, p);
    return [];
  }
  if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') return onOutput(scan, p);
  return [];
}
