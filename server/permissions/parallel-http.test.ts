// Rotas de /api/permissions com o canal paralelo do Codex (contrato C4): o hook do Codex numa thread atendida pelo
// canal recebe 200 {skip: "parallel"} (sem 201) e o hook.mjs sai sem decidir; a página vê o pedido 'parallel' no
// snapshot e a decisão vai ao ParallelSink (200, 409, 400, 503 e 404). HOME e CODEX_HOME em pastas temporárias.
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { CodexDecision, OfficeSnapshot } from '../../shared/types';
import { setQuiet } from '../log';
import { tempDir } from '../test/fixtures';
import { CODEX_MAIN, CODEX_THREAD, request, servePermissions, type PermissionServer } from '../test/permission-server';
import type { ParallelSink } from './registry';

setQuiet(true);

/** run() do hook do Codex: manda o evento e decide (ou não) o PermissionRequest; devolve a saída a imprimir. */
const hook = (await import(pathToFileURL(resolve(__dirname, '../../mod/habblaud-codex/hook.mjs')).href)) as { run(env: NodeJS.ProcessEnv, stdinText: string): Promise<unknown> };

type DecideReply = Awaited<ReturnType<ParallelSink['decide']>>;

let srv: PermissionServer | undefined;
let tmp: ReturnType<typeof tempDir> | undefined;
afterEach(async () => {
  await srv?.close();
  srv = undefined;
  tmp?.cleanup();
  tmp = undefined;
});

async function serve(): Promise<{ s: PermissionServer; sent: Array<[string, CodexDecision]>; owned: Set<string>; reply: { value: DecideReply } }> {
  const s = (srv = await servePermissions({ codex: true }));
  const sent: Array<[string, CodexDecision]> = [];
  const owned = new Set<string>();
  const reply: { value: DecideReply } = { value: 'ok' };
  s.registry!.setParallelSink({
    decide: (key, decision) => {
      sent.push([key, decision]);
      return Promise.resolve(reply.value);
    },
    owns: (account, threadId) => owned.has(`${account}|${threadId}`),
  });
  return { s, sent, owned, reply };
}

const codexHook = (over: Record<string, unknown> = {}) => ({
  provider: 'codex',
  account: '.codex',
  codexHome: '/u/.codex',
  session_id: CODEX_THREAD,
  cwd: '/p/loja',
  tool_name: 'Bash',
  tool_input: { command: 'npm test' },
  timeout_ms: 25_000,
  ...over,
});

function openParallel(s: PermissionServer, decisions: CodexDecision[] = ['accept', 'acceptForSession', 'decline', 'cancel']): string {
  const r = s.registry!.registerParallel({ key: '.codex:0', account: '.codex', threadId: CODEX_THREAD, tool: 'exec_command', input: { command: 'npm test' }, cwd: '/p/loja', decisions });
  if ('skip' in r) throw new Error(`pulou: ${r.skip}`);
  return r.id;
}

const decide = (s: PermissionServer, id: string, body: unknown) => request(s.base, `/api/permissions/${encodeURIComponent(id)}/decision`, { method: 'POST', body });

describe('/api/permissions com o canal paralelo', () => {
  it('hook do Codex numa thread do canal: 200 {skip: "parallel"} (sem 201) e nada registrado', async () => {
    const { s, owned } = await serve();
    owned.add(`.codex|${CODEX_THREAD}`);
    const r = await request(s.base, '/api/permissions', { method: 'POST', body: codexHook() });
    expect(r).toMatchObject({ status: 200, json: { skip: 'parallel' } });
    expect(s.registry!.size).toBe(0);
  });

  it('o hook.mjs numa thread do canal sai sem decidir, na hora', async () => {
    // Arrange
    const { s, owned } = await serve();
    owned.add(`.codex|${CODEX_THREAD}`);
    tmp = tempDir();
    const home = join(tmp.dir, 'home');
    const codexHome = join(home, '.codex');
    mkdirSync(codexHome, { recursive: true });
    const stdin = JSON.stringify({ session_id: CODEX_THREAD, turn_id: 'turn-1', cwd: '/p/loja', hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'npm test' } });

    // Act
    const t0 = Date.now();
    const out = await hook.run({ HOME: home, CODEX_HOME: codexHome, HABBLAUD_PORT: String(s.port) }, stdin);

    // Assert
    expect(out).toBeUndefined();
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(s.registry!.size).toBe(0);
  });

  it('a página vê o pedido parallel no snapshot e a decisão vai ao canal (forSession → acceptForSession); segunda decisão: 409', async () => {
    // Arrange
    const { s, sent } = await serve();
    const id = openParallel(s);

    // Act
    const snap = (await request(s.base, '/api/snapshot')).json as OfficeSnapshot;
    const dec = await decide(s, id, { behavior: 'allow', forSession: true });

    // Assert
    const agent = snap.agents.find((a) => a.id === CODEX_MAIN)!;
    expect(agent).toMatchObject({ status: 'waiting', permission: { id, provider: 'codex', mode: 'parallel', decisions: ['accept', 'acceptForSession', 'decline', 'cancel'] } });
    expect(dec).toMatchObject({ status: 200, json: { ok: true } });
    expect(sent).toEqual([['.codex:0', 'acceptForSession']]);
    expect((await decide(s, id, { behavior: 'deny' })).status).toBe(409);
  });

  it('decisão que o pedido não oferece: 400; canal indisponível: 503 (responda no terminal); já respondido lá: 404 e o cartão some', async () => {
    const { s, reply } = await serve();
    const id = openParallel(s, ['accept', 'decline']);
    const bad = await decide(s, id, { behavior: 'allow', forSession: true });
    expect(bad.status).toBe(400);
    expect(bad.json).toMatchObject({ error: expect.stringMatching(/não oferece/) });
    reply.value = 'unavailable';
    const down = await decide(s, id, { behavior: 'allow' });
    expect(down.status).toBe(503);
    expect(down.json).toMatchObject({ error: expect.stringMatching(/terminal/) });
    reply.value = 'gone';
    expect((await decide(s, id, { behavior: 'deny' })).status).toBe(404);
    const after = ((await request(s.base, '/api/snapshot')).json as OfficeSnapshot).agents.find((a) => a.id === CODEX_MAIN)!;
    expect(after.permission).toBeUndefined();
  });
});
