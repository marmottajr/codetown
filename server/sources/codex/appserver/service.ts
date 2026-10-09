// Canal paralelo de aprovação do Codex (spec R2.8 e §8.2, contrato C6): por conta Codex, junta-se ao daemon do
// app-server que o TUI já subiu (NUNCA o inicia nem o configura), assina as threads dele (thread/loaded/list e
// thread/started → thread/resume sem overrides) e repassa ao PermissionRegistry os pedidos de aprovação de comando e de
// arquivo ('parallel'). Vale a 1ª resposta (escritório ou terminal); o serverRequest/resolved fecha o cartão.
//
// - Daemon no ar: pré-filtro pela pasta <CODEX_HOME>/app-server-control/ (o arquivo do socket AF_UNIX não aparece para
//   o Node no Windows; a pasta sim) e confirmação por `codex app-server daemon version` (código 0). Só então abre o
//   `codex app-server proxy` (repassa bytes entre o stdio e o socket). Sem shell, sem janela, com o CODEX_HOME da conta no
//   ambiente; nada é escrito em CODEX_HOME.
// - Sem daemon: confere de novo a cada DISCOVERY_MS. Queda da conexão (o proxy saiu, o daemon reiniciou): os pedidos
//   abertos daquela conexão fecham (o resolved deles não vem mais), owns() fica falso (o próximo pedido da thread volta ao
//   hook) e a reconexão espera de BACKOFF_MIN_MS a BACKOFF_MAX_MS.
// - owns(): a thread foi assinada nesta conexão (resume 'ok', ou um pedido dela chegou: o app-server só manda pedidos a
//   quem assina a thread, e assina sozinho os subagentes que nascem com a conexão aberta). 'not-daemon' (outro escritor,
//   ou guardian) fica com o hook; 'no-rollout' (antes do 1º turno) tenta de novo depois de RESUME_RETRY_MS.
import { execFile, spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import type { CodexDecision } from '../../../../shared/types';
import { errMsg, log } from '../../../log';
import type { ParallelRequestInput, ParallelSink, PermissionRegistry } from '../../../permissions/registry';
import { CodexAppServerClient, type ApprovalRequest } from './client';

/** Sem conexão: intervalo entre as conferências do daemon de cada conta. */
export const DISCOVERY_MS = 30_000;
/** Reconexão depois de uma queda: começa em 1 s e dobra até 30 s (volta a 1 s quando a conexão fica pronta). */
export const BACKOFF_MIN_MS = 1_000;
export const BACKOFF_MAX_MS = 30_000;
/** Thread ainda sem rollout (antes do primeiro turno): tenta o resume de novo depois disto. */
export const RESUME_RETRY_MS = 5_000;
const DAEMON_CHECK_TIMEOUT_MS = 5_000;
const TICK_MS = 1_000;

/** O `codex app-server proxy` de uma conta (o processo, ou um falso nos testes). */
export interface CodexProxy {
  stdin: NodeJS.WritableStream;
  stdout: NodeJS.ReadableStream;
  kill(): void;
  on(ev: 'exit', cb: () => void): void;
}

export interface CodexAppServerServiceOptions {
  /** Contas do Codex: `id` do Habblaud (o mesmo que o registro passa ao owns) e a pasta CODEX_HOME. */
  accounts: () => Array<{ id: string; home: string }>;
  registry: Pick<PermissionRegistry, 'registerParallel' | 'resolveParallel'>;
  /** Executável do Codex (findCodexBin de messages/codex.ts); ausente = o canal não liga. */
  codexBin?: string;
  spawnProxy?: (bin: string, home: string) => CodexProxy;
  log?: (msg: string) => void;
  /** Versão do Habblaud (clientInfo do initialize). */
  version?: string;
  /** Confere se o daemon da conta está no ar (testes); padrão: daemonRunning. */
  daemonCheck?: (bin: string, home: string) => Promise<boolean>;
  now?: () => number;
  /** Intervalo do relógio interno (start). */
  tickMs?: number;
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** `codex app-server daemon version` com o CODEX_HOME da conta: código 0 = o daemon está no ar. Só consulta. Nunca rejeita. */
export function daemonRunning(bin: string, home: string): Promise<boolean> {
  return new Promise((done) => {
    try {
      execFile(bin, ['app-server', 'daemon', 'version'], { env: { ...process.env, CODEX_HOME: home }, timeout: DAEMON_CHECK_TIMEOUT_MS, windowsHide: true, maxBuffer: 64 * 1024 }, (err) => done(!err));
    } catch {
      done(false);
    }
  });
}

/** Abre o `codex app-server proxy` da conta (o socket padrão do CODEX_HOME). Falha ao abrir (ENOENT) vira 'exit'. */
export function spawnCodexProxy(bin: string, home: string): CodexProxy {
  const child = spawn(bin, ['app-server', 'proxy'], { env: { ...process.env, CODEX_HOME: home }, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
  // EPIPE ao escrever depois que o proxy saiu: a queda é tratada pelo 'exit'.
  child.stdin.on('error', () => {});
  const listeners: Array<() => void> = [];
  let exited = false;
  const onExit = (): void => {
    if (exited) return;
    exited = true;
    for (const cb of listeners.splice(0)) cb();
  };
  child.on('exit', onExit);
  child.on('error', onExit);
  return {
    stdin: child.stdin,
    stdout: child.stdout,
    kill: () => {
      try {
        child.kill();
      } catch {
        // já saiu
      }
    },
    on: (_ev, cb) => {
      if (exited) cb();
      else listeners.push(cb);
    },
  };
}

/** Chave do pedido no registro: `<conta>:<requestId>` (um id string vai entre aspas: 0 e "0" são pedidos distintos). */
function requestKey(account: string, requestId: string | number): string {
  return `${account}:${typeof requestId === 'number' ? requestId : JSON.stringify(requestId)}`;
}

interface Conn {
  client: CodexAppServerClient;
  proxy: CodexProxy;
  ready: boolean;
  closed: boolean;
  /** Threads assinadas nesta conexão (owns). */
  owned: Set<string>;
  /** Threads com o resume em andamento. */
  resuming: Set<string>;
  /** Threads a tentar de novo (sem rollout, ou erro): thread → a partir de quando. */
  retry: Map<string, number>;
  /** Threads de outro escritor (Desktop, TUI embutido) ou guardian: ficam com o hook. */
  notDaemon: Set<string>;
  /** Pedidos com cartão aberto no registro: key → id ORIGINAL do pedido. */
  open: Map<string, string | number>;
  /** A descoberta (thread/loaded/list ao ficar pronta) já deu certo. */
  discovered: boolean;
  /** thread/loaded/list em andamento (um por vez: o pedido pode levar até o prazo do RpcPeer). */
  listing: boolean;
  /** Depois de uma falha do thread/loaded/list, a próxima listagem só a partir daqui. */
  listAt: number;
  /** A falha do thread/loaded/list já foi para o log nesta conexão. */
  listWarned: boolean;
}

interface AccountState {
  id: string;
  home: string;
  conn?: Conn;
  checking: boolean;
  retryAt: number;
  backoffMs: number;
}

export class CodexAppServerService implements ParallelSink {
  private readonly states = new Map<string, AccountState>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private readonly now: () => number;
  private readonly say: (msg: string) => void;

  constructor(private readonly opts: CodexAppServerServiceOptions) {
    this.now = opts.now ?? Date.now;
    this.say = opts.log ?? ((msg) => log.info(msg));
  }

  start(): void {
    if (this.timer || this.stopped) return;
    if (!this.opts.codexBin) {
      this.say('Codex: sem o binário do Codex (codex no PATH ou HABBLAUD_CODEX_BIN): os pedidos do codex no terminal ficam só com o hook.');
      return;
    }
    this.timer = setInterval(() => this.tick(), this.opts.tickMs ?? TICK_MS);
    this.timer.unref?.();
    this.tick();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const st of [...this.states.values()]) if (st.conn) this.drop(st, st.conn, 'fechada pelo Habblaud');
    this.states.clear();
  }

  /** Um ciclo: contas novas/sumidas, conferência do daemon e novas tentativas de resume. Público para os testes. */
  tick(): void {
    const bin = this.opts.codexBin;
    if (this.stopped || !bin) return;
    try {
      const now = this.now();
      const accounts = this.opts.accounts();
      const ids = new Set(accounts.map((a) => a.id));
      for (const st of [...this.states.values()]) {
        if (ids.has(st.id)) continue;
        if (st.conn) this.drop(st, st.conn, 'a conta saiu da lista');
        this.states.delete(st.id);
      }
      for (const a of accounts) {
        let st = this.states.get(a.id);
        if (!st) {
          st = { id: a.id, home: a.home, checking: false, retryAt: 0, backoffMs: BACKOFF_MIN_MS };
          this.states.set(a.id, st);
        }
        if (st.conn) {
          if (st.conn.ready) this.maintain(st, st.conn, now);
        } else if (!st.checking && now >= st.retryAt) this.check(st, bin);
      }
    } catch (err) {
      log.warnOnce(`codex-appserver-tick:${errMsg(err)}`, `Codex: falha no relógio do canal paralelo (${errMsg(err)}).`);
    }
  }

  decide(key: string, decision: CodexDecision): Promise<'ok' | 'gone' | 'unavailable'> {
    for (const st of this.states.values()) {
      const conn = st.conn;
      const requestId = conn?.open.get(key);
      if (!conn || requestId === undefined) continue;
      if (!conn.ready || conn.closed) return Promise.resolve('unavailable');
      // O cartão continua até o resolved: a resposta pode ter perdido a corrida para o terminal.
      conn.client.respond(requestId, decision);
      return Promise.resolve('ok');
    }
    return Promise.resolve('gone');
  }

  owns(account: string, threadId: string): boolean {
    const conn = this.states.get(account)?.conn;
    return !!conn && conn.ready && !conn.closed && conn.owned.has(threadId);
  }

  // ---------------------------------------------------------------- conexão

  private check(st: AccountState, bin: string): void {
    // Pré-filtro barato: sem a pasta do socket não há daemon (e nenhum processo é aberto).
    if (!isDir(join(st.home, 'app-server-control'))) {
      st.retryAt = this.now() + DISCOVERY_MS;
      return;
    }
    st.checking = true;
    let pending: Promise<boolean>;
    try {
      pending = (this.opts.daemonCheck ?? daemonRunning)(bin, st.home);
    } catch {
      pending = Promise.resolve(false);
    }
    void pending
      .catch(() => false)
      .then((up) => {
        st.checking = false;
        if (this.stopped || this.states.get(st.id) !== st || st.conn) return;
        if (up) this.guard(() => this.connect(st, bin));
        else st.retryAt = this.now() + DISCOVERY_MS;
      });
  }

  private connect(st: AccountState, bin: string): void {
    let proxy: CodexProxy;
    try {
      proxy = (this.opts.spawnProxy ?? spawnCodexProxy)(bin, st.home);
    } catch (err) {
      log.warnOnce(`codex-appserver-spawn:${errMsg(err)}`, `Codex (${st.id}): não consegui abrir o proxy do app-server (${errMsg(err)}).`);
      this.backoff(st);
      return;
    }
    const client = new CodexAppServerClient({ input: proxy.stdout, output: proxy.stdin, clientName: 'habblaud', version: this.opts.version ?? '0.0.0' });
    const conn: Conn = {
      client,
      proxy,
      ready: false,
      closed: false,
      owned: new Set(),
      resuming: new Set(),
      retry: new Map(),
      notDaemon: new Set(),
      open: new Map(),
      discovered: false,
      listing: false,
      listAt: 0,
      listWarned: false,
    };
    st.conn = conn;
    proxy.on('exit', () => this.drop(st, conn, 'o proxy do app-server saiu'));
    client.on('close', (reason: string) => this.drop(st, conn, reason));
    client.on('approval', (req: ApprovalRequest) => this.guard(() => this.onApproval(st, conn, req)));
    client.on('approvalResolved', (r: { requestId: string | number }) => this.guard(() => this.onResolved(st, conn, r.requestId)));
    client.on('threadStarted', (threadId: string) => this.guard(() => this.resume(conn, threadId)));
    client.on('threadClosed', (threadId: string) => this.guard(() => this.forget(conn, threadId)));
    client.start().then(
      () => this.guard(() => this.onReady(st, conn)),
      () => {
        // O 'close' do cliente já tratou a queda.
      },
    );
  }

  private onReady(st: AccountState, conn: Conn): void {
    if (st.conn !== conn || conn.closed) return;
    conn.ready = true;
    st.backoffMs = BACKOFF_MIN_MS;
    this.say(`Codex (${st.id}): ligado ao daemon do app-server; os pedidos de aprovação do codex no terminal também podem ser respondidos pelo escritório.`);
    this.listLoaded(st, conn);
  }

  /** Conexão pronta, a cada tick: novas tentativas de resume e a descoberta que falhou. */
  private maintain(st: AccountState, conn: Conn, now: number): void {
    this.retryResumes(conn, now);
    if (!conn.discovered && now >= conn.listAt) this.listLoaded(st, conn);
  }

  /**
   * Descoberta: thread/loaded/list (um por vez) e resume de cada thread carregada. Falha com a conexão de pé (prazo do
   * pedido no RpcPeer, erro do daemon): avisa uma vez por conexão e lista de novo depois de DISCOVERY_MS, sem derrubar a
   * conexão (com um método desconhecido, reconectar não adiantaria). Se a conexão caiu no meio, a reconexão lista de novo.
   */
  private listLoaded(st: AccountState, conn: Conn): void {
    if (conn.listing || conn.closed) return;
    conn.listing = true;
    conn.client.listLoadedThreads().then(
      (ids) =>
        this.guard(() => {
          conn.listing = false;
          if (conn.closed) return;
          conn.discovered = true;
          conn.listAt = 0;
          for (const id of ids) this.resume(conn, id);
        }),
      (err) =>
        this.guard(() => {
          conn.listing = false;
          if (conn.closed) return;
          conn.listAt = this.now() + DISCOVERY_MS;
          if (conn.listWarned) return;
          conn.listWarned = true;
          this.say(`Codex (${st.id}): o thread/loaded/list falhou (${errMsg(err)}); tento de novo em ${DISCOVERY_MS / 1000} s. Até lá, só as threads que começarem agora entram no canal paralelo.`);
        }),
    );
  }

  /** Fim de uma conexão (uma vez só): fecha os pedidos dela, mata o proxy e agenda a reconexão. */
  private drop(st: AccountState, conn: Conn, reason: string): void {
    if (conn.closed) return;
    conn.closed = true;
    const wasReady = conn.ready;
    conn.ready = false;
    // O cliente esquece os pedidos sem emitir o resolved: os cartões desta conexão fecham aqui.
    for (const key of conn.open.keys()) this.opts.registry.resolveParallel(key);
    conn.open.clear();
    conn.owned.clear();
    conn.client.close();
    conn.proxy.kill();
    if (st.conn !== conn) return;
    st.conn = undefined;
    this.backoff(st);
    if (wasReady && !this.stopped) this.say(`Codex (${st.id}): a conexão com o app-server caiu (${reason}); os pedidos voltam ao hook até reconectar.`);
  }

  private backoff(st: AccountState): void {
    st.retryAt = this.now() + st.backoffMs;
    st.backoffMs = Math.min(st.backoffMs * 2, BACKOFF_MAX_MS);
  }

  private guard(fn: () => void): void {
    try {
      fn();
    } catch (err) {
      log.warnOnce(`codex-appserver:${errMsg(err)}`, `Codex: falha no canal paralelo (${errMsg(err)}).`);
    }
  }

  // ---------------------------------------------------------------- threads

  private resume(conn: Conn, threadId: string): void {
    if (conn.closed || conn.owned.has(threadId) || conn.resuming.has(threadId) || conn.notDaemon.has(threadId)) return;
    conn.resuming.add(threadId);
    conn.retry.delete(threadId);
    void conn.client.resumeThread(threadId).then((r) =>
      this.guard(() => {
        // Fora de `resuming` = a thread fechou (ou a conexão caiu) no meio: o resultado não vale mais.
        if (!conn.resuming.delete(threadId) || conn.closed) return;
        if (r === 'ok') conn.owned.add(threadId);
        else if (r === 'not-daemon') conn.notDaemon.add(threadId);
        else conn.retry.set(threadId, this.now() + (r === 'no-rollout' ? RESUME_RETRY_MS : DISCOVERY_MS));
      }),
    );
  }

  private retryResumes(conn: Conn, now: number): void {
    for (const [threadId, at] of [...conn.retry]) if (now >= at) this.resume(conn, threadId);
  }

  /** thread/closed: a assinatura acabou (o cliente já fechou os pedidos abertos dela pelo approvalResolved). */
  private forget(conn: Conn, threadId: string): void {
    conn.owned.delete(threadId);
    conn.resuming.delete(threadId);
    conn.retry.delete(threadId);
    conn.notDaemon.delete(threadId);
  }

  // ---------------------------------------------------------------- pedidos

  private onApproval(st: AccountState, conn: Conn, req: ApprovalRequest): void {
    if (conn.closed) return;
    // O app-server só manda o pedido a quem assina a thread.
    conn.owned.add(req.threadId);
    conn.retry.delete(req.threadId);
    const key = requestKey(st.id, req.requestId);
    const input: ParallelRequestInput = {
      key,
      account: st.id,
      threadId: req.threadId,
      tool: req.kind === 'command' ? 'exec_command' : 'apply_patch',
      input: { command: (req.kind === 'command' ? req.command : req.patch) ?? '' },
      decisions: req.decisions ?? [],
    };
    if (req.cwd) input.cwd = req.cwd;
    if (req.reason) input.reason = req.reason;
    // skip (agente fora do escritório, pedidos demais): nenhum cartão, vale o terminal.
    if ('id' in this.opts.registry.registerParallel(input)) conn.open.set(key, req.requestId);
  }

  private onResolved(st: AccountState, conn: Conn, requestId: string | number): void {
    const key = requestKey(st.id, requestId);
    if (conn.open.delete(key)) this.opts.registry.resolveParallel(key);
  }
}
