// Cliente do app-server do Codex contra um app-server FALSO sobre streams em memória (nenhum teste roda o
// codex): handshake antes de qualquer frame, initialize com clientInfo e opt-out dos deltas, descoberta
// (loaded/list paginado, resume SEM overrides e as duas recusas -32600), pedidos de aprovação de comando e de
// arquivo (patch do item), resposta com o id original, resolved, pedidos que nunca são respondidos e queda.
import { afterEach, describe, expect, it } from 'vitest';
import { FakeAppServer, NO_REPLY, rpcFail, until } from '../../../test/codex-fixtures-appserver';
import { CodexAppServerClient, isGuardianThread, OPT_OUT_NOTIFICATIONS, patchFromChanges, type ApprovalRequest } from './client';

const THREAD = '00000000-0000-7000-8000-00000000000a';
const OTHER = '00000000-0000-7000-8000-00000000000b';
const CHILD = '00000000-0000-7000-8000-00000000000c';
const GUARD = '00000000-0000-7000-8000-00000000000d';
const COMMAND = 'item/commandExecution/requestApproval';
const FILE = 'item/fileChange/requestApproval';
const BASE = { turnId: 'turn-1', startedAtMs: 1_700_000_000_000 };

const clients: CodexAppServerClient[] = [];
afterEach(() => {
  for (const c of clients.splice(0)) c.close();
});

function make(fake: FakeAppServer) {
  const client = new CodexAppServerClient({ input: fake.toClient, output: fake.fromClient, clientName: 'habblaud', version: '9.9.9' });
  clients.push(client);
  const ev = { approvals: [] as ApprovalRequest[], resolved: [] as unknown[], started: [] as string[], threadClosed: [] as string[], closes: [] as string[] };
  client.on('approval', (a: ApprovalRequest) => ev.approvals.push(a));
  client.on('approvalResolved', (r: unknown) => ev.resolved.push(r));
  client.on('threadStarted', (id: string) => ev.started.push(id));
  client.on('threadClosed', (id: string) => ev.threadClosed.push(id));
  client.on('close', (reason: string) => ev.closes.push(reason));
  return { client, ev };
}

/** Cliente já com initialize/initialized feitos. */
async function ready(fake = new FakeAppServer()) {
  const made = make(fake);
  await made.client.start();
  await until(() => fake.calls('initialized').length === 1);
  return { fake, ...made };
}

const flush = () => new Promise<void>((ok) => setTimeout(ok, 30));

describe('funções puras do cliente', () => {
  it('patchFromChanges: add/update/delete, Move to e o diff de cada arquivo; sem mudanças, vazio', () => {
    // Arrange
    const changes = [
      { path: 'src/novo.ts', kind: { type: 'add' }, diff: '+export const x = 1;\n' },
      { path: 'src/app.ts', kind: { type: 'update', move_path: 'src/main.ts' }, diff: '@@\n-a\n+b' },
      { path: 'velho.txt', kind: { type: 'delete' }, diff: '' },
      { kind: { type: 'add' }, diff: '+sem caminho' },
    ];

    // Act
    const patch = patchFromChanges(changes);

    // Assert
    expect(patch.split('\n')).toEqual([
      '*** Begin Patch',
      '*** Add File: src/novo.ts',
      '+export const x = 1;',
      '*** Update File: src/app.ts',
      '*** Move to: src/main.ts',
      '@@',
      '-a',
      '+b',
      '*** Delete File: velho.txt',
      '*** End Patch',
    ]);
    expect(patchFromChanges(undefined)).toBe('');
    expect(patchFromChanges([])).toBe('');
  });

  it('isGuardianThread: subAgent.other, threadSource "guardian_review" e internal "guardian"', () => {
    expect(isGuardianThread({ source: { subAgent: { other: 'guardian' } } })).toBe(true);
    expect(isGuardianThread({ source: { subagent: { other: 'guardian' } } })).toBe(true);
    expect(isGuardianThread({ threadSource: 'guardian_review', source: 'appServer' })).toBe(true);
    expect(isGuardianThread({ source: { internal: 'guardian' } })).toBe(true);
    expect(isGuardianThread({ source: { subAgent: { thread_spawn: { parent_thread_id: THREAD, depth: 1 } } } })).toBe(false);
    expect(isGuardianThread({ source: 'cli' })).toBe(false);
    expect(isGuardianThread(undefined)).toBe(false);
  });
});

describe('CodexAppServerClient: conexão', () => {
  it('start: GET /rpc e nada mais antes do 101; depois initialize (clientInfo + opt-out) e initialized', async () => {
    // Arrange
    const fake = new FakeAppServer({ handshake: 'manual' });
    const { client } = make(fake);

    // Act
    const started = client.start();
    await until(() => fake.head.includes('\r\n\r\n'));
    await flush();

    // Assert: só o pedido de upgrade, sem nenhum frame antes do 101.
    expect(fake.head).toMatch(/^GET \/rpc HTTP\/1\.1\r\n/);
    expect(fake.head).toContain('Upgrade: websocket\r\n');
    expect(fake.head.indexOf('\r\n\r\n')).toBe(fake.head.length - 4);
    expect(fake.received).toEqual([]);
    fake.acceptHandshake();
    await started;
    await until(() => fake.received.length === 2);
    expect(client.start()).toBe(started);
    expect(fake.received[0]).toMatchObject({ method: 'initialize' });
    expect(fake.received[0].params).toEqual({ clientInfo: { name: 'habblaud', version: '9.9.9' }, capabilities: { optOutNotificationMethods: [...OPT_OUT_NOTIFICATIONS] } });
    expect(fake.received[1]).toEqual({ method: 'initialized' });
  });

  it('opt-out: nunca as notificações que o canal usa (threads, itens, patch e resolved)', () => {
    for (const used of ['thread/started', 'thread/closed', 'item/started', 'item/completed', 'item/fileChange/patchUpdated', 'serverRequest/resolved']) {
      expect(OPT_OUT_NOTIFICATIONS).not.toContain(used);
    }
    expect(OPT_OUT_NOTIFICATIONS.filter((m) => m.startsWith('thread/') && !m.startsWith('thread/realtime/'))).toEqual([]);
    expect(OPT_OUT_NOTIFICATIONS).toContain('item/agentMessage/delta');
    expect(OPT_OUT_NOTIFICATIONS).toContain('item/commandExecution/outputDelta');
  });

  it('handshake recusado: start rejeita e "close" sai uma vez só', async () => {
    // Arrange
    const fake = new FakeAppServer({ handshake: 'refuse' });
    const { client, ev } = make(fake);

    // Act
    const err = await client.start().catch((e: Error) => e);
    client.close();

    // Assert
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('handshake recusado: HTTP/1.1 403 Forbidden');
    expect(ev.closes).toEqual(['handshake recusado: HTTP/1.1 403 Forbidden']);
    expect(fake.received).toEqual([]);
  });

  it('initialize com erro: start rejeita, "close" com o motivo e nada de initialized', async () => {
    const fake = new FakeAppServer();
    fake.handlers.set('initialize', () => rpcFail(-32600, 'Not initialized'));
    const { client, ev } = make(fake);
    const err = await client.start().catch((e: Error) => e);
    expect((err as Error).message).toBe('initialize recusado (Not initialized)');
    expect(ev.closes).toEqual(['initialize recusado (Not initialized)']);
    expect(fake.calls('initialized')).toEqual([]);
  });

  it('antes do start (ou depois do close), os pedidos falham sem lançar fora da promessa', async () => {
    const fake = new FakeAppServer();
    const { client } = make(fake);
    await expect(client.listLoadedThreads()).rejects.toThrow(/sem conexão com o app-server/);
    await expect(client.resumeThread(THREAD)).resolves.toBe('error');
    await expect(client.unsubscribe(THREAD)).resolves.toBeUndefined();
    client.respond(0, 'accept');
    expect(fake.received).toEqual([]);
  });

  it('fim do stream sem close: "close" uma vez, pendentes rejeitados; respond e close() depois não fazem nada', async () => {
    // Arrange
    const { fake, client, ev } = await ready();
    fake.handlers.set('thread/loaded/list', () => NO_REPLY);
    fake.handlers.set('thread/resume', () => NO_REPLY);
    fake.request(1, COMMAND, { ...BASE, threadId: THREAD, itemId: 'call-1', command: 'npm test' });
    const listing = client.listLoadedThreads().catch((e: Error) => e.message);
    const resume = client.resumeThread(THREAD);
    await until(() => fake.calls('thread/resume').length === 1 && ev.approvals.length === 1);

    // Act
    fake.end();

    // Assert
    await expect(listing).resolves.toBe('conexão encerrada: o proxy do app-server fechou a saída');
    await expect(resume).resolves.toBe('error');
    client.respond(1, 'accept');
    client.close();
    await flush();
    expect(ev.closes).toEqual(['o proxy do app-server fechou a saída']);
    expect(fake.responses()).toEqual([]);
  });

  it('close do servidor e close() do cliente: "close" com o motivo, uma vez', async () => {
    const a = await ready();
    a.fake.closeWs();
    await until(() => a.ev.closes.length === 1);
    expect(a.ev.closes).toEqual(['o app-server fechou a conexão (1000)']);
    const b = await ready();
    b.client.close();
    b.client.close();
    await until(() => b.fake.clientClosed);
    expect(b.ev.closes).toEqual(['fechada pelo Habblaud']);
  });

  it('ouvinte que lança ao tratar uma mensagem: a conexão fecha com o motivo', async () => {
    const { fake, client, ev } = await ready();
    client.on('threadStarted', () => {
      throw new Error('bug do ouvinte');
    });
    fake.notify('thread/started', { thread: { id: THREAD, source: 'cli' } });
    await until(() => ev.closes.length === 1);
    expect(ev.closes).toEqual(['falha ao tratar mensagem do app-server (bug do ouvinte)']);
  });
});

describe('CodexAppServerClient: threads', () => {
  it('listLoadedThreads: pagina por cursor/nextCursor e junta os ids', async () => {
    // Arrange
    const { fake, client } = await ready();
    fake.handlers.set('thread/loaded/list', (p) => (p.cursor === 'c1' ? { data: [OTHER, THREAD], nextCursor: null } : { data: [THREAD, CHILD], nextCursor: 'c1' }));

    // Act
    const ids = await client.listLoadedThreads();

    // Assert
    expect(ids).toEqual([THREAD, CHILD, OTHER]);
    expect(fake.calls('thread/loaded/list').map((m) => m.params)).toEqual([{ limit: 100 }, { cursor: 'c1', limit: 100 }]);
  });

  it('resumeThread: só threadId e excludeTurns (sem overrides); as duas -32600 se distinguem pela mensagem', async () => {
    // Arrange
    const { fake, client } = await ready();
    fake.handlers.set('thread/resume', (p) => {
      if (p.threadId === OTHER) return rpcFail(-32600, `no rollout found for thread id ${OTHER}`);
      if (p.threadId === CHILD) return rpcFail(-32600, `thread ${CHILD} already has an active writer`);
      if (p.threadId === GUARD) return rpcFail(-32603, 'erro interno');
      return { thread: { id: p.threadId, source: 'cli' }, approvalPolicy: 'on-request' };
    });

    // Act
    const results = [await client.resumeThread(THREAD), await client.resumeThread(OTHER), await client.resumeThread(CHILD), await client.resumeThread(GUARD)];

    // Assert
    expect(results).toEqual(['ok', 'no-rollout', 'not-daemon', 'error']);
    expect(fake.calls('thread/resume').map((m) => m.params)).toEqual([THREAD, OTHER, CHILD, GUARD].map((threadId) => ({ threadId, excludeTurns: true })));
  });

  it('-32600 com outra mensagem, ou a mensagem certa com outro código: "error"', async () => {
    const { fake, client } = await ready();
    fake.handlers.set('thread/resume', (p) => (p.threadId === THREAD ? rpcFail(-32600, 'Not initialized') : rpcFail(-32000, 'no rollout found')));
    expect(await client.resumeThread(THREAD)).toBe('error');
    expect(await client.resumeThread(OTHER)).toBe('error');
  });

  it('resumeThread de uma thread guardian: tira a inscrição e devolve "not-daemon"', async () => {
    const { fake, client } = await ready();
    fake.handlers.set('thread/resume', (p) => ({ thread: { id: p.threadId, source: { subAgent: { other: 'guardian' } } } }));
    expect(await client.resumeThread(GUARD)).toBe('not-daemon');
    expect(fake.calls('thread/unsubscribe').map((m) => m.params)).toEqual([{ threadId: GUARD }]);
  });

  it('unsubscribe: manda { threadId }; erro do servidor não lança', async () => {
    const { fake, client } = await ready();
    await client.unsubscribe(THREAD);
    fake.handlers.set('thread/unsubscribe', () => rpcFail(-32600, 'thread not loaded'));
    await expect(client.unsubscribe(OTHER)).resolves.toBeUndefined();
    expect(fake.calls('thread/unsubscribe').map((m) => m.params)).toEqual([{ threadId: THREAD }, { threadId: OTHER }]);
  });

  it('thread/started vira "threadStarted" (guardian fica de fora); thread/closed vira "threadClosed"', async () => {
    // Arrange
    const { fake, ev } = await ready();

    // Act
    fake.notify('thread/started', { thread: { id: THREAD, source: 'cli' } });
    fake.notify('thread/started', { thread: { id: GUARD, source: { subAgent: { other: 'guardian' } } } });
    fake.notify('thread/started', { thread: { id: OTHER, threadSource: 'guardian_review', source: { subAgent: { thread_spawn: { parent_thread_id: THREAD, depth: 1 } } } } });
    fake.notify('thread/started', { thread: { id: CHILD, source: { subAgent: { thread_spawn: { parent_thread_id: THREAD, depth: 1, agent_role: 'worker' } } } } });
    fake.notify('thread/started', { thread: { source: 'cli' } });
    fake.notify('thread/closed', { threadId: CHILD });
    await until(() => ev.threadClosed.length === 1);

    // Assert
    expect(ev.started).toEqual([THREAD, CHILD]);
    expect(ev.threadClosed).toEqual([CHILD]);
  });
});

describe('CodexAppServerClient: aprovações', () => {
  it('pedido de comando vira "approval"; respond leva o id ORIGINAL (0 número e "0" string são pedidos distintos)', async () => {
    // Arrange
    const { fake, client, ev } = await ready();

    // Act
    fake.request(0, COMMAND, {
      ...BASE,
      threadId: THREAD,
      itemId: 'call-1',
      command: 'npm test',
      cwd: '/p/loja',
      reason: 'rodar os testes',
      commandActions: [],
      availableDecisions: ['accept', 'acceptForSession', { applyNetworkPolicyAmendment: { network_policy_amendment: {} } }, 'decline', 'cancel'],
    });
    fake.request('0', COMMAND, { ...BASE, threadId: OTHER, itemId: 'call-2', command: 'ls' });
    await until(() => ev.approvals.length === 2);
    client.respond('0', 'decline');
    client.respond(0, 'acceptForSession');
    client.respond(0, 'accept');
    await until(() => fake.responses().length === 2);
    await flush();

    // Assert
    expect(ev.approvals).toEqual([
      { requestId: 0, threadId: THREAD, kind: 'command', command: 'npm test', cwd: '/p/loja', reason: 'rodar os testes', decisions: ['accept', 'acceptForSession', 'decline', 'cancel'] },
      { requestId: '0', threadId: OTHER, kind: 'command', command: 'ls' },
    ]);
    expect(fake.responses()).toEqual([
      { id: '0', result: { decision: 'decline' } },
      { id: 0, result: { decision: 'acceptForSession' } },
    ]);
  });

  it('pedido de arquivo: o patch vem do item fileChange (item/started, atualizado por patchUpdated); reason do grantRoot', async () => {
    // Arrange
    const { fake, ev } = await ready();
    const update = { path: 'src/app.ts', kind: { type: 'update', move_path: null }, diff: '@@\n-a\n+b' };

    // Act
    fake.notify('item/started', { ...BASE, threadId: THREAD, item: { type: 'fileChange', id: 'patch-1', status: 'inProgress', changes: [update] } });
    fake.notify('item/fileChange/patchUpdated', { ...BASE, threadId: THREAD, itemId: 'patch-1', changes: [update, { path: 'src/novo.ts', kind: { type: 'add' }, diff: '+x\n' }] });
    fake.request('req-7', FILE, { ...BASE, threadId: THREAD, itemId: 'patch-1', grantRoot: '/p/loja/src' });
    fake.request('req-8', FILE, { ...BASE, threadId: OTHER, itemId: 'patch-1', reason: 'escrever fora do projeto', grantRoot: '/tmp' });
    await until(() => ev.approvals.length === 2);

    // Assert
    expect(ev.approvals).toEqual([
      {
        requestId: 'req-7',
        threadId: THREAD,
        kind: 'fileChange',
        reason: 'pede para escrever em /p/loja/src',
        patch: ['*** Begin Patch', '*** Update File: src/app.ts', '@@', '-a', '+b', '*** Add File: src/novo.ts', '+x', '*** End Patch'].join('\n'),
      },
      { requestId: 'req-8', threadId: OTHER, kind: 'fileChange', reason: 'escrever fora do projeto' },
    ]);
  });

  it('item/completed esquece o patch do item', async () => {
    const { fake, ev } = await ready();
    const item = { type: 'fileChange', id: 'patch-2', status: 'inProgress', changes: [{ path: 'a.txt', kind: { type: 'add' }, diff: '+a' }] };
    fake.notify('item/started', { ...BASE, threadId: THREAD, item });
    fake.notify('item/completed', { ...BASE, threadId: THREAD, item: { ...item, status: 'completed' } });
    fake.request(9, FILE, { ...BASE, threadId: THREAD, itemId: 'patch-2' });
    await until(() => ev.approvals.length === 1);
    expect(ev.approvals[0]).toEqual({ requestId: 9, threadId: THREAD, kind: 'fileChange' });
  });

  it('serverRequest/resolved vira "approvalResolved" ({ requestId }), respondido aqui ou não; respond depois é ignorado', async () => {
    // Arrange
    const { fake, client, ev } = await ready();
    fake.request(5, COMMAND, { ...BASE, threadId: THREAD, itemId: 'call-5', command: 'npm test' });
    fake.request(6, COMMAND, { ...BASE, threadId: THREAD, itemId: 'call-6', command: 'npm run build' });
    await until(() => ev.approvals.length === 2);

    // Act
    client.respond(6, 'accept');
    fake.notify('serverRequest/resolved', { threadId: THREAD, requestId: 5 });
    fake.notify('serverRequest/resolved', { threadId: THREAD, requestId: 6 });
    fake.notify('serverRequest/resolved', { threadId: THREAD, requestId: 99 });
    await until(() => ev.resolved.length === 2);
    client.respond(5, 'accept');
    await flush();

    // Assert
    expect(ev.resolved).toEqual([{ requestId: 5 }, { requestId: 6 }]);
    expect(fake.responses()).toEqual([{ id: 6, result: { decision: 'accept' } }]);
  });

  it('replay do resume: o mesmo id pendente gera um "approval" só', async () => {
    const { fake, ev } = await ready();
    const params = { ...BASE, threadId: THREAD, itemId: 'call-3', command: 'cargo build' };
    fake.request(3, COMMAND, params);
    fake.request(3, COMMAND, params);
    fake.request(4, COMMAND, params);
    await until(() => ev.approvals.length === 2);
    await flush();
    expect(ev.approvals.map((a) => a.requestId)).toEqual([3, 4]);
  });

  it('outros pedidos do servidor: nenhum evento e NUNCA respondidos, nem por respond; decisão fora das quatro também não', async () => {
    // Arrange
    const { fake, client, ev } = await ready();
    const others = [
      'item/tool/requestUserInput',
      'item/permissions/requestApproval',
      'item/tool/call',
      'account/chatgptAuthTokens/refresh',
      'attestation/generate',
      'mcpServer/elicitation/request',
      'execCommandApproval',
      'applyPatchApproval',
    ];

    // Act
    others.forEach((method, i) => fake.request(10 + i, method, { ...BASE, threadId: THREAD, itemId: `x-${i}` }));
    fake.request(30, COMMAND, { ...BASE, itemId: 'sem-thread', command: 'ls' });
    fake.request(31, COMMAND, { ...BASE, threadId: THREAD, itemId: 'call-31', command: 'ls' });
    await until(() => ev.approvals.length === 1);
    others.forEach((_, i) => client.respond(10 + i, 'accept'));
    client.respond(30, 'accept');
    client.respond(31, 'acceptWithExecpolicyAmendment' as never);
    await flush();

    // Assert
    expect(ev.approvals.map((a) => a.requestId)).toEqual([31]);
    expect(fake.responses()).toEqual([]);
  });

  it('thread/closed e unsubscribe fecham os pedidos abertos daquela thread (o resolved dela não vem mais)', async () => {
    // Arrange
    const { fake, client, ev } = await ready();
    fake.request(40, COMMAND, { ...BASE, threadId: THREAD, itemId: 'call-40', command: 'ls' });
    fake.request(41, COMMAND, { ...BASE, threadId: CHILD, itemId: 'call-41', command: 'ls' });
    fake.request(42, COMMAND, { ...BASE, threadId: OTHER, itemId: 'call-42', command: 'ls' });
    await until(() => ev.approvals.length === 3);

    // Act
    fake.notify('thread/closed', { threadId: THREAD });
    await until(() => ev.threadClosed.length === 1);
    await client.unsubscribe(CHILD);
    client.respond(40, 'accept');
    client.respond(41, 'accept');
    await flush();

    // Assert
    expect(ev.resolved).toEqual([{ requestId: 40 }, { requestId: 41 }]);
    expect(fake.responses()).toEqual([]);
  });

  it('pedido que chega durante o unsubscribe (antes da resposta) não fica aberto, nem depois dela', async () => {
    // Arrange: o app-server manda o pedido da thread depois do unsubscribe do cliente e antes de respondê-lo.
    const { fake, client, ev } = await ready();
    const openIds = () => ev.approvals.filter((a) => !ev.resolved.some((r) => (r as { requestId: unknown }).requestId === a.requestId)).map((a) => a.requestId);
    fake.handlers.set('thread/unsubscribe', (p) => {
      fake.request(50, COMMAND, { ...BASE, threadId: p.threadId, itemId: 'call-50', command: 'ls' });
      return { status: 'unsubscribed' };
    });

    // Act
    await client.unsubscribe(THREAD);
    fake.request(51, FILE, { ...BASE, threadId: THREAD, itemId: 'item-51' });
    await flush();
    client.respond(50, 'accept');
    client.respond(51, 'accept');
    await flush();

    // Assert
    expect(openIds()).toEqual([]);
    expect(fake.responses()).toEqual([]);
  });

  it('resumeThread volta a seguir a thread: o pedido dela volta a virar cartão', async () => {
    // Arrange
    const { fake, client, ev } = await ready();
    await client.unsubscribe(THREAD);
    fake.request(60, COMMAND, { ...BASE, threadId: THREAD, itemId: 'call-60', command: 'ls' });
    await flush();
    expect(ev.approvals).toEqual([]);

    // Act
    await expect(client.resumeThread(THREAD)).resolves.toBe('ok');
    fake.request(61, COMMAND, { ...BASE, threadId: THREAD, itemId: 'call-61', command: 'ls' });
    await until(() => ev.approvals.length === 1);
    client.respond(61, 'accept');
    await until(() => fake.responses().length === 1);

    // Assert
    expect(ev.approvals.map((a) => a.requestId)).toEqual([61]);
    expect(fake.responses()).toEqual([{ id: 61, result: { decision: 'accept' } }]);
  });
});
