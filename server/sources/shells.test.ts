import { describe, expect, it } from 'vitest';
import { notificationOutcome, reportShellDone, SHELL_MAX_AGE_MS, shellsByOwner, ShellTracker, toShellJob, type ShellStart, type TrackedShell } from './shells';

const T0 = Date.parse('2026-10-07T08:50:00Z');

const bash = (toolUseId: string, at: number, extra: Partial<ShellStart> = {}): ShellStart => ({
  toolUseId,
  label: 'Rodar a suíte completa',
  command: 'vendor/bin/phpunit',
  background: true,
  kind: 'shell',
  at,
  ...extra,
});

describe('notificationOutcome', () => {
  it('status do Claude Code e, sem ele, o resumo', () => {
    expect(notificationOutcome('shell', 'completed', 'Background command "x" completed (exit code 0)')).toBe('ok');
    expect(notificationOutcome('shell', 'completed', 'Background command "x" completed (exit code 2)')).toBe('failed');
    expect(notificationOutcome('shell', 'failed', undefined)).toBe('failed');
    expect(notificationOutcome('shell', 'killed', undefined)).toBe('killed');
    expect(notificationOutcome('shell', undefined, 'Background command "x" failed with exit code 1')).toBe('failed');
    expect(notificationOutcome('shell', undefined, undefined)).toBe('ok');
    // Monitor: cada evento é uma notificação; só um status terminal encerra.
    expect(notificationOutcome('monitor', undefined, 'linha de log')).toBeUndefined();
    expect(notificationOutcome('monitor', 'running', undefined)).toBeUndefined();
    expect(notificationOutcome('monitor', 'completed', undefined)).toBe('ok');
  });
});

describe('ShellTracker', () => {
  it('segundo plano: lançamento troca o id pelo da tarefa; a notificação encerra uma vez só', () => {
    const s = new ShellTracker();
    s.start('main', bash('toolu_1', T0));
    expect(s.list().map(toShellJob)).toEqual([
      { id: 'toolu_1', label: 'Rodar a suíte completa', command: 'vendor/bin/phpunit', startedAt: T0, background: true, kind: 'shell' },
    ]);
    // O comando começa de fato no lançamento (depois de uma eventual aprovação).
    s.result('toolu_1', { taskId: 'bo0ov3q3l', error: false, at: T0 + 4_000 });
    expect(s.list().map(toShellJob)[0]).toMatchObject({ id: 'bo0ov3q3l', startedAt: T0 + 4_000 });
    expect(s.hasBackgroundShell(T0 + 60_000)).toBe(true);
    const fin = s.notify({ taskId: 'bo0ov3q3l', status: 'completed', summary: 'ok (exit code 0)', at: T0 + 480_000 });
    expect(fin).toMatchObject({ outcome: 'ok', at: T0 + 480_000, job: { owner: 'main', label: 'Rodar a suíte completa' } });
    expect(s.list()).toEqual([]);
    // A mesma notificação entregue de novo (fila -> mensagem) não encerra outra vez.
    expect(s.notify({ taskId: 'bo0ov3q3l', toolUseId: 'toolu_1', status: 'completed', at: T0 + 481_000 })).toBeUndefined();
    expect(s.reportedRecently({ toolUseId: 'toolu_1' }, T0 + 481_000)).toBe(true);
    // Releitura do transcript não ressuscita o job.
    s.start('main', bash('toolu_1', T0));
    expect(s.size).toBe(0);
  });

  it('primeiro plano: sai no resultado; mandado para o fundo vira segundo plano sem perder o início', () => {
    const s = new ShellTracker();
    s.start('main', bash('fg1', T0, { background: false }));
    s.start('main', bash('fg2', T0 + 1_000, { background: false }));
    expect(s.list().map((j) => [j.toolUseId, j.background])).toEqual([
      ['fg1', false],
      ['fg2', false],
    ]);
    expect(s.hasBackgroundShell(T0 + 2_000)).toBe(false);
    s.result('fg1', { error: false, at: T0 + 30_000 });
    s.result('fg2', { taskId: 'bmanual1', error: false, at: T0 + 40_000 });
    expect(s.list().map(toShellJob)).toEqual([expect.objectContaining({ id: 'bmanual1', background: true, startedAt: T0 + 1_000 })]);
  });

  it('erro no tool_result, fim de turno e interrupção encerram sem notificação', () => {
    const s = new ShellTracker();
    s.start('main', bash('b1', T0));
    s.result('b1', { taskId: 'bx', error: true, at: T0 + 1 });
    s.start('main', bash('f1', T0, { background: false }));
    s.start('sub', bash('f2', T0, { background: false }));
    s.endForeground('main', T0 + 2);
    expect(s.list().map((j) => j.toolUseId)).toEqual(['f2']);
  });

  it('TaskStop/KillShell mata pelo id da tarefa', () => {
    const s = new ShellTracker();
    s.start('main', bash('b1', T0));
    s.result('b1', { taskId: 'bkill', error: false, at: T0 });
    expect(s.stop('bkill', T0 + 9_000)).toMatchObject({ outcome: 'killed', job: { toolUseId: 'b1' } });
    expect(s.size).toBe(0);
    // A notificação "killed" que vem depois é ignorada.
    expect(s.notify({ taskId: 'bkill', status: 'killed', at: T0 + 9_500 })).toBeUndefined();
  });

  it('descarta o que não pode estar rodando: anterior ao processo, mais de 24 h, monitor vencido', () => {
    const s = new ShellTracker();
    s.start('main', bash('velho', T0 - 60_000));
    s.start('main', bash('novo', T0 + 1_000));
    s.start('main', bash('mon', T0 + 1_000, { kind: 'monitor', timeoutMs: 60_000 }));
    expect(s.prune(T0 + 2_000, T0)).toBe(true);
    expect(s.list().map((j) => j.toolUseId)).toEqual(['mon', 'novo']);
    s.prune(T0 + 1_000 + 60_000 + 61_000);
    expect(s.list().map((j) => j.toolUseId)).toEqual(['novo']);
    s.prune(T0 + 1_000 + SHELL_MAX_AGE_MS + 1);
    expect(s.size).toBe(0);
  });

  it('aprovação pendente esconde o comando em primeiro plano e zera o relógio dele', () => {
    const s = new ShellTracker();
    s.start('main', bash('f1', T0, { background: false }));
    s.holdForeground(true, T0 + 60_000);
    expect(s.list()).toEqual([]);
    s.holdForeground(false, T0 + 61_000);
    expect(s.list()[0]).toMatchObject({ toolUseId: 'f1', startedAt: T0 + 60_000 });
  });

  it('mescla o começo do arquivo sem ressuscitar o que a janela já viu terminar', () => {
    const s = new ShellTracker();
    // Janela do fim: término de um shell cujo início ficou no começo do arquivo, e o lançamento de outro.
    s.notify({ toolUseId: 'antigo', taskId: 'bant', status: 'completed', at: T0 + 10 });
    s.result('rodando', { taskId: 'brod', error: false, at: T0 + 5 });
    const older = new ShellTracker();
    older.start('main', bash('antigo', T0));
    older.start('main', bash('rodando', T0));
    older.start('main', bash('fg', T0, { background: false }));
    expect(s.merge(older.openBackground())).toBe(true);
    expect(s.list().map(toShellJob)).toEqual([expect.objectContaining({ id: 'brod', startedAt: T0 + 5 })]);
    expect(s.notify({ taskId: 'brod', status: 'failed', at: T0 + 20 })).toMatchObject({ outcome: 'failed' });
  });
});

describe('shellsByOwner e reportShellDone (os mesmos para o Claude Code e o Codex)', () => {
  /** Escritório de mentira: agentes presentes (ativo ou já entregue) e os ShellDone recebidos. */
  function fakeOffice(present: Record<string, 'active' | 'done'>) {
    const done: Array<{ id: string; job: { id: string; label: string; startedAt: number; command?: string }; outcome: string; at: number; opts?: { live?: boolean; summary?: string } }> = [];
    return {
      done,
      has: (id: string) => id in present,
      isSubDone: (id: string) => present[id] === 'done',
      shellDone(id: string, job: { id: string; label: string; startedAt: number; command?: string }, outcome: string, at: number, opts?: { live?: boolean; summary?: string }) {
        done.push({ id, job, outcome, at, opts });
      },
    };
  }
  const job = (owner: string, toolUseId: string, extra: Partial<TrackedShell> = {}): TrackedShell => ({
    owner,
    toolUseId,
    label: 'Rodar a suíte completa',
    command: 'vendor/bin/phpunit',
    background: true,
    kind: 'shell',
    startedAt: T0,
    requestedAt: T0,
    ...extra,
  });

  it('cada shell fica no dono ativo; o de quem entregou ou saiu passa ao principal se roda em segundo plano (o em primeiro plano morreu com ele)', () => {
    const office = fakeOffice({ main: 'active', ativo: 'active', entregou: 'done' });
    const jobs = [
      job('main', 'm1'),
      job('ativo', 'a1', { background: false }),
      job('entregou', 'e1', { taskId: 'be1' }),
      job('saiu', 's1'),
      job('saiu', 's2', { background: false }),
    ];
    const by = shellsByOwner(office, 'main', jobs);
    expect([...by.keys()].sort()).toEqual(['ativo', 'main']);
    expect(by.get('main')!.map((j) => j.id)).toEqual(['m1', 'be1', 's1']);
    expect(by.get('ativo')).toEqual([toShellJob(jobs[1])]);
  });

  it('ShellDone no dono ativo, ou no principal se o dono saiu ou entregou, com "Código de saída N — comando"', () => {
    const office = fakeOffice({ main: 'active', ativo: 'active', entregou: 'done' });
    reportShellDone(office, 'main', { job: job('ativo', 'a1', { taskId: 'ba1' }), outcome: 'failed', at: T0 + 5, summary: 'Background command completed (exit code 2)' }, true);
    reportShellDone(office, 'main', { job: job('entregou', 'e1'), outcome: 'ok', at: T0 + 6, summary: 'exit code 0' }, false);
    reportShellDone(office, 'main', { job: job('saiu', 's1', { command: undefined }), outcome: 'killed', at: T0 + 7, summary: 'parado pelo usuário' }, true);
    reportShellDone(office, 'main', { job: job('main', 'm1', { command: undefined }), outcome: 'ok', at: T0 + 8 }, true);
    expect(office.done).toEqual([
      { id: 'ativo', job: { id: 'ba1', label: 'Rodar a suíte completa', startedAt: T0, command: 'vendor/bin/phpunit' }, outcome: 'failed', at: T0 + 5, opts: { live: true, summary: 'Código de saída 2 — vendor/bin/phpunit' } },
      { id: 'main', job: { id: 'e1', label: 'Rodar a suíte completa', startedAt: T0, command: 'vendor/bin/phpunit' }, outcome: 'ok', at: T0 + 6, opts: { live: false, summary: 'Código de saída 0 — vendor/bin/phpunit' } },
      { id: 'main', job: { id: 's1', label: 'Rodar a suíte completa', startedAt: T0 }, outcome: 'killed', at: T0 + 7, opts: { live: true, summary: 'parado pelo usuário' } },
      { id: 'main', job: { id: 'm1', label: 'Rodar a suíte completa', startedAt: T0 }, outcome: 'ok', at: T0 + 8, opts: { live: true } },
    ]);
  });

  it('ShellDone só de shell em segundo plano (monitor e primeiro plano ficam de fora)', () => {
    const office = fakeOffice({ main: 'active' });
    reportShellDone(office, 'main', { job: job('main', 'mon', { kind: 'monitor' }), outcome: 'ok', at: T0 }, true);
    reportShellDone(office, 'main', { job: job('main', 'fg', { background: false }), outcome: 'ok', at: T0 }, true);
    expect(office.done).toEqual([]);
  });
});
