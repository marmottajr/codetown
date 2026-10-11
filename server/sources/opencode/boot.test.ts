// Registro da fonte do OpenCode no boot: OC-07, OC-08, OC-10, e as outras fontes seguem rodando.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccountsService } from '../../accounts/service';
import { setQuiet } from '../../log';
import { NameStore } from '../../model/names';
import { Office } from '../../model/office';
import { tempDir } from '../../test/fixtures';
import { buildOpencodeDb, HAS_SQLITE, ocId } from '../../test/opencode-fixtures';
import { SourceSet, type AgentSource } from '../source';
import { createOpencodeSource } from './boot';

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
  vi.restoreAllMocks();
  setQuiet(true);
});

function deps() {
  const t = tempDir();
  cleanups.push(t.cleanup);
  const accounts = new AccountsService({ dirs: [], home: t.dir, env: {}, now: Date.now, onChange: () => {} });
  const office = new Office({ names: new NameStore(null), version: 'teste', startedAt: Date.now(), accounts: (s) => accounts.list(s), sources: () => [], accountName: () => undefined });
  return { accounts, office };
}

describe('createOpencodeSource', () => {
  it('OC-10: HABBLAUD_OPENCODE=0 (config.opencode false) não cria a fonte nem abre o banco', () => {
    const importer = vi.fn(async () => {
      throw new Error('não deveria importar');
    });
    expect(createOpencodeSource({ opencode: false, opencodeDir: '/qualquer' }, { ...deps(), importer })).toBeUndefined();
    expect(importer).not.toHaveBeenCalled();
  });

  it('OC-08: sem opencode.db a fonte fica dormente: nada registrado e nada logado', async () => {
    setQuiet(false);
    const spies = (['log', 'warn', 'error'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    const t = tempDir();
    cleanups.push(t.cleanup);
    const d = deps();
    const src = createOpencodeSource({ opencode: true, opencodeDir: t.dir }, d)!;
    cleanups.push(() => src.stop());
    await src.start();
    expect(src.sources()).toEqual([]);
    expect(d.office.commit().snapshot.agents).toEqual([]);
    expect(d.office.commit().snapshot.accounts.filter((a) => a.id === 'opencode')).toEqual([]);
    for (const s of spies) expect(s).not.toHaveBeenCalled();
  });

  it.skipIf(!HAS_SQLITE)('com o banco e ligado, cria a fonte do provider opencode', () => {
    const fx = buildOpencodeDb();
    cleanups.push(fx.cleanup);
    const src = createOpencodeSource({ opencode: true, opencodeDir: fx.dir }, deps());
    expect(src?.provider).toBe('opencode');
  });

  it.skipIf(!HAS_SQLITE)('OC-07: node:sqlite ausente loga uma linha e as outras fontes continuam no SourceSet', async () => {
    setQuiet(false);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fx = buildOpencodeDb();
    cleanups.push(fx.cleanup);
    fx.addSession({ id: ocId('ses', 1), directory: '/p/a' });
    const oc = createOpencodeSource(
      { opencode: true, opencodeDir: fx.dir },
      {
        ...deps(),
        importer: async () => {
          throw new Error('sem sqlite');
        },
      },
    )!;
    const started: string[] = [];
    const other: AgentSource = { provider: 'claude', start: () => void started.push('claude'), stop: () => {}, sources: () => [], transcriptPathOf: () => undefined };
    const set = new SourceSet([other, oc]);
    await set.start();
    expect(started).toEqual(['claude']);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('22.13');
    expect(err).not.toHaveBeenCalled();
    expect(set.of('opencode')).toBe(oc);
    set.stop();
  });
});

describe.skipIf(!HAS_SQLITE)('createOpencodeSource: banco que ainda não existe no boot (OC-08)', () => {
  afterEach(() => vi.useRealTimers());

  it('o banco aparece depois: as sessões entram em um re-check mais um ciclo, sem log', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'setTimeout', 'clearInterval', 'clearTimeout'] });
    setQuiet(false);
    const spies = (['log', 'warn', 'error'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    const t = tempDir();
    cleanups.push(t.cleanup);
    const d = deps();
    const src = createOpencodeSource({ opencode: true, opencodeDir: t.dir }, { ...d, watch: false })!;
    cleanups.push(() => src.stop());
    await src.start();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(d.office.commit().snapshot.agents).toEqual([]);
    const fx = buildOpencodeDb({ dir: t.dir });
    cleanups.push(() => fx.db.close());
    fx.addSession({ id: ocId('ses', 7), directory: '/p/a', updated: Date.now() });
    await vi.advanceTimersByTimeAsync(5_000 + 1_000);
    expect(d.office.commit().snapshot.agents.map((a) => a.id)).toContain(`opencode:${ocId('ses', 7)}`);
    expect(src.sources()).toHaveLength(1);
    for (const s of spies) expect(s).not.toHaveBeenCalled();
  });

  it('stop() limpa o timer de espera', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'setTimeout', 'clearInterval', 'clearTimeout'] });
    const t = tempDir();
    cleanups.push(t.cleanup);
    const src = createOpencodeSource({ opencode: true, opencodeDir: t.dir }, { ...deps(), watch: false })!;
    await src.start();
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    src.stop();
    expect(vi.getTimerCount()).toBe(0);
    const fx = buildOpencodeDb({ dir: t.dir });
    cleanups.push(() => fx.db.close());
    await vi.advanceTimersByTimeAsync(20_000);
    expect(src.sources()).toEqual([]);
  });

  it('sem node:sqlite: uma linha no log e não fica esperando o arquivo', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'setTimeout', 'clearInterval', 'clearTimeout'] });
    setQuiet(false);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fx = buildOpencodeDb();
    cleanups.push(fx.cleanup);
    const src = createOpencodeSource(
      { opencode: true, opencodeDir: fx.dir },
      {
        ...deps(),
        watch: false,
        importer: async () => {
          throw new Error('sem sqlite');
        },
      },
    )!;
    cleanups.push(() => src.stop());
    await src.start();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
