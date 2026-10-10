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
// - Nunca segura uma thread que o usuário fechou (assinada, a thread fica carregada no daemon com a trava de escritor
//   presa): só assina thread que está no thread/loaded/list atual ou que acabou de chegar em thread/started (o resume de
//   uma thread descarregada faria o daemon carregá-la), e desassina UNSUBSCRIBE_AFTER_MS depois de o turno dela fechar
//   (setTurnOpen), até o turno reabrir.
import { execFile, spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import type { CodexDecision } from '../../../../shared/types';
import { errMsg, log } from '../../../log';
import type { ParallelRequestInput, ParallelSink, PermissionRegistry } from '../../../permissions/registry';
import { unwrapCommand } from '../command';
import { CodexAppServerClient, type ApprovalRequest } from './client';

/** Sem conexão: intervalo entre as conferências do daemon de cada conta. */
export const DISCOVERY_MS = 30_000;
/** Reconexão depois de uma queda: começa em 1 s e dobra até 30 s (volta a 1 s quando a conexão fica pronta). */
export const BACKOFF_MIN_MS = 1_000;
export const BACKOFF_MAX_MS = 30_000;
/** Thread ainda sem rollout (antes do primeiro turno): tenta o resume de novo depois disto. */
export const RESUME_RETRY_MS = 5_000;
/** Turno fechado (setTurnOpen false): desassina a thread depois disto, se o turno não reabrir antes. */
export const UNSUBSCRIBE_AFTER_MS = 60_000;
const DAEMON_CHECK_TIMEOUT_MS = 5_000;
const TICK_MS = 1_000;
/** Pedido sem `availableDecisions`: o escritório oferece as quatro. */
const ALL_DECISIONS: readonly CodexDecision[] = ['accept', 'acceptForSession', 'decline', 'cancel'];
/** Decisões que o cartão oferece (o escritório nunca manda cancel): sem nenhuma delas, o pedido fica só no terminal. */
const OFFICE_DECISIONS: ReadonlySet<CodexDecision> = new Set<CodexDecision>(['accept', 'acceptForSession', 'decline']);

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
  /** Turnos fechados (setTurnOpen false), por conta: thread → quando fechou. Fora da conexão: sobrevive à reconexão. */
  private readonly closedTurns = new Map<string, Map<string, number>>();
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
    this.closedTurns.clear();
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
        this.closedTurns.delete(st.id);
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

  /**
   * O turno da thread abriu ou fechou (`account` = o id da conta, o mesmo da chave `<conta>:<requestId>` e do id do
   * agente). Fechado: desassina UNSUBSCRIBE_AFTER_MS depois (no tick; os pedidos abertos dela fecham e os novos voltam ao
   * hook). Aberto: cancela o desassinar; se a thread não está assinada, lista de novo e só a assina se ainda estiver
   * carregada no daemon. Vale também sem conexão (a próxima conexão respeita).
   */
  setTurnOpen(account: string, threadId: string, open: boolean): void {
    if (this.stopped) return;
    const closed = this.closedTurns.get(account) ?? new Map<string, number>();
    if (!open) {
      if (!closed.has(threadId)) closed.set(threadId, this.now());
      this.closedTurns.set(account, closed);
      return;
    }
    this.turnReopened(account, threadId);
    const st = this.states.get(account);
    const conn = st?.conn;
    if (!st || !conn?.ready || conn.closed || conn.owned.has(threadId) || conn.resuming.has(threadId)) return;
    // Nova tentativa vencida: a próxima listagem decide (assina se estiver carregada; senão desiste).
    conn.retry.set(threadId, this.now());
    this.guard(() => this.listLoaded(st, conn));
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
    client.on('threadStarted', (threadId: string) =>
      this.guard(() => {
        // Thread de turno fechado há UNSUBSCRIBE_AFTER_MS (o Habblaud não a retoma): outro cliente acabou de carregá-la,
        // então o turno fechado não vale mais. Com o prazo ainda correndo, não: o daemon pode anunciar thread/started a
        // quem retoma a thread, e só a reabertura do turno cancela o desassinar.
        if (this.idle(st.id, threadId, this.now())) this.turnReopened(st.id, threadId);
        this.resume(st, conn, threadId);
      }),
    );
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

  /** Conexão pronta, a cada tick: desassina as threads de turno fechado e lista de novo (descoberta que falhou, novas tentativas vencidas). */
  private maintain(st: AccountState, conn: Conn, now: number): void {
    for (const threadId of [...conn.owned]) if (this.idle(st.id, threadId, now)) this.release(conn, threadId);
    if (now < conn.listAt) return;
    if (!conn.discovered || [...conn.retry.values()].some((at) => now >= at)) this.listLoaded(st, conn);
  }

  /**
   * thread/loaded/list (um por vez) e resume do que está carregado: tudo na descoberta; depois, só as novas tentativas
   * vencidas. Nova tentativa de thread que não está mais carregada: desiste (o resume faria o daemon carregá-la). Falha com
   * a conexão de pé (prazo do pedido no RpcPeer, erro do daemon): avisa uma vez por conexão e lista de novo depois de
   * DISCOVERY_MS, sem perder as novas tentativas e sem derrubar a conexão (com um método desconhecido, reconectar não
   * adiantaria). Se a conexão caiu no meio, a reconexão lista de novo.
   */
  private listLoaded(st: AccountState, conn: Conn): void {
    if (conn.listing || conn.closed) return;
    conn.listing = true;
    conn.client.listLoadedThreads().then(
      (ids) =>
        this.guard(() => {
          conn.listing = false;
          if (conn.closed) return;
          const now = this.now();
          const loaded = new Set(ids);
          const all = !conn.discovered;
          conn.discovered = true;
          conn.listAt = 0;
          this.forgetUnloaded(st.id, loaded);
          for (const [threadId, at] of [...conn.retry]) {
            if (!loaded.has(threadId)) conn.retry.delete(threadId);
            else if (now >= at) this.resume(st, conn, threadId);
          }
          if (all) for (const id of ids) this.resume(st, conn, id);
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

  /** Assina uma thread carregada (só quem chama sabe: veio do thread/loaded/list atual ou de thread/started). */
  private resume(st: AccountState, conn: Conn, threadId: string): void {
    // Sai das novas tentativas antes de qualquer saída: uma tentativa vencida que sobrasse (thread já assinada, de outro
    // escritor ou de turno fechado) faria listar a cada tick.
    conn.retry.delete(threadId);
    if (conn.closed || conn.owned.has(threadId) || conn.resuming.has(threadId) || conn.notDaemon.has(threadId)) return;
    // Turno fechado há UNSUBSCRIBE_AFTER_MS: não segura a thread (assina de novo quando o turno reabrir).
    if (this.idle(st.id, threadId, this.now())) return;
    conn.resuming.add(threadId);
    void conn.client.resumeThread(threadId).then((r) =>
      this.guard(() => {
        // Fora de `resuming` = a thread fechou (ou a conexão caiu) no meio: o resultado não vale mais.
        if (!conn.resuming.delete(threadId) || conn.closed) return;
        if (r === 'ok') conn.owned.add(threadId);
        else if (r === 'not-daemon') conn.notDaemon.add(threadId);
        else {
          // Erro do daemon (ou sem resposta): a thread não entra no canal até dar certo; uma linha por conta e thread.
          if (r === 'error') log.warnOnce(`codex-appserver-resume:${st.id}:${threadId}`, `Codex (${st.id}): o thread/resume de uma thread falhou (${threadId}); os pedidos dela seguem com o hook e tento de novo a cada ${DISCOVERY_MS / 1000} s.`);
          conn.retry.set(threadId, this.now() + (r === 'no-rollout' ? RESUME_RETRY_MS : DISCOVERY_MS));
        }
      }),
    );
  }

  /** thread/closed: a assinatura acabou (o cliente já fechou os pedidos abertos dela pelo approvalResolved). */
  private forget(conn: Conn, threadId: string): void {
    conn.owned.delete(threadId);
    conn.resuming.delete(threadId);
    conn.retry.delete(threadId);
    conn.notDaemon.delete(threadId);
  }

  /** Turno fechado há UNSUBSCRIBE_AFTER_MS: sai da thread (o cliente fecha os pedidos abertos dela pelo approvalResolved). */
  private release(conn: Conn, threadId: string): void {
    this.forget(conn, threadId);
    void conn.client.unsubscribe(threadId);
  }

  /** O turno fechou há UNSUBSCRIBE_AFTER_MS ou mais (e não reabriu): o Habblaud não assina nem segura a thread. */
  private idle(account: string, threadId: string, now: number): boolean {
    const at = this.closedTurns.get(account)?.get(threadId);
    return at !== undefined && now - at >= UNSUBSCRIBE_AFTER_MS;
  }

  /** O turno reabriu (ou a thread foi carregada de novo): cancela o desassinar. */
  private turnReopened(account: string, threadId: string): void {
    const closed = this.closedTurns.get(account);
    if (!closed) return;
    closed.delete(threadId);
    if (closed.size === 0) this.closedTurns.delete(account);
  }

  /** Turnos fechados de threads que o daemon já descarregou não valem mais (uma nova carga vem com thread/started). */
  private forgetUnloaded(account: string, loaded: ReadonlySet<string>): void {
    const closed = this.closedTurns.get(account);
    if (!closed) return;
    for (const threadId of [...closed.keys()]) if (!loaded.has(threadId)) closed.delete(threadId);
    if (closed.size === 0) this.closedTurns.delete(account);
  }

  // ---------------------------------------------------------------- pedidos

  private onApproval(st: AccountState, conn: Conn, req: ApprovalRequest): void {
    if (conn.closed) return;
    // O app-server só manda o pedido a quem assina a thread.
    conn.owned.add(req.threadId);
    conn.retry.delete(req.threadId);
    // availableDecisions ausente = as quatro; presente sem accept, acceptForSession nem decline (só cancel, ou só emendas
    // de política) = o escritório não tem o que responder (ele nunca manda cancel): nenhum cartão, vale o terminal (a
    // thread segue assinada, então o hook dela sai sem decidir).
    const decisions = req.decisions ?? [...ALL_DECISIONS];
    if (!decisions.some((d) => OFFICE_DECISIONS.has(d))) {
      this.say(`Codex (${st.id}): pedido de aprovação sem nenhuma decisão que o escritório saiba dar (aprovar, aprovar nesta sessão ou recusar); fica só com o terminal.`);
      return;
    }
    const key = requestKey(st.id, req.requestId);
    const input: ParallelRequestInput = {
      key,
      account: st.id,
      threadId: req.threadId,
      tool: req.kind === 'command' ? 'exec_command' : 'apply_patch',
      // O comando vem como o shell o recebe (`pwsh.exe -NoProfile -Command '…'`): o cartão mostra o de dentro.
      input: { command: req.kind === 'command' ? unwrapCommand(req.command ?? '').text : (req.patch ?? '') },
      decisions,
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
