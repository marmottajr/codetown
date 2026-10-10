// Eventos do hook do Antigravity (mod/habblaud-antigravity/hook.mjs, que npm run antigravity:install copia para
// ~/.habblaud/): os cinco eventos do agy chegam aqui e vão para a fonte do Antigravity (AntigravityLive), que atualiza o
// agente na hora. Os eventos só observam, mas só valem vindos do próprio computador: a trava (Host local e conexão
// pelo loopback) é conferida em http/app.ts. O guard (http/guard.ts) já exigiu JSON.
//
//   POST /api/antigravity/events   (hook)   {event, conversationId, workspacePaths?, stepIdx?, fullyIdle?, tool?: {name, head?}}: 200 {ok}
import type { IncomingMessage, ServerResponse } from 'node:http';
import { HttpError, readJson, sendJson } from '../http/app';
import { errMsg, log } from '../log';
import { AG_EVENTS, CONVERSATION_ID_RE, type AgEventName, type AntigravityEvent, type AntigravityLive } from '../sources/antigravity/live';

type Rec = Record<string, unknown>;

const rec = (v: unknown): Rec | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : undefined);

/** Corpo de POST /api/antigravity/events. Evento fora dos cinco ou `conversationId` que não é UUID: 400 (AG-07). */
export function parseAntigravityEvent(raw: unknown): AntigravityEvent {
  const body = rec(raw);
  if (!body || typeof body.event !== 'string' || !AG_EVENTS.includes(body.event as AgEventName)) throw new HttpError(400, 'evento não aceito');
  if (typeof body.conversationId !== 'string' || !CONVERSATION_ID_RE.test(body.conversationId)) throw new HttpError(400, 'conversationId inválido');
  const out: AntigravityEvent = {
    event: body.event as AgEventName,
    conversationId: body.conversationId,
    workspacePaths: Array.isArray(body.workspacePaths) ? body.workspacePaths.filter((p): p is string => typeof p === 'string').slice(0, 8) : [],
  };
  if (Number.isInteger(body.stepIdx)) out.stepIdx = body.stepIdx as number;
  if (typeof body.fullyIdle === 'boolean') out.fullyIdle = body.fullyIdle;
  const tool = rec(body.tool);
  if (tool && typeof tool.name === 'string') out.tool = { name: tool.name.slice(0, 80), ...(typeof tool.head === 'string' ? { head: tool.head.slice(0, 200) } : {}) };
  return out;
}

/** Trata POST /api/antigravity/events (método e Host já conferidos). `ok` = a fonte aproveitou o evento. */
export async function handleAntigravityEvent(req: IncomingMessage, res: ServerResponse, deps: { live?: AntigravityLive }): Promise<void> {
  const event = parseAntigravityEvent(await readJson(req));
  let ok = false;
  if (deps.live) {
    try {
      ok = deps.live.applyHookEvent(event) === true;
    } catch (err) {
      log.warnOnce(`antigravity-event:${errMsg(err)}`, `Eventos do Antigravity: falha ao aplicar um evento (${errMsg(err)}).`);
    }
  }
  sendJson(res, 200, { ok });
}
