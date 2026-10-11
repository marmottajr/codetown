// Instalador do plugin do OpenCode (scripts/opencode-install.ts) sobre um HOME FALSO em pasta temporária: nunca toca
// em ~/.config/opencode nem em ~/.habblaud de verdade. Install (arquivos, backup, idempotência), --dry-run, uninstall
// (só os dois arquivos), status e a leitura dos argumentos.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { configPath, DEFAULT_PORT, DEFAULT_WAIT_S, parseArgs, PLUGIN_SOURCE, pluginPath, readHookConfig, run, type Health, type RunContext, type RunOptions } from '../../scripts/opencode-install';
import { tempDir } from './fixtures';

let tmp: ReturnType<typeof tempDir>;
let home: string;
let out: string[];
let srcDir: string;
const NOW = new Date(2026, 9, 9, 10, 30, 0);

beforeEach(() => {
  tmp = tempDir();
  home = join(tmp.dir, 'home');
  srcDir = join(tmp.dir, 'repo');
  mkdirSync(home, { recursive: true });
  mkdirSync(srcDir, { recursive: true });
  out = [];
});
afterEach(() => tmp.cleanup());

const opts = (command: RunOptions['command'], over: Partial<RunOptions> = {}): RunOptions => ({ command, dryRun: false, port: 4851, waitS: 40, ...over });
const ctx = (over: Partial<RunContext> = {}): RunContext => ({ home, now: NOW, pluginPath: PLUGIN_SOURCE, out: (l) => out.push(l), health: async () => undefined, ...over });
const exec = (command: RunOptions['command'], over: Partial<RunOptions> = {}, c: Partial<RunContext> = {}) => run(opts(command, over), ctx(c));
const backups = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.includes('backup')) : []);
const PLUGIN = () => pluginPath(home);
const CONFIG = () => configPath(home);

describe('opencode-install: install (OC-12)', () => {
  it('grava a cópia do plugin em ~/.config/opencode/plugins/habblaud.js e a configuração em ~/.habblaud/opencode-hook.json', async () => {
    expect(PLUGIN()).toBe(join(home, '.config', 'opencode', 'plugins', 'habblaud.js'));
    expect(CONFIG()).toBe(join(home, '.habblaud', 'opencode-hook.json'));
    expect(await exec('install')).toBe(0);
    expect(readFileSync(PLUGIN(), 'utf8')).toBe(readFileSync(PLUGIN_SOURCE, 'utf8'));
    expect(JSON.parse(readFileSync(CONFIG(), 'utf8'))).toEqual({ port: 4851, permissionTimeoutS: 40 });
    expect(readHookConfig(home)).toEqual({ port: 4851, permissionTimeoutS: 40 });
    const text = out.join('\n');
    expect(text).toContain('~/.config/opencode/plugins/habblaud.js: criado');
    expect(text).toContain('Reinicie o OpenCode');
    expect(backups(join(home, '.config', 'opencode', 'plugins'))).toHaveLength(0); // nada existia: nada de backup
  });

  it('faz backup de um arquivo que já existia com outro conteúdo (plugin e configuração) antes de trocar', async () => {
    mkdirSync(join(home, '.config', 'opencode', 'plugins'), { recursive: true });
    mkdirSync(join(home, '.habblaud'), { recursive: true });
    writeFileSync(PLUGIN(), '// plugin antigo do usuário\n');
    writeFileSync(CONFIG(), JSON.stringify({ port: 1234, permissionTimeoutS: 10 }));
    expect(await exec('install')).toBe(0);
    const pb = backups(join(home, '.config', 'opencode', 'plugins'));
    expect(pb).toEqual(['habblaud.js.habblaud-backup-20261009-103000']);
    expect(readFileSync(join(home, '.config', 'opencode', 'plugins', pb[0]), 'utf8')).toBe('// plugin antigo do usuário\n');
    const cb = backups(join(home, '.habblaud'));
    expect(cb).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(home, '.habblaud', cb[0]), 'utf8'))).toEqual({ port: 1234, permissionTimeoutS: 10 });
    expect(readFileSync(PLUGIN(), 'utf8')).toBe(readFileSync(PLUGIN_SOURCE, 'utf8'));
    expect(readHookConfig(home)).toEqual({ port: 4851, permissionTimeoutS: 40 });
  });

  it('rodar de novo com os mesmos valores não grava nem faz backup; outra porta atualiza só a configuração', async () => {
    await exec('install');
    out = [];
    expect(await exec('install')).toBe(0);
    expect(out.join('\n')).toContain('já instalado');
    expect(out.join('\n')).not.toContain('Reinicie');
    expect(backups(join(home, '.config', 'opencode', 'plugins'))).toHaveLength(0);
    expect(backups(join(home, '.habblaud'))).toHaveLength(0);
    expect(await exec('install', { port: 4900 })).toBe(0);
    expect(readHookConfig(home)?.port).toBe(4900);
    expect(backups(join(home, '.habblaud'))).toHaveLength(1);
    expect(backups(join(home, '.config', 'opencode', 'plugins'))).toHaveLength(0);
  });

  it('sem o plugin do repositório: erro e nada gravado', async () => {
    expect(await exec('install', {}, { pluginPath: join(srcDir, 'nao-existe.js') })).toBe(1);
    expect(existsSync(join(home, '.config'))).toBe(false);
    expect(existsSync(join(home, '.habblaud'))).toBe(false);
  });
});

describe('opencode-install: --dry-run (OC-14)', () => {
  it('imprime o plano e não grava nada (nem pastas), com ou sem arquivos existentes', async () => {
    expect(await exec('install', { dryRun: true })).toBe(0);
    expect(existsSync(join(home, '.config'))).toBe(false);
    expect(existsSync(join(home, '.habblaud'))).toBe(false);
    expect(out.join('\n')).toContain('simulação');
    expect(out.join('\n')).toContain('seria criado');

    mkdirSync(join(home, '.config', 'opencode', 'plugins'), { recursive: true });
    writeFileSync(PLUGIN(), '// do usuário\n');
    out = [];
    await exec('install', { dryRun: true });
    expect(readFileSync(PLUGIN(), 'utf8')).toBe('// do usuário\n');
    expect(backups(join(home, '.config', 'opencode', 'plugins'))).toHaveLength(0);
    expect(out.join('\n')).toContain('seria atualizado (com backup)');

    await exec('install');
    out = [];
    await exec('uninstall', { dryRun: true });
    expect(existsSync(PLUGIN())).toBe(true);
    expect(existsSync(CONFIG())).toBe(true);
    expect(out.join('\n')).toContain('seria removido');
  });
});

describe('opencode-install: uninstall (OC-13)', () => {
  it('remove só os dois arquivos; o resto da pasta do OpenCode e do ~/.habblaud fica', async () => {
    await exec('install');
    const outro = join(home, '.config', 'opencode', 'plugins', 'outro.js');
    const json = join(home, '.config', 'opencode', 'opencode.json');
    const stats = join(home, '.habblaud', 'stats.json');
    writeFileSync(outro, '// outro plugin\n');
    writeFileSync(json, '{"model":"x"}');
    writeFileSync(stats, '{}');
    out = [];
    expect(await exec('uninstall')).toBe(0);
    expect(existsSync(PLUGIN())).toBe(false);
    expect(existsSync(CONFIG())).toBe(false);
    for (const f of [outro, json, stats]) expect(existsSync(f), f).toBe(true);
    expect(readFileSync(json, 'utf8')).toBe('{"model":"x"}');
    out = [];
    expect(await exec('uninstall')).toBe(0);
    expect(out.join('\n')).toContain('não estava instalado');
  });

  it('um habblaud.js que não é do Habblaud não é removido (erro), mas a configuração sim', async () => {
    mkdirSync(join(home, '.config', 'opencode', 'plugins'), { recursive: true });
    writeFileSync(PLUGIN(), '// plugin de outra pessoa\nexport const Outro = async () => ({})\n');
    expect(await exec('uninstall')).toBe(1);
    expect(readFileSync(PLUGIN(), 'utf8')).toContain('Outro');
    expect(out.join('\n')).toContain('não é o plugin do Habblaud');
  });
});

describe('opencode-install: status', () => {
  it('não instalado; instalado e atualizado; copia defasada; com o Habblaud no ar ou fora', async () => {
    await exec('status');
    let text = out.join('\n');
    expect(text).toContain('não instalado');
    expect(text).toContain('fora do ar');
    expect(text).toContain(`porta ${DEFAULT_PORT}`);
    await exec('install');
    out = [];
    const health: Health = { opencodeEvents: true, opencodeSource: true, permissions: true };
    expect(await exec('status', {}, { health: async () => health })).toBe(0);
    text = out.join('\n');
    expect(text).toContain('instalado e atualizado');
    expect(text).toContain('porta 4851, espera 40 s');
    expect(text).toContain('Habblaud em http://127.0.0.1:4851: recebendo os eventos do OpenCode; aprovar pelo escritório ligado');
    writeFileSync(PLUGIN(), `${readFileSync(PLUGIN(), 'utf8')}\n// versão velha\n`);
    out = [];
    await exec('status', {}, { health: async () => ({ opencodeEvents: false, permissions: false }) });
    text = out.join('\n');
    expect(text).toContain('diferente do plugin deste repositório');
    expect(text).toContain('HABBLAUD_OPENCODE=0');
  });
});

describe('opencode-install: argumentos', () => {
  it('comando, --dry-run, --port, --espera e erros', () => {
    expect(parseArgs(['install'], {})).toEqual({ command: 'install', dryRun: false, port: DEFAULT_PORT, waitS: DEFAULT_WAIT_S });
    expect(parseArgs(['install', '--dry-run', '--port', '5000', '--espera', '30'], {})).toEqual({ command: 'install', dryRun: true, port: 5000, waitS: 30 });
    expect(parseArgs(['status'], { HABBLAUD_PORT: '4999' })).toMatchObject({ command: 'status', port: 4999 });
    expect(parseArgs(['--help'], {})).toBe('help');
    for (const bad of [[], ['install', '--port', '0'], ['install', '--port', 'x'], ['install', '--espera', '1'], ['install', '--espera', '999'], ['install', '--nada'], ['install', 'uninstall']]) {
      expect(() => parseArgs(bad, {}), bad.join(' ')).toThrow();
    }
  });
});
