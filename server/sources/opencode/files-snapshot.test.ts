// Edge case "instantâneo consistente": o ciclo de leitura roda numa única transação de leitura (BEGIN/COMMIT na conexão
// somente leitura, banco em modo WAL). Uma gravação de OUTRA conexão entre duas consultas do mesmo ciclo não aparece nele,
// só no ciclo seguinte. Banco sintético temporário; a conexão de escrita é a da fixture.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildOpencodeDb, HAS_SQLITE, ocId, type OcFixture } from '../../test/opencode-fixtures';
import { inSnapshot, listSessions, openDb, type OcDb } from './files';

const NOW = 1_800_000_000_000;

describe.skipIf(!HAS_SQLITE)('leitura em uma única transação', () => {
  let fx: OcFixture | undefined;
  let db: OcDb | undefined;
  afterEach(() => {
    db?.close();
    db = undefined;
    fx?.cleanup();
    fx = undefined;
  });
  const open = async (onError?: (e: unknown) => void) => {
    fx = buildOpencodeDb();
    const r = await openDb(fx.dir, { onError });
    if (typeof r === 'string') throw new Error(`openDb: ${r}`);
    db = r;
    return { fx, db: r };
  };

  it('gravação entre duas consultas do mesmo ciclo não aparece nele, mas aparece no ciclo seguinte', async () => {
    const { fx, db } = await open();
    expect(String(fx.db.prepare('PRAGMA journal_mode').get()?.journal_mode)).toBe('wal');
    fx.addSession({ id: ocId('ses', 1), updated: NOW });
    const inside = inSnapshot(db, () => {
      const first = listSessions(db, 0).map((s) => s.id);
      fx.addSession({ id: ocId('ses', 2), updated: NOW });
      const second = listSessions(db, 0).map((s) => s.id);
      return { first, second };
    });
    expect(inside.first).toEqual([ocId('ses', 1)]);
    expect(inside.second).toEqual([ocId('ses', 1)]);
    expect(listSessions(db, 0).map((s) => s.id).sort()).toEqual([ocId('ses', 1), ocId('ses', 2)].sort());
  });

  it('sem a transação a mesma gravação seria vista (o teste distingue de fato)', async () => {
    const { fx, db } = await open();
    fx.addSession({ id: ocId('ses', 1), updated: NOW });
    const first = listSessions(db, 0).length;
    fx.addSession({ id: ocId('ses', 2), updated: NOW });
    expect([first, listSessions(db, 0).length]).toEqual([1, 2]);
  });

  it('termina sempre a transação (COMMIT no finally), mesmo se a função lançar; a escrita seguinte não fica travada', async () => {
    const { fx, db } = await open();
    expect(() =>
      inSnapshot(db, () => {
        throw new Error('falhou no meio');
      }),
    ).toThrow('falhou no meio');
    expect((db.raw as unknown as { isTransaction: boolean }).isTransaction).toBe(false);
    fx.addSession({ id: ocId('ses', 3), updated: NOW });
    expect(listSessions(db, 0)).toHaveLength(1);
  });

  it('BEGIN que falha (já dentro de uma transação): segue sem transação e mantém as regras de cache', async () => {
    const onError = vi.fn();
    const { fx, db } = await open(onError);
    fx.addSession({ id: ocId('ses', 1), updated: NOW });
    const out = inSnapshot(db, () => inSnapshot(db, () => listSessions(db, 0).map((s) => s.id)));
    expect(out).toEqual([ocId('ses', 1)]);
    expect((db.raw as unknown as { isTransaction: boolean }).isTransaction).toBe(false); // o COMMIT de fora terminou
    db.raw.close();
    expect(inSnapshot(db, () => listSessions(db, 0).map((s) => s.id))).toEqual([ocId('ses', 1)]); // fechado: último bom
    expect(onError).toHaveBeenCalled();
  });
});
