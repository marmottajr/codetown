// fs.watch da fonte do Codex (source.ts): a pasta dos locks e o rollout de cada thread só aceleram o próximo ciclo de
// leitura (o `schedule` da fonte). Desligado (testes) ou sem suporte, o polling cobre.
import { watch, type FSWatcher } from 'node:fs';
import type { ThreadTracker } from './source-types';

export class CodexWatchers {
  constructor(private readonly useWatch: boolean, private readonly dirWatchers: Map<string, FSWatcher>, private readonly schedule: () => void) {}

  // ---------------------------------------------------------------- fs.watch (acelerador)

  watchDir(dir: string): void {
    if (!this.useWatch || this.dirWatchers.has(dir)) return;
    try {
      const w = watch(dir, { persistent: false }, () => this.schedule());
      w.on('error', () => {
        w.close();
        this.dirWatchers.delete(dir);
      });
      this.dirWatchers.set(dir, w);
    } catch {
      // sem suporte: o polling cobre
    }
  }

  watchFile(t: ThreadTracker, path: string): void {
    if (!this.useWatch) return;
    this.unwatch(t);
    try {
      const w = watch(path, { persistent: false }, () => this.schedule());
      w.on('error', () => w.close());
      t.watcher = w;
    } catch {
      // sem suporte: o polling cobre
    }
  }

  unwatch(t: ThreadTracker): void {
    t.watcher?.close();
    delete t.watcher;
  }
}
