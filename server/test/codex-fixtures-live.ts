// Construtores SINTÉTICOS dos formatos vistos na validação ao vivo com o Codex 0.160.1 (T18): mensagem do multiagente
// cifrada (token no formato Fernet), o envelope "Message Type: NEW_TASK…" que o filho recebe e o comando encerrado no
// fim do turno. Só a forma segue o observado; nomes, tarefas e tokens são inventados (nada vem de conversas reais).
import { R } from './codex-fixtures';

const ts = (at: number) => new Date(at).toISOString();

/** Texto cifrado sintético no formato de um token Fernet (`gAAAAA` + base64 url-safe, longo). */
export function fernet(seed = 'sintetico'): string {
  return `gAAAAAB${Buffer.from(`habblaud-teste-${seed}-`.repeat(12)).toString('base64url')}`;
}

/** spawn_agent do 0.160.1: a mensagem vem cifrada; só o task_name e o tipo ficam legíveis. */
export function spawnEncrypted(callId: string, taskName: string, at: number, agentType = 'explorer'): string {
  return R.functionCall(callId, 'spawn_agent', { task_name: taskName, agent_type: agentType, fork_turns: 'all', message: fernet(callId) }, at, 'collaboration');
}

/** send_message do 0.160.1 com a mensagem cifrada. */
export function sendEncrypted(callId: string, target: string, at: number): string {
  return R.functionCall(callId, 'send_message', { target, message: fernet(callId) }, at, 'collaboration');
}

/**
 * agent_message com o envelope do 0.160.1 (gravado no rollout de quem recebe): o cabeçalho num bloco de texto e o
 * conteúdo num bloco `encrypted_content` à parte; `payload` em claro só se a versão o mandar assim.
 */
export function envelope(o: { recipient: string; sender: string; type?: string; payload?: string; at: number }): string {
  const text = `Message Type: ${o.type ?? 'NEW_TASK'}\nTask name: ${o.recipient}\nSender: ${o.sender}\nPayload:\n${o.payload ?? ''}`;
  return JSON.stringify({
    timestamp: ts(o.at),
    type: 'response_item',
    payload: {
      type: 'agent_message',
      id: 'amsg_sintetico',
      author: o.sender,
      recipient: o.recipient,
      content: [
        { type: 'input_text', text },
        { type: 'encrypted_content', encrypted_content: fernet(o.recipient) },
      ],
    },
  });
}
