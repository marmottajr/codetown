// Banco SQLITE SINTÉTICO do OpenCode (subconjunto do esquema da 1.18.35: project, session, message, part, todo), num
// diretório temporário, para os testes da fonte do OpenCode. Nada aqui vem de conversas reais; nunca abre o banco de
// verdade do usuário. Usa `node:sqlite` (estável sem flag desde o Node 22.13); no Node 22.12 `HAS_SQLITE` é false e os
// testes que dependem dele se pulam (`describe.skipIf(!HAS_SQLITE)`).
import { join } from 'node:path';
import { tempDir } from './fixtures';

type SqliteModule = typeof import('node:sqlite');
type Db = InstanceType<SqliteModule['DatabaseSync']>;

let sqlite: SqliteModule | undefined;
try {
  sqlite = await import('node:sqlite');
} catch {
  sqlite = undefined;
}

/** `node:sqlite` disponível neste Node? (false no 22.12 sem flag.) */
export const HAS_SQLITE = sqlite !== undefined;

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** Id no formato do OpenCode: prefixo ("ses_", "msg_", "prt_", "prj_") + 26 caracteres, determinístico por `n`. */
export function ocId(prefix: 'ses' | 'msg' | 'prt' | 'prj', n: number): string {
  let rest = '';
  let x = n + 1;
  while (rest.length < 26) {
    rest += ALPHABET[x % ALPHABET.length];
    x = Math.floor(x / 3) + 7 * (rest.length + 1);
  }
  return `${prefix}_${rest.slice(0, 26)}`;
}

const SCHEMA = `
CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT NOT NULL, vcs TEXT, name TEXT, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL);
CREATE TABLE session (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, workspace_id TEXT, parent_id TEXT, slug TEXT NOT NULL DEFAULT '',
  directory TEXT NOT NULL, path TEXT, title TEXT NOT NULL DEFAULT '', version TEXT NOT NULL DEFAULT '1.18.35',
  cost REAL NOT NULL DEFAULT 0, tokens_input INTEGER NOT NULL DEFAULT 0, tokens_output INTEGER NOT NULL DEFAULT 0,
  agent TEXT, model TEXT, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, time_archived INTEGER
);
CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
CREATE TABLE todo (session_id TEXT NOT NULL, content TEXT NOT NULL, status TEXT NOT NULL, priority TEXT NOT NULL, position INTEGER NOT NULL);
-- tabelas que a fonte NUNCA pode ler (existem só para provar isso nos testes)
CREATE TABLE account (id TEXT PRIMARY KEY, email TEXT);
CREATE TABLE event (id TEXT PRIMARY KEY, data TEXT);
`;

export interface OcSessionOpts {
  id?: string;
  project?: string;
  parent?: string | null;
  directory?: string;
  title?: string;
  /** epoch ms; padrão: agora. */
  updated?: number;
  created?: number;
  archived?: number | null;
}

export interface OcMessageOpts {
  id?: string;
  session: string;
  role: 'user' | 'assistant';
  created?: number;
  /** epoch ms de `time.completed`; ausente = turno em andamento. */
  completed?: number;
  /** Texto sintético que a fonte jamais deve devolver. */
  text?: string;
  /** JSON cru no lugar do gerado (para testar `data` malformado). */
  rawData?: string;
}

export interface OcPartOpts {
  id?: string;
  message: string;
  session: string;
  created?: number;
  /** `data` completo; padrão: parte de texto. */
  data?: Record<string, unknown>;
  rawData?: string;
}

export interface OcFixture {
  dir: string;
  dbPath: string;
  /** Conexão de escrita do teste (modo WAL, como o OpenCode). */
  db: Db;
  addProject(id: string, worktree: string): void;
  addSession(o?: OcSessionOpts): string;
  addMessage(o: OcMessageOpts): string;
  addPart(o: OcPartOpts): string;
  addTodo(session: string, content: string, status: string, position?: number): void;
  setSession(id: string, fields: { time_updated?: number; time_archived?: number | null; directory?: string; parent_id?: string | null }): void;
  deleteSession(id: string): void;
  close(): void;
  cleanup(): void;
}

/** Parte `tool` como o OpenCode grava (só o que a fonte lê, mais conteúdo sintético que ela não pode devolver). */
export function toolPart(tool: string, o: { status?: string; title?: string; output?: string; withState?: boolean } = {}): Record<string, unknown> {
  const part: Record<string, unknown> = { type: 'tool', tool, callID: 'call_sintetico' };
  if (o.withState !== false) part.state = { status: o.status ?? 'running', input: { sintetico: true }, title: o.title, output: o.output, time: { start: 1 } };
  return part;
}

/**
 * Cria o banco sintético (vazio) em um diretório temporário e devolve os construtores de linhas.
 * Lança se `node:sqlite` não existir: guarde o uso com `describe.skipIf(!HAS_SQLITE)`.
 */
export function buildOpencodeDb(opts: { dir?: string } = {}): OcFixture {
  if (!sqlite) throw new Error('node:sqlite indisponível neste Node (precisa de >= 22.13)');
  const tmp = opts.dir ? undefined : tempDir('habblaud-oc-');
  const dir = opts.dir ?? tmp!.dir;
  const dbPath = join(dir, 'opencode.db');
  const db = new sqlite.DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(SCHEMA);
  let seq = 1000;
  const now = () => Date.now();
  const f: OcFixture = {
    dir,
    dbPath,
    db,
    addProject(id, worktree) {
      db.prepare('INSERT OR REPLACE INTO project (id, worktree, vcs, name, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?)').run(id, worktree, 'git', 'sintetico', now(), now());
    },
    addSession(o = {}) {
      const id = o.id ?? ocId('ses', seq++);
      const project = o.project ?? ocId('prj', 1);
      const exists = db.prepare('SELECT 1 FROM project WHERE id = ?').get(project);
      if (!exists) f.addProject(project, o.directory ?? '/projetos/loja');
      const updated = o.updated ?? now();
      db.prepare(
        'INSERT INTO session (id, project_id, parent_id, slug, directory, title, time_created, time_updated, time_archived) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).run(id, project, o.parent ?? null, 'sintetica', o.directory ?? '/projetos/loja', o.title ?? 'Sessão sintética', o.created ?? updated, updated, o.archived ?? null);
      return id;
    },
    addMessage(o) {
      const id = o.id ?? ocId('msg', seq++);
      const created = o.created ?? now();
      const data =
        o.rawData ??
        JSON.stringify({
          role: o.role,
          time: o.completed === undefined ? { created } : { created, completed: o.completed },
          ...(o.role === 'assistant' ? { modelID: 'modelo-sintetico', providerID: 'prov-sintetico' } : {}),
          path: { cwd: '/projetos/loja', root: '/projetos/loja' },
          ...(o.text ? { summary: { body: o.text } } : {}),
        });
      db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)').run(id, o.session, created, created, data);
      return id;
    },
    addPart(o) {
      const id = o.id ?? ocId('prt', seq++);
      const created = o.created ?? now();
      const data = o.rawData ?? JSON.stringify(o.data ?? { type: 'text', text: 'texto sintético' });
      db.prepare('INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)').run(id, o.message, o.session, created, created, data);
      return id;
    },
    addTodo(session, content, status, position = 0) {
      db.prepare('INSERT INTO todo (session_id, content, status, priority, position) VALUES (?, ?, ?, ?, ?)').run(session, content, status, 'medium', position);
    },
    setSession(id, fields) {
      for (const [k, v] of Object.entries(fields)) {
        if (!['time_updated', 'time_archived', 'directory', 'parent_id'].includes(k)) continue;
        db.prepare(`UPDATE session SET ${k} = ? WHERE id = ?`).run(v as string | number | null, id);
      }
    },
    deleteSession(id) {
      db.prepare('DELETE FROM session WHERE id = ?').run(id);
    },
    close() {
      try {
        db.close();
      } catch {
        // já fechado
      }
    },
    cleanup() {
      f.close();
      tmp?.cleanup();
    },
  };
  return f;
}
