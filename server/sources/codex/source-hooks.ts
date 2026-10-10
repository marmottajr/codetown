// Eventos dos hooks do Codex na fonte (source.ts; chegam pelo applyHookEvent dela, dentro do try/catch dele): a conta e
// o thread de cada evento, a presença que o hook dá ao thread e as bordas de status que ele adianta aos arquivos. As
// bordas (decide, reconcile, turnTo), a leitura do rollout (pump) e o próximo ciclo (schedule) são da fonte.
import { realpathSync } from 'node:fs';
import { basename, resolve, sep } from 'node:path';
import { codexApprovalReason } from '../../../shared/activity';
import type { Activity, AgentStatus } from '../../../shared/types';
import { networkTarget } from '../../permissions/codex';
import { parseRolloutName } from './files';
import { codexAgentPath, describeCodexTool, isThreadId } from './rollout';
import { newTracker, type CodexAccount, type CodexSourceOptions, type ThreadTracker } from './source-types';

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

/** O que os hooks usam da fonte do Codex: as contas (lidas na hora da chamada), os threads e a máquina de estados. */
export interface HookHost {
  readonly opts: Pick<CodexSourceOptions, 'office'>;
  readonly threads: Map<string, ThreadTracker>;
  now(): number;
  accs(): CodexAccount[];
  schedule(): void;
  pump(t: ThreadTracker, boot: boolean): void;
  turnTo(t: ThreadTracker, open: boolean): void;
  reconcile(t: ThreadTracker, now: number, via?: 'lock' | 'recent' | 'hook'): void;
  decide(t: ThreadTracker, status: AgentStatus, at: number, waitingFor: string | undefined, live: boolean): void;
}

export class CodexHooks {
  constructor(private readonly src: HookHost) {}

  hookEvent(account: string | undefined, input: Record<string, unknown>): boolean {
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
    const now = this.src.now();
    const cwd = str(input.cwd);
    const office = this.src.opts.office;

    if (event === 'SessionEnd') {
      const t = this.src.threads.get(`${acc.id}:${root}`);
      if (!t) return false;
      t.endedAt = now;
      delete t.lastHookAt;
      this.src.turnTo(t, false);
      this.src.reconcile(t, now);
      this.src.schedule();
      return true;
    }

    // Subagente: o thread filho vem em agent_id (o pai, até sabermos pelo session_meta, é a raiz).
    const isSubEvent = target !== root || event === 'SubagentStart' || event === 'SubagentStop';
    const subId = event === 'SubagentStart' || event === 'SubagentStop' ? (agent && isThreadId(agent) ? agent : undefined) : target !== root ? target : undefined;
    if (isSubEvent && !subId) return false;
    const rootT = this.touch(acc, root, now, cwd);
    const t = subId ? this.touch(acc, subId, now, cwd, root, agentType) : rootT;
    this.hintTranscript(acc, subId ?? root, event === 'SubagentStop' ? str(input.agent_transcript_path) : subId ? undefined : str(input.transcript_path));
    this.src.reconcile(rootT, now, 'hook');

    switch (event) {
      case 'SubagentStart':
        t.hookSpawned = true;
        this.src.decide(t, 'working', now, undefined, true);
        break;
      case 'SubagentStop':
        this.src.decide(t, 'idle', now, undefined, true);
        break;
      case 'UserPromptSubmit':
      case 'PostToolUse':
      case 'PreCompact':
      case 'PostCompact':
        this.src.decide(t, 'working', now, undefined, true);
        break;
      case 'PreToolUse': {
        this.src.decide(t, 'working', now, undefined, true);
        if (t !== rootT) this.src.reconcile(t, now, 'hook');
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
        this.src.decide(t, 'waiting', now, codexApprovalReason(toolName, !!networkTarget(rec(input.tool_input) ?? {})), true);
        break;
      }
      case 'Stop':
      case 'Interrupt':
        this.src.decide(t, 'idle', now, undefined, true);
        break;
      default:
        break;
    }
    if (t !== rootT) this.src.reconcile(t, now, 'hook');
    return true;
  }

  /** Tracker do thread (criado se preciso), com a presença dada pelo hook. */
  touch(acc: CodexAccount, threadId: string, now: number, cwd: string | undefined, parent?: string, agentType?: string): ThreadTracker {
    const key = `${acc.id}:${threadId}`;
    let t = this.src.threads.get(key);
    if (!t) {
      t = newTracker(acc, threadId);
      this.src.threads.set(key, t);
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
    if (t.inOffice && !this.src.opts.office.has(t.key)) t.inOffice = false;
    this.src.pump(t, false);
    return t;
  }

  /** `transcript_path` do hook, se for um rollout dentro da pasta da conta (no Docker é do host: não serve). */
  hintTranscript(acc: CodexAccount, threadId: string, path: string | undefined): void {
    if (!path) return;
    const t = this.src.threads.get(`${acc.id}:${threadId}`);
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
  accountFor(account: string | undefined, input: Record<string, unknown>, threadId: string): CodexAccount | undefined {
    const norm = (p: string) => {
      try {
        return resolve(p);
      } catch {
        return p;
      }
    };
    if (account) {
      const byId = this.src.accs().find((a) => a.id === account);
      if (byId) return byId;
      const abs = norm(account);
      const byDir = this.src.accs().find((a) => norm(a.dir) === abs || norm(a.configDir) === abs);
      if (byDir) return byDir;
    }
    for (const raw of [str(input.transcript_path), str(input.agent_transcript_path)]) {
      if (!raw) continue;
      const p = norm(raw);
      const byPath = this.src.accs().find((a) => p.startsWith(norm(a.dir) + sep) || p.startsWith(norm(a.configDir) + sep));
      if (byPath) return byPath;
    }
    const known = this.src.accs().filter((a) => this.src.threads.has(`${a.id}:${threadId}`));
    if (known.length === 1) return known[0];
    if (account) {
      const byName = this.src.accs().find((a) => basename(a.dir) === basename(account) || basename(a.configDir) === basename(account));
      if (byName) return byName;
    }
    return this.src.accs().length === 1 ? this.src.accs()[0] : undefined;
  }
}
