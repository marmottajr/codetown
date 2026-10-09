// Interpretação dos rollouts do Codex (linhas sintéticas nos formatos paginated e legacy).
import { describe, expect, it } from 'vitest';
import { R, SOURCES, threadId } from '../../test/codex-fixtures';
import {
  commandText,
  createCodexState,
  describeCodexTool,
  fileChanges,
  metaFromLine,
  parseRolloutLine,
  parseSessionMeta,
  patchFiles,
  pathFromUri,
  usageFromRateLimits,
  type CodexLineResult,
  type CodexState,
} from './rollout';

const T = threadId(1);
const ctx = { idPrefix: 'acc:t', now: 0 };

function feed(lines: string[], state: CodexState = createCodexState()): { state: CodexState; results: CodexLineResult[] } {
  const results = lines.map((l) => parseRolloutLine(state, l, ctx));
  return { state, results };
}

const texts = (results: CodexLineResult[]) => results.flatMap((r) => r.activities.map((a) => a.activity.text));
const ids = (results: CodexLineResult[]) => results.flatMap((r) => r.activities.map((a) => a.activity.id));

describe('rollout do Codex: paginated', () => {
  it('conversa sai dos item_completed; contexto injetado (response_item message) fica de fora', () => {
    const at = Date.parse('2026-10-09T12:00:00Z');
    const { state, results } = feed([
      R.meta(T, { at }),
      R.message('developer', '<permissions instructions> segredo do sistema'),
      R.message('user', '<environment_context>cwd</environment_context>'),
      R.taskStarted('turn1', at + 1),
      R.user(T, 'turn1', 'u1', 'Arrume o teste quebrado da loja', at + 2),
      R.reasoning(T, 'turn1', 'r1', ['Lendo os testes'], at + 3),
      R.reasoning(T, 'turn1', 'r2', ['Ainda pensando'], at + 4),
      R.agent(T, 'turn1', 'a1', 'Corrigi o teste.', at + 5),
      R.taskComplete('turn1', at + 6, 6_000),
    ]);
    expect(texts(results)).toEqual(['Recebeu “Arrume o teste quebrado da loja”', 'Pensando…', 'Escrevendo a resposta', 'Concluiu em 6s']);
    expect(ids(results)).toEqual(['acc:t#u1', 'acc:t#r1', 'acc:t#a1', 'acc:t#turn1:done']);
    expect(results.find((r) => r.activities[0]?.activity.kind === 'prompt')?.activities[0].activity.kind).toBe('prompt');
    expect(state.title).toBe('Arrume o teste quebrado da loja');
    expect(state.mode).toBe('paginated');
    expect(state.gitBranch).toBe('main');
    expect(state.turnOpen).toBe(false);
    const signals = results.flatMap((r) => r.signals.map((s) => s.type));
    expect(signals).toContain('turnStart');
    expect(signals).toContain('turnEnd');
  });

  it('comando: as mesmas atividades do Bash, comando em lista ou texto, erro e recusa', () => {
    const { results, state } = feed([
      R.command(T, 't', 'call_1', 'npm test', { output: 'ok' }),
      R.command(T, 't', 'call_2', 'git push origin main', { exit: 1, output: 'rejected\n' }),
      R.command(T, 't', 'call_3', 'rm -rf build', { status: 'declined' }),
    ]);
    const acts = results.flatMap((r) => r.activities.map((a) => a.activity));
    expect(acts.map((a) => [a.id, a.text, a.tool])).toEqual([
      ['acc:t#call_1', 'Rodando testes', 'Bash'],
      ['acc:t#call_2', 'Enviando commits (git push)', 'Bash'],
      ['acc:t#call_2:e', 'Erro em Bash', 'Bash'],
      ['acc:t#call_3', 'Organizando arquivos', 'Bash'],
      ['acc:t#call_3:r', 'Você recusou: Bash', undefined],
    ]);
    expect(acts[0].detail).toBe('npm test');
    expect(state.stats.toolCalls).toBe(3);
    expect(commandText(['/bin/bash', '-c', 'ls -la'])).toBe('ls -la');
    expect(commandText(['git', 'commit', '-m', 'uma mensagem'])).toBe("git commit -m 'uma mensagem'");
    expect(commandText('  echo oi ')).toBe('echo oi');
  });

  it('atividade em andamento (function_call sem saída) e o item concluído não duplicam (mesmo call_id)', () => {
    const { results: all, state } = feed([
      R.meta(T),
      R.functionCall('call_9', 'exec_command', { cmd: 'npm run build', yield_time_ms: 10_000 }),
      R.customToolCall('call_x', 'exec', 'await tools.exec_command({cmd: "ls"})'),
    ]);
    const results = all.slice(1);
    expect(results[0].activities[0].activity).toMatchObject({ id: 'acc:t#call_9', text: 'Compilando o projeto', tool: 'Bash' });
    expect(results[1].activities[0].activity).toMatchObject({ id: 'acc:t#call_x', text: 'Executando código' });
    expect([...state.pending.keys()]).toEqual(['call_9', 'call_x']);
    const done = parseRolloutLine(state, R.command(T, 't', 'call_9', 'npm run build'), ctx);
    expect(done.activities[0].activity.id).toBe('acc:t#call_9');
    expect(state.pending.has('call_9')).toBe(false);
    // No paginated, só o item concluído conta como ferramenta.
    expect(state.stats.toolCalls).toBe(1);
  });

  it('mudanças de arquivo (mapa do rollout ou lista), apply_patch, MCP e plano', () => {
    const { results, state } = feed([
      R.fileChange(T, 't', 'call_p', {
        '/projetos/loja/src/app.ts': { type: 'update', unified_diff: '@@ -1 +1 @@\n-a\n+b\n', move_path: null },
        '/projetos/loja/src/novo.ts': { type: 'add', content: 'export {}\n' },
      }),
      R.mcp(T, 't', 'call_m', 'github', 'create_pull_request', { owner: 'o', repo: 'r', title: 'x' }, { result: '{"number": 7, "html_url": "https://github.com/o/r/pull/7"}' }),
      R.functionCall('call_plan', 'update_plan', { plan: [{ step: 'Ler o código', status: 'completed' }, { step: 'Corrigir', status: 'in_progress' }] }),
    ]);
    const acts = results.flatMap((r) => r.activities.map((a) => a.activity));
    expect(acts.map((a) => [a.id, a.text])).toEqual([
      ['acc:t#call_p', 'Editando app.ts'],
      ['acc:t#call_p:1', 'Escrevendo novo.ts'],
      ['acc:t#call_m', 'GitHub: create pull request'],
      ['acc:t#call_plan', 'Atualizando o plano'],
    ]);
    expect(acts[2].tool).toBe('mcp__github__create_pull_request');
    expect(state.tasks).toEqual([
      { id: '1', title: 'Ler o código', status: 'completed' },
      { id: '2', title: 'Corrigir', status: 'in_progress' },
    ]);
    expect(results[1].signals.find((s) => s.type === 'github')).toMatchObject({ event: { kind: 'pr_opened', number: 7, repo: 'o/r' }, key: 'call_m' });
    expect(fileChanges([{ path: '/x/a.ts', kind: 'add', diff: 'oi' }])).toEqual([{ path: '/x/a.ts', kind: 'add', text: 'oi' }]);
    expect(patchFiles('*** Begin Patch\n*** Update File: src/a.ts\n@@\n*** Add File: src/b.ts\n+x\n*** End Patch')).toEqual([
      { path: 'src/a.ts', kind: 'update' },
      { path: 'src/b.ts', kind: 'add' },
    ]);
    expect(describeCodexTool('apply_patch', { command: '*** Begin Patch\n*** Add File: docs/x.md\n+oi\n*** End Patch' })).toMatchObject({ tool: 'Write', desc: { text: 'Escrevendo x.md' } });
    expect(describeCodexTool('Bash', { command: 'pytest -q' }).desc.text).toBe('Rodando testes');
    expect(describeCodexTool('create_issue', {}, 'mcp__github__').tool).toBe('mcp__github__create_issue');
  });

  it('code mode do app: a mensagem enviada a você (user_messaging) é a resposta, sem duplicar com a entrega gravada', () => {
    const { results } = feed([
      R.meta(T),
      R.customToolCall('call_js', 'exec', 'await tools.user_messaging.send_message({text: "Achei o bug"})'),
      R.delivered('call_msg', 'Achei o bug no checkout'),
      R.mcp(T, 't', 'call_msg', 'codex_apps', 'user_messaging_send_message', { text: 'Achei o bug no checkout' }, { result: 'ok' }),
      R.delivered('call_cut', 'Texto cortado', Date.now(), false),
    ]);
    const acts = results.flatMap((r) => r.activities.map((a) => a.activity));
    expect(acts.map((a) => [a.id, a.text, a.detail])).toEqual([
      ['acc:t#call_js', 'Executando código', undefined],
      ['acc:t#call_msg', 'Escrevendo a resposta', 'Achei o bug no checkout'],
      // O item concluído tem o mesmo id: o escritório não duplica.
      ['acc:t#call_msg', 'Escrevendo a resposta', 'Achei o bug no checkout'],
      ['acc:t#call_cut', 'Escrevendo a resposta', 'Texto cortado'],
    ]);
  });

  it('uso do plano: só a cota padrão (outro limit_id fica de fora)', () => {
    const rl = { ...R.rateLimits({}), limit_id: 'codex_outro_modelo' };
    expect(usageFromRateLimits(rl, 1)).toBeUndefined();
    expect(usageFromRateLimits({ ...rl, limit_id: null }, 1)).toMatchObject({ fiveHour: { utilization: 12.5 } });
  });

  it('GitHub: o push que deu certo vira evento; o que falhou, não', () => {
    const ok = 'To github.com:o/r.git\n   abc1234..def5678  main -> main\n';
    const rejected = 'To github.com:o/r.git\n ! [rejected]        main -> main (fetch first)\nerror: failed to push some refs\n';
    const { results } = feed([R.command(T, 't', 'c1', 'git push', { output: ok }), R.command(T, 't', 'c2', 'git push', { exit: 1, output: rejected })]);
    expect(results[0].signals).toContainEqual({ type: 'github', event: { kind: 'push', branch: 'main' }, key: 'c1' });
    expect(results[1].signals.some((s) => s.type === 'github')).toBe(false);
  });

  it('tokens: total cumulativo, sem somar o cache de novo', () => {
    const { state } = feed([R.tokens({ input: 1_000, cached: 800, output: 50 }), R.tokens({ input: 3_000, cached: 2_500, output: 120, reasoning: 60 })]);
    expect(state.stats.tokensIn).toBe(3_000);
    expect(state.stats.tokensOut).toBe(120);
  });

  it('uso do plano: janela pela duração, idade da linha e sem cota', () => {
    const at = Date.parse('2026-10-09T12:00:00Z');
    // Posições trocadas: vale a duração (10080 = semana).
    const swapped = usageFromRateLimits(R.rateLimits({ primary: { used: 70, minutes: 10080, resetsAt: 1_900_000_000 }, secondary: { used: 5.5, minutes: 300 } }), at);
    expect(swapped).toEqual({ source: 'codex', fetchedAt: at, sevenDay: { utilization: 70, resetsAt: 1_900_000_000_000 }, fiveHour: { utilization: 5.5, resetsAt: 2_000_000_000_000 } });
    const none = usageFromRateLimits(R.rateLimits({ primary: null, secondary: null, reached: 'workspace_owner_credits_depleted' }), at);
    expect(none).toEqual({ source: 'codex', fetchedAt: at, noQuota: true });
    expect(usageFromRateLimits(R.rateLimits({ primary: null, secondary: null }), at)).toBeUndefined();
    const { state, results } = feed([R.tokens({ input: 1, output: 1, at, rateLimits: { plan: 'pro' } })]);
    expect(state.planType).toBe('pro');
    expect(results[0].signals).toContainEqual({ type: 'usage', usage: expect.objectContaining({ fetchedAt: at, fiveHour: { utilization: 12.5, resetsAt: 2_000_000_000_000 } }), plan: 'pro' });
  });

  it('turno interrompido e ids estáveis numa releitura (inclusive sem id próprio)', () => {
    // Sem session_meta na janela, o formato ainda não é conhecido: a resposta legacy vale.
    const lines = [R.taskStarted('t9'), R.turnAborted('t9'), R.legacyAgent('x')];
    const a = feed(lines);
    const b = feed(lines);
    expect(texts(a.results)).toEqual(['Interrompido por você', 'Escrevendo a resposta']);
    expect(ids(a.results)).toEqual(ids(b.results));
    expect(a.state.turnOpen).toBe(false);
  });
});

describe('rollout do Codex: legacy', () => {
  it('o básico: prompt, raciocínio, resposta e comando concluído (function_call + saída)', () => {
    const { results, state } = feed([
      R.meta(T, { history: null }),
      R.legacyUser('Liste os arquivos'),
      R.legacyReasoning('pensando'),
      R.functionCall('c1', 'shell', { command: ['bash', '-lc', 'ls -la'] }),
      R.functionOutput('c1', JSON.stringify({ output: 'erro', metadata: { exit_code: 2 } })),
      R.legacyAgent('Pronto, listei.'),
      // Num legacy, item_completed de UserMessage não existe; se aparecer, não duplica a conversa por isso.
    ]);
    expect(state.mode).toBe('legacy');
    expect(texts(results)).toEqual(['Recebeu “Liste os arquivos”', 'Pensando…', 'Explorando pastas', 'Erro em Bash', 'Escrevendo a resposta']);
    expect(state.stats.toolCalls).toBe(1);
    expect(state.title).toBe('Liste os arquivos');
  });

  it('eventos legacy são ignorados num rollout paginated', () => {
    const { results } = feed([R.meta(T), R.legacyUser('duplicado'), R.legacyAgent('duplicado')]);
    expect(texts(results)).toEqual([]);
  });
});

describe('session_meta', () => {
  const meta = (source: unknown, extra: Record<string, unknown> = {}) =>
    parseSessionMeta({ id: T, session_id: T, cwd: '/p', source, history_mode: 'paginated', ...extra });

  it('subagente (thread_spawn), internos e fontes comuns', () => {
    const parent = threadId(2);
    expect(meta(SOURCES.sub(parent))).toMatchObject({ parentThreadId: parent, agentRole: 'explorer', agentNickname: 'Kepler', internal: false });
    // A chave já apareceu como subAgent (camelCase) na documentação: as duas valem.
    expect(meta({ subAgent: { threadSpawn: { parent_thread_id: parent } } }).parentThreadId).toBe(parent);
    expect(meta(SOURCES.guardian()).internal).toBe(true);
    expect(meta(SOURCES.internal()).internal).toBe(true);
    expect(meta(SOURCES.review()).internal).toBe(true);
    expect(meta('cli', { thread_source: 'guardian_review' }).internal).toBe(true);
    expect(meta('vscode')).toMatchObject({ internal: false, cwd: '/p', historyMode: 'paginated' });
    expect(meta('vscode').parentThreadId).toBeUndefined();
    // Sem thread_spawn, mas com a raiz diferente do próprio id: o pai é a raiz.
    expect(meta('exec', { session_id: parent }).parentThreadId).toBe(parent);
    expect(parseSessionMeta({ id: T }).historyMode).toBe('legacy');
  });
});

/** CommandExecution com a lista e o parsed_cmd dados (o R.command grava sempre `zsh -lc`). */
function execItem(id: string, command: unknown, o: { parsed?: unknown[]; exit?: number; output?: string } = {}): string {
  const j = JSON.parse(R.command(T, 't', id, 'x', { exit: o.exit, output: o.output }));
  j.payload.item.command = command;
  j.payload.item.parsed_cmd = o.parsed ?? [{ type: 'unknown', cmd: 'x' }];
  return JSON.stringify(j);
}

const acts = (results: CodexLineResult[]) => results.flatMap((r) => r.activities.map((a) => a.activity));

describe('rollout do Codex: comandos do PowerShell e do cmd (P5)', () => {
  it('commandText devolve o comando desembrulhado (pwsh -Command, cmd /c, texto inteiro)', () => {
    expect(commandText(['pwsh.exe', '-NoProfile', '-Command', 'git status'])).toBe('git status');
    expect(commandText(['cmd.exe', '/d', '/s', '/c', 'dir'])).toBe('dir');
    expect(commandText('pwsh -NoProfile -Command "npm test"')).toBe('npm test');
    expect(describeCodexTool('Bash', { command: 'pwsh -NoProfile -Command "git status"' }).desc).toMatchObject({ text: 'Conferindo o git status', detail: 'git status' });
  });

  it('CommandExecution do code mode: a heurística olha o comando de dentro', () => {
    const { results } = feed([execItem('exec-1', ['pwsh.exe', '-NoProfile', '-Command', 'npm test']), execItem('exec-2', ['cmd.exe', '/d', '/s', '/c', 'git status'])]);
    expect(acts(results).map((a) => [a.id, a.text, a.detail, a.tool])).toEqual([
      ['acc:t#exec-1', 'Rodando testes', 'npm test', 'Bash'],
      ['acc:t#exec-2', 'Conferindo o git status', 'git status', 'Bash'],
    ]);
  });

  it('parsed_cmd: só leitura, listagem ou busca mudam o tipo; mistura com unknown fica com o comando', () => {
    const { results, state } = feed([
      execItem('e1', ['pwsh.exe', '-Command', 'Get-Content src/soma.ts'], { parsed: [{ type: 'read', cmd: 'Get-Content src/soma.ts', name: 'soma.ts', path: 'src/soma.ts' }] }),
      execItem('e2', ['pwsh.exe', '-Command', 'Get-ChildItem src'], { parsed: [{ type: 'list_files', cmd: 'Get-ChildItem src', path: 'src' }] }),
      execItem('e3', ['pwsh.exe', '-Command', 'rg -n TODO src'], { parsed: [{ type: 'search', cmd: 'rg -n TODO src', query: 'TODO', path: 'src' }] }),
      execItem('e4', ['pwsh.exe', '-Command', 'Get-ChildItem; npm test'], { parsed: [{ type: 'list_files', cmd: 'Get-ChildItem' }, { type: 'unknown', cmd: 'npm test' }] }),
      execItem('e5', ['pwsh.exe', '-Command', 'Get-Content a.txt | Select-String x'], {
        parsed: [{ type: 'read', cmd: 'Get-Content a.txt', name: 'a.txt', path: 'a.txt' }, { type: 'search', cmd: 'Select-String x', query: 'x' }],
      }),
      // Leitura sem caminho: não dá para dizer o quê; fica o comando.
      execItem('e6', ['pwsh.exe', '-Command', 'npm test'], { parsed: [{ type: 'read', cmd: 'npm test' }] }),
    ]);
    expect(acts(results).map((a) => [a.id, a.kind, a.text, a.tool])).toEqual([
      ['acc:t#e1', 'read', 'Lendo soma.ts', 'Bash'],
      ['acc:t#e2', 'read', 'Listando src', 'Bash'],
      ['acc:t#e3', 'search', 'Buscando “TODO”', 'Bash'],
      ['acc:t#e4', 'run', 'Rodando Get-ChildItem', 'Bash'],
      ['acc:t#e5', 'read', 'Lendo a.txt', 'Bash'],
      ['acc:t#e6', 'test', 'Rodando testes', 'Bash'],
    ]);
    expect(state.stats.toolCalls).toBe(6);
  });

  it('GitHub: push e PR detectados no comando desembrulhado (pwsh e cmd)', () => {
    const ok = 'To github.com:o/r.git\n   abc1234..def5678  main -> main\n';
    const { results } = feed([
      execItem('g1', ['pwsh.exe', '-Command', 'git push origin main'], { output: ok }),
      execItem('g2', ['cmd.exe', '/d', '/s', '/c', 'gh pr create --fill'], { output: 'https://github.com/o/r/pull/12\n' }),
    ]);
    expect(results[0].signals).toContainEqual({ type: 'github', event: { kind: 'push', branch: 'main' }, key: 'g1' });
    expect(results[1].signals).toContainEqual({ type: 'github', event: expect.objectContaining({ kind: 'pr_opened', number: 12, repo: 'o/r' }), key: 'g2' });
  });
});

const MIB = 1024 * 1024;

/** A linha com `ordinal` e campos a mais no payload (o R não grava ordinal). */
function withOrdinal(raw: string, ordinal: number, payload: Record<string, unknown> = {}): string {
  const j = JSON.parse(raw);
  return JSON.stringify({ ...j, ordinal, payload: { ...j.payload, ...payload } });
}

/** item_completed qualquer (o R não tem CollabAgentToolCall). */
function itemLine(thread: string, turn: string, it: Record<string, unknown>, at: number): string {
  return JSON.stringify({ timestamp: new Date(at).toISOString(), type: 'event_msg', payload: { type: 'item_completed', thread_id: thread, turn_id: turn, item: it } });
}

describe('session_meta: só o 1º vale e a herança do fork fica de fora (P4, Review Focus #2)', () => {
  const CHILD = threadId(10);
  const PARENT = threadId(11);
  const GRANDPARENT = threadId(12);
  const t0 = Date.parse('2026-10-09T12:00:00Z');
  /** As linhas copiadas do pai guardam o horário dele (antes do filho nascer). */
  const tp = Date.parse('2026-10-09T10:00:00Z');
  const pushOk = 'To github.com:o/r.git\n   abc1234..def5678  main -> main\n';

  /**
   * Subagente com fork: o cabeçalho (instruções base grandes: o 2º session_meta fica a mais de 1 MiB do começo,
   * fora da 1ª linha e dentro da janela do fim), o session_meta do pai copiado (ordinal 1) e a história herdada
   * (ordinais 2 a 7) antes da do filho (subagent_history_start_ordinal = 8).
   */
  function forkedChild(): string[] {
    const header = withOrdinal(R.meta(CHILD, { at: t0, source: SOURCES.sub(PARENT, 'explorer'), sessionId: PARENT }), 0, {
      subagent_history_start_ordinal: 8,
      base_instructions: { text: 'Instruções base sintéticas. '.repeat(Math.ceil(MIB / 28) + 10) },
    });
    return [
      header,
      withOrdinal(R.meta(PARENT, { at: tp, source: SOURCES.sub(GRANDPARENT, 'worker'), sessionId: GRANDPARENT, branch: 'feat/pai' }), 1),
      withOrdinal(R.taskStarted('turn-pai', tp + 1), 2),
      withOrdinal(R.user(PARENT, 'turn-pai', 'u-pai', 'Pedido herdado do pai', tp + 2), 3),
      withOrdinal(R.command(PARENT, 'turn-pai', 'c-pai', 'git push', { output: pushOk, at: tp + 3 }), 4),
      withOrdinal(itemLine(PARENT, 'turn-pai', { type: 'CollabAgentToolCall', id: 'spawn-pai', tool: 'spawn_agent', prompt: 'Neto fantasma' }, tp + 4), 5),
      withOrdinal(R.tokens({ input: 5_000, output: 300, at: tp + 5, rateLimits: {} }), 6),
      withOrdinal(R.taskComplete('turn-pai', tp + 6), 7),
      withOrdinal(R.taskStarted('turn-filho', t0 + 10), 8),
      withOrdinal(R.user(CHILD, 'turn-filho', 'u-filho', 'Liste os arquivos de src', t0 + 11), 9),
      withOrdinal(R.command(CHILD, 'turn-filho', 'c-filho', 'ls src', { at: t0 + 12 }), 10),
      withOrdinal(R.tokens({ input: 100, output: 20, at: t0 + 13 }), 11),
    ];
  }

  function expectOnlyChild(state: CodexState, results: CodexLineResult[]): void {
    expect(state.meta).toMatchObject({ threadId: CHILD, parentThreadId: PARENT, agentRole: 'explorer', startedAt: t0, historyStart: 8 });
    expect(state.gitBranch).toBe('main');
    expect(ids(results)).toEqual(['acc:t#u-filho', 'acc:t#c-filho']);
    const signals = results.flatMap((r) => r.signals.map((s) => s.type));
    expect(signals.filter((s) => s === 'turnStart')).toHaveLength(1);
    expect(signals.filter((s) => ['turnEnd', 'github', 'usage'].includes(s))).toEqual([]);
    expect(state.title).toBe('Liste os arquivos de src');
    expect(state.stats).toEqual({ toolCalls: 1, subagents: 0, tokensIn: 100, tokensOut: 20 });
    expect(state.usage).toBeUndefined();
    expect(state.turnOpen).toBe(true);
    expect(state.lastAt).toBe(t0 + 13);
  }

  it('janela do fim (estado com o meta do cabeçalho): o 2º session_meta, a mais de 1 MiB do começo, não muda nada', () => {
    const lines = forkedChild();
    expect(Buffer.byteLength(lines[0], 'utf8') + 1).toBeGreaterThan(MIB);
    const head = metaFromLine(lines[0]);
    expect(head).toMatchObject({ threadId: CHILD, historyStart: 8 });
    const { state, results } = feed(lines.slice(1), createCodexState(head));
    expect(results.flatMap((r) => r.signals).some((s) => s.type === 'meta')).toBe(false);
    expectOnlyChild(state, results);
    expect(state.firstAt).toBe(t0 + 10);
  });

  it('leitura desde o começo (estado vazio): o meta é o do cabeçalho e só ele vira sinal', () => {
    const { state, results } = feed(forkedChild());
    expect(results.flatMap((r) => r.signals).filter((s) => s.type === 'meta')).toEqual([{ type: 'meta', meta: expect.objectContaining({ threadId: CHILD, parentThreadId: PARENT }) }]);
    expectOnlyChild(state, results);
    expect(state.firstAt).toBe(t0);
  });

  it('título do cabeçalho (só estado, sem atividades): o prompt herdado não vira título', () => {
    const lines = forkedChild();
    const state = createCodexState(metaFromLine(lines[0]));
    for (const l of lines.slice(1)) {
      parseRolloutLine(state, l, { idPrefix: '', now: 0, activities: false });
      if (state.title !== undefined) break;
    }
    expect(state.title).toBe('Liste os arquivos de src');
  });

  it('sem subagente: um session_meta repetido (resume) ou de outro thread é ignorado', () => {
    const other = threadId(13);
    const { state, results } = feed([R.meta(T, { at: t0 }), R.meta(T, { at: t0 + 5 }), R.meta(other, { at: t0 + 6, cwd: '/projetos/outro' })]);
    expect(results.map((r) => [r.signals.map((s) => s.type), r.changed])).toEqual([
      [['meta'], true],
      [[], false],
      [[], false],
    ]);
    expect(state.meta).toMatchObject({ threadId: T, cwd: '/projetos/loja', startedAt: t0 });
    expect(state.meta?.historyStart).toBeUndefined();
  });

  it('parseSessionMeta: historyStart só com um ordinal válido', () => {
    expect(parseSessionMeta({ id: T, subagent_history_start_ordinal: 5 }).historyStart).toBe(5);
    expect(parseSessionMeta({ id: T, subagent_history_start_ordinal: -1 }).historyStart).toBeUndefined();
    expect(parseSessionMeta({ id: T, subagent_history_start_ordinal: '5' }).historyStart).toBeUndefined();
    expect(parseSessionMeta({ id: T }).historyStart).toBeUndefined();
  });
});

describe('segredos mascarados antes do corte do detalhe de erro (P15)', () => {
  // Montados em partes: nenhum token inteiro no código. O token começa no caractere 130 e cruza o 140º: cortado
  // antes, sobra menos do que a máscara exige (16 depois de ghp_/glpat-, 8 depois de sk-) e o começo vazaria.
  const prefix = `Falhou: ${'x'.repeat(121)} `;
  /** [máscara, token, começo do token que vazaria] */
  const tokens: Array<[string, string, string]> = [
    ['gh*_***', 'gh' + 'p_' + 'Z9'.repeat(20), 'gh' + 'p_Z'],
    ['sk-***', 's' + 'k-' + 'Z9'.repeat(20), 's' + 'k-Z'],
    ['glpat-***', 'gl' + 'pat-' + 'Z9'.repeat(20), 'gl' + 'pat-Z'],
  ];

  it.each(tokens)('comando com erro: o token que vira %s não vaza nem cortado', (masked, token, leak) => {
    expect(prefix.length).toBe(130);
    const { results } = feed([execItem('c1', ['bash', '-lc', 'npm run deploy'], { exit: 1, output: `${prefix}${token} resto\nlinha 2` })]);
    const error = acts(results).find((a) => a.kind === 'error');
    expect(error?.detail).toContain(masked);
    expect(error?.detail).not.toContain(leak);
  });

  it('erro de MCP e erro do turno (task_complete) também', () => {
    const [masked, token, leak] = tokens[0];
    const turnEnd = JSON.parse(R.taskComplete('t1'));
    turnEnd.payload.error = { message: `${prefix}${token}` };
    const { results } = feed([R.mcp(T, 't1', 'm1', 'github', 'get_me', {}, { error: `${prefix}${token}` }), JSON.stringify(turnEnd)]);
    const details = acts(results)
      .filter((a) => a.kind === 'error')
      .map((a) => a.detail);
    expect(details).toHaveLength(2);
    for (const d of details) {
      expect(d).toContain(masked);
      expect(d).not.toContain(leak);
    }
  });
});

describe('pathFromUri', () => {
  it('Windows sem barra antes da letra do drive; POSIX e caminho comum como estão', () => {
    expect(pathFromUri('file:///C:/x/y')).toBe('C:/x/y');
    expect(pathFromUri('file:///d:/Projetos/a%20b/c.png')).toBe('d:/Projetos/a b/c.png');
    expect(pathFromUri('file:///projetos/loja/a.png')).toBe('/projetos/loja/a.png');
    expect(pathFromUri('C:\\x\\y.png')).toBe('C:\\x\\y.png');
    expect(pathFromUri('/x/y')).toBe('/x/y');
    expect(pathFromUri(42)).toBeUndefined();
  });

  it('ImageView com caminho do Windows vira leitura com o caminho certo', () => {
    const { results } = feed([itemLine(T, 't', { type: 'ImageView', id: 'img1', path: 'file:///C:/proj/tela.png' }, Date.parse('2026-10-09T12:00:00Z'))]);
    expect(acts(results)[0]).toMatchObject({ id: 'acc:t#img1', kind: 'read', text: 'Olhando tela.png', detail: 'C:/proj/tela.png', tool: 'Read' });
  });
});
