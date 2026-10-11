// Eventos do hook do Antigravity CLI (`agy`): mod/habblaud-antigravity/hook.mjs manda cada um para
// POST /api/antigravity/events e a rota (server/antigravity/http.ts) repassa aqui. A fonte (source.ts) implementa.
// Contrato dos hooks: docs/hooks.md embutido no agy 1.3.3 (~/.gemini/antigravity-cli/builtin/skills/agy-customizations).

/** Os cinco eventos que o agy dispara. */
export const AG_EVENTS = ['PreInvocation', 'PostInvocation', 'PreToolUse', 'PostToolUse', 'Stop'] as const;
export type AgEventName = (typeof AG_EVENTS)[number];

/** O que o hook manda: só o necessário (nunca o texto do pedido, a saída das ferramentas nem o transcript). */
export interface AntigravityEvent {
  event: AgEventName;
  conversationId: string;
  workspacePaths: string[];
  /** Passo da conversa (PreToolUse/PostToolUse): serve de id da atividade, para o mesmo evento duas vezes não repetir. */
  stepIdx?: number;
  /** Stop: false = ainda há tarefas em segundo plano (o agente segue trabalhando). */
  fullyIdle?: boolean;
  /** PreToolUse: nome da ferramenta e o texto curto que a descreve (comando, arquivo, padrão...). */
  tool?: { name: string; head?: string };
}

export interface AntigravityLive {
  /** Aplica um evento ao escritório na hora. Idempotente. Devolve false se o evento não pôde ser aproveitado. */
  applyHookEvent(event: AntigravityEvent): boolean;
}

/** Id de conversa do agy: UUID (docs: `conversation_id`). */
export const CONVERSATION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
