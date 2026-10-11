// OC-26: o plugin do OpenCode repete no lado dele o limite de texto do servidor (20.000 caracteres, o mesmo MESSAGE_MAX
// do Codex): texto com exatamente 20.000 é entregue com promptAsync; com 20.001 nunca chega ao promptAsync (rejeitado).
// Servidor falso em 127.0.0.1 que entrega as mensagens na busca e guarda a confirmação; HOME temporário, cliente falso.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MESSAGE_MAX } from '../../shared/messages';
import { setQuiet } from '../log';
import { tempDir } from './fixtures';

setQuiet(true);

const PLUGIN = resolve(__dirname, '../../mod/habblaud-opencode/plugin.js');
type Hooks = { event: (input: unknown) => Promise<void> };
const mod = (await import(pathToFileURL(PLUGIN).href)) as { HabblaudPlugin: (ctx: unknown) => Promise<Hooks> };
const SES = 'ses_' + 'e'.repeat(26);

let tmp: ReturnType<typeof tempDir>;
let savedHome: string | undefined;
let server: http.Server | undefined;
let hooks: Hooks | undefined;

beforeEach(() => {
  tmp = tempDir();
  savedHome = process.env.HOME;
  process.env.HOME = tmp.dir;
});
afterEach(async () => {
  await hooks?.event({ event: { type: 'server.instance.disposed', properties: {} } });
  hooks = undefined;
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (server) {
    const s = server;
    server = undefined;
    s.closeAllConnections();
    await new Promise<void>((ok) => s.close(() => ok()));
  }
  tmp.cleanup();
});

/** Entrega `texts` (uma mensagem cada) na primeira busca; devolve o que o plugin confirmou. */
async function run(texts: string[]) {
  const acks: Array<{ session: string; results: Array<{ id: string; ok: boolean; error?: string }> }> = [];
  let delivered = false;
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (req.url === '/api/opencode/bridge/poll' && !delivered) {
        delivered = true;
        return void res.end(JSON.stringify({ messages: texts.map((text, i) => ({ id: `m${i}`, text })) }));
      }
      if (req.url === '/api/opencode/bridge/ack') acks.push(JSON.parse(raw));
      res.end(req.url === '/api/opencode/bridge/poll' ? '{"messages":[]}' : '{"ok":true}');
    });
  });
  await new Promise<void>((ok) => server!.listen(0, '127.0.0.1', ok));
  const port = (server.address() as AddressInfo).port;
  mkdirSync(join(tmp.dir, '.habblaud'), { recursive: true });
  writeFileSync(join(tmp.dir, '.habblaud', 'opencode-hook.json'), JSON.stringify({ port }));
  const prompts: Array<{ path: { id: string }; body: { parts: Array<{ text: string }> } }> = [];
  const client = {
    session: {
      promptAsync: async (p: (typeof prompts)[number]) => {
        prompts.push(p);
        return { data: undefined, response: { ok: true } };
      },
    },
  };
  hooks = await mod.HabblaudPlugin({ client, directory: '/p/loja' });
  await hooks.event({ event: { type: 'session.status', properties: { sessionID: SES, status: { type: 'busy' } } } });
  const t0 = Date.now();
  while (!acks.length && Date.now() - t0 < 6_000) await new Promise((ok) => setTimeout(ok, 20));
  return { prompts, acks };
}

describe('plugin do OpenCode: limite de texto (OC-26)', () => {
  it('o limite do plugin é o mesmo do servidor e do Codex (20.000)', () => {
    expect(MESSAGE_MAX).toBe(20_000);
  });

  it('exatamente 20.000 caracteres é entregue e confirmado', async () => {
    const text = 'x'.repeat(20_000);
    const { prompts, acks } = await run([text]);
    expect(prompts).toHaveLength(1);
    expect(prompts[0].body.parts[0].text).toBe(text);
    expect(acks[0].results).toEqual([{ id: 'm0', ok: true }]);
  }, 15_000);

  it('20.001 caracteres nunca chega ao promptAsync (o servidor, que exige a confirmação, a marca como não entregue)', async () => {
    const { prompts, acks } = await run(['y'.repeat(20_001), 'ok']);
    expect(prompts.map((p) => p.body.parts[0].text)).toEqual(['ok']);
    expect(acks[0].results.map((r) => r.id)).toEqual(['m1']);
  }, 15_000);
});
