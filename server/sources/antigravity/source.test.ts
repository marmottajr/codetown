// Fonte do Antigravity: eventos sintéticos (formato capturado num agy 1.3.3 real), AccountsService e Office.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentInfo } from '../../../shared/types';
import { describeTool } from '../../../shared/activity';
import { AccountsService } from '../../accounts/service';
import { setQuiet } from '../../log';
import { NameStore } from '../../model/names';
import { Office, OFFLINE_GRACE_MS } from '../../model/office';
import { tempDir } from '../../test/fixtures';
import type { AntigravityEvent } from './live';
import { AntigravitySource, PRESENCE_MS } from './source';

setQuiet(true);

let cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups) c();
  cleanups = [];
  vi.restoreAllMocks();
  setQuiet(true);
});

const C1 = '08a163a1-c091-4c62-8146-ac8553c45d55';
const C2 = 'f595345c-583d-497e-b55a-13271595d997';
const key = (id: string) => `antigravity:${id}`;

function setup() {
  const t = tempDir('habblaud-ag-');
  cleanups.push(t.cleanup);
  let clock = Date.now();
  const now = () => clock;
  const late: { office?: Office } = {};
  const accounts = new AccountsService({ dirs: [], home: t.dir, env: {}, now, onChange: () => late.office?.markDirty() });
  const office = new Office({
    names: new NameStore(null),
    version: 'teste',
    startedAt: clock,
    accounts: (s) => accounts.list(s),
    sources: () => [],
    accountName: (id) => accounts.find(id)?.detected.name,
    now,
  });
  late.office = office;
  const source = new AntigravitySource({ accounts, office, now, sweepMs: 1_000 });
  cleanups.unshift(() => source.stop());
  const ev = (event: AntigravityEvent['event'], extra: Partial<AntigravityEvent> = {}, id = C1): AntigravityEvent => ({
    event,
    conversationId: id,
    workspacePaths: ['/projetos/loja'],
    ...extra,
  });
  return {
    accounts,
    office,
    source,
    ev,
    advance(ms: number) {
      clock += ms;
    },
    agents(): AgentInfo[] {
      return office.commit().snapshot.agents;
    },
    agent(id = C1): AgentInfo | undefined {
      return office.commit().snapshot.agents.find((a) => a.id === key(id));
    },
    sweep() {
      (source as unknown as { sweep(): void }).sweep();
      office.tick();
    },
  };
}

describe('fonte do Antigravity', () => {
  it('AG-01: o primeiro evento cria um agente na sala do workspace, com provider, conta e sessão', () => {
    const c = setup();
    expect(c.source.applyHookEvent(c.ev('PreInvocation'))).toBe(true);
    const a = c.agent()!;
    expect(a).toMatchObject({ kind: 'main', provider: 'antigravity', sessionId: C1, status: 'working', account: 'antigravity' });
    expect(a.roomId).toContain('loja');
    expect(c.accounts.find('antigravity')?.detected.name).toBe('Antigravity');
    expect(c.source.sources()).toEqual([expect.objectContaining({ provider: 'antigravity', sessions: 1, ok: true })]);
  });

  it('sem nenhum evento não há agente nem conta', () => {
    const c = setup();
    expect(c.agents()).toHaveLength(0);
    expect(c.accounts.find('antigravity')).toBeUndefined();
    expect(c.source.sources()).toEqual([]);
  });

  it('AG-02: Pre/PostToolUse e PostInvocation mantêm working; Stop (fullyIdle) vira idle; o próximo ciclo volta a working', () => {
    const c = setup();
    c.source.applyHookEvent(c.ev('PreInvocation'));
    for (const e of ['PreToolUse', 'PostToolUse', 'PostInvocation'] as const) {
      c.source.applyHookEvent(c.ev(e, { stepIdx: 2 }));
      expect(c.agent()?.status).toBe('working');
    }
    c.source.applyHookEvent(c.ev('Stop', { fullyIdle: true }));
    expect(c.agent()?.status).toBe('idle');
    c.source.applyHookEvent(c.ev('PreInvocation'));
    expect(c.agent()?.status).toBe('working');
  });

  it('AG-02: Stop com fullyIdle=false mantém working (tarefas em segundo plano)', () => {
    const c = setup();
    c.source.applyHookEvent(c.ev('PreInvocation'));
    c.source.applyHookEvent(c.ev('Stop', { fullyIdle: false }));
    expect(c.agent()?.status).toBe('working');
  });

  it('AG-02: um Stop como primeiro evento mostra o agente ocioso', () => {
    const c = setup();
    c.source.applyHookEvent(c.ev('Stop', { fullyIdle: true }));
    expect(c.agent()?.status).toBe('idle');
  });

  it('AG-03: PreToolUse mostra a atividade da ferramenta com os rótulos do Claude Code', () => {
    const c = setup();
    c.source.applyHookEvent(c.ev('PreInvocation'));
    c.source.applyHookEvent(c.ev('PreToolUse', { stepIdx: 2, tool: { name: 'run_command', head: 'npm test' } }));
    const act = c.agent()?.activity;
    expect(act).toMatchObject({ ...describeTool('Bash', { command: 'npm test' }), tool: 'Bash', id: `${key(C1)}#2` });
  });

  it('AG-03: ferramenta desconhecida ou sem nome não derruba (sem nome só mantém working)', () => {
    const c = setup();
    c.source.applyHookEvent(c.ev('PreToolUse', { stepIdx: 1, tool: { name: 'browser_click_element' } }));
    expect(c.agent()?.activity?.tool).toBe('browser_click_element');
    expect(c.source.applyHookEvent(c.ev('PreToolUse', { stepIdx: 2, tool: { name: ' ' } }))).toBe(true);
    expect(c.agent()?.status).toBe('working');
  });

  it('AG-04: sem evento por 30 min o agente sai; com eventos no meio, fica', () => {
    const c = setup();
    c.source.applyHookEvent(c.ev('PreInvocation'));
    c.advance(PRESENCE_MS - 1_000);
    c.sweep();
    expect(c.agent()).toBeDefined();
    c.source.applyHookEvent(c.ev('Stop', { fullyIdle: true }));
    c.advance(PRESENCE_MS - 1_000);
    c.sweep();
    expect(c.agent()).toBeDefined();
    c.advance(2_000);
    c.sweep();
    c.advance(OFFLINE_GRACE_MS + 1_000);
    c.office.tick();
    expect(c.agent()).toBeUndefined();
  });

  it('AG-04: depois de sair, um novo evento traz o agente de volta', () => {
    const c = setup();
    c.source.applyHookEvent(c.ev('PreInvocation'));
    c.advance(PRESENCE_MS + 1_000);
    c.sweep();
    c.advance(OFFLINE_GRACE_MS + 1_000);
    c.office.tick();
    expect(c.agent()).toBeUndefined();
    c.source.applyHookEvent(c.ev('PreInvocation'));
    expect(c.agent()?.status).toBe('working');
  });

  it('AG-08: o mesmo evento duas vezes dá o mesmo estado', () => {
    const c = setup();
    const e = c.ev('PreToolUse', { stepIdx: 4, tool: { name: 'view_file', head: '/a/b.ts' } });
    c.source.applyHookEvent(e);
    const once = JSON.stringify(c.agent());
    c.source.applyHookEvent(e);
    expect(c.agents()).toHaveLength(1);
    expect(JSON.stringify(c.agent())).toBe(once);
  });

  it('duas conversas no mesmo workspace dividem a sala', () => {
    const c = setup();
    c.source.applyHookEvent(c.ev('PreInvocation', {}, C1));
    c.source.applyHookEvent(c.ev('PreInvocation', {}, C2));
    const [a, b] = c.agents();
    expect(c.agents()).toHaveLength(2);
    expect(a.roomId).toBe(b.roomId);
  });

  it('sem workspacePaths o evento é ignorado (sem sala não entra)', () => {
    const c = setup();
    expect(c.source.applyHookEvent(c.ev('PreInvocation', { workspacePaths: [] }))).toBe(false);
    expect(c.agents()).toHaveLength(0);
  });

  it('conversationId inválido ou evento desconhecido: false e nenhum estado', () => {
    const c = setup();
    expect(c.source.applyHookEvent(c.ev('PreInvocation', {}, 'nao-e-uuid'))).toBe(false);
    expect(c.source.applyHookEvent({ ...c.ev('PreInvocation'), event: 'Outro' as never })).toBe(false);
    expect(c.agents()).toHaveLength(0);
  });

  it('stop() para o timer e depois dele os eventos não entram', () => {
    const c = setup();
    c.source.start();
    c.source.stop();
    expect(c.source.applyHookEvent(c.ev('PreInvocation'))).toBe(false);
    expect(c.agents()).toHaveLength(0);
  });
});
