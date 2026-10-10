// Cliente do app-server do Codex (8.2 da spec) sobre um par de streams: o stdout/stdin do
// `codex app-server proxy`, que repassa bytes ao socket AF_UNIX do daemon compartilhado. Este módulo não cria
// processo nem confere o daemon (isso é do serviço): só WebSocket (`GET /rpc`, espera o 101) + JSON-RPC,
// initialize/initialized, descoberta e inscrição de threads e os pedidos de aprovação de comando e de arquivo.
//
// Só `item/commandExecution/requestApproval` e `item/fileChange/requestApproval` viram evento, e só eles podem
// ser respondidos. Qualquer outro pedido do servidor (perguntas, permissões, ferramentas dinâmicas, renovação
// de token, atestado, elicitação MCP, aprovações v1) NUNCA recebe resposta: a primeira resposta vence, e uma
// resposta do Habblaud quebraria a sessão do TUI.
import { EventEmitter } from 'node:events';
import type { CodexDecision } from '../../../../shared/types';
import { RpcError, RpcPeer } from './rpc';
import { WsConnection } from './ws';

/** Notificações que o Habblaud não usa (deltas de texto, saída de comandos, áudio): o app-server nem as manda. */
export const OPT_OUT_NOTIFICATIONS: readonly string[] = [
  'item/agentMessage/delta',
  'item/plan/delta',
  'item/reasoning/summaryTextDelta',
  'item/reasoning/summaryPartAdded',
  'item/reasoning/textDelta',
  'item/commandExecution/outputDelta',
  'item/commandExecution/terminalInteraction',
  'item/fileChange/outputDelta',
  'item/mcpToolCall/progress',
  'command/exec/outputDelta',
  'process/outputDelta',
  'turn/diff/updated',
  'thread/realtime/outputAudio/delta',
  'thread/realtime/transcript/delta',
  'thread/realtime/item/transcript/delta',
];

const COMMAND_APPROVAL = 'item/commandExecution/requestApproval';
const FILE_APPROVAL = 'item/fileChange/requestApproval';
const DECISIONS: ReadonlySet<string> = new Set<CodexDecision>(['accept', 'acceptForSession', 'decline', 'cancel']);
/** Invalid Request: o app-server usa o mesmo código para as duas recusas do resume (a mensagem distingue). */
const INVALID_REQUEST = -32600;
const LIST_LIMIT = 100;
const MAX_LIST_PAGES = 50;
/** Patches de itens fileChange guardados (para montar o pedido de arquivo). */
const MAX_PATCHES = 200;

export interface ApprovalRequest {
  requestId: string | number;
  threadId: string;
  kind: 'command' | 'fileChange';
  command?: string;
  cwd?: string;
  reason?: string;
  /** Patch do item (fileChange), quando o app-server o mandou em item/started. */
  patch?: string;
  /** Decisões oferecidas (`availableDecisions`, só as quatro do CodexDecision), quando o app-server as mandou. */
  decisions?: CodexDecision[];
}

export type ResumeResult = 'ok' | 'no-rollout' | 'not-daemon' | 'error';

type Rec = Record<string, unknown>;

function rec(v: unknown): Rec | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Thread do revisor automático (guardian): não vira evento nem fica inscrita. */
export function isGuardianThread(thread: Rec | undefined): boolean {
  if (!thread) return false;
  if (thread.threadSource === 'guardian_review') return true;
  const src = rec(thread.source);
  const sub = rec(src?.subAgent) ?? rec(src?.subagent);
  return sub?.other === 'guardian' || src?.internal === 'guardian' || src?.custom === 'guardian';
}

/** Patch no formato do apply_patch montado das mudanças de um item fileChange (`changes[]`). */
export function patchFromChanges(changes: unknown): string {
  if (!Array.isArray(changes)) return '';
  const lines: string[] = [];
  for (const c of changes) {
    const r = rec(c);
    const path = str(r?.path);
    if (!r || !path) continue;
    const kind = rec(r.kind);
    if (kind?.type === 'add') lines.push(`*** Add File: ${path}`);
    else if (kind?.type === 'delete') lines.push(`*** Delete File: ${path}`);
    else {
      lines.push(`*** Update File: ${path}`);
      const to = str(kind?.move_path);
      if (to) lines.push(`*** Move to: ${to}`);
    }
    const diff = str(r.diff);
    if (diff) lines.push(diff.replace(/\n$/, ''));
  }
  return lines.length ? ['*** Begin Patch', ...lines, '*** End Patch'].join('\n') : '';
}

function decisionsOf(raw: unknown): CodexDecision[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw.filter((d): d is CodexDecision => typeof d === 'string' && DECISIONS.has(d));
}

function resumeFailure(err: unknown): ResumeResult {
  if (!(err instanceof RpcError) || err.code !== INVALID_REQUEST) return 'error';
  if (/no rollout found/i.test(err.message)) return 'no-rollout';
  if (/active writer/i.test(err.message)) return 'not-daemon';
  return 'error';
}

const patchKey = (threadId: string, itemId: string): string => `${threadId}\n${itemId}`;

/**
 * Uma conexão com o app-server de uma conta. Eventos: 'approval' (ApprovalRequest), 'approvalResolved'
 * ({ requestId }), 'threadStarted' (threadId), 'threadClosed' (threadId) e 'close' (motivo), uma vez só.
 */
export class CodexAppServerClient extends EventEmitter {
  private ws?: WsConnection;
  private rpc?: RpcPeer;
  private starting?: Promise<void>;
  private ready = false;
  private closedReason?: string;
  /** Pedidos de aprovação abertos, pelo id ORIGINAL (0 e "0" são pedidos distintos); `answered` = já respondemos. */
  private readonly approvals = new Map<string | number, { threadId: string; answered: boolean }>();
  /** "<threadId>\n<itemId>" → patch do item fileChange. */
  private readonly patches = new Map<string, string>();
  /** Threads que deixamos de seguir (unsubscribe começou): o `serverRequest/resolved` delas não vem mais, então um pedido novo não vira cartão. */
  private readonly released = new Set<string>();

  constructor(private readonly opts: { input: NodeJS.ReadableStream; output: NodeJS.WritableStream; clientName: string; version: string }) {
    super();
  }

  /** Handshake WebSocket (`GET /rpc`, espera o 101) + initialize/initialized. Falhou: rejeita e emite 'close'. */
  start(): Promise<void> {
    this.starting ??= this.open();
    return this.starting;
  }

  /** Ids das threads carregadas no daemon (todas as páginas). */
  async listLoadedThreads(): Promise<string[]> {
    const ids: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const res = rec(await this.request('thread/loaded/list', cursor ? { cursor, limit: LIST_LIMIT } : { limit: LIST_LIMIT }));
      for (const id of Array.isArray(res?.data) ? res.data : []) if (typeof id === 'string' && id && !ids.includes(id)) ids.push(id);
      cursor = str(res?.nextCursor);
      if (!cursor) break;
    }
    return ids;
  }

  /**
   * Batimento: um pedido barato e sem efeito (thread/loaded/list de 1). Qualquer resposta vale, até um erro do daemon
   * (ele respondeu). Rejeita sem conexão, com a conexão encerrada ou sem resposta no prazo do RpcPeer.
   */
  async ping(): Promise<void> {
    try {
      await this.request('thread/loaded/list', { limit: 1 });
    } catch (err) {
      if (!(err instanceof RpcError)) throw err;
    }
  }

  /** Inscreve a conexão numa thread carregada (rejoin), sem overrides. Nunca rejeita. */
  async resumeThread(threadId: string): Promise<ResumeResult> {
    // O replay dos pedidos abertos pode vir antes da resposta do resume: a thread já tem de valer de novo.
    this.released.delete(threadId);
    let res: unknown;
    try {
      // Sem overrides: com overrides divergentes o app-server pode encerrar e recarregar uma thread ociosa.
      res = await this.request('thread/resume', { threadId, excludeTurns: true });
    } catch (err) {
      return resumeFailure(err);
    }
    if (!isGuardianThread(rec(rec(res)?.thread))) return 'ok';
    // O revisor automático não pede aprovação ao usuário: não segurar a thread carregada.
    await this.unsubscribe(threadId);
    return 'not-daemon';
  }

  /** Sai da thread (o daemon a descarrega quando ninguém mais a segura). Fecha os pedidos abertos dela. Nunca rejeita. */
  async unsubscribe(threadId: string): Promise<void> {
    this.released.add(threadId);
    this.dropThread(threadId);
    try {
      await this.request('thread/unsubscribe', { threadId });
    } catch {
      // notLoaded/notSubscribed ou conexão encerrada: não há o que desfazer.
    }
  }

  /** Responde um pedido de aprovação aberto com o id original. Pedido desconhecido, já respondido ou resolvido: nada. */
  respond(requestId: string | number, decision: CodexDecision): void {
    const open = this.approvals.get(requestId);
    const rpc = this.rpc;
    if (!open || open.answered || !rpc || !this.ready || this.closedReason !== undefined || !DECISIONS.has(decision)) return;
    open.answered = true;
    rpc.respond(requestId, { decision });
  }

  close(): void {
    this.finish('fechada pelo Habblaud');
  }

  private async open(): Promise<void> {
    if (this.closedReason !== undefined) throw new Error(this.closedReason);
    const ws = new WsConnection(this.opts.input, this.opts.output);
    const rpc = new RpcPeer((text) => ws.send(text));
    this.ws = ws;
    this.rpc = rpc;
    rpc.onNotification((method, params) => this.onNotification(method, params));
    rpc.onRequest((id, method, params) => this.onServerRequest(id, method, params));
    ws.on('message', (text: string) => {
      try {
        rpc.handle(text);
      } catch (err) {
        this.finish(`falha ao tratar mensagem do app-server (${errMessage(err)})`);
      }
    });
    ws.on('close', (reason: string) => this.finish(reason));
    await new Promise<void>((ok, fail) => {
      ws.once('open', ok);
      ws.once('close', (reason: string) => fail(new Error(reason)));
    });
    try {
      await rpc.request('initialize', {
        clientInfo: { name: this.opts.clientName, version: this.opts.version },
        capabilities: { optOutNotificationMethods: [...OPT_OUT_NOTIFICATIONS] },
      });
    } catch (err) {
      this.finish(`initialize recusado (${errMessage(err)})`);
    }
    if (this.closedReason !== undefined) throw new Error(this.closedReason);
    rpc.notify('initialized');
    this.ready = true;
  }

  private request(method: string, params: unknown): Promise<unknown> {
    if (!this.rpc || !this.ready || this.closedReason !== undefined) return Promise.reject(new Error('sem conexão com o app-server'));
    return this.rpc.request(method, params);
  }

  private onNotification(method: string, params: unknown): void {
    const p = rec(params);
    if (!p) return;
    switch (method) {
      case 'thread/started': {
        const thread = rec(p.thread);
        const id = str(thread?.id);
        if (id && !isGuardianThread(thread)) this.emit('threadStarted', id);
        return;
      }
      case 'thread/closed': {
        const id = str(p.threadId);
        if (!id) return;
        this.dropThread(id);
        this.emit('threadClosed', id);
        return;
      }
      case 'serverRequest/resolved': {
        const requestId = p.requestId;
        if ((typeof requestId === 'number' || typeof requestId === 'string') && this.approvals.delete(requestId)) {
          this.emit('approvalResolved', { requestId });
        }
        return;
      }
      case 'item/started':
      case 'item/completed': {
        const item = rec(p.item);
        const threadId = str(p.threadId);
        const itemId = str(item?.id);
        if (item?.type !== 'fileChange' || !threadId || !itemId) return;
        if (method === 'item/completed') this.patches.delete(patchKey(threadId, itemId));
        else this.remember(patchKey(threadId, itemId), patchFromChanges(item.changes));
        return;
      }
      case 'item/fileChange/patchUpdated': {
        const threadId = str(p.threadId);
        const itemId = str(p.itemId);
        if (threadId && itemId) this.remember(patchKey(threadId, itemId), patchFromChanges(p.changes));
        return;
      }
      default:
        return;
    }
  }

  private onServerRequest(id: number | string, method: string, params: unknown): void {
    // Só aprovação de comando e de arquivo; o resto fica sem resposta (vale o terminal).
    if (method !== COMMAND_APPROVAL && method !== FILE_APPROVAL) return;
    const p = rec(params);
    const threadId = str(p?.threadId);
    // O mesmo id de novo é o replay do resume: um pedido só.
    if (!p || !threadId || this.approvals.has(id) || this.released.has(threadId)) return;
    this.approvals.set(id, { threadId, answered: false });
    const req: ApprovalRequest = { requestId: id, threadId, kind: method === COMMAND_APPROVAL ? 'command' : 'fileChange' };
    if (req.kind === 'command') {
      const command = str(p.command);
      if (command) req.command = command;
      const cwd = str(p.cwd);
      if (cwd) req.cwd = cwd;
    } else {
      const patch = this.patches.get(patchKey(threadId, str(p.itemId) ?? ''));
      if (patch) req.patch = patch;
    }
    const grant = req.kind === 'fileChange' ? str(p.grantRoot) : undefined;
    const reason = str(p.reason) ?? (grant ? `pede para escrever em ${grant}` : undefined);
    if (reason) req.reason = reason;
    const decisions = decisionsOf(p.availableDecisions);
    if (decisions) req.decisions = decisions;
    this.emit('approval', req);
  }

  private remember(key: string, patch: string): void {
    this.patches.delete(key);
    this.patches.set(key, patch);
    while (this.patches.size > MAX_PATCHES) {
      const oldest = this.patches.keys().next();
      if (oldest.done) break;
      this.patches.delete(oldest.value);
    }
  }

  /** A thread saiu (fechou ou deixamos de segui-la): o resolved dela não vem mais, então os pedidos abertos fecham aqui. */
  private dropThread(threadId: string): void {
    for (const [requestId, open] of [...this.approvals]) {
      if (open.threadId !== threadId) continue;
      this.approvals.delete(requestId);
      this.emit('approvalResolved', { requestId });
    }
    for (const key of [...this.patches.keys()]) if (key.startsWith(`${threadId}\n`)) this.patches.delete(key);
  }

  private finish(reason: string): void {
    if (this.closedReason !== undefined) return;
    this.closedReason = reason;
    this.ready = false;
    this.approvals.clear();
    this.patches.clear();
    this.rpc?.close(reason);
    this.ws?.close();
    this.emit('close', reason);
  }
}
