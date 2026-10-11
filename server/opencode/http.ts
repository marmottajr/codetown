// Eventos do plugin do OpenCode (mod/habblaud-opencode/plugin.js, que npm run opencode:install copia para
// ~/.config/opencode/plugins/): session.status, session.idle, todo.updated, permission.asked/permission.updated e
// tool.execute.before/after chegam aqui e vão para a fonte do OpenCode (OpencodeLive), que atualiza o agente na hora.
// Os eventos só observam, mas só valem vindos do próprio computador: a trava (Host local e conexão pelo loopback) é
// conferida em http/app.ts. O guard (http/guard.ts) já exigiu JSON.
//
//   POST /api/opencode/events   (plugin)   {event: {type, properties: {sessionID, ...}}}: 200 {ok}
import type { IncomingMessage, ServerResponse } from 'node:http';
import { HttpError, readJson, sendJson } from '../http/app';
import { errMsg, log } from '../log';
import { SESSION_ID_RE, type OpencodeEvent, type OpencodeLive } from '../sources/opencode/live';

type Rec = Record<string, unknown>;

/** Só estes tipos de evento são aceitos (OC-15). */
export const OPENCODE_EVENT_TYPES: ReadonlySet<string> = new Set([
  'session.status',
  'session.idle',
  'todo.updated',
  'permission.asked',
  'permission.updated',
  'tool.execute.before',
  'tool.execute.after',
  'question.asked',
  'question.replied',
  'question.rejected',
]);

const rec = (v: unknown): Rec | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : undefined);

/** Corpo de POST /api/opencode/events. Sem `event` válido, tipo fora da lista ou `sessionID` inválido: 400. */
export function parseOpencodeEvent(raw: unknown): OpencodeEvent {
  const event = rec(rec(raw)?.event);
  if (!event || typeof event.type !== 'string') throw new HttpError(400, 'esperado {event: {type, properties: {sessionID, ...}}}');
  if (!OPENCODE_EVENT_TYPES.has(event.type)) throw new HttpError(400, 'tipo de evento não aceito');
  const properties = rec(event.properties);
  if (!properties) throw new HttpError(400, 'esperado event.properties (objeto)');
  if (typeof properties.sessionID !== 'string' || !SESSION_ID_RE.test(properties.sessionID)) throw new HttpError(400, 'sessionID inválido');
  return { type: event.type, properties };
}

/** Trata POST /api/opencode/events (método e Host já conferidos). `ok` = a fonte do OpenCode aproveitou o evento. */
export async function handleOpencodeEvent(req: IncomingMessage, res: ServerResponse, deps: { live?: OpencodeLive; releaseQuestions?: (sessionId: string) => void }): Promise<void> {
  const event = parseOpencodeEvent(await readJson(req));
  let ok = false;
  if (deps.live) {
    try {
      ok = deps.live.applyHookEvent(event) === true;
    } catch (err) {
      log.warnOnce(`opencode-event:${errMsg(err)}`, `Eventos do OpenCode: falha ao aplicar um evento (${errMsg(err)}).`);
    }
  }
  // A pergunta foi respondida (ou recusada) no OpenCode: o cartão que o escritório tinha dela some (OQ-16).
  if (deps.releaseQuestions && (event.type === 'question.replied' || event.type === 'question.rejected')) {
    try {
      deps.releaseQuestions(String(event.properties.sessionID));
    } catch (err) {
      log.warnOnce(`opencode-question-release:${errMsg(err)}`, `Eventos do OpenCode: falha ao liberar as perguntas da sessão (${errMsg(err)}).`);
    }
  }
  sendJson(res, 200, { ok });
}
