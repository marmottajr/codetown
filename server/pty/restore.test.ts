import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PtyManager, type PtyProcess, type SpawnPty } from './manager';
import { PtyRestore } from './restore';

const SID = '11111111-2222-3333-4444-555555555555';
let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function setup(alive: Set<number> = new Set()) {
  dir = mkdtempSync(join(tmpdir(), 'habblaud-pty-'));
  const calls: { args: string[]; cwd: string }[] = [];
  let pid = 100;
  const spawn: SpawnPty = (_file, args, o) => {
    calls.push({ args, cwd: o.cwd });
    const p: PtyProcess = { pid: ++pid, onData: () => {}, onExit: () => {}, write: () => {}, resize: () => {}, kill: () => {} };
    return p;
  };
  const killed: number[] = [];
  const ptys = new PtyManager({
    spawn,
    claudeBin: 'claude',
    accounts: () => [{ id: 'acc', dir, isDefault: true }],
    agent: () => undefined,
    onChange: () => {},
    killPid: (p) => {
      killed.push(p);
      alive.delete(p);
    },
    isAlive: (p) => alive.has(p),
    sleep: async () => {},
  });
  return { ptys, calls, killed };
}

describe('retomar terminais depois de reiniciar', () => {
  it('grava o que está aberto e retoma com --resume (uma vez por sessão)', async () => {
    const { ptys, calls } = setup();
    const n = await ptys.restore([
      { sessionId: SID, cwd: dir, account: 'acc' },
      { sessionId: SID, cwd: dir, account: 'acc' },
      { sessionId: 'nao-e-uuid', cwd: dir, account: 'acc' },
    ]);
    expect(n).toBe(1);
    expect(calls).toEqual([{ args: ['--resume', SID], cwd: dir }]);
    expect(ptys.restorable()).toEqual([{ sessionId: SID, cwd: dir, account: 'acc' }]);

    const file = join(dir, 'ptys.json');
    const r = new PtyRestore(file, ptys);
    await r.start(false);
    r.stop();
    expect(JSON.parse(readFileSync(file, 'utf8')).ptys).toEqual([{ sessionId: SID, cwd: dir, account: 'acc' }]);
  });

  it('encerra o processo que sobrou da sessão antes de retomar', async () => {
    const alive = new Set([4242]);
    const { ptys, killed, calls } = setup(alive);
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(dir, 'sessions'));
    writeFileSync(join(dir, 'sessions', '4242.json'), JSON.stringify({ sessionId: SID }));
    expect(await ptys.restore([{ sessionId: SID, cwd: dir, account: 'acc' }])).toBe(1);
    expect(killed).toEqual([4242]);
    expect(calls).toHaveLength(1);
  });
});
