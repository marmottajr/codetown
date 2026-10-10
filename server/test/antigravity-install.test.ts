// Instalador do hook do Antigravity (scripts/antigravity-install.ts) sobre um HOME FALSO em pasta temporária: nunca toca
// em ~/.gemini nem em ~/.habblaud de verdade. Install (hooks.json mesclado, backup, idempotência), --dry-run, uninstall
// (só o que a instalação acrescentou), status, caminho com espaço, hooks.json inválido e a leitura dos argumentos.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { configPath, DEFAULT_PORT, HOOK_NAME, HOOK_SOURCE, hookCopy, hookEntry, hooksFile, parseArgs, run, type Health, type RunContext, type RunOptions } from '../../scripts/antigravity-install';
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

const opts = (command: RunOptions['command'], over: Partial<RunOptions> = {}): RunOptions => ({ command, dryRun: false, port: 4851, ...over });
const ctx = (over: Partial<RunContext> = {}): RunContext => ({ home, now: NOW, hookPath: HOOK_SOURCE, out: (l) => out.push(l), health: async () => undefined, ...over });
const exec = (command: RunOptions['command'], over: Partial<RunOptions> = {}, c: Partial<RunContext> = {}) => run(opts(command, over), ctx(c));
const backups = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.includes('backup')) : []);
const HOOKS = () => hooksFile(home);
const COPY = () => hookCopy(home);
const CONFIG = () => configPath(home);
const readHooks = () => JSON.parse(readFileSync(HOOKS(), 'utf8')) as Record<string, unknown>;
/** O hooks.json de um usuário com outro hook (formato da doc do agy 1.3.3). */
const OTHER = { 'lint-checker': { PostToolUse: [{ matcher: 'run_command', hooks: [{ type: 'command', command: './scripts/lint.sh', timeout: 10 }] }] } };
const seed = (obj: unknown) => {
  mkdirSync(join(home, '.gemini', 'config'), { recursive: true });
  writeFileSync(HOOKS(), typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2));
};

describe('antigravity-install: install (AG-11)', () => {
  it('sem hooks.json: cria o arquivo com o hook "habblaud" nos cinco eventos, copia o script e grava a porta', async () => {
    expect(HOOKS()).toBe(join(home, '.gemini', 'config', 'hooks.json'));
    expect(COPY()).toBe(join(home, '.habblaud', 'antigravity-hook.mjs'));
    expect(await exec('install')).toBe(0);
    const h = readHooks();
    expect(Object.keys(h)).toEqual([HOOK_NAME]);
    expect(h[HOOK_NAME]).toEqual(hookEntry(COPY()));
    expect(readFileSync(COPY(), 'utf8')).toBe(readFileSync(HOOK_SOURCE, 'utf8'));
    expect(JSON.parse(readFileSync(CONFIG(), 'utf8'))).toEqual({ port: 4851 });
  });

  it('o formato segue a doc do agy: Pre/PostToolUse agrupados com matcher; os outros três em lista plana; timeout em segundos', async () => {
    await exec('install');
    const e = readHooks()[HOOK_NAME] as Record<string, Array<Record<string, unknown>>>;
    expect(Object.keys(e).sort()).toEqual(['PostInvocation', 'PostToolUse', 'PreInvocation', 'PreToolUse', 'Stop']);
    for (const ev of ['PreToolUse', 'PostToolUse']) {
      expect(e[ev]).toEqual([{ matcher: '*', hooks: [{ type: 'command', command: `node ${COPY()} ${ev}`, timeout: 10 }] }]);
    }
    for (const ev of ['PreInvocation', 'PostInvocation', 'Stop']) {
      expect(e[ev]).toEqual([{ type: 'command', command: `node ${COPY()} ${ev}`, timeout: 10 }]);
    }
  });

  it('AG-17: o comando não tem aspas e o caminho não tem espaço', async () => {
    await exec('install');
    const cmds = JSON.stringify(readHooks()[HOOK_NAME]).match(/"command":"([^"]+)"/g) ?? [];
    expect(cmds).toHaveLength(5);
    for (const c of cmds) expect(c).toMatch(/^"command":"node \S+ [A-Za-z]+"$/);
  });

  it('com outro hook já no arquivo: o dele fica idêntico, o do Habblaud entra e um backup do original é feito', async () => {
    seed(OTHER);
    const before = readFileSync(HOOKS(), 'utf8');
    expect(await exec('install')).toBe(0);
    const h = readHooks();
    expect(h['lint-checker']).toEqual(OTHER['lint-checker']);
    expect(h[HOOK_NAME]).toEqual(hookEntry(COPY()));
    const bk = backups(join(home, '.gemini', 'config'));
    expect(bk).toHaveLength(1);
    expect(readFileSync(join(home, '.gemini', 'config', bk[0]), 'utf8')).toBe(before);
  });

  it('AG-14: rodar duas vezes deixa o hooks.json idêntico e não faz outro backup', async () => {
    seed(OTHER);
    await exec('install');
    const once = readFileSync(HOOKS(), 'utf8');
    const nBackups = backups(join(home, '.gemini', 'config')).length;
    out = [];
    expect(await exec('install')).toBe(0);
    expect(readFileSync(HOOKS(), 'utf8')).toBe(once);
    expect(backups(join(home, '.gemini', 'config'))).toHaveLength(nBackups);
    expect(out.every((l) => l.startsWith('='))).toBe(true);
  });

  it('outra porta: atualiza só a configuração (com backup dela) e deixa o hooks.json quieto', async () => {
    await exec('install');
    const hooksBefore = readFileSync(HOOKS(), 'utf8');
    await exec('install', { port: 4999 });
    expect(JSON.parse(readFileSync(CONFIG(), 'utf8'))).toEqual({ port: 4999 });
    expect(readFileSync(HOOKS(), 'utf8')).toBe(hooksBefore);
    expect(backups(join(home, '.habblaud'))).toHaveLength(1);
  });

  it('um hook "habblaud" antigo ou editado à mão é trocado (com backup)', async () => {
    seed({ ...OTHER, [HOOK_NAME]: { Stop: [{ type: 'command', command: 'echo velho' }] } });
    await exec('install');
    expect(readHooks()[HOOK_NAME]).toEqual(hookEntry(COPY()));
    expect(readHooks()['lint-checker']).toEqual(OTHER['lint-checker']);
    expect(backups(join(home, '.gemini', 'config'))).toHaveLength(1);
  });

  it('AG-15: hooks.json que não é JSON, ou não é um objeto: recusa, código 1 e NADA é gravado (nem a cópia do script)', async () => {
    for (const bad of ['{ quebrado', '[1,2]', '"texto"', 'null']) {
      seed(bad);
      out = [];
      expect(await exec('install'), bad).toBe(1);
      expect(readFileSync(HOOKS(), 'utf8')).toBe(bad);
      expect(existsSync(COPY())).toBe(false);
      expect(existsSync(CONFIG())).toBe(false);
      expect(out.join('\n')).toContain('não é um objeto JSON válido');
    }
  });

  it('caminho da cópia com espaço: recusa sem gravar nada (o agy parte o comando nos espaços)', async () => {
    const spaced = join(tmp.dir, 'home com espaço');
    mkdirSync(spaced, { recursive: true });
    expect(await exec('install', {}, { home: spaced })).toBe(1);
    expect(existsSync(hooksFile(spaced))).toBe(false);
    expect(out.join('\n')).toContain('espaço');
  });

  it('sem o hook no repositório: erro e nada gravado', async () => {
    expect(await exec('install', {}, { hookPath: join(tmp.dir, 'nao-existe.mjs') })).toBe(1);
    expect(existsSync(HOOKS())).toBe(false);
  });
});

describe('antigravity-install: --dry-run (AG-13)', () => {
  it('mostra o plano e não grava nada, nem pasta', async () => {
    seed(OTHER);
    const before = readFileSync(HOOKS(), 'utf8');
    expect(await exec('install', { dryRun: true })).toBe(0);
    expect(readFileSync(HOOKS(), 'utf8')).toBe(before);
    expect(existsSync(join(home, '.habblaud'))).toBe(false);
    expect(backups(join(home, '.gemini', 'config'))).toHaveLength(0);
    expect(out.join('\n')).toContain('simulação');
  });

  it('sem nada instalado: não cria arquivo nenhum', async () => {
    await exec('install', { dryRun: true });
    expect(existsSync(join(home, '.gemini'))).toBe(false);
    expect(existsSync(join(home, '.habblaud'))).toBe(false);
  });

  it('o uninstall --dry-run também não remove nada', async () => {
    await exec('install');
    const before = readFileSync(HOOKS(), 'utf8');
    await exec('uninstall', { dryRun: true });
    expect(readFileSync(HOOKS(), 'utf8')).toBe(before);
    expect(existsSync(COPY())).toBe(true);
    expect(existsSync(CONFIG())).toBe(true);
  });
});

describe('antigravity-install: uninstall (AG-12)', () => {
  it('remove só o hook "habblaud" e os dois arquivos; o outro hook segue igual', async () => {
    seed(OTHER);
    await exec('install');
    expect(await exec('uninstall')).toBe(0);
    expect(readHooks()).toEqual(OTHER);
    expect(existsSync(COPY())).toBe(false);
    expect(existsSync(CONFIG())).toBe(false);
  });

  it('sem nada instalado: avisa, código 0, e não cria arquivo', async () => {
    expect(await exec('uninstall')).toBe(0);
    expect(existsSync(HOOKS())).toBe(false);
    expect(out.join('\n')).toContain('não estava registrado');
  });

  it('hooks.json inválido: não mexe, devolve 1 e MANTÉM a cópia e a configuração (o hook pode seguir registrado)', async () => {
    await exec('install');
    writeFileSync(HOOKS(), '{ quebrado');
    expect(await exec('uninstall')).toBe(1);
    expect(readFileSync(HOOKS(), 'utf8')).toBe('{ quebrado');
    expect(existsSync(COPY())).toBe(true);
    expect(existsSync(CONFIG())).toBe(true);
    expect(out.join('\n')).toContain('mantidos');
  });

  it('um hooks.json só com o hook do Habblaud vira {} (o arquivo fica)', async () => {
    await exec('install');
    await exec('uninstall');
    expect(readHooks()).toEqual({});
  });
});

describe('antigravity-install: status (AG-18)', () => {
  const health = (h: Health | undefined) => ({ health: async () => h });

  it('não grava nada e diz que não está registrado', async () => {
    seed(OTHER);
    const before = readFileSync(HOOKS(), 'utf8');
    expect(await exec('status', {}, health(undefined))).toBe(0);
    expect(readFileSync(HOOKS(), 'utf8')).toBe(before);
    expect(existsSync(join(home, '.habblaud'))).toBe(false);
    const text = out.join('\n');
    expect(text).toContain('não registrado');
    expect(text).toContain('fora do ar');
  });

  it('instalado e atualizado, com o Habblaud recebendo os eventos', async () => {
    await exec('install');
    out = [];
    await exec('status', {}, health({ antigravityEvents: true, antigravitySource: true }));
    const text = out.join('\n');
    expect(text).toContain('registrado');
    expect(text).toContain('instalado e atualizado');
    expect(text).toContain('recebendo os eventos do Antigravity');
    expect(text).toContain('1.3.3');
  });

  it('cópia desatualizada e hook diferente do esperado: avisa para rodar o install', async () => {
    await exec('install');
    writeFileSync(COPY(), '// velho');
    seed({ [HOOK_NAME]: { Stop: [{ type: 'command', command: 'echo outro' }] } });
    out = [];
    await exec('status', {}, health({ antigravityEvents: false }));
    const text = out.join('\n');
    expect(text.match(/npm run antigravity:install/g)).toHaveLength(2);
    expect(text).toContain('Antigravity desligado');
  });

  it('usa a porta gravada na configuração', async () => {
    await exec('install', { port: 4999 });
    let asked = 0;
    await exec('status', { port: 4747 }, { health: async (p) => ((asked = p), undefined) });
    expect(asked).toBe(4999);
  });
});

describe('antigravity-install: argumentos', () => {
  it('comando, --dry-run e --port', () => {
    expect(parseArgs(['install'], {})).toEqual({ command: 'install', dryRun: false, port: DEFAULT_PORT });
    expect(parseArgs(['uninstall', '--dry-run', '--port', '5000'], {})).toEqual({ command: 'uninstall', dryRun: true, port: 5000 });
    expect(parseArgs(['status'], { HABBLAUD_PORT: '4800' })).toMatchObject({ port: 4800 });
    expect(parseArgs(['--help'], {})).toBe('help');
  });

  it('sem comando, comando repetido, opção desconhecida ou porta ruim: erro', () => {
    expect(() => parseArgs([], {})).toThrow(/diga o que fazer/);
    expect(() => parseArgs(['install', 'status'], {})).toThrow(/opção desconhecida/);
    expect(() => parseArgs(['install', '--foo'], {})).toThrow(/opção desconhecida/);
    expect(() => parseArgs(['install', '--port', '0'], {})).toThrow(/--port/);
    expect(() => parseArgs(['install', '--port', 'abc'], {})).toThrow(/--port/);
  });
});
