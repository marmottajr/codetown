// Tipos da fonte do Codex (source.ts e os módulos source-* ao lado dela): as opções, a conta, o tracker de cada thread
// e o tracker novo de um thread que acabou de aparecer.
import type { FSWatcher } from 'node:fs';
import type { AccountUsage, AgentStatus } from '../../../shared/types';
import type { AccountsService } from '../../accounts/service';
import type { Office } from '../../model/office';
import type { FileTail } from '../tail';
import type { LockInfo, RolloutIndex } from './files';
import type { LockProber } from './locks';
import { createCodexState, type CodexLineResult, type CodexState, type RolloutMeta } from './rollout';
import { createShellScan, type CodexShellScan } from './shells';

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
  /**
   * O turno de uma thread (principal, subagente ou interna) abriu ou fechou, para o canal paralelo soltar a thread de um
   * TUI fechado. `account` = o id da conta (o prefixo do id do agente, `<conta>:<threadId>`); `threadId` como o Codex o
   * grava (o `id` do session_meta). Ao abrir o rollout (e no thread ainda sem rollout) sai o estado do turno uma vez;
   * depois só as mudanças: task_started, task_complete/turn_aborted ao vivo, SessionEnd do hook, a saída do escritório e
   * o fim do thread. O mesmo valor seguido não sai de novo.
   */
  onTurn?: (account: string, threadId: string, open: boolean) => void;
}

export interface CodexAccount {
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
  /** Última leitura do uso pelos rollouts (boot ou releitura de USAGE_RESCAN_MS). */
  usageScanAt: number;
  usage?: AccountUsage;
  plan?: string;
  error?: string;
}

export interface ThreadTracker {
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
  /** Chamadas de shell (exec_command, write_stdin, exec, wait) ainda sem saída, para achar os processos em segundo plano. */
  shellScan: CodexShellScan;
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
  /** Último estado do turno avisado ao onTurn por este tracker (undefined = nada ainda). */
  turnSent?: boolean;
  /** Horário da última linha ao vivo que andou com o tracker ocioso e o turno aberto, na leitura em curso. */
  reviveAt?: number;
  watcher?: FSWatcher;
}

export function newTracker(acc: CodexAccount, threadId: string): ThreadTracker {
  return {
    key: `${acc.id}:${threadId}`,
    acc,
    threadId,
    kind: 'main',
    nextResolveAt: 0,
    state: createCodexState(),
    shellScan: createShellScan(),
    backlog: [],
    inOffice: false,
    status: 'idle',
    statusAt: 0,
    subDone: false,
  };
}
