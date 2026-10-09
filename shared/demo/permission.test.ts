// Pedidos de permissão fictícios do demo: aparecem na espera, respondem pelo escritório (aprovar, recusar,
// responder a pergunta, devolver ao terminal) e somem quando a espera acaba sozinha.
import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../hash';
import { DEMO_CODEX_PERMISSION_MS, demoCodexPermission, demoPermission } from './permission';
import { DemoSimulator } from './simulator';

describe('demoPermission', () => {
  it('monta pedidos completos (título, resumo, argumentos) com prazo', () => {
    const kinds = new Set<string>();
    for (let seed = 1; seed < 60; seed++) {
      const p = demoPermission(`p${seed}`, { files: ['src/app.ts'], commands: ['npm test'] }, mulberry32(seed), 1_000);
      kinds.add(p.tool);
      expect(p).toMatchObject({ id: `p${seed}`, createdAt: 1_000 });
      expect(p.expiresAt).toBeGreaterThan(1_000);
      expect(p.title).toMatch(/^(Bash|Edit|WebFetch|AskUserQuestion)\(/);
      expect(p.input).toBeTruthy();
      expect(p.text).toBeTruthy();
      if (p.tool === 'Bash') expect(p.suggestions).toEqual([{ index: 0, rules: ['Bash(npm test:*)'], destination: 'localSettings' }]);
    }
    expect(kinds).toEqual(new Set(['Bash', 'Edit', 'WebFetch', 'AskUserQuestion']));
  });

  it('pergunta (AskUserQuestion): uma de escolha única e uma de várias, com as posições para responder', () => {
    const p = demoPermission('q', { files: [], commands: [] }, mulberry32(3), 1_000, 'question');
    expect(p).toMatchObject({ tool: 'AskUserQuestion', icon: '❓', inputKind: 'text' });
    expect(p.suggestions).toBeUndefined();
    const qs = p.questions!;
    expect(qs).toHaveLength(2);
    expect(qs.map((q) => q.index)).toEqual([0, 1]);
    expect(qs[0]!.multiSelect).toBeUndefined();
    expect(qs[1]!.multiSelect).toBe(true);
    for (const q of qs) {
      expect(q.header).toBeTruthy();
      expect(q.options.map((o) => o.index)).toEqual(q.options.map((_, i) => i));
      expect(p.input).toContain(q.question);
    }
  });
});

describe('DemoSimulator: pedidos de permissão', () => {
  const start = 10_000;

  it('forcePermission: o agente espera com o pedido; aprovar retoma o trabalho e registra a atividade', () => {
    const sim = new DemoSimulator({ seed: 4, idPrefix: 'demo:' }, start);
    const id = sim.forcePermission(start, 'permission')!;
    let a = sim.snapshot(start).agents.find((x) => x.id === id)!;
    expect(a).toMatchObject({ status: 'waiting', waitingFor: 'aprovar uma permissão' });
    const p = a.permission!;
    expect(p.id.startsWith('demo:perm-')).toBe(true);
    expect(sim.decidePermission('outro', { behavior: 'allow' }, start + 1)).toBe(false);
    expect(sim.decidePermission(p.id, { behavior: 'allow', suggestion: 0 }, start + 1)).toBe(true);
    a = sim.snapshot(start + 1).agents.find((x) => x.id === id)!;
    expect(a.status).toBe('working');
    expect(a.permission).toBeUndefined();
    expect(a.recent.map((r) => r.text)).toContain('Aprovado no Habblaud (sempre permitir)');
    expect(sim.decidePermission(p.id, { behavior: 'allow' }, start + 2)).toBe(false);
  });

  it('recusar retoma com a atividade de recusa; terminal só tira o pedido (a espera continua um pouco)', () => {
    const sim = new DemoSimulator({ seed: 5 }, start);
    const a1 = sim.forcePermission(start, 'permission')!;
    const p1 = sim.snapshot(start).agents.find((x) => x.id === a1)!.permission!;
    sim.decidePermission(p1.id, { behavior: 'deny', message: 'agora não' }, start + 1);
    const after = sim.snapshot(start + 1).agents.find((x) => x.id === a1)!;
    expect(after.status).toBe('working');
    expect(after.recent.at(-1)).toMatchObject({ icon: '🚫', text: 'Recusado no Habblaud' });

    const sim2 = new DemoSimulator({ seed: 6 }, start);
    const a2 = sim2.forcePermission(start, 'permission')!;
    const p2 = sim2.snapshot(start).agents.find((x) => x.id === a2)!.permission!;
    expect(sim2.decidePermission(p2.id, { behavior: 'terminal' }, start + 1)).toBe(true);
    const still = sim2.snapshot(start + 1).agents.find((x) => x.id === a2)!;
    expect(still.status).toBe('waiting');
    expect(still.permission).toBeUndefined();
    let t = start + 1;
    while (t < start + 20_000 && sim2.snapshot(t).agents.find((x) => x.id === a2)?.status === 'waiting') sim2.tick((t += 250));
    expect(sim2.snapshot(t).agents.find((x) => x.id === a2)?.status).toBe('working');
  });

  it('pergunta: responder (answer) retoma com o resumo das escolhas; aprovar ou respostas incompletas não valem', () => {
    const sim = new DemoSimulator({ seed: 7, idPrefix: 'demo:' }, start);
    const id = sim.forcePermission(start, 'question')!;
    const a = sim.snapshot(start).agents.find((x) => x.id === id)!;
    expect(a).toMatchObject({ status: 'waiting', waitingFor: 'responder uma pergunta' });
    const p = a.permission!;
    expect(p.tool).toBe('AskUserQuestion');
    const [single, multi] = p.questions!;
    expect(sim.decidePermission(p.id, { behavior: 'allow' }, start + 1)).toBe(false);
    // Falta a segunda pergunta; escolha única com duas opções.
    expect(sim.decidePermission(p.id, { behavior: 'answer', answers: [{ question: single!.index, options: [0] }] }, start + 1)).toBe(false);
    expect(
      sim.decidePermission(p.id, { behavior: 'answer', answers: [{ question: single!.index, options: [0, 1] }, { question: multi!.index, options: [0] }] }, start + 1),
    ).toBe(false);
    expect(
      sim.decidePermission(p.id, { behavior: 'answer', answers: [{ question: single!.index, options: [1] }, { question: multi!.index, options: [2, 0], other: 'lint também' }] }, start + 1),
    ).toBe(true);
    const after = sim.snapshot(start + 1).agents.find((x) => x.id === id)!;
    expect(after.status).toBe('working');
    expect(after.permission).toBeUndefined();
    const act = after.recent.at(-1)!;
    expect(act).toMatchObject({ icon: '💬', text: 'Respondido no Habblaud' });
    expect(act.detail).toBe(`${single!.header}: ${single!.options[1]!.label} · ${multi!.header}: ${multi!.options[0]!.label}, ${multi!.options[2]!.label}, “lint também”`);
  });

  it('pergunta: recusar e "responder no terminal" também valem', () => {
    const sim = new DemoSimulator({ seed: 8 }, start);
    const id = sim.forcePermission(start, 'question')!;
    const p = sim.snapshot(start).agents.find((x) => x.id === id)!.permission!;
    expect(sim.decidePermission(p.id, { behavior: 'deny', message: 'decida você' }, start + 1)).toBe(true);
    expect(sim.snapshot(start + 1).agents.find((x) => x.id === id)!.recent.at(-1)).toMatchObject({ icon: '🚫', text: 'Recusado no Habblaud' });
  });

  it('com o tempo, as esperas por permissão trazem pedido e ele some quando a espera acaba', () => {
    const sim = new DemoSimulator({ seed: 2, speed: 10, sessions: 5 }, 0);
    let withPermission = 0;
    for (let t = 0; t < 600_000; t += 250) {
      sim.tick(t);
      for (const a of sim.snapshot(t).agents) {
        if (a.permission) {
          withPermission++;
          expect(a.status).toBe('waiting');
        }
        if (a.status !== 'waiting') expect(a.permission).toBeUndefined();
      }
    }
    expect(withPermission).toBeGreaterThan(0);
  });
});

describe('pedidos do Codex (demo)', () => {
  const start = 10_000;

  it('demoCodexPermission: comando, apply_patch ou rede; sem sugestões nem perguntas; prazo de segundos', () => {
    const tools = new Set<string>();
    for (let seed = 1; seed < 80; seed++) {
      const p = demoCodexPermission(`c${seed}`, { files: ['src/app.ts'], commands: ['npm test'] }, mulberry32(seed), 1_000);
      tools.add(p.text.startsWith('Acesso à rede') ? 'rede' : p.tool);
      expect(p).toMatchObject({ provider: 'codex', createdAt: 1_000, expiresAt: 1_000 + DEMO_CODEX_PERMISSION_MS });
      expect(p.suggestions).toBeUndefined();
      expect(p.questions).toBeUndefined();
      expect(p.input).toBeTruthy();
      if (p.tool === 'apply_patch') expect(p.input).toMatch(/^\*\*\* Begin Patch\n\*\*\* Update File: src\/app\.ts\n/);
    }
    expect(tools).toEqual(new Set(['Bash', 'apply_patch', 'rede']));
  });

  it('forcePermission no Codex: espera "aprovar um comando"; recusa só com motivo; sem sempre permitir nem interromper', () => {
    const sim = new DemoSimulator({ seed: 4, idPrefix: 'demo:' }, start);
    const id = sim.forcePermission(start, 'question', 'codex')!;
    const a = sim.snapshot(start).agents.find((x) => x.id === id)!;
    expect(a).toMatchObject({ provider: 'codex', status: 'waiting', waitingFor: 'aprovar um comando' });
    const p = a.permission!;
    expect(p.provider).toBe('codex');
    expect(p.tool).not.toBe('AskUserQuestion');
    expect(sim.decidePermission(p.id, { behavior: 'deny' }, start + 1)).toBe(false);
    expect(sim.decidePermission(p.id, { behavior: 'deny', message: '   ' }, start + 1)).toBe(false);
    expect(sim.decidePermission(p.id, { behavior: 'allow', suggestion: 0 }, start + 1)).toBe(false);
    expect(sim.decidePermission(p.id, { behavior: 'deny', message: 'não', interrupt: true }, start + 1)).toBe(false);
    expect(sim.decidePermission(p.id, { behavior: 'answer', answers: [] }, start + 1)).toBe(false);
    expect(sim.decidePermission(p.id, { behavior: 'deny', message: 'use pnpm' }, start + 1)).toBe(true);
    expect(sim.snapshot(start + 1).agents.find((x) => x.id === id)!.recent.at(-1)).toMatchObject({ text: 'Recusado no Habblaud' });
  });

  it('o prazo do Codex acaba: o pedido sai do escritório e o agente segue esperando no terminal', () => {
    const sim = new DemoSimulator({ seed: 5 }, start);
    const id = sim.forcePermission(start, 'permission', 'codex')!;
    sim.tick(start + DEMO_CODEX_PERMISSION_MS - 1_000);
    expect(sim.snapshot(start + DEMO_CODEX_PERMISSION_MS - 1_000).agents.find((x) => x.id === id)!.permission).toBeDefined();
    sim.tick(start + DEMO_CODEX_PERMISSION_MS);
    const after = sim.snapshot(start + DEMO_CODEX_PERMISSION_MS).agents.find((x) => x.id === id)!;
    expect(after.permission).toBeUndefined();
    expect(after.status).toBe('waiting');
  });

  it('forcePermission sem ferramenta continua escolhendo um agente do Claude Code', () => {
    for (const seed of [4, 5, 6, 7, 8]) {
      const sim = new DemoSimulator({ seed }, start);
      const id = sim.forcePermission(start)!;
      expect(sim.snapshot(start).agents.find((x) => x.id === id)!.provider).toBeUndefined();
    }
  });
});

describe('pedidos do Codex no canal paralelo (demo)', () => {
  const start = 10_000;
  const src = { files: ['src/app.ts'], commands: ['npm test'] };
  const agentOf = (sim: DemoSimulator, id: string, t = start) => sim.snapshot(t).agents.find((x) => x.id === id)!;

  it('demoCodexPermission parallel: os mesmos sorteios e o mesmo pedido, com as decisões do canal e sem prazo', () => {
    const tools = new Set<string>();
    for (let seed = 1; seed < 80; seed++) {
      const hookRng = mulberry32(seed);
      const parRng = mulberry32(seed);
      const hook = demoCodexPermission(`c${seed}`, src, hookRng, 1_000);
      const par = demoCodexPermission(`c${seed}`, src, parRng, 1_000, 'parallel');
      // Mesmo número de sorteios: o resto do agente segue igual nos dois modos.
      expect(parRng()).toBe(hookRng());
      expect(hook.mode).toBeUndefined();
      expect(hook.decisions).toBeUndefined();
      expect(par).toMatchObject({ id: `c${seed}`, provider: 'codex', mode: 'parallel', createdAt: 1_000, expiresAt: Number.MAX_SAFE_INTEGER, title: hook.title, input: hook.input });
      expect(par.suggestions).toBeUndefined();
      expect(par.questions).toBeUndefined();
      tools.add(par.tool);
      if (par.tool === 'apply_patch') {
        expect(par.decisions).toEqual(['accept', 'acceptForSession', 'decline', 'cancel']);
      } else {
        // Comando (o acesso à rede também chega como o comando pelo app-server): a emenda de execpolicy, que o
        // Habblaud não oferece, fica no lugar do "nesta sessão".
        expect(par.tool).toBe('exec_command');
        expect(par.title).toMatch(/^Bash\(/);
        expect(par.inputKind).toBe('command');
        expect(par.decisions).toEqual(['accept', 'decline', 'cancel']);
      }
    }
    expect(tools).toEqual(new Set(['exec_command', 'apply_patch']));
  });

  it('forcePermission parallel: Aprovar nesta sessão só quando o canal oferece, Recusar sem motivo; nada de responder, sempre permitir nem interromper', () => {
    const tools = new Set<string>();
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
      const sim = new DemoSimulator({ seed, idPrefix: 'demo:' }, start);
      const id = sim.forcePermission(start, 'permission', 'codex', 'parallel')!;
      const a = agentOf(sim, id);
      expect(a).toMatchObject({ provider: 'codex', status: 'waiting', waitingFor: 'aprovar um comando' });
      const p = a.permission!;
      expect(p).toMatchObject({ provider: 'codex', mode: 'parallel', expiresAt: Number.MAX_SAFE_INTEGER });
      tools.add(p.tool);
      expect(sim.decidePermission(p.id, { behavior: 'answer', answers: [] }, start + 1)).toBe(false);
      expect(sim.decidePermission(p.id, { behavior: 'allow', suggestion: 0 }, start + 1)).toBe(false);
      expect(sim.decidePermission(p.id, { behavior: 'deny', interrupt: true }, start + 1)).toBe(false);
      if (p.decisions!.includes('acceptForSession')) {
        expect(sim.decidePermission(p.id, { behavior: 'allow', forSession: true }, start + 1)).toBe(true);
        expect(agentOf(sim, id, start + 1).recent.at(-1)).toMatchObject({ icon: '✅', text: 'Aprovado no Habblaud (nesta sessão)', detail: p.title });
      } else {
        expect(sim.decidePermission(p.id, { behavior: 'allow', forSession: true }, start + 1)).toBe(false);
        // O cartão recusa direto: o app-server não leva motivo.
        expect(sim.decidePermission(p.id, { behavior: 'deny' }, start + 1)).toBe(true);
        expect(agentOf(sim, id, start + 1).recent.at(-1)).toMatchObject({ icon: '🚫', text: 'Recusado no Habblaud', detail: p.title });
      }
      const after = agentOf(sim, id, start + 1);
      expect(after.status).toBe('working');
      expect(after.permission).toBeUndefined();
      expect(sim.decidePermission(p.id, { behavior: 'allow' }, start + 2)).toBe(false);
    }
    expect(tools).toEqual(new Set(['exec_command', 'apply_patch']));
  });

  it('parallel sem prazo: o cartão fica enquanto o agente espera (além dos 25 s do hook) e fecha quando o terminal responde primeiro', () => {
    const sim = new DemoSimulator({ seed: 5 }, start);
    const id = sim.forcePermission(start, 'permission', 'codex', 'parallel')!;
    let t = start;
    for (; t < start + 120_000; t += 250) {
      sim.tick(t);
      const a = agentOf(sim, id, t);
      if (a.status !== 'waiting') break;
      expect(a.permission?.mode).toBe('parallel');
    }
    expect(t - start).toBeGreaterThanOrEqual(DEMO_CODEX_PERMISSION_MS);
    const after = agentOf(sim, id, t);
    expect(after.status).toBe('working');
    expect(after.permission).toBeUndefined();
  });

  it('parallel: Aprovar simples e "Responder no terminal" (só fecha o cartão; o agente segue esperando o terminal)', () => {
    const sim = new DemoSimulator({ seed: 6 }, start);
    const id = sim.forcePermission(start, 'permission', 'codex', 'parallel')!;
    const p = agentOf(sim, id).permission!;
    expect(p.mode).toBe('parallel');
    expect(sim.decidePermission(p.id, { behavior: 'allow' }, start + 1)).toBe(true);
    expect(agentOf(sim, id, start + 1).recent.at(-1)).toMatchObject({ icon: '✅', text: 'Aprovado no Habblaud', detail: p.title });

    const sim2 = new DemoSimulator({ seed: 7 }, start);
    const id2 = sim2.forcePermission(start, 'permission', 'codex', 'parallel')!;
    const p2 = agentOf(sim2, id2).permission!;
    expect(sim2.decidePermission(p2.id, { behavior: 'terminal' }, start + 1)).toBe(true);
    const still = agentOf(sim2, id2, start + 1);
    expect(still.status).toBe('waiting');
    expect(still.permission).toBeUndefined();
  });

  it('"nesta sessão" só vale no canal paralelo (nem no hook do Codex, nem no Claude Code)', () => {
    const sim = new DemoSimulator({ seed: 4 }, start);
    const codex = sim.forcePermission(start, 'permission', 'codex')!;
    const pc = agentOf(sim, codex).permission!;
    expect(pc.mode).toBeUndefined();
    expect(sim.decidePermission(pc.id, { behavior: 'allow', forSession: true }, start + 1)).toBe(false);
    const claude = sim.forcePermission(start, 'permission')!;
    const pl = agentOf(sim, claude).permission!;
    expect(sim.decidePermission(pl.id, { behavior: 'allow', forSession: true }, start + 1)).toBe(false);
    expect(sim.decidePermission(pl.id, { behavior: 'allow' }, start + 1)).toBe(true);
  });

  it('com o tempo: a sessão do Codex da abertura usa o canal paralelo (TUI com daemon); cada sessão fica num canal só', () => {
    const sim = new DemoSimulator({ seed: 2, speed: 10, sessions: 5 }, 0);
    const host = sim.snapshot(0).agents.find((a) => a.provider === 'codex' && a.kind === 'main')!.id;
    const modes = new Map<string, Set<string>>();
    for (let t = 0; t < 1_800_000; t += 250) {
      sim.tick(t);
      for (const a of sim.snapshot(t).agents) {
        if (a.provider !== 'codex' || !a.permission) continue;
        const mode = a.permission.mode ?? 'hook';
        if (mode === 'parallel') expect(a.permission.decisions?.length).toBeGreaterThan(0);
        else expect(a.permission.decisions).toBeUndefined();
        modes.set(a.id, (modes.get(a.id) ?? new Set()).add(mode));
      }
    }
    expect(modes.get(host)).toEqual(new Set(['parallel']));
    for (const m of modes.values()) expect(m.size).toBe(1);
    expect(new Set([...modes.values()].flatMap((m) => [...m]))).toEqual(new Set(['parallel', 'hook']));
  });
});
