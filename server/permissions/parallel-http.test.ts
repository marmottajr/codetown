// Rotas de /api/permissions com o canal paralelo do Codex (contrato C4): o hook do Codex numa thread atendida pelo
// canal recebe 200 {skip: "parallel"} (sem 201) e o hook.mjs sai sem decidir; a página vê o pedido 'parallel' no
// snapshot e a decisão vai ao ParallelSink (200, 409, 400, 503 e 404). HOME e CODEX_HOME em pastas temporárias, e a
// chave do hook (~/.habblaud/codex-hook.key, server/codex/key.ts) sintética, no HOME temporário e no servidor de teste.
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CodexDecision, OfficeSnapshot } from '../../shared/types';
import { keyProof, NONCE_HEADER, PROOF_HEADER } from '../codex/key';
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

async function serve(opts: Parameters<typeof servePermissions>[0] = {}): Promise<{
  s: PermissionServer;
  sent: Array<[string, CodexDecision]>;
  owned: Set<string>;
  asked: string[];
  reply: { value: DecideReply };
}> {
  const s = (srv = await servePermissions({ codex: true, ...opts }));
  const sent: Array<[string, CodexDecision]> = [];
  const owned = new Set<string>();
  /** Cada consulta do registro ao canal (`conta|thread`): só chega aqui um pedido do hook que passou pela guarda. */
  const asked: string[] = [];
  const reply: { value: DecideReply } = { value: 'ok' };
  s.registry!.setParallelSink({
    decide: (key, decision) => {
      sent.push([key, decision]);
      return Promise.resolve(reply.value);
    },
    owns: (account, threadId) => (asked.push(`${account}|${threadId}`), owned.has(`${account}|${threadId}`)),
  });
  return { s, sent, owned, asked, reply };
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

  it('o hook.mjs numa thread do canal, com a chave nos dois lados, chega ao registro e recebe {skip: "parallel"} provado; sai sem decidir, na hora', async () => {
    // Arrange: a mesma chave (32 bytes) no HOME temporário, que o hook lê, e no servidor de teste, que a usa para provar.
    // Sem ela o hook sai antes de registrar e o teste passaria sem tocar o {skip: "parallel"}.
    const key = randomBytes(32);
    tmp = tempDir();
    const home = join(tmp.dir, 'home');
    const codexHome = join(home, '.codex');
    mkdirSync(codexHome, { recursive: true });
    mkdirSync(join(home, '.habblaud'), { recursive: true });
    writeFileSync(join(home, '.habblaud', 'codex-hook.key'), key);
    const events: Array<Record<string, unknown>> = [];
    const { s, owned, asked } = await serve({ codexHookKey: key, codexLive: { applyHookEvent: (_account, input) => (events.push(input), true) } });
    owned.add(`.codex|${CODEX_THREAD}`);
    const stdin = JSON.stringify({ session_id: CODEX_THREAD, turn_id: 'turn-1', cwd: '/p/loja', hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'npm test' } });
    // O hook roda neste processo: o fetch dele é espiado para ver, de cada chamada, o que o servidor respondeu e com que prova.
    const replies: Array<{ path: string; status: number; body: unknown; nonce: string | null; serverProof: string | null }> = [];
    const realFetch = globalThis.fetch;
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const res = await realFetch(input, init);
      replies.push({
        path: new URL(String(input)).pathname,
        status: res.status,
        body: await res.clone().json(),
        nonce: new Headers(init?.headers).get(NONCE_HEADER),
        serverProof: res.headers.get(PROOF_HEADER),
      });
      return res;
    });

    // Act
    const t0 = Date.now();
    let out: unknown;
    try {
      out = await hook.run({ HOME: home, CODEX_HOME: codexHome, HABBLAUD_PORT: String(s.port) }, stdin);
    } finally {
      spy.mockRestore();
    }
    const ms = Date.now() - t0;

    // Assert: o evento e o pedido chegaram ao servidor, e este perguntou ao canal (só um pedido do hook que passou pela guarda chega lá).
    expect(events).toHaveLength(1);
    expect(asked).toEqual([`.codex|${CODEX_THREAD}`]);
    // Cada resposta trouxe a prova do servidor para o nonce da própria chamada, e o registro respondeu 200 {skip: "parallel"} (sem 201).
    expect(replies.map((r) => [r.path, r.status])).toEqual([
      ['/api/codex/events', 200],
      ['/api/permissions', 200],
    ]);
    for (const r of replies) expect(r.serverProof).toBe(keyProof(key, 'server', r.nonce!));
    expect(replies[1].body).toEqual({ skip: 'parallel' });
    // O hook não decidiu (nada a imprimir), não registrou nada e saiu na hora.
    expect(out).toBeUndefined();
    expect(ms).toBeLessThan(1_000);
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
