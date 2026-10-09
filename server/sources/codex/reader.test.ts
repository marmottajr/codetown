// Varredura reversa do rollout do Codex até a fronteira de turno (linhas sintéticas).
import { appendFileSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { R, threadId } from '../../test/codex-fixtures';
import { tempDir } from '../../test/fixtures';
import { SCAN_BLOCK_BYTES, SCAN_MAX_BYTES, isTurnBoundary, lineTimestamp, scanBackward } from './reader';

const T = threadId(1);
const T0 = Date.parse('2026-10-09T12:00:00Z');

let tmp: ReturnType<typeof tempDir>;
let file: string;
beforeEach(() => {
  tmp = tempDir();
  file = join(tmp.dir, `rollout-2026-10-09T12-00-00-${T}.jsonl`);
});
afterEach(() => tmp.cleanup());

/** Conteúdo do arquivo com uma linha por item, cada uma terminada em \n. */
const text = (lines: string[]) => lines.map((l) => `${l}\n`).join('');
/** Byte do começo da linha `i` num arquivo gravado com text(lines). */
const offsetOf = (lines: string[], i: number) => Buffer.byteLength(text(lines.slice(0, i)));
const sizeOf = (p: string) => statSync(p).size;
/** event_msg de um tipo qualquer (os aliases turn_started/turn_complete não têm construtor nas fixtures). */
const event = (type: string) => JSON.stringify({ timestamp: new Date(T0).toISOString(), type: 'event_msg', payload: { type, turn_id: 't1' } });

describe('isTurnBoundary', () => {
  it('task_started, task_complete e turn_aborted, e os aliases turn_started e turn_complete', () => {
    expect(isTurnBoundary(R.taskStarted('t1', T0))).toBe(true);
    expect(isTurnBoundary(R.taskComplete('t1', T0))).toBe(true);
    expect(isTurnBoundary(R.turnAborted('t1', T0))).toBe(true);
    expect(isTurnBoundary(event('turn_started'))).toBe(true);
    expect(isTurnBoundary(event('turn_complete'))).toBe(true);
  });

  it('texto que só menciona o evento, outros event_msg, outro tipo de linha e JSON cortado não contam', () => {
    expect(isTurnBoundary(R.user(T, 't1', 'u1', 'o que é "type":"task_started"?', T0))).toBe(false);
    expect(isTurnBoundary(R.agent(T, 't1', 'a1', 'task_complete', T0))).toBe(false);
    expect(isTurnBoundary(R.tokens({ input: 1, output: 1, at: T0 }))).toBe(false);
    expect(isTurnBoundary(event('item_completed'))).toBe(false);
    expect(isTurnBoundary(event('task_started_extra'))).toBe(false);
    expect(isTurnBoundary(JSON.stringify({ type: 'response_item', payload: { type: 'task_started' } }))).toBe(false);
    expect(isTurnBoundary('{"type":"event_msg","payload":{"type":"task_started"')).toBe(false);
  });
});

describe('lineTimestamp', () => {
  it('o timestamp da linha em epoch ms; ausente, inválido ou JSON inválido → undefined', () => {
    expect(lineTimestamp(R.taskStarted('t1', T0 + 5000))).toBe(T0 + 5000);
    expect(lineTimestamp(JSON.stringify({ type: 'x', timestamp: '2026-10-09T12:00:07.250Z' }))).toBe(T0 + 7250);
    expect(lineTimestamp(JSON.stringify({ type: 'x' }))).toBeUndefined();
    expect(lineTimestamp(JSON.stringify({ timestamp: 'ontem' }))).toBeUndefined();
    expect(lineTimestamp(JSON.stringify({ timestamp: T0 }))).toBeUndefined();
    expect(lineTimestamp(R.taskStarted('t1', T0).slice(0, 50))).toBeUndefined();
    expect(lineTimestamp('null')).toBeUndefined();
    expect(lineTimestamp('não é json')).toBeUndefined();
  });
});

describe('scanBackward', () => {
  it('limites padrão: blocos de 1 MiB, teto de 64 MiB', () => {
    expect(SCAN_BLOCK_BYTES).toBe(1024 * 1024);
    expect(SCAN_MAX_BYTES).toBe(64 * 1024 * 1024);
  });

  it('turno aberto a mais de 2 MiB do fim: atravessa os blocos de 1 MiB e devolve desde o task_started', () => {
    const lines = [
      R.meta(T, { at: T0 }),
      R.turnContext({ at: T0 }),
      R.taskStarted('t1', T0 + 1),
      R.agent(T, 't1', 'a1', 'feito', T0 + 2),
      R.taskComplete('t1', T0 + 3),
      R.turnContext({ at: T0 + 4 }),
      R.taskStarted('t2', T0 + 5),
    ];
    const big = 'x'.repeat(4000);
    for (let i = 0; i < 640; i++) {
      lines.push(R.functionCall(`call_${i}`, 'shell_command', { command: `echo ${i}` }, T0 + 6 + i), R.functionOutput(`call_${i}`, big, T0 + 6 + i));
    }
    writeFileSync(file, text(lines));
    const size = sizeOf(file);
    expect(size - offsetOf(lines, 6)).toBeGreaterThan(2 * SCAN_BLOCK_BYTES);

    expect(scanBackward(file, { size })).toEqual({ lines: lines.slice(6), start: offsetOf(lines, 6), end: size, hitBoundary: true });
  });

  it('para na fronteira mais recente: task_complete e turn_aborted também', () => {
    const done = [R.meta(T, { at: T0 }), R.taskStarted('t1', T0 + 1), R.agent(T, 't1', 'a1', 'ok', T0 + 2), R.taskComplete('t1', T0 + 3), R.tokens({ input: 10, output: 2, at: T0 + 4 })];
    writeFileSync(file, text(done));
    expect(scanBackward(file, { size: sizeOf(file) })).toEqual({ lines: done.slice(3), start: offsetOf(done, 3), end: sizeOf(file), hitBoundary: true });
    const aborted = [R.meta(T, { at: T0 }), R.taskStarted('t1', T0 + 1), R.turnAborted('t1', T0 + 2)];
    writeFileSync(file, text(aborted));
    expect(scanBackward(file, { size: sizeOf(file) })).toEqual({ lines: aborted.slice(2), start: offsetOf(aborted, 2), end: sizeOf(file), hitBoundary: true });
  });

  it('fronteira, acentos e \\r\\n cortados entre blocos, em qualquer alinhamento (blocos de 1 a 200 bytes)', () => {
    const lines = [
      R.taskComplete('t0', T0),
      R.user(T, 't1', 'u1', 'Corrija a função de preço — ação rápida ☕', T0 + 1),
      R.taskStarted('t1', T0 + 2),
      R.agent(T, 't1', 'a1', 'Olhando o código: ü, ñ, ç, ã, 🚀 '.repeat(3), T0 + 3),
      R.functionCall('call_1', 'shell_command', { command: 'npm test' }, T0 + 4),
      R.functionOutput('call_1', 'ok', T0 + 5),
    ];
    for (const eol of ['\n', '\r\n']) {
      const raw = lines.map((l) => `${l}${eol}`).join('');
      writeFileSync(file, raw);
      const size = Buffer.byteLength(raw);
      const start = Buffer.byteLength(lines.slice(0, 2).map((l) => `${l}${eol}`).join(''));
      for (let blockBytes = 1; blockBytes <= 200; blockBytes++) {
        expect(scanBackward(file, { size, blockBytes })).toEqual({ lines: lines.slice(2), start, end: size, hitBoundary: true });
      }
    }
  });

  it('a última linha sem \\n fica de fora, mesmo sendo uma fronteira inteira, e end fica logo depois do último \\n', () => {
    const done = [R.taskStarted('t1', T0), R.agent(T, 't1', 'a1', 'pronto', T0 + 1), R.taskComplete('t1', T0 + 2)];
    const expected = { lines: [done[2]], start: offsetOf(done, 2), end: Buffer.byteLength(text(done)), hitBoundary: true };
    for (const tail of [R.taskStarted('t2', T0 + 3).slice(0, 50), R.taskStarted('t2', T0 + 3)]) {
      writeFileSync(file, text(done) + tail);
      for (const blockBytes of [7, SCAN_BLOCK_BYTES]) {
        expect(scanBackward(file, { size: sizeOf(file), blockBytes })).toEqual(expected);
      }
    }
  });

  it('respeita o size passado: o que entrou depois do stat fica para o tail', () => {
    const first = [R.taskStarted('t1', T0), R.agent(T, 't1', 'a1', 'um', T0 + 1)];
    writeFileSync(file, text(first));
    const size = sizeOf(file);
    const later = [R.taskComplete('t1', T0 + 2), R.taskStarted('t2', T0 + 3)];
    appendFileSync(file, `${text(later)}{"parcial`);

    expect(scanBackward(file, { size, blockBytes: 16 })).toEqual({ lines: first, start: 0, end: size, hitBoundary: true });
    // size no meio de uma linha: ela conta como parcial.
    expect(scanBackward(file, { size: size - 3, blockBytes: 16 })).toEqual({ lines: [first[0]], start: 0, end: offsetOf(first, 1), hitBoundary: true });
    // size além do fim real: vale o fim real.
    const all = [...first, ...later];
    expect(scanBackward(file, { size: sizeOf(file) + 1000 })).toEqual({ lines: [later[1]], start: offsetOf(all, 3), end: offsetOf(all, 4), hitBoundary: true });
  });

  it('sem fronteira até o começo do arquivo: todas as linhas completas, hitBoundary false', () => {
    const lines = [R.meta(T, { at: T0 }), R.user(T, 't1', 'u1', 'oi', T0 + 1), R.agent(T, 't1', 'a1', 'olá', T0 + 2)];
    writeFileSync(file, text(lines));
    for (const blockBytes of [5, SCAN_BLOCK_BYTES]) {
      expect(scanBackward(file, { size: sizeOf(file), blockBytes })).toEqual({ lines, start: 0, end: sizeOf(file), hitBoundary: false });
    }
  });

  it('teto maxBytes: sem fronteira dentro dele, hitBoundary false e só as linhas que começam dentro do teto', () => {
    // 100 linhas de 100 bytes (99 + \n); a fronteira é a 1ª.
    const lines = Array.from({ length: 100 }, (_, i) => (i === 0 ? 'B' : 'a').padEnd(99, String(i % 10)));
    writeFileSync(file, text(lines));
    const isBoundary = (l: string) => l.startsWith('B');
    for (const blockBytes of [64, 512, SCAN_BLOCK_BYTES]) {
      const scan = (maxBytes: number) => scanBackward(file, { size: 10_000, isBoundary, blockBytes, maxBytes });
      // Teto no meio da linha 79: ela fica de fora (nunca devolve linha cortada).
      expect(scan(2050)).toEqual({ lines: lines.slice(80), start: 8000, end: 10_000, hitBoundary: false });
      // Teto exatamente no começo da linha 80: ela entra.
      expect(scan(2000)).toEqual({ lines: lines.slice(80), start: 8000, end: 10_000, hitBoundary: false });
      expect(scan(1999)).toEqual({ lines: lines.slice(81), start: 8100, end: 10_000, hitBoundary: false });
      // Teto do tamanho do arquivo: chega à fronteira.
      expect(scan(10_000)).toEqual({ lines, start: 0, end: 10_000, hitBoundary: true });
    }
  });

  it('arquivo vazio, só com uma linha parcial ou inexistente: nada', () => {
    const nothing = { lines: [], start: 0, end: 0, hitBoundary: false };
    writeFileSync(file, '');
    expect(scanBackward(file, { size: 0 })).toEqual(nothing);
    writeFileSync(file, R.taskStarted('t1', T0).slice(0, 50));
    expect(scanBackward(file, { size: sizeOf(file), blockBytes: 16 })).toEqual(nothing);
    expect(scanBackward(join(tmp.dir, 'nao-existe.jsonl'), { size: 100 })).toEqual(nothing);
  });

  it('pula linhas em branco e tira o \\r do fim', () => {
    const started = R.taskStarted('t1', T0);
    const reply = R.agent(T, 't1', 'a1', 'ok', T0 + 1);
    writeFileSync(file, `${started}\r\n\n  \n${reply}\r\n`);
    expect(scanBackward(file, { size: sizeOf(file), blockBytes: 5 })).toEqual({ lines: [started, reply], start: 0, end: sizeOf(file), hitBoundary: true });
    writeFileSync(file, '\n\r\n  \n');
    expect(scanBackward(file, { size: 6, blockBytes: 2 })).toEqual({ lines: [], start: 6, end: 6, hitBoundary: false });
  });

  it('isBoundary próprio: para na linha mais recente em que ele diz true (ex.: a última com timestamp)', () => {
    const lines = [R.taskStarted('t1', T0), R.agent(T, 't1', 'a1', 'ok', T0 + 2000), JSON.stringify({ type: 'sem_timestamp' })];
    writeFileSync(file, `${text(lines)}${R.agent(T, 't1', 'a2', 'parcial', T0 + 9000).slice(0, 40)}`);
    const r = scanBackward(file, { size: sizeOf(file), isBoundary: (l) => lineTimestamp(l) !== undefined, maxBytes: 64 * 1024 });
    expect(r).toEqual({ lines: lines.slice(1), start: offsetOf(lines, 1), end: Buffer.byteLength(text(lines)), hitBoundary: true });
    expect(lineTimestamp(r.lines[0])).toBe(T0 + 2000);
  });
});

it('o leitor só abre arquivos para leitura (o servidor não escreve no CODEX_HOME)', () => {
  const src = readFileSync(fileURLToPath(new URL('./reader.ts', import.meta.url)), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
  expect(src).not.toMatch(/\b(?:writeSync|writeFileSync|appendFileSync|ftruncateSync|truncateSync|renameSync|unlinkSync|rmSync|mkdirSync)\b/);
  expect(src).not.toMatch(/'(?:r\+|rs\+|w\+?|wx\+?|a\+?|ax\+?|as\+?)'/);
  expect(src.match(/openSync\(/g)?.length).toBe(1);
  expect(src).toMatch(/openSync\(path, 'r'\)/);
});
