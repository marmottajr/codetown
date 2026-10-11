import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { tempDir } from '../../test/fixtures';
import { buildOpencodeDb, HAS_SQLITE, ocId, toolPart, type OcFixture } from '../../test/opencode-fixtures';
import { lastMessage, lastPart, listSessions, openDb, todos, type OcDb } from './files';

const SENTINEL = 'SEGREDO-NAO-PODE-VAZAR';
const NOW = 1_800_000_000_000;

describe('openDb sem banco ou sem node:sqlite', () => {
  it('OC-08: sem opencode.db devolve missing, sem chamar o import nem o onError', async () => {
    const t = tempDir();
    try {
      const importer = vi.fn(async () => {
        throw new Error('não deveria importar');
      });
      const onError = vi.fn();
      expect(await openDb(t.dir, { importer, onError })).toBe('missing');
      expect(importer).not.toHaveBeenCalled();
      expect(onError).not.toHaveBeenCalled();
    } finally {
      t.cleanup();
    }
  });

  it.skipIf(!HAS_SQLITE)('OC-07: import de node:sqlite falhando devolve unsupported', async () => {
    const fx = buildOpencodeDb();
    try {
      const r = await openDb(fx.dir, {
        importer: async () => {
          throw new Error('ERR_UNKNOWN_BUILTIN_MODULE');
        },
      });
      expect(r).toBe('unsupported');
    } finally {
      fx.cleanup();
    }
  });
});

describe.skipIf(!HAS_SQLITE)('leitor do opencode.db', () => {
  let fx: OcFixture;
  let db: OcDb | undefined;
  const open = async (onError?: (e: unknown) => void): Promise<OcDb> => {
    const r = await openDb(fx.dir, { onError });
    if (typeof r === 'string') throw new Error(`openDb: ${r}`);
    db = r;
    return r;
  };
  const setup = () => {
    fx = buildOpencodeDb();
  };
  afterEach(() => {
    db?.close();
    db = undefined;
    fx?.cleanup();
  });

  it('OC-06: abre somente leitura (escrever falha)', async () => {
    setup();
    const d = await open();
    expect(() => d.raw.exec("INSERT INTO todo VALUES ('x','y','z','w',0)")).toThrow();
  });

  it('OC-01/OC-05: lista só sessões não arquivadas e recentes, com room e parent', async () => {
    setup();
    const parent = fx.addSession({ updated: NOW, directory: '/p/a' });
    const child = fx.addSession({ updated: NOW - 1000, parent, directory: '/p/a' });
    fx.addSession({ updated: NOW - 10_000_000, directory: '/p/velha' });
    fx.addSession({ updated: NOW, archived: NOW, directory: '/p/arquivada' });
    const rows = listSessions(await open(), NOW - 1_800_000);
    expect(rows.map((r) => r.id)).toEqual([parent, child]);
    expect(rows[1].parentId).toBe(parent);
    expect(rows[0].parentId).toBeNull();
    expect(rows[0].directory).toBe('/p/a');
  });

  it('edge: directory vazio traz project.worktree para o fallback', async () => {
    setup();
    fx.addProject(ocId('prj', 9), '/p/worktree');
    fx.addSession({ project: ocId('prj', 9), directory: '', updated: NOW });
    const [s] = listSessions(await open(), 0);
    expect(s.directory).toBe('');
    expect(s.worktree).toBe('/p/worktree');
  });

  it('OC-03: última mensagem do assistente com e sem time.completed', async () => {
    setup();
    const s = fx.addSession({ updated: NOW });
    fx.addMessage({ session: s, role: 'assistant', created: 100, completed: 150 });
    fx.addMessage({ session: s, role: 'user', created: 200 });
    fx.addMessage({ session: s, role: 'assistant', created: 300 });
    const d = await open();
    expect(lastMessage(d, s, 'assistant')).toEqual({ role: 'assistant', created: 300 });
    expect(lastMessage(d, s)).toEqual({ role: 'assistant', created: 300 });
    expect(lastMessage(d, s, 'user')).toEqual({ role: 'user', created: 200 });
    expect(lastMessage(d, ocId('ses', 77))).toBeUndefined();
  });

  it('OC-04: última parte tool traz tool, status e state.title; sem state vale hasState false', async () => {
    setup();
    const s = fx.addSession({ updated: NOW });
    const m = fx.addMessage({ session: s, role: 'assistant' });
    fx.addPart({ message: m, session: s, created: 10, data: { type: 'text', text: 'oi' } });
    fx.addPart({ message: m, session: s, created: 20, data: toolPart('bash', { status: 'running', title: 'npm test' }) });
    const d = await open();
    expect(lastPart(d, s)).toEqual({ type: 'tool', tool: 'bash', status: 'running', title: 'npm test', hasState: true, created: 20 });
    fx.addPart({ message: m, session: s, created: 30, data: toolPart('read', { withState: false }) });
    expect(lastPart(d, s)).toEqual({ type: 'tool', tool: 'read', hasState: false, created: 30 });
  });

  it('todos na ordem de position', async () => {
    setup();
    const s = fx.addSession({ updated: NOW });
    fx.addTodo(s, 'segundo', 'pending', 2);
    fx.addTodo(s, 'primeiro', 'completed', 1);
    expect(todos(await open(), s).map((t) => t.content)).toEqual(['primeiro', 'segundo']);
  });

  it('privacidade: texto, saída e raciocínio nunca aparecem nos resultados', async () => {
    setup();
    const s = fx.addSession({ updated: NOW, title: 'titulo' });
    const m = fx.addMessage({ session: s, role: 'assistant', text: SENTINEL });
    fx.addPart({ message: m, session: s, created: 1, data: { type: 'text', text: SENTINEL } });
    fx.addPart({ message: m, session: s, created: 2, data: { type: 'reasoning', text: SENTINEL } });
    const d = await open();
    expect(lastPart(d, s)).toEqual({ type: 'reasoning', hasState: false, created: 2 });
    fx.addPart({ message: m, session: s, created: 3, data: toolPart('bash', { title: 'ls', output: SENTINEL }) });
    const all = JSON.stringify([listSessions(d, 0), lastMessage(d, s), lastPart(d, s), todos(d, s)]);
    expect(all).not.toContain(SENTINEL);
    fx.db.exec(`INSERT INTO account VALUES ('a', '${SENTINEL}')`);
    expect(JSON.stringify(listSessions(d, 0))).not.toContain(SENTINEL);
  });

  it('privacidade: files.ts só consulta as 5 tabelas permitidas', () => {
    const src = readFileSync(join(fileURLToPath(new URL('.', import.meta.url)), 'files.ts'), 'utf8');
    const sql = src.split('\n').filter((l) => !l.trimStart().startsWith('//')).join('\n');
    const used = [...sql.matchAll(/\b(?:FROM|JOIN)\s+([a-z_]+)/g)].map((m) => m[1]);
    expect(used.length).toBeGreaterThan(0);
    for (const t of used) expect(['project', 'session', 'message', 'part', 'todo']).toContain(t);
    expect(sql).not.toMatch(/auth\.json|opencode\.jsonc|tool-output|\baccount\b|\bevent\b/);
  });

  it('OC-09: data malformado é pulado e vale a última linha válida', async () => {
    setup();
    const s = fx.addSession({ updated: NOW });
    const m = fx.addMessage({ session: s, role: 'assistant', created: 100, completed: 120 });
    fx.addPart({ message: m, session: s, created: 10, data: toolPart('grep', { title: 'x' }) });
    fx.addMessage({ session: s, role: 'assistant', created: 200, rawData: '{nao é json' });
    fx.addPart({ message: m, session: s, created: 20, rawData: '{quebrado' });
    const d = await open();
    expect(lastMessage(d, s)).toEqual({ role: 'assistant', created: 100, completed: 120 });
    expect(lastPart(d, s)?.tool).toBe('grep');
  });

  it('OC-09: leitura que falha (banco ocupado/fechado) devolve o último resultado e avisa onError', async () => {
    setup();
    const s = fx.addSession({ updated: NOW });
    fx.addMessage({ session: s, role: 'assistant', created: 5 });
    const onError = vi.fn();
    const d = await open(onError);
    const before = listSessions(d, 0);
    const msg = lastMessage(d, s);
    expect(before).toHaveLength(1);
    d.raw.close();
    expect(listSessions(d, 0)).toEqual(before);
    expect(lastMessage(d, s)).toEqual(msg);
    expect(onError).toHaveBeenCalled();
  });
});
