// Terminais interativos sobrevivem a um reinício do servidor (rebuild, atualização): a lista do que está aberto
// (sessão, pasta e conta) fica gravada em <dataDir>/ptys.json, atualizada a cada poucos segundos — então até uma
// queda brusca é recuperável — e, ao subir, o servidor retoma cada sessão com `claude --resume` (PtyManager.restore).
// No desligamento a gravação para antes de os terminais serem encerrados, para a lista não ficar vazia.
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { errMsg, log } from '../log';
import type { PtyManager, PtyRestoreEntry } from './manager';

const SAVE_MS = 3000;

export class PtyRestore {
  private timer: ReturnType<typeof setInterval> | null = null;
  private last = '';

  constructor(
    private readonly file: string,
    private readonly ptys: PtyManager,
  ) {}

  /** Retoma o que estava aberto e passa a gravar a lista. */
  async start(resume: boolean): Promise<void> {
    const entries = resume ? this.read() : [];
    if (entries.length) {
      log.info(`Retomando ${entries.length} terminal(is) interativo(s) da execução anterior…`);
      const n = await this.ptys.restore(entries);
      log.info(`   ${n} de ${entries.length} retomado(s).`);
    }
    this.save();
    this.timer = setInterval(() => this.save(), SAVE_MS);
    this.timer.unref?.();
  }

  /** Para de gravar (chamar ANTES de encerrar os terminais no desligamento). */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private read(): PtyRestoreEntry[] {
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as { ptys?: unknown };
      return Array.isArray(raw.ptys)
        ? raw.ptys.filter((e): e is PtyRestoreEntry => !!e && typeof e.sessionId === 'string' && typeof e.cwd === 'string' && typeof e.account === 'string')
        : [];
    } catch {
      return [];
    }
  }

  private save(): void {
    const data = JSON.stringify({ savedAt: Date.now(), ptys: this.ptys.restorable() }, null, 2);
    const sig = data.replace(/"savedAt": \d+/, '');
    if (sig === this.last) return;
    try {
      writeFileSync(`${this.file}.tmp`, data);
      renameSync(`${this.file}.tmp`, this.file);
      this.last = sig;
    } catch (err) {
      log.warnOnce(`ptys.json:${errMsg(err)}`, `Não consegui gravar a lista de terminais (${this.file}): ${errMsg(err)}`);
    }
  }
}
