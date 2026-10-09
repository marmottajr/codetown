// Comandos em segundo plano do Codex lidos das linhas cruas do rollout (unified exec e code mode), com linhas SINTÉTICAS.
import { describe, expect, it } from 'vitest';
import { describeShellJob } from '../../../shared/activity';
import { threadId } from '../../test/codex-fixtures';
import { B, withOrdinal } from '../../test/codex-fixtures-source-ii';
import { createShellScan, scanShellLine, type CodexShellEvent } from './shells';

const T = threadId(1);
const AT = Date.UTC(2026, 9, 9, 12, 0, 0);

/** Eventos de cada linha, na ordem, com um scan só. */
function feed(lines: string[], historyStart?: number): CodexShellEvent[][] {
  const scan = createShellScan();
  return lines.map((l) => scanShellLine(scan, l, { historyStart }));
}

describe('scanShellLine: unified exec', () => {
  it('exec_command com "Process running with session ID N" abre proc:N com o rótulo e o comando mascarados; o write_stdin que ainda roda não fecha; "Process exited" fecha', () => {
    const token = 'gh' + 'p_' + 'B2'.repeat(18);
    const cmd = `npm run dev -- --token ${token}`;
    const out = feed([
      B.exec('call_dev', cmd, AT),
      B.running('call_dev', 7, AT + 10_000),
      B.stdin('call_poll', 7, AT + 20_000),
      B.running('call_poll', 7, AT + 30_000),
      B.stdin('call_end', 7, AT + 40_000),
      B.exited('call_end', 1, AT + 41_000),
    ]);
    const job = describeShellJob('Bash', { command: cmd });
    expect(out[1]).toEqual([{ type: 'start', callId: 'call_dev', taskId: 'proc:7', label: job.label, command: job.command }]);
    expect(JSON.stringify(out[1])).not.toContain(token);
    expect(out.slice(2, 4)).toEqual([[], []]);
    expect(out[5]).toEqual([{ type: 'end', taskId: 'proc:7', status: 'failed', summary: 'exit code 1' }]);
    expect(out[0]).toEqual([]);
  });

  it('comando do PowerShell sai desembrulhado; exec_command que termina na própria saída não abre nada; CommandExecution com process_id fecha o proc:N', () => {
    const out = feed([
      B.exec('call_ps', 'pwsh.exe -NoProfile -Command "npm run watch"', AT),
      B.running('call_ps', 8, AT + 10_000),
      B.exec('call_t', 'npm test', AT + 11_000),
      B.exited('call_t', 0, AT + 12_000),
      B.procDone(T, 'turn1', 'call_ps', 8, 0, AT + 48_000, 'npm run watch'),
    ]);
    const { label, command } = describeShellJob('Bash', { command: 'npm run watch' });
    expect(out[1]).toEqual([{ type: 'start', callId: 'call_ps', taskId: 'proc:8', label, command }]);
    expect(out[3]).toEqual([]);
    expect(out[4]).toEqual([{ type: 'end', taskId: 'proc:8', status: 'completed', summary: 'exit code 0' }]);
  });
});

describe('scanShellLine: code mode', () => {
  it('exec com "Script running with cell ID N" abre cell:N ("Rodando script"); o wait que ainda roda não fecha; failed, terminated e o resto fecham com o desfecho certo', () => {
    const out = feed([
      B.code('call_js', 'await tools.exec_command({ cmd: "npm run dev" });', AT),
      B.codeOutput('call_js', 'Script running with cell ID 3\nWall time: 10.0 seconds', AT + 10_000),
      B.wait('call_w1', '3', AT + 11_000),
      B.waitOutput('call_w1', 'Script running with cell ID 3\nWall time: 30.0 seconds', AT + 41_000),
      B.wait('call_w2', '3', AT + 42_000),
      B.waitOutput('call_w2', 'Script failed\nError: 1 teste falhou', AT + 50_000),
      B.code('call_js4', 'await tools.exec_command({ cmd: "npm run serve" });', AT + 51_000),
      B.codeOutput('call_js4', 'Script running with cell ID 4', AT + 52_000),
      B.wait('call_w4', '4', AT + 53_000),
      B.waitOutput('call_w4', 'Script terminated', AT + 54_000),
      B.code('call_js5', 'text("ok")', AT + 55_000),
      B.codeOutput('call_js5', 'Script running with cell ID 5', AT + 56_000),
      B.wait('call_w5', '5', AT + 57_000),
      B.waitOutput('call_w5', 'Script completed\nok', AT + 58_000),
    ]);
    expect(out[1]).toEqual([{ type: 'start', callId: 'call_js', taskId: 'cell:3', label: 'Rodando script' }]);
    expect(out[3]).toEqual([]);
    expect(out[5]).toEqual([{ type: 'end', taskId: 'cell:3', status: 'failed' }]);
    expect(out[9]).toEqual([{ type: 'end', taskId: 'cell:4', status: 'killed' }]);
    expect(out[13]).toEqual([{ type: 'end', taskId: 'cell:5', status: 'completed' }]);
  });
});

describe('scanShellLine: o que não conta', () => {
  it('herança de um fork (ordinal < subagent_history_start_ordinal), linha inválida e saída de chamada desconhecida não geram nada', () => {
    const inherited = feed([withOrdinal(B.exec('call_old', 'npm run dev', AT), 3), withOrdinal(B.running('call_old', 9, AT + 1), 4)], 10);
    expect(inherited).toEqual([[], []]);
    const own = feed([withOrdinal(B.exec('call_new', 'npm run dev', AT), 12), withOrdinal(B.running('call_new', 9, AT + 1), 13)], 10);
    expect(own[1]).toHaveLength(1);
    expect(feed(['{"timestamp": "quebrado', B.running('call_x', 5, AT), B.exited('call_y', 0, AT)])).toEqual([[], [], []]);
  });
});
