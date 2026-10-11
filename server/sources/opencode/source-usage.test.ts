// A fonte do OpenCode empurra o uso local (custo e tokens dos últimos 7 dias) para a conta. Spec: .specs/features/opencode-uso.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AccountInfo } from '../../../shared/types';
import { AccountsService } from '../../accounts/service';
import { setQuiet } from '../../log';
import { NameStore } from '../../model/names';
import { Office } from '../../model/office';
import { tempDir } from '../../test/fixtures';
import { buildOpencodeDb, HAS_SQLITE, type OcFixture } from '../../test/opencode-fixtures';
import { createOpencodeSource } from './boot';
import { USAGE_WINDOW_MS } from './files';
import { OpencodeSource } from './source';

setQuiet(true);

const DAY = 86_400_000;
let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
  vi.restoreAllMocks();
  setQuiet(true);
});

function setup(opts: { noDb?: boolean } = {}) {
  let fx: OcFixture | undefined;
  let dir: string;
  if (opts.noDb) {
    const t = tempDir('habblaud-oc-');
    dir = t.dir;
    cleanups.push(t.cleanup);
  } else {
    fx = buildOpencodeDb();
    dir = fx.dir;
    cleanups.push(fx.cleanup);
  }
  let clock = Date.now();
  const now = () => clock;
  const late: { office?: Office } = {};
  const accounts = new AccountsService({ dirs: [], home: dir, env: {}, now, onChange: () => late.office?.markDirty() });
  const office = new Office({
    names: new NameStore(null),
    version: 'teste',
    startedAt: clock,
    accounts: (s) => accounts.list(s),
    sources: () => [],
    accountName: (id) => accounts.find(id)?.detected.name,
    now,
  });
  late.office = office;
  const source = new OpencodeSource({ accounts, office, dir, now, watch: false });
  cleanups.unshift(() => source.stop());
  return {
    fx: fx!,
    dir,
    accounts,
    office,
    source,
    now,
    advance(ms: number) {
      clock += ms;
    },
    card(): AccountInfo | undefined {
      return accounts.list(new Map()).find((a) => a.provider === 'opencode');
    },
  };
}

/** Resposta do assistente no formato do OpenCode (`time.created` em epoch ms). */
function reply(fx: OcFixture, session: string, at: number, cost: number, input: number, output: number, cacheRead: number): void {
  fx.addMessage({
    session,
    role: 'assistant',
    created: at,
    rawData: JSON.stringify({ role: 'assistant', time: { created: at, completed: at + 1 }, cost, tokens: { total: 0, input, output, reasoning: 0, cache: { read: cacheRead, write: 0 } } }),
  });
}

describe.skipIf(!HAS_SQLITE)('fonte do OpenCode: uso local na conta (OCU)', () => {
  it('OCU-01: a conta do OpenCode traz custo e tokens dos últimos 7 dias (sem janelas de cota)', async () => {
    const t = setup();
    const s = t.fx.addSession({ updated: t.now() });
    reply(t.fx, s, t.now() - DAY, 1.5, 1000, 200, 5000);
    reply(t.fx, s, t.now() - 3 * DAY, 0.25, 500, 100, 2500);
    reply(t.fx, s, t.now() - 8 * DAY, 10, 9_000_000, 9_000, 90_000_000); // fora da janela
    await t.source.start();
    const usage = t.card()?.usage;
    expect(usage?.source).toBe('opencode');
    expect(usage?.fetchedAt).toBe(t.now());
    expect(usage?.local).toEqual({ days: 7, costUsd: 1.75, input: 1500, output: 300, reasoning: 0, cacheRead: 7500, cacheWrite: 0 });
    expect(usage?.fiveHour).toBeUndefined();
    expect(usage?.sevenDay).toBeUndefined();
    expect(USAGE_WINDOW_MS).toBe(usage!.local!.days * DAY);
  });

  it('OCU-01: a janela anda com o relógio (resposta de 6 dias sai da soma 2 dias depois)', async () => {
    const t = setup();
    const s = t.fx.addSession({ updated: t.now() });
    reply(t.fx, s, t.now() - 6 * DAY, 2, 100, 10, 0);
    await t.source.start();
    expect(t.card()?.usage?.local?.costUsd).toBe(2);
    t.advance(2 * DAY);
    t.source.poll();
    expect(t.card()?.usage?.local).toMatchObject({ costUsd: 0, input: 0, output: 0 });
  });

  it('OCU-04: se a leitura falha, o cartão mantém o último valor bom e sua hora', async () => {
    const t = setup();
    const s = t.fx.addSession({ updated: t.now() });
    reply(t.fx, s, t.now() - DAY, 1.5, 1000, 200, 5000);
    await t.source.start();
    const good = t.card()!.usage!;
    expect(good.local?.costUsd).toBe(1.5);
    t.fx.db.exec('ALTER TABLE message RENAME TO message_fora');
    t.advance(2 * 60_000);
    t.source.poll();
    expect(t.card()!.usage).toEqual(good);
    t.fx.db.exec('ALTER TABLE message_fora RENAME TO message');
    reply(t.fx, s, t.now() - 1000, 0.5, 10, 1, 0);
    t.advance(2 * 60_000);
    t.source.poll();
    expect(t.card()!.usage?.local?.costUsd).toBe(2);
  });

  it('OCU-04: banco que falha desde a primeira leitura não inventa números (a conta fica sem uso)', async () => {
    const t = setup();
    t.fx.addSession({ updated: t.now() });
    t.fx.db.exec('ALTER TABLE message RENAME TO message_fora');
    await t.source.start();
    expect(t.card()).toBeDefined();
    expect(t.card()?.usage).toBeUndefined();
    expect(t.card()?.usageStatus).toBe('disabled');
  });

  it('OCU-03/OCU-08: sem opencode.db (é o caso do Docker) a fonte não registra conta nem uso', async () => {
    const t = setup({ noDb: true });
    const docker = createOpencodeSource({ opencode: true, opencodeDir: t.dir, inDocker: true }, { accounts: t.accounts, office: t.office })!;
    cleanups.unshift(() => docker.stop());
    await docker.start();
    expect(t.card()).toBeUndefined();
    expect(t.accounts.list(new Map())).toEqual([]);
  });
});
