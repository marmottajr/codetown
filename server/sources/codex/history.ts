// Histórico do terminal do Codex (o HistoryProvider 'codex', ver sources/source.ts): as conversas recentes de cada
// conta do Codex (abertas ou já encerradas), a partir dos rollouts em sessions/AAAA/MM/DD/ e archived_sessions/.
// Funil de cada conta, nesta ordem (o corte em `limit` vem por último, só sobre as conversas principais):
// 1. quais arquivos abrir: pasta do dia ou UUIDv7 do nome dentro da janela, tamanho diferente do da listagem anterior
//    (conversa antiga retomada), thread aberta no escritório, já lido antes ou, só como pista, o mtime (no Windows ele
//    às vezes fica parado). O mtime nunca decide quem entra: só faz abrir;
// 2. a 1ª linha (session_meta) classifica, com cache permanente: subagentes e threads internos (guardian, revisão...)
//    ficam de fora, como os subagentes do Claude Code;
// 3. do resto, a primeira instrução e a última atividade (`timestamp` das linhas do fim), com cache pelo TAMANHO;
// 4. entra quem teve atividade dentro da janela; de cada thread fica o rollout de atividade mais recente.
// Título: o nome da thread no session_index.jsonl (a última linha de cada id vence), senão a primeira instrução.
import { readdirSync, realpathSync, statSync } from 'node:fs';
import { open, readdir, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { maskSecrets, truncate } from '../../../shared/activity';
import type { RecentSession } from '../../../shared/types';
import { errMsg, log } from '../../log';
import { HISTORY_LIMIT, HISTORY_MAX_AGE_MS } from '../history';
import type { HistoryProvider, HistoryResolveResult } from '../source';
import { encodeCwd } from '../watcher';
import { compareRollouts, parseRolloutName, rolloutDirs } from './files';
import { createCodexState, isThreadId, metaFromLine, parseRolloutLine, type CodexState, type RolloutMeta } from './rollout';
import { createCodexTerminalParser } from './terminal';

/** Começo lido de cada rollout (o session_meta costuma caber; senão lê mais, até META_MAX). */
const HEAD_BYTES = 64 * 1024;
const META_MAX = 1024 * 1024;
/** Trecho depois do session_meta onde a primeira instrução é procurada. */
const PROMPT_BYTES = 128 * 1024;
const TAIL_BYTES = 64 * 1024;
const READ_CONCURRENCY = 8;
/** Nomes das threads: o Codex só acrescenta linhas (a última de cada id vence). Lido do fim, até INDEX_MAX. */
const SESSION_INDEX = 'session_index.jsonl';
const INDEX_MAX = 4 * 1024 * 1024;
const TITLE_MAX = 90;
/** Folga da janela pelo nome: a pasta do dia usa o fuso de quem gravou (e no Docker o servidor roda em UTC). */
const ZONE_SLACK_MS = 24 * 3600_000;
/** sessions/AAAA/MM/DD no fim do caminho de uma pasta de rollouts. */
const DAY_DIR = /(\d{4})[\\/](\d{2})[\\/](\d{2})$/;
const NO_NAMES: ReadonlyMap<string, string> = new Map();

export interface CodexHistoryAccount {
  id: string;
  /** Pasta do Codex lida por este processo (no Docker, a montada). */
  dir: string;
}

export interface CodexHistoryOptions {
  accounts: () => readonly CodexHistoryAccount[];
  /** Agente principal da sessão, se ela ainda estiver aberta no escritório. */
  openAgentOf: (account: string, sessionId: string) => string | undefined;
  now?: () => number;
  maxAgeMs?: number;
  limit?: number;
}

/** O que o começo e o fim do rollout dizem sobre a conversa. */
export interface RolloutSummary {
  meta?: RolloutMeta;
  title?: string;
  firstAt?: number;
  lastAt?: number;
}

/** 1ª linha do rollout, já completa. `end` = byte logo depois do seu \n; ausente = linha maior que META_MAX. */
interface RolloutHead {
  meta?: RolloutMeta;
  end?: number;
}

interface FileCache {
  /** Tamanho na listagem anterior: mudou = conversa retomada (mesmo com a pasta velha e o mtime parado). */
  size: number;
  /** Classificação pela 1ª linha: para sempre (o rollout só cresce), guardada só depois que a linha termina. */
  head?: RolloutHead;
  /** Resumo do resto, válido enquanto o tamanho for `size` (o mtime não invalida nada). */
  summary?: { size: number; value: RolloutSummary };
}

interface Candidate {
  account: string;
  threadId: string;
  path: string;
  dir: string;
  size: number;
  /** Agente principal aberto no escritório com esta thread. */
  agentId?: string;
  /** Criação da thread pelo UUIDv7 do nome (reserva do horário quando as linhas não têm `timestamp`). */
  bornAt?: number;
}

interface Row {
  c: Candidate;
  summary: RolloutSummary;
  lastAt: number;
}

export class CodexHistory implements HistoryProvider {
  readonly provider = 'codex' as const;
  private files = new Map<string, FileCache>();
  private indexes = new Map<string, { size: number; names: ReadonlyMap<string, string> }>();
  private readonly now: () => number;
  private readonly maxAgeMs: number;
  private readonly limit: number;

  constructor(private readonly opts: CodexHistoryOptions) {
    this.now = opts.now ?? Date.now;
    this.maxAgeMs = opts.maxAgeMs ?? HISTORY_MAX_AGE_MS;
    this.limit = opts.limit ?? HISTORY_LIMIT;
  }

  hasAccount(account: string): boolean {
    return this.opts.accounts().some((a) => a.id === account);
  }

  async list(): Promise<RecentSession[]> {
    const cutoff = this.now() - this.maxAgeMs;
    const accounts = this.opts.accounts();
    const seen = new Set<string>();
    const rows: Row[] = [];
    for (const acc of accounts) rows.push(...(await this.rowsOf(acc, cutoff, seen)));
    // Só sai do cache o arquivo que sumiu: a classificação dos subagentes fica (senão seria relida a cada listagem).
    for (const path of this.files.keys()) if (!seen.has(path)) this.files.delete(path);
    for (const dir of this.indexes.keys()) if (!accounts.some((a) => a.dir === dir)) this.indexes.delete(dir);
    const picked = rows.sort((a, b) => b.lastAt - a.lastAt).slice(0, this.limit);
    const names = new Map<string, ReadonlyMap<string, string>>();
    for (const r of picked) if (!names.has(r.c.dir)) names.set(r.c.dir, await this.titles(r.c.dir));
    return picked.map((r) => toSession(r, names.get(r.c.dir) ?? NO_NAMES));
  }

  /**
   * Rollout do thread `sessionId` da conta, validado: conta conhecida, id com formato de UUID e o arquivo (com links
   * resolvidos) dentro da pasta da conta. Um rollout só compactado (.jsonl.zst) ainda não dá para ler: 404.
   */
  resolve(account: string, sessionId: string): HistoryResolveResult {
    if (!isThreadId(sessionId)) return { status: 400, error: 'id de sessão inválido' };
    const acc = this.opts.accounts().find((a) => a.id === account);
    if (!acc) return { status: 404, error: 'conta desconhecida' };
    let root: string;
    try {
      root = realpathSync(acc.dir);
    } catch {
      return { status: 404, error: 'sessão não encontrada' };
    }
    const id = sessionId.toLowerCase();
    let best: { path: string; mtimeMs: number } | undefined;
    let compressed = false;
    for (const dir of rolloutDirs(acc.dir)) {
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch {
        continue;
      }
      for (const name of names) {
        const r = parseRolloutName(name);
        if (!r || r.threadId !== id) continue;
        if (r.compressed) {
          compressed = true;
          continue;
        }
        try {
          const real = realpathSync(join(dir, name));
          // Um link apontando para fora da pasta da conta não serve.
          if (!real.startsWith(root + sep)) continue;
          const st = statSync(real);
          if (!st.isFile()) continue;
          // Thread revertido (mais de um rollout): vale o de última linha mais recente; o mtime só desempata.
          const found = { path: real, mtimeMs: st.mtimeMs };
          if (!best || compareRollouts(found, best) > 0) best = found;
        } catch {
          // sumiu entre a listagem e a leitura
        }
      }
    }
    if (best) return { path: best.path, createParser: createCodexTerminalParser };
    return { status: 404, error: compressed ? 'sessão compactada pelo Codex (.zst): ainda não dá para ler' : 'sessão não encontrada' };
  }

  /** Conversas principais da conta com atividade na janela (uma por thread: a de atividade mais recente). */
  private async rowsOf(acc: CodexHistoryAccount, cutoff: number, seen: Set<string>): Promise<Row[]> {
    const candidates = await this.candidates(acc, cutoff, seen);
    const rows = await mapLimit(candidates, READ_CONCURRENCY, (c) => this.rowOf(c, cutoff));
    const best = new Map<string, Row>();
    for (const r of rows) {
      if (!r) continue;
      const prev = best.get(r.c.threadId);
      if (!prev || r.lastAt > prev.lastAt) best.set(r.c.threadId, r);
    }
    return [...best.values()];
  }

  /** Rollouts que vale abrir nesta listagem (passo 1 do funil); guarda o tamanho visto de todos. */
  private async candidates(acc: CodexHistoryAccount, cutoff: number, seen: Set<string>): Promise<Candidate[]> {
    const out: Candidate[] = [];
    for (const dir of rolloutDirs(acc.dir)) {
      let names: string[];
      try {
        names = await readdir(dir);
      } catch {
        continue;
      }
      const dayEnd = dayEndOf(dir);
      for (const name of names) {
        const r = parseRolloutName(name);
        if (!r || r.compressed) continue;
        const path = join(dir, name);
        try {
          const st = await stat(path);
          if (!st.isFile()) continue;
          seen.add(path);
          const changed = this.remember(path, st.size);
          const c: Candidate = { account: acc.id, threadId: r.threadId, path, dir: acc.dir, size: st.size };
          const agentId = this.opts.openAgentOf(acc.id, r.threadId);
          if (agentId) c.agentId = agentId;
          const bornAt = uuidV7Time(r.threadId);
          if (bornAt !== undefined) c.bornAt = bornAt;
          const byName = Math.max(bornAt ?? -Infinity, dayEnd ?? -Infinity) + ZONE_SLACK_MS >= cutoff;
          const known = this.files.get(path)?.summary !== undefined;
          // O mtime é só pista para abrir: quem decide se entra é o horário das linhas (rowOf).
          if (agentId || changed || known || byName || st.mtimeMs >= cutoff) out.push(c);
        } catch {
          // apagado no meio da listagem
        }
      }
    }
    return out;
  }

  /** Guarda o tamanho visto; true = mudou desde a listagem anterior (encolheu = arquivo trocado: esquece o que sabia). */
  private remember(path: string, size: number): boolean {
    const f = this.files.get(path);
    if (!f) {
      this.files.set(path, { size });
      return false;
    }
    if (f.size === size) return false;
    if (size < f.size) this.files.set(path, { size });
    else f.size = size;
    return true;
  }

  /** A conversa, se for principal e tiver atividade na janela; undefined = fica de fora. */
  private async rowOf(c: Candidate, cutoff: number): Promise<Row | undefined> {
    const head = await this.headOf(c);
    // Subagentes e threads internos não são conversas suas (e saem antes do corte em `limit`).
    if (!head || isSide(head.meta)) return undefined;
    const summary = await this.summaryOf(c, head);
    // Sem `timestamp` nas linhas: a criação (session_meta, depois o UUIDv7). Nunca o mtime.
    const lastAt = summary.lastAt ?? summary.firstAt ?? c.bornAt;
    if (lastAt === undefined || lastAt < cutoff) return undefined;
    return { c, summary, lastAt };
  }

  /** 1ª linha, lida uma vez por arquivo; undefined = ainda sendo gravada ou ilegível (a próxima listagem tenta de novo). */
  private async headOf(c: Candidate): Promise<RolloutHead | undefined> {
    const f = this.files.get(c.path);
    if (f?.head) return f.head;
    try {
      const head = await readRolloutHead(c.path, c.size);
      if (head && f) f.head = head;
      return head;
    } catch (err) {
      log.warnOnce(`codex-history:${errMsg(err)}`, `Histórico do Codex: rollout ilegível (${errMsg(err)}).`);
      return undefined;
    }
  }

  private async summaryOf(c: Candidate, head: RolloutHead): Promise<RolloutSummary> {
    const f = this.files.get(c.path);
    if (f?.summary?.size === c.size) return f.summary.value;
    let value: RolloutSummary;
    try {
      value = await readRolloutRest(c.path, c.size, head, f?.summary?.value);
    } catch (err) {
      log.warnOnce(`codex-history:${errMsg(err)}`, `Histórico do Codex: rollout ilegível (${errMsg(err)}).`);
      value = head.meta ? { meta: head.meta } : {};
    }
    if (f) f.summary = { size: c.size, value };
    return value;
  }

  /** Nomes das threads da conta (session_index.jsonl), já mascarados e cortados; relidos quando o tamanho muda. */
  private async titles(home: string): Promise<ReadonlyMap<string, string>> {
    const path = join(home, SESSION_INDEX);
    let size: number;
    try {
      const st = await stat(path);
      if (!st.isFile()) return NO_NAMES;
      size = st.size;
    } catch {
      return NO_NAMES; // sem índice (TUI sem /rename, exec): vale a primeira instrução
    }
    const hit = this.indexes.get(home);
    if (hit?.size === size) return hit.names;
    let names: ReadonlyMap<string, string> = NO_NAMES;
    try {
      names = await readThreadNames(path, size);
    } catch (err) {
      log.warnOnce(`codex-index:${errMsg(err)}`, `Histórico do Codex: session_index.jsonl ilegível (${errMsg(err)}).`);
    }
    this.indexes.set(home, { size, names });
    return names;
  }
}

function toSession(r: Row, names: ReadonlyMap<string, string>): RecentSession {
  const { c, summary: s } = r;
  const cwd = s.meta?.cwd;
  const out: RecentSession = {
    account: c.account,
    provider: 'codex',
    sessionId: c.threadId,
    projectDir: cwd ? encodeCwd(cwd) : relative(c.dir, join(c.path, '..')) || 'sessions',
    lastAt: r.lastAt,
    size: c.size,
    open: !!c.agentId,
  };
  if (cwd) out.project = cwd;
  const title = names.get(c.threadId) ?? s.title;
  if (title) out.title = title;
  if (s.firstAt !== undefined) out.firstAt = s.firstAt;
  if (c.agentId) out.agentId = c.agentId;
  return out;
}

/** Subagente (spawn_agent) ou thread interno do Codex (guardian, revisão, compactação...). */
function isSide(meta: RolloutMeta | undefined): boolean {
  return !!meta && (meta.internal || meta.parentThreadId !== undefined);
}

/** Criação da thread pelo UUIDv7 (os 48 bits de cima são o epoch em ms); undefined se o id não é v7. */
function uuidV7Time(id: string): number | undefined {
  return id[14] === '7' ? parseInt(id.slice(0, 8) + id.slice(9, 13), 16) : undefined;
}

/** Fim do dia de uma pasta sessions/AAAA/MM/DD (em UTC; a folga cobre o fuso de quem gravou); undefined fora dela. */
function dayEndOf(dir: string): number | undefined {
  const m = DAY_DIR.exec(dir);
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + 1) : undefined;
}

type ReadAt = (start: number, length: number) => Promise<Buffer>;

/** Abre o arquivo (de tamanho `size`) só para leitura e dá a `fn` uma leitura por trecho. */
async function withFile<T>(path: string, size: number, fn: (read: ReadAt) => Promise<T>): Promise<T> {
  const fh = await open(path, 'r');
  try {
    return await fn(async (start, length) => {
      const buf = Buffer.alloc(Math.max(0, Math.min(length, size - start)));
      const { bytesRead } = await fh.read(buf, 0, buf.length, start);
      return buf.subarray(0, bytesRead);
    });
  } finally {
    await fh.close();
  }
}

/** 1ª linha do rollout (até META_MAX); undefined = ainda sem o \n (sendo gravada). */
async function readRolloutHead(path: string, size: number): Promise<RolloutHead | undefined> {
  return withFile(path, size, async (read) => {
    let head = await read(0, HEAD_BYTES);
    let nl = head.indexOf(0x0a);
    // session_meta grande (instruções base, ferramentas): lê mais, até META_MAX.
    while (nl === -1 && head.length < Math.min(size, META_MAX)) {
      const more = await read(head.length, HEAD_BYTES * 4);
      if (!more.length) break;
      head = Buffer.concat([head, more]);
      nl = head.indexOf(0x0a);
    }
    if (nl !== -1) {
      const meta = metaFromLine(head.toString('utf8', 0, nl));
      return meta ? { meta, end: nl + 1 } : { end: nl + 1 };
    }
    // Sem \n até META_MAX: linha grande demais (fica sem meta, como uma ilegível); antes disso, ainda sendo gravada.
    return head.length >= META_MAX ? {} : undefined;
  });
}

/** O resto do rollout: primeira instrução (procurada só enquanto não foi achada; ela não muda) e horários. */
async function readRolloutRest(path: string, size: number, head: RolloutHead, prev?: RolloutSummary): Promise<RolloutSummary> {
  return withFile(path, size, async (read) => {
    const summary: RolloutSummary = {};
    if (head.meta) summary.meta = head.meta;
    let state: CodexState | undefined;
    if (prev?.title !== undefined) summary.title = prev.title;
    else if (head.end !== undefined) {
      state = createCodexState(head.meta);
      const ctx = { idPrefix: '', now: 0, activities: false };
      const after = await read(head.end, PROMPT_BYTES);
      const lines = after.toString('utf8').split('\n');
      if (head.end + after.length < size) lines.pop(); // cortada
      for (const line of lines) {
        if (!line.trim()) continue;
        parseRolloutLine(state, line, ctx);
        if (state.title !== undefined) break;
      }
      if (state.title) summary.title = state.title;
    }
    const tailStart = Math.max(0, size - TAIL_BYTES);
    const tail = (await read(tailStart, TAIL_BYTES)).toString('utf8').split('\n');
    if (tailStart > 0) tail.shift(); // cortada
    for (const line of tail) {
      const at = /"timestamp":"([^"]+)"/.exec(line.slice(0, 200))?.[1];
      const ms = at ? Date.parse(at) : NaN;
      if (!Number.isNaN(ms) && (summary.lastAt === undefined || ms > summary.lastAt)) summary.lastAt = ms;
    }
    const first = head.meta?.startedAt ?? prev?.firstAt ?? state?.firstAt;
    if (first !== undefined) summary.firstAt = first;
    if (summary.lastAt === undefined && state?.lastAt !== undefined) summary.lastAt = state.lastAt;
    return summary;
  });
}

/** Lê o começo e o fim do rollout (de tamanho `size`): session_meta, primeira instrução e horários. */
export async function readRolloutSummary(path: string, size: number): Promise<RolloutSummary> {
  return readRolloutRest(path, size, (await readRolloutHead(path, size)) ?? {});
}

/** {id → nome} do session_index.jsonl: a última linha de cada id vence; nome vazio = sem nome. */
async function readThreadNames(path: string, size: number): Promise<ReadonlyMap<string, string>> {
  const start = Math.max(0, size - INDEX_MAX);
  const lines = await withFile(path, size, async (read) => (await read(start, size - start)).toString('utf8').split('\n'));
  if (start > 0) lines.shift(); // cortada
  const names = new Map<string, string>();
  for (const line of lines) {
    const e = indexEntry(line);
    if (!e) continue;
    // Mascarado antes de cortar (um segredo cortado ao meio escaparia do padrão).
    const name = truncate(maskSecrets(e.name), TITLE_MAX);
    if (name) names.set(e.id, name);
    else names.delete(e.id);
  }
  return names;
}

/** {id, thread_name} de uma linha do session_index.jsonl (id em minúsculas); undefined = linha inválida. */
function indexEntry(line: string): { id: string; name: string } | undefined {
  if (!line.trim()) return undefined;
  try {
    const j = JSON.parse(line) as { id?: unknown; thread_name?: unknown } | null;
    return j && isThreadId(j.id) && typeof j.thread_name === 'string' ? { id: j.id.toLowerCase(), name: j.thread_name } : undefined;
  } catch {
    return undefined; // linha cortada ou JSON inválido
  }
}

/** map() assíncrono com no máximo `limit` tarefas ao mesmo tempo (mantém a ordem). */
async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
