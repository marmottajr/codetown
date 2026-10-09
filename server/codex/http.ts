// Eventos dos hooks do Codex (mod/habblaud-codex/hook.mjs, que npm run codex:install acrescenta em
// <CODEX_HOME>/hooks.json): SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, PermissionRequest, Stop,
// SubagentStart, SubagentStop e SessionEnd chegam aqui com a conta e vão para a fonte do Codex (CodexLive), que
// atualiza o agente na hora, sem esperar a conversa chegar ao arquivo. Os eventos só observam (a resposta nunca volta
// para a sessão), mas só valem vindos do próprio computador: Host local (http/app.ts) e a guarda de verifyHookCall,
// abaixo. O hook roda no computador e fala com 127.0.0.1: fora do Docker, pelo loopback; no Docker, pela porta
// publicada, com o endereço do gateway, e aí só vale com nonce e prova da chave local do hook (codex/key.ts). O guard
// (http/guard.ts) já exigiu JSON.
//
//   POST /api/codex/events   (hook)   {account?, codexHome?, event: <stdin do hook, textos cortados>}: 200 {ok}
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isAbsolute, resolve } from 'node:path';
import type { AccountEntry } from '../accounts/service';
import { HttpError, readJson, sendJson } from '../http/app';
import { errMsg, log } from '../log';
import type { CodexLive } from '../sources/codex/live';
import { keyProof, NONCE_HEADER, PROOF_HEADER } from './key';

type Rec = Record<string, unknown>;

/** Conexão vinda do próprio computador (127.x, ::1 ou ::ffff:127.x). */
function isLoopbackAddress(addr: string | undefined): boolean {
  if (!addr) return false;
  const a = addr.replace(/^::ffff:/i, '');
  return a === '::1' || /^127\./.test(a);
}

/** Guarda das chamadas do hook do Codex: uma por processo (http/app.ts cria), a mesma em todas as rotas que o hook usa. */
export interface CodexHookAuth {
  /** A chave local do hook (codex/key.ts); undefined = ausente ou ilegível. */
  key: Buffer | undefined;
  /** createProofChecker(key): um conjunto só de nonces vistos, para um nonce não valer duas vezes nem em rotas diferentes. */
  check: (nonce: string | undefined, proof: string | undefined) => boolean;
  inDocker: boolean;
}

/**
 * Confere uma chamada do hook do Codex (o Host local a rota já conferiu). Só lê cabeçalhos e o socket: a rota dos eventos
 * chama antes de ler o corpo; uma rota que só sabe que a chamada é do Codex pelo corpo pode chamar depois do readJson.
 * - 'proof': nonce e prova do hook válidos; a resposta já leva `x-habblaud-proof` = keyProof(key, 'server', nonce);
 * - 'loopback': sem prova válida, mas pela conexão do próprio computador (aceita, sem a prova do servidor);
 * - 'denied': nem uma coisa nem outra (a rota responde 403).
 * Fora do Docker, conexão de fora do loopback é sempre recusada, com ou sem prova (o hook roda no mesmo computador).
 * A prova do servidor só sai para uma prova do hook válida: nunca para um nonce qualquer.
 */
export function verifyHookCall(req: IncomingMessage, res: ServerResponse, auth: CodexHookAuth): 'proof' | 'loopback' | 'denied' {
  const local = isLoopbackAddress(req.socket.remoteAddress);
  if (!local && !auth.inDocker) return 'denied';
  const nonce = req.headers[NONCE_HEADER];
  const proof = req.headers[PROOF_HEADER];
  if (auth.key && typeof nonce === 'string' && typeof proof === 'string' && auth.check(nonce, proof)) {
    res.setHeader(PROOF_HEADER, keyProof(auth.key, 'server', nonce));
    return 'proof';
  }
  return local ? 'loopback' : 'denied';
}

export interface CodexHookEvent {
  /** Conta calculada pelo hook (basename do CODEX_HOME). */
  account?: string;
  /** Pasta CODEX_HOME da sessão, no computador onde o hook roda. */
  codexHome?: string;
  /** O stdin do hook (hook_event_name, session_id...). */
  event: Rec;
}

function rec(v: unknown): Rec | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : undefined;
}

function shortStr(v: unknown, max: number): string | undefined {
  return typeof v === 'string' && v.trim() && v.length <= max ? v.trim() : undefined;
}

/** Corpo de POST /api/codex/events. Sem `event` (objeto com hook_event_name): 400. */
export function parseCodexEvent(raw: unknown): CodexHookEvent {
  const r = rec(raw);
  const event = rec(r?.event);
  if (!r || !event || typeof event.hook_event_name !== 'string') throw new HttpError(400, 'esperado {account?, codexHome?, event: <JSON do hook do Codex>}');
  const out: CodexHookEvent = { event };
  const account = shortStr(r.account, 200);
  const codexHome = shortStr(r.codexHome, 4_096);
  if (account) out.account = account;
  if (codexHome) out.codexHome = codexHome;
  return out;
}

/**
 * Conta do Codex de um evento do hook: a da pasta CODEX_HOME que ele mandou (pelo caminho do host, AccountInfo.configDir,
 * ou pelo lido por este processo); senão a que ele calculou (o basename não sabe dos ids desambiguados, ex. ".codex~2").
 */
export function codexAccountOf(entries: readonly AccountEntry[], account: string | undefined, codexHome: string | undefined): string | undefined {
  if (codexHome && isAbsolute(codexHome)) {
    const abs = resolve(codexHome);
    const e = entries.find((x) => resolve(x.detected.configDir) === abs || resolve(x.dir) === abs);
    if (e) return e.id;
  }
  return account;
}

/** Trata POST /api/codex/events (método e Host já conferidos). `ok` = a fonte do Codex aproveitou o evento. */
export async function handleCodexEvent(
  req: IncomingMessage,
  res: ServerResponse,
  deps: { live?: CodexLive; entries: () => readonly AccountEntry[] },
): Promise<void> {
  const body = parseCodexEvent(await readJson(req));
  let ok = false;
  if (deps.live) {
    try {
      ok = deps.live.applyHookEvent(codexAccountOf(deps.entries(), body.account, body.codexHome), body.event) === true;
    } catch (err) {
      log.warnOnce(`codex-event:${errMsg(err)}`, `Eventos do Codex: falha ao aplicar um evento (${errMsg(err)}).`);
    }
  }
  sendJson(res, 200, { ok });
}
