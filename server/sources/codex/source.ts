// Fonte de agentes do Codex (AgentSource 'codex', ver sources/source.ts): CLI `codex` e o app desktop, que gravam
// no mesmo CODEX_HOME. Observa as sessões ABERTAS de cada conta do Codex e alimenta o Office; os eventos dos hooks
// (CodexLive, via POST /api/codex/events) chegam por applyHookEvent e adiantam o que os arquivos ainda não contam.
//
// Presença (o Codex não grava um registro de sessões como o do Claude Code):
// - um thread carregado tem o arquivo `thread-writer-locks/<thread>.lock`, travado pelo processo do Codex. A trava é
//   SONDADA a cada ciclo (locks.ts; nunca adquirida): 'held' (Windows: EBUSY; Linux: /proc/locks) = sessão viva, por
//   mais velhos que sejam o lock e o rollout; 'free' = órfã de um crash, vale como lock sumido; 'unknown' (macOS,
//   Docker: só a existência) = vale a regra de 12 h abaixo. O lock precisa ter alguns segundos de vida
//   (LOCK_SETTLE_MS, pela idade do arquivo): operações de manutenção (arquivar, renomear, migrar, compactar) criam
//   locks rápidos que não são sessões;
// - o rollout do thread (achado pelo id no nome do arquivo) dá o projeto (cwd do session_meta), o título e o que o
//   agente faz. Lock sem rollout = sessão aberta e ainda vazia: o Codex só cria o arquivo (e o hook SessionStart só
//   dispara) no primeiro prompt, e o lock não diz a pasta. Sem o projeto não há sala: o principal só entra quando o
//   rollout ou um hook disser o cwd (uma CLI recém-aberta aparece com a primeira mensagem);
// - sem lock (ou órfã) = fechada, depois da graça de MAIN_GONE_GRACE_MS (principal) ou de 1,5 s (subagente). Só no
//   modo 'unknown': lock criado há mais de STALE_LOCK_MS, rollout parado há mais de STALE_LOCK_MS pela ÚLTIMA LINHA
//   (ou sem rollout) e nenhum evento de hook = órfã de um crash, mesmo com o turno aberto. Uma escrita nova no rollout
//   (ou um hook) reabre;
// - versão sem `thread-writer-locks/` (ou Docker sem a pasta montada): o mtime só escolhe os rollouts a abrir; fica o
//   que tem escrita nos últimos 30 min (crescimento do arquivo ou horário da última linha);
// - um evento de hook segura o agente presente por HOOK_PRESENCE_MS mesmo sem lock visível; SessionEnd fecha (se o
//   lock também sumiu, ou depois de SESSION_END_GRACE_MS).
// O mtime nunca decide presença, progresso nem status (no Windows ele fica parado durante as escritas): a "última
// escrita" é o crescimento do arquivo visto pelo tail ou o `timestamp` da última linha.
// Subagentes (spawn_agent) são threads próprios, com lock e rollout: o session_meta aponta o pai. Entram como
// subagentes do pai enquanto trabalham e entregam ao concluir o turno (ou ao sumir); threads internos (guardian,
// revisão, compactação, memória) ficam de fora.
//
// Status: aplicado por bordas (início/fim de turno no rollout, eventos de hook), a informação mais nova vence; um
// rollout relido nunca sobrescreve o 'waiting' de um PermissionRequest mais novo. Um request_user_input sem output é
// 'waiting' ("responder uma pergunta") até a resposta ou o fim do turno, sem trocar uma espera por aprovação que já
// esteja valendo (a resposta só tira a espera da pergunta). Com a trava segura o turno aberto
// continua 'working' sem prazo; sem sondagem, 'working' sem nenhuma escrita por WORKING_QUIET_MS vira 'idle'. Ao abrir
// um rollout: o começo (session_meta, título) e, do fim para trás, pelo menos `tailBytes` e até a fronteira de turno
// (reader.ts: o turno aberto pode estar a vários MB do fim); o tail continua de onde a varredura parou e o começo
// anterior a ela é lido depois, em segundo plano (números e linha do tempo longa). Boot síncrono, com endBoot num
// `finally`.
import { createReadStream, readdirSync, realpathSync, statSync, watch, type FSWatcher } from 'node:fs';
import { basename, join, resolve, sep } from 'node:path';
import type { AccountUsage, Activity, AgentStatus, SourceInfo } from '../../../shared/types';
import type { DetectedAccount } from '../../accounts/detect';
import type { AccountEntry, AccountsService } from '../../accounts/service';
import { detectDocker } from '../../config';
import { errMsg, log } from '../../log';
import type { Office, TranscriptSummary } from '../../model/office';
import type { AgentSource } from '../source';
import { FileTail } from '../tail';
import type { TerminalParser } from '../terminal';
import { codexPlanLabel, detectCodexAccounts } from './accounts';
import { readLocks, readRolloutHead, rolloutDirs, RolloutIndex, parseRolloutName, LOCKS_DIR, type LockInfo } from './files';
import type { CodexLive } from './live';
import { createLockProber, type LockProber } from './locks';
import { isTurnBoundary, lineTimestamp, scanBackward } from './reader';
import {
  createCodexState,
  describeCodexTool,
  isThreadId,
  parseRolloutLine,
  type CodexLineResult,
  type CodexState,
  type RolloutMeta,
} from './rollout';
import { createCodexTerminalParser } from './terminal';

/** Idade mínima do lock para valer como sessão aberta (os locks de manutenção duram menos). */
export const LOCK_SETTLE_MS = 3_000;
/**
 * Só no modo sem sondagem ('unknown'): lock criado há mais que isto, rollout parado há mais que isto (pela última
 * linha) e nenhum evento de hook = lock velho de um crash.
 */
export const STALE_LOCK_MS = 12 * 3600_000;
/** Sem `thread-writer-locks/`: presença = escrita no rollout nos últimos 30 min (o mtime só escolhe o que abrir). */
export const FALLBACK_RECENT_MS = 30 * 60_000;
/** Um evento de hook segura o agente presente por este tempo (sem lock visível). */
export const HOOK_PRESENCE_MS = 60_000;
/** SessionEnd com o lock ainda presente: fecha mesmo assim depois disto. */
export const SESSION_END_GRACE_MS = 5_000;
/** Principal ausente (lock sumido ou órfão, presença do hook vencida) por este tempo: encerrado. */
export const MAIN_GONE_GRACE_MS = 5_000;
/** Subagente ausente por este tempo: entrega e sai. */
const CLOSE_AFTER_MISSING_MS = 1_500;
/**
 * 'working' sem nenhuma escrita no rollout nem evento de hook por este tempo: o turno morreu (crash). Só sem a trava
 * segura: com ela, um comando longo pode passar horas sem escrever.
 */
export const WORKING_QUIET_MS = 30 * 60_000;
/** Sem eventos de turno (legacy antigo): escreveu há pouco = trabalhando. */
const LEGACY_WORKING_MS = 90_000;
/** Atividades recuperadas do começo de um rollout grande para a linha do tempo longa. */
const PREFIX_HISTORY = 120;
/** Resultados guardados ao ler um rollout antes de o agente entrar no escritório. */
const BACKLOG_MAX = 400;
/** Conta sem sessão aberta ao subir: quantos rollouts recentes tentar até achar um com o uso do plano. */
const SEED_USAGE_FILES = 8;
const MAIN_ROLE = 'Agente principal (Codex)';
const SUB_ROLE = 'Subagente (Codex)';
/** Motivo da espera de um request_user_input aberto (o mesmo texto que o registro usa para uma pergunta). */
const QUESTION_WAIT = 'responder uma pergunta';

const HOOK_EVENTS = new Set([
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PermissionRequest',
  'Stop',
  'SubagentStart',
  'SubagentStop',
  'PreCompact',
  'PostCompact',
  'Interrupt',
]);

export interface CodexSourceOptions {
  accounts: AccountsService;
  office: Office;
  /** Pastas do Codex lidas por este processo (no Docker, as montadas), uma por conta. */
  dirs: string[];
  env?: NodeJS.ProcessEnv;
  home?: string;
  now?: () => number;
  pollMs?: number;
  /**
   * Mínimo lido do fim de cada rollout ao abrir a sessão (padrão 1 MB, as atividades recentes); a leitura continua para
   * trás até a fronteira de turno (no máximo SCAN_MAX_BYTES).
   */
  tailBytes?: number;
  /** Desliga o fs.watch (testes). */
  watch?: boolean;
  /** Sondagem das travas (testes); padrão `createLockProber({ platform: process.platform, inDocker: detectDocker(env) })`. */
  lockProber?: LockProber;
}

interface CodexAccount {
  id: string;
  /** Pasta lida por este processo. */
  dir: string;
  /** Pasta para exibir (no Docker, a do host). */
  configDir: string;
  index: RolloutIndex;
  /** Locks vistos no último ciclo, com o estado da sondagem (null = sem a pasta de locks). */
  locks: Map<string, LockInfo> | null;
  /** Modo sem locks: candidatos a abrir (rollouts com mtime recente), revistos a cada 10 s. */
  recent: Set<string>;
  recentAt: number;
  usage?: AccountUsage;
  plan?: string;
  error?: string;
}

interface ThreadTracker {
  key: string;
  acc: CodexAccount;
  threadId: string;
  /** main/sub pelo session_meta (ou pelo hook); internal = fica fora do escritório. */
  kind: 'main' | 'sub' | 'internal';
  parentThreadId?: string;
  meta?: RolloutMeta;
  rolloutPath?: string;
  nextResolveAt: number;
  tail?: FileTail;
  state: CodexState;
  /** Resultados lidos antes de o agente entrar no escritório (vão como histórico, sem feed). */
  backlog: CodexLineResult[];
  inOffice: boolean;
  hookCwd?: string;
  hookRole?: string;
  status: AgentStatus;
  /** Quando o status foi decidido (linha do rollout ou evento de hook): informação mais velha não o muda. */
  statusAt: number;
  waitingFor?: string;
  lastHookAt?: number;
  /**
   * Última escrita no rollout: o `timestamp` da última linha lida ao abrir, depois o momento em que o tail viu o
   * arquivo crescer. Nunca o mtime.
   */
  lastWriteAt?: number;
  /** Tamanho do rollout já visto (o que passar disto é escrita nova). */
  sizeSeen?: number;
  endedAt?: number;
  missingSince?: number;
  /** Subagente que já entregou (turno concluído). */
  subDone: boolean;
  /** Criado agora por um hook (SubagentStart): entra mesmo sem turno visto. */
  hookSpawned?: boolean;
  watcher?: FSWatcher;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function rec(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

function roleOf(raw: string | undefined): string {
  if (!raw) return SUB_ROLE;
  const r = raw.trim();
  return r ? `${r[0].toUpperCase()}${r.slice(1)}` : SUB_ROLE;
}

export class CodexSource implements AgentSource, CodexLive {
  readonly provider = 'codex' as const;
  private accs: CodexAccount[] = [];
  private entries: readonly AccountEntry[] = [];
  private detected: DetectedAccount[] = [];
  private threads = new Map<string, ThreadTracker>();
  private dirWatchers = new Map<string, FSWatcher>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private kick: ReturnType<typeof setTimeout> | null = null;
  private lastPollAt = 0;
  private prefixChain: Promise<void> = Promise.resolve();
  private readonly now: () => number;
  private readonly tailBytes: number;
  private readonly useWatch: boolean;
  private readonly prober: LockProber;
  private stopped = false;

  constructor(private readonly opts: CodexSourceOptions) {
    this.now = opts.now ?? Date.now;
    this.tailBytes = opts.tailBytes ?? 1024 * 1024;
    this.useWatch = opts.watch ?? true;
    const env = opts.env ?? process.env;
    this.prober = opts.lockProber ?? createLockProber({ platform: process.platform, inDocker: detectDocker(env) });
    const claude = opts.accounts.entries();
    this.detected = detectCodexAccounts(opts.dirs, {
      env,
      home: opts.home,
      taken: { shorts: claude.map((e) => e.detected.short), colors: claude.map((e) => e.detected.color) },
    });
    this.register();
  }

  /** Registra (de novo) as contas no AccountsService, sempre na mesma ordem: os ids não mudam. */
  private register(): void {
    const entries = this.opts.accounts.setProviderAccounts(
      'codex',
      this.opts.dirs.map((dir, i) => ({ dir, detected: this.detected[i] })),
    );
    this.entries = entries;
    const prev = new Map(this.accs.map((a) => [a.dir, a]));
    this.accs = entries.map((e) => {
      const old = prev.get(e.dir);
      if (old) {
        old.id = e.id;
        old.configDir = e.detected.configDir;
        return old;
      }
      return { id: e.id, dir: e.dir, configDir: e.detected.configDir, index: new RolloutIndex(e.dir, this.now), locks: null, recent: new Set(), recentAt: -Infinity };
    });
  }

  /** Contas do Codex (ids finais, no AccountsService). */
  accountEntries(): readonly AccountEntry[] {
    return this.entries;
  }

  start(): void {
    this.boot();
    this.timer = setInterval(() => this.safePoll(), this.opts.pollMs ?? 1_000);
    this.timer.unref?.();
  }

  /** Reconstrói as sessões abertas sem gerar avisos. Síncrono e curto. */
  boot(): void {
    this.opts.office.beginBoot();
    try {
      for (const acc of this.accs) acc.index.scanAll();
      this.poll(true);
      for (const acc of this.accs) if (!acc.usage) this.seedUsage(acc);
    } finally {
      this.opts.office.endBoot();
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.kick) clearTimeout(this.kick);
    this.timer = null;
    this.kick = null;
    for (const w of this.dirWatchers.values()) w.close();
    this.dirWatchers.clear();
    for (const t of this.threads.values()) this.unwatch(t);
  }

  sources(): SourceInfo[] {
    return this.accs.map((acc) => {
      let sessions = 0;
      for (const t of this.threads.values()) if (t.acc === acc && t.kind === 'main' && t.inOffice) sessions++;
      const info: SourceInfo = { label: acc.id, provider: 'codex', path: acc.configDir, sessions, ok: !acc.error };
      if (acc.error) info.error = acc.error;
      return info;
    });
  }

  transcriptPathOf(agentId: string): string | undefined {
    const t = this.threads.get(agentId);
    return t?.inOffice ? t.rolloutPath : undefined;
  }

  terminalParser(agentId: string): TerminalParser | undefined {
    return this.threads.has(agentId) ? createCodexTerminalParser() : undefined;
  }

  /** Espera as leituras do começo dos rollouts (testes). */
  idle(): Promise<void> {
    return this.prefixChain;
  }

  // ---------------------------------------------------------------- polling

  private safePoll(): void {
    try {
      this.poll(false);
    } catch (err) {
      log.warnOnce(`codex-poll:${errMsg(err)}`, `Codex: falha no ciclo de leitura: ${errMsg(err)}`);
    }
  }

  private schedule(): void {
    if (this.kick || this.stopped) return;
    const wait = Math.max(60, 150 - (this.now() - this.lastPollAt));
    this.kick = setTimeout(() => {
      this.kick = null;
      this.safePoll();
    }, wait);
    this.kick.unref?.();
  }

  poll(boot = false): void {
    const now = (this.lastPollAt = this.now());
    const seen = new Set<string>();
    for (const acc of this.accs) {
      const present = this.presentThreads(acc, now);
      for (const [threadId, via] of present) {
        const key = `${acc.id}:${threadId}`;
        let t = this.threads.get(key);
        if (!t) {
          t = this.newTracker(acc, threadId);
          this.threads.set(key, t);
        }
        try {
          this.syncThread(t, via, now, boot);
        } catch (err) {
          log.warnOnce(`codex-thread:${key}:${errMsg(err)}`, `Codex: thread ${key}: ${errMsg(err)}`);
        }
        seen.add(key);
      }
    }
    for (const [key, t] of [...this.threads]) {
      if (seen.has(key)) continue;
      t.missingSince ??= now;
      const grace = t.kind === 'main' ? MAIN_GONE_GRACE_MS : CLOSE_AFTER_MISSING_MS;
      if (!boot && now - t.missingSince < grace) continue;
      this.leave(t);
      this.unwatch(t);
      this.threads.delete(key);
    }
    // Subagentes que ficaram para depois (o pai entrou neste ciclo).
    for (const t of this.threads.values()) if (t.kind === 'sub' && !t.inOffice && seen.has(t.key)) this.reconcile(t, now);
  }

  /**
   * Threads presentes de uma conta e por quê: 'lock' (lock com idade suficiente que a sondagem não deu como órfão),
   * 'recent' (sem pasta de locks: candidato pelo mtime ou com escrita recente; quem decide é `wanted`) ou 'hook'
   * (evento de hook recente).
   */
  private presentThreads(acc: CodexAccount, now: number): Map<string, 'lock' | 'recent' | 'hook'> {
    const out = new Map<string, 'lock' | 'recent' | 'hook'>();
    acc.locks = readLocks(acc.dir, this.prober);
    if (acc.locks) {
      this.watchDir(`${acc.dir}${sep}${LOCKS_DIR}`);
      for (const lock of acc.locks.values()) {
        // Órfã (o arquivo ficou e ninguém segura a trava: o Codex morreu): conta como lock sumido.
        if (lock.state === 'free') continue;
        const known = this.threads.get(`${acc.id}:${lock.threadId}`);
        // Lock novo demais (manutenção?): espera (o polling de ~1 s confere de novo). O que já está no escritório
        // não precisa esperar de novo.
        if (now - lock.createdAt < LOCK_SETTLE_MS && !known?.inOffice) continue;
        out.set(lock.threadId, 'lock');
      }
    } else {
      // O mtime só escolhe o que abrir (no Windows ele pode ficar parado); depois de lido, vale a última escrita.
      if (now - acc.recentAt >= 10_000) {
        acc.recentAt = now;
        acc.recent = new Set(acc.index.recentlyModified(FALLBACK_RECENT_MS).map((r) => r.threadId));
      }
      for (const threadId of acc.recent) out.set(threadId, 'recent');
      for (const t of this.threads.values()) {
        if (t.acc === acc && t.lastWriteAt !== undefined && now - t.lastWriteAt <= FALLBACK_RECENT_MS) out.set(t.threadId, 'recent');
      }
    }
    for (const t of this.threads.values()) {
      if (t.acc !== acc || out.has(t.threadId)) continue;
      if (t.lastHookAt !== undefined && now - t.lastHookAt < HOOK_PRESENCE_MS) out.set(t.threadId, 'hook');
    }
    return out;
  }

  private newTracker(acc: CodexAccount, threadId: string): ThreadTracker {
    return {
      key: `${acc.id}:${threadId}`,
      acc,
      threadId,
      kind: 'main',
      nextResolveAt: 0,
      state: createCodexState(),
      backlog: [],
      inOffice: false,
      status: 'idle',
      statusAt: 0,
      subDone: false,
    };
  }

  /** Um ciclo de um thread presente: acha/lê o rollout e decide se ele está (ou continua) no escritório. */
  private syncThread(t: ThreadTracker, via: 'lock' | 'recent' | 'hook', now: number, boot: boolean): void {
    delete t.missingSince;
    if (t.inOffice && !this.opts.office.has(t.key)) t.inOffice = false; // saiu do escritório (graça encerrada)
    this.pump(t, boot);
    this.reconcile(t, now, via);
    if (t.inOffice && t.kind === 'main') {
      this.quietCheck(t, now);
      this.opts.office.fillWorkingActivity(t.key);
    }
  }

  /** O thread deve estar no escritório agora? Entra, sai ou muda de sala conforme o caso. */
  private reconcile(t: ThreadTracker, now: number, via?: 'lock' | 'recent' | 'hook'): void {
    const want = this.wanted(t, now, via);
    if (!want) {
      if (t.inOffice) this.leave(t);
      return;
    }
    if (!t.inOffice) this.enter(t, now);
  }

  private wanted(t: ThreadTracker, now: number, via?: 'lock' | 'recent' | 'hook'): boolean {
    if (t.kind === 'internal') return false;
    const hookRecent = t.lastHookAt !== undefined && now - t.lastHookAt < HOOK_PRESENCE_MS;
    // SessionEnd: fecha, a não ser que algo novo tenha acontecido depois.
    if (t.endedAt !== undefined) {
      const lock = this.lockOf(t);
      const newer = (t.lastHookAt ?? 0) > t.endedAt || (t.lastWriteAt ?? 0) > t.endedAt + 1_000 || (lock?.createdAt ?? 0) > t.endedAt;
      if (newer) delete t.endedAt;
      else if (!lock || now - t.endedAt >= SESSION_END_GRACE_MS) return false;
    }
    if (!hookRecent && via === 'lock') {
      const lock = this.lockOf(t);
      // Só sem sondagem ('unknown'): lock velho de um crash = o lock é antigo e o rollout está parado há muito tempo
      // pela última linha (ou nem existe), mesmo com o turno aberto. Um thread antigo retomado agora tem lock novo (o
      // Codex cria o arquivo ao carregar e o apaga ao descarregar). Com a trava segura ('held'), a sessão está viva.
      const rolloutIdle = !t.rolloutPath || (t.lastWriteAt !== undefined && now - t.lastWriteAt > STALE_LOCK_MS);
      if (lock?.state === 'unknown' && now - lock.createdAt > STALE_LOCK_MS && rolloutIdle) return false;
    }
    // Sem a pasta de locks: o mtime só trouxe o candidato; fica quem escreveu nos últimos 30 min.
    if (!hookRecent && via === 'recent' && (t.lastWriteAt === undefined || now - t.lastWriteAt > FALLBACK_RECENT_MS)) return false;
    // Sem o projeto (sessão aberta ainda sem prompt, só com o lock) não há sala para o principal: espera o rollout ou um
    // hook dizer o cwd. Isso também segura um lock de subagente até o rollout dele dizer de quem ele é.
    if (t.kind === 'main' && !this.cwdOf(t)) return false;
    if (t.kind === 'sub') {
      const parent = this.parentKey(t);
      if (!parent || !this.opts.office.has(parent) || this.opts.office.isSubDone(parent) || this.opts.office.get(parent)?.status === 'offline') return false;
      // Subagente só aparece trabalhando (ou recém-criado pelo hook); depois de entregar, sai.
      if (!t.inOffice && t.status !== 'working' && t.status !== 'waiting' && !t.hookSpawned) return false;
    }
    return true;
  }

  /** Lock do thread que ainda conta: a órfã ('free', ninguém segura a trava) vale como sumida. */
  private lockOf(t: ThreadTracker): LockInfo | undefined {
    const lock = t.acc.locks?.get(t.threadId);
    return lock && lock.state !== 'free' ? lock : undefined;
  }

  /** A trava do thread está segura por um processo vivo do Codex (a sondagem viu). */
  private lockHeld(t: ThreadTracker): boolean {
    return t.acc.locks?.get(t.threadId)?.state === 'held';
  }

  private parentKey(t: ThreadTracker): string | undefined {
    if (!t.parentThreadId) return undefined;
    const direct = `${t.acc.id}:${t.parentThreadId}`;
    return direct;
  }

  /** Projeto conhecido do thread (session_meta ou hook). */
  private cwdOf(t: ThreadTracker): string | undefined {
    return t.meta?.cwd ?? t.hookCwd;
  }

  private enter(t: ThreadTracker, now: number): void {
    const office = this.opts.office;
    if (t.kind === 'main') {
      const cwd = this.cwdOf(t)!;
      office.addMain({
        id: t.key,
        provider: 'codex',
        account: t.acc.id,
        sessionId: t.threadId,
        cwd,
        role: MAIN_ROLE,
        startedAt: t.meta?.startedAt ?? t.state.firstAt ?? now,
        status: t.status,
        waitingFor: t.waitingFor,
      });
      t.inOffice = office.has(t.key);
      if (!t.inOffice) return;
      // Reaberta dentro do período de graça: o status pode ter mudado enquanto esteve fora.
      office.setStatus(t.key, t.status, t.waitingFor);
    } else {
      const parent = this.parentKey(t)!;
      const added = office.addSub({
        id: t.key,
        parentId: parent,
        sessionId: t.threadId,
        role: roleOf(t.meta?.agentRole ?? t.hookRole),
        title: t.state.title,
        background: false,
        startedAt: t.meta?.startedAt ?? t.state.firstAt ?? now,
      });
      if (!added) return;
      t.inOffice = true;
      t.subDone = false;
      delete t.hookSpawned;
      // addSub começa em 'working': um pedido de aprovação visto antes de ele entrar vale já.
      if (t.status === 'waiting') office.setStatus(t.key, 'waiting', t.waitingFor);
    }
    this.flushBacklog(t);
    this.applySummary(t);
  }

  /** Sai do escritório: principal encerra; subagente entrega (se ainda não tinha entregado). */
  private leave(t: ThreadTracker): void {
    if (!t.inOffice) return;
    const office = this.opts.office;
    if (t.kind === 'sub') {
      if (!t.subDone) office.completeSub(t.key);
      t.subDone = true;
    } else office.closeMain(t.key);
    t.inOffice = false;
  }

  /** Leva o status do tracker ao escritório (o subagente entrega ao ficar ocioso e volta ao trabalhar). */
  private statusToOffice(t: ThreadTracker): void {
    if (!t.inOffice) return;
    const office = this.opts.office;
    if (t.kind === 'main') {
      office.setStatus(t.key, t.status, t.waitingFor);
      return;
    }
    if (t.kind !== 'sub') return;
    if (t.status === 'idle') {
      if (!t.subDone) office.completeSub(t.key);
      t.subDone = true;
      return;
    }
    if (t.subDone) {
      office.reactivateSub(t.key);
      t.subDone = office.isSubDone(t.key);
    }
    if (!t.subDone) office.setStatus(t.key, t.status, t.waitingFor);
  }

  // ---------------------------------------------------------------- rollout

  /** Acha o rollout (sem pressa: no máximo a cada 3 s por thread) e lê o que for novo. */
  private pump(t: ThreadTracker, boot: boolean): void {
    if (!t.tail) {
      const now = this.now();
      if (now < t.nextResolveAt) return;
      t.nextResolveAt = now + (boot ? 0 : 3_000);
      const path = t.acc.index.find(t.threadId);
      if (!path) {
        if (t.acc.index.isCompressedOnly(t.threadId)) {
          log.warnOnce('codex-zst', 'Codex: há conversas compactadas (.jsonl.zst) que o Habblaud ainda não lê; elas ficam sem detalhes.');
        }
        return;
      }
      this.load(t, path);
      return;
    }
    for (let i = 0; i < 4; i++) {
      let r;
      try {
        r = t.tail.read();
      } catch (err) {
        log.warnOnce(`codex-read:${t.key}`, `Codex: rollout de ${t.key} ilegível (${errMsg(err)}).`);
        return;
      }
      if (r.missing) {
        // Apagado ou trocado de lugar (arquivado, compactado): procura de novo.
        this.unwatch(t);
        delete t.tail;
        delete t.rolloutPath;
        t.nextResolveAt = 0;
        return;
      }
      // Escrita nova = o arquivo cresceu além do que já foi visto (o mtime não acompanha as escritas no Windows).
      if (t.tail.size > (t.sizeSeen ?? 0)) {
        t.sizeSeen = t.tail.size;
        t.lastWriteAt = Math.max(t.lastWriteAt ?? 0, this.now());
      }
      if (r.reset) {
        // Reescrito no mesmo caminho (ex.: codex migrate-rollouts): relê como histórico.
        this.load(t, t.tail.path);
        return;
      }
      for (const line of r.lines) this.apply(t, parseRolloutLine(t.state, line, { idPrefix: t.key, now: this.now() }), true);
      if (r.lines.length) this.applySummary(t);
      if (!r.more) break;
    }
  }

  /**
   * Abre o rollout: o começo (session_meta, título) e, do fim para trás, pelo menos `tailBytes` e até a fronteira de
   * turno (o turno aberto pode estar a vários MB do fim; a janela fixa daria 'idle' no meio do trabalho). O tail
   * continua de onde a varredura parou: a última linha ainda sem `\n` fica para ele, que a entrega uma vez só quando
   * ela se completar. O começo anterior à varredura vai em segundo plano (números, título e linha do tempo longa).
   */
  private load(t: ThreadTracker, path: string): void {
    const head = readRolloutHead(path);
    if (head.meta) this.setMeta(t, head.meta);
    const tail = new FileTail(path);
    tail.seekEnd(); // fixa o arquivo (inode) e o tamanho antes da varredura
    const scan = scanBackward(path, { size: tail.size, isBoundary: boundaryAfter(this.tailBytes) });
    tail.offset = scan.end;
    t.tail = tail;
    t.rolloutPath = path;
    t.sizeSeen = tail.size;
    t.state = createCodexState(head.meta);
    if (head.title) t.state.title = head.title;
    t.backlog = [];
    for (const line of scan.lines) this.apply(t, parseRolloutLine(t.state, line, { idPrefix: t.key, now: this.now() }), false);
    t.lastWriteAt = lastLineAt(scan.lines) ?? t.state.lastAt;
    this.settleStatus(t);
    if (t.inOffice) {
      this.flushBacklog(t);
      this.statusToOffice(t);
    }
    this.applySummary(t);
    this.watchFile(t, path);
    if (scan.start > 0) this.queuePrefix(t, path, scan.start);
  }

  private setMeta(t: ThreadTracker, meta: RolloutMeta): void {
    t.meta = meta;
    if (meta.internal) t.kind = 'internal';
    else if (meta.parentThreadId) {
      if (t.kind === 'main' && t.inOffice) {
        // Aparecia como sessão aberta (sem rollout ainda) e é um subagente: sai e volta como subagente.
        this.opts.office.closeMain(t.key);
        t.inOffice = false;
      }
      t.kind = 'sub';
      t.parentThreadId = meta.parentThreadId;
    }
  }

  /**
   * Status depois de ler o rollout: o turno aberto (ou, no legacy antigo sem eventos de turno, uma escrita recente) é
   * 'working'; sem a trava segura, um turno aberto sem escrita há WORKING_QUIET_MS é dado como morto. Um status mais
   * novo vindo de hook vence.
   */
  private settleStatus(t: ThreadTracker): void {
    const s = t.state;
    const at = s.lastAt ?? 0;
    if (at < t.statusAt) return;
    let status: AgentStatus;
    if (s.turnOpen !== undefined) status = s.turnOpen ? 'working' : 'idle';
    else status = s.lastAt !== undefined && this.now() - s.lastAt < LEGACY_WORKING_MS ? 'working' : 'idle';
    if (status === 'working' && !this.lockHeld(t) && this.now() - Math.max(t.lastWriteAt ?? 0, at) > WORKING_QUIET_MS) status = 'idle';
    // Turno aberto com request_user_input sem output: espera você responder.
    const asking = status === 'working' && s.asking.size > 0;
    t.status = asking ? 'waiting' : status;
    t.statusAt = at;
    if (asking) t.waitingFor = QUESTION_WAIT;
    else delete t.waitingFor;
  }

  /** Aplica um resultado de linha: ao vivo vai direto ao escritório; na carga inicial, fica no backlog. */
  private apply(t: ThreadTracker, r: CodexLineResult, live: boolean): void {
    for (const sig of r.signals) {
      switch (sig.type) {
        case 'meta':
          this.setMeta(t, sig.meta);
          break;
        case 'usage':
          this.pushUsage(t.acc, sig.usage, sig.plan);
          break;
        case 'turnStart':
          this.decide(t, 'working', r.at, undefined, live);
          break;
        case 'turnEnd':
          this.decide(t, 'idle', r.at, undefined, live);
          break;
        case 'progress':
          // Algo andou: sai a espera por aprovação; com uma pergunta ainda aberta, volta a esperar a resposta.
          if (t.status === 'waiting' && t.waitingFor !== QUESTION_WAIT) {
            if (t.state.asking.size) this.decide(t, 'waiting', r.at, QUESTION_WAIT, live);
            else this.decide(t, 'working', r.at, undefined, live);
          }
          break;
        case 'asking':
          // Não troca uma espera por aprovação (hook PermissionRequest) que já esteja valendo.
          if (t.status !== 'waiting' || t.waitingFor === QUESTION_WAIT) this.decide(t, 'waiting', r.at, QUESTION_WAIT, live);
          break;
        case 'answered':
          // Só a espera da pergunta sai com a resposta (a de aprovação continua até o comando andar).
          if (t.status === 'waiting' && t.waitingFor === QUESTION_WAIT) this.decide(t, 'working', r.at, undefined, live);
          break;
        default:
          break;
      }
    }
    if (!live || !t.inOffice) {
      if (r.activities.length || r.signals.some((s) => s.type === 'github')) {
        t.backlog.push(r);
        if (t.backlog.length > BACKLOG_MAX) t.backlog.splice(0, t.backlog.length - BACKLOG_MAX);
      }
      return;
    }
    this.toOffice(t, r, true);
  }

  private toOffice(t: ThreadTracker, r: CodexLineResult, live: boolean): void {
    const office = this.opts.office;
    for (const a of r.activities) office.addActivity(t.key, a.activity, a.current, { feed: live, replace: a.replace });
    for (const sig of r.signals) {
      // Só o que chega ao vivo anima a sala; a carga inicial vai para o histórico.
      if (sig.type === 'github') office.githubEvent(t.key, sig.event, { key: sig.key, at: r.at, live });
    }
  }

  private flushBacklog(t: ThreadTracker): void {
    const backlog = t.backlog;
    t.backlog = [];
    for (const r of backlog) this.toOffice(t, r, false);
  }

  /**
   * Muda o status por uma borda (início/fim de turno, hook): informação mais velha que a última decisão não vale.
   * `live` = aplica no escritório agora (a carga inicial só guarda; o status entra junto com o agente).
   */
  private decide(t: ThreadTracker, status: AgentStatus, at: number, waitingFor: string | undefined, live: boolean): void {
    if (at < t.statusAt) return;
    t.statusAt = at;
    t.status = status;
    if (waitingFor) t.waitingFor = waitingFor;
    else delete t.waitingFor;
    if (live) this.statusToOffice(t);
  }

  /**
   * 'working' sem nenhuma notícia por muito tempo (turno morto num crash): vira 'idle'. Só sem a trava segura: com ela
   * o processo está vivo e o turno aberto continua (um comando longo pode passar horas sem escrever nada).
   */
  private quietCheck(t: ThreadTracker, now: number): void {
    if (t.status !== 'working' || this.lockHeld(t)) return;
    const last = Math.max(t.lastWriteAt ?? 0, t.lastHookAt ?? 0, t.statusAt);
    if (now - last > WORKING_QUIET_MS) this.decide(t, 'idle', now, undefined, true);
  }

  private applySummary(t: ThreadTracker): void {
    if (!t.inOffice) return;
    const s = t.state;
    const summary: TranscriptSummary = { tasks: s.tasks, stats: { ...s.stats } };
    if (s.title) summary.title = s.title;
    if (s.model) summary.model = s.model;
    const branch = s.gitBranch ?? t.meta?.gitBranch;
    if (branch) summary.gitBranch = branch;
    if (s.firstAt !== undefined) summary.firstAt = s.firstAt;
    if (s.lastAt !== undefined) summary.lastAt = s.lastAt;
    this.opts.office.applyTranscript(t.key, summary);
  }

  /**
   * Começo de um rollout grande (os bytes antes da varredura, sem sobreposição com ela): números, título e a linha do
   * tempo longa. O status não sai daqui: a varredura já tem a fronteira de turno.
   */
  private queuePrefix(t: ThreadTracker, path: string, end: number): void {
    const state = t.state;
    this.prefixChain = this.prefixChain
      .then(async () => {
        if (this.stopped) return;
        const prefix = await scanPrefix(path, end, t.key, PREFIX_HISTORY);
        if (this.threads.get(t.key) !== t || t.state !== state) return;
        state.stats.toolCalls += prefix.state.stats.toolCalls;
        state.stats.subagents += prefix.state.stats.subagents;
        state.title ??= prefix.state.title;
        state.model ??= prefix.state.model;
        if (!state.tasks.length && prefix.state.tasks.length) state.tasks = prefix.state.tasks;
        if (prefix.state.firstAt !== undefined && (state.firstAt === undefined || prefix.state.firstAt < state.firstAt)) state.firstAt = prefix.state.firstAt;
        this.applySummary(t);
        if (t.inOffice) this.opts.office.mergeHistory(t.key, prefix.activities);
      })
      .catch((err) => log.warnOnce(`codex-prefix:${path}`, `Codex: não foi possível ler o início de um rollout (${errMsg(err)}).`));
  }

  // ---------------------------------------------------------------- uso do plano

  /** Uso da conta (e o plano junto): vale o mais recente entre as sessões dela. */
  private pushUsage(acc: CodexAccount, usage: AccountUsage, plan: string | undefined): void {
    if (acc.usage && usage.fetchedAt < acc.usage.fetchedAt) return;
    acc.usage = usage;
    this.opts.accounts.setUsage(acc.id, usage);
    this.pushPlan(acc, plan);
  }

  /** O plano (rate_limits.plan_type) entra na conta. */
  private pushPlan(acc: CodexAccount, plan: string | undefined): void {
    const label = codexPlanLabel(plan);
    if (label && label !== acc.plan) {
      acc.plan = label;
      const i = this.accs.indexOf(acc);
      if (i >= 0 && this.detected[i]) {
        this.detected[i] = { ...this.detected[i], plan: label };
        this.register();
      }
    }
  }

  /**
   * Conta sem sessão aberta ao subir: o uso do rollout mais recente que tenha números (fica "desatualizado" com a
   * idade: os números do Codex só se renovam com alguma sessão rodando). Por mtime em TODAS as pastas de data (uma
   * sessão retomada continua no arquivo da pasta antiga), tentando os SEED_USAGE_FILES mais recentes: o último pode não
   * ter `token_count` nenhum (sessão sem resposta, ou arquivada logo).
   */
  private seedUsage(acc: CodexAccount): void {
    const files: Array<{ path: string; mtimeMs: number }> = [];
    for (const dir of rolloutDirs(acc.dir)) {
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch {
        continue;
      }
      for (const name of names) {
        const r = parseRolloutName(name);
        if (!r || r.compressed) continue;
        try {
          files.push({ path: join(dir, name), mtimeMs: statSync(join(dir, name)).mtimeMs });
        } catch {
          // sumiu
        }
      }
    }
    files.sort((a, b) => b.mtimeMs - a.mtimeMs);
    let plan: string | undefined;
    for (const f of files.slice(0, SEED_USAGE_FILES)) {
      try {
        const tail = new FileTail(f.path);
        tail.seekTail(256 * 1024);
        const state = createCodexState();
        for (let i = 0; i < 4; i++) {
          const r = tail.read();
          for (const line of r.lines) parseRolloutLine(state, line, { idPrefix: '', now: this.now(), activities: false });
          if (!r.more) break;
        }
        plan ??= state.planType;
        if (state.usage) return this.pushUsage(acc, state.usage, state.planType ?? plan);
      } catch {
        // ilegível agora: tenta o seguinte
      }
    }
    if (!acc.plan) this.pushPlan(acc, plan);
  }

  // ---------------------------------------------------------------- hooks (CodexLive)

  applyHookEvent(account: string | undefined, input: Record<string, unknown>): boolean {
    try {
      return this.hookEvent(account, input);
    } catch (err) {
      log.warnOnce(`codex-hook:${errMsg(err)}`, `Codex: evento de hook ignorado (${errMsg(err)}).`);
      return false;
    }
  }

  private hookEvent(account: string | undefined, input: Record<string, unknown>): boolean {
    const event = str(input.hook_event_name);
    if (!event || !HOOK_EVENTS.has(event)) return false;
    const root = str(input.session_id)?.toLowerCase();
    const agent = str(input.agent_id)?.toLowerCase();
    if (!isThreadId(root)) return false;
    const target = agent && isThreadId(agent) ? agent : root;
    const agentType = str(input.agent_type);
    if (agentType && /guardian/i.test(agentType)) return false;
    const acc = this.accountFor(account, input, target);
    if (!acc) return false;
    const now = this.now();
    const cwd = str(input.cwd);
    const office = this.opts.office;

    if (event === 'SessionEnd') {
      const t = this.threads.get(`${acc.id}:${root}`);
      if (!t) return false;
      t.endedAt = now;
      delete t.lastHookAt;
      this.reconcile(t, now);
      this.schedule();
      return true;
    }

    // Subagente: o thread filho vem em agent_id (o pai, até sabermos pelo session_meta, é a raiz).
    const isSubEvent = target !== root || event === 'SubagentStart' || event === 'SubagentStop';
    const subId = event === 'SubagentStart' || event === 'SubagentStop' ? (agent && isThreadId(agent) ? agent : undefined) : target !== root ? target : undefined;
    if (isSubEvent && !subId) return false;
    const rootT = this.touch(acc, root, now, cwd);
    const t = subId ? this.touch(acc, subId, now, cwd, root, agentType) : rootT;
    this.hintTranscript(acc, subId ?? root, event === 'SubagentStop' ? str(input.agent_transcript_path) : subId ? undefined : str(input.transcript_path));
    this.reconcile(rootT, now, 'hook');

    switch (event) {
      case 'SubagentStart':
        t.hookSpawned = true;
        this.decide(t, 'working', now, undefined, true);
        break;
      case 'SubagentStop':
        this.decide(t, 'idle', now, undefined, true);
        break;
      case 'UserPromptSubmit':
      case 'PostToolUse':
      case 'PreCompact':
      case 'PostCompact':
        this.decide(t, 'working', now, undefined, true);
        break;
      case 'PreToolUse': {
        this.decide(t, 'working', now, undefined, true);
        if (t !== rootT) this.reconcile(t, now, 'hook');
        const toolName = str(input.tool_name) ?? 'ferramenta';
        const toolInput = rec(input.tool_input) ?? {};
        const { desc, tool } = describeCodexTool(toolName, toolInput);
        const id = str(input.tool_use_id);
        const act: Activity = { id: `${t.key}#${id ?? `hook${now.toString(36)}`}`, at: now, ...desc, tool };
        if (t.inOffice) office.addActivity(t.key, act, true);
        break;
      }
      case 'PermissionRequest':
        this.decide(t, 'waiting', now, 'aprovar um comando', true);
        break;
      case 'Stop':
      case 'Interrupt':
        this.decide(t, 'idle', now, undefined, true);
        break;
      default:
        break;
    }
    if (t !== rootT) this.reconcile(t, now, 'hook');
    return true;
  }

  /** Tracker do thread (criado se preciso), com a presença dada pelo hook. */
  private touch(acc: CodexAccount, threadId: string, now: number, cwd: string | undefined, parent?: string, agentType?: string): ThreadTracker {
    const key = `${acc.id}:${threadId}`;
    let t = this.threads.get(key);
    if (!t) {
      t = this.newTracker(acc, threadId);
      this.threads.set(key, t);
    }
    t.lastHookAt = now;
    delete t.missingSince;
    if (t.endedAt !== undefined && now > t.endedAt) delete t.endedAt;
    if (cwd) t.hookCwd ??= cwd;
    if (parent && !t.meta && t.kind === 'main') {
      t.kind = 'sub';
      t.parentThreadId = parent;
    }
    if (agentType) t.hookRole ??= agentType;
    if (t.inOffice && !this.opts.office.has(t.key)) t.inOffice = false;
    this.pump(t, false);
    return t;
  }

  /** `transcript_path` do hook, se for um rollout dentro da pasta da conta (no Docker é do host: não serve). */
  private hintTranscript(acc: CodexAccount, threadId: string, path: string | undefined): void {
    if (!path) return;
    const t = this.threads.get(`${acc.id}:${threadId}`);
    if (t?.tail) return;
    try {
      const real = realpathSync(path);
      const root = realpathSync(acc.dir);
      if (!real.startsWith(root + sep) || parseRolloutName(basename(real))?.threadId !== threadId) return;
      acc.index.hint(threadId, real);
      if (t) t.nextResolveAt = 0;
    } catch {
      // não existe aqui (Docker) ou ainda não foi criado
    }
  }

  /**
   * Conta de um evento: `account` (id ou pasta), senão a do `transcript_path`, senão a que já conhece o thread;
   * com uma conta só, ela.
   */
  private accountFor(account: string | undefined, input: Record<string, unknown>, threadId: string): CodexAccount | undefined {
    const norm = (p: string) => {
      try {
        return resolve(p);
      } catch {
        return p;
      }
    };
    if (account) {
      const byId = this.accs.find((a) => a.id === account);
      if (byId) return byId;
      const abs = norm(account);
      const byDir = this.accs.find((a) => norm(a.dir) === abs || norm(a.configDir) === abs);
      if (byDir) return byDir;
    }
    for (const raw of [str(input.transcript_path), str(input.agent_transcript_path)]) {
      if (!raw) continue;
      const p = norm(raw);
      const byPath = this.accs.find((a) => p.startsWith(norm(a.dir) + sep) || p.startsWith(norm(a.configDir) + sep));
      if (byPath) return byPath;
    }
    const known = this.accs.filter((a) => this.threads.has(`${a.id}:${threadId}`));
    if (known.length === 1) return known[0];
    if (account) {
      const byName = this.accs.find((a) => basename(a.dir) === basename(account) || basename(a.configDir) === basename(account));
      if (byName) return byName;
    }
    return this.accs.length === 1 ? this.accs[0] : undefined;
  }

  // ---------------------------------------------------------------- fs.watch (acelerador)

  private watchDir(dir: string): void {
    if (!this.useWatch || this.dirWatchers.has(dir)) return;
    try {
      const w = watch(dir, { persistent: false }, () => this.schedule());
      w.on('error', () => {
        w.close();
        this.dirWatchers.delete(dir);
      });
      this.dirWatchers.set(dir, w);
    } catch {
      // sem suporte: o polling cobre
    }
  }

  private watchFile(t: ThreadTracker, path: string): void {
    if (!this.useWatch) return;
    this.unwatch(t);
    try {
      const w = watch(path, { persistent: false }, () => this.schedule());
      w.on('error', () => w.close());
      t.watcher = w;
    } catch {
      // sem suporte: o polling cobre
    }
  }

  private unwatch(t: ThreadTracker): void {
    t.watcher?.close();
    delete t.watcher;
  }
}

/**
 * Fronteira de turno para a varredura reversa, mas só depois de juntar `minBytes` do fim: as atividades recentes e o
 * último token_count/rate_limits vêm junto, como na janela fixa de antes, mesmo com o turno recém-fechado.
 */
function boundaryAfter(minBytes: number): (line: string) => boolean {
  let bytes = 0;
  return (line) => {
    bytes += Buffer.byteLength(line) + 1;
    return bytes >= minBytes && isTurnBoundary(line);
  };
}

/** `timestamp` da última linha que tiver um (as linhas vêm na ordem do arquivo). */
function lastLineAt(lines: string[]): number | undefined {
  for (let i = lines.length - 1; i >= 0; i--) {
    const at = lineTimestamp(lines[i]);
    if (at !== undefined) return at;
  }
  return undefined;
}

/**
 * Lê em stream (sem travar o event loop) os bytes [0, end) de um rollout: os números, o título e as últimas
 * `keep` atividades anteriores à varredura feita ao abrir a sessão.
 */
export async function scanPrefix(path: string, end: number, idPrefix: string, keep: number): Promise<{ state: CodexState; activities: Activity[] }> {
  const state = createCodexState();
  let activities: Activity[] = [];
  if (end <= 0) return { state, activities };
  const ctx = { idPrefix, now: Date.now(), activities: keep > 0 };
  const take = (line: string) => {
    const r = parseRolloutLine(state, line, ctx);
    for (const a of r.activities) activities.push(a.activity);
    if (activities.length > keep * 2) activities = activities.slice(-keep);
  };
  let partial: Buffer | null = null;
  const stream = createReadStream(path, { start: 0, end: end - 1, highWaterMark: 1024 * 1024 });
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    const data: Buffer = partial ? Buffer.concat([partial, chunk]) : chunk;
    let start = 0;
    for (let i = data.indexOf(0x0a, start); i !== -1; i = data.indexOf(0x0a, start)) {
      const line = data.toString('utf8', start, i);
      start = i + 1;
      if (line) take(line);
    }
    partial = start < data.length ? Buffer.from(data.subarray(start)) : null;
  }
  if (partial?.length) take(partial.toString('utf8'));
  return { state, activities: activities.slice(-keep) };
}
