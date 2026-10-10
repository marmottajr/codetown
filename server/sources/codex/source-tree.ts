// Ligações entre os threads do Codex (source.ts): o pai de cada subagente no escritório (o direto ou o principal da
// árvore), a profundidade e o projeto de cada thread. Sem estado próprio: lê os threads e o escritório da fonte.
import type { CodexSourceOptions, ThreadTracker } from './source-types';

export class CodexThreadTree {
  constructor(private readonly threads: Map<string, ThreadTracker>, private readonly opts: Pick<CodexSourceOptions, 'office'>) {}

  /**
   * Pai do subagente no escritório: o pai direto enquanto ele está lá e não entregou, ou enquanto ele ainda pode entrar
   * (o sub espera por ele); senão (neto cujo pai já concluiu ou saiu) o principal da árvore, se estiver lá. Sem nenhum
   * dos dois, o pai direto (o sub espera).
   */
  parentKey(t: ThreadTracker): string | undefined {
    if (!t.parentThreadId) return undefined;
    const direct = `${t.acc.id}:${t.parentThreadId}`;
    if (this.activeInOffice(direct) || !this.parentDone(direct)) return direct;
    const root = this.rootKey(t);
    return root && root !== direct && this.opts.office.has(root) ? root : direct;
  }

  /**
   * O pai direto já entregou ou saiu: sem tracker (fechou), entregue ou encerrado no escritório, ou lido e ocioso fora
   * dele (concluiu antes de entrar). Um pai presente que ainda pode entrar (trabalhando, ou com o rollout ainda não lido)
   * não conta como concluído.
   */
  parentDone(key: string): boolean {
    const p = this.threads.get(key);
    if (!p) return true;
    if (this.opts.office.has(key)) return this.opts.office.isSubDone(key);
    return p.subDone || (p.meta !== undefined && p.status === 'idle');
  }

  /** Ancestrais do subagente entre os threads conhecidos (1 = filho do principal, 2 = neto); o pai vem antes do neto. */
  depthOf(t: ThreadTracker): number {
    let depth = 0;
    for (let p: ThreadTracker | undefined = t; p?.parentThreadId && depth < 8; depth++) p = this.threads.get(`${p.acc.id}:${p.parentThreadId}`);
    return depth;
  }

  /** Principal da árvore: session_meta.session_id (o thread raiz), do próprio sub ou do pai dele. */
  rootKey(t: ThreadTracker): string | undefined {
    const parent = t.parentThreadId ? this.threads.get(`${t.acc.id}:${t.parentThreadId}`) : undefined;
    const root = t.meta?.sessionId ?? parent?.meta?.sessionId;
    return root ? `${t.acc.id}:${root.toLowerCase()}` : undefined;
  }

  /** No escritório e ainda ativo (nem concluído, nem encerrado). */
  activeInOffice(key: string): boolean {
    return this.opts.office.has(key) && !this.opts.office.isSubDone(key);
  }

  /** Projeto conhecido do thread (session_meta ou hook). */
  cwdOf(t: ThreadTracker): string | undefined {
    return t.meta?.cwd ?? t.hookCwd;
  }
}
