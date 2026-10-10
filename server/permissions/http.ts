// Rotas de /api/permissions (responder pelo escritório). A trava (bind local + Host local) já foi
// conferida em http/app.ts; o guard (http/guard.ts) já exigiu JSON e Origin local nos POST (contra CSRF).
//
//   POST /api/permissions                 (hook)    registra o pedido: 201 {id, expiresAt} ou 200 {skip}
//                                                   (o hook do Codex manda também provider: "codex", account e codexHome;
//                                                   numa thread do canal paralelo: 200 {skip: "parallel"})
//   GET  /api/permissions/:id/wait        (hook)    long-poll: {status: pending | decided | released}
//   GET  /api/permissions/:id             (página)  detalhe com os argumentos (comando, diff...)
//   POST /api/permissions/:id/decision    (página)  {behavior: allow | deny | terminal | answer, message?, answers?, forSession?, ...}
//                                                   (pedido 'parallel': a decisão vai ao app-server do Codex; 503 = canal fora)
//
// As chamadas do hook do Codex (o registro com provider "codex" e a espera dos pedidos que ele registrou) passam pela
// guarda do hook (verifyHookCall, codex/http.ts): de fora do loopback só com nonce e prova da chave local (senão 403,
// sem efeito nenhum), e com a prova a resposta leva a do servidor, sem a qual o hook não decide. As do hook do Claude
// nunca: no Docker elas também chegam pelo gateway e sem prova.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { type CodexHookAuth, verifyHookCall } from '../codex/http';
import { HttpError, readJson, sendJson } from '../http/app';
import { log } from '../log';
import { InvalidRequest, parseDecision, WAIT_MAX_MS, type PermissionRegistry } from './registry';

const ITEM = /^\/api\/permissions\/([^/]+)(?:\/(wait|decision))?$/;
/** Sem a guarda do processo: só o loopback (nenhuma chave, nenhuma prova vale). */
const LOOPBACK_ONLY: CodexHookAuth = { key: undefined, check: () => false, inDocker: false };
/** Ids do hook do Codex lembrados, bem acima de MAX_PENDING: o mais antigo que sai já não espera nada. */
const CODEX_IDS_MAX = 1_024;

function methodNotAllowed(res: ServerResponse, allow: string): void {
  res.setHeader('Allow', allow);
  sendJson(res, 405, { error: 'método não permitido' });
}

function fail(res: ServerResponse, err: unknown): void {
  if (res.headersSent) return void res.destroy();
  if (err instanceof HttpError) sendJson(res, err.status, { error: err.message });
  else if (err instanceof InvalidRequest) sendJson(res, 400, { error: err.message });
  else sendJson(res, 500, { error: 'erro interno' });
}

/** Tempo de espera pedido em `?timeout=` (segundos), limitado a WAIT_MAX_MS. */
export function waitMs(url: URL): number {
  const raw = Number(url.searchParams.get('timeout'));
  if (!Number.isFinite(raw) || raw <= 0) return WAIT_MAX_MS;
  return Math.min(WAIT_MAX_MS, Math.max(50, raw * 1_000));
}

export function createPermissionRoutes(
  registry: PermissionRegistry,
): (req: IncomingMessage, res: ServerResponse, path: string, codexHook?: CodexHookAuth) => void {
  /**
   * Pedidos que o hook do Codex registrou: a espera deles passa pela mesma guarda. O registro não serve para saber:
   * o detalhe some assim que há decisão, justamente a resposta que precisa da prova.
   */
  const codexIds = new Set<string>();

  /** Chamada do hook do Codex: false = recusada (já respondeu 403). Com a prova, a resposta já leva a do servidor. */
  const codexAllowed = (req: IncomingMessage, res: ServerResponse, codexHook: CodexHookAuth | undefined): boolean => {
    if (verifyHookCall(req, res, codexHook ?? LOOPBACK_ONLY) !== 'denied') return true;
    sendJson(res, 403, { error: 'pedidos do hook do Codex só são aceitos pelo próprio computador (no Docker, com a prova da chave do hook)' });
    return false;
  };

  const register = async (req: IncomingMessage, res: ServerResponse, codexHook: CodexHookAuth | undefined) => {
    const body = await readJson(req);
    const codex = !!body && typeof body === 'object' && (body as { provider?: unknown }).provider === 'codex';
    if (codex && !codexAllowed(req, res, codexHook)) return;
    const r = registry.register(body);
    if ('skip' in r) return sendJson(res, 200, { skip: r.skip });
    if (codex) {
      codexIds.add(r.id);
      if (codexIds.size > CODEX_IDS_MAX) codexIds.delete(codexIds.values().next().value!);
    }
    sendJson(res, 201, r);
  };

  const wait = (req: IncomingMessage, res: ServerResponse, id: string, codexHook: CodexHookAuth | undefined) => {
    if (codexIds.has(id) && !codexAllowed(req, res, codexHook)) return;
    const w = registry.wait(id, waitMs(new URL(req.url ?? '/', 'http://localhost')));
    if (!w) {
      codexIds.delete(id);
      return sendJson(res, 404, { error: 'pedido desconhecido' });
    }
    req.socket.setTimeout(0);
    // Conexão fechada antes da resposta (o hook morreu ou desistiu): larga a espera.
    res.on('close', () => {
      if (!res.writableEnded) w.cancel();
    });
    w.result.then(
      (result) => {
        if (result.status !== 'pending') codexIds.delete(id);
        if (!res.destroyed && !res.writableEnded) sendJson(res, 200, result);
      },
      (err) => fail(res, err),
    );
  };

  const decide = async (req: IncomingMessage, res: ServerResponse, id: string) => {
    const d = parseDecision(await readJson(req));
    if (!d) {
      throw new HttpError(400, 'esperado {behavior: "allow" | "deny" | "terminal", message?, interrupt?, suggestion?, forSession?} ou {behavior: "answer", answers: [{question, options?, other?}]}');
    }
    const r = await registry.decide(id, d);
    switch (r) {
      case 'ok':
        return sendJson(res, 200, { ok: true });
      case 'not-found':
        return sendJson(res, 404, { error: 'pedido desconhecido: já foi respondido, expirou ou foi respondido no terminal' });
      case 'conflict':
        return sendJson(res, 409, { error: 'este pedido já foi respondido' });
      case 'invalid':
        return sendJson(res, 400, { error: 'sugestão de regra desconhecida (ou "nesta sessão") para este pedido' });
      case 'invalid-answer':
        return sendJson(res, 400, { error: 'resposta que não serve para este pedido: pergunta se responde com "answer" (cada pergunta uma vez, com as opções dela); os outros pedidos, com "allow" ou "deny"' });
      case 'unsupported':
        return sendJson(res, 400, { error: 'o Codex não aceita esta resposta pelo Habblaud (interromper, "sempre permitir" ou uma decisão que o pedido não oferece): aprove, recuse ou responda no terminal' });
      case 'unavailable':
        return sendJson(res, 503, { error: 'o canal com o Codex não está disponível agora: responda no terminal' });
      default: {
        // Um DecideResult novo sem tratamento aqui: o tsc acusa (never), e a página nunca fica sem resposta.
        const unknown: never = r;
        log.warnOnce(`permissions-decide-result:${String(unknown)}`, `Pedidos de permissão: resultado de decisão sem tratamento na rota (${String(unknown)}).`);
        return sendJson(res, 500, { error: 'erro interno' });
      }
    }
  };

  return (req, res, path, codexHook) => {
    const method = req.method ?? 'GET';
    if (path === '/api/permissions') {
      if (method !== 'POST') return methodNotAllowed(res, 'POST');
      register(req, res, codexHook).catch((err) => fail(res, err));
      return;
    }
    const m = ITEM.exec(path);
    if (!m) return sendJson(res, 404, { error: 'rota desconhecida' });
    let id: string;
    try {
      id = decodeURIComponent(m[1]);
    } catch {
      return sendJson(res, 400, { error: 'id inválido' });
    }
    if (m[2] === 'wait') {
      if (method !== 'GET') return methodNotAllowed(res, 'GET');
      return wait(req, res, id, codexHook);
    }
    if (m[2] === 'decision') {
      if (method !== 'POST') return methodNotAllowed(res, 'POST');
      decide(req, res, id).catch((err) => fail(res, err));
      return;
    }
    if (method !== 'GET' && method !== 'HEAD') return methodNotAllowed(res, 'GET');
    const detail = registry.detail(id);
    if (detail) sendJson(res, 200, detail);
    else sendJson(res, 404, { error: 'pedido desconhecido' });
  };
}
