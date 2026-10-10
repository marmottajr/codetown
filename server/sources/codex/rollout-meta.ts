// Metadados que o rollout do Codex traz fora da conversa: o session_meta (1ª linha: formato, cwd, versão, branch,
// subagente e thread pai) e o uso do plano (`rate_limits` do token_count, em janelas por duração).
import { truncate } from '../../../shared/activity';
import type { AccountUsage, UsageWindowInfo } from '../../../shared/types';
import { num, rec, str, toMs, type Rec } from './rollout-util';

/** Id de thread do Codex (UUID). */
const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isThreadId(v: unknown): v is string {
  return typeof v === 'string' && THREAD_ID.test(v);
}

// ------------------------------------------------------------------ session_meta

export type HistoryMode = 'paginated' | 'legacy';

/** O que o session_meta (1ª linha do rollout) diz sobre o thread. */
export interface RolloutMeta {
  threadId?: string;
  /** Thread raiz da sessão (num subagente, o do agente principal). */
  sessionId?: string;
  cwd?: string;
  cliVersion?: string;
  historyMode: HistoryMode;
  gitBranch?: string;
  startedAt?: number;
  /** Thread interno do Codex (guardian, review, compactação, memória...): fica fora do escritório. */
  internal: boolean;
  /** Subagente (spawn_agent): o thread pai e o que se sabe dele. */
  parentThreadId?: string;
  agentNickname?: string;
  agentRole?: string;
  /** Caminho do subagente no multiagente v2 ("/root/tarefa_filho/tarefa_neto"), quando o thread_spawn o traz. */
  agentPath?: string;
  /** subagent_history_start_ordinal: as linhas com ordinal menor são a história herdada do pai (fork). */
  historyStart?: number;
}

/** Chaves de um objeto em minúsculas e sem `_` (o Codex já gravou `subagent`, `subAgent`, `thread_spawn`...). */
function looseGet(o: Rec, name: string): unknown {
  const want = name.toLowerCase().replace(/_/g, '');
  for (const [k, v] of Object.entries(o)) if (k.toLowerCase().replace(/_/g, '') === want) return v;
  return undefined;
}

/**
 * `source` do session_meta: "cli", "vscode", "exec", "mcp", {"custom": ...}, {"internal": "guardian"},
 * {"subagent": "review" | "compact" | "memory_consolidation" | {"other": ...} | {"thread_spawn": {...}}}.
 */
function sourceInfo(src: unknown): { internal: boolean; spawn?: Rec } {
  const o = rec(src);
  if (!o) return { internal: false };
  if (looseGet(o, 'internal') !== undefined) return { internal: true };
  const sub = looseGet(o, 'subagent');
  if (sub === undefined) return { internal: false };
  const so = rec(sub);
  const spawn = so ? rec(looseGet(so, 'thread_spawn')) : undefined;
  // review, compact, memory_consolidation e {"other": "guardian"}: internos, sem pai conhecido.
  return spawn ? { internal: false, spawn } : { internal: true };
}

const INTERNAL_THREAD_SOURCES = new Set(['guardian_review', 'memory_consolidation']);

/** Caminho absoluto de agente do multiagente v2: "/root" e nomes em minúsculas, dígitos e `_`. */
const AGENT_PATH = /^\/root(?:\/[a-z0-9_]+)*$/;

/** Caminho do próprio agente: o principal é o "/root"; o subagente, o do thread_spawn (se veio). */
export function codexAgentPath(meta: RolloutMeta | undefined): string | undefined {
  if (!meta || meta.internal) return undefined;
  return meta.parentThreadId ? meta.agentPath : '/root';
}

export function parseSessionMeta(payload: Rec, at?: number): RolloutMeta {
  const src = sourceInfo(payload.source);
  const meta: RolloutMeta = {
    historyMode: payload.history_mode === 'paginated' ? 'paginated' : 'legacy',
    internal: src.internal || INTERNAL_THREAD_SOURCES.has(String(payload.thread_source ?? '')),
  };
  const id = str(payload.id);
  const sessionId = str(payload.session_id);
  if (id) meta.threadId = id;
  if (sessionId) meta.sessionId = sessionId;
  const cwd = str(payload.cwd);
  if (cwd) meta.cwd = cwd;
  const version = str(payload.cli_version);
  if (version) meta.cliVersion = version;
  const branch = str(rec(payload.git)?.branch);
  if (branch && branch !== 'HEAD') meta.gitBranch = branch;
  const started = toMs(payload.timestamp) ?? at;
  if (started !== undefined) meta.startedAt = started;
  const parent =
    str(src.spawn ? looseGet(src.spawn, 'parent_thread_id') : undefined) ??
    str(payload.parent_thread_id) ??
    (sessionId && id && sessionId !== id && !meta.internal ? sessionId : undefined);
  if (parent && isThreadId(parent) && parent !== id) meta.parentThreadId = parent;
  const nickname = str(src.spawn ? looseGet(src.spawn, 'agent_nickname') : undefined) ?? str(payload.agent_nickname);
  const role = str(src.spawn ? (looseGet(src.spawn, 'agent_role') ?? looseGet(src.spawn, 'agent_type')) : undefined) ?? str(payload.agent_role);
  if (nickname) meta.agentNickname = truncate(nickname, 40);
  if (role) meta.agentRole = truncate(role, 40);
  const agentPath = str(src.spawn ? looseGet(src.spawn, 'agent_path') : undefined);
  if (agentPath && AGENT_PATH.test(agentPath)) meta.agentPath = agentPath;
  const historyStart = num(payload.subagent_history_start_ordinal);
  if (historyStart !== undefined && historyStart >= 0) meta.historyStart = historyStart;
  return meta;
}

// ------------------------------------------------------------------ uso do plano

/** Janelas do Codex pela duração (não pela posição): 300 min = sessão de 5 h, 10080 min = semana. */
const WINDOW_BY_MINUTES: Record<number, 'fiveHour' | 'sevenDay'> = { 300: 'fiveHour', 10080: 'sevenDay' };

/**
 * Uma janela do `rate_limits` ({used_percent, window_minutes, ...}), de qualquer duração. Reinício: `resets_at` (epoch
 * em segundos, Codex ≥ 0.50) ou `resets_in_seconds` (0.45/0.46, contado do horário da linha). Sem duração ou sem
 * percentual = undefined.
 */
function usageWindow(raw: unknown, at: number): UsageWindowInfo | undefined {
  const w = rec(raw);
  const minutes = num(w?.window_minutes);
  const used = num(w?.used_percent);
  if (!w || minutes === undefined || minutes <= 0 || used === undefined) return undefined;
  const info: UsageWindowInfo = { windowMinutes: minutes, usedPercent: Math.min(100, Math.max(0, used)) };
  const resets = num(w.resets_at);
  const resetsIn = num(w.resets_in_seconds);
  if (resets !== undefined) info.resetsAt = resets < 1e12 ? Math.round(resets * 1000) : Math.round(resets);
  else if (resetsIn !== undefined) info.resetsAt = at + Math.round(resetsIn * 1000);
  return info;
}

/**
 * `token_count.rate_limits` → uso da conta (source 'codex', `fetchedAt` = horário da linha). `windows` = os medidores
 * que o plano tem, na ordem primary, secondary (uma janela por duração: a primeira vence); `fiveHour`/`sevenDay`
 * continuam preenchidos pela duração (300/10080), para quem lê os campos fixos. Aceita também o formato plano do
 * 0.40 (`primary_used_percent`, `primary_window_minutes`, ...). `primary` nulo com `rate_limit_reached_type` = sem
 * cota nem créditos (`noQuota`), não 0%. Sem nenhuma janela e com cota = undefined.
 */
export function usageFromRateLimits(raw: unknown, at: number): AccountUsage | undefined {
  const rl = rec(raw);
  if (!rl) return undefined;
  // Só a cota padrão ("codex"); modelos com cota própria (outro limit_id) fariam o número pular entre as duas.
  const limit = str(rl.limit_id);
  if (limit && limit !== 'codex') return undefined;
  const usage: AccountUsage = { source: 'codex', fetchedAt: at };
  const windows: UsageWindowInfo[] = [];
  for (const slot of ['primary', 'secondary'] as const) {
    const w = usageWindow(rl[slot], at) ?? usageWindow({ used_percent: rl[`${slot}_used_percent`], window_minutes: rl[`${slot}_window_minutes`] }, at);
    if (!w || windows.some((x) => x.windowMinutes === w.windowMinutes)) continue;
    windows.push(w);
    const key = WINDOW_BY_MINUTES[w.windowMinutes];
    if (key) usage[key] = w.resetsAt === undefined ? { utilization: w.usedPercent } : { utilization: w.usedPercent, resetsAt: w.resetsAt };
  }
  if (windows.length) usage.windows = windows;
  if ((rl.primary === null || rl.primary === undefined) && str(rl.rate_limit_reached_type)) usage.noQuota = true;
  return windows.length || usage.noQuota ? usage : undefined;
}
