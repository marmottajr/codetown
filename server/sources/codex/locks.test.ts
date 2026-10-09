// Sondagem das travas de escrita do Codex (thread-writer-locks/<threadId>.lock): só sonda, nunca adquire.
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { threadId } from '../../test/codex-fixtures';
import { tempDir } from '../../test/fixtures';
import { createLockProber, decodeDev, probeProc, probeWin32, type ProbeFs } from './locks';

const errno = (code: string) => Object.assign(new Error(`${code}: simulado`), { code });

/** fs falso que registra as chamadas; cada função decide o que a operação faz. */
function fakeFs(o: { open?: () => number; read?: () => number; close?: () => void } = {}) {
  const calls = { open: [] as Array<[string, string]>, read: [] as Array<[number, number, number]>, closed: [] as number[] };
  const fs: ProbeFs = {
    openSync(path, flags) {
      calls.open.push([path, flags]);
      return o.open ? o.open() : 7;
    },
    readSync(fd, _buffer, _offset, length, position) {
      calls.read.push([fd, length, position]);
      return o.read ? o.read() : 0;
    },
    closeSync(fd) {
      calls.closed.push(fd);
      o.close?.();
    },
  };
  return { fs, calls };
}

/** dev_t como o glibc monta (makedev), para simular o stat do Linux. */
const makedev = (major: number, minor: number) =>
  ((BigInt(major) & 0xfffn) << 8n) | ((BigInt(major) & 0xfffff000n) << 32n) | (BigInt(minor) & 0xffn) | ((BigInt(minor) & 0xffffff00n) << 12n);

const hex = (n: number) => n.toString(16).padStart(2, '0');

describe('sondagem das travas do Codex', () => {
  let tmp: ReturnType<typeof tempDir>;
  let locks: string;
  /** /proc/locks falso (arquivo temporário). */
  let proc: string;
  beforeEach(() => {
    tmp = tempDir();
    locks = join(tmp.dir, 'thread-writer-locks');
    mkdirSync(locks);
    proc = join(tmp.dir, 'proc-locks');
  });
  afterEach(() => tmp.cleanup());

  const lockFile = (n: number) => {
    const p = join(locks, `${threadId(n)}.lock`);
    writeFileSync(p, '');
    return p;
  };
  const missing = () => join(locks, `${threadId(99)}.lock`);
  const writeProc = (...lines: string[]) => writeFileSync(proc, lines.map((l) => `${l}\n`).join(''));
  /** Linha do /proc/locks de uma trava FLOCK WRITE no arquivo `p` de verdade (dev:inode do stat). */
  const flockLine = (p: string) => {
    const st = statSync(p, { bigint: true });
    const { major, minor } = decodeDev(st.dev);
    return `1: FLOCK  ADVISORY  WRITE 4321 ${hex(major)}:${hex(minor)}:${st.ino} 0 EOF`;
  };

  describe('probeWin32', () => {
    it('arquivo de 0 byte sem trava: a leitura passa → free; inexistente → free', () => {
      expect(probeWin32(lockFile(1))).toBe('free');
      expect(probeWin32(missing())).toBe('free');
    });

    it('EBUSY na leitura (LockFileEx do Codex) → held, abrindo só com "r", lendo 1 byte no offset 0 e fechando o handle', () => {
      const { fs, calls } = fakeFs({
        read: () => {
          throw errno('EBUSY');
        },
      });
      expect(probeWin32('x.lock', fs)).toBe('held');
      expect(calls.open).toEqual([['x.lock', 'r']]);
      expect(calls.read).toEqual([[7, 1, 0]]);
      expect(calls.closed).toEqual([7]);
    });

    it('EBUSY na abertura → held; ENOENT → free; outros erros → unknown; o handle aberto sempre é fechado', () => {
      const failOpen = (code: string) =>
        fakeFs({
          open: () => {
            throw errno(code);
          },
        });
      expect(probeWin32('x.lock', failOpen('EBUSY').fs)).toBe('held');
      expect(probeWin32('x.lock', failOpen('ENOENT').fs)).toBe('free');
      expect(probeWin32('x.lock', failOpen('EPERM').fs)).toBe('unknown');
      expect(probeWin32('x.lock', failOpen('EACCES').fs)).toBe('unknown');
      const eio = fakeFs({
        read: () => {
          throw errno('EIO');
        },
      });
      expect(probeWin32('x.lock', eio.fs)).toBe('unknown');
      expect(eio.calls.closed).toEqual([7]);
      const zero = fakeFs();
      expect(probeWin32('x.lock', zero.fs)).toBe('free');
      expect(zero.calls.closed).toEqual([7]);
    });

    it('erro ao fechar o handle não muda a resposta', () => {
      const busy = fakeFs({
        read: () => {
          throw errno('EBUSY');
        },
        close: () => {
          throw errno('EBADF');
        },
      });
      expect(probeWin32('x.lock', busy.fs)).toBe('held');
      const free = fakeFs({
        close: () => {
          throw errno('EBADF');
        },
      });
      expect(probeWin32('x.lock', free.fs)).toBe('free');
    });
  });

  describe('probeProc (/proc/locks)', () => {
    const DEV = makedev(259, 3); // o kernel imprime 103:03
    const INO = 1_234_567n;
    const stat = () => ({ dev: DEV, ino: INO });

    it('decodeDev: major/minor da codificação do glibc, inclusive os bits altos', () => {
      expect(decodeDev(0x801n)).toEqual({ major: 8, minor: 1 });
      expect(decodeDev(makedev(259, 3))).toEqual({ major: 259, minor: 3 });
      expect(decodeDev(makedev(8, 0x123))).toEqual({ major: 8, minor: 0x123 });
      expect(decodeDev(makedev(0x1234, 0x12345))).toEqual({ major: 0x1234, minor: 0x12345 });
    });

    it('FLOCK WRITE com o mesmo dispositivo (major:minor em hex) e inode → held', () => {
      writeProc('1: POSIX  ADVISORY  WRITE 900 08:01:42 0 EOF', '2: FLOCK  ADVISORY  WRITE 4321 103:03:1234567 0 EOF');
      expect(probeProc('/codex/thread-writer-locks/x.lock', proc, stat)).toBe('held');
    });

    it('sem a linha certa → free (decimal no lugar de hex, outro inode, READ, POSIX, só quem espera)', () => {
      writeProc(
        '1: FLOCK  ADVISORY  WRITE 4321 259:3:1234567 0 EOF',
        '2: FLOCK  ADVISORY  WRITE 4321 103:03:1234568 0 EOF',
        '3: FLOCK  ADVISORY  READ  4321 103:03:1234567 0 EOF',
        '4: POSIX  ADVISORY  WRITE 4321 103:03:1234567 0 EOF',
        '5: -> FLOCK  ADVISORY  WRITE 4322 103:03:1234567 0 EOF',
      );
      expect(probeProc('/x.lock', proc, stat)).toBe('free');
      writeFileSync(proc, '');
      expect(probeProc('/x.lock', proc, stat)).toBe('free');
    });

    it('minor com mais de 8 bits e major com mais de 12 bits', () => {
      writeProc('7: FLOCK  ADVISORY  WRITE 1 08:123:99 0 EOF', '8: FLOCK  ADVISORY  WRITE 1 1234:12345:100 0 EOF');
      expect(probeProc('/a.lock', proc, () => ({ dev: makedev(8, 0x123), ino: 99n }))).toBe('held');
      expect(probeProc('/b.lock', proc, () => ({ dev: makedev(0x1234, 0x12345), ino: 100n }))).toBe('held');
    });

    it('btrfs/overlayfs (major 0 dos dois lados, minor diferente): vale o inode; com dispositivo de verdade, não', () => {
      const anon = () => ({ dev: makedev(0, 0x2d), ino: 4242n });
      writeProc('1: FLOCK  ADVISORY  WRITE 10 00:2f:4242 0 EOF');
      expect(probeProc('/x.lock', proc, anon)).toBe('held');
      writeProc('1: FLOCK  ADVISORY  WRITE 10 00:2f:4243 0 EOF');
      expect(probeProc('/x.lock', proc, anon)).toBe('free');
      writeProc('1: FLOCK  ADVISORY  WRITE 10 08:01:4242 0 EOF');
      expect(probeProc('/x.lock', proc, anon)).toBe('free');
      writeProc('1: FLOCK  ADVISORY  WRITE 10 00:2f:4242 0 EOF');
      expect(probeProc('/x.lock', proc, () => ({ dev: makedev(8, 1), ino: 4242n }))).toBe('free');
    });

    it('arquivo sumiu → free; /proc/locks ilegível agora → unknown; erro no stat → unknown', () => {
      writeProc('2: FLOCK  ADVISORY  WRITE 4321 103:03:1234567 0 EOF');
      expect(
        probeProc('/x.lock', proc, () => {
          throw errno('ENOENT');
        }),
      ).toBe('free');
      expect(
        probeProc('/x.lock', proc, () => {
          throw errno('EACCES');
        }),
      ).toBe('unknown');
      expect(probeProc('/x.lock', join(tmp.dir, 'sem-proc-locks'), stat)).toBe('unknown');
    });

    it('arquivo de verdade: o stat padrão (bigint) casa com o dev:inode do /proc/locks', () => {
      const p = lockFile(1);
      writeProc(flockLine(p));
      expect(probeProc(p, proc)).toBe('held');
      writeFileSync(proc, '');
      expect(probeProc(p, proc)).toBe('free');
      writeProc(flockLine(p));
      expect(probeProc(missing(), proc)).toBe('free');
    });
  });

  describe('createLockProber', () => {
    it('Windows fora do Docker: modo win32 (leitura de 1 byte)', () => {
      const prober = createLockProber({ platform: 'win32', inDocker: false });
      expect(prober.mode).toBe('win32');
      expect(prober.probe(lockFile(1))).toBe('free');
      expect(prober.probe(missing())).toBe('free');
    });

    it('Linux com /proc/locks legível na criação: modo proc, relido a cada sondagem', () => {
      const p = lockFile(1);
      writeProc(flockLine(p));
      const prober = createLockProber({ platform: 'linux', inDocker: false, procLocksPath: proc });
      expect(prober.mode).toBe('proc');
      expect(prober.probe(p)).toBe('held');
      writeFileSync(proc, '');
      expect(prober.probe(p)).toBe('free');
      expect(prober.probe(missing())).toBe('free');
      rmSync(proc);
      expect(prober.probe(p)).toBe('unknown');
    });

    it('Linux com /proc/locks ilegível na criação: modo exists, mesmo que ele apareça depois', () => {
      const p = lockFile(1);
      const prober = createLockProber({ platform: 'linux', inDocker: false, procLocksPath: proc });
      expect(prober.mode).toBe('exists');
      writeProc(flockLine(p));
      expect(prober.probe(p)).toBe('unknown');
      expect(prober.probe(missing())).toBe('free');
    });

    it('macOS e Docker (qualquer host): modo exists; arquivo existente → unknown, inexistente → free', () => {
      const p = lockFile(1);
      writeProc(flockLine(p));
      for (const prober of [
        createLockProber({ platform: 'darwin', inDocker: false }),
        createLockProber({ platform: 'win32', inDocker: true }),
        createLockProber({ platform: 'linux', inDocker: true, procLocksPath: proc }),
      ]) {
        expect(prober.mode).toBe('exists');
        expect(prober.probe(p)).toBe('unknown');
        expect(prober.probe(missing())).toBe('free');
      }
    });

    it('sem procLocksPath, o Linux usa o /proc/locks do sistema', () => {
      let readable = true;
      try {
        readFileSync('/proc/locks', 'utf8');
      } catch {
        readable = false;
      }
      expect(createLockProber({ platform: 'linux', inDocker: false }).mode).toBe(readable ? 'proc' : 'exists');
    });
  });

  it('nunca adquire a trava nem escreve: só open "r", leitura, stat e /proc/locks', () => {
    const src = readFileSync(fileURLToPath(new URL('./locks.ts', import.meta.url)), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    expect(src).not.toMatch(/\bflock\s*\(|\bfcntl\b|LockFileEx|O_EXLOCK|\blockSync\b|constants\.O_/);
    expect(src).not.toMatch(/\b(?:writeSync|writeFileSync|appendFileSync|ftruncateSync|truncateSync|renameSync|unlinkSync|rmSync|mkdirSync)\b/);
    expect(src).not.toMatch(/'(?:r\+|rs\+|w\+?|wx\+?|a\+?|ax\+?|as\+?)'/);
    expect(src.match(/openSync\(/g)).toHaveLength(2); // a declaração em ProbeFs e a única chamada, com 'r'
    expect(src).toMatch(/fs\.openSync\(lockPath, 'r'\)/);
  });
});
