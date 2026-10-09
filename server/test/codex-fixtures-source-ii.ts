// Construtores SINTÉTICOS da Tarefa 15 (CodexSource II): pergunta do request_user_input, spawn_agent e o
// SubAgentActivity do multiagente v2, neto (depth 2) e comandos em segundo plano (unified exec e code mode). Os formatos
// seguem a pesquisa do Codex 0.160.1 (c-rollout.md, c-agents.md §6); nada aqui vem de conversas reais.
import { R } from './codex-fixtures';

const ts = (at: number) => new Date(at).toISOString();

function line(type: string, payload: Record<string, unknown>, at: number): string {
  return JSON.stringify({ timestamp: ts(at), type, payload });
}

/** event_msg item_completed de um TurnItem qualquer. */
export function itemLine(thread: string, turn: string, item: Record<string, unknown>, at: number): string {
  return line('event_msg', { type: 'item_completed', thread_id: thread, turn_id: turn, item, started_at_ms: at - 10, completed_at_ms: at }, at);
}

/** session_meta.source de um neto: subagente (depth 2) de outro subagente. */
export function grandchildSource(parent: string, role = 'worker') {
  return { subagent: { thread_spawn: { parent_thread_id: parent, depth: 2, agent_nickname: 'Hubble', agent_role: role } } };
}

export const Q = {
  /** request_user_input (a pergunta síncrona) ainda sem output. */
  ask(callId: string, question: string, at: number): string {
    return R.functionCall(callId, 'request_user_input', { questions: [{ id: 'q1', header: 'Dúvida', question, options: [{ label: 'Sim' }, { label: 'Não' }] }] }, at);
  },
  /** O output do request_user_input: a resposta chegou. */
  answer(callId: string, at: number): string {
    return R.functionOutput(callId, '{"answers":{"q1":{"answers":["Sim"]}}}', at);
  },
};

export const S = {
  /** spawn_agent do multiagente v2 (namespace collaboration). */
  spawnAgent(callId: string, message: string, at: number, taskName = 'tarefa_sintetica'): string {
    return R.functionCall(callId, 'spawn_agent', { task_name: taskName, message, agent_type: 'worker', fork_turns: 'none' }, at, 'collaboration');
  },
  /** SubAgentActivity started (no rollout do pai): o filho nasceu, com o id do thread dele. */
  started(thread: string, turn: string, callId: string, child: string, at: number, taskName = 'tarefa_sintetica'): string {
    return itemLine(thread, turn, { type: 'SubAgentActivity', id: callId, kind: 'started', agent_thread_id: child, agent_path: `/root/${taskName}` }, at);
  },
};

export const B = {
  /** exec_command (unified exec). */
  exec(callId: string, cmd: string, at: number): string {
    return R.functionCall(callId, 'exec_command', { cmd, workdir: '/projetos/loja', yield_time_ms: 10_000, max_output_tokens: 4_000 }, at);
  },
  /** Saída do exec_command (ou do write_stdin) com o processo ainda vivo: "Process running with session ID N". */
  running(callId: string, session: number, at: number, output = 'ouvindo na porta 5173'): string {
    return R.functionOutput(callId, `Chunk ID: c${session}\nWall time: 10.0 seconds\nProcess running with session ID ${session}\nOriginal token count: 4\nOutput:\n${output}`, at);
  },
  /** Saída com o processo encerrado: "Process exited with code N". */
  exited(callId: string, code: number, at: number, output = 'fim'): string {
    return R.functionOutput(callId, `Chunk ID: e${code}\nWall time: 1.0 seconds\nProcess exited with code ${code}\nOriginal token count: 2\nOutput:\n${output}`, at);
  },
  /** write_stdin na sessão N (chars vazio = só ler). */
  stdin(callId: string, session: number, at: number): string {
    return R.functionCall(callId, 'write_stdin', { session_id: session, chars: '', yield_time_ms: 30_000, max_output_tokens: 4_000 }, at);
  },
  /** item_completed CommandExecution do processo da sessão N, quando ele termina. */
  procDone(thread: string, turn: string, id: string, session: number, exit: number, at: number, script = 'npm run dev'): string {
    return itemLine(
      thread,
      turn,
      {
        type: 'CommandExecution',
        id,
        process_id: String(session),
        command: ['/bin/zsh', '-lc', script],
        cwd: 'file:///projetos/loja',
        parsed_cmd: [{ type: 'unknown', cmd: script }],
        source: 'unified_exec_startup',
        status: exit === 0 ? 'completed' : 'failed',
        aggregated_output: '',
        exit_code: exit,
        duration: { secs: 48, nanos: 0 },
      },
      at,
    );
  },
  /** exec do code mode (custom tool com JS). */
  code(callId: string, js: string, at: number): string {
    return R.customToolCall(callId, 'exec', js, at);
  },
  /** Saída do exec do code mode (lista de input_text), ex.: "Script running with cell ID N". */
  codeOutput(callId: string, text: string, at: number): string {
    return line('response_item', { type: 'custom_tool_call_output', call_id: callId, output: [{ type: 'input_text', text }] }, at);
  },
  /** wait {cell_id} do code mode. */
  wait(callId: string, cell: string, at: number): string {
    return R.functionCall(callId, 'wait', { cell_id: cell, yield_time_ms: 30_000, max_tokens: 2_000 }, at);
  },
  /** Saída do wait (lista de input_text). */
  waitOutput(callId: string, text: string, at: number): string {
    return line('response_item', { type: 'function_call_output', call_id: callId, output: [{ type: 'input_text', text }] }, at);
  },
};

/** A mesma linha com `ordinal` (para a herança de um fork: ordinal < subagent_history_start_ordinal). */
export function withOrdinal(raw: string, ordinal: number): string {
  const j = JSON.parse(raw) as Record<string, unknown>;
  return JSON.stringify({ timestamp: j.timestamp, ordinal, type: j.type, payload: j.payload });
}
