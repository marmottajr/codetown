// Eventos do plugin do OpenCode (a parte "ao vivo" da fonte do OpenCode): o plugin (mod/habblaud-opencode/plugin.js)
// manda cada evento para POST /api/opencode/events e a rota (server/opencode/http.ts) repassa aqui. A fonte do
// OpenCode (sources/opencode/source.ts) implementa.

/** Evento do plugin: o `event` do OpenCode (`type` + `properties`), ou o par de ferramenta (tool.execute.before/after). */
export interface OpencodeEvent {
  type: string;
  properties: Record<string, unknown>;
}

export interface OpencodeLive {
  /**
   * Aplica um evento ao escritório na hora, sem esperar o próximo ciclo de leitura do banco. Idempotente: o mesmo evento
   * duas vezes dá o mesmo estado. Devolve false para evento desconhecido ou sessão que a fonte não conhece.
   */
  applyHookEvent(event: OpencodeEvent): boolean;
}

/** Id de sessão do OpenCode: `ses_` + 26 caracteres (OC-18). */
export const SESSION_ID_RE = /^ses_[A-Za-z0-9]{26}$/;
