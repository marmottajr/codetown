// Sessões abertas do Codex: <CODEX_HOME>/thread-writer-locks/<threadId>.lock fica travado enquanto um processo do
// Codex tem a thread carregada. A trava é só SONDADA, nunca adquirida: se o Habblaud a segurasse no instante em que o
// Codex tenta retomar a thread, o Codex falharia ("already has an active writer"). Por isso aqui só há open 'r' +
// leitura de 1 byte, stat e a leitura do /proc/locks.
import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs';

/** held = alguém segura a trava (sessão viva); free = existe e ninguém segura (órfã); unknown = não dá para saber (vale a regra de existência + 12 h). */
export type LockState = 'held' | 'free' | 'unknown';
export interface LockProber {
  /** 'win32' (EBUSY), 'proc' (/proc/locks), 'exists' (só existência). */
  readonly mode: 'win32' | 'proc' | 'exists';
  probe(lockPath: string): LockState;
}

const PROC_LOCKS = '/proc/locks';

/** O mínimo de node:fs que a sondagem do Windows usa (injetável nos testes). Só abre com 'r'. */
export interface ProbeFs {
  openSync(path: string, flags: 'r'): number;
  readSync(fd: number, buffer: Buffer, offset: number, length: number, position: number): number;
  closeSync(fd: number): void;
}
const NODE_FS: ProbeFs = { openSync, readSync, closeSync };

const codeOf = (err: unknown): string | undefined => (err as NodeJS.ErrnoException | undefined)?.code;

/** Arquivo que não existe: ninguém segura a trava (o consumidor trata como lock sumido). */
const isMissing = (err: unknown) => codeOf(err) === 'ENOENT';

/**
 * Windows: o Codex trava o arquivo inteiro (LockFileEx exclusivo), então ler 1 byte falha com EBUSY
 * (ERROR_LOCK_VIOLATION) enquanto a thread está carregada. Leitura que passa (0 byte: o arquivo é vazio) = free;
 * ENOENT = free; EBUSY (na abertura ou na leitura) = held; outro erro = unknown. O handle é sempre fechado.
 */
export function probeWin32(lockPath: string, fs: ProbeFs = NODE_FS): LockState {
  const fromError = (err: unknown): LockState => (codeOf(err) === 'EBUSY' ? 'held' : isMissing(err) ? 'free' : 'unknown');
  let fd: number;
  try {
    fd = fs.openSync(lockPath, 'r');
  } catch (err) {
    return fromError(err);
  }
  try {
    fs.readSync(fd, Buffer.alloc(1), 0, 1, 0);
    return 'free';
  } catch (err) {
    return fromError(err);
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // o handle já não vale: nada a liberar
    }
  }
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

/** st_dev (codificação do glibc, a que o Node devolve) → major/minor, como o kernel imprime no /proc/locks. */
export function decodeDev(dev: bigint): { major: number; minor: number } {
  return {
    major: Number(((dev >> 8n) & 0xfffn) | ((dev >> 32n) & 0xfffff000n)),
    minor: Number((dev & 0xffn) | ((dev >> 12n) & 0xffffff00n)),
  };
}

/**
 * Linha de trava no /proc/locks: "1: FLOCK  ADVISORY  WRITE 1234 08:01:131074 0 EOF". O kernel imprime major:minor
 * em hexadecimal ("%02x:%02x") e o inode em decimal. Linhas "1: -> FLOCK …" são processos esperando a trava (não a
 * seguram) e não casam.
 */
const LOCK_LINE = /^\s*\d+:\s+FLOCK\s+\S+\s+WRITE\s+-?\d+\s+([0-9a-f]+):([0-9a-f]+):(\d+)\s/i;

/**
 * Linux: o Codex usa flock(LOCK_EX), que não impede a leitura; o jeito de ver a trava sem pegá-la é achar o
 * dispositivo:inode do arquivo numa linha FLOCK WRITE do /proc/locks (achou = held; não achou = free). Arquivo
 * sumido = free; /proc/locks ilegível ou outro erro no stat = unknown.
 */
export function probeProc(
  lockPath: string,
  procLocksPath: string = PROC_LOCKS,
  statLock: (path: string) => { dev: bigint; ino: bigint } = (p) => statSync(p, { bigint: true }),
): LockState {
  let st: { dev: bigint; ino: bigint };
  try {
    st = statLock(lockPath);
  } catch (err) {
    return isMissing(err) ? 'free' : 'unknown';
  }
  const text = readText(procLocksPath);
  if (text === undefined) return 'unknown';
  const { major, minor } = decodeDev(st.dev);
  let anonSameInode = false;
  for (const line of text.split('\n')) {
    const m = LOCK_LINE.exec(line);
    if (!m || BigInt(m[3]) !== st.ino) continue;
    const lineMajor = parseInt(m[1], 16);
    if (lineMajor === major && parseInt(m[2], 16) === minor) return 'held';
    // btrfs (subvolumes) e overlayfs: o stat e o /proc/locks mostram dispositivos anônimos (major 0) diferentes para
    // o mesmo arquivo; aí vale o inode.
    if (lineMajor === 0 && major === 0) anonSameInode = true;
  }
  return anonSameInode ? 'held' : 'free';
}

/** Só a existência (macOS, Docker, Linux sem /proc/locks): existe → unknown; não existe → free. */
function probeExists(lockPath: string): LockState {
  try {
    statSync(lockPath);
    return 'unknown';
  } catch (err) {
    return isMissing(err) ? 'free' : 'unknown';
  }
}

export function createLockProber(opts: { platform: NodeJS.Platform; inDocker: boolean; procLocksPath?: string }): LockProber {
  const byExistence = (): LockProber => ({ mode: 'exists', probe: probeExists });
  // No Docker as travas do host não atravessam o bind mount (e o /proc/locks é o do contêiner).
  if (opts.inDocker) return byExistence();
  if (opts.platform === 'win32') return { mode: 'win32', probe: (p) => probeWin32(p) };
  if (opts.platform === 'linux') {
    const procLocksPath = opts.procLocksPath ?? PROC_LOCKS;
    if (readText(procLocksPath) !== undefined) return { mode: 'proc', probe: (p) => probeProc(p, procLocksPath) };
  }
  // macOS e outros: não há como ver a trava sem tentar adquiri-la.
  return byExistence();
}
