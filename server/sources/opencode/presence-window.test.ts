// OC-01/OC-05: a janela de presença é de 30 minutos. O valor literal fica fixado aqui (sem importar PRESENCE_MS, que
// tornaria o teste uma tautologia): sessão atualizada há 29 min aparece, há 31 min não, com o relógio injetado.
import { afterEach, describe, expect, it } from 'vitest';
import { AccountsService } from '../../accounts/service';
import { setQuiet } from '../../log';
import { NameStore } from '../../model/names';
import { Office } from '../../model/office';
import { buildOpencodeDb, HAS_SQLITE, ocId } from '../../test/opencode-fixtures';
import { OpencodeSource } from './source';

setQuiet(true);

const MIN = 60_000;
const NOW = 1_800_000_000_000;
const S_RECENT = ocId('ses', 31);
const S_OLD = ocId('ses', 32);

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c();
});

describe.skipIf(!HAS_SQLITE)('fonte do OpenCode: janela de presença de 30 minutos (literal)', () => {
  it('OC-01/OC-05: atualizada há 29 min aparece; há 31 min não aparece', async () => {
    const fx = buildOpencodeDb();
    cleanups.push(fx.cleanup);
    const now = () => NOW;
    const late: { office?: Office } = {};
    const accounts = new AccountsService({ dirs: [], home: fx.dir, env: {}, now, onChange: () => late.office?.markDirty() });
    const office = new Office({ names: new NameStore(null), version: 't', startedAt: NOW, accounts: (s) => accounts.list(s), sources: () => [], accountName: (id) => accounts.find(id)?.detected.name, now });
    late.office = office;
    const source = new OpencodeSource({ accounts, office, dir: fx.dir, now, watch: false });
    cleanups.push(() => source.stop());
    fx.addSession({ id: S_RECENT, directory: '/p/recente', updated: NOW - 29 * MIN });
    fx.addSession({ id: S_OLD, directory: '/p/velha', updated: NOW - 31 * MIN });
    await source.start();
    const ids = office.commit().snapshot.agents.map((a) => a.id);
    expect(ids).toContain(`opencode:${S_RECENT}`);
    expect(ids).not.toContain(`opencode:${S_OLD}`);
  });
});
