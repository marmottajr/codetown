// Plugin do OpenCode: eventos de pergunta (question.asked/replied/rejected) chegam ao Habblaud com a estrutura completa
// (OQ-01). Servidor local em 127.0.0.1 e HOME temporário; nunca o OpenCode de verdade. Dados sintéticos.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setQuiet } from '../log';
import { tempDir } from './fixtures';

setQuiet(true);

const PLUGIN = resolve(__dirname, '../../mod/habblaud-opencode/plugin.js');
type Hooks = Record<string, (input: unknown, output?: unknown) => Promise<void>>;
const mod = (await import(pathToFileURL(PLUGIN).href)) as Record<string, (ctx: unknown) => Promise<Hooks>>;
const SES = 'ses_' + 'd'.repeat(26);

let tmp: ReturnType<typeof tempDir>;
let savedHome: string | undefined;
let server: http.Server | undefined;
const bodies: Array<{ event: { type: string; properties: Record<string, unknown> } }> = [];

beforeEach(async () => {
  tmp = tempDir();
  savedHome = process.env.HOME;
  process.env.HOME = tmp.dir;
  bodies.length = 0;
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      if (req.url === '/api/opencode/events') bodies.push(JSON.parse(raw));
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}');
    });
  });
  await new Promise<void>((ok) => server!.listen(0, '127.0.0.1', ok));
  mkdirSync(join(tmp.dir, '.habblaud'), { recursive: true });
  writeFileSync(join(tmp.dir, '.habblaud', 'opencode-hook.json'), JSON.stringify({ port: (server.address() as AddressInfo).port }));
});
afterEach(async () => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  server!.closeAllConnections();
  await new Promise<void>((ok) => server!.close(() => ok()));
  tmp.cleanup();
});

async function waitFor(cond: () => boolean, ms = 3_000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('tempo esgotado esperando a condição');
    await new Promise((ok) => setTimeout(ok, 15));
  }
}

const start = () => mod.HabblaudPlugin({ client: {}, project: {}, directory: '/p/loja', worktree: '/p/loja', $: undefined });

describe('plugin do OpenCode: eventos de pergunta (OQ-01)', () => {
  it('question.asked chega com id, sessionID e as questions completas (question, header, options, multiple, custom)', async () => {
    const hooks = await start();
    const event = {
      type: 'question.asked',
      properties: {
        id: 'que_abc123',
        sessionID: SES,
        questions: [
          { question: 'Qual banco?', header: 'Banco', options: [{ label: 'SQLite', description: 'local' }, { label: 'Postgres', description: 'remoto' }], multiple: true, custom: false },
          { question: 'Nome?', header: 'Nome', options: [] },
        ],
        tool: { messageID: 'msg_1', callID: 'call_1' },
      },
    };
    await hooks.event({ event });
    await waitFor(() => bodies.length === 1);
    expect(bodies[0]).toEqual({ event });
  });

  it('question.replied e question.rejected chegam com requestID (e answers)', async () => {
    const hooks = await start();
    const replied = { type: 'question.replied', properties: { sessionID: SES, requestID: 'que_abc123', answers: [['SQLite', 'Postgres'], ['texto livre']] } };
    const rejected = { type: 'question.rejected', properties: { sessionID: SES, requestID: 'que_abc123' } };
    await hooks.event({ event: replied });
    await hooks.event({ event: rejected });
    await waitFor(() => bodies.length === 2);
    expect(bodies.map((b) => b.event)).toEqual([replied, rejected]);
  });

  it('textos enormes de uma pergunta são cortados, e o evento sem sessionID não sai', async () => {
    const hooks = await start();
    await hooks.event({ event: { type: 'question.asked', properties: { id: 'que_1', questions: [] } } });
    await hooks.event({ event: { type: 'question.asked', properties: { id: 'que_2', sessionID: SES, questions: [{ question: 'x'.repeat(50_000), header: 'h', options: [] }] } } });
    await waitFor(() => bodies.length === 1);
    expect(bodies[0].event.properties.id).toBe('que_2');
    expect(JSON.stringify(bodies[0]).length).toBeLessThan(5_000);
  });
});
