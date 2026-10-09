// Instalador dos hooks do Codex (scripts/codex-install.ts): planos puros e o comando de verdade sobre hooks.json em
// pastas temporárias (HOME e CODEX_HOME FALSOS: nunca toca em ~/.codex). O ponto principal: os grupos de outros apps
// (ex.: o Orca) nunca mudam de posição nem de conteúdo — a confiança do Codex é guardada pela posição do grupo.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  chooseNode,
  createNodeProbe,
  DEFAULT_WAIT_S,
  discoverCodexHomes,
  EVENTS,
  findOnPath,
  handlerFor,
  HOOK_SCRIPT,
  hookCommand,
  installState,
  isOurHandler,
  nodeMajor,
  parseArgs,
  planInstall,
  planUninstall,
  run,
  scriptPathOf,
  STATUS_MESSAGE,
  windowsHookCommand,
  type RunContext,
  type RunOptions,
} from '../../scripts/codex-install';
import { posixShell, tempDir } from './fixtures';

const CMD = hookCommand('/repo/habblaud/mod/habblaud-codex/hook.mjs');
const SH = posixShell();
const slash = (p: string) => p.split('\\').join('/');
/** Caminhos sintéticos do Windows (os testes rodam iguais no Windows e no Linux: nada aqui toca o disco). */
const WIN_REPO_HOOK = 'D:\\repo\\habblaud\\mod\\habblaud-codex\\hook.mjs';
const NODE_WIN = 'C:\\Program Files\\nodejs\\node.exe';
/** Versões falsas do Node: `PATH` = o `node` que o shell do Codex acharia; as outras chaves, caminhos de candidatos. */
const versions =
  (v: Record<string, string>) =>
  (bin: string | undefined): string | undefined =>
    v[bin ?? 'PATH'];

/** hooks.json (sintético) com grupos de outro app em alguns eventos, inclusive um que o Habblaud não usa. */
const ORCA = {
  description: 'Hooks de outro app',
  hooks: {
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'orca-hook pre', timeout: 10 }] }],
    PermissionRequest: [{ hooks: [{ type: 'command', command: 'orca-hook perm' }] }, { matcher: 'apply_patch', hooks: [{ type: 'command', command: 'orca-hook patch' }] }],
    Stop: [{ hooks: [{ type: 'command', command: 'orca-hook stop', async: true }] }],
    PreCompact: [{ hooks: [{ type: 'command', command: 'orca-hook compact' }] }],
  },
};
const orcaAt = (file: { hooks?: Record<string, unknown[]> }, event: string, i: number) => file.hooks?.[event]?.[i];

describe('codex-install.ts (funções puras)', () => {
  it('comando sem opções e handlers fixos: observação em segundo plano, SessionEnd síncrono, PermissionRequest com a espera', () => {
    expect(CMD).toBe('node "/repo/habblaud/mod/habblaud-codex/hook.mjs"');
    expect(handlerFor('PreToolUse', CMD, 25)).toEqual({ type: 'command', command: CMD, async: true, timeout: 5 });
    expect(handlerFor('SessionEnd', CMD, 25)).toEqual({ type: 'command', command: CMD, timeout: 1 });
    expect(handlerFor('PermissionRequest', CMD, 25)).toEqual({ type: 'command', command: CMD, timeout: 35, statusMessage: STATUS_MESSAGE });
    expect(STATUS_MESSAGE).toBe('Aguardando resposta no Habblaud…');
    expect(isOurHandler({ command: CMD })).toBe(true);
    expect(isOurHandler({ command: 'node "C:\\x\\habblaud-codex\\hook.mjs"' })).toBe(true);
    expect(isOurHandler({ command: 'orca-hook perm' })).toBe(false);
    expect(scriptPathOf(CMD)).toBe('/repo/habblaud/mod/habblaud-codex/hook.mjs');
    expect(scriptPathOf("node '/a/it'\\''s/habblaud-codex/hook.mjs'")).toBe("/a/it's/habblaud-codex/hook.mjs");
  });

  it('install: acrescenta no FIM de cada evento, sem matcher; grupos alheios e o resto do arquivo intactos; idempotente', () => {
    const p = planInstall(ORCA, CMD, 25);
    expect(p.action).toBe('install');
    if (p.action !== 'install') return;
    const next = p.file as typeof ORCA & { hooks: Record<string, unknown[]> };
    expect(next.description).toBe(ORCA.description);
    expect(Object.keys(next).sort()).toEqual(['description', 'hooks']);
    for (const [event, list] of Object.entries(ORCA.hooks)) list.forEach((g, i) => expect(orcaAt(next, event, i), `${event}[${i}]`).toEqual(g));
    expect(next.hooks.PreCompact).toEqual(ORCA.hooks.PreCompact);
    for (const event of EVENTS) {
      const list = next.hooks[event];
      expect(list.at(-1), event).toEqual({ hooks: [handlerFor(event, CMD, 25)] });
      expect(list.length, event).toBe(((ORCA.hooks as Record<string, unknown[]>)[event]?.length ?? 0) + 1);
    }
    expect(p.approve.sort()).toEqual([...EVENTS].sort());
    expect(planInstall(next, CMD, 25)).toEqual({ action: 'none', message: 'já instalado' });
    expect(installState(next, CMD, 25)).toEqual({ ok: [...EVENTS], outdated: [], missing: [], paths: ['/repo/habblaud/mod/habblaud-codex/hook.mjs'] });
  });

  it('atualizar (outra espera, outro caminho): troca o handler NO MESMO lugar, mesmo com um grupo alheio acrescentado depois', () => {
    const first = planInstall(ORCA, CMD, 25);
    if (first.action !== 'install') throw new Error('esperado install');
    const installed = first.file as { hooks: Record<string, unknown[]> };
    // Outro app acrescenta um grupo DEPOIS do do Habblaud.
    const later = { hooks: [{ type: 'command', command: 'orca-hook depois' }] };
    installed.hooks.PermissionRequest = [...installed.hooks.PermissionRequest, later];
    const before = JSON.parse(JSON.stringify(installed));
    const upd = planInstall(installed, hookCommand('/novo/lugar/mod/habblaud-codex/hook.mjs'), 60);
    expect(upd.action).toBe('install');
    if (upd.action !== 'install') return;
    const next = upd.file as { hooks: Record<string, unknown[]> };
    expect(upd.approve.sort()).toEqual([...EVENTS].sort());
    for (const event of EVENTS) {
      expect(next.hooks[event].length, event).toBe(before.hooks[event].length);
      before.hooks[event].forEach((g: { hooks: unknown[] }, i: number) => {
        if (!isOurHandler(g.hooks[0])) expect(next.hooks[event][i], `${event}[${i}]`).toEqual(g);
      });
    }
    expect(next.hooks.PermissionRequest[2]).toEqual({ hooks: [handlerFor('PermissionRequest', hookCommand('/novo/lugar/mod/habblaud-codex/hook.mjs'), 60)] });
    expect(next.hooks.PermissionRequest[3]).toEqual(later);
    expect(installState(installed, CMD, 60)).toMatchObject({ outdated: ['PermissionRequest'], missing: [] });
  });

  it('uninstall: tira só os handlers do Habblaud; de volta ao original; avisa quando um grupo alheio muda de posição', () => {
    const p = planInstall(ORCA, CMD, 25);
    if (p.action !== 'install') throw new Error('esperado install');
    expect(planUninstall(p.file)).toEqual({ action: 'uninstall', file: ORCA, message: 'hooks do Habblaud removidos', shifted: [] });
    const withLater = JSON.parse(JSON.stringify(p.file));
    withLater.hooks.Stop.push({ hooks: [{ type: 'command', command: 'orca-hook depois' }] });
    const u = planUninstall(withLater);
    expect(u.action === 'uninstall' && u.shifted).toEqual(['Stop']);
    expect(planUninstall(ORCA)).toEqual({ action: 'none', message: 'não estava instalado' });
    // Arquivo que só tinha o Habblaud: volta a {}.
    const only = planInstall({}, CMD, 25);
    expect(only.action === 'install' && planUninstall(only.file)).toMatchObject({ action: 'uninstall', file: {} });
  });

  it('cópias repetidas saem; formatos desconhecidos não são tocados', () => {
    const dup = { hooks: { Stop: [{ hooks: [handlerFor('Stop', CMD, 25)] }, { hooks: [{ type: 'command', command: 'x' }, handlerFor('Stop', CMD, 25)] }] } };
    const p = planInstall(dup, CMD, 25);
    expect(p.action === 'install' && (p.file.hooks as Record<string, unknown[]>).Stop).toEqual([{ hooks: [handlerFor('Stop', CMD, 25)] }, { hooks: [{ type: 'command', command: 'x' }] }]);
    expect(planInstall({ hooks: [] }, CMD, 25).action).toBe('skip');
    expect(planInstall({ hooks: { Stop: {} } }, CMD, 25).action).toBe('skip');
    expect(planUninstall({ hooks: 'x' }).action).toBe('skip');
  });

  it('parseArgs', () => {
    expect(parseArgs(['install'], {})).toEqual({ command: 'install', dryRun: false, account: undefined, port: 4747, waitS: DEFAULT_WAIT_S });
    expect(parseArgs(['status', '--port', '4851', '--espera', '60', '--conta', '.codex', '--dry-run'], {})).toEqual({ command: 'status', dryRun: true, account: '.codex', port: 4851, waitS: 60 });
    expect(parseArgs(['install'], { HABBLAUD_PORT: '4848' })).toMatchObject({ port: 4848 });
    expect(parseArgs(['--help'], {})).toBe('help');
    expect(() => parseArgs([], {})).toThrow(/install, uninstall ou status/);
    expect(() => parseArgs(['install', '--espera', '4'], {})).toThrow(/--espera/);
    expect(() => parseArgs(['install', '--espera', '121'], {})).toThrow(/--espera/);
    expect(() => parseArgs(['install', '--conta'], {})).toThrow(/--conta/);
    expect(parseArgs(['install', '--node', '/opt/homebrew/bin/node'], {})).toMatchObject({ node: '/opt/homebrew/bin/node' });
    expect(() => parseArgs(['install', '--node', 'node'], {})).toThrow(/--node/);
  });

  it('Node dos hooks: o do shell de login se for 22+; senão o primeiro candidato 22+ com caminho absoluto', () => {
    expect(nodeMajor('v18.12.1')).toBe(18);
    expect(nodeMajor('v24.17.0\n')).toBe(24);
    expect(nodeMajor(undefined)).toBeUndefined();
    const versions: Record<string, string> = { login: 'v18.12.1', '/opt/homebrew/bin/node': 'v25.8.2', '/usr/local/bin/node': 'v18.12.1' };
    const probe = (bin: string | undefined) => versions[bin ?? 'login'];
    expect(chooseNode(probe, ['/usr/local/bin/node', '/opt/homebrew/bin/node'])).toEqual({ bin: '/opt/homebrew/bin/node', login: 'v18.12.1', chosen: 'v25.8.2' });
    versions.login = 'v22.12.0';
    expect(chooseNode(probe, ['/opt/homebrew/bin/node'])).toEqual({ login: 'v22.12.0' });
    // Nenhum 22+: `node` mesmo (o instalador avisa).
    expect(chooseNode(() => undefined, ['/x/node'])).toEqual({ login: undefined });
    expect(hookCommand('/repo/mod/habblaud-codex/hook.mjs', '/opt/homebrew/bin/node')).toBe('"/opt/homebrew/bin/node" "/repo/mod/habblaud-codex/hook.mjs"');
    expect(scriptPathOf('"/opt/homebrew/bin/node" "/repo/mod/habblaud-codex/hook.mjs"')).toBe('/repo/mod/habblaud-codex/hook.mjs');
  });

  it('Windows: node "<hook com />" roda no PowerShell, no cmd e no sh; com outro Node, a forma do PowerShell (& "<node>" "<hook>")', () => {
    const short = windowsHookCommand(WIN_REPO_HOOK);
    expect(short).toBe('node "D:/repo/habblaud/mod/habblaud-codex/hook.mjs"');
    const amp = windowsHookCommand(WIN_REPO_HOOK, NODE_WIN);
    expect(amp).toBe('& "C:/Program Files/nodejs/node.exe" "D:/repo/habblaud/mod/habblaud-codex/hook.mjs"');
    for (const c of [short, amp]) {
      expect(isOurHandler({ command: c })).toBe(true);
      expect(scriptPathOf(c)).toBe('D:/repo/habblaud/mod/habblaud-codex/hook.mjs');
    }
  });

  it('Windows: o `node` do PATH é o que o PowerShell e o cmd rodariam (1ª pasta que tiver, ordem do PATHEXT, Path/PATH)', () => {
    const files = new Set(['relativo\\node.exe', 'C:\\Program Files\\nodejs\\node.cmd', NODE_WIN, 'C:\\shims\\node.cmd', 'C:\\velho\\node.exe']);
    const isFile = (p: string) => files.has(p);
    // Pasta relativa e vazia não contam; aspas em volta da pasta saem; na mesma pasta, .EXE vem antes de .CMD.
    expect(findOnPath('node', { Path: 'relativo;;"C:\\Program Files\\nodejs";C:\\velho', PATHEXT: '.COM;.EXE;.BAT;.CMD' }, isFile)).toBe(NODE_WIN);
    // A 1ª pasta decide, mesmo que seja um script (.cmd): é ele que o `node "<hook>"` rodaria. Sem PATHEXT: o padrão.
    expect(findOnPath('node', { PATH: 'C:\\shims;C:\\velho' }, isFile)).toBe('C:\\shims\\node.cmd');
    expect(findOnPath('node', { PATH: 'C:\\velho', PATHEXT: '.CMD' }, isFile)).toBeUndefined();
    expect(findOnPath('node', {}, isFile)).toBeUndefined();
  });

  it('versão do Node sem shell: no Windows, o do PATH (o $SHELL do Git Bash não conta); no macOS/Linux, o do shell de login', () => {
    const files = new Set(['C:\\velho\\node.exe', NODE_WIN, 'C:\\shims\\node.cmd']);
    const isFile = (p: string) => files.has(p);
    const out: Record<string, string> = { 'C:\\velho\\node.exe': 'v18.12.1\r\n', [NODE_WIN]: 'v24.16.0\r\n', '/bin/zsh': 'v22.12.0\n', '/bin/sh': 'v18.0.0\n' };
    const calls: string[][] = [];
    const exec = (bin: string, args: string[]): string => {
      calls.push([bin, ...args]);
      const v = out[bin];
      // O execFileSync sem shell não roda .cmd (EINVAL).
      if (!v) throw new Error('spawnSync EINVAL');
      return v;
    };
    // Rodado pelo PowerShell (sem $SHELL) ou pelo Git Bash (com): a mesma resposta.
    for (const env of [{ PATH: `C:\\velho;C:\\Program Files\\nodejs` }, { PATH: `C:\\velho;C:\\Program Files\\nodejs`, SHELL: '/usr/bin/bash' }]) {
      calls.length = 0;
      const probe = createNodeProbe({ platform: 'win32', env, exec, isFile });
      expect(probe(undefined)).toBe('v18.12.1');
      expect(probe(NODE_WIN)).toBe('v24.16.0');
      expect(calls).toEqual([
        ['C:\\velho\\node.exe', '--version'],
        [NODE_WIN, '--version'],
      ]);
    }
    // node.cmd na frente do PATH: sem shell não dá para conferir a versão (o chooseNode cai noutro Node 22+).
    expect(createNodeProbe({ platform: 'win32', env: { PATH: 'C:\\shims;C:\\Program Files\\nodejs' }, exec, isFile })(undefined)).toBeUndefined();
    expect(createNodeProbe({ platform: 'win32', env: { PATH: 'C:\\nada' }, exec, isFile })(undefined)).toBeUndefined();
    calls.length = 0;
    expect(createNodeProbe({ platform: 'darwin', env: { SHELL: '/bin/zsh' }, exec, isFile })(undefined)).toBe('v22.12.0');
    expect(createNodeProbe({ platform: 'linux', env: {}, exec, isFile })(undefined)).toBe('v18.0.0');
    expect(calls).toEqual([
      ['/bin/zsh', '-lc', 'node --version'],
      ['/bin/sh', '-lc', 'node --version'],
    ]);
  });

  it('cópias repetidas: só sai a que não muda a posição de nenhum hook de outro app (nem o grupo dele, nem o índice no grupo)', () => {
    const h = (event: string) => handlerFor(event, CMD, 25);
    const copy = (event: string) => ({ ...h(event), timeout: 99 }); // editada à mão
    const other = (name: string) => ({ type: 'command', command: `orca-hook ${name}` });
    const file = {
      hooks: {
        // Cópia num grupo inteiro ANTES do grupo de outro app: tirá-la faria o grupo dele subir uma posição.
        Stop: [{ hooks: [h('Stop')] }, { hooks: [copy('Stop')] }, { hooks: [other('stop')] }],
        // Cópia na frente do handler de outro app, no mesmo grupo: tirá-la mudaria o índice dele.
        PreToolUse: [{ hooks: [h('PreToolUse')] }, { matcher: 'Bash', hooks: [copy('PreToolUse'), other('pre')] }],
        // Cópias depois de tudo que é de outro app (fim de um grupo misto, último grupo): saem.
        SessionStart: [{ hooks: [h('SessionStart')] }, { hooks: [other('start'), copy('SessionStart')] }, { hooks: [copy('SessionStart')] }],
      },
    };
    const p = planInstall(file, CMD, 25);
    if (p.action !== 'install') throw new Error('esperado install');
    const next = p.file.hooks as Record<string, unknown[]>;
    expect(next.Stop).toEqual(file.hooks.Stop);
    expect(next.PreToolUse).toEqual(file.hooks.PreToolUse);
    expect(next.SessionStart).toEqual([{ hooks: [h('SessionStart')] }, { hooks: [other('start')] }]);
    expect(p.deduped).toEqual(['SessionStart']);
    // Tirar uma cópia de trás não muda a chave nem o hash da que fica: nada a aprovar de novo nesses eventos.
    expect(p.approve).not.toContain('SessionStart');
    expect(p.approve).not.toContain('Stop');
    expect(p.message).toContain('cópias repetidas tiradas em SessionStart');
    // O status separa as cópias que ficaram (o install não resolve) do handler diferente (o install resolve).
    const st = installState(p.file, CMD, 25);
    expect(st.duplicates).toEqual(['PreToolUse', 'Stop']);
    expect(st.outdated).toEqual([]);
    expect(st.ok).toEqual([...EVENTS]);
    expect(planInstall(p.file, CMD, 25)).toEqual({ action: 'none', message: 'já instalado' });
  });

  it('troca de comando (ex.: o formato antigo do Windows): no mesmo lugar e com o comando antigo no plano', () => {
    const old = `'${NODE_WIN}' '${WIN_REPO_HOOK}'`;
    const first = planInstall(ORCA, old, 25);
    if (first.action !== 'install') throw new Error('esperado install');
    expect(first.replaced).toEqual([]);
    const win = windowsHookCommand(WIN_REPO_HOOK);
    const upd = planInstall(first.file, win, 25);
    if (upd.action !== 'install') throw new Error('esperado install');
    expect(upd.replaced).toEqual([old]);
    expect(upd.approve.sort()).toEqual([...EVENTS].sort());
    const before = first.file.hooks as Record<string, unknown[]>;
    const after = upd.file.hooks as Record<string, unknown[]>;
    for (const event of EVENTS) {
      expect(after[event].length, event).toBe(before[event].length);
      expect(after[event].at(-1), event).toEqual({ hooks: [handlerFor(event, win, 25)] });
    }
    // Só a espera mudou: nenhum comando trocado.
    const wait = planInstall(upd.file, win, 60);
    expect(wait.action === 'install' && wait.replaced).toEqual([]);
  });
});

describe('codex-install.ts (arquivos, HOME falso)', () => {
  let tmp: ReturnType<typeof tempDir>;
  let home: string;
  let out: string[];
  const configToml = '[hooks.state."x"]\ntrusted_hash = "abc"\n';

  beforeEach(() => {
    tmp = tempDir();
    home = join(tmp.dir, 'home');
    out = [];
    // ~/.codex com hooks de outro app; ~/.codex-trabalho sem hooks.json; ~/.claude (do Claude Code) nunca entra.
    mkdirSync(join(home, '.codex', 'sessions', '2026'), { recursive: true });
    writeFileSync(join(home, '.codex', 'config.toml'), configToml);
    writeFileSync(join(home, '.codex', 'hooks.json'), `${JSON.stringify(ORCA, null, 2)}\n`);
    mkdirSync(join(home, '.codex-trabalho', 'thread-writer-locks'), { recursive: true });
    mkdirSync(join(home, '.claude', 'projects'), { recursive: true });
  });
  afterEach(() => tmp.cleanup());

  /** `ctx` troca a plataforma (padrão: linux, para o resultado não depender de onde a suíte roda) e o Node dos hooks. */
  const exec = (command: RunOptions['command'], extra: Partial<RunOptions> = {}, env: NodeJS.ProcessEnv = {}, health?: object, ctx: Partial<RunContext> = {}) =>
    run(
      { command, dryRun: false, port: 4747, waitS: DEFAULT_WAIT_S, ...extra },
      { env: { HOME: home, ...env }, home, now: new Date(2026, 9, 9, 9, 30, 0), hookPath: HOOK_SCRIPT, out: (l) => out.push(l), health: async () => health, platform: 'linux', ...ctx },
    );
  const read = (acc: string) => JSON.parse(readFileSync(join(home, acc, 'hooks.json'), 'utf8'));
  const cmd = hookCommand(HOOK_SCRIPT);
  /** O comando que o install grava no Windows com um Node 22+ no PATH. */
  const winCmd = `node "${slash(HOOK_SCRIPT)}"`;
  const installed = (acc: string, event = 'PermissionRequest'): string => read(acc).hooks[event].at(-1).hooks[0].command;

  it('descobre ~/.codex* do Codex (e CODEX_HOME); HABBLAUD_CODEX_DIRS substitui e recusa pasta do Claude Code', () => {
    expect(discoverCodexHomes({}, home).dirs).toEqual([join(home, '.codex'), join(home, '.codex-trabalho')]);
    const extra = join(tmp.dir, 'outra-conta');
    mkdirSync(extra);
    // As mesmas pastas que o servidor acompanha: um CODEX_HOME sem cara de Codex (vazio) fica de fora.
    expect(discoverCodexHomes({ CODEX_HOME: extra }, home).dirs).toEqual([join(home, '.codex'), join(home, '.codex-trabalho')]);
    mkdirSync(join(extra, 'thread-writer-locks'));
    expect(discoverCodexHomes({ CODEX_HOME: extra }, home).dirs).toEqual([extra, join(home, '.codex'), join(home, '.codex-trabalho')]);
    expect(discoverCodexHomes({ HABBLAUD_CODEX_DIRS: `${extra}, ~/.claude, /nao/existe` }, home)).toEqual({ dirs: [extra], refused: [join(home, '.claude')] });
  });

  it('install: backup, grupos alheios intactos, config.toml intocado, ~/.habblaud/codex-hook.json gravado; de novo = nada a fazer', async () => {
    expect(await exec('install', { port: 4851, waitS: 40 })).toBe(0);
    const c = read('.codex');
    for (const [event, list] of Object.entries(ORCA.hooks)) list.forEach((g, i) => expect(c.hooks[event][i]).toEqual(g));
    expect(c.hooks.PermissionRequest[2]).toEqual({ hooks: [handlerFor('PermissionRequest', cmd, 40)] });
    expect(read('.codex-trabalho').hooks.SessionStart).toEqual([{ hooks: [handlerFor('SessionStart', cmd, 40)] }]);
    expect(JSON.parse(readFileSync(join(home, '.codex', 'hooks.json.habblaud-backup-20261009-093000'), 'utf8'))).toEqual(ORCA);
    expect(readFileSync(join(home, '.codex', 'config.toml'), 'utf8')).toBe(configToml);
    expect(existsSync(join(home, '.codex-trabalho', 'config.toml'))).toBe(false);
    expect(existsSync(join(home, '.claude', 'hooks.json'))).toBe(false);
    expect(JSON.parse(readFileSync(join(home, '.habblaud', 'codex-hook.json'), 'utf8'))).toEqual({ port: 4851, permissionTimeoutS: 40 });
    const text = out.join('\n');
    expect(text).toContain('abra o Codex e aprove os hooks do Habblaud em /hooks');
    expect(text).not.toMatch(/trusted_hash/);

    out = [];
    expect(await exec('install', { port: 4851, waitS: 40 })).toBe(0);
    expect(out.join('\n')).toContain('já instalado');
    expect(out.join('\n')).not.toContain('em /hooks');
    expect(readdirSync(join(home, '.codex')).filter((f) => f.includes('backup'))).toHaveLength(1);
  });

  it('--conta, --dry-run, status (com o Habblaud no ar ou não) e uninstall devolvendo o original', async () => {
    const before = readFileSync(join(home, '.codex', 'hooks.json'), 'utf8');
    await exec('install', { dryRun: true });
    expect(readFileSync(join(home, '.codex', 'hooks.json'), 'utf8')).toBe(before);
    expect(existsSync(join(home, '.codex-trabalho', 'hooks.json'))).toBe(false);
    expect(existsSync(join(home, '.habblaud', 'codex-hook.json'))).toBe(false);
    expect(out.join('\n')).toContain('simulação');

    out = [];
    expect(await exec('install', { account: '.codex-trabalho' })).toBe(0);
    expect(readFileSync(join(home, '.codex', 'hooks.json'), 'utf8')).toBe(before);
    out = [];
    await exec('status', {}, {}, { codexEvents: true, permissions: true });
    let text = out.join('\n');
    expect(text).toMatch(/\.codex \(~\/\.codex\/hooks\.json\): não instalado/);
    expect(text).toMatch(/\.codex-trabalho \(.*\): instalado em 9 de 9 eventos/);
    expect(text).toContain('recebendo os eventos do Codex; aprovar pelo escritório ligado');
    expect(text).toContain('confira em /hooks');
    out = [];
    await exec('status');
    expect(out.join('\n')).toContain('fora do ar');

    out = [];
    expect(await exec('uninstall')).toBe(0);
    expect(read('.codex-trabalho')).toEqual({});
    expect(readFileSync(join(home, '.codex', 'hooks.json'), 'utf8')).toBe(before);
    expect(out.join('\n')).toContain('não estava instalado');
    expect(await exec('install', { account: '.nada' })).toBe(1);
  });

  it('--conta com outra espera: avisa das outras pastas que ficaram com a espera antiga (o arquivo de configuração é um só)', async () => {
    expect(await exec('install')).toBe(0);
    out = [];
    expect(await exec('install', { account: '.codex', waitS: 60 })).toBe(0);
    expect(out.join('\n')).toContain('! .codex-trabalho: o Habblaud está lá com outra espera; rode npm run codex:install sem --conta para alinhar.');
    out = [];
    expect(await exec('install', { waitS: 60 })).toBe(0);
    expect(out.join('\n')).not.toContain('outra espera');
  });

  it('JSON inválido nunca é sobrescrito', async () => {
    writeFileSync(join(home, '.codex-trabalho', 'hooks.json'), '{ quebrado');
    expect(await exec('install')).toBe(1);
    expect(readFileSync(join(home, '.codex-trabalho', 'hooks.json'), 'utf8')).toBe('{ quebrado');
    expect(out.join('\n')).toContain('JSON inválido');
  });

  it('Windows com Node 22+ no PATH: grava node "<hook com />"; o status concorda (rodado pelo PowerShell ou pelo Git Bash)', async () => {
    const win: Partial<RunContext> = { platform: 'win32', nodeProbe: versions({ PATH: 'v24.16.0' }), nodeCandidates: [NODE_WIN] };
    expect(await exec('install', {}, {}, undefined, win)).toBe(0);
    for (const event of EVENTS) expect(installed('.codex', event), event).toBe(winCmd);
    expect(out.join('\n')).not.toContain('forma do PowerShell');
    for (const env of [{}, { SHELL: '/usr/bin/bash' }]) {
      out = [];
      await exec('status', {}, env, undefined, win);
      const text = out.join('\n');
      expect(text).toMatch(/\.codex \(.*\): instalado em 9 de 9 eventos/);
      expect(text).toMatch(/\.codex-trabalho \(.*\): instalado em 9 de 9 eventos/);
      expect(text).not.toMatch(/diferente do esperado|apontam para/);
    }
  });

  it('Windows com o node do PATH velho (ou um node.cmd): outro Node 22+ na forma do PowerShell, com aviso; o status concorda', async () => {
    const old: Partial<RunContext> = { platform: 'win32', nodeProbe: versions({ PATH: 'v18.12.1', [NODE_WIN]: 'v24.16.0' }), nodeCandidates: [NODE_WIN] };
    expect(await exec('install', {}, {}, undefined, old)).toBe(0);
    expect(installed('.codex')).toBe(`& "C:/Program Files/nodejs/node.exe" "${slash(HOOK_SCRIPT)}"`);
    let text = out.join('\n');
    expect(text).toContain('O `node` do PATH (o que o Codex roda nos hooks, pelo PowerShell ou pelo cmd) é o Node v18.12.1');
    expect(text).toContain('forma do PowerShell');
    expect(text).toContain('não roda no cmd');
    out = [];
    await exec('status', {}, {}, undefined, old);
    text = out.join('\n');
    expect(text).toMatch(/\.codex \(.*\): instalado em 9 de 9 eventos/);
    expect(text).not.toMatch(/diferente do esperado/);

    // node do PATH que não responde (ausente ou .cmd) e nenhum outro 22+: o comando curto, com aviso.
    out = [];
    expect(await exec('install', { account: '.codex-trabalho' }, {}, undefined, { platform: 'win32', nodeProbe: () => undefined, nodeCandidates: [NODE_WIN] })).toBe(0);
    expect(installed('.codex-trabalho')).toBe(winCmd);
    expect(out.join('\n')).toContain('não existe ou não respondeu e não achei um Node 22+');

    // --node no Windows: a forma do PowerShell (a de antes, "<node>" "<hook>", é erro de sintaxe lá).
    out = [];
    expect(await exec('install', { account: '.codex-trabalho', node: NODE_WIN }, {}, undefined, { platform: 'win32' })).toBe(0);
    expect(installed('.codex-trabalho')).toBe(`& "C:/Program Files/nodejs/node.exe" "${slash(HOOK_SCRIPT)}"`);
    expect(out.join('\n')).toContain('--node no Windows');
  });

  it('Windows: o comando antigo (aspas simples, que o PowerShell rejeita) é trocado no mesmo lugar e o install pede aprovação nova em /hooks', async () => {
    const oldCmd = `'${NODE_WIN}' '${HOOK_SCRIPT}'`;
    const first = planInstall(ORCA, oldCmd, DEFAULT_WAIT_S);
    if (first.action !== 'install') throw new Error('esperado install');
    writeFileSync(join(home, '.codex', 'hooks.json'), `${JSON.stringify(first.file, null, 2)}\n`);
    const win: Partial<RunContext> = { platform: 'win32', nodeProbe: versions({ PATH: 'v24.16.0' }) };
    await exec('status', { account: '.codex' }, {}, undefined, win);
    expect(out.join('\n')).toContain(`diferente do esperado em ${EVENTS.join(', ')}; rode npm run codex:install para atualizar`);
    out = [];
    expect(await exec('install', { account: '.codex' }, {}, undefined, win)).toBe(0);
    const c = read('.codex');
    for (const [event, list] of Object.entries(ORCA.hooks)) list.forEach((g, i) => expect(c.hooks[event][i]).toEqual(g));
    expect(c.hooks.PermissionRequest).toHaveLength(3);
    expect(c.hooks.PermissionRequest[2]).toEqual({ hooks: [handlerFor('PermissionRequest', winCmd, DEFAULT_WAIT_S)] });
    const text = out.join('\n');
    expect(text).toContain(`O comando dos hooks mudou (antes: ${oldCmd}; agora: ${winCmd})`);
    expect(text).toContain('aprovar de novo em /hooks');
    expect(text).not.toMatch(/trusted_hash/);
    expect(readFileSync(join(home, '.codex', 'config.toml'), 'utf8')).toBe(configToml);
    // De novo: nada muda e nada a aprovar.
    out = [];
    expect(await exec('install', { account: '.codex' }, {}, undefined, win)).toBe(0);
    expect(out.join('\n')).toContain('já instalado');
    expect(out.join('\n')).not.toContain('O comando dos hooks mudou');
  });

  it('cópia repetida antes do grupo de outro app: o install não a tira e diz por quê; o status aponta a mesma causa', async () => {
    const h = handlerFor('Stop', cmd, DEFAULT_WAIT_S);
    const file = { ...ORCA, hooks: { ...ORCA.hooks, Stop: [{ hooks: [h] }, { hooks: [{ ...h, timeout: 99 }] }, ...ORCA.hooks.Stop] } };
    writeFileSync(join(home, '.codex', 'hooks.json'), `${JSON.stringify(file, null, 2)}\n`);
    expect(await exec('install', { account: '.codex' })).toBe(0);
    expect(read('.codex').hooks.Stop).toEqual(file.hooks.Stop);
    let text = out.join('\n');
    expect(text).toContain('! .codex (~/.codex/hooks.json): mais de uma cópia do hook do Habblaud em Stop');
    expect(text).toContain('mudaria a posição do hook de outro app');
    expect(text).not.toContain('mudaram de posição');
    out = [];
    await exec('status', { account: '.codex' });
    text = out.join('\n');
    expect(text).toContain('mais de uma cópia do hook do Habblaud em Stop');
    expect(text).toContain('mudaria a posição do hook de outro app');
    expect(text).toMatch(/instalado em 9 de 9 eventos/);
    expect(text).not.toMatch(/diferente do esperado/);
    out = [];
    expect(await exec('install', { account: '.codex' })).toBe(0);
    expect(out.join('\n')).toContain('já instalado');
    expect(out.join('\n')).toContain('mais de uma cópia do hook do Habblaud em Stop');
  });

  it('cópia repetida que dá para tirar: o status manda rodar o install; o install tira sem pedir aprovação nova', async () => {
    expect(await exec('install', { account: '.codex' })).toBe(0);
    const c = read('.codex');
    c.hooks.Stop.push({ hooks: [handlerFor('Stop', cmd, DEFAULT_WAIT_S)] });
    writeFileSync(join(home, '.codex', 'hooks.json'), `${JSON.stringify(c, null, 2)}\n`);
    out = [];
    await exec('status', { account: '.codex' });
    expect(out.join('\n')).toContain('mais de uma cópia do hook do Habblaud em Stop; rode npm run codex:install para tirar as repetidas');
    out = [];
    expect(await exec('install', { account: '.codex' })).toBe(0);
    expect(read('.codex').hooks.Stop).toHaveLength(ORCA.hooks.Stop.length + 1);
    const text = out.join('\n');
    expect(text).toContain('cópias repetidas tiradas em Stop');
    expect(text).not.toContain('em /hooks');
  });

  it.skipIf(!SH)('o comando instalado roda de verdade: com o Habblaud fora do ar, sai rápido, com 0 e sem saída', async () => {
    await exec('install', { port: 1 });
    const command: string = read('.codex').hooks.PermissionRequest.at(-1).hooks[0].command;
    for (const event of ['PreToolUse', 'PermissionRequest']) {
      const input = JSON.stringify({ session_id: '0199b0c0-1234-7abc-8def-0123456789ab', hook_event_name: event, cwd: '/p', tool_name: 'Bash', tool_input: { command: 'ls' } });
      const t0 = Date.now();
      const r = spawnSync(SH!, ['-c', command], { input, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home }, timeout: 10_000 });
      expect(r.status, event).toBe(0);
      expect(r.stdout, event).toBe('');
      expect(Date.now() - t0).toBeLessThan(5_000);
    }
  });

  const hookInput = JSON.stringify({ session_id: '0199b0c0-1234-7abc-8def-0123456789ab', hook_event_name: 'PreToolUse', cwd: '/p', tool_name: 'Bash', tool_input: { command: 'ls' } });

  it.skipIf(!SH)('o comando do Windows (node "<hook com />") também roda no sh: sai com 0 e sem saída', async () => {
    await exec('install', { port: 1 }, {}, undefined, { platform: 'win32', nodeProbe: versions({ PATH: 'v24.16.0' }) });
    expect(installed('.codex')).toBe(winCmd);
    const r = spawnSync(SH!, ['-c', winCmd], { input: hookInput, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home }, timeout: 10_000 });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('');
  }, 30_000);

  it.skipIf(process.platform !== 'win32')('Windows: o comando gravado roda de verdade no PowerShell (-NoProfile -Command) e no cmd (/C): sai com 0 e sem saída', async () => {
    await exec('install', { port: 1 }, {}, undefined, { platform: 'win32', nodeProbe: versions({ PATH: 'v24.16.0' }) });
    const short = installed('.codex');
    expect(short).toBe(winCmd);
    // A forma do PowerShell, com o Node deste processo (o que o install usa quando o do PATH é velho).
    await exec('install', { port: 1, account: '.codex-trabalho' }, {}, undefined, { platform: 'win32', nodeProbe: versions({ [process.execPath]: 'v24.16.0' }), nodeCandidates: [process.execPath] });
    const amp = installed('.codex-trabalho');
    expect(amp).toBe(`& "${slash(process.execPath)}" "${slash(HOOK_SCRIPT)}"`);
    // O Codex usa o pwsh.exe; sem ele (Windows sem PowerShell 7), o powershell.exe 5.1 se comporta igual aqui.
    const ps = findOnPath('pwsh', process.env) ?? findOnPath('powershell', process.env);
    expect(ps).toBeDefined();
    // HOME falso: o hook lê a porta 1 do ~/.habblaud/codex-hook.json falso (nunca o Habblaud de verdade).
    const env = { PATH: process.env.PATH, PATHEXT: process.env.PATHEXT, SystemRoot: process.env.SystemRoot, HOME: home };
    const runs: Array<[string, string[], boolean]> = [
      [ps!, ['-NoProfile', '-Command', short], false],
      [ps!, ['-NoProfile', '-Command', amp], false],
      // Sem shell configurado, o Codex roda `%COMSPEC% /C "<comando>"`.
      [process.env.ComSpec ?? 'cmd.exe', ['/C', `"${short}"`], true],
    ];
    for (const [bin, args, verbatim] of runs) {
      const t0 = Date.now();
      const r = spawnSync(bin, args, { input: hookInput, encoding: 'utf8', env, timeout: 30_000, windowsVerbatimArguments: verbatim });
      expect(r.status, `${bin} ${args.join(' ')}: ${r.stderr}`).toBe(0);
      expect(r.stdout).toBe('');
      expect(Date.now() - t0).toBeLessThan(10_000);
    }
    // Três processos (o PowerShell sobe devagar com a máquina carregada): mais que os 5 s padrão do Vitest.
  }, 60_000);
});
