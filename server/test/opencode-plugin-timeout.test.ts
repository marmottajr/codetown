// OC-15: o envio de um evento do plugin do OpenCode (mod/habblaud-opencode/plugin.js) tem prazo de 1,5 s. Servidor local
// em 127.0.0.1 que nunca responde: mede quando o plugin desiste (a conexão cai) e exige ~1,5 s (aceita 1,3 a 2,5 s),
// nunca 150 s; o gancho volta sem lançar. HOME temporário, sem o OpenCode de verdade. Dados sintéticos.
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
let savedPort: string | undefined;
let server: http.Server | undefined;

beforeEach(() => {
  tmp = tempDir();
  savedHome = process.env.HOME;
  savedPort = process.env.HABBLAUD_PORT;
  process.env.HOME = tmp.dir;
  delete process.env.HABBLAUD_PORT;
});
afterEach(async () => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (savedPort !== undefined) process.env.HABBLAUD_PORT = savedPort;
  if (server) {
    const s = server;
    server = undefined;
    s.closeAllConnections();
    await new Promise<void>((ok) => s.close(() => ok()));
  }
  tmp.cleanup();
});

describe('plugin do OpenCode: prazo do envio de eventos (OC-15)', () => {
  it('servidor que nunca responde: o plugin desiste em ~1,5 s (não em 150 s) e o gancho não lança', async () => {
    let received = 0;
    let closedAt: number | undefined;
    let sentAt = 0;
    server = http.createServer((req) => {
      req.resume();
      if (req.url !== '/api/opencode/events') return; // a busca de mensagens do plugin (bridge/poll) tem outro prazo
      received++;
      req.socket.on('close', () => {
        closedAt ??= Date.now();
      });
      // nunca responde
    });
    await new Promise<void>((ok) => server!.listen(0, '127.0.0.1', ok));
    const port = (server.address() as AddressInfo).port;
    mkdirSync(join(tmp.dir, '.habblaud'), { recursive: true });
    writeFileSync(join(tmp.dir, '.habblaud', 'opencode-hook.json'), JSON.stringify({ port }));

    const hooks = await mod.HabblaudPlugin({ client: {}, directory: '/p/loja' });
    sentAt = Date.now();
    await expect(hooks.event({ event: { type: 'session.idle', properties: { sessionID: SES } } })).resolves.toBeUndefined();

    const t0 = Date.now();
    while (closedAt === undefined && Date.now() - t0 < 6_000) await new Promise((ok) => setTimeout(ok, 20));
    expect(received).toBe(1);
    expect(closedAt).toBeDefined();
    const waited = (closedAt as number) - sentAt;
    expect(waited).toBeGreaterThanOrEqual(1_300);
    expect(waited).toBeLessThanOrEqual(2_500);
    await hooks.event({ event: { type: 'server.instance.disposed', properties: {} } }); // encerra a busca do plugin
  }, 15_000);
});
