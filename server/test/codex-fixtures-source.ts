// Construtores SINTÉTICOS para os testes da CodexSource: a sondagem de trava de mentira (o lock do fixture é um arquivo
// vazio que ninguém trava), um turno longo (para passar da janela de 1 MB) e a escrita de uma linha pela metade.
import { appendFileSync, existsSync } from 'node:fs';
import { basename } from 'node:path';
import type { LockProber, LockState } from '../sources/codex/locks';
import { R } from './codex-fixtures';

/**
 * Sondagem de mentira: lock que existe vale 'held' no modo 'win32' (trava segura por um processo vivo, como no
 * Windows e no Linux com /proc/locks) ou 'unknown' no modo 'exists' (macOS/Docker: só a existência), a não ser que o
 * teste mude o estado da thread com `set`. Lock que não existe = 'free', como nas sondagens de verdade.
 */
export function fakeLockProber(mode: 'win32' | 'exists' = 'win32') {
  const states = new Map<string, LockState>();
  const fallback: LockState = mode === 'exists' ? 'unknown' : 'held';
  const prober: LockProber = {
    mode,
    probe(lockPath: string): LockState {
      if (!existsSync(lockPath)) return 'free';
      return states.get(basename(lockPath, '.lock').toLowerCase()) ?? fallback;
    },
  };
  return {
    prober,
    /** Estado da trava da thread (undefined = volta ao padrão do modo). */
    set(thread: string, state: LockState | undefined): void {
      if (state) states.set(thread.toLowerCase(), state);
      else states.delete(thread.toLowerCase());
    },
  };
}

/**
 * Comandos de um turno que não acaba, com saída grande, até passar de `bytes`; um por `stepMs` a partir de `from`.
 * Cada linha tem uns 8 KB (saída sintética de 'x').
 */
export function bigTurn(t: string, turn: string, bytes: number, from: number, stepMs = 1_000): string[] {
  const output = 'x'.repeat(8 * 1024);
  const out: string[] = [];
  let size = 0;
  for (let i = 0; size < bytes; i++) {
    const line = R.command(t, turn, `call_big_${i}`, `echo parte ${i}`, { at: from + i * stepMs, output });
    out.push(line);
    size += Buffer.byteLength(line) + 1;
  }
  return out;
}

/** Acrescenta texto cru (sem `\n` no fim): uma linha que o Codex ainda está escrevendo. */
export function appendRaw(path: string, text: string): void {
  appendFileSync(path, text);
}
