import { describe, expect, it } from 'vitest';
import { DemoSimulator } from './simulator';

describe('DemoSimulator', () => {
  it('no ?mock=1 imita as contas C e D', () => {
    const sim = new DemoSimulator({ seed: 1 }, 1_000);
    expect(sim.snapshot(1_000).accounts.map((a) => [a.id, a.short])).toEqual([
      ['.claude', 'C'],
      ['.claude-conta2', 'D'],
    ]);
  });

  it('com idPrefix usa contas próprias e ids que não colidem com dados reais', () => {
    const sim = new DemoSimulator({ seed: 1, idPrefix: 'demo:', sessions: 5 }, 1_000);
    const snap = sim.snapshot(1_000);
    expect(snap.accounts.map((a) => [a.id, a.short, a.name])).toEqual([
      ['demo:.claude', 'X', 'Demo X'],
      ['demo:.claude-conta2', 'Y', 'Demo Y'],
    ]);
    expect(snap.agents.every((a) => a.id.startsWith('demo:') && a.account.startsWith('demo:'))).toBe(true);
    expect(snap.rooms.every((r) => r.id.startsWith('demo:'))).toBe(true);
  });

  it('ids de atividades não se repetem entre instâncias (religar o demo)', () => {
    const ids = new Set<string>();
    for (const start of [1_000, 2_000]) {
      const sim = new DemoSimulator({ seed: 7, idPrefix: 'demo:', speed: 20 }, start);
      for (let t = start; t < start + 60_000; t += 250) for (const f of sim.tick(t).feed) {
        expect(ids.has(f.id)).toBe(false);
        ids.add(f.id);
      }
    }
    expect(ids.size).toBeGreaterThan(10);
  });

  it('abre com alguém esperando um shell em segundo plano (com job e balão), e o shell termina com ShellDone', () => {
    const start = 5_000;
    const sim = new DemoSimulator({ seed: 3 }, start);
    const waiting = sim.snapshot(start).agents.filter((a) => a.status === 'shell');
    expect(waiting.length).toBeGreaterThanOrEqual(1);
    const a = waiting[0];
    expect(a.shells?.length).toBeGreaterThanOrEqual(1);
    expect(a.shells!.every((j) => j.background && j.kind === 'shell' && j.startedAt < start && j.label)).toBe(true);
    expect(a.activity).toMatchObject({ tool: 'ShellWait' });
    const done: string[] = [];
    for (let t = start; t < start + 200_000; t += 250) {
      for (const f of sim.tick(t).feed) if (f.activity.tool === 'ShellDone') done.push(f.agentId);
    }
    expect(done).toContain(a.id);
  });

  it('com o tempo: shells em segundo plano (status shell), comandos longos em primeiro plano e falhas', () => {
    for (const seed of [1, 2, 3]) {
      const sim = new DemoSimulator({ seed, speed: 10, sessions: 5 }, 0);
      const seen = { shell: 0, foreground: 0, ok: 0, failed: 0, noticeWait: 0 };
      for (let t = 0; t < 3_600_000 / 10; t += 250) {
        const r = sim.tick(t);
        for (const f of r.feed) {
          if (f.activity.tool !== 'ShellDone') continue;
          if (f.activity.error) seen.failed++;
          else seen.ok++;
        }
        seen.noticeWait += r.notices.filter((n) => n.text.includes('está esperando o shell')).length;
        if (!r.changed) continue;
        for (const a of sim.snapshot(t).agents) {
          if (a.status === 'shell') {
            seen.shell++;
            expect(a.shells?.some((j) => j.background)).toBe(true);
          }
          if (a.status === 'working' && a.shells?.some((j) => !j.background)) seen.foreground++;
          if (a.status === 'idle') expect(a.shells).toBeUndefined();
        }
      }
      expect(seen.shell).toBeGreaterThan(0);
      expect(seen.foreground).toBeGreaterThan(0);
      expect(seen.ok).toBeGreaterThan(0);
      expect(seen.noticeWait).toBeGreaterThan(0);
      if (seed === 1) expect(seen.ok + seen.failed).toBeGreaterThan(3);
    }
  });
});
