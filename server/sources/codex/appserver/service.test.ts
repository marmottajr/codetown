// Serviço do canal paralelo do Codex (contrato C6, spec R2.8 e §8.2) contra o app-server FALSO da Tarefa 4 e um
// PermissionRegistry de verdade. Nenhum teste roda o codex: a conferência do daemon e o proxy são injetados (o proxy
// falso liga o stdio ao FakeAppServer). Cobre: pré-filtro pela pasta app-server-control/ e `daemon version` antes de
// abrir o proxy, assinatura (loaded/list, thread/started, resume sem overrides; no-rollout tenta de novo, not-daemon fica
// com o hook), pedidos de comando/arquivo virando 'parallel' com o id original na resposta, resolved, a queda do daemon
// com pedido aberto (Review Focus #3) e a corrida com o hook (Review Focus #4). Ids e caminhos sintéticos.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { codexAppServerOffReason, loadConfig } from '../../../config';
import { setQuiet } from '../../../log';
import { NameStore } from '../../../model/names';
import { Office } from '../../../model/office';
import { PermissionRegistry, type ParallelRequestInput } from '../../../permissions/registry';
import { FakeAppServer, rpcFail, until } from '../../../test/codex-fixtures-appserver';
import { BACKOFF_MAX_MS, BACKOFF_MIN_MS, CodexAppServerService, daemonRunning, DISCOVERY_MS, RESUME_RETRY_MS, spawnCodexProxy, type CodexProxy } from './service';

setQuiet(true);

const THREAD = '00000000-0000-7000-8000-0000000000a1';
const OTHER = '00000000-0000-7000-8000-0000000000a2';
const CHILD = '00000000-0000-7000-8000-0000000000a3';
const ACCOUNT = '.codex';
const MAIN = `${ACCOUNT}:${THREAD}`;
const BIN = 'codex-falso';
const COMMAND = 'item/commandExecution/requestApproval';
const FILE = 'item/fileChange/requestApproval';
const BASE = { turnId: 'turn-1', startedAtMs: 1_700_000_000_000 };

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

/** CODEX_HOME temporário (vazio), com ou sem a pasta do socket do daemon. */
function tempHome(withControl = true): string {
  const dir = mkdtempSync(join(tmpdir(), 'habblaud-appserver-'));
  if (withControl) mkdirSync(join(dir, 'app-server-control'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** App-server falso cujo thread/loaded/list devolve estas threads. */
function server(threads: string[]): FakeAppServer {
  const fake = new FakeAppServer();
  fake.handlers.set('thread/loaded/list', () => ({ data: threads, nextCursor: null }));
  return fake;
}

/** Proxy falso: o stdio é o do FakeAppServer; `die()` simula a saída do processo. */
interface FakeProxy extends CodexProxy {
  fake: FakeAppServer;
  bin: string;
  home: string;
  killed: boolean;
  die(): void;
}

function setup(opts: { daemon?: boolean; control?: boolean; threads?: string[]; codexBin?: string | null } = {}) {
  let now = 5_000_000;
  const clock = { now: () => now, advance: (ms: number) => (now += ms) };
  let registry: PermissionRegistry | undefined;
  const office = new Office({
    names: new NameStore(null),
    version: 't',
    startedAt: 0,
    accounts: () => [],
    sources: () => [],
    accountName: () => undefined,
    permissions: () => registry?.snapshot() ?? new Map(),
    now: clock.now,
  });
  office.addMain({ id: MAIN, provider: 'codex', account: ACCOUNT, sessionId: THREAD, cwd: '/p/loja', role: 'Agente principal', startedAt: 0, status: 'working' });
  registry = new PermissionRegistry({ office, viewers: () => 1, now: clock.now });
  const home = tempHome(opts.control ?? true);
  const accounts = [{ id: ACCOUNT, home }];
  const daemon = { up: opts.daemon ?? true, checks: [] as Array<[string, string]> };
  const proxies: FakeProxy[] = [];
  /** Próximos app-servers falsos (handshake recusado, resume com erro…); vazio = um que aceita e lista `threads`. */
  const queue: FakeAppServer[] = [];
  const logs: string[] = [];
  /** O que o serviço passou ao registerParallel (o registro de verdade recebe o mesmo). */
  const seen: ParallelRequestInput[] = [];
  const real = registry;
  const svc = new CodexAppServerService({
    accounts: () => accounts,
    registry: {
      registerParallel: (req) => {
        seen.push(req);
        return real.registerParallel(req);
      },
      resolveParallel: (key) => real.resolveParallel(key),
    },
    codexBin: opts.codexBin === null ? undefined : (opts.codexBin ?? BIN),
    version: '9.9.9',
    now: clock.now,
    log: (msg) => logs.push(msg),
    daemonCheck: async (bin, h) => {
      daemon.checks.push([bin, h]);
      return daemon.up;
    },
    spawnProxy: (bin, h) => {
      const fake = queue.shift() ?? server(opts.threads ?? [THREAD]);
      const exits: Array<() => void> = [];
      const proxy: FakeProxy = {
        fake,
        bin,
        home: h,
        killed: false,
        stdin: fake.fromClient,
        stdout: fake.toClient,
        kill: () => {
          proxy.killed = true;
        },
        on: (_ev, cb) => {
          exits.push(cb);
        },
        die: () => {
          for (const cb of exits.splice(0)) cb();
        },
      };
      proxies.push(proxy);
      return proxy;
    },
  });
  registry.setParallelSink(svc);
  cleanups.push(() => svc.stop());
  return { office, registry, clock, svc, home, accounts, daemon, proxies, queue, logs, seen };
}

type Setup = ReturnType<typeof setup>;

/** Liga e espera a assinatura da thread principal; devolve o app-server falso da conexão. */
async function connected(s: Setup): Promise<FakeAppServer> {
  s.svc.tick();
  await until(() => s.svc.owns(ACCOUNT, THREAD));
  return s.proxies[s.proxies.length - 1].fake;
}

const pendingOf = (s: Setup) => [...s.registry.snapshot()].map(([agentId, info]) => ({ agentId, ...info }));
const flush = () => new Promise<void>((ok) => setTimeout(ok, 30));

/** JSON do hook PermissionRequest do Codex (mod/habblaud-codex/hook.mjs) para a thread principal. */
function codexHook() {
  return { provider: 'codex', account: ACCOUNT, codexHome: '/u/.codex', session_id: THREAD, cwd: '/p/loja', tool_name: 'Bash', tool_input: { command: 'rm -rf build' }, timeout_ms: 25_000 };
}

describe('CodexAppServerService: daemon e conexão', () => {
  it('sem a pasta app-server-control/: nem confere o daemon nem abre o proxy; volta a olhar só depois de DISCOVERY_MS', async () => {
    // Arrange
    const s = setup({ control: false });

    // Act
    s.svc.tick();
    await flush();
    mkdirSync(join(s.home, 'app-server-control'));
    s.svc.tick();
    await flush();

    // Assert
    expect(s.daemon.checks).toEqual([]);
    expect(s.proxies).toHaveLength(0);
    s.clock.advance(DISCOVERY_MS);
    s.svc.tick();
    await until(() => s.proxies.length === 1);
    expect(s.daemon.checks).toEqual([[BIN, s.home]]);
  });

  it('daemon fora do ar (daemon version com código ≠ 0): não abre o proxy e só confere de novo depois de DISCOVERY_MS', async () => {
    // Arrange
    const s = setup({ daemon: false });

    // Act
    s.svc.tick();
    await until(() => s.daemon.checks.length === 1);
    await flush();
    s.svc.tick();
    await flush();

    // Assert
    expect(s.daemon.checks).toHaveLength(1);
    expect(s.proxies).toHaveLength(0);
    s.clock.advance(DISCOVERY_MS);
    s.svc.tick();
    await until(() => s.daemon.checks.length === 2);
    expect(s.proxies).toHaveLength(0);
  });

  it('daemon no ar: proxy com o binário e o CODEX_HOME da conta, initialize como habblaud, resume SEM overrides; owns só da thread assinada', async () => {
    // Arrange
    const s = setup();

    // Act
    const fake = await connected(s);

    // Assert
    expect(s.proxies.map((p) => [p.bin, p.home])).toEqual([[BIN, s.home]]);
    expect(fake.calls('initialize')[0].params).toMatchObject({ clientInfo: { name: 'habblaud', version: '9.9.9' } });
    expect(fake.calls('thread/resume').map((m) => m.params)).toEqual([{ threadId: THREAD, excludeTurns: true }]);
    expect(s.svc.owns(ACCOUNT, THREAD)).toBe(true);
    expect(s.svc.owns(ACCOUNT, OTHER)).toBe(false);
    expect(s.svc.owns('outra', THREAD)).toBe(false);
    expect(s.logs.some((l) => l.includes(ACCOUNT))).toBe(true);
  });

  it('sem codexBin: start não confere o daemon nem abre processo (só avisa)', async () => {
    // Arrange
    const s = setup({ codexBin: null });

    // Act
    s.svc.start();
    s.svc.tick();
    await flush();

    // Assert
    expect(s.daemon.checks).toEqual([]);
    expect(s.proxies).toHaveLength(0);
    expect(s.logs.join('\n')).toMatch(/HABBLAUD_CODEX_BIN/);
  });

  it('conta que sai da lista: mata o proxy e fecha os pedidos abertos (e, depois do stop, nada reconecta)', async () => {
    // Arrange
    const s = setup();
    const fake = await connected(s);
    fake.request(1, COMMAND, { threadId: THREAD, ...BASE, itemId: 'call-1', command: 'npm test' });
    await until(() => pendingOf(s).length === 1);

    // Act
    s.accounts.splice(0);
    s.svc.tick();

    // Assert
    expect(s.proxies[0].killed).toBe(true);
    expect(pendingOf(s)).toEqual([]);
    expect(s.svc.owns(ACCOUNT, THREAD)).toBe(false);
    s.svc.stop();
    s.accounts.push({ id: ACCOUNT, home: s.home });
    s.svc.tick();
    await flush();
    expect(s.proxies).toHaveLength(1);
  });

  it('stop com a conexão viva: mata o proxy, fecha o cartão aberto, owns fica falso e nada reconecta', async () => {
    // Arrange
    const s = setup();
    const fake = await connected(s);
    fake.request(9, COMMAND, { threadId: THREAD, ...BASE, itemId: 'call-9', command: 'npm test' });
    await until(() => pendingOf(s).length === 1);

    // Act
    s.svc.stop();

    // Assert
    expect(s.proxies[0].killed).toBe(true);
    expect(pendingOf(s)).toEqual([]);
    expect(s.svc.owns(ACCOUNT, THREAD)).toBe(false);
    s.clock.advance(BACKOFF_MAX_MS);
    s.svc.tick();
    await flush();
    expect(s.proxies).toHaveLength(1);
    expect(s.daemon.checks).toHaveLength(1);
  });
});

describe('CodexAppServerService: threads', () => {
  it('no-rollout tenta o resume de novo depois de RESUME_RETRY_MS; not-daemon (outro escritor) fica com o hook para sempre', async () => {
    // Arrange
    const s = setup();
    const fake = server([THREAD, OTHER]);
    let attempts = 0;
    fake.handlers.set('thread/resume', (p) => {
      attempts++;
      if (p.threadId === OTHER) rpcFail(-32600, `thread ${OTHER} already has an active writer`);
      if (attempts === 1) rpcFail(-32600, `no rollout found for thread id ${THREAD}`);
      return { thread: { id: p.threadId, source: 'cli' } };
    });
    s.queue.push(fake);

    // Act
    s.svc.tick();
    await until(() => fake.calls('thread/resume').length === 2);
    await flush();
    s.svc.tick();
    await flush();

    // Assert
    expect(fake.calls('thread/resume')).toHaveLength(2);
    expect(s.svc.owns(ACCOUNT, THREAD)).toBe(false);
    expect(s.svc.owns(ACCOUNT, OTHER)).toBe(false);
    s.clock.advance(RESUME_RETRY_MS);
    s.svc.tick();
    await until(() => s.svc.owns(ACCOUNT, THREAD));
    s.clock.advance(DISCOVERY_MS);
    s.svc.tick();
    await flush();
    expect(fake.calls('thread/resume').map((m) => (m.params as { threadId: string }).threadId)).toEqual([THREAD, OTHER, THREAD]);
    expect(s.svc.owns(ACCOUNT, OTHER)).toBe(false);
  });

  it('thread/loaded/list que falha com a conexão de pé: avisa uma vez e lista de novo depois de DISCOVERY_MS, sem derrubar a conexão', async () => {
    // Arrange: o daemon recusa a 1ª listagem (método desconhecido numa outra versão, ou o prazo do pedido).
    const s = setup();
    const fake = server([THREAD]);
    let lists = 0;
    fake.handlers.set('thread/loaded/list', () => {
      lists++;
      if (lists === 1) rpcFail(-32601, 'método desconhecido: thread/loaded/list');
      return { data: [THREAD], nextCursor: null };
    });
    s.queue.push(fake);

    // Act
    s.svc.tick();
    await until(() => s.logs.some((l) => l.includes('thread/loaded/list')));
    s.clock.advance(DISCOVERY_MS - 1);
    s.svc.tick();
    await flush();

    // Assert
    expect(fake.calls('thread/loaded/list')).toHaveLength(1);
    expect(s.svc.owns(ACCOUNT, THREAD)).toBe(false);
    s.clock.advance(1);
    s.svc.tick();
    await until(() => s.svc.owns(ACCOUNT, THREAD));
    expect(fake.calls('thread/loaded/list')).toHaveLength(2);
    expect(s.proxies).toHaveLength(1);
    expect(s.proxies[0].killed).toBe(false);
    expect(s.logs.filter((l) => l.includes('thread/loaded/list'))).toHaveLength(1);
  });

  it('thread/started → resume; thread/closed → a thread deixa a conexão e o cartão aberto dela fecha', async () => {
    // Arrange
    const s = setup({ threads: [] });
    s.svc.tick();
    await until(() => s.proxies.length === 1 && s.proxies[0].fake.calls('thread/loaded/list').length === 1);
    const fake = s.proxies[0].fake;

    // Act
    fake.notify('thread/started', { thread: { id: THREAD, source: 'cli' } });
    await until(() => s.svc.owns(ACCOUNT, THREAD));
    fake.request(4, COMMAND, { threadId: THREAD, ...BASE, itemId: 'call-4', command: 'npm test' });
    await until(() => pendingOf(s).length === 1);
    fake.notify('thread/closed', { threadId: THREAD });

    // Assert
    await until(() => pendingOf(s).length === 0);
    expect(s.svc.owns(ACCOUNT, THREAD)).toBe(false);
    expect(fake.calls('thread/resume').map((m) => m.params)).toEqual([{ threadId: THREAD, excludeTurns: true }]);
  });
});

describe('CodexAppServerService: pedidos de aprovação', () => {
  it('comando vira "parallel" (exec_command, decisões do pedido); a decisão do escritório volta com o id ORIGINAL; o resolved fecha o cartão', async () => {
    // Arrange
    const s = setup();
    const fake = await connected(s);

    // Act
    fake.request(0, COMMAND, {
      threadId: THREAD,
      ...BASE,
      itemId: 'call-0',
      command: 'npm test',
      cwd: '/p/loja',
      reason: 'rodar os testes',
      availableDecisions: ['accept', 'decline', { applyNetworkPolicyAmendment: {} }],
    });
    await until(() => pendingOf(s).length === 1);
    const p = pendingOf(s)[0];
    const decided = await s.registry.decide(p.id, { behavior: 'allow' });

    // Assert
    expect(p).toMatchObject({ agentId: MAIN, tool: 'exec_command', provider: 'codex', mode: 'parallel', decisions: ['accept', 'decline'], title: expect.stringContaining('npm test') });
    expect(decided).toBe('ok');
    await until(() => fake.responses().length === 1);
    expect(fake.responses()[0]).toEqual({ id: 0, result: { decision: 'accept' } });
    // O cartão só fecha com o resolved (a resposta pode ter perdido a corrida para o terminal).
    expect(pendingOf(s)).toHaveLength(1);
    fake.notify('serverRequest/resolved', { threadId: THREAD, requestId: 0 });
    await until(() => pendingOf(s).length === 0);
  });

  it('arquivo vira apply_patch com o patch do item (item/started); recusar = decline com o id string original', async () => {
    // Arrange
    const s = setup();
    const fake = await connected(s);
    fake.notify('item/started', {
      threadId: THREAD,
      ...BASE,
      item: { type: 'fileChange', id: 'patch-1', status: 'inProgress', changes: [{ path: 'src/app.ts', kind: { type: 'update', move_path: null }, diff: '@@\n-a\n+b' }] },
    });

    // Act
    fake.request('req-7', FILE, { threadId: THREAD, ...BASE, itemId: 'patch-1', grantRoot: '/p/loja/src' });
    await until(() => pendingOf(s).length === 1);
    const p = pendingOf(s)[0];
    const decided = await s.registry.decide(p.id, { behavior: 'deny' });

    // Assert
    expect(p).toMatchObject({ tool: 'apply_patch', mode: 'parallel', decisions: ['accept', 'acceptForSession', 'decline', 'cancel'] });
    expect(s.registry.detail(p.id)?.input).toContain('*** Update File: src/app.ts');
    expect(decided).toBe('ok');
    await until(() => fake.responses().length === 1);
    expect(fake.responses()[0]).toEqual({ id: 'req-7', result: { decision: 'decline' } });
  });

  it('respondido no terminal: o resolved fecha o cartão sem resposta daqui; decide depois (ou de chave desconhecida) = gone', async () => {
    // Arrange
    const s = setup();
    const fake = await connected(s);
    fake.request(2, COMMAND, { threadId: THREAD, ...BASE, itemId: 'call-2', command: 'npm test' });
    await until(() => pendingOf(s).length === 1);

    // Act
    fake.notify('serverRequest/resolved', { threadId: THREAD, requestId: 2 });
    await until(() => pendingOf(s).length === 0);

    // Assert
    expect(await s.svc.decide(`${ACCOUNT}:2`, 'accept')).toBe('gone');
    expect(await s.svc.decide(`${ACCOUNT}:99`, 'accept')).toBe('gone');
    expect(fake.responses()).toEqual([]);
  });

  it('subagente que o escritório não mostra: nenhum cartão e nenhuma resposta do Habblaud (vale o terminal)', async () => {
    // Arrange
    const s = setup();
    const fake = await connected(s);

    // Act
    fake.request(21, COMMAND, { threadId: CHILD, ...BASE, itemId: 'call-21', command: 'cargo build' });
    await flush();

    // Assert
    expect(pendingOf(s)).toEqual([]);
    expect(await s.svc.decide(`${ACCOUNT}:21`, 'accept')).toBe('gone');
    expect(fake.responses()).toEqual([]);
    // O pedido só chega a quem assina a thread: o hook dela sai sem decidir e o terminal atende.
    expect(s.svc.owns(ACCOUNT, CHILD)).toBe(true);
  });

  it('comando com o invólucro do shell: o cartão recebe o comando desembrulhado', async () => {
    // Arrange
    const s = setup();
    const fake = await connected(s);

    // Act
    fake.request(8, COMMAND, { threadId: THREAD, ...BASE, itemId: 'call-8', command: "pwsh.exe -NoProfile -Command 'git status'" });
    await until(() => pendingOf(s).length === 1);

    // Assert
    expect(s.seen.map((r) => r.input)).toEqual([{ command: 'git status' }]);
  });

  it('sem availableDecisions: o registro recebe as quatro decisões', async () => {
    // Arrange
    const s = setup();
    const fake = await connected(s);

    // Act
    fake.request(10, COMMAND, { threadId: THREAD, ...BASE, itemId: 'call-10', command: 'npm test' });
    await until(() => pendingOf(s).length === 1);

    // Assert
    expect(s.seen.map((r) => r.decisions)).toEqual([['accept', 'acceptForSession', 'decline', 'cancel']]);
    expect(pendingOf(s)[0].decisions).toEqual(['accept', 'acceptForSession', 'decline', 'cancel']);
  });

  it('availableDecisions sem nenhuma das quatro: nenhum cartão, uma linha no log (sem o comando) e o hook da thread sai sem decidir', async () => {
    // Arrange
    const s = setup();
    const fake = await connected(s);
    const before = s.logs.length;

    // Act
    fake.request(12, COMMAND, { threadId: THREAD, ...BASE, itemId: 'call-12', command: 'npm test', availableDecisions: [{ applyNetworkPolicyAmendment: {} }] });
    await until(() => s.logs.length > before);
    await flush();

    // Assert
    expect(s.seen).toEqual([]);
    expect(pendingOf(s)).toEqual([]);
    const lines = s.logs.slice(before);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(ACCOUNT);
    expect(lines[0]).not.toContain('npm test');
    expect(await s.svc.decide(`${ACCOUNT}:12`, 'accept')).toBe('gone');
    expect(s.registry.register(codexHook())).toEqual({ skip: 'parallel' });
  });
});

describe('CodexAppServerService: queda e corrida (Review Focus #3 e #4)', () => {
  it('daemon cai com um pedido aberto: o cartão fecha, owns fica falso e o próximo pedido da thread volta ao hook; reconecta com backoff 1 s → 2 s, de volta a 1 s depois de conectar', async () => {
    // Arrange
    const s = setup();
    const fake = await connected(s);
    fake.request(5, COMMAND, { threadId: THREAD, ...BASE, itemId: 'call-5', command: 'npm test' });
    await until(() => pendingOf(s).length === 1);

    // Act: o proxy sai (daemon caiu ou reiniciou).
    s.proxies[0].die();

    // Assert: nada pendurado, a thread volta ao hook.
    expect(pendingOf(s)).toEqual([]);
    expect(s.registry.size).toBe(0);
    expect(s.svc.owns(ACCOUNT, THREAD)).toBe(false);
    expect(s.proxies[0].killed).toBe(true);
    expect(await s.svc.decide(`${ACCOUNT}:5`, 'accept')).toBe('gone');
    const hook = s.registry.register(codexHook());
    expect(hook).toHaveProperty('id');
    expect(s.logs.join('\n')).toMatch(/caiu/);

    // Backoff: 1 s, depois 2 s (handshake recusado), e de volta a 1 s depois de uma conexão que deu certo.
    s.queue.push(new FakeAppServer({ handshake: 'refuse' }));
    s.clock.advance(BACKOFF_MIN_MS - 1);
    s.svc.tick();
    await flush();
    expect(s.proxies).toHaveLength(1);
    s.clock.advance(1);
    s.svc.tick();
    await until(() => s.proxies.length === 2 && s.proxies[1].killed);
    s.clock.advance(BACKOFF_MIN_MS);
    s.svc.tick();
    await flush();
    expect(s.proxies).toHaveLength(2);
    s.clock.advance(BACKOFF_MIN_MS);
    s.svc.tick();
    await until(() => s.proxies.length === 3 && s.svc.owns(ACCOUNT, THREAD));
    s.proxies[2].die();
    s.clock.advance(BACKOFF_MIN_MS);
    s.svc.tick();
    await until(() => s.proxies.length === 4);
  });

  it('fim do stdout do proxy sem exit: a conexão cai do mesmo jeito (proxy morto, cartão fechado)', async () => {
    // Arrange
    const s = setup();
    const fake = await connected(s);
    fake.request(6, COMMAND, { threadId: THREAD, ...BASE, itemId: 'call-6', command: 'npm test' });
    await until(() => pendingOf(s).length === 1);

    // Act
    fake.end();

    // Assert
    await until(() => s.proxies[0].killed);
    expect(pendingOf(s)).toEqual([]);
    expect(s.svc.owns(ACCOUNT, THREAD)).toBe(false);
  });

  it('corrida com o hook: o pedido do hook vira um cartão só ("parallel") e a resposta do escritório vai pelo canal; com a thread assinada, o hook sai sem decidir', async () => {
    // Arrange: o hook chegou antes de a thread ser assinada.
    const s = setup();
    const hook = s.registry.register(codexHook());
    if (!('id' in hook)) throw new Error('o hook deveria entrar');
    const fake = await connected(s);

    // Act
    fake.request(3, COMMAND, { threadId: THREAD, ...BASE, itemId: 'call-3', command: 'rm -rf build', cwd: '/p/loja' });
    await until(() => pendingOf(s)[0]?.mode === 'parallel');
    const p = pendingOf(s)[0];
    const decided = await s.registry.decide(p.id, { behavior: 'allow', forSession: true });

    // Assert
    expect(s.registry.size).toBe(1);
    expect(await s.registry.wait(hook.id, 0)?.result).toEqual({ status: 'released', reason: 'replaced' });
    expect(decided).toBe('ok');
    await until(() => fake.responses().length === 1);
    expect(fake.responses()[0]).toEqual({ id: 3, result: { decision: 'acceptForSession' } });
    expect(s.registry.register(codexHook())).toEqual({ skip: 'parallel' });
  });
});

describe('processos e configuração', () => {
  it('daemonRunning padrão: código ≠ 0 ou binário que não existe = sem daemon, sem lançar', async () => {
    // node app-server daemon version: não há script "app-server", então o node sai com código 1.
    expect(await daemonRunning(process.execPath, tempHome())).toBe(false);
    expect(await daemonRunning(join(tempHome(), 'nao-existe'), tempHome())).toBe(false);
  });

  it('spawnCodexProxy padrão: binário que não existe vira saída do proxy, sem derrubar o servidor', async () => {
    // Arrange
    const proxy = spawnCodexProxy(join(tempHome(), 'nao-existe'), tempHome());
    let exits = 0;

    // Act
    proxy.on('exit', () => exits++);
    await until(() => exits === 1);
    proxy.kill();
    await flush();

    // Assert
    expect(exits).toBe(1);
  });

  it('codexAppServerOffReason/loadConfig: ligado por padrão; HABBLAUD_CODEX_APPSERVER=0, HABBLAUD_CODEX=0, a trava do terminal e o Docker desligam', () => {
    // Arrange
    const home = tempHome(false);
    const cfg = (env: NodeJS.ProcessEnv) => loadConfig({ HOME: home, HABBLAUD_IN_DOCKER: '0', ...env }, []);

    // Assert
    expect(cfg({}).codexAppServer).toBe(true);
    expect(cfg({ HABBLAUD_CODEX_APPSERVER: '1' }).codexAppServer).toBe(true);
    for (const v of ['0', 'false', 'off']) {
      expect(cfg({ HABBLAUD_CODEX_APPSERVER: v }).codexAppServer).toBe(false);
      expect(codexAppServerOffReason({ HABBLAUD_CODEX_APPSERVER: v }, '127.0.0.1', false)).toBe(`HABBLAUD_CODEX_APPSERVER=${v}`);
    }
    expect(cfg({ HABBLAUD_CODEX: '0' }).codexAppServer).toBe(false);
    expect(cfg({ HABBLAUD_TERMINAL: '0' }).codexAppServer).toBe(false);
    expect(cfg({ HABBLAUD_HOST: '0.0.0.0' }).codexAppServer).toBe(false);
    expect(cfg({ HABBLAUD_IN_DOCKER: '1', HABBLAUD_HOST: '0.0.0.0', HABBLAUD_BIND: '127.0.0.1' })).toMatchObject({ terminal: true, codexAppServer: false });
    expect(codexAppServerOffReason({ HABBLAUD_CODEX: '0' }, '127.0.0.1', false)).toBe('HABBLAUD_CODEX=0');
    expect(codexAppServerOffReason({ HABBLAUD_BIND: '127.0.0.1' }, '0.0.0.0', true)).toMatch(/Docker/);
    expect(codexAppServerOffReason({}, '0.0.0.0', false)).toMatch(/^mesma trava do terminal: /);
    expect(codexAppServerOffReason({}, '127.0.0.1', false)).toBeUndefined();
  });
});
