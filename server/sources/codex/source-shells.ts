// Comandos em segundo plano de cada árvore de threads do Codex (source.ts): o que cada linha do rollout começa ou
// termina (o detector é o shells.ts), a soltura sem 'ShellDone' (novo turno, thread fechado, SHELL_EXPIRE_MS depois do
// fim do turno) e a publicação no escritório. Os ShellTracker de cada árvore são da fonte, que os passa aqui.
import { shellsByOwner, ShellTracker, type ShellFinish } from '../shells';
import type { CodexLineResult } from './rollout';
import { scanShellLine } from './shells';
import type { CodexThreadTree } from './source-tree';
import type { CodexSourceOptions, ThreadTracker } from './source-types';

/**
 * Espera pelo shell depois do fim do turno: o Codex quase nunca grava o fim de um processo que sobreviveu ao turno
 * (e o fim não acorda o agente), então a espera vale por este tempo, contado do fim do turno do dono.
 */
export const SHELL_EXPIRE_MS = 30 * 60_000;

export class CodexShells {
  constructor(
    private readonly shellTrees: Map<string, ShellTracker>,
    private readonly threads: Map<string, ThreadTracker>,
    private readonly opts: Pick<CodexSourceOptions, 'office'>,
    private readonly now: () => number,
    private readonly tree: CodexThreadTree,
  ) {}

  /** Árvore dos processos de um thread: o principal dele (session_meta.session_id), senão o pai, senão ele mesmo. */
  treeKey(t: ThreadTracker): string {
    if (t.kind !== 'sub') return t.key;
    return this.tree.rootKey(t) ?? (t.parentThreadId ? `${t.acc.id}:${t.parentThreadId}` : t.key);
  }

  /**
   * Shells de uma linha do rollout (antes dos sinais dela: o fim do turno já encontra o processo). O task_started
   * encerra a espera pelos processos do próprio thread. Devolve os términos, ou undefined se nada mudou.
   */
  trackShells(t: ThreadTracker, line: string, r: CodexLineResult): ShellFinish[] | undefined {
    if (t.kind === 'internal') return undefined;
    const root = this.treeKey(t);
    const dropped = r.signals.some((s) => s.type === 'turnStart') && this.dropShells(t.key, root, r.at);
    const events = scanShellLine(t.shellScan, line, { historyStart: t.state.meta?.historyStart });
    if (!events.length) return dropped ? [] : undefined;
    let tree = this.shellTrees.get(root);
    if (!tree) this.shellTrees.set(root, (tree = new ShellTracker()));
    const fins: ShellFinish[] = [];
    // Pelo call_id do início (único), nunca pela sessão ("proc:7" se repete entre threads e volta depois que o processo
    // morre): um id de tarefa já encerrado faria o ShellTracker descartar o processo novo.
    for (const ev of events) {
      if (ev.type === 'start') {
        tree.start(t.key, { toolUseId: ev.callId, label: ev.label, ...(ev.command ? { command: ev.command } : {}), background: true, kind: 'shell', at: r.at });
        tree.result(ev.callId, { error: false, at: r.at });
        continue;
      }
      const fin = tree.notify({ toolUseId: ev.callId, status: ev.status, summary: ev.summary, at: r.at });
      if (fin) fins.push(fin);
    }
    return fins;
  }

  /** Tira, sem ShellDone, os processos de um dono (novo turno ou thread fechado). */
  dropShells(owner: string, root: string, at: number): boolean {
    const tree = this.shellTrees.get(root);
    if (!tree) return false;
    let changed = false;
    for (const job of tree.list()) {
      if (job.owner !== owner) continue;
      tree.stop(job.taskId ?? job.toolUseId, at);
      changed = true;
    }
    return changed;
  }

  /** Tira, sem ShellDone, os processos cujo dono terminou o turno há mais de SHELL_EXPIRE_MS. */
  expireShells(tree: ShellTracker, now: number): void {
    for (const job of tree.list()) {
      const owner = this.threads.get(job.owner);
      if (owner && owner.status !== 'idle') continue; // turno aberto: o processo pode acabar a qualquer momento
      if (now - Math.max(job.startedAt, owner?.statusAt ?? 0) > SHELL_EXPIRE_MS) tree.stop(job.taskId ?? job.toolUseId, now);
    }
  }

  /**
   * Publica os shells de uma árvore: cada subagente ativo mostra os dele; os de quem entregou ou saiu continuam rodando
   * e passam ao principal. Devolve se o principal tem algum.
   */
  publishShells(root: string): boolean {
    const tree = this.shellTrees.get(root);
    if (!tree) return false;
    this.expireShells(tree, this.now());
    const office = this.opts.office;
    const byOwner = shellsByOwner(office, root, tree.list());
    office.setShells(root, byOwner.get(root) ?? []);
    for (const t of this.threads.values()) if (t.kind === 'sub' && t.inOffice && this.treeKey(t) === root) office.setShells(t.key, byOwner.get(t.key) ?? []);
    return byOwner.has(root);
  }
}
