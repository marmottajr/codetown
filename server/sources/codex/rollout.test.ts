// Interpretação dos rollouts do Codex (linhas sintéticas nos formatos paginated e legacy).
import { describe, expect, it } from 'vitest';
import { R, SOURCES, threadId } from '../../test/codex-fixtures';
import { LIMIT_MESSAGE, taskCompleteError } from '../../test/codex-fixtures-fim';
import { envelope, fernet, spawnEncrypted } from '../../test/codex-fixtures-live';
import { grandchildSource } from '../../test/codex-fixtures-source-ii';
import {
  commandText,
  createCodexState,
  describeCodexTool,
  fileChanges,
  isEncryptedText,
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

  it('0.160.1: comando encerrado pelo Codex no fim do turno (failed, código -1, depois do task_complete) não vira atividade nem "Erro", com ou sem saída', () => {
    const at = Date.parse('2026-10-09T12:00:00Z');
    const { state, results } = feed([
      R.meta(T, { at }),
      R.taskStarted('turn1', at + 1),
      R.command(T, 'turn1', 'exec-1', 'npm test', { output: 'ok', at: at + 2 }),
      R.taskComplete('turn1', at + 3, 3_000),
      R.command(T, 'turn1', 'exec-2', 'npm run dev', { exit: -1, status: 'failed', output: '', at: at + 4 }),
      R.command(T, 'turn1', 'exec-3', 'npm run watch', { exit: -1, status: 'failed', output: 'compilando…\n'.repeat(200), at: at + 5 }),
    ]);
    expect(results.slice(4).flatMap((r) => r.activities)).toEqual([]);
    expect(texts(results).at(-1)).toBe('Concluiu em 3s');
    expect(state.current?.id).toBe('acc:t#turn1:done');
    // Com o turno aberto, o -1 continua sendo erro.
    const open = feed([R.taskStarted('turn2', at), R.command(T, 'turn2', 'exec-4', 'npm test', { exit: -1, status: 'failed', output: '', at: at + 1 })]);
    expect(texts(open.results)).toContain('Erro em Bash');
  });

  it('turno que termina com erro (task_complete com error, ex.: limite de uso): um "Concluiu com erro" só, atual, com o erro no detalhe', () => {
    const at = Date.parse('2026-10-09T12:00:00Z');
    const { state, results } = feed([R.meta(T, { at }), R.taskStarted('turn1', at + 1), R.user(T, 'turn1', 'u1', 'Rode a suíte', at + 2), taskCompleteError('turn1', at + 3, 8_000)]);
    const end = results.at(-1)!.activities;
    expect(end).toHaveLength(1);
    expect(end[0]).toMatchObject({ current: true, activity: { id: 'acc:t#turn1:done', kind: 'done', icon: '⚠️', text: 'Concluiu com erro em 8s', detail: LIMIT_MESSAGE, error: true, durationMs: 8_000 } });
    expect(texts(results)).not.toContain('Algo deu errado');
    expect(state.current?.id).toBe('acc:t#turn1:done');
    // Sem erro, o de sempre.
    expect(texts(feed([R.taskComplete('turn2', at, 8_000)]).results)).toEqual(['Concluiu em 8s']);
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
    expect(swapped).toEqual({
      source: 'codex',
      fetchedAt: at,
      sevenDay: { utilization: 70, resetsAt: 1_900_000_000_000 },
      fiveHour: { utilization: 5.5, resetsAt: 2_000_000_000_000 },
      // windows segue a ordem do rate_limits (primary, secondary), não a da duração.
      windows: [
        { windowMinutes: 10080, usedPercent: 70, resetsAt: 1_900_000_000_000 },
        { windowMinutes: 300, usedPercent: 5.5, resetsAt: 2_000_000_000_000 },
      ],
    });
    const none = usageFromRateLimits(R.rateLimits({ primary: null, secondary: null, reached: 'workspace_owner_credits_depleted' }), at);
    expect(none).toEqual({ source: 'codex', fetchedAt: at, noQuota: true });
    expect(usageFromRateLimits(R.rateLimits({ primary: null, secondary: null }), at)).toBeUndefined();
    const { state, results } = feed([R.tokens({ input: 1, output: 1, at, rateLimits: { plan: 'pro' } })]);
    expect(state.planType).toBe('pro');
    expect(results[0].signals).toContainEqual({ type: 'usage', usage: expect.objectContaining({ fetchedAt: at, fiveHour: { utilization: 12.5, resetsAt: 2_000_000_000_000 } }), plan: 'pro' });
  });

  it('uso do plano: windows com só os medidores que o plano tem, na ordem primary, secondary', () => {
    const at = Date.parse('2026-10-09T12:00:00Z');
    // Plano só semanal (pro/prolite desde jul/2026): nada de 5 h.
    const weekOnly = usageFromRateLimits(R.rateLimits({ primary: { used: 23, minutes: 10080, resetsAt: 1_900_000_000 }, secondary: null }), at);
    expect(weekOnly).toEqual({
      source: 'codex',
      fetchedAt: at,
      sevenDay: { utilization: 23, resetsAt: 1_900_000_000_000 },
      windows: [{ windowMinutes: 10080, usedPercent: 23, resetsAt: 1_900_000_000_000 }],
    });
    expect(usageFromRateLimits(R.rateLimits({}), at)?.windows).toEqual([
      { windowMinutes: 300, usedPercent: 12.5, resetsAt: 2_000_000_000_000 },
      { windowMinutes: 10080, usedPercent: 40, resetsAt: 2_000_000_000_000 },
    ]);
    // Outra duração também é medidor do plano (o cartão rotula em horas/dias); fiveHour/sevenDay ficam sem ela.
    // Percentual fora de 0–100 é limitado.
    expect(usageFromRateLimits(R.rateLimits({ primary: { used: 130, minutes: 60 }, secondary: null }), at)).toEqual({
      source: 'codex',
      fetchedAt: at,
      windows: [{ windowMinutes: 60, usedPercent: 100, resetsAt: 2_000_000_000_000 }],
    });
    // Mesma duração nas duas posições: vale a primary (como em fiveHour/sevenDay), sem medidor repetido.
    const twice = usageFromRateLimits(R.rateLimits({ primary: { used: 7, minutes: 10080 }, secondary: { used: 99, minutes: 10080 } }), at);
    expect(twice?.windows).toEqual([{ windowMinutes: 10080, usedPercent: 7, resetsAt: 2_000_000_000_000 }]);
    expect(twice?.sevenDay).toEqual({ utilization: 7, resetsAt: 2_000_000_000_000 });
    // Sem cota: como antes, sem windows (nenhuma janela informada).
    expect(usageFromRateLimits(R.rateLimits({ primary: null, secondary: null, reached: 'rate_limit_reached' }), at)).toEqual({ source: 'codex', fetchedAt: at, noQuota: true });
  });

  it('uso do plano: formatos antigos (resets_in_seconds do 0.45/0.46 e o formato plano do 0.40)', () => {
    const at = Date.parse('2026-10-09T12:00:00Z');
    const v045 = {
      primary: { used_percent: 5, window_minutes: 300, resets_in_seconds: 600 },
      secondary: { used_percent: 50, window_minutes: 10080, resets_in_seconds: 86_400 },
    };
    expect(usageFromRateLimits(v045, at)).toEqual({
      source: 'codex',
      fetchedAt: at,
      fiveHour: { utilization: 5, resetsAt: at + 600_000 },
      sevenDay: { utilization: 50, resetsAt: at + 86_400_000 },
      windows: [
        { windowMinutes: 300, usedPercent: 5, resetsAt: at + 600_000 },
        { windowMinutes: 10080, usedPercent: 50, resetsAt: at + 86_400_000 },
      ],
    });
    const v040 = {
      primary_used_percent: 12,
      secondary_used_percent: 30,
      primary_to_secondary_ratio_percent: 40,
      primary_window_minutes: 300,
      secondary_window_minutes: 10080,
    };
    expect(usageFromRateLimits(v040, at)).toEqual({
      source: 'codex',
      fetchedAt: at,
      fiveHour: { utilization: 12 },
      sevenDay: { utilization: 30 },
      windows: [
        { windowMinutes: 300, usedPercent: 12 },
        { windowMinutes: 10080, usedPercent: 30 },
      ],
    });
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

  it('subagente e neto abortados pelo Codex (turn_aborted "interrupted" quando o pai encerra): "Interrompido", sem "por você"; o principal segue igual', () => {
    const at = Date.parse('2026-10-09T12:00:00Z');
    const P = threadId(7);
    const turn = (meta: string) => texts(feed([meta, R.taskStarted('t1', at + 1), R.turnAborted('t1', at + 2)]).results);
    expect(turn(R.meta(T, { at, sessionId: P, source: SOURCES.sub(P, 'worker') }))).toEqual(['Interrompido']);
    expect(turn(R.meta(threadId(8), { at, sessionId: P, source: grandchildSource(T) }))).toEqual(['Interrompido']);
    expect(turn(R.meta(P, { at }))).toEqual(['Interrompido por você']);
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

  it('sequência real (function_call e depois o CommandExecution de mesmo id): só a reclassificação pede para substituir', () => {
    const at = Date.parse('2026-10-09T12:00:00Z');
    const read = [{ type: 'read', cmd: 'Get-Content src/soma.ts', name: 'soma.ts', path: 'src/soma.ts' }];
    const { results } = feed([
      R.functionCall('call_1', 'exec_command', { cmd: 'Get-Content src/soma.ts' }, at),
      execItem('call_1', ['pwsh.exe', '-Command', 'Get-Content src/soma.ts'], { parsed: read }),
      R.functionCall('call_2', 'exec_command', { cmd: 'npm test' }, at + 2),
      execItem('call_2', ['pwsh.exe', '-Command', 'npm test']),
    ]);
    expect(results.flatMap((r) => r.activities.map((a) => [a.activity.id, a.activity.kind, a.replace]))).toEqual([
      ['acc:t#call_1', 'run', undefined],
      ['acc:t#call_1', 'read', true],
      ['acc:t#call_2', 'test', undefined],
      ['acc:t#call_2', 'test', undefined],
    ]);
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
    // O erro do turno vai na própria conclusão ("Concluiu com erro"), marcada com `error`.
    const details = acts(results)
      .filter((a) => a.error)
      .map((a) => a.detail);
    expect(details).toHaveLength(2);
    for (const d of details) {
      expect(d).toContain(masked);
      expect(d).not.toContain(leak);
    }
  });

  it.each([tokens[0], tokens[2]])('busca do parsed_cmd: o token que vira %s não vaza no texto (o Grep corta em 26)', (masked, token, leak) => {
    const { results } = feed([execItem('s1', ['pwsh.exe', '-Command', 'Select-String x'], { parsed: [{ type: 'search', cmd: 'Select-String x', query: `usage of ${token}` }] })]);
    const [search] = acts(results);
    expect(search).toMatchObject({ kind: 'search', tool: 'Bash' });
    expect(search.text).toContain(masked);
    expect(search.text).not.toContain(leak);
    expect(search.detail).not.toContain(leak);
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

describe('prompt do spawn_agent mascarado antes do corte', () => {
  it('a máscara encurta o texto e não puxa para a tela um pedaço de token sem máscara', () => {
    const ghp = 'gh' + 'p_' + 'Z9'.repeat(18);
    const sk = 's' + 'k-' + 'Z9'.repeat(10);
    // O ghp mascarado encolhe 33 caracteres; o sk começa no 52 e, cortado em 60 antes da máscara, sobraria com menos
    // de 8 caracteres (não casa) e cairia dentro dos 46 do texto.
    const { desc } = describeCodexTool('spawn_agent', { message: `a ${ghp} ${'x'.repeat(8)} ${sk}` });
    expect(desc.text).toContain('gh*_***');
    expect(desc.text).not.toContain('s' + 'k-Z');
  });
});

const AT = Date.parse('2026-10-09T12:00:00Z');
/** Montado em partes: nenhum token inteiro no código. */
const GHP = 'gh' + 'p_' + 'Z9'.repeat(10);
const signalsOf = (results: CodexLineResult[]) => results.flatMap((r) => r.signals);
const typesOf = (r: CodexLineResult) => r.signals.map((s) => s.type);

describe('request_user_input: o agente espera você (P9)', () => {
  const questions = [
    { id: 'banco', header: 'Banco', question: `Qual banco usar? token ${GHP}`, options: [{ label: 'Postgres', description: 'Recomendado' }, { label: 'SQLite', description: 'Mais simples' }] },
    { id: 'dist', header: 'Limpeza', question: 'Posso apagar a pasta dist?', options: [{ label: 'Sim' }, { label: 'Não' }] },
  ];
  const ask = (callId: string, qs: unknown[] = questions) => R.functionCall(callId, 'request_user_input', { autoResolutionMs: 60_000, questions: qs }, AT);

  it('pergunta sem output: atividade ask com as perguntas mascaradas, sinal asking com o resumo e a pergunta aberta no estado; o output fecha', () => {
    const { state, results } = feed([R.meta(T, { at: AT }), R.taskStarted('t1', AT), ask('call_ask')]);
    const open = results[2];
    expect(open.activities[0]).toMatchObject({ toolUseId: 'call_ask', current: true });
    expect(open.activities[0].activity).toMatchObject({ id: 'acc:t#call_ask', kind: 'ask', text: 'Esperando você responder', tool: 'request_user_input', detail: 'Qual banco usar? token gh*_***' });
    expect(open.activities[0].activity.questions?.map((q) => q.question)).toEqual(['Qual banco usar? token gh*_***', 'Posso apagar a pasta dist?']);
    expect(open.signals).toEqual([{ type: 'asking', questions: 'Qual banco usar? token gh*_*** · Posso apagar a pasta dist?' }]);
    expect([...state.asking.keys()]).toEqual(['call_ask']);
    const answered = parseRolloutLine(state, R.functionOutput('call_ask', '{"answers":{"banco":{"answers":["Postgres"]}}}', AT + 5_000), ctx);
    expect(answered.signals).toEqual([{ type: 'answered' }]);
    expect(answered.activities.map((a) => a.activity)).toEqual([
      expect.objectContaining({ id: 'acc:t#call_ask:ans', kind: 'ask', text: 'Recebeu a sua resposta', detail: 'Qual banco usar? token gh*_*** · Posso apagar a pasta dist?' }),
    ]);
    expect(state.asking.size).toBe(0);
  });

  it('o resumo é mascarado antes do corte (token cruzando o limite de 120 não vaza)', () => {
    const prefix = `Pergunta ${'x'.repeat(102)} `;
    expect(prefix.length).toBe(112);
    const token = 'gh' + 'p_' + 'Z9'.repeat(20);
    const { results } = feed([R.meta(T), ask('c1', [{ id: 'q', header: 'X', question: `${prefix}${token} resto`, options: [] }])]);
    const sig = results[1].signals.find((s) => s.type === 'asking');
    expect(sig).toBeDefined();
    const summary = sig?.type === 'asking' ? sig.questions : '';
    expect(summary.length).toBeLessThanOrEqual(120);
    expect(summary).toContain('gh*_***');
    expect(summary).not.toContain('gh' + 'p_Z');
  });

  it('fim do turno com a pergunta aberta: answered antes do turnEnd (e do turnStart de um turno novo); já respondida, nada de answered', () => {
    const base = [R.meta(T, { at: AT }), R.taskStarted('t1', AT), ask('c1')];
    const done = feed([...base, R.taskComplete('t1', AT + 9_000)]);
    expect(typesOf(done.results[3])).toEqual(['answered', 'turnEnd']);
    expect(done.state.asking.size).toBe(0);
    expect(typesOf(feed([...base, R.turnAborted('t1', AT + 9_000)]).results[3])).toEqual(['answered', 'turnEnd']);
    const next = feed([...base, R.taskStarted('t2', AT + 9_000)]);
    expect(typesOf(next.results[3])).toEqual(['answered', 'turnStart']);
    expect(next.state.asking.size).toBe(0);
    const replied = feed([...base, R.functionOutput('c1', '{"answers":{}}', AT + 1_000), R.taskComplete('t1', AT + 9_000)]);
    expect(typesOf(replied.results[4])).toEqual(['turnEnd']);
  });

  it('request_user_input_async não abre espera; no legacy e sem atividades (só estado) a pergunta abre e fecha igual', () => {
    const asyncAsk = feed([R.meta(T), R.functionCall('c2', 'request_user_input_async', { questions: [{ title: 'Posso apagar a pasta dist?', options: ['Sim', 'Não'] }] }, AT)]);
    expect(signalsOf(asyncAsk.results).some((s) => s.type === 'asking')).toBe(false);
    expect(asyncAsk.state.asking.size).toBe(0);
    const legacy = feed([R.meta(T, { history: null }), ask('c3'), R.functionOutput('c3', '{"answers":{}}', AT + 1)]);
    expect(legacy.results.map(typesOf)).toEqual([['meta'], ['asking'], ['answered']]);
    const state = createCodexState();
    const quiet = [ask('c4'), R.functionOutput('c4', '{"answers":{}}', AT + 1)].map((l) => parseRolloutLine(state, l, { idPrefix: '', now: 0, activities: false }));
    expect(quiet.map(typesOf)).toEqual([['asking'], ['answered']]);
    expect(quiet.flatMap((r) => r.activities)).toEqual([]);
  });
});

describe('update_plan dentro do exec do code mode (P10)', () => {
  const marker = '__habblaudExecutou';
  /** custom_tool_call `exec` (code mode) com o JS dado. */
  const codeMode = (callId: string, js: string) => R.customToolCall(callId, 'exec', js, AT);

  it('tools.update_plan({...}) no JS vira as tarefas: literal tolerante (aspas simples, crase, chaves sem aspas, vírgula final), sem executar nada', () => {
    const js = [
      'const r = await tools.exec_command({ cmd: "npm test" });',
      "await tools.update_plan({ plan: [ { step: 'Ler o código', status: 'completed' }, { step: \"Escrever o teste\", status: 'in_progress', }, { step: `Rodar a suíte`, status: 'pending' }, ], explanation: `um 'teste'`, });",
      `globalThis.${marker} = true;`,
    ].join('\n');
    const { state, results } = feed([R.meta(T), codeMode('call_js', js)]);
    expect(state.tasks).toEqual([
      { id: '1', title: 'Ler o código', status: 'completed' },
      { id: '2', title: 'Escrever o teste', status: 'in_progress' },
      { id: '3', title: 'Rodar a suíte', status: 'pending' },
    ]);
    expect(results[1].changed).toBe(true);
    // Só a atividade do exec (o plano não ganha atividade própria); nada do JS rodou.
    expect(ids(results)).toEqual(['acc:t#call_js']);
    expect((globalThis as Record<string, unknown>)[marker]).toBeUndefined();
  });

  it('vale a última chamada do script; título mascarado; argumento que não é literal, literal ilegível ou script sem plano não mexem nas tarefas', () => {
    const two = "tools.update_plan({ plan: [{ step: 'Velho', status: 'completed' }] });\n" + `tools.update_plan({ plan: [{ step: 'Configurar o ${GHP}', status: 'in_progress' }] });`;
    const { state, results } = feed([
      R.meta(T),
      codeMode('c1', two),
      codeMode('c2', 'const passos = []; tools.update_plan({ plan: passos });'),
      codeMode('c3', "tools.update_plan({ plan: [{ step: 'quebrado', status: 'pending' }"),
      codeMode('c4', 'await tools.exec_command({ cmd: "ls" });'),
      codeMode('c5', 'tools.update_plan(planoMontado);'),
    ]);
    expect(state.tasks).toEqual([{ id: '1', title: 'Configurar o gh*_***', status: 'in_progress' }]);
    expect(results.slice(2).map((r) => r.changed)).toEqual([false, false, false, false]);
  });
});

describe('multiagente v2: SubAgentActivity, spawn_agent e agent_message (P11)', () => {
  const CHILD = threadId(20);
  const CHILD2 = threadId(21);
  const sub = (id: string, kind: string, child: string, path: string) => itemLine(T, 't', { type: 'SubAgentActivity', id, kind, agent_thread_id: child, agent_path: path }, AT);
  /** response_item agent_message (gravado no rollout de quem recebe), com o bloco cifrado que o Codex põe junto. */
  const agentMessage = (author: string, recipient: string, text: string) =>
    JSON.stringify({
      timestamp: new Date(AT).toISOString(),
      type: 'response_item',
      payload: { type: 'agent_message', id: 'amsg_1', author, recipient, content: [{ type: 'input_text', text }, { type: 'encrypted_content', encrypted_content: 'cifrado' }] },
    });
  const spawnsOf = (results: CodexLineResult[]) => signalsOf(results).filter((s) => s.type === 'spawn');
  const childMeta = (extra: Record<string, unknown> = {}) => parseSessionMeta({ id: CHILD, session_id: T, source: SOURCES.sub(T, 'worker'), history_mode: 'paginated', ...extra });

  it('pai: spawn_agent (fork_turns none) e o SubAgentActivity started contam um subagente e emitem um spawn com o id e o título do filho', () => {
    const { state, results } = feed([
      R.meta(T, { at: AT }),
      R.taskStarted('t', AT),
      R.functionCall('call_sp', 'spawn_agent', { task_name: 'revisar_testes', message: `Revise os testes de soma ${GHP}`, agent_type: 'explorer', fork_turns: 'none' }, AT, 'collaboration'),
      sub('call_sp', 'started', CHILD, '/root/revisar_testes'),
      R.functionOutput('call_sp', '{"task_name":"/root/revisar_testes"}', AT),
    ]);
    expect(acts(results).map((a) => [a.id, a.kind, a.text, a.tool])).toEqual([['acc:t#call_sp', 'delegate', 'Delegando: Revise os testes de soma gh*_***', 'Agent']]);
    expect(spawnsOf(results)).toStrictEqual([{ type: 'spawn', childThreadId: CHILD, title: 'Revise os testes de soma gh*_***' }]);
    expect(state.stats.subagents).toBe(1);
  });

  it('started sem o spawn_agent visto: atividade de delegar com o título pelo agent_path; o mesmo started relido não conta; interacted, completed e interrupted não geram nada', () => {
    const { state, results } = feed([
      R.meta(T),
      sub('subagent-7', 'started', CHILD2, '/root/documentar'),
      sub('subagent-7', 'started', CHILD2, '/root/documentar'),
      sub('call_msg', 'interacted', CHILD2, '/root/documentar'),
      sub('subagent-completed-tc', 'completed', CHILD2, '/root/documentar'),
      sub('call_int', 'interrupted', CHILD2, '/root/documentar'),
    ]);
    expect(acts(results).map((a) => [a.id, a.kind, a.text, a.tool])).toEqual([['acc:t#subagent-7', 'delegate', 'Delegando: documentar', 'Agent']]);
    expect(spawnsOf(results)).toStrictEqual([{ type: 'spawn', childThreadId: CHILD2, title: 'documentar' }]);
    expect(state.stats.subagents).toBe(1);
    // Nem progress: o completed do filho chega no rollout do pai e não tira a espera por aprovação dele.
    expect(results.slice(2).flatMap((r) => r.signals)).toEqual([]);
    expect(results.slice(2).map((r) => r.changed)).toEqual([false, false, false, false]);
  });

  it('CollabAgentToolCall spawn_agent entra na mesma conta: spawn pelo receiver (sem receiver, sem o id) e o started do mesmo id não conta de novo', () => {
    const collab = (id: string, receivers: string[], prompt: string) =>
      itemLine(T, 't', { type: 'CollabAgentToolCall', id, tool: 'spawn_agent', status: 'completed', sender_thread_id: T, receiver_thread_ids: receivers, receiver_agents: [], agents_states: {}, prompt }, AT);
    const { state, results } = feed([R.meta(T), collab('call_v1', [CHILD], 'Documente o módulo de soma'), sub('call_v1', 'started', CHILD, '/root/documentar'), collab('call_v2', [], 'Revise o README')]);
    expect(spawnsOf(results)).toStrictEqual([
      { type: 'spawn', childThreadId: CHILD, title: 'Documente o módulo de soma' },
      { type: 'spawn', title: 'Revise o README' },
    ]);
    expect(state.stats.subagents).toBe(2);
  });

  it('filho: a 1ª agent_message endereçada a ele (a tarefa) vira o título, mascarada e sem atividade, também só com o estado; o follow-up não troca', () => {
    const { state, results } = feed(
      [R.taskStarted('tc', AT), agentMessage('/root', '/root/revisar_testes', `Revise os testes de soma ${GHP}`), agentMessage('/root', '/root/revisar_testes', 'Agora documente o módulo')],
      createCodexState(childMeta()),
    );
    expect(state.title).toBe('Revise os testes de soma gh*_***');
    expect(results.map((r) => r.changed)).toEqual([false, true, false]);
    expect(ids(results)).toEqual([]);
    const quiet = createCodexState(childMeta());
    parseRolloutLine(quiet, agentMessage('/root', '/root/revisar_testes', 'Liste os arquivos de src'), { idPrefix: '', now: 0, activities: false });
    expect(quiet.title).toBe('Liste os arquivos de src');
  });

  it('0.160.1, pai: spawn_agent com a mensagem cifrada: título pelo task_name, atividade neutra com o nome da tarefa e nada cifrado em lugar nenhum', () => {
    const { results } = feed([R.meta(T, { at: AT }), R.taskStarted('t', AT), spawnEncrypted('call_sp', 'listar_arquivos', AT), sub('call_sp', 'started', CHILD, '/root/listar_arquivos')]);
    expect(acts(results).map((a) => [a.id, a.kind, a.text, a.tool])).toEqual([['acc:t#call_sp', 'delegate', 'Delegando ao subagente listar_arquivos', 'Agent']]);
    expect(spawnsOf(results)).toStrictEqual([{ type: 'spawn', childThreadId: CHILD, title: 'listar_arquivos' }]);
    expect(JSON.stringify(results)).not.toContain('gAAAAA');
    // CollabAgentToolCall com o prompt cifrado: sem título (o filho dá o dele) e a atividade genérica.
    const collab = itemLine(T, 't', { type: 'CollabAgentToolCall', id: 'call_v1', tool: 'spawn_agent', status: 'completed', receiver_thread_ids: [CHILD2], prompt: fernet('v1') }, AT);
    const v1 = feed([R.meta(T), collab]);
    expect(acts(v1.results).map((a) => a.text)).toEqual(['Chamando um subagente']);
    expect(spawnsOf(v1.results)).toEqual([]);
    expect(JSON.stringify(v1.results)).not.toContain('gAAAAA');
  });

  it('0.160.1, filho: o envelope "Message Type: NEW_TASK…" (conteúdo cifrado à parte) dá a tarefa do "Task name", nunca o cabeçalho; payload em claro vale', () => {
    const { state } = feed([R.taskStarted('tc', AT), envelope({ recipient: '/root/explorar/listar_arquivos', sender: '/root/explorar', at: AT })], createCodexState(childMeta()));
    expect(state.title).toBe('listar_arquivos');
    const clear = createCodexState(childMeta());
    parseRolloutLine(clear, envelope({ recipient: '/root/listar', sender: '/root', payload: `Liste os arquivos de src ${GHP}`, at: AT }), { idPrefix: '', now: 0, activities: false });
    expect(clear.title).toBe('Liste os arquivos de src gh*_***');
    // Payload cifrado em linha: cai no nome da tarefa.
    const sealed = createCodexState(childMeta());
    parseRolloutLine(sealed, envelope({ recipient: '/root/revisar', sender: '/root', payload: fernet('p'), at: AT }), { idPrefix: '', now: 0, activities: false });
    expect(sealed.title).toBe('revisar');
    for (const s of [state, clear, sealed]) expect(s.title).not.toMatch(/Message Type|Task name|gAAAAA/);
  });

  it('isEncryptedText: token no formato Fernet (com ou sem "=" e brancos em volta) é cifrado; texto comum, curto ou com espaço no meio não', () => {
    expect(isEncryptedText(fernet())).toBe(true);
    expect(isEncryptedText(`  ${fernet('x')}==\n`)).toBe(true);
    expect(isEncryptedText('gAAAAA123')).toBe(false);
    expect(isEncryptedText(`gAAAAAB${'a'.repeat(30)} texto`)).toBe(false);
    expect(isEncryptedText('Revise os testes de soma')).toBe(false);
  });

  it('raiz: a mensagem de um filho não vira título; herança do fork (ordinal < historyStart) não conta, não emite spawn nem dá título', () => {
    const root = feed([R.meta(T), agentMessage('/root/revisar_testes', '/root', 'Terminei: 3 testes corrigidos')]);
    expect(root.state.title).toBeUndefined();
    const { state, results } = feed(
      [
        withOrdinal(sub('call_old', 'started', CHILD2, '/root/antigo'), 2),
        withOrdinal(agentMessage('/root', '/root/antigo', 'Tarefa herdada do pai'), 3),
        withOrdinal(agentMessage('/root', '/root/revisar_testes', 'Tarefa do filho'), 6),
      ],
      createCodexState(childMeta({ subagent_history_start_ordinal: 5 })),
    );
    expect(state.stats.subagents).toBe(0);
    expect(spawnsOf(results)).toEqual([]);
    expect(state.title).toBe('Tarefa do filho');
  });
});

describe('Extension (web.search, clock.sleep, image_gen) e web::run (P12)', () => {
  const ext = (id: string, kind: string, extra: Record<string, unknown> = {}) => itemLine(T, 't', { type: 'Extension', kind, id, ...extra }, AT);
  const usingRunOrSleep = (results: CodexLineResult[]) => acts(results).some((a) => /^Usando (run|sleep)/.test(a.text));

  it('itens de extensão viram atividades próprias e contam como ferramenta; o clock.sleep cai na mesma atividade do function_call; tipo desconhecido não gera nada', () => {
    const { state, results } = feed([
      R.meta(T),
      ext('exec-1', 'web.search', { query: 'vitest each', action: { type: 'search', query: 'vitest each', queries: null }, results: [] }),
      ext('exec-2', 'web.search', { action: { type: 'open_page', url: 'https://vitest.dev/api/' } }),
      R.functionCall('call_s', 'sleep', { duration_ms: 15_000 }, AT, 'clock'),
      ext('call_s', 'clock.sleep', { durationMs: 15_000 }),
      ext('exec-3', 'image_gen.generation', { status: 'completed', revisedPrompt: `Um gato de pixel art ${GHP}`, result: 'x', transparentBackground: null, failure: null, savedPath: 'imagens/gato.png' }),
      ext('exec-4', 'outra.extensao', {}),
    ]);
    expect(acts(results).map((a) => [a.id, a.kind, a.text, a.tool])).toEqual([
      ['acc:t#exec-1', 'web', 'Pesquisando “vitest each”', 'WebSearch'],
      ['acc:t#exec-2', 'web', 'Lendo vitest.dev', 'WebFetch'],
      ['acc:t#call_s', 'wait', 'Esperando um pouco', 'clock.sleep'],
      ['acc:t#call_s', 'wait', 'Esperando um pouco', 'clock.sleep'],
      ['acc:t#exec-3', 'other', 'Gerando imagem', 'image_gen'],
    ]);
    expect(acts(results)[3].durationMs).toBe(15_000);
    expect(acts(results)[4].detail).toBe('Um gato de pixel art gh*_***');
    expect(state.stats.toolCalls).toBe(4);
    expect(state.pending.size).toBe(0);
    expect(usingRunOrSleep(results)).toBe(false);
  });

  it('web::run (function_call run no namespace web): busca, página ou busca genérica, nunca "Usando run"', () => {
    const { results } = feed([
      R.meta(T),
      R.functionCall('call_w1', 'run', { search_query: [{ q: 'formato do rollout' }], response_length: 'short' }, AT, 'web'),
      R.functionCall('call_w2', 'run', { open: [{ ref_id: 'https://example.com/docs' }] }, AT, 'web'),
      R.functionCall('call_w3', 'run', { search_query: ['texto solto'] }, AT, 'web'),
      R.functionCall('call_w4', 'run', {}, AT, 'web'),
    ]);
    expect(acts(results).map((a) => [a.id, a.kind, a.text, a.tool])).toEqual([
      ['acc:t#call_w1', 'web', 'Pesquisando “formato do rollout”', 'WebSearch'],
      ['acc:t#call_w2', 'web', 'Lendo example.com', 'WebFetch'],
      ['acc:t#call_w3', 'web', 'Pesquisando “texto solto”', 'WebSearch'],
      ['acc:t#call_w4', 'web', 'Pesquisando na web', 'WebSearch'],
    ]);
    expect(usingRunOrSleep(results)).toBe(false);
    // Outros namespaces continuam como estão (só web e clock ganham nome composto).
    expect(describeCodexTool('load_workspace_dependencies', {}, 'codex_app').desc.text).toBe('Usando load_workspace_dependencies');
  });

  it('no legacy, o function_call já contou: o Extension do clock.sleep não conta de novo nem muda o formato', () => {
    const { state } = feed([R.meta(T, { history: null }), R.functionCall('call_s', 'sleep', { duration_ms: 1_000 }, AT, 'clock'), ext('call_s', 'clock.sleep', { durationMs: 1_000 })]);
    expect(state.stats.toolCalls).toBe(1);
    expect(state.mode).toBe('legacy');
  });
});

describe('segredos mascarados antes de qualquer corte, com um teto alto e fixo (C8)', () => {
  // Montados em partes: nenhum token inteiro no código.
  const jwt = 'ey' + 'J' + 'a'.repeat(20) + '.' + 'b'.repeat(245) + '.' + 'c'.repeat(30);
  const ghp = 'gh' + 'p_' + 'Z9'.repeat(20);
  const JWT_LEAK = 'ey' + 'Ja';
  const GHP_LEAK = 'gh' + 'p_Z';
  const CHILD = threadId(20);

  // O 2º token começa antes do corte antigo e o atravessa: cortado ali, sobraria menos do que a máscara exige (6
  // caracteres depois do ghp_, 3 no último trecho do JWT) e o começo dele apareceria no texto visível. Os brancos
  // entre um e outro colapsam na hora do corte visível.
  const crossings: Array<[string, (cut: number) => string]> = [
    ['ghp atravessa o corte, depois de um JWT de ~300 caracteres', (cut) => `${jwt}${' '.repeat(cut - jwt.length - 10)}${ghp} resto`],
    ['JWT atravessa o corte, depois de um ghp', (cut) => `${ghp}${' '.repeat(cut - ghp.length - 273)}${jwt} resto`],
  ];

  const turn = (text: string) => [R.meta(T, { at: AT }), R.taskStarted('t1', AT), R.user(T, 't1', 'u1', text, AT + 1)];
  const promptActs = (text: string) => acts(feed(turn(text)).results).filter((a) => a.kind === 'prompt');
  const ask = (text: string) =>
    feed([R.meta(T, { at: AT }), R.taskStarted('t1', AT), R.functionCall('c1', 'request_user_input', { questions: [{ id: 'q', header: 'X', question: text, options: [] }] }, AT), R.functionOutput('c1', '{"answers":{}}', AT + 1_000)]).results;

  /** [ponto, tamanho do corte antigo, texto visível que sai de um texto com o token atravessando o corte] */
  const paths: Array<[string, number, (text: string) => Array<string | undefined>]> = [
    ['prompt: texto de 34', 1_000, (text) => promptActs(text).map((a) => a.text)],
    ['prompt: detalhe', 1_200, (text) => promptActs(text).map((a) => a.detail)],
    ['título da sessão', 1_000, (text) => [feed(turn(text)).state.title]],
    [
      'título do filho (spawn)',
      1_000,
      (text) =>
        signalsOf(feed([itemLine(T, 't', { type: 'CollabAgentToolCall', id: 'sp1', tool: 'spawn_agent', status: 'completed', sender_thread_id: T, receiver_thread_ids: [CHILD], receiver_agents: [], agents_states: {}, prompt: text }, AT)]).results).flatMap((s) =>
          s.type === 'spawn' ? [s.title] : [],
        ),
    ],
    ['plano', 480, (text) => feed([R.meta(T), R.functionCall('p1', 'update_plan', { plan: [{ step: text, status: 'pending' }] }, AT)]).state.tasks.map((t) => t.title)],
    ['spawn_agent', 600, (text) => [describeCodexTool('spawn_agent', { message: text }).desc.text]],
    [
      'pergunta (request_user_input)',
      960,
      (text) => {
        const results = ask(text);
        const asking = signalsOf(results).flatMap((s) => (s.type === 'asking' ? [s.questions] : []));
        return [...asking, ...acts(results).filter((a) => a.id.endsWith(':ans')).map((a) => a.detail)];
      },
    ],
    ['image_gen', 1_200, (text) => acts(feed([R.meta(T), itemLine(T, 't', { type: 'Extension', kind: 'image_gen.generation', id: 'img1', status: 'completed', revisedPrompt: text }, AT)]).results).map((a) => a.detail)],
    ['erro de comando (firstLine)', 1_120, (text) => acts(feed([execItem('c1', ['bash', '-lc', 'npm run deploy'], { exit: 1, output: `${text}\nlinha 2` })]).results).filter((a) => a.kind === 'error').map((a) => a.detail)],
    [
      'busca do parsed_cmd',
      600,
      (text) => acts(feed([execItem('s1', ['pwsh.exe', '-Command', 'Select-String x'], { parsed: [{ type: 'search', cmd: 'Select-String x', query: text }] })]).results).flatMap((a) => [a.text, a.detail]),
    ],
  ];

  const cases = paths.flatMap(([name, cut, run]) => crossings.map(([how, build]) => [name, how, cut, run, build] as const));

  it.each(cases)('%s — %s: nenhum pedaço de token sem máscara no texto visível', (_name, _how, cut, run, build) => {
    const shown = run(build(cut)).filter((s): s is string => s !== undefined);
    expect(shown.length).toBeGreaterThan(0);
    for (const s of shown) {
      expect(s).not.toContain(JWT_LEAK);
      expect(s).not.toContain(GHP_LEAK);
    }
    const all = shown.join('\n');
    expect(all).toContain('eyJ***');
    expect(all).toContain('gh*_***');
  });

  it('teto de 16 KiB: o corte vai no último espaço antes dele, então o token que cruza o teto some inteiro em vez de aparecer pela metade', () => {
    const ceiling = 16 * 1024;
    const text = `${jwt}${' '.repeat(ceiling - jwt.length - 10)}${ghp} resto`;
    const [prompt] = promptActs(text);
    expect(prompt.text).toBe('Recebeu “eyJ***”');
    expect(prompt.detail).toBe('eyJ***');
    expect(feed(turn(text)).state.title).toBe('eyJ***');
  });

  it('texto enorme sem nenhum espaço: corta no teto e continua dentro dos limites visíveis', () => {
    const [prompt] = promptActs('a'.repeat(40_000));
    expect(prompt.text.length).toBeLessThanOrEqual(46);
    expect(prompt.detail?.length).toBeLessThanOrEqual(300);
    expect(feed(turn('a'.repeat(40_000))).state.title?.length).toBeLessThanOrEqual(90);
  });
});

describe('texto livre entregue às descrições compartilhadas chega mascarado (C8, complemento)', () => {
  // Montados em partes: nenhum token inteiro no código.
  const ghp = 'gh' + 'p_' + 'Z9'.repeat(20);
  const jwt = 'ey' + 'J' + 'a'.repeat(20) + '.' + 'b'.repeat(245) + '.' + 'c'.repeat(30);
  const GHP_LEAK = 'gh' + 'p_Z';
  const JWT_LEAK = 'ey' + 'Ja';
  const respItem = (payload: Record<string, unknown>) => JSON.stringify({ timestamp: new Date(AT).toISOString(), type: 'response_item', payload });

  // O shared/activity.ts corta antes de mascarar (truncate(q, 28), slice(0, 368), slice(0, 1200)...). O token começa
  // 10 caracteres antes desse corte: cortado ali, sobram 6 depois do prefixo (a máscara exige 16) e o começo apareceria
  // no texto visível. Corte curto: o texto à frente aparece. Corte longo: brancos à frente, que colapsam.
  const small = (cut: number) => `${'x'.repeat(cut - 11)} ${ghp}`;
  const viaGhp = (cut: number) => `${' '.repeat(cut - 10)}${ghp} resto`;
  const viaJwt = (cut: number) => `${' '.repeat(cut - 273)}${jwt} resto`;
  /** Textos que atravessam `cut` (já descontado o que a função compartilhada põe à frente). */
  const builds = (cut: number): Array<[string, string]> => (cut < 100 ? [['ghp', small(cut)]] : cut < 300 ? [['ghp', viaGhp(cut)]] : [['ghp', viaGhp(cut)], ['JWT', viaJwt(cut)]]);

  type Row = { name: string; cuts: number[]; shift?: number; run: (text: string) => Array<string | undefined> };
  const textAndDetail = (r: ReturnType<typeof describeCodexTool>) => [r.desc.text, r.desc.detail];
  const pushed = (lines: string[]) => acts(feed(lines).results).flatMap((a) => [a.text, a.detail]);
  const ask =(field: 'question' | 'header' | 'label' | 'description') => (text: string) => {
    const option = { label: field === 'label' ? text : 'A', ...(field === 'description' ? { description: text } : {}) };
    const { desc } = describeCodexTool('request_user_input', { questions: [{ id: 'q', header: field === 'header' ? text : 'X', question: field === 'question' ? text : 'Qual?', options: [option] }] });
    return [desc.detail, ...(desc.questions ?? []).flatMap((q) => [q.question, q.header, ...q.options.flatMap((o) => [o.label, o.description])])];
  };
  const PT = 'Conferindo a saída do teste ';

  const rows: Row[] = [
    { name: 'Bash: comando (exec_command)', cuts: [1_200], shift: 5, run: (t) => textAndDetail(describeCodexTool('exec_command', { cmd: `echo ${t}` })) },
    // O 'a' à frente: a description é aparada (trim) antes de ir para o detalhe e os brancos iniciais sumiriam.
    { name: 'Bash: description em inglês, no detalhe', cuts: [1_200], shift: 1, run: (t) => textAndDetail(describeCodexTool('exec_command', { cmd: 'frobnicate --x', description: `a${t}` })) },
    { name: 'Bash: description em português, no texto', cuts: [368], shift: PT.length, run: (t) => textAndDetail(describeCodexTool('exec_command', { cmd: 'frobnicate --x', description: `${PT}${t}` })) },
    { name: 'Bash: CommandExecution', cuts: [1_200], shift: 5, run: (t) => pushed([R.meta(T, { at: AT }), R.command(T, 't1', 'c1', `echo ${t}`, { at: AT })]) },
    { name: 'Bash: local_shell_call', cuts: [1_200], shift: 5, run: (t) => pushed([R.meta(T, { at: AT }), respItem({ type: 'local_shell_call', call_id: 'l1', action: { command: ['bash', '-lc', `echo ${t}`] } })]) },
    { name: 'WebSearch: web_search', cuts: [28, 1_200], run: (t) => textAndDetail(describeCodexTool('web_search', { query: t })) },
    { name: 'WebSearch: web.run', cuts: [28, 1_200], run: (t) => textAndDetail(describeCodexTool('run', { search_query: [{ q: t }] }, 'web')) },
    { name: 'WebSearch: Extension web.search', cuts: [28, 1_200], run: (t) => pushed([R.meta(T, { at: AT }), itemLine(T, 't', { type: 'Extension', kind: 'web.search', id: 'w1', query: t, action: { type: 'search', query: t } }, AT)]) },
    { name: 'WebSearch: item WebSearch', cuts: [28, 1_200], run: (t) => pushed([R.meta(T, { at: AT }), itemLine(T, 't', { type: 'WebSearch', id: 'w1', query: t }, AT)]) },
    { name: 'WebSearch: web_search_call (legacy)', cuts: [28, 1_200], run: (t) => pushed([R.meta(T, { at: AT, history: null }), respItem({ type: 'web_search_call', action: { type: 'search', query: t } })]) },
    { name: 'Agent: subagent_type', cuts: [1_200], run: (t) => textAndDetail(describeCodexTool('spawn_agent', { message: 'Revise os testes', agent_type: t })) },
    { name: 'AskUserQuestion: pergunta', cuts: [1_200], run: ask('question') },
    { name: 'AskUserQuestion: cabeçalho', cuts: [120], run: ask('header') },
    { name: 'AskUserQuestion: rótulo da opção', cuts: [320], run: ask('label') },
    { name: 'AskUserQuestion: descrição da opção', cuts: [800], run: ask('description') },
    { name: 'AskUserQuestion: pelo nome (caminho genérico)', cuts: [1_200], run: (t) => textAndDetail(describeCodexTool('AskUserQuestion', { questions: [{ question: t, options: [] }] })) },
    { name: 'resposta: agent_message (legacy)', cuts: [1_200], run: (t) => pushed([R.meta(T, { at: AT, history: null }), R.legacyAgent(t, AT)]) },
    // O 'a' à frente: o texto do AgentMessage é aparado (trim) e os brancos iniciais sumiriam.
    { name: 'resposta: AgentMessage', cuts: [1_200], shift: 1, run: (t) => pushed([R.meta(T, { at: AT }), R.taskStarted('t1', AT), R.agent(T, 't1', 'a1', `a${t}`, AT)]) },
    { name: 'resposta: user_messaging.send_message', cuts: [1_200], run: (t) => pushed([R.meta(T, { at: AT }), R.mcp(T, 't1', 'm1', 'user_messaging', 'send_message', { text: t }, { at: AT })]) },
    { name: 'resposta: entrega do code mode', cuts: [1_200], run: (t) => pushed([R.meta(T, { at: AT }), R.delivered('m2', t, AT)]) },
    { name: 'genérico: Glob (pattern)', cuts: [30, 1_200], run: (t) => textAndDetail(describeCodexTool('Glob', { pattern: t })) },
    { name: 'genérico: Skill', cuts: [368], shift: 15, run: (t) => textAndDetail(describeCodexTool('Skill', { skill: t })) },
    { name: 'genérico: SendMessage', cuts: [1_200], run: (t) => textAndDetail(describeCodexTool('SendMessage', { message: t })) },
  ];

  const cases = rows.flatMap((r) => r.cuts.flatMap((cut) => builds(cut - (r.shift ?? 0)).map(([token, text]) => [r.name, cut, token, r.run, text] as const)));

  it.each(cases)('%s — corte %i, token %s: nenhum pedaço sem máscara no texto visível', (_name, _cut, token, run, text) => {
    const shown = run(text).filter((s): s is string => s !== undefined);
    expect(shown.length).toBeGreaterThan(0);
    for (const s of shown) {
      expect(s).not.toContain(JWT_LEAK);
      expect(s).not.toContain(GHP_LEAK);
    }
    expect(shown.join('\n')).toContain(token === 'ghp' ? 'gh*_***' : 'eyJ***');
  });
});
