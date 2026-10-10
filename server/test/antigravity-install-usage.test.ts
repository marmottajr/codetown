// Instalador do Antigravity com --uso (AG-25 e AG-29): o statusLine da cota no settings.json do agy, sobre um HOME FALSO em
// pasta temporária (nunca toca no ~/.gemini nem no ~/.habblaud de verdade).
import { existsSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HOOK_SOURCE, hooksFile, quotaFile, run, settingsFile, statuslineCopy, STATUSLINE_SOURCE, statusLineEntry, type RunContext, type RunOptions } from '../../scripts/antigravity-install';
import { tempDir } from './fixtures';

let tmp: ReturnType<typeof tempDir>;
let home: string;
let out: string[];
const NOW = new Date(2026, 9, 10, 12, 0, 0);

beforeEach(() => {
  tmp = tempDir();
  home = join(tmp.dir, 'home');
  mkdirSync(home, { recursive: true });
  out = [];
});
afterEach(() => tmp.cleanup());

const opts = (command: RunOptions['command'], over: Partial<RunOptions> = {}): RunOptions => ({ command, dryRun: false, port: 4851, approvals: false, waitS: 40, usage: false, ...over });
const ctx = (over: Partial<RunContext> = {}): RunContext => ({ home, now: NOW, hookPath: HOOK_SOURCE, out: (l) => out.push(l), health: async () => undefined, ...over });
const exec = (command: RunOptions['command'], over: Partial<RunOptions> = {}, c: Partial<RunContext> = {}) => run(opts(command, over), ctx(c));
const SETTINGS = () => settingsFile(home);
const SL_COPY = () => statuslineCopy(home);
const settingsDir = () => join(home, '.gemini', 'antigravity-cli');
const backups = () => (existsSync(settingsDir()) ? readdirSync(settingsDir()).filter((f) => f.includes('backup')) : []);
const readSettings = () => JSON.parse(readFileSync(SETTINGS(), 'utf8')) as Record<string, unknown>;
const seed = (obj: unknown) => {
  mkdirSync(settingsDir(), { recursive: true });
  writeFileSync(SETTINGS(), typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2));
};
const MINE = { theme: 'dark', model: 'gemini-x', nested: { a: [1, 2, 3] } };
const FOREIGN = { type: 'command', command: 'bash ~/minha-linha.sh', stack_with_default: false };
const text = () => out.join('\n');

describe('antigravity-install --uso: install (AG-25)', () => {
  it('copia o statusline, grava o statusLine mantendo as outras chaves e faz backup do settings anterior', async () => {
    seed(MINE);
    const before = readFileSync(SETTINGS(), 'utf8');
    expect(await exec('install', { usage: true })).toBe(0);
    expect(SL_COPY()).toBe(join(home, '.habblaud', 'antigravity-statusline.mjs'));
    expect(readFileSync(SL_COPY(), 'utf8')).toBe(readFileSync(STATUSLINE_SOURCE, 'utf8'));
    expect(readSettings()).toEqual({ ...MINE, statusLine: { type: 'command', command: `node ${SL_COPY()}`, stack_with_default: true } });
    const bk = backups();
    expect(bk).toHaveLength(1);
    expect(readFileSync(join(settingsDir(), bk[0]), 'utf8')).toBe(before);
  });

  it('sem settings.json: cria só com o statusLine', async () => {
    expect(await exec('install', { usage: true })).toBe(0);
    expect(readSettings()).toEqual({ statusLine: statusLineEntry(SL_COPY()) });
    expect(backups()).toHaveLength(0);
  });

  it('segunda rodada: idempotente, sem novo backup nem mudança', async () => {
    seed(MINE);
    await exec('install', { usage: true });
    const first = readFileSync(SETTINGS(), 'utf8');
    out.length = 0;
    expect(await exec('install', { usage: true })).toBe(0);
    expect(readFileSync(SETTINGS(), 'utf8')).toBe(first);
    expect(backups()).toHaveLength(1);
    expect(text()).toContain('já instalado');
  });

  it('--dry-run não grava nada (nem o settings, nem a cópia)', async () => {
    seed(MINE);
    const before = readFileSync(SETTINGS(), 'utf8');
    expect(await exec('install', { usage: true, dryRun: true })).toBe(0);
    expect(readFileSync(SETTINGS(), 'utf8')).toBe(before);
    expect(existsSync(SL_COPY())).toBe(false);
    expect(existsSync(hooksFile(home))).toBe(false);
    expect(backups()).toHaveLength(0);
  });

  it('sem --uso o settings.json nunca é criado nem tocado', async () => {
    expect(await exec('install')).toBe(0);
    expect(existsSync(SETTINGS())).toBe(false);
    expect(existsSync(SL_COPY())).toBe(false);
    seed('{"theme":  "dark"}\n');
    const before = readFileSync(SETTINGS(), 'utf8');
    expect(await exec('install')).toBe(0);
    expect(await exec('uninstall')).toBe(0);
    expect(readFileSync(SETTINGS(), 'utf8')).toBe(before);
    expect(backups()).toHaveLength(0);
  });

  it('statusLine de outra pessoa: fica intacto, o resto do install roda, sai com 1 e avisa', async () => {
    seed({ ...MINE, statusLine: FOREIGN });
    const before = readFileSync(SETTINGS(), 'utf8');
    expect(await exec('install', { usage: true })).toBe(1);
    expect(readFileSync(SETTINGS(), 'utf8')).toBe(before);
    expect(existsSync(SL_COPY())).toBe(false);
    expect(existsSync(hooksFile(home))).toBe(true);
    expect(existsSync(join(home, '.habblaud', 'antigravity-hook.mjs'))).toBe(true);
    expect(backups()).toHaveLength(0);
    expect(text()).toContain('statusLine que não é do Habblaud');
  });

  it.each([['não é JSON', '{isso nao e json'], ['não é um objeto', '[1,2]'], ['é null', 'null']])('settings.json inválido (%s): não é tocado, sai com 1', async (_n, content) => {
    seed(content);
    expect(await exec('install', { usage: true })).toBe(1);
    expect(readFileSync(SETTINGS(), 'utf8')).toBe(content);
    expect(existsSync(SL_COPY())).toBe(false);
    expect(backups()).toHaveLength(0);
    expect(text()).toContain('não é um objeto JSON válido');
  });

  it('caminho com espaço: recusa e não grava o settings', async () => {
    const spaced = join(tmp.dir, 'home com espaço');
    mkdirSync(spaced, { recursive: true });
    expect(await exec('install', { usage: true }, { home: spaced })).toBe(1);
    expect(existsSync(settingsFile(spaced))).toBe(false);
    expect(existsSync(statuslineCopy(spaced))).toBe(false);
  });

  it('atualiza um statusLine do Habblaud antigo (outro caminho) sem tocar nas outras chaves', async () => {
    seed({ ...MINE, statusLine: { type: 'command', command: 'node /velho/antigravity-statusline.mjs' } });
    expect(await exec('install', { usage: true })).toBe(0);
    expect(readSettings()).toEqual({ ...MINE, statusLine: statusLineEntry(SL_COPY()) });
  });
});

describe('antigravity-install --uso: uninstall (AG-29)', () => {
  const quota = () => {
    mkdirSync(join(home, '.habblaud', 'usage'), { recursive: true });
    writeFileSync(quotaFile(home), '{"quota":{}}');
    writeFileSync(join(home, '.habblaud', 'usage', 'outro.json'), '{}');
  };

  it('remove o statusLine do Habblaud, a cópia e o arquivo de cota; o resto do settings fica idêntico', async () => {
    seed(MINE);
    await exec('install', { usage: true });
    quota();
    expect(quotaFile(home)).toBe(join(home, '.habblaud', 'usage', 'antigravity-quota.json'));
    const withSl = readFileSync(SETTINGS(), 'utf8');
    expect(await exec('uninstall')).toBe(0);
    expect(readSettings()).toEqual(MINE);
    // o settings anterior (ainda com o statusLine do Habblaud) fica num backup
    const dir = settingsDir();
    expect(backups().map((f) => readFileSync(join(dir, f), 'utf8'))).toContain(withSl);
    expect(text()).toContain('backup em');
    expect(existsSync(SL_COPY())).toBe(false);
    expect(existsSync(quotaFile(home))).toBe(false);
    expect(existsSync(join(home, '.habblaud', 'usage', 'outro.json'))).toBe(true);
  });

  it('statusLine de outra pessoa continua; a cópia e a cota do Habblaud saem', async () => {
    seed({ ...MINE, statusLine: FOREIGN });
    const before = readFileSync(SETTINGS(), 'utf8');
    mkdirSync(join(home, '.habblaud'), { recursive: true });
    writeFileSync(SL_COPY(), '// copia');
    quota();
    expect(await exec('uninstall')).toBe(0);
    expect(readFileSync(SETTINGS(), 'utf8')).toBe(before);
    expect(existsSync(SL_COPY())).toBe(false);
    expect(existsSync(quotaFile(home))).toBe(false);
  });

  it('settings.json inválido: não é tocado', async () => {
    seed('{quebrado');
    expect(await exec('uninstall')).toBe(0);
    expect(readFileSync(SETTINGS(), 'utf8')).toBe('{quebrado');
    expect(backups()).toHaveLength(0);
  });

  it('--dry-run não remove nada', async () => {
    seed(MINE);
    await exec('install', { usage: true });
    quota();
    const before = readFileSync(SETTINGS(), 'utf8');
    out.length = 0;
    expect(await exec('uninstall', { dryRun: true })).toBe(0);
    expect(readFileSync(SETTINGS(), 'utf8')).toBe(before);
    expect(existsSync(SL_COPY())).toBe(true);
    expect(existsSync(quotaFile(home))).toBe(true);
    expect(text()).toContain('simulação');
  });
});

describe('antigravity-install --uso: status', () => {
  const status = async () => {
    out.length = 0;
    expect(await exec('status')).toBe(0);
    return text();
  };

  it('desligado, sem settings.json', async () => {
    expect(await status()).toContain('Uso (cota do /usage): ');
    expect(text()).toMatch(/desligado\. Para ligar: npm run antigravity:install -- --uso/);
  });

  it('ligado, ainda sem leitura', async () => {
    await exec('install', { usage: true });
    expect(await status()).toContain('ligado; ainda sem leitura');
  });

  it('ligado com a idade da última leitura', async () => {
    await exec('install', { usage: true });
    mkdirSync(join(home, '.habblaud', 'usage'), { recursive: true });
    writeFileSync(quotaFile(home), '{}');
    expect(await status()).toMatch(/ligado; última leitura há \d+ s/);
    const old = new Date(Date.now() - 10 * 60_000);
    utimesSync(quotaFile(home), old, old);
    expect(await status()).toContain('última leitura há 10 min');
  });

  it('statusLine de outra pessoa', async () => {
    seed({ statusLine: FOREIGN });
    expect(await status()).toContain('statusLine que não é do Habblaud; o uso não é lido');
  });

  it('desatualizado: cópia diferente da do repositório, ou comando diferente', async () => {
    await exec('install', { usage: true });
    writeFileSync(SL_COPY(), '// antigo');
    expect(await status()).toContain('diferente do esperado ou desatualizado');
    await exec('install', { usage: true });
    seed({ statusLine: { type: 'command', command: 'node /velho/antigravity-statusline.mjs' } });
    expect(await status()).toContain('diferente do esperado ou desatualizado');
  });

  it('settings.json inválido: desligado, e não é tocado', async () => {
    seed('nao-json');
    expect(await status()).toContain('não é um objeto JSON válido; desligado');
    expect(readFileSync(SETTINGS(), 'utf8')).toBe('nao-json');
  });
});
