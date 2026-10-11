import { afterEach, describe, expect, it } from 'vitest';
import { buildOpencodeDb, HAS_SQLITE, ocId, toolPart, type OcFixture } from './opencode-fixtures';

// OC-06: o banco sintético tem as tabelas lidas pela fonte e abre somente leitura.
describe('ocId', () => {
  it('segue o formato do OpenCode (prefixo + 26 caracteres) e é único por número', () => {
    for (const p of ['ses', 'msg', 'prt', 'prj'] as const) {
      expect(ocId(p, 3)).toMatch(new RegExp(`^${p}_[A-Za-z0-9]{26}$`));
    }
    expect(ocId('ses', 1)).not.toBe(ocId('ses', 2));
    expect(ocId('ses', 1)).toBe(ocId('ses', 1));
  });
});

describe.skipIf(!HAS_SQLITE)('buildOpencodeDb', () => {
  let fx: OcFixture | undefined;
  afterEach(() => fx?.cleanup());

  it('cria as tabelas do subconjunto do esquema 1.18.35', () => {
    fx = buildOpencodeDb();
    const names = (fx.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map((r) => r.name);
    for (const t of ['project', 'session', 'message', 'part', 'todo']) expect(names).toContain(t);
  });

  it('monta sessão, filha, mensagens (com e sem completed) e partes de ferramenta', () => {
    fx = buildOpencodeDb();
    const parent = fx.addSession({ directory: '/projetos/loja' });
    const child = fx.addSession({ parent, directory: '/projetos/loja' });
    const done = fx.addMessage({ session: parent, role: 'assistant', completed: Date.now() });
    const running = fx.addMessage({ session: child, role: 'assistant' });
    fx.addMessage({ session: parent, role: 'user' });
    fx.addPart({ message: running, session: child, data: toolPart('bash', { title: 'ls' }) });
    fx.addTodo(parent, 'fazer', 'pending');
    const msgs = fx.db.prepare('SELECT id, data FROM message').all() as { id: string; data: string }[];
    expect(msgs).toHaveLength(3);
    expect(JSON.parse(msgs.find((m) => m.id === done)!.data).time.completed).toBeTypeOf('number');
    expect(JSON.parse(msgs.find((m) => m.id === running)!.data).time.completed).toBeUndefined();
    expect(fx.db.prepare('SELECT parent_id FROM session WHERE id = ?').get(child)).toEqual({ parent_id: parent });
    expect(JSON.parse((fx.db.prepare('SELECT data FROM part').get() as { data: string }).data)).toMatchObject({ type: 'tool', tool: 'bash', state: { title: 'ls' } });
    expect(parent).toMatch(/^ses_[A-Za-z0-9]{26}$/);
  });

  it('o banco abre somente leitura (e escrever falha)', async () => {
    fx = buildOpencodeDb();
    fx.addSession();
    const { DatabaseSync } = await import('node:sqlite');
    const ro = new DatabaseSync(fx.dbPath, { readOnly: true });
    try {
      expect((ro.prepare('SELECT count(*) AS n FROM session').get() as { n: number }).n).toBe(1);
      expect(() => ro.exec("INSERT INTO todo VALUES ('x','y','z','w',0)")).toThrow();
    } finally {
      ro.close();
    }
  });
});
