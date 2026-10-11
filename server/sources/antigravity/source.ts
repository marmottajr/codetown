// Fonte de agentes do Antigravity CLI (AgentSource 'antigravity', ver sources/source.ts). Só por eventos: o hook do agy
// (mod/habblaud-antigravity/hook.mjs) manda cada evento para POST /api/antigravity/events e `applyHookEvent` leva ao
// Office. Não lê arquivo nenhum do agy (o formato das conversas dele não é documentado e traz o texto dos pedidos).
//
// Presença: a conversa entra no primeiro evento (sala = workspacePaths[0]) e sai depois de 30 min sem evento (o agy
// não tem hook de fim de sessão). Status: PreInvocation/PreToolUse/PostToolUse/PostInvocation = trabalhando (entre uma
// passada do modelo e a próxima vêm PostInvocation e logo PreInvocation: não é ocioso); Stop (com fullyIdle) = ocioso.
// Atividade: o nome da ferramenta + o texto curto que o hook mandou (nunca o resto dos args nem a saída).
import { readFileSync, statSync } from 'node:fs';
import type { AgentStatus, SourceInfo } from '../../../shared/types';
import type { AccountsService } from '../../accounts/service';
import { toEpochMs, usageFromAntigravity } from '../../accounts/usage';
import { errMsg, log } from '../../log';
import type { Office } from '../../model/office';
import type { AgentSource } from '../source';
import { describeAntigravityTool } from './activity';
import { AG_EVENTS, CONVERSATION_ID_RE, type AntigravityEvent, type AntigravityLive } from './live';

/** Conversa sem nenhum evento há mais que isto sai do escritório. */
export const PRESENCE_MS = 30 * 60_000;
const SWEEP_MS = 60_000;
/** De quanto em quanto tempo conferir o arquivo das cotas (AG-27: o número novo aparece em até 10 s). */
export const USAGE_POLL_MS = 5_000;
const ACCOUNT_ID = 'antigravity';
const ACCOUNT_COLOR = '#6c8cff';
const ROLE = 'Agente principal (Antigravity)';
const HEAD_MAX = 200;
const PATHS_MAX = 8;

export interface AntigravitySourceOptions {
  accounts: AccountsService;
  office: Office;
  now?: () => number;
  /** De quanto em quanto tempo varrer as conversas paradas (padrão 60 s). */
  sweepMs?: number;
  /** Arquivo das cotas gravado pelo statusline do agy (mod/habblaud-antigravity/statusline.mjs); sem ele, sem uso. */
  usageFile?: string;
  /** De quanto em quanto tempo conferir o arquivo das cotas (padrão 5 s). */
  usagePollMs?: number;
}

/** O arquivo das cotas tem ~300 bytes; maior que isto não é dele. */
const USAGE_MAX_BYTES = 16 * 1024;

interface Tracker {
  key: string;
  conversationId: string;
  inOffice: boolean;
  status: AgentStatus;
  lastEventAt: number;
  lastActivityId?: string;
}

/** Primeira letra de atalho livre (não repete as das outras contas). */
function freeShort(taken: readonly string[]): string {
  const used = new Set(taken.map((s) => s.toUpperCase()));
  return ['G', 'Y', 'A', 'N', 'T', 'R'].find((c) => !used.has(c)) ?? 'G';
}

export class AntigravitySource implements AgentSource, AntigravityLive {
  readonly provider = 'antigravity' as const;
  private trackers = new Map<string, Tracker>();
  private accountId = ACCOUNT_ID;
  private registered = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private usageTimer: ReturnType<typeof setInterval> | null = null;
  private usageMtime = 0;
  private stopped = false;
  private readonly now: () => number;

  constructor(private readonly opts: AntigravitySourceOptions) {
    this.now = opts.now ?? Date.now;
  }

  start(): void {
    this.timer = setInterval(() => this.sweep(), this.opts.sweepMs ?? SWEEP_MS);
    this.timer.unref?.();
    if (this.opts.usageFile) {
      this.readUsage();
      this.usageTimer = setInterval(() => this.readUsage(), this.opts.usagePollMs ?? USAGE_POLL_MS);
      this.usageTimer.unref?.();
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.usageTimer) clearInterval(this.usageTimer);
    this.timer = null;
    this.usageTimer = null;
  }

  sources(): SourceInfo[] {
    if (!this.registered) return [];
    let sessions = 0;
    for (const t of this.trackers.values()) if (t.inOffice) sessions++;
    return [{ label: this.accountId, provider: 'antigravity', path: '', sessions, ok: true }];
  }

  /** O agy não deixa uma conversa em arquivo de texto que a fonte leia: sem terminal nem histórico. */
  transcriptPathOf(_agentId: string): string | undefined {
    return undefined;
  }

  /** A conta só é registrada no primeiro evento: sem `agy` em uso, não aparece conta nenhuma. */
  private registerAccount(): void {
    if (this.registered) return;
    const claude = this.opts.accounts.entries();
    const entries = this.opts.accounts.setProviderAccounts('antigravity', [
      {
        dir: ACCOUNT_ID,
        detected: {
          id: ACCOUNT_ID,
          provider: 'antigravity',
          configDir: ACCOUNT_ID,
          short: freeShort(claude.map((e) => e.detected.short)),
          name: 'Antigravity',
          color: ACCOUNT_COLOR,
        },
      },
    ]);
    this.accountId = entries[0]?.id ?? ACCOUNT_ID;
    this.registered = true;
  }

  /**
   * Lê as cotas que o statusline do agy gravou ({fetchedAt, quota}) e as leva à conta do Antigravity (a conta aparece
   * assim que há números, mesmo sem nenhum evento de hook). Só relê se o arquivo mudou. Nunca lança: arquivo ausente,
   * grande demais ou sem cota válida não muda nada (se havia números, saem).
   */
  readUsage(): void {
    const file = this.opts.usageFile;
    if (!file || this.stopped) return;
    try {
      const st = statSync(file);
      if (st.mtimeMs === this.usageMtime || st.size > USAGE_MAX_BYTES) return;
      this.usageMtime = st.mtimeMs;
      const j = JSON.parse(readFileSync(file, 'utf8')) as { fetchedAt?: unknown; quota?: unknown };
      const fetchedAt = Math.min(this.now(), toEpochMs(j.fetchedAt) ?? Math.round(st.mtimeMs));
      const usage = usageFromAntigravity(j.quota, fetchedAt);
      if (!usage) {
        if (this.registered) this.opts.accounts.clearUsage(this.accountId, 'antigravity');
        return;
      }
      this.registerAccount();
      this.opts.accounts.setUsage(this.accountId, usage);
    } catch {
      // ausente ou ilegível: sem uso
    }
  }

  applyHookEvent(event: AntigravityEvent): boolean {
    try {
      return this.liveEvent(event);
    } catch (err) {
      log.warnOnce(`antigravity-hook:${errMsg(err)}`, `Antigravity: evento ignorado (${errMsg(err)}).`);
      return false;
    }
  }

  private liveEvent(event: AntigravityEvent): boolean {
    if (this.stopped || !event || !AG_EVENTS.includes(event.event) || !CONVERSATION_ID_RE.test(event.conversationId)) return false;
    const cwd = (Array.isArray(event.workspacePaths) ? event.workspacePaths : []).slice(0, PATHS_MAX).find((p) => typeof p === 'string' && p.trim())?.trim();
    const now = this.now();
    const key = `antigravity:${event.conversationId}`;
    let t = this.trackers.get(key);
    if (t?.inOffice && !this.opts.office.has(key)) t.inOffice = false; // saiu do escritório (período de graça encerrado)
    if (!t?.inOffice) {
      if (!cwd) return false; // sem sala não entra
      t ??= { key, conversationId: event.conversationId, inOffice: false, status: 'working', lastEventAt: now };
      this.trackers.set(key, t);
      this.enter(t, cwd, event.event === 'Stop' ? 'idle' : 'working', now);
      if (!t.inOffice) return false;
    }
    t.lastEventAt = now;

    switch (event.event) {
      case 'Stop':
        this.setStatus(t, event.fullyIdle === false ? 'working' : 'idle');
        return true;
      case 'PreToolUse': {
        this.setStatus(t, 'working');
        const name = typeof event.tool?.name === 'string' ? event.tool.name.trim() : '';
        if (!name) return true;
        const head = typeof event.tool?.head === 'string' ? event.tool.head.slice(0, HEAD_MAX) : undefined;
        const step = Number.isInteger(event.stepIdx) ? String(event.stepIdx) : name;
        const id = `${key}#${step}`;
        if (id !== t.lastActivityId) {
          t.lastActivityId = id;
          const { desc, tool } = describeAntigravityTool(name, head);
          this.opts.office.addActivity(key, { id, at: now, ...desc, tool }, true);
        }
        return true;
      }
      default:
        this.setStatus(t, 'working');
        return true;
    }
  }

  private enter(t: Tracker, cwd: string, status: AgentStatus, now: number): void {
    this.registerAccount();
    const office = this.opts.office;
    office.addMain({ id: t.key, provider: 'antigravity', account: this.accountId, sessionId: t.conversationId, cwd, role: ROLE, startedAt: now, status });
    t.inOffice = office.has(t.key);
    if (t.inOffice) {
      office.setStatus(t.key, status); // reaberta durante o período de graça
      t.status = status;
    }
  }

  private setStatus(t: Tracker, status: AgentStatus): void {
    if (t.status === status) return;
    this.opts.office.setStatus(t.key, status);
    t.status = status;
  }

  /** Tira do escritório as conversas sem evento há PRESENCE_MS. */
  private sweep(): void {
    const now = this.now();
    for (const [key, t] of [...this.trackers]) {
      if (now - t.lastEventAt < PRESENCE_MS) continue;
      if (t.inOffice) this.opts.office.closeMain(key);
      this.trackers.delete(key);
    }
  }
}
