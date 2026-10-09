// Varredura reversa dos rollouts do Codex: do fim para o começo, em blocos, até a fronteira de turno mais recente.
// Turnos do Codex passam de vários MB: a janela fixa de 1 MB do fim não acha o task_started e mostraria "ocioso" no
// meio do trabalho. Só leitura posicional (openSync 'r' + readSync), nunca o arquivo inteiro.
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

/** Bloco da varredura reversa. */
export const SCAN_BLOCK_BYTES = 1024 * 1024;
/** Teto da varredura: passou disto do fim sem achar a fronteira, desiste (`hitBoundary: false`). */
export const SCAN_MAX_BYTES = 64 * 1024 * 1024;

const NL = 0x0a;

/** Tipos de event_msg que abrem ou fecham um turno (o Codex aceita turn_started/turn_complete como aliases). */
const TURN_BOUNDARIES = new Set(['task_started', 'turn_started', 'task_complete', 'turn_complete', 'turn_aborted']);
/** Filtro barato antes do JSON.parse (dentro de uma string JSON as aspas viriam escapadas e não casam). */
const TURN_BOUNDARY_HINT = /"type"\s*:\s*"(?:task_started|turn_started|task_complete|turn_complete|turn_aborted)"/;

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function parseRecord(line: string): Record<string, unknown> | undefined {
  try {
    const rec: unknown = JSON.parse(line);
    return isObj(rec) ? rec : undefined;
  } catch {
    return undefined;
  }
}

/** task_started, task_complete ou turn_aborted (event_msg), em qualquer formato do Codex 0.160.1. */
export function isTurnBoundary(line: string): boolean {
  if (!TURN_BOUNDARY_HINT.test(line)) return false;
  const rec = parseRecord(line);
  if (rec?.type !== 'event_msg' || !isObj(rec.payload)) return false;
  const type = rec.payload.type;
  return typeof type === 'string' && TURN_BOUNDARIES.has(type);
}

/** `timestamp` da linha em epoch ms (undefined se ausente/ inválido). */
export function lineTimestamp(line: string): number | undefined {
  const raw = parseRecord(line)?.timestamp;
  if (typeof raw !== 'string') return undefined;
  const at = Date.parse(raw);
  return Number.isFinite(at) ? at : undefined;
}

/** Lê `length` bytes a partir de `position` (menos, se o arquivo acabar antes). */
function readAt(fd: number, position: number, length: number): Buffer {
  const buf = Buffer.allocUnsafe(length);
  let got = 0;
  while (got < length) {
    const n = readSync(fd, buf, got, length - got, position + got);
    if (n <= 0) break;
    got += n;
  }
  return got < length ? buf.subarray(0, got) : buf;
}

/**
 * Lê de trás para frente, em blocos, até achar uma linha de fronteira (inclusive) ou bater `maxBytes`.
 * Só linhas completas (a última sem `\n` fica de fora). `start` = byte da 1ª linha devolvida;
 * `end` = byte logo depois da última linha completa (o tail continua daí).
 *
 * Lê só até `size` (o que o arquivo cresceu depois do stat fica para o tail), nunca além do fim real. Com o teto, só
 * entram as linhas que começam nos últimos `maxBytes` antes de `size`. Linhas em branco são puladas e o `\r` final é
 * tirado. Arquivo inexistente → nada lido; outros erros de leitura sobem (como no FileTail).
 */
export function scanBackward(
  path: string,
  opts: { size: number; isBoundary?: (line: string) => boolean; blockBytes?: number; maxBytes?: number },
): { lines: string[]; start: number; end: number; hitBoundary: boolean } {
  const isBoundary = opts.isBoundary ?? isTurnBoundary;
  const blockBytes = Math.max(1, Math.floor(opts.blockBytes ?? SCAN_BLOCK_BYTES));
  const maxBytes = Math.max(0, Math.floor(opts.maxBytes ?? SCAN_MAX_BYTES));
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { lines: [], start: 0, end: 0, hitBoundary: false };
    throw err;
  }
  try {
    const size = Math.min(Math.max(0, Math.floor(opts.size)), fstatSync(fd).size);
    const floor = Math.max(0, size - maxBytes);
    const reversed: string[] = [];
    let end = -1; // logo depois do último \n (−1 = ainda dentro da linha parcial do fim)
    let start = -1;

    /** Guarda uma linha completa (de trás para frente); true = é a fronteira (para aqui). */
    const take = (bytes: Buffer, at: number): boolean => {
      const line = bytes.toString('utf8').replace(/\r$/, '');
      if (!line.trim()) return false;
      reversed.push(line);
      start = at;
      return isBoundary(line);
    };
    const result = (hitBoundary: boolean) => {
      const e = end < 0 ? floor : end;
      return { lines: reversed.reverse(), start: start < 0 ? e : start, end: e, hitBoundary };
    };

    /** Pedaços (em ordem) de uma linha que começou antes do bloco atual; ela termina num \n já lido. */
    let carry: Buffer[] = [];
    let pos = size;
    while (pos > floor) {
      const from = Math.max(floor, pos - blockBytes);
      const block = readAt(fd, from, pos - from);
      if (block.length < pos - from) break; // o arquivo encolheu durante a leitura
      let lineEnd = block.length;
      if (end < 0) {
        const nl = block.lastIndexOf(NL);
        if (nl === -1) {
          pos = from; // tudo aqui ainda é a linha parcial do fim: descarta
          continue;
        }
        end = from + nl + 1;
        lineEnd = nl;
      }
      while (lineEnd > 0) {
        const nl = block.lastIndexOf(NL, lineEnd - 1);
        if (nl === -1) break;
        const piece = block.subarray(nl + 1, lineEnd);
        const bytes = carry.length ? Buffer.concat([piece, ...carry]) : piece;
        carry = [];
        if (take(bytes, from + nl + 1)) return result(true);
        lineEnd = nl;
      }
      const head = block.subarray(0, lineEnd);
      // A linha começa no bloco se ele é o começo do arquivo, ou se é o teto e o byte anterior a ele é um \n.
      if (from === 0 || (from === floor && readAt(fd, from - 1, 1)[0] === NL)) {
        if (take(carry.length ? Buffer.concat([head, ...carry]) : head, from)) return result(true);
      } else {
        carry = [head, ...carry]; // no teto, sem \n antes: a linha começou além dele e fica de fora
      }
      pos = from;
    }
    return result(false);
  } finally {
    closeSync(fd);
  }
}
