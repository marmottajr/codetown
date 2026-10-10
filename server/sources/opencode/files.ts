// Leitor SOMENTE LEITURA do banco do OpenCode (<dados>/opencode.db, SQLite em modo WAL), validado na versão 1.18.35.
// Diferente do Codex (que tem rollouts em texto e por isso NUNCA abre SQLite), o OpenCode só guarda as sessões aqui.
// Por isso este é o único arquivo do Habblaud que abre um SQLite, e só estas tabelas são lidas:
//   project, session, message, part, todo.
// (`usageTotals` lê só `message`, e dela só json_extract de role, time.created, cost e tokens: o uso local do cartão.)
// Nunca são lidas: account, event, auth.json, opencode.jsonc, log/ e tool-output/. As consultas pedem colunas nomeadas e
// extraem do JSON `data` só o que a fonte usa (papel, tempos, tipo da parte, nome da ferramenta e `state.title`) com
// json_extract no próprio SQLite, então o texto das mensagens, o `output` das ferramentas e o raciocínio NUNCA chegam
// a este processo. Única exceção: `pendingQuestion` lê `$.state.input.questions` das partes da ferramenta `question`
// (o prompt que ela mostra ao usuário; nada mais de `state.input`). `node:sqlite` é carregado por import dinâmico: no Node 22.12 (sem a API sem flag) a fonte só fica
// desligada ('unsupported'), o resto do Habblaud segue.
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export const DB_FILE = 'opencode.db';

type SqliteModule = typeof import('node:sqlite');
type RawDb = InstanceType<SqliteModule['DatabaseSync']>;

/** Banco aberto. `cache` guarda o último resultado de cada consulta (usado quando uma leitura falha). */
export interface OcDb {
  raw: RawDb;
  cache: Map<string, unknown>;
  onError?: (error: unknown) => void;
  close(): void;
}

export interface OpenOptions {
  /** Troca do `import('node:sqlite')` (testes: simula o Node sem a API). */
  importer?: () => Promise<SqliteModule>;
  /** Chamado com o erro de uma leitura que falhou (SQLITE_BUSY, esquema novo...). A leitura devolve o último valor bom. */
  onError?: (error: unknown) => void;
}

/**
 * Abre o banco só para leitura. 'missing' = não há opencode.db (ou não abriu); 'unsupported' = `node:sqlite` não existe
 * neste Node (precisa de 22.13 ou mais). O arquivo é checado ANTES do import: sem banco não há nada a dizer.
 */
export async function openDb(dir: string, opts: OpenOptions = {}): Promise<OcDb | 'unsupported' | 'missing'> {
  const path = join(dir, DB_FILE);
  if (!existsSync(path)) return 'missing';
  let mod: SqliteModule;
  try {
    mod = await (opts.importer ?? (() => import('node:sqlite')))();
  } catch {
    return 'unsupported';
  }
  try {
    const raw = new mod.DatabaseSync(path, { readOnly: true });
    return {
      raw,
      cache: new Map(),
      onError: opts.onError,
      close: () => {
        try {
          raw.close();
        } catch {
          // já fechado
        }
      },
    };
  } catch (e) {
    opts.onError?.(e);
    return 'missing';
  }
}

/** Roda a consulta; se falhar (banco ocupado, esquema diferente...) avisa `onError` e devolve o último resultado bom. */
function read<T>(db: OcDb, key: string, fallback: T, run: () => T): T {
  try {
    const value = run();
    db.cache.set(key, value);
    return value;
  } catch (e) {
    db.onError?.(e);
    return db.cache.has(key) ? (db.cache.get(key) as T) : fallback;
  }
}

/**
 * Roda `fn` (as consultas de UM ciclo de leitura) numa única transação de leitura: no modo WAL o ciclo inteiro enxerga o
 * mesmo instantâneo, então uma gravação do OpenCode entre duas consultas só aparece no ciclo seguinte. Termina sempre
 * com COMMIT (ROLLBACK se o COMMIT falhar). Se o BEGIN falhar (já dentro de uma transação, banco fechado...), segue sem
 * transação, como antes, com as mesmas regras de cache de `read`.
 */
export function inSnapshot<T>(db: OcDb, fn: () => T): T {
  let begun = false;
  try {
    db.raw.exec('BEGIN');
    begun = true;
  } catch {
    // sem instantâneo: cada consulta lê o que houver
  }
  try {
    return fn();
  } finally {
    if (begun) {
      try {
        db.raw.exec('COMMIT');
      } catch {
        try {
          db.raw.exec('ROLLBACK');
        } catch {
          // transação já encerrada
        }
      }
    }
  }
}

export interface OcSession {
  id: string;
  projectId: string;
  parentId: string | null;
  directory: string;
  /** `project.worktree` (sala quando `directory` vem vazio). */
  worktree: string | null;
  title: string;
  timeUpdated: number;
}

/** Sessões não arquivadas atualizadas em `sinceMs` (epoch ms) ou depois. */
export function listSessions(db: OcDb, sinceMs: number): OcSession[] {
  return read<OcSession[]>(db, 'sessions', [], () => {
    const rows = db.raw
      .prepare(
        `SELECT s.id AS id, s.project_id AS project_id, s.parent_id AS parent_id, s.directory AS directory,
                p.worktree AS worktree, s.title AS title, s.time_updated AS time_updated
           FROM session s LEFT JOIN project p ON p.id = s.project_id
          WHERE s.time_archived IS NULL AND s.time_updated >= ?
          ORDER BY s.time_updated DESC, s.id`,
      )
      .all(sinceMs) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: String(r.id),
      projectId: String(r.project_id ?? ''),
      parentId: typeof r.parent_id === 'string' && r.parent_id ? r.parent_id : null,
      directory: typeof r.directory === 'string' ? r.directory : '',
      worktree: typeof r.worktree === 'string' ? r.worktree : null,
      title: typeof r.title === 'string' ? r.title : '',
      timeUpdated: Number(r.time_updated),
    }));
  });
}

export interface OcMessage {
  role: string;
  created: number;
  /** `time.completed` (epoch ms); ausente = o turno ainda roda. */
  completed?: number;
}

/**
 * Última mensagem da sessão (pelo `time_created`), opcionalmente só de um papel. Linhas com `data` que não é JSON
 * válido são puladas (valem as anteriores). undefined = nenhuma.
 */
export function lastMessage(db: OcDb, sessionId: string, role?: 'user' | 'assistant'): OcMessage | undefined {
  return read<OcMessage | undefined>(db, `message:${sessionId}:${role ?? ''}`, undefined, () => {
    const row = db.raw
      .prepare(
        `SELECT json_extract(data, '$.role') AS role, json_extract(data, '$.time.created') AS created,
                json_extract(data, '$.time.completed') AS completed
           FROM message
          WHERE session_id = ? AND json_valid(data) AND (? IS NULL OR json_extract(data, '$.role') = ?)
          ORDER BY time_created DESC, id DESC LIMIT 1`,
      )
      .get(sessionId, role ?? null, role ?? null) as Record<string, unknown> | undefined;
    if (!row || typeof row.role !== 'string') return undefined;
    const created = typeof row.created === 'number' ? row.created : 0;
    return typeof row.completed === 'number' ? { role: row.role, created, completed: row.completed } : { role: row.role, created };
  });
}

export interface OcPart {
  /** text | reasoning | tool | step-start | step-finish | agent | ... */
  type: string;
  /** Só nas partes `tool`. */
  tool?: string;
  /** `state.status` (pending | running | completed | error), quando há `state`. */
  status?: string;
  /** `state.title` (rótulo curto da ferramenta). */
  title?: string;
  /** A parte tem `state`? */
  hasState: boolean;
  created: number;
}

/** Última parte da sessão (pelo `time_created`), sem nunca trazer o conteúdo (texto, saída, raciocínio). */
export function lastPart(db: OcDb, sessionId: string): OcPart | undefined {
  return read<OcPart | undefined>(db, `part:${sessionId}`, undefined, () => {
    const row = db.raw
      .prepare(
        `SELECT json_extract(data, '$.type') AS type, json_extract(data, '$.tool') AS tool,
                json_extract(data, '$.state.status') AS status, json_extract(data, '$.state.title') AS title,
                json_type(data, '$.state') AS state_type, time_created AS created
           FROM part
          WHERE session_id = ? AND json_valid(data)
          ORDER BY time_created DESC, id DESC LIMIT 1`,
      )
      .get(sessionId) as Record<string, unknown> | undefined;
    if (!row || typeof row.type !== 'string') return undefined;
    const part: OcPart = { type: row.type, hasState: row.state_type === 'object', created: Number(row.created) };
    if (typeof row.tool === 'string') part.tool = row.tool;
    if (typeof row.status === 'string') part.status = row.status;
    if (typeof row.title === 'string') part.title = row.title;
    return part;
  });
}

/**
 * Perguntas pendentes da ferramenta `question`: o array `state.input.questions` da ÚLTIMA parte `question` da sessão, se
 * ela ainda está `running`. É o único trecho de `state.input` que este leitor toca (o prompt da própria ferramenta,
 * mascarado depois por `askQuestions`); nada de outras chaves de `input`, do `output` nem do texto das mensagens.
 * undefined = nenhuma pendente, JSON ruim ou `questions` que não é lista.
 */
export function pendingQuestion(db: OcDb, sessionId: string): unknown[] | undefined {
  return read<unknown[] | undefined>(db, `question:${sessionId}`, undefined, () => {
    const row = db.raw
      .prepare(
        `SELECT CASE WHEN json_extract(data, '$.state.status') = 'running' THEN json_extract(data, '$.state.input.questions') END AS questions
           FROM part
          WHERE session_id = ? AND json_valid(data) AND json_extract(data, '$.tool') = 'question'
          ORDER BY time_created DESC, id DESC LIMIT 1`,
      )
      .get(sessionId) as Record<string, unknown> | undefined;
    if (!row || typeof row.questions !== 'string' || row.questions.length > MAX_QUESTIONS_JSON) return undefined;
    try {
      const parsed: unknown = JSON.parse(row.questions);
      return Array.isArray(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  });
}

/** Perguntas maiores que isto (em JSON) são ignoradas: o escritório só mostra prévias. */
const MAX_QUESTIONS_JSON = 200_000;

export interface OcTodo {
  content: string;
  status: string;
  position: number;
}

/** Tarefas (todo) da sessão, na ordem de `position`. */
export function todos(db: OcDb, sessionId: string): OcTodo[] {
  return read<OcTodo[]>(db, `todo:${sessionId}`, [], () => {
    const rows = db.raw
      .prepare('SELECT content, status, position FROM todo WHERE session_id = ? ORDER BY position, rowid')
      .all(sessionId) as Record<string, unknown>[];
    return rows.map((r) => ({ content: String(r.content ?? ''), status: String(r.status ?? ''), position: Number(r.position ?? 0) }));
  });
}

/** Janela do uso local mostrado no cartão: os últimos 7 dias. */
export const USAGE_WINDOW_MS = 7 * 86_400_000;

/** Custo e tokens das respostas do assistente numa janela (o que o `opencode stats` soma). `at` = quando a leitura foi feita. */
export interface OcUsage {
  costUsd: number;
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  /** Respostas do assistente dentro da janela. */
  responses: number;
  at: number;
}

/**
 * Soma, das respostas do assistente com `time.created` (epoch ms) de `sinceMs` em diante, o custo e os tokens. Só
 * json_extract de role, time.created, cost e tokens: nada de texto, raciocínio nem saída de ferramenta. Se a leitura
 * falha, devolve o último valor bom (com o `at` dele); undefined = nunca leu com sucesso.
 */
export function usageTotals(db: OcDb, sinceMs: number, at: number): OcUsage | undefined {
  return read<OcUsage | undefined>(db, 'usage', undefined, () => {
    const row = db.raw
      .prepare(
        `SELECT COALESCE(SUM(json_extract(data, '$.cost')), 0) AS cost,
                COALESCE(SUM(json_extract(data, '$.tokens.input')), 0) AS input,
                COALESCE(SUM(json_extract(data, '$.tokens.output')), 0) AS output,
                COALESCE(SUM(json_extract(data, '$.tokens.reasoning')), 0) AS reasoning,
                COALESCE(SUM(json_extract(data, '$.tokens.cache.read')), 0) AS cache_read,
                COALESCE(SUM(json_extract(data, '$.tokens.cache.write')), 0) AS cache_write,
                COUNT(*) AS responses
           FROM message
          WHERE json_valid(data) AND json_extract(data, '$.role') = 'assistant' AND json_extract(data, '$.time.created') >= ?`,
      )
      .get(sinceMs) as Record<string, unknown>;
    return {
      costUsd: Number(row.cost),
      input: Number(row.input),
      output: Number(row.output),
      reasoning: Number(row.reasoning),
      cacheRead: Number(row.cache_read),
      cacheWrite: Number(row.cache_write),
      responses: Number(row.responses),
      at,
    };
  });
}
