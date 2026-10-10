// Construtores SINTÉTICOS do fim de turno do Codex: o task_complete de um turno que termina com erro, no formato do
// TurnCompleteEvent do 0.160.1 (`error: {message, codex_error_info}`; ex.: o limite de uso). A mensagem é inventada;
// nada vem de conversas reais.

const ts = (at: number) => new Date(at).toISOString();

/** Mensagem sintética de um limite de uso atingido. */
export const LIMIT_MESSAGE = 'Limite de uso sintético atingido. Tente de novo mais tarde.';

/** task_complete de um turno que terminou com erro (sem resposta final). */
export function taskCompleteError(turn: string, at: number, durationMs: number, message = LIMIT_MESSAGE, info = 'usage_limit_exceeded'): string {
  return JSON.stringify({
    timestamp: ts(at),
    type: 'event_msg',
    payload: { type: 'task_complete', turn_id: turn, last_agent_message: null, error: { message, codex_error_info: info }, duration_ms: durationMs },
  });
}
