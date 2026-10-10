// Integração da fonte do OpenCode: banco sintético (SQLite temporário), AccountsService e Office.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { describeTool } from '../../../shared/activity';
import type { AgentInfo } from '../../../shared/types';
import { AccountsService } from '../../accounts/service';
import { setQuiet } from '../../log';
import { NameStore } from '../../model/names';
import { Office, OFFLINE_GRACE_MS } from '../../model/office';
import { tempDir } from '../../test/fixtures';
import { buildOpencodeDb, HAS_SQLITE, ocId, toolPart, type OcFixture } from '../../test/opencode-fixtures';
import { OpencodeSource, PRESENCE_MS } from './source';

setQuiet(true);

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
  vi.restoreAllMocks();
  vi.useRealTimers();
  setQuiet(true);
});

function setup(opts: { watch?: boolean; importer?: ConstructorParameters<typeof OpencodeSource>[0]['importer']; noDb?: boolean } = {}) {
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
  const source = new OpencodeSource({ accounts, office, dir, now, watch: opts.watch ?? false, importer: opts.importer });
  cleanups.unshift(() => source.stop());
  return {
    fx: fx!,
    accounts,
    office,
    source,
    now,
    advance(ms: number) {
      clock += ms;
    },
    poll() {
      source.poll();
      office.tick();
      return office.commit().snapshot;
    },
    agents(): AgentInfo[] {
      return office.commit().snapshot.agents;
    },
    agent(id: string): AgentInfo | undefined {
      return office.commit().snapshot.agents.find((a) => a.id === `opencode:${id}`);
    },
  };
}

const S1 = ocId('ses', 1);
const S2 = ocId('ses', 2);
const key = (id: string) => `opencode:${id}`;

describe.skipIf(!HAS_SQLITE)('fonte do OpenCode: presença e status', () => {
  it('OC-01/OC-02/OC-03: principal e subagente na sala do projeto, com provider, conta, pai e status', async () => {
    const ctx = setup();
    const t = ctx.now();
    ctx.fx.addSession({ id: S1, directory: '/projetos/loja', updated: t, title: 'Loja' });
    ctx.fx.addSession({ id: S2, parent: S1, directory: '/projetos/loja', updated: t - 500, title: 'Sub' });
    ctx.fx.addMessage({ session: S1, role: 'assistant', created: t - 2000, completed: t - 1000 });
    ctx.fx.addMessage({ session: S2, role: 'assistant', created: t - 900 });
    await ctx.source.start();
    const agents = ctx.agents();
    expect(agents).toHaveLength(2);
    const main = agents.find((a) => a.id === key(S1))!;
    const sub = agents.find((a) => a.id === key(S2))!;
    expect(main).toMatchObject({ kind: 'main', provider: 'opencode', sessionId: S1, status: 'idle', account: 'opencode', title: 'Loja' });
    expect(sub).toMatchObject({ kind: 'sub', parentId: key(S1), status: 'working', roomId: main.roomId });
    expect(main.roomId).toContain('loja');
    expect(ctx.source.sources()).toEqual([expect.objectContaining({ provider: 'opencode', sessions: 1, ok: true })]);
    expect(ctx.accounts.find('opencode')?.detected.name).toBe('OpenCode');
  });

  it('OC-03: assistente sem completed = working; ao completar vira idle, e uma nova rodada volta a working', async () => {
    const ctx = setup();
    const t = ctx.now();
    ctx.fx.addSession({ id: S1, directory: '/p/a', updated: t });
    const m = ctx.fx.addMessage({ session: S1, role: 'assistant', created: t - 100 });
    await ctx.source.start();
    expect(ctx.agent(S1)?.status).toBe('working');
    ctx.fx.db.prepare("UPDATE message SET data = json_set(data, '$.time.completed', ?) WHERE id = ?").run(t, m);
    expect(ctx.poll().agents.find((a) => a.id === key(S1))?.status).toBe('idle');
    ctx.fx.addMessage({ session: S1, role: 'assistant', created: t + 10 });
    expect(ctx.poll().agents.find((a) => a.id === key(S1))?.status).toBe('working');
  });

  it('OC-04: a atividade vem do nome da ferramenta e do state.title, com o rótulo do Claude Code', async () => {
    const ctx = setup();
    const t = ctx.now();
    ctx.fx.addSession({ id: S1, directory: '/p/a', updated: t });
    const m = ctx.fx.addMessage({ session: S1, role: 'assistant', created: t - 100 });
    ctx.fx.addPart({ message: m, session: S1, created: t - 50, data: toolPart('read', { title: 'src/app.ts' }) });
    await ctx.source.start();
    const a = ctx.agent(S1)!;
    expect(a.activity).toMatchObject({ kind: 'read', tool: 'Read', text: describeTool('Read', { file_path: 'src/app.ts' }).text });
    ctx.fx.addPart({ message: m, session: S1, created: t - 10, data: toolPart('bash', { title: 'npm test' }) });
    expect(ctx.poll().agents.find((x) => x.id === key(S1))?.activity?.tool).toBe('Bash');
  });

  it('parte sem state: working com atividade genérica', async () => {
    const ctx = setup();
    const t = ctx.now();
    ctx.fx.addSession({ id: S1, directory: '/p/a', updated: t });
    const m = ctx.fx.addMessage({ session: S1, role: 'assistant', created: t - 100 });
    ctx.fx.addPart({ message: m, session: S1, created: t - 50, data: toolPart('read', { withState: false }) });
    await ctx.source.start();
    expect(ctx.agent(S1)).toMatchObject({ status: 'working' });
    expect(ctx.agent(S1)?.activity).toMatchObject({ kind: 'other', text: 'Trabalhando' });
  });

  it('OC-05: sessão velha (>30 min) sai no ciclo seguinte e some depois do período de graça', async () => {
    const ctx = setup();
    const t = ctx.now();
    ctx.fx.addSession({ id: S1, directory: '/p/a', updated: t });
    await ctx.source.start();
    expect(ctx.agent(S1)?.status).toBe('idle');
    ctx.advance(PRESENCE_MS + 1_000);
    expect(ctx.poll().agents.find((a) => a.id === key(S1))?.status).toBe('offline');
    ctx.advance(OFFLINE_GRACE_MS + 1);
    expect(ctx.poll().agents).toHaveLength(0);
  });

  it('OC-05: time_archived preenchido remove o agente no ciclo seguinte', async () => {
    const ctx = setup();
    ctx.fx.addSession({ id: S1, directory: '/p/a', updated: ctx.now() });
    await ctx.source.start();
    expect(ctx.agents()).toHaveLength(1);
    ctx.fx.setSession(S1, { time_archived: ctx.now() });
    expect(ctx.poll().agents[0]?.status).toBe('offline');
    ctx.advance(OFFLINE_GRACE_MS + 1);
    expect(ctx.poll().agents).toHaveLength(0);
  });

  it('sessão apagada do banco também sai', async () => {
    const ctx = setup();
    ctx.fx.addSession({ id: S1, directory: '/p/a', updated: ctx.now() });
    await ctx.source.start();
    ctx.fx.deleteSession(S1);
    expect(ctx.poll().agents[0]?.status).toBe('offline');
  });

  it('subagente ocioso entrega; ao voltar a trabalhar, reativa', async () => {
    const ctx = setup();
    const t = ctx.now();
    ctx.fx.addSession({ id: S1, directory: '/p/a', updated: t });
    ctx.fx.addSession({ id: S2, parent: S1, directory: '/p/a', updated: t });
    ctx.fx.addMessage({ session: S2, role: 'assistant', created: t - 100 });
    await ctx.source.start();
    expect(ctx.agent(S2)?.status).toBe('working');
    ctx.fx.db.prepare("UPDATE message SET data = json_set(data, '$.time.completed', ?) WHERE session_id = ?").run(t, S2);
    expect(ctx.poll().agents.find((a) => a.id === key(S2))?.status).toBe('done');
    ctx.fx.addMessage({ session: S2, role: 'assistant', created: t + 100 });
    expect(ctx.poll().agents.find((a) => a.id === key(S2))?.status).toBe('working');
  });

  it('edge: directory vazio usa project.worktree; duas sessões no mesmo diretório dividem a sala', async () => {
    const ctx = setup();
    const t = ctx.now();
    const P = ocId('prj', 5);
    ctx.fx.addProject(P, '/projetos/worktree');
    ctx.fx.addSession({ id: S1, project: P, directory: '', updated: t });
    ctx.fx.addSession({ id: S2, project: P, directory: '/projetos/worktree', updated: t });
    await ctx.source.start();
    const [a, b] = [ctx.agent(S1)!, ctx.agent(S2)!];
    expect(a.roomId).toBe(b.roomId);
    expect(a.roomId).toContain('worktree');
  });

  it('sem directory nem worktree: não entra', async () => {
    const ctx = setup();
    ctx.fx.db.exec("INSERT INTO project (id, worktree, time_created, time_updated) VALUES ('prj_vazio', '', 1, 1)");
    ctx.fx.addSession({ id: S1, project: 'prj_vazio', directory: '', updated: ctx.now() });
    await ctx.source.start();
    expect(ctx.agents()).toHaveLength(0);
  });

  it('privacidade: nada do texto das mensagens ou das saídas chega ao snapshot', async () => {
    const ctx = setup();
    const t = ctx.now();
    ctx.fx.addSession({ id: S1, directory: '/p/a', updated: t });
    const m = ctx.fx.addMessage({ session: S1, role: 'assistant', created: t - 100, text: 'SEGREDO-123' });
    ctx.fx.addPart({ message: m, session: S1, created: t - 50, data: toolPart('bash', { title: 'ls', output: 'SEGREDO-123' }) });
    await ctx.source.start();
    expect(JSON.stringify(ctx.office.commit().snapshot)).not.toContain('SEGREDO-123');
  });

  it('OC-09: banco que passa a falhar mantém o último estado e não derruba o ciclo', async () => {
    const ctx = setup();
    ctx.fx.addSession({ id: S1, directory: '/p/a', updated: ctx.now() });
    await ctx.source.start();
    expect(ctx.agents()).toHaveLength(1);
    // fecha a conexão de leitura da própria fonte: as consultas passam a falhar e o último estado vale
    (ctx.source as unknown as { db: { raw: { close(): void } } }).db.raw.close();
    expect(() => ctx.poll()).not.toThrow();
    expect(ctx.agent(S1)?.status).toBe('idle');
  });

  it('OC-09: data malformado numa mensagem nova não muda o estado conhecido', async () => {
    const ctx = setup();
    const t = ctx.now();
    ctx.fx.addSession({ id: S1, directory: '/p/a', updated: t });
    ctx.fx.addMessage({ session: S1, role: 'assistant', created: t - 100, completed: t - 50 });
    await ctx.source.start();
    ctx.fx.addMessage({ session: S1, role: 'assistant', created: t, rawData: '{quebrado' });
    expect(ctx.poll().agents.find((a) => a.id === key(S1))?.status).toBe('idle');
  });

  it('stop() limpa o timer e o watcher', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'setTimeout', 'clearInterval', 'clearTimeout'] });
    const ctx = setup({ watch: true });
    ctx.fx.addSession({ id: S1, directory: '/p/a', updated: ctx.now() });
    await ctx.source.start();
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    ctx.fx.addSession({ id: S2, directory: '/p/b', updated: ctx.now() }); // mexe no WAL: pode agendar um empurrão
    ctx.source.stop();
    expect(vi.getTimerCount()).toBe(0);
    expect(ctx.source.sources()).toEqual([]);
  });
});

describe.skipIf(!HAS_SQLITE)('fonte do OpenCode: banco ausente ou sem node:sqlite', () => {
  it('OC-08: sem opencode.db não registra nada e não loga', async () => {
    setQuiet(false);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    const ctx = setup({ noDb: true });
    await ctx.source.start();
    expect(ctx.source.sources()).toEqual([]);
    expect(ctx.accounts.find('opencode')).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
    expect(err).not.toHaveBeenCalled();
    expect(out).not.toHaveBeenCalled();
  });

  it('OC-07: node:sqlite indisponível loga UMA linha com Node 22.13 e fica desligada', async () => {
    setQuiet(false);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ctx = setup({
      importer: async () => {
        throw new Error('sem sqlite');
      },
    });
    await ctx.source.start();
    ctx.source.poll();
    ctx.source.poll();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('22.13');
    expect(ctx.source.sources()).toEqual([]);
    expect(ctx.agents()).toHaveLength(0);
  });
});
