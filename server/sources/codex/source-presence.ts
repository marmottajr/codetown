// Presença dos threads do Codex (source.ts): quem está presente a cada ciclo (trava sondada, escrita recente no rollout
// ou evento de hook) e se o thread deve estar no escritório agora. As travas são só sondadas (locks.ts), nunca
// adquiridas; os prazos de graça e de crash ficam aqui com a regra que os usa.
import { sep } from 'node:path';
import { readLocks, LOCKS_DIR, type LockInfo } from './files';
import type { LockProber } from './locks';
import type { CodexThreadTree } from './source-tree';
import type { CodexAccount, ThreadTracker } from './source-types';
import type { CodexWatchers } from './source-watch';

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

export class CodexPresence {
  constructor(
    private readonly threads: Map<string, ThreadTracker>,
    private readonly prober: LockProber,
    private readonly watchers: CodexWatchers,
    private readonly tree: CodexThreadTree,
  ) {}

  /**
   * Threads presentes de uma conta e por quê: 'lock' (lock com idade suficiente que a sondagem não deu como órfão),
   * 'recent' (sem pasta de locks: candidato pelo mtime ou com escrita recente; quem decide é `wanted`) ou 'hook'
   * (evento de hook recente).
   */
  presentThreads(acc: CodexAccount, now: number): Map<string, 'lock' | 'recent' | 'hook'> {
    const out = new Map<string, 'lock' | 'recent' | 'hook'>();
    acc.locks = readLocks(acc.dir, this.prober);
    if (acc.locks) {
      this.watchers.watchDir(`${acc.dir}${sep}${LOCKS_DIR}`);
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

  wanted(t: ThreadTracker, now: number, via?: 'lock' | 'recent' | 'hook'): boolean {
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
    if (t.kind === 'main' && !this.tree.cwdOf(t)) return false;
    if (t.kind === 'sub') {
      const parent = this.tree.parentKey(t);
      if (!parent || !this.tree.activeInOffice(parent)) return false;
      // Subagente só aparece trabalhando (ou recém-criado pelo hook); depois de entregar, sai.
      if (!t.inOffice && t.status !== 'working' && t.status !== 'waiting' && !t.hookSpawned) return false;
    }
    return true;
  }

  /** Lock do thread que ainda conta: a órfã ('free', ninguém segura a trava) vale como sumida. */
  lockOf(t: ThreadTracker): LockInfo | undefined {
    const lock = t.acc.locks?.get(t.threadId);
    return lock && lock.state !== 'free' ? lock : undefined;
  }

  /** A trava do thread está segura por um processo vivo do Codex (a sondagem viu). */
  lockHeld(t: ThreadTracker): boolean {
    return t.acc.locks?.get(t.threadId)?.state === 'held';
  }
}
