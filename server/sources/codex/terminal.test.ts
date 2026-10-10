// Terminal do Codex: linhas sintéticas de rollout (paginated e legacy) viram as entradas do terminal.
import { describe, expect, it } from 'vitest';
import type { TerminalEntry } from '../../../shared/types';
import { R, threadId } from '../../test/codex-fixtures';
import { fernet, sendEncrypted, spawnEncrypted } from '../../test/codex-fixtures-live';
import { parseSessionMeta } from './rollout';
import { createCodexTerminalParser } from './terminal';

const T = threadId(1);
const CWD = '/projetos/loja';
// Token falso montado em partes (nada de segredo literal no repositório).
const TOKEN = ['sk', 'ant', 'api03', 'testeFALSO0123456789abcdefXYZ'].join('-');

type ToolEntry = Extract<TerminalEntry, { kind: 'tool' }>;
type ResultEntry = Extract<TerminalEntry, { kind: 'result' }>;

function entries(lines: string[]): TerminalEntry[] {
  const p = createCodexTerminalParser();
  return lines.flatMap((l) => p.push(l));
}

const tools = (out: TerminalEntry[]) => out.filter((e): e is ToolEntry => e.kind === 'tool');
const results = (out: TerminalEntry[]) => out.filter((e): e is ResultEntry => e.kind === 'result');
/** [tipo, título ou texto] de cada entrada: a conversa sem depender dos ids. */
const shape = (out: TerminalEntry[]) => out.map((e) => [e.kind, e.kind === 'tool' ? e.title : e.kind === 'thinking' ? (e.text ?? '') : e.text]);

/** event_msg/item_completed com um TurnItem qualquer. */
function item(it: Record<string, unknown>, at = Date.now()): string {
  return JSON.stringify({ timestamp: new Date(at).toISOString(), type: 'event_msg', payload: { type: 'item_completed', thread_id: T, turn_id: 't', item: it } });
}

/** CommandExecution com a lista que o Codex manda ao sistema (pwsh, cmd, sh). */
function commandItem(id: string, command: string[], o: { exit?: number; output?: string } = {}): string {
  const exit = o.exit ?? 0;
  return item({ type: 'CommandExecution', id, command, cwd: `file://${CWD}`, status: exit === 0 ? 'completed' : 'failed', exit_code: exit, aggregated_output: o.output ?? '' });
}

/** custom_tool_call_output (saída do apply_patch e do exec do code mode). */
function customOutput(callId: string, output: unknown, at = Date.now()): string {
  return JSON.stringify({ timestamp: new Date(at).toISOString(), type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: callId, output } });
}

/** A mesma linha com o `ordinal` do formato paginated. */
function ord(line: string, ordinal: number): string {
  return JSON.stringify({ ...JSON.parse(line), ordinal });
}

/** session_meta de um subagente com fork: as linhas com ordinal < start são a história herdada do pai. */
function subMeta(t: string, start: number): string {
  const j = JSON.parse(R.meta(t, { cwd: CWD }));
  j.payload.subagent_history_start_ordinal = start;
  return JSON.stringify(j);
}

describe('terminal do Codex', () => {
  it('paginated: prompt, raciocínio resumido, comando com a saída, diff, MCP e fim do turno', () => {
    const out = entries([
      R.meta(T, { cwd: '/projetos/loja' }),
      R.message('developer', 'instruções injetadas que não aparecem'),
      R.message('user', '<environment_context>nada</environment_context>'),
      R.user(T, 't', 'u1', 'Rode os testes com o token sk-ant-abcdefghijklmnop'),
      R.reasoning(T, 't', 'r1', ['**Lendo** o projeto']),
      // A chamada vem depois do prompt, como no rollout real, e vira a entrada da ferramenta na hora; o
      // CommandExecution de mesmo id só traz o resultado.
      R.functionCall('c1', 'exec_command', { cmd: 'npm test' }),
      R.command(T, 't', 'c1', 'npm test', { exit: 1, output: 'FAIL src/a.test.ts\n' }),
      R.fileChange(T, 't', 'p1', { '/projetos/loja/src/a.ts': { type: 'update', unified_diff: '@@ -1 +1 @@\n-velho\n+novo\n' } }),
      R.mcp(T, 't', 'm1', 'github', 'get_issue', { owner: 'o', repo: 'r', issue_number: 1 }, { result: 'Issue 1: bug' }),
      R.agent(T, 't', 'a1', 'Corrigi o **teste**.'),
      R.taskComplete('t', Date.now(), 65_000),
    ]);
    expect(out.map((e) => e.kind)).toEqual(['user', 'thinking', 'tool', 'result', 'tool', 'tool', 'result', 'assistant', 'system']);
    expect(out[0]).toMatchObject({ kind: 'user', id: 'u1:u', text: 'Rode os testes com o token sk-***' });
    expect(out[1]).toMatchObject({ kind: 'thinking', text: '**Lendo** o projeto' });
    expect(out[2]).toMatchObject({ kind: 'tool', id: 'c1', tool: 'Bash', title: 'Bash(npm test)', input: 'npm test', inputKind: 'command' });
    expect(out[3]).toMatchObject({ kind: 'result', toolUseId: 'c1', error: true, text: 'Código de saída 1\nFAIL src/a.test.ts' });
    expect(out[4]).toMatchObject({ kind: 'tool', tool: 'Edit', title: 'Edit(src/a.ts)', inputKind: 'diff' });
    expect((out[4] as { input?: string }).input).toContain('+novo');
    expect(out[5]).toMatchObject({ kind: 'tool', tool: 'mcp__github__get_issue', title: 'github - get_issue (MCP)' });
    expect(out[6]).toMatchObject({ kind: 'result', toolUseId: 'm1', text: 'Issue 1: bug' });
    expect(out[7]).toMatchObject({ kind: 'assistant', text: 'Corrigi o **teste**.' });
    expect(out[8]).toMatchObject({ kind: 'system', text: 'Turno concluído em 1min 5s' });
  });

  it('saída longa: truncada e marcada; turno interrompido', () => {
    const long = Array.from({ length: 400 }, (_, i) => `linha ${i}`).join('\n');
    const out = entries([R.meta(T), R.command(T, 't', 'c1', 'cat log.txt', { output: long }), R.turnAborted('t')]);
    expect(out[1]).toMatchObject({ kind: 'result', truncated: true });
    expect((out[1] as { text: string }).text.split('\n').length).toBeLessThanOrEqual(120);
    expect(out[2]).toMatchObject({ kind: 'system', text: 'Interrompido pelo usuário', level: 'warn' });
  });

  it('legacy: prompt, resposta, raciocínio e o par function_call / saída', () => {
    const out = entries([
      R.meta(T, { history: null }),
      R.legacyUser('Liste os arquivos'),
      R.legacyReasoning('vou listar'),
      R.functionCall('c1', 'shell', { command: ['bash', '-lc', 'ls'] }),
      R.functionOutput('c1', JSON.stringify({ output: 'a.ts\nb.ts', metadata: { exit_code: 0 } })),
      R.legacyAgent('Dois arquivos.'),
    ]);
    expect(out.map((e) => [e.kind, 'text' in e ? e.text : 'title' in e ? e.title : ''])).toEqual([
      ['user', 'Liste os arquivos'],
      ['thinking', 'vou listar'],
      ['tool', 'Bash(ls)'],
      ['result', 'a.ts\nb.ts'],
      ['assistant', 'Dois arquivos.'],
    ]);
  });

  it('code mode do app: a mensagem enviada a você vira resposta, uma vez só', () => {
    const out = entries([
      R.meta(T),
      R.delivered('call_msg', 'Achei o **bug**'),
      R.mcp(T, 't', 'call_msg', 'codex_apps', 'user_messaging_send_message', { text: 'Achei o **bug**' }, { result: 'ok' }),
      R.message('assistant', 'contexto que não aparece'),
    ]);
    expect(out).toEqual([{ kind: 'assistant', id: 'call_msg', at: expect.any(Number), text: 'Achei o **bug**' }]);
  });

  // Na 0.7.0 o paginated descartava de propósito as chamadas de response_item: isso escondia o comando em andamento
  // e o shell_command de rollouts migrados, que não têm CommandExecution (P6). Os eventos legacy e as mensagens de
  // contexto (que têm gêmeo em item_completed) continuam de fora.
  it('paginated ignora os eventos legacy e as mensagens de contexto; a chamada de response_item vira entrada e a saída a completa', () => {
    const out = entries([
      R.meta(T),
      R.legacyUser('dup'),
      R.legacyAgent('dup'),
      R.message('user', 'contexto'),
      R.message('assistant', 'contexto'),
      R.functionCall('c1', 'exec_command', { cmd: 'ls' }),
      R.functionOutput('c1', 'x'),
    ]);
    expect(out.map((e) => [e.kind, e.id])).toEqual([
      ['tool', 'c1'],
      ['result', 'c1:r'],
    ]);
  });
});

describe('terminal do Codex — response_item no paginated', () => {
  it('o function_call vira a entrada na hora (comando em andamento) e a saída completa a mesma entrada', () => {
    const p = createCodexTerminalParser();
    p.push(R.meta(T));
    expect(p.push(R.functionCall('c1', 'shell_command', { command: 'npm test', workdir: CWD }))).toEqual([
      { kind: 'tool', id: 'c1', at: expect.any(Number), tool: 'Bash', title: 'Bash(npm test)', input: 'npm test', inputKind: 'command' },
    ]);
    // shell_command de rollout migrado (≤ 0.142): não há CommandExecution; o resultado vem da saída.
    expect(p.push(R.functionOutput('c1', 'Exit code: 1\nWall time: 5.8 seconds\nOutput:\nFAIL src/a.test.ts'))).toEqual([
      { kind: 'result', id: 'c1:r', at: expect.any(Number), toolUseId: 'c1', text: 'Exit code: 1\nWall time: 5.8 seconds\nOutput:\nFAIL src/a.test.ts', error: true },
    ]);
  });

  it('function_call e CommandExecution de mesmo id: uma ferramenta e um resultado, nas duas ordens; reler não repete', () => {
    const call = R.functionCall('c1', 'exec_command', { cmd: 'npm run lint', yield_time_ms: 10_000 });
    const done = R.command(T, 't', 'c1', 'npm run lint', { output: 'sem problemas' });
    const output = R.functionOutput('c1', 'Chunk ID: 1\nWall time: 1.2 seconds\nProcess exited with code 0\nOutput:\nsem problemas');
    for (const lines of [
      [R.meta(T), call, done, output],
      [R.meta(T), done, call, output],
    ]) {
      const p = createCodexTerminalParser();
      const first = lines.flatMap((l) => p.push(l));
      expect(first.map((e) => [e.kind, e.id])).toEqual([
        ['tool', 'c1'],
        ['result', 'c1:r'],
      ]);
      expect(first[0]).toMatchObject({ tool: 'Bash', title: 'Bash(npm run lint)' });
      expect(first[1]).toMatchObject({ toolUseId: 'c1', text: 'sem problemas' });
      expect(first[1]).not.toHaveProperty('error');
      expect(lines.flatMap((l) => p.push(l))).toEqual([]);
    }
  });

  it('exec_command que segue rodando: a saída "Process running" não fecha a entrada; o CommandExecution de mesmo id traz o resultado', () => {
    const out = entries([
      R.meta(T),
      R.functionCall('c1', 'exec_command', { cmd: 'npm run build', yield_time_ms: 30_000 }),
      R.functionOutput('c1', 'Chunk ID: 1\nWall time: 30.0 seconds\nProcess running with session ID 7\nOriginal token count: 3\nOutput:\ncompilando'),
      R.functionCall('w1', 'write_stdin', { session_id: 7, chars: '', yield_time_ms: 30_000 }),
      R.command(T, 't', 'c1', 'npm run build', { exit: 2, output: 'erro de tipo' }),
      R.functionOutput('w1', 'Chunk ID: 2\nWall time: 4.1 seconds\nProcess exited with code 2\nOutput:\nerro de tipo'),
    ]);
    expect(out.map((e) => [e.kind, e.id])).toEqual([
      ['tool', 'c1'],
      ['tool', 'w1'],
      ['result', 'c1:r'],
      ['result', 'w1:r'],
    ]);
    expect(out[1]).toMatchObject({ tool: 'write_stdin', title: 'write_stdin(sessão 7)' });
    expect(out[1]).not.toHaveProperty('input');
    expect(out[2]).toMatchObject({ toolUseId: 'c1', text: 'Código de saída 2\nerro de tipo', error: true });
    expect(out[3]).toMatchObject({ toolUseId: 'w1', error: true });
  });

  it('erro pela saída: código de saída nos dois formatos e as falhas do exec_command e do apply_patch', () => {
    const out = entries([
      R.meta(T),
      R.functionCall('a', 'exec_command', { cmd: 'ls' }),
      R.functionOutput('a', 'Chunk ID: 1\nWall time: 0.1 seconds\nProcess exited with code 0\nOutput:\na.ts'),
      R.functionCall('b', 'exec_command', { cmd: 'npm test' }),
      R.functionOutput('b', 'Chunk ID: 2\nWall time: 3.0 seconds\nProcess exited with code 2\nOutput:\nFAIL'),
      R.functionCall('c', 'shell_command', { command: 'git status' }),
      R.functionOutput('c', 'Exit code: 0\nWall time: 0.2 seconds\nOutput:\nnada a commitar'),
      R.functionCall('d', 'exec_command', { cmd: 'programa-que-nao-existe' }),
      R.functionOutput('d', 'exec_command failed for `programa-que-nao-existe`: arquivo não encontrado'),
      R.customToolCall('e', 'apply_patch', '*** Begin Patch\n*** Delete File: src/velho.ts\n*** End Patch'),
      customOutput('e', 'apply_patch verification failed: src/velho.ts não existe'),
    ]);
    expect(results(out).map((r) => [r.toolUseId, r.error ?? false])).toEqual([
      ['a', false],
      ['b', true],
      ['c', false],
      ['d', true],
      ['e', true],
    ]);
  });

  it('comandos desembrulhados (pwsh, powershell, cmd): Bash(git status) em vez de Bash(pwsh.exe -Command ...)', () => {
    const out = entries([
      R.meta(T),
      R.functionCall('c1', 'shell_command', { command: 'pwsh.exe -NoProfile -Command "git status"' }),
      commandItem('exec-1', ['pwsh.exe', '-Command', 'npm test']),
      commandItem('exec-2', ['cmd.exe', '/d', '/s', '/c', 'dir']),
      commandItem('exec-3', ['powershell.exe', '-NoProfile', '-Command', 'git push origin main']),
    ]);
    expect(tools(out).map((t) => [t.id, t.tool, t.title, t.input])).toEqual([
      ['c1', 'Bash', 'Bash(git status)', 'git status'],
      ['exec-1', 'Bash', 'Bash(npm test)', 'npm test'],
      ['exec-2', 'Bash', 'Bash(dir)', 'dir'],
      ['exec-3', 'Bash', 'Bash(git push origin main)', 'git push origin main'],
    ]);
  });

  it('apply_patch e FileChange de mesmo id: uma entrada só, com os caminhos relativos ao cwd (Write quando só cria arquivos)', () => {
    const update = ['*** Begin Patch', `*** Update File: ${CWD}/src/a.ts`, '@@', '-velho', '+novo', '*** End Patch'].join('\n');
    const adds = ['*** Begin Patch', `*** Add File: ${CWD}/src/b.ts`, '+export const b = 1;', `*** Add File: ${CWD}/src/c.ts`, '+export const c = 2;', '*** End Patch'].join('\n');
    const three = ['*** Begin Patch', `*** Update File: ${CWD}/src/a.ts`, '@@', '-a', '+b', `*** Add File: ${CWD}/src/d.ts`, '+d', `*** Delete File: ${CWD}/src/e.ts`, '*** End Patch'].join('\n');
    const out = entries([
      R.meta(T, { cwd: CWD }),
      R.customToolCall('p1', 'apply_patch', update),
      R.fileChange(T, 't', 'p1', { [`${CWD}/src/a.ts`]: { type: 'update', unified_diff: '@@ -1 +1 @@\n-velho\n+novo\n' } }),
      customOutput('p1', 'Exit code: 0\nWall time: 0.1 seconds\nOutput:\nSuccess. Updated the following files:\nM src/a.ts'),
      R.customToolCall('p2', 'apply_patch', adds),
      R.customToolCall('p3', 'apply_patch', three),
    ]);
    expect(tools(out).map((t) => [t.id, t.tool, t.title, t.inputKind])).toEqual([
      ['p1', 'Edit', 'Edit(src/a.ts)', 'diff'],
      ['p2', 'Write', 'Write(src/b.ts, src/c.ts)', 'diff'],
      ['p3', 'Edit', 'Edit(src/a.ts e mais 2)', 'diff'],
    ]);
    expect(tools(out)[0].input).toContain('+novo');
    expect(results(out).map((r) => [r.toolUseId, r.error ?? false])).toEqual([['p1', false]]);
  });

  it('MCP pelo nome ou pelo namespace, com o mesmo nome do McpToolCall (que só traz o resultado)', () => {
    const out = entries([
      R.meta(T),
      R.functionCall('m1', 'mcp__docs__buscar', { termo: 'frete' }),
      R.functionCall('m2', 'buscar', { termo: 'cupom' }, Date.now(), 'mcp__docs'),
      R.mcp(T, 't', 'm2', 'docs', 'buscar', { termo: 'cupom' }, { result: 'achei 2 cupons' }),
      R.functionOutput('m2', 'achei 2 cupons'),
    ]);
    expect(tools(out).map((t) => [t.id, t.tool, t.title, t.inputKind])).toEqual([
      ['m1', 'mcp__docs__buscar', 'docs - buscar (MCP)', 'json'],
      ['m2', 'mcp__docs__buscar', 'docs - buscar (MCP)', 'json'],
    ]);
    expect(results(out).map((r) => [r.toolUseId, r.text])).toEqual([['m2', 'achei 2 cupons']]);
  });

  it('update_plan, request_user_input, spawn_agent, send_message e followup_task com títulos próprios', () => {
    const out = entries([
      R.meta(T),
      R.functionCall('u1', 'update_plan', {
        explanation: 'Três passos',
        plan: [
          { step: 'Ler o carrinho', status: 'completed' },
          { step: 'Corrigir o arredondamento', status: 'in_progress' },
          { step: 'Rodar os testes', status: 'pending' },
        ],
      }),
      R.functionCall('q1', 'request_user_input', {
        questions: [{ id: 'arred', header: 'Frete', question: 'Arredondar para cima?', options: [{ label: 'Sim', description: 'sempre' }, { label: 'Não' }] }],
      }),
      R.functionCall('q2', 'request_user_input_async', { questions: [{ title: 'Qual banco?', options: ['Postgres', 'SQLite'] }] }),
      R.functionCall('s1', 'spawn_agent', { task_name: 'revisar testes', agent_type: 'worker', message: 'Revise os testes do frete', fork_turns: 'none' }, Date.now(), 'collaboration'),
      R.functionCall('x1', 'send_message', { target: '/root/revisar_testes', message: 'Inclua o caso de frete zero' }, Date.now(), 'collaboration'),
      R.functionCall('f1', 'followup_task', { target: '/root/revisar_testes', message: 'Agora o frete grátis' }, Date.now(), 'collaboration'),
    ]);
    expect(tools(out).map((t) => [t.id, t.tool, t.title, t.input])).toEqual([
      ['u1', 'update_plan', 'update_plan(1/3 concluídas)', 'Três passos\n\n☒ Ler o carrinho\n◐ Corrigir o arredondamento\n☐ Rodar os testes'],
      ['q1', 'request_user_input', 'request_user_input(Arredondar para cima?)', 'Arredondar para cima?\n  - Sim: sempre\n  - Não'],
      ['q2', 'request_user_input_async', 'request_user_input_async(Qual banco?)', 'Qual banco?\n  - Postgres\n  - SQLite'],
      ['s1', 'Agent', 'Agent(worker: revisar testes)', 'Revise os testes do frete'],
      ['x1', 'send_message', 'send_message(/root/revisar_testes)', 'Inclua o caso de frete zero'],
      ['f1', 'followup_task', 'followup_task(/root/revisar_testes)', 'Agora o frete grátis'],
    ]);
    expect(tools(out).every((t) => t.inputKind === 'text')).toBe(true);
  });

  it('segredos mascarados no plano, na pergunta, nas mensagens e no comando; o texto do write_stdin nunca aparece', () => {
    const out = entries([
      R.meta(T),
      R.functionCall('u1', 'update_plan', { plan: [{ step: `Trocar ${TOKEN}`, status: 'pending' }] }),
      R.functionCall('q1', 'request_user_input', { questions: [{ question: `Uso o ${TOKEN}?`, options: [{ label: TOKEN }] }] }),
      R.functionCall('s1', 'spawn_agent', { task_name: `tarefa ${TOKEN}`, message: `Use ${TOKEN}` }),
      R.functionCall('x1', 'send_message', { target: '/root/a', message: `chave ${TOKEN}` }),
      R.functionCall('c1', 'shell_command', { command: `curl -H "Authorization: Bearer ${TOKEN}" https://exemplo.test` }),
      R.functionCall('w1', 'write_stdin', { session_id: 3, chars: 'senha-do-banco\n' }),
    ]);
    expect(tools(out)).toHaveLength(6);
    const all = JSON.stringify(out);
    expect(all).not.toContain('testeFALSO');
    expect(all).not.toContain('senha-do-banco');
    const stdin = tools(out).find((t) => t.id === 'w1');
    expect(stdin).toMatchObject({ tool: 'write_stdin', title: 'write_stdin(sessão 3, 15 caracteres)' });
    expect(stdin).not.toHaveProperty('input');
  });

  it('0.160.1: spawn_agent e send_message com a mensagem cifrada mostram "(mensagem cifrada)", nunca o texto cifrado', () => {
    const out = entries([R.meta(T), spawnEncrypted('s1', 'listar_arquivos', Date.now()), sendEncrypted('x1', '/root/listar_arquivos', Date.now())]);
    expect(tools(out).map((t) => [t.id, t.tool, t.title, t.input])).toEqual([
      ['s1', 'Agent', 'Agent(explorer: listar_arquivos)', '(mensagem cifrada)'],
      ['x1', 'send_message', 'send_message(/root/listar_arquivos)', '(mensagem cifrada)'],
    ]);
    expect(JSON.stringify(out)).not.toContain('gAAAAA');
  });

  it('0.160.1: o CollabAgentToolCall (formato paginated) com o prompt cifrado mostra "(mensagem cifrada)", nunca o texto cifrado; o legível segue como está', () => {
    const out = entries([
      R.meta(T),
      item({ type: 'CollabAgentToolCall', id: 'ca1', tool: 'spawn_agent', prompt: fernet('ca1') }),
      item({ type: 'CollabAgentToolCall', id: 'ca2', tool: 'spawn_agent', prompt: 'Liste os arquivos do módulo' }),
    ]);
    const [cifrado, legivel] = tools(out);
    expect(cifrado.title).toBe('spawn_agent((mensagem cifrada))');
    expect(legivel.title).toBe('spawn_agent(Liste os arquivos do módulo)');
    expect(JSON.stringify(out)).not.toContain('gAAAAA');
  });

  it('code mode: o exec (script em JavaScript) não vira entrada; os itens de dentro sim', () => {
    const out = entries([
      R.meta(T),
      R.customToolCall('call_js', 'exec', 'text(await tools.exec_command({ cmd: "npm test" }))'),
      commandItem('exec-1', ['pwsh.exe', '-Command', 'npm test'], { exit: 1, output: 'FAIL a.test.ts' }),
      customOutput('call_js', [{ type: 'input_text', text: 'Script failed' }]),
    ]);
    expect(shape(out)).toEqual([
      ['tool', 'Bash(npm test)'],
      ['result', 'Código de saída 1\nFAIL a.test.ts'],
    ]);
  });

  it('janela sem o cabeçalho (rollout grande): a chamada já vira entrada e o exec do code mode continua de fora', () => {
    const out = entries([
      R.customToolCall('call_js', 'exec', 'await tools.exec_command({ cmd: "ls" })'),
      R.functionCall('c1', 'shell_command', { command: 'ls' }),
      R.functionOutput('c1', 'Exit code: 0\nWall time: 0.1 seconds\nOutput:\na.ts'),
      customOutput('call_js', 'Script completed'),
    ]);
    expect(shape(out)).toEqual([
      ['tool', 'Bash(ls)'],
      ['result', 'Exit code: 0\nWall time: 0.1 seconds\nOutput:\na.ts'],
    ]);
  });

  it('mensagem para você pelo user_messaging como function_call direto: continua sendo a resposta, uma vez só', () => {
    const call = R.functionCall('call_msg', 'user_messaging_send_message', { text: 'Achei o **bug**' }, Date.now(), 'mcp__codex_apps');
    const delivered = R.delivered('call_msg', 'Achei o **bug**');
    for (const lines of [
      [R.meta(T), call, delivered],
      [R.meta(T), delivered, call],
    ]) {
      expect(entries([...lines, R.functionOutput('call_msg', 'ok')])).toEqual([{ kind: 'assistant', id: 'call_msg', at: expect.any(Number), text: 'Achei o **bug**' }]);
    }
  });

  it('subagente com fork: a história herdada (ordinal abaixo do subagent_history_start_ordinal) e o session_meta copiado do pai não aparecem', () => {
    const header = ord(subMeta(threadId(2), 4), 0);
    const parentCopy = ord(R.meta(T, { cwd: '/projetos/pai' }), 1);
    const own = [
      ord(R.functionCall('old', 'shell_command', { command: 'ls' }), 2),
      ord(R.functionOutput('old', 'Exit code: 0\nOutput:\na.ts'), 3),
      ord(R.functionCall('new', 'shell_command', { command: 'npm test' }), 4),
      ord(R.customToolCall('p1', 'apply_patch', `*** Begin Patch\n*** Update File: ${CWD}/src/a.ts\n@@\n-a\n+b\n*** End Patch`), 5),
    ];
    const expected = [
      ['tool', 'Bash(npm test)'],
      ['tool', 'Edit(src/a.ts)'],
    ];
    // Cabeçalho dentro da janela lida.
    expect(shape(entries([header, parentCopy, ...own]))).toEqual(expected);
    // Cabeçalho fora da janela (rollout grande): o session_meta lido à parte faz o mesmo papel.
    const p = createCodexTerminalParser({ meta: parseSessionMeta(JSON.parse(header).payload) });
    expect(shape(own.flatMap((l) => p.push(l)))).toEqual(expected);
    // Sem herança (resume): só o 1º session_meta vale.
    expect(shape(entries([R.meta(T, { cwd: CWD }), R.meta(T, { cwd: '/projetos/pai' }), own[3]]))).toEqual([['tool', 'Edit(src/a.ts)']]);
  });
});
