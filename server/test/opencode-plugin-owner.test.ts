// Dono das sessões no plugin do OpenCode: com dois OpenCode abertos, `client.session.list()` pode trazer sessões do outro
// processo. O plugin só serve as que viu em eventos/ferramentas e as da lista cujo `directory` é o do próprio plugin
// (comparado depois de normalizar o caminho); sem `directory` no argumento, só as vistas. Servidor falso em 127.0.0.1
// que guarda as sessões buscadas, HOME temporário, cliente falso. Dados sintéticos.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setQuiet } from '../log';
import { tempDir } from './fixtures';
import { ocId } from './opencode-fixtures';

setQuiet(true);

const PLUGIN = resolve(__dirname, '../../mod/habblaud-opencode/plugin.js');
type Hooks = { event: (input: unknown) => Promise<void> };
const mod = (await import(pathToFileURL(PLUGIN).href)) as { HabblaudPlugin: (ctx: unknown) => Promise<Hooks> };
const MINE = ocId('ses', 41);
const OTHER = ocId('ses', 42);
const SEEN = ocId('ses', 43);

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

/** Plugin com `directory` e a lista dada; devolve o que foi buscado e entregue (cada sessão listada tem uma mensagem pronta). */
async function run(directory: string | undefined, list: unknown[], seen: string[] = []) {
  const polled = new Set<string>();
  const delivered: string[] = [];
  const handed = new Set<string>();
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (req.url === '/api/opencode/bridge/poll') {
        const session = (JSON.parse(raw) as { session: string }).session;
        polled.add(session);
        if (handed.has(session)) return void res.end('{"messages":[]}');
        handed.add(session);
        return void res.end(JSON.stringify({ messages: [{ id: 'm1', text: `para ${session}` }] }));
      }
      res.end('{"ok":true}');
    });
  });
  await new Promise<void>((ok) => server!.listen(0, '127.0.0.1', ok));
  const port = (server.address() as AddressInfo).port;
  mkdirSync(join(tmp.dir, '.habblaud'), { recursive: true });
  writeFileSync(join(tmp.dir, '.habblaud', 'opencode-hook.json'), JSON.stringify({ port }));
  const client = {
    session: {
      list: async () => ({ data: list }),
      promptAsync: async (p: { path: { id: string } }) => {
        delivered.push(p.path.id);
        return { data: undefined, response: { ok: true } };
      },
    },
  };
  hooks = await mod.HabblaudPlugin({ client, directory });
  for (const id of seen) await hooks.event({ event: { type: 'session.status', properties: { sessionID: id, status: { type: 'busy' } } } });
  const t0 = Date.now();
  while (!polled.size && Date.now() - t0 < 6_000) await new Promise((ok) => setTimeout(ok, 20));
  await new Promise((ok) => setTimeout(ok, 1_800)); // mais de uma rodada
  return { polled, delivered };
}

describe('plugin do OpenCode: só atende as sessões do próprio diretório', () => {
  it('sessão listada de outro diretório não é buscada nem entregue; a do mesmo diretório é servida', async () => {
    const { polled, delivered } = await run('/p/loja', [
      { id: OTHER, directory: '/p/outra' },
      { id: MINE, directory: '/p/loja' },
    ]);
    expect(polled).toEqual(new Set([MINE]));
    expect(delivered).toEqual([MINE]);
  }, 15_000);

  it('o diretório é comparado depois de normalizar o caminho (barra no fim, ponto)', async () => {
    const { polled } = await run('/p/loja', [
      { id: MINE, directory: '/p/loja/' },
      { id: OTHER, directory: '/p/loja-2' },
    ]);
    expect(polled).toEqual(new Set([MINE]));
  }, 15_000);

  it('sessão vista em evento é servida mesmo de outro diretório (o plugin a viu rodar)', async () => {
    const { polled } = await run('/p/loja', [{ id: OTHER, directory: '/p/outra' }], [SEEN]);
    expect(polled).toEqual(new Set([SEEN]));
  }, 15_000);

  it('sem directory no argumento só as sessões vistas são servidas, nenhuma da lista', async () => {
    const { polled, delivered } = await run(undefined, [{ id: MINE, directory: '/p/loja' }, { id: OTHER, directory: '' }], [SEEN]);
    expect(polled).toEqual(new Set([SEEN]));
    expect(delivered).toEqual([SEEN]);
  }, 15_000);
});
