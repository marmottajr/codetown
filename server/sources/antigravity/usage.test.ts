// A fonte do Antigravity lendo o arquivo de cotas que o statusline do agy grava (AG-27): números na conta, conta que
// aparece só com os números, arquivo trocado ou estragado, e os limites. Dados sintéticos no formato real.
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AccountsService } from '../../accounts/service';
import { setQuiet } from '../../log';
import { NameStore } from '../../model/names';
import { Office } from '../../model/office';
import { tempDir } from '../../test/fixtures';
import { AntigravitySource } from './source';

setQuiet(true);

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

const QUOTA = {
  '3p-weekly': { remaining_fraction: 1, reset_time: '2026-10-17T16:37:57Z' },
  'gemini-weekly': { remaining_fraction: 0.8337216, reset_time: '2026-10-17T14:54:02Z' },
};

function setup() {
  const t = tempDir('habblaud-agyusage-');
  cleanups.push(t.cleanup);
  const file = join(t.dir, 'usage', 'antigravity-quota.json');
  mkdirSync(join(t.dir, 'usage'));
  const now = () => Date.parse('2026-10-10T16:00:00Z');
  const late: { office?: Office } = {};
  const accounts = new AccountsService({ dirs: [], home: t.dir, env: {}, now, onChange: () => late.office?.markDirty() });
  const office = new Office({ names: new NameStore(null), version: 't', startedAt: now(), accounts: (s) => accounts.list(s), sources: () => [], accountName: (id) => accounts.find(id)?.detected.name, now });
  late.office = office;
  const source = new AntigravitySource({ accounts, office, now, usageFile: file, usagePollMs: 20 });
  cleanups.unshift(() => source.stop());
  let touch = 1_000;
  const write = (body: unknown) => {
    writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body));
    utimesSync(file, ++touch, touch); // muda o mtime a cada escrita
  };
  const usage = () => office.commit().snapshot.accounts.find((a) => a.id === 'antigravity')?.usage;
  return { accounts, office, source, file, write, usage, now };
}

describe('uso do Antigravity (arquivo de cotas)', () => {
  it('arquivo com cotas: a conta aparece com a barra principal (Gemini) e a outra em extra, sem nenhum evento de hook', () => {
    const c = setup();
    c.write({ fetchedAt: c.now() - 5_000, quota: QUOTA });
    c.source.start();
    const u = c.usage()!;
    expect(u).toMatchObject({ source: 'antigravity', labels: { sevenDay: 'Gemini' }, fetchedAt: c.now() - 5_000 });
    expect(u.sevenDay!.utilization).toBeCloseTo(16.63, 1);
    expect(u.extra).toHaveLength(1);
    expect(c.accounts.find('antigravity')?.detected.name).toBe('Antigravity');
    expect(c.source.sources()).toEqual([expect.objectContaining({ provider: 'antigravity', sessions: 0 })]);
  });

  it('sem o arquivo: nada (nem conta); com a opção ausente: nada', () => {
    const c = setup();
    c.source.start();
    expect(c.usage()).toBeUndefined();
    expect(c.accounts.find('antigravity')).toBeUndefined();
  });

  it('o arquivo muda: os números novos entram na leitura seguinte (a cada 20 ms no teste)', async () => {
    const c = setup();
    c.write({ fetchedAt: c.now(), quota: QUOTA });
    c.source.start();
    expect(c.usage()!.sevenDay!.utilization).toBeCloseTo(16.63, 1);
    c.write({ fetchedAt: c.now(), quota: { 'gemini-weekly': { remaining_fraction: 0.5, reset_time: '2026-10-17T14:54:02Z' } } });
    await new Promise((ok) => setTimeout(ok, 80));
    expect(c.usage()!.sevenDay!.utilization).toBe(50);
    expect(c.usage()!.extra).toBeUndefined();
  });

  it('arquivo estragado, grande demais ou sem cota válida não derruba; o último número é trocado por nada só se o arquivo ficou sem cota', () => {
    const c = setup();
    c.write({ fetchedAt: c.now(), quota: QUOTA });
    c.source.start();
    c.write('{ quebrado');
    c.source.readUsage();
    expect(c.usage()).toBeDefined();
    c.write(JSON.stringify({ fetchedAt: c.now(), quota: QUOTA, lixo: 'x'.repeat(20_000) }));
    c.source.readUsage();
    expect(c.usage()).toBeDefined();
    c.write({ fetchedAt: c.now(), quota: {} });
    c.source.readUsage();
    expect(c.usage()).toBeUndefined();
  });

  it('fetchedAt no futuro vale como agora; sem fetchedAt vale a data do arquivo', () => {
    const c = setup();
    c.write({ fetchedAt: c.now() + 3_600_000, quota: QUOTA });
    c.source.start();
    expect(c.usage()!.fetchedAt).toBe(c.now());
    c.write({ quota: QUOTA });
    c.source.readUsage();
    expect(c.usage()!.fetchedAt).toBeLessThanOrEqual(c.now());
  });

  it('só lê as cotas: nada do que mais vier no arquivo (e-mail, pasta) chega à conta', () => {
    const c = setup();
    c.write({ fetchedAt: c.now(), quota: QUOTA, email: 'a@b.c', cwd: '/segredo' });
    c.source.start();
    expect(JSON.stringify(c.office.commit().snapshot)).not.toMatch(/a@b\.c|segredo/);
  });
});
