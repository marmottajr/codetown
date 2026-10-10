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
// - sem lock (ou órfã) = fechada, depois da graça de MAIN_GONE_GRACE_MS (principal) ou de 1,5 s (subagente; o que ainda
//   não concluiu espera SUB_FOLLOWUP_GRACE_MS, porque volta com o mesmo id num followup_task). Só no modo 'unknown':
//   lock criado há mais de STALE_LOCK_MS, rollout parado há mais de STALE_LOCK_MS pela ÚLTIMA LINHA
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
// revisão, compactação, memória) ficam de fora. O título do filho é a tarefa do spawn_agent do pai (sinal 'spawn' com
// o id do filho, guardado até ele entrar), senão o 1º texto do próprio filho. Um neto (depth 2) cujo pai já entregou
// ou saiu fica ligado ao principal da árvore (session_meta.session_id): entra assim e não sai quando o pai conclui.
//
// Status: aplicado por bordas (início/fim de turno no rollout, eventos de hook), a informação mais nova vence; um
// rollout relido nunca sobrescreve o 'waiting' de um PermissionRequest mais novo. Um request_user_input sem output é
// 'waiting' ("responder uma pergunta") até a resposta ou o fim do turno, sem trocar uma espera por aprovação que já
// esteja valendo (a resposta só tira a espera da pergunta, e só quando não sobra outra aberta). Comandos em segundo
// plano (shells.ts: exec_command com "Process running with session ID N", célula do code mode com "Script running with
// cell ID N") ficam no agente que os rodou (ou no principal, depois que ele entrega); o principal ocioso com algum vivo
// fica 'shell'. O fim vem do write_stdin/wait ou do CommandExecution com o process_id ('ShellDone'); o próximo
// task_started do dono, o thread fechar ou SHELL_EXPIRE_MS depois do fim do turno encerram a espera sem 'ShellDone'.
// Com a trava segura o turno aberto continua 'working' sem prazo; sem sondagem, 'working' sem nenhuma escrita por
// WORKING_QUIET_MS vira 'idle' (principal e subagente), e uma linha nova do turno ainda aberto volta a 'working' (ou a
// 'waiting', com pergunta aberta), decidido no fim de cada leitura: a resposta final lida junto com o task_complete
// depois de um Stop não traz o agente de volta. Ao abrir um rollout: o começo (session_meta, título) e, do fim para trás, pelo menos
// `tailBytes` e até a fronteira de turno (reader.ts: o turno aberto pode estar a vários MB do fim); o tail continua de
// onde a varredura parou e o começo anterior a ela é lido depois, em segundo plano (números e linha do tempo longa).
// Boot síncrono, com endBoot num `finally`.
import { realpathSync, type FSWatcher } from 'node:fs';
import { basename, resolve, sep } from 'node:path';
import { codexApprovalReason } from '../../../shared/activity';
import type { Activity, AgentStatus, SourceInfo } from '../../../shared/types';
import type { DetectedAccount } from '../../accounts/detect';
import type { AccountEntry } from '../../accounts/service';
import { detectDocker } from '../../config';
import { errMsg, log } from '../../log';
import type { TranscriptSummary } from '../../model/office';
import { networkTarget } from '../../permissions/codex';
import { reportShellDone, type ShellTracker } from '../shells';
import type { AgentSource } from '../source';
import { FileTail } from '../tail';
import type { TerminalParser } from '../terminal';
import { detectCodexAccounts } from './accounts';
import { readRolloutHead, RolloutIndex, parseRolloutName } from './files';
import { ThreadNameIndex } from './history';
import type { CodexLive } from './live';
import { createLockProber, type LockProber } from './locks';
import { scanBackward } from './reader';
import {
  codexAgentPath,
  createCodexState,
  describeCodexTool,
  isThreadId,
  parseRolloutLine,
  type CodexLineResult,
  type RolloutMeta,
} from './rollout';
import { createShellScan } from './shells';
import { CodexPresence } from './source-presence';
import { boundaryAfter, lastLineAt, scanPrefix } from './source-scan';
import { CodexShells } from './source-shells';
import { CodexThreadTree } from './source-tree';
import { newTracker, type CodexAccount, type CodexSourceOptions, type ThreadTracker } from './source-types';
import { CodexUsage } from './source-usage';
import { CodexWatchers } from './source-watch';
import { createCodexTerminalParser } from './terminal';

export { FALLBACK_RECENT_MS, HOOK_PRESENCE_MS, LOCK_SETTLE_MS, SESSION_END_GRACE_MS, STALE_LOCK_MS } from './source-presence';
export { scanPrefix } from './source-scan';
export { SHELL_EXPIRE_MS } from './source-shells';
export type { CodexSourceOptions } from './source-types';
export { USAGE_RESCAN_MS } from './source-usage';

/** Principal ausente (lock sumido ou órfão, presença do hook vencida) por este tempo: encerrado. */
export const MAIN_GONE_GRACE_MS = 5_000;
/** Subagente ausente por este tempo: entrega e sai. */
const CLOSE_AFTER_MISSING_MS = 1_500;
/**
 * Subagente que ainda não concluiu e cuja trava sumiu: espera isto antes de sair, porque ele volta com o mesmo id (o
 * pai manda um followup_task e o Codex o carrega de novo). O concluído sai com CLOSE_AFTER_MISSING_MS.
 */
export const SUB_FOLLOWUP_GRACE_MS = 120_000;
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
/** Títulos de filhos (sinal spawn) guardados até o filho aparecer. */
const SPAWN_TITLES_MAX = 256;
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
  /** Título de cada filho pelo spawn_agent do pai ("<conta>:<thread do filho>" → título), até o filho aparecer. */
  private spawnTitles = new Map<string, string>();
  /** Processos em segundo plano de cada árvore (principal e subagentes), pela chave do principal. */
  private shellTrees = new Map<string, ShellTracker>();
  private dirWatchers = new Map<string, FSWatcher>();
  /** Nome das threads (session_index.jsonl): o título do principal, como no histórico. */
  private readonly threadNames = new ThreadNameIndex();
  private timer: ReturnType<typeof setInterval> | null = null;
  private kick: ReturnType<typeof setTimeout> | null = null;
  private lastPollAt = 0;
  private prefixChain: Promise<void> = Promise.resolve();
  private readonly now: () => number;
  private readonly tailBytes: number;
  private readonly useWatch: boolean;
  private readonly prober: LockProber;
  private readonly tree: CodexThreadTree;
  private readonly watchers: CodexWatchers;
  private readonly presence: CodexPresence;
  private readonly shells: CodexShells;
  private readonly usage: CodexUsage;
  private stopped = false;

  constructor(private readonly opts: CodexSourceOptions) {
    this.now = opts.now ?? Date.now;
    this.tailBytes = opts.tailBytes ?? 1024 * 1024;
    this.useWatch = opts.watch ?? true;
    const env = opts.env ?? process.env;
    this.prober = opts.lockProber ?? createLockProber({ platform: process.platform, inDocker: detectDocker(env) });
    this.tree = new CodexThreadTree(this.threads, opts);
    this.watchers = new CodexWatchers(this.useWatch, this.dirWatchers, () => this.schedule());
    this.presence = new CodexPresence(this.threads, this.prober, this.watchers, this.tree);
    this.shells = new CodexShells(this.shellTrees, this.threads, opts, this.now, this.tree);
    this.usage = new CodexUsage({ opts, threads: this.threads, now: this.now, accs: () => this.accs, detected: () => this.detected, register: () => this.register() });
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
      return { id: e.id, dir: e.dir, configDir: e.detected.configDir, index: new RolloutIndex(e.dir, this.now), locks: null, recent: new Set(), recentAt: -Infinity, usageScanAt: -Infinity };
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
      for (const acc of this.accs) {
        acc.usageScanAt = this.now();
        if (!acc.usage) this.usage.seedUsage(acc);
      }
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
    for (const t of this.threads.values()) this.watchers.unwatch(t);
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

  /** Com o session_meta do cabeçalho: a janela do fim lida pelo terminal pode não ter o dele (fork: o do pai vem depois). */
  terminalParser(agentId: string): TerminalParser | undefined {
    const t = this.threads.get(agentId);
    return t ? createCodexTerminalParser({ meta: t.state.meta }) : undefined;
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
    /** Threads presentes neste ciclo, e por quê. */
    const seen = new Map<string, 'lock' | 'recent' | 'hook'>();
    for (const acc of this.accs) {
      const present = this.presence.presentThreads(acc, now);
      for (const [threadId, via] of present) {
        const key = `${acc.id}:${threadId}`;
        let t = this.threads.get(key);
        if (!t) {
          t = newTracker(acc, threadId);
          this.threads.set(key, t);
        }
        try {
          this.syncThread(t, via, now, boot);
        } catch (err) {
          log.warnOnce(`codex-thread:${key}:${errMsg(err)}`, `Codex: thread ${key}: ${errMsg(err)}`);
        }
        seen.set(key, via);
      }
    }
    for (const [key, t] of [...this.threads]) {
      if (seen.has(key)) continue;
      if (t.missingSince === undefined) {
        t.missingSince = now;
        // Primeiro ciclo sem a trava: uma última leitura antes da graça. Sem fs.watch (Docker, macOS), o task_complete e
        // a soltura da trava podem cair no mesmo intervalo de poll; sem ela, o status ficaria 'working' (graça de 120 s
        // para o subagente) e a última resposta nunca entraria.
        try {
          this.pump(t, false);
        } catch (err) {
          log.warnOnce(`codex-thread:${key}:${errMsg(err)}`, `Codex: thread ${key}: ${errMsg(err)}`);
        }
      }
      const grace = t.kind === 'main' ? MAIN_GONE_GRACE_MS : t.kind === 'sub' && !t.subDone && t.status !== 'idle' ? SUB_FOLLOWUP_GRACE_MS : CLOSE_AFTER_MISSING_MS;
      if (!boot && now - t.missingSince < grace) continue;
      this.leave(t);
      this.turnTo(t, false);
      this.watchers.unwatch(t);
      this.threads.delete(key);
      // Thread fechado: os processos dele morrem junto (a sessão do Codex encerra os terminais em segundo plano).
      if (t.kind !== 'main') this.shells.dropShells(t.key, this.shells.treeKey(t), now);
      else if (this.shellTrees.delete(key)) this.opts.office.setShells(key, []);
    }
    // Subagentes presentes, depois de todos os threads lidos e das entradas e saídas deste ciclo, o pai antes do neto: a
    // ligação do neto (pai direto ou principal) não depende da ordem do readdir, e o neto ligado ao principal sai se o
    // principal fechou agora (o closeMain não o alcança pelo pai direto).
    const subs = [...this.threads.values()].filter((t) => t.kind === 'sub' && seen.has(t.key));
    const depth = new Map(subs.map((t) => [t, this.tree.depthOf(t)]));
    for (const t of subs.sort((a, b) => depth.get(a)! - depth.get(b)!)) {
      try {
        this.reconcile(t, now, seen.get(t.key));
        if (t.inOffice) this.quietCheck(t, now);
      } catch (err) {
        log.warnOnce(`codex-thread:${t.key}:${errMsg(err)}`, `Codex: thread ${t.key}: ${errMsg(err)}`);
      }
    }
    // Shells de cada árvore, a cada ciclo: expiração, o de quem entregou ou fechou passa ao principal, e o status.
    for (const [root, tree] of [...this.shellTrees]) {
      if (!tree.size && !this.threads.has(root)) this.shellTrees.delete(root);
      else this.refreshShells(root);
    }
    if (!boot) this.usage.rescanUsage(now);
  }

  /**
   * Um ciclo de um thread presente: acha/lê o rollout e decide se ele está (ou continua) no escritório. O subagente é
   * decidido no fim do ciclo (poll), depois de todos os threads lidos.
   */
  private syncThread(t: ThreadTracker, via: 'lock' | 'recent' | 'hook', now: number, boot: boolean): void {
    delete t.missingSince;
    if (t.inOffice && !this.opts.office.has(t.key)) t.inOffice = false; // saiu do escritório (graça encerrada)
    this.pump(t, boot);
    // Thread ainda sem rollout (o Codex só o cria no primeiro prompt): nenhum turno aberto.
    if (!t.tail && t.turnSent === undefined) this.turnTo(t, false);
    if (t.kind === 'sub') return;
    this.reconcile(t, now, via);
    if (t.inOffice && t.kind === 'main') {
      this.quietCheck(t, now);
      this.opts.office.fillWorkingActivity(t.key);
    }
  }

  /** O thread deve estar no escritório agora? Entra, sai ou muda de sala conforme o caso. */
  private reconcile(t: ThreadTracker, now: number, via?: 'lock' | 'recent' | 'hook'): void {
    const want = this.presence.wanted(t, now, via);
    if (!want) {
      if (t.inOffice) this.leave(t);
      return;
    }
    if (!t.inOffice) this.enter(t, now);
  }

  private enter(t: ThreadTracker, now: number): void {
    const office = this.opts.office;
    if (t.kind === 'main') {
      const cwd = this.tree.cwdOf(t)!;
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
      // Reaberta dentro do período de graça: o status pode ter mudado enquanto esteve fora (e pode haver shell vivo).
      this.statusToOffice(t);
    } else {
      const parent = this.tree.parentKey(t)!;
      const added = office.addSub({
        id: t.key,
        parentId: parent,
        sessionId: t.threadId,
        role: roleOf(t.meta?.agentRole ?? t.hookRole),
        // A tarefa que o pai deu no spawn_agent; sem ela, o 1º texto do próprio filho.
        title: this.spawnTitles.get(t.key) ?? t.state.title,
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

  /** Sai do escritório: principal encerra; subagente entrega (se ainda não tinha entregado). O turno conta como fechado. */
  private leave(t: ThreadTracker): void {
    if (!t.inOffice) return;
    const office = this.opts.office;
    if (t.kind === 'sub') {
      if (!t.subDone) office.completeSub(t.key);
      t.subDone = true;
    } else office.closeMain(t.key);
    t.inOffice = false;
    this.turnTo(t, false);
  }

  /** Avisa o onTurn que o turno do thread abriu ou fechou (o mesmo valor seguido não sai de novo). */
  private turnTo(t: ThreadTracker, open: boolean): void {
    if (t.turnSent === open || !this.opts.onTurn) return;
    t.turnSent = open;
    // O id como o Codex o grava (o do session_meta): o canal paralelo o compara com o do app-server sem normalizar.
    // Locks, nomes de arquivo e hooks chegam aqui em minúsculas.
    const own = t.meta?.threadId;
    const threadId = own && own.toLowerCase() === t.threadId ? own : t.threadId;
    try {
      this.opts.onTurn(t.acc.id, threadId, open);
    } catch (err) {
      log.warnOnce(`codex-turn:${errMsg(err)}`, `Codex: o aviso de turno ao canal paralelo falhou (${errMsg(err)}).`);
    }
  }

  /**
   * Leva o status do tracker ao escritório (o subagente entrega ao ficar ocioso e volta ao trabalhar). O principal
   * ocioso com shell em segundo plano vivo vai direto para 'shell' (nunca 'idle' e depois 'shell': sairia o "concluiu");
   * os shells vão antes do status (o aviso usa o rótulo deles) e o balão de espera depois.
   */
  private statusToOffice(t: ThreadTracker): void {
    if (!t.inOffice) return;
    const office = this.opts.office;
    if (t.kind === 'main') {
      const shell = this.shells.publishShells(t.key);
      office.setStatus(t.key, t.status === 'idle' && shell ? 'shell' : t.status, t.waitingFor);
      office.fillShellActivity(t.key);
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

  // ---------------------------------------------------------------- shells

  /** Reaplica os shells de uma árvore (e o status do principal, que depende deles). */
  private refreshShells(root: string): void {
    const main = this.threads.get(root);
    if (main?.kind === 'main' && main.inOffice) this.statusToOffice(main);
    else this.shells.publishShells(root);
  }

  // ---------------------------------------------------------------- rollout

  /**
   * Uma linha do rollout: shells, sinais e atividades; ao vivo, o fim de um processo vira 'ShellDone' no dono (ou no
   * principal, se o dono já entregou ou saiu).
   */
  private take(t: ThreadTracker, line: string, live: boolean): void {
    const r = parseRolloutLine(t.state, line, { idPrefix: t.key, now: this.now() });
    const fins = this.shells.trackShells(t, line, r);
    this.apply(t, r, live);
    if (!live || !fins) return;
    const root = this.shells.treeKey(t);
    for (const fin of fins) reportShellDone(this.opts.office, root, fin, true);
    this.refreshShells(root);
  }

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
        this.watchers.unwatch(t);
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
      for (const line of r.lines) this.take(t, line, true);
      this.reviveIfOpen(t);
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
    t.shellScan = createShellScan();
    if (head.title) t.state.title = head.title;
    t.backlog = [];
    for (const line of scan.lines) this.take(t, line, false);
    t.lastWriteAt = lastLineAt(scan.lines) ?? t.state.lastAt;
    this.settleStatus(t);
    // O estado do turno ao abrir: o canal paralelo solta a thread que assinou no boot e cujo turno já fechou.
    this.turnTo(t, t.state.turnOpen === true);
    if (t.inOffice) {
      this.flushBacklog(t);
      this.statusToOffice(t);
    }
    this.applySummary(t);
    this.watchers.watchFile(t, path);
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
    if (status === 'working' && !this.presence.lockHeld(t) && this.now() - Math.max(t.lastWriteAt ?? 0, at) > WORKING_QUIET_MS) status = 'idle';
    // Turno aberto com request_user_input sem output: espera você responder.
    const asking = status === 'working' && s.asking.size > 0;
    t.status = asking ? 'waiting' : status;
    t.statusAt = at;
    if (asking) t.waitingFor = QUESTION_WAIT;
    else delete t.waitingFor;
  }

  /** Aplica um resultado de linha: ao vivo vai direto ao escritório; na carga inicial, fica no backlog. */
  private apply(t: ThreadTracker, r: CodexLineResult, live: boolean): void {
    // Subagente ao vivo: o "Concluiu" do próprio rollout chega ao escritório antes do fim do turno que o entrega. O
    // completeSub sintetiza um "Concluiu" quando a atividade atual não é uma conclusão; depois dele, o do rollout
    // ficaria duplicado.
    const doneFirst = live && t.inOffice && t.kind === 'sub' && r.activities.some((a) => a.activity.kind === 'done');
    if (doneFirst) this.toOffice(t, r, true);
    for (const sig of r.signals) {
      switch (sig.type) {
        case 'meta':
          this.setMeta(t, sig.meta);
          break;
        case 'usage':
          this.usage.pushUsage(t.acc, sig.usage, sig.plan);
          break;
        case 'turnStart':
          this.decide(t, 'working', r.at, undefined, live);
          if (live) this.turnTo(t, true);
          break;
        case 'turnEnd':
          this.decide(t, 'idle', r.at, undefined, live);
          if (live) this.turnTo(t, false);
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
          // Só a espera da pergunta sai com a resposta (a de aprovação continua até o comando andar), e só quando não
          // sobra outra pergunta aberta (o parser emite um 'answered' por pergunta respondida).
          if (t.status === 'waiting' && t.waitingFor === QUESTION_WAIT && !t.state.asking.size) this.decide(t, 'working', r.at, undefined, live);
          break;
        case 'spawn':
          // Título do filho: vale quando ele entrar no escritório (sem o id dele não há como casar).
          if (sig.childThreadId) {
            const key = `${t.acc.id}:${sig.childThreadId.toLowerCase()}`;
            this.spawnTitles.delete(key);
            this.spawnTitles.set(key, sig.title);
            if (this.spawnTitles.size > SPAWN_TITLES_MAX) this.spawnTitles.delete(this.spawnTitles.keys().next().value as string);
          }
          break;
        default:
          break;
      }
    }
    // Turno ainda aberto que o corte de inatividade (ou um Stop) deu como ocioso e voltou a andar: anotado aqui e
    // decidido no fim da leitura (reviveIfOpen), quando o resto do turno lido junto já foi aplicado.
    if (live && t.status === 'idle' && t.state.turnOpen === true && (r.activities.length || r.signals.some((s) => s.type === 'progress'))) {
      t.reviveAt = r.at;
    }
    if (doneFirst) return;
    if (!live || !t.inOffice) {
      if (r.activities.length || r.signals.some((s) => s.type === 'github')) {
        t.backlog.push(r);
        if (t.backlog.length > BACKLOG_MAX) t.backlog.splice(0, t.backlog.length - BACKLOG_MAX);
      }
      return;
    }
    this.toOffice(t, r, true);
  }

  /**
   * Fim de uma leitura: o turno que voltou a andar com o tracker ocioso e continua aberto sai do 'idle' (trabalhando, ou
   * esperando a resposta se houver pergunta aberta). A resposta final e o task_complete lidos juntos depois de um Stop
   * fecham o turno antes disso: o agente não volta por uma linha (nem entrega duas vezes).
   */
  private reviveIfOpen(t: ThreadTracker): void {
    const at = t.reviveAt;
    if (at === undefined) return;
    delete t.reviveAt;
    if (t.status !== 'idle' || t.state.turnOpen !== true) return;
    if (t.state.asking.size) this.decide(t, 'waiting', at, QUESTION_WAIT, true);
    else this.decide(t, 'working', at, undefined, true);
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
    if (t.status !== 'working' || this.presence.lockHeld(t)) return;
    const last = Math.max(t.lastWriteAt ?? 0, t.lastHookAt ?? 0, t.statusAt);
    if (now - last > WORKING_QUIET_MS) this.decide(t, 'idle', now, undefined, true);
  }

  private applySummary(t: ThreadTracker): void {
    if (!t.inOffice) return;
    const s = t.state;
    const summary: TranscriptSummary = { tasks: s.tasks, stats: { ...s.stats } };
    // Como no histórico: o nome dado à thread (/rename) vale mais que a 1ª instrução. Só o principal tem título no Office.
    const title = (t.kind === 'main' ? this.threadNames.nameOf(t.acc.dir, t.threadId) : undefined) ?? s.title;
    if (title) summary.title = title;
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
        const prefix = await scanPrefix(path, end, t.key, PREFIX_HISTORY, this.now());
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
      this.turnTo(t, false);
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
        // Quem chama (o destino do send_message): o thread raiz é o "/root"; o subagente, o caminho do session_meta dele.
        const { desc, tool } = describeCodexTool(toolName, toolInput, undefined, { agentPath: t === rootT ? '/root' : codexAgentPath(t.meta) });
        const id = str(input.tool_use_id);
        const act: Activity = { id: `${t.key}#${id ?? `hook${now.toString(36)}`}`, at: now, ...desc, tool };
        if (t.inOffice) office.addActivity(t.key, act, true);
        break;
      }
      case 'PermissionRequest': {
        const toolName = str(input.tool_name) ?? 'ferramenta';
        this.decide(t, 'waiting', now, codexApprovalReason(toolName, !!networkTarget(rec(input.tool_input) ?? {})), true);
        break;
      }
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
      t = newTracker(acc, threadId);
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
}
