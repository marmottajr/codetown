// Fonte de agentes do OpenCode (AgentSource 'opencode', ver sources/source.ts). Camada 1, sem instalar nada: lê o
// opencode.db (SQLite, somente leitura, ver files.ts) a cada segundo e alimenta o Office. O `fs.watch` em
// opencode.db-wal é só um empurrão para o ciclo rodar antes; a verdade vem do polling (como na CodexSource).
//
// Presença: a sessão aparece enquanto `time_updated` estiver nos últimos 30 min e `time_archived` for nulo; some no
// ciclo seguinte ao deixar de valer. `parent_id` de uma sessão mostrada faz dela subagente do pai. Status: a última
// mensagem do assistente sem `time.completed` = trabalhando; senão ocioso. Atividade: a última parte (`tool` pelo nome
// e `state.title`; nunca o conteúdo). Sala: `session.directory`, ou `project.worktree` se vier vazio.
import { watch, type FSWatcher } from 'node:fs';
import type { Activity, AgentStatus, SourceInfo, TaskItem } from '../../../shared/types';
import type { AccountsService } from '../../accounts/service';
import { errMsg, log } from '../../log';
import type { Office } from '../../model/office';
import type { AgentSource } from '../source';
import { describeOpencodePart } from './activity';
import { DB_FILE, inSnapshot, lastMessage, lastPart, listSessions, openDb, todos, type OcDb, type OcSession, type OpenOptions } from './files';

/** Sessão sem escrita há mais que isto (ou arquivada) sai do escritório. */
export const PRESENCE_MS = 30 * 60_000;
const ACCOUNT_ID = 'opencode';
const ACCOUNT_COLOR = '#35b7a5';
const MAIN_ROLE = 'Agente principal (OpenCode)';
const SUB_ROLE = 'Subagente (OpenCode)';
const MAX_DEPTH = 8;

export interface OpencodeSourceOptions {
  accounts: AccountsService;
  office: Office;
  /** Pasta de dados do OpenCode (onde fica o opencode.db). */
  dir: string;
  now?: () => number;
  pollMs?: number;
  /** Desliga o fs.watch (testes). */
  watch?: boolean;
  /** Troca do import de node:sqlite (testes). */
  importer?: OpenOptions['importer'];
  /** De quanto em quanto tempo conferir se o opencode.db já existe (padrão 5 s). */
  waitMs?: number;
}

interface Tracker {
  key: string;
  sessionId: string;
  kind: 'main' | 'sub';
  parentKey?: string;
  inOffice: boolean;
  /** Subagente que já entregou (ocioso). */
  subDone: boolean;
  status: AgentStatus;
  lastActivityId?: string;
}

const depthOf = (row: OcSession, byId: Map<string, OcSession>): number => {
  let depth = 0;
  for (let p = row.parentId; p && byId.has(p) && depth < MAX_DEPTH; p = byId.get(p)!.parentId) depth++;
  return depth;
};

/** Primeira letra de atalho livre (não repete as das outras contas). */
function freeShort(taken: readonly string[]): string {
  const used = new Set(taken.map((s) => s.toUpperCase()));
  return ['O', 'P', 'Q', 'U', 'V', 'W'].find((c) => !used.has(c)) ?? 'O';
}

export class OpencodeSource implements AgentSource {
  readonly provider = 'opencode' as const;
  private db: OcDb | undefined;
  private accountId = ACCOUNT_ID;
  private trackers = new Map<string, Tracker>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private kick: ReturnType<typeof setTimeout> | null = null;
  private watcher: FSWatcher | null = null;
  private waiter: ReturnType<typeof setInterval> | null = null;
  private attaching = false;
  private lastPollAt = 0;
  private stopped = false;
  private readonly now: () => number;

  constructor(private readonly opts: OpencodeSourceOptions) {
    this.now = opts.now ?? Date.now;
  }

  /**
   * Abre o banco e liga o acompanhamento. Sem opencode.db: não faz nada e não loga. Sem `node:sqlite` (Node < 22.13):
   * UMA linha no log e a fonte fica desligada; as outras seguem.
   */
  async start(): Promise<void> {
    await this.attach();
    if (!this.db && !this.stopped && !this.unsupported && !this.waiter) {
      this.waiter = setInterval(() => void this.attach(), this.opts.waitMs ?? 5_000);
      this.waiter.unref?.();
    }
  }

  private unsupported = false;

  private async attach(): Promise<void> {
    if (this.attaching || this.db || this.stopped) return;
    this.attaching = true;
    try {
      await this.open();
    } finally {
      this.attaching = false;
    }
  }

  private async open(): Promise<void> {
    const r = await openDb(this.opts.dir, {
      importer: this.opts.importer,
      onError: (e) => log.warnOnce(`opencode-read:${errMsg(e)}`, `OpenCode: falha ao ler o banco (${errMsg(e)}); tentando de novo no próximo ciclo.`),
    });
    if (r === 'missing') return;
    if (r === 'unsupported') {
      this.unsupported = true;
      this.clearWaiter();
      log.warn('OpenCode: o banco de sessões precisa do node:sqlite (Node 22.13 ou mais novo); a fonte do disco ficou desligada.');
      return;
    }
    if (this.stopped) {
      r.close();
      return;
    }
    this.clearWaiter();
    this.db = r;
    this.registerAccount();
    this.opts.office.beginBoot();
    try {
      this.poll();
    } finally {
      this.opts.office.endBoot();
    }
    this.timer = setInterval(() => this.safePoll(), this.opts.pollMs ?? 1_000);
    this.timer.unref?.();
    if (this.opts.watch ?? true) this.watchWal();
  }

  private clearWaiter(): void {
    if (this.waiter) clearInterval(this.waiter);
    this.waiter = null;
  }

  stop(): void {
    this.stopped = true;
    this.clearWaiter();
    if (this.timer) clearInterval(this.timer);
    if (this.kick) clearTimeout(this.kick);
    this.timer = null;
    this.kick = null;
    try {
      this.watcher?.close();
    } catch {
      // já fechado
    }
    this.watcher = null;
    this.db?.close();
    this.db = undefined;
  }

  sources(): SourceInfo[] {
    if (!this.db) return [];
    let sessions = 0;
    for (const t of this.trackers.values()) if (t.kind === 'main' && t.inOffice) sessions++;
    return [{ label: this.accountId, provider: 'opencode', path: this.opts.dir, sessions, ok: true }];
  }

  /** O OpenCode não guarda a conversa em arquivo de texto: sem terminal nem histórico nesta fonte. */
  transcriptPathOf(_agentId: string): string | undefined {
    return undefined;
  }

  private registerAccount(): void {
    const claude = this.opts.accounts.entries();
    const entries = this.opts.accounts.setProviderAccounts('opencode', [
      {
        dir: this.opts.dir,
        detected: {
          id: ACCOUNT_ID,
          provider: 'opencode',
          configDir: this.opts.dir,
          short: freeShort(claude.map((e) => e.detected.short)),
          name: 'OpenCode',
          color: ACCOUNT_COLOR,
        },
      },
    ]);
    this.accountId = entries[0]?.id ?? ACCOUNT_ID;
  }

  /** Observa a pasta de dados só para adiantar o ciclo quando o WAL muda (o resto dos arquivos é ignorado). */
  private watchWal(): void {
    try {
      this.watcher = watch(this.opts.dir, (_event, filename) => {
        if (typeof filename === 'string' && filename.startsWith(DB_FILE)) this.schedule();
      });
      this.watcher.on('error', () => {
        this.watcher?.close();
        this.watcher = null;
      });
      this.watcher.unref?.();
    } catch {
      this.watcher = null; // o polling basta
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

  private safePoll(): void {
    try {
      this.poll();
    } catch (err) {
      log.warnOnce(`opencode-poll:${errMsg(err)}`, `OpenCode: falha no ciclo de leitura: ${errMsg(err)}`);
    }
  }

  /** Um ciclo: relê as sessões presentes e leva ao Office o que mudou. */
  poll(): void {
    const db = this.db;
    if (!db) return;
    inSnapshot(db, () => this.pollOnce(db));
  }

  /** O corpo do ciclo, todo dentro de uma transação de leitura (instantâneo único do banco). */
  private pollOnce(db: OcDb): void {
    const now = (this.lastPollAt = this.now());
    const rows = listSessions(db, now - PRESENCE_MS);
    const byId = new Map(rows.map((r) => [r.id, r]));
    const ordered = rows.map((row) => ({ row, depth: depthOf(row, byId) })).sort((a, b) => a.depth - b.depth || a.row.id.localeCompare(b.row.id));
    const seen = new Set<string>();
    for (const { row } of ordered) {
      const key = `opencode:${row.id}`;
      try {
        if (this.sync(db, row, key, now)) seen.add(key);
      } catch (err) {
        log.warnOnce(`opencode-session:${key}:${errMsg(err)}`, `OpenCode: sessão ${row.id}: ${errMsg(err)}`);
        seen.add(key);
      }
    }
    for (const [key, t] of [...this.trackers]) {
      if (seen.has(key)) continue;
      this.leave(t);
      this.trackers.delete(key);
    }
  }

  /** Sincroniza uma sessão; false = sem sala (não entra). */
  private sync(db: OcDb, row: OcSession, key: string, now: number): boolean {
    const cwd = row.directory.trim() || row.worktree?.trim() || '';
    if (!cwd) return false;
    const office = this.opts.office;
    const msg = lastMessage(db, row.id, 'assistant');
    const diskStatus: AgentStatus = msg && msg.completed === undefined ? 'working' : 'idle';
    const status: AgentStatus = diskStatus;

    let t = this.trackers.get(key);
    if (t && t.inOffice && !office.has(key)) t.inOffice = false; // saiu do escritório (período de graça encerrado)
    if (!t) {
      const parentKey = row.parentId ? `opencode:${row.parentId}` : undefined;
      const parent = parentKey ? this.trackers.get(parentKey) : undefined;
      const isSub = !!parent && parent.inOffice;
      t = { key, sessionId: row.id, kind: isSub ? 'sub' : 'main', parentKey: isSub ? parentKey : undefined, inOffice: false, subDone: false, status };
      this.trackers.set(key, t);
    }

    if (!t.inOffice) this.enter(t, row, cwd, status, now);
    else if (status !== t.status) this.setStatus(t, status);
    t.status = status;
    if (!t.inOffice) return true;

    if (status === 'working') this.pushActivity(db, t, now);
    this.applySummary(db, t, row);
    return true;
  }

  private enter(t: Tracker, row: OcSession, cwd: string, status: AgentStatus, now: number): void {
    const office = this.opts.office;
    if (t.kind === 'main') {
      office.addMain({
        id: t.key,
        provider: 'opencode',
        account: this.accountId,
        sessionId: t.sessionId,
        cwd,
        role: MAIN_ROLE,
        startedAt: now,
        status,
      });
      t.inOffice = office.has(t.key);
      if (t.inOffice) office.setStatus(t.key, status); // reaberta durante o período de graça
      return;
    }
    const added = office.addSub({
      id: t.key,
      parentId: t.parentKey!,
      sessionId: t.sessionId,
      role: SUB_ROLE,
      title: row.title || undefined,
      background: false,
      startedAt: now,
    });
    if (!added) return;
    t.inOffice = true;
    t.subDone = false;
    // addSub começa em 'working': um subagente já ocioso entrega logo.
    if (status === 'idle') this.setStatus(t, status);
  }

  /** Leva o status ao escritório (o subagente entrega ao ficar ocioso e volta ao trabalhar). */
  private setStatus(t: Tracker, status: AgentStatus): void {
    const office = this.opts.office;
    if (t.kind === 'main') {
      office.setStatus(t.key, status);
      return;
    }
    if (status === 'idle') {
      if (!t.subDone) office.completeSub(t.key);
      t.subDone = true;
      return;
    }
    if (t.subDone) {
      office.reactivateSub(t.key);
      t.subDone = office.isSubDone(t.key);
    }
    if (!t.subDone) office.setStatus(t.key, status);
  }

  /** Atividade da última parte (ferramenta, raciocínio ou resposta), uma vez por parte nova. */
  private pushActivity(db: OcDb, t: Tracker, now: number): void {
    const office = this.opts.office;
    const part = lastPart(db, t.sessionId);
    if (part && (part.type === 'tool' || part.type === 'reasoning' || part.type === 'text')) {
      const id = `${t.key}#${part.created}:${part.type}:${part.tool ?? ''}`;
      if (id !== t.lastActivityId) {
        t.lastActivityId = id;
        const { desc, tool } = describeOpencodePart(part);
        const activity: Activity = { id, at: part.created || now, ...desc, ...(tool ? { tool } : {}) };
        office.addActivity(t.key, activity, true);
      }
    }
    office.fillWorkingActivity(t.key);
  }

  /** Título, tarefas e último sinal de vida do agente. */
  private applySummary(db: OcDb, t: Tracker, row: OcSession): void {
    const tasks: TaskItem[] = todos(db, t.sessionId).map((x, i) => ({
      id: String(i + 1),
      title: x.content,
      status: x.status === 'completed' ? 'completed' : x.status === 'in_progress' ? 'in_progress' : 'pending',
    }));
    this.opts.office.applyTranscript(t.key, {
      title: row.title || undefined,
      tasks,
      stats: { toolCalls: 0, tokensIn: 0, tokensOut: 0, subagents: 0 },
      lastAt: row.timeUpdated,
    });
  }

  /** Sai do escritório: principal encerra; subagente entrega (se ainda não tinha entregado). */
  private leave(t: Tracker): void {
    if (!t.inOffice) return;
    const office = this.opts.office;
    if (t.kind === 'sub') {
      if (!t.subDone) office.completeSub(t.key);
      t.subDone = true;
    } else office.closeMain(t.key);
    t.inOffice = false;
  }
}
