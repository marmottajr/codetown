// Funções puras de scripts/docker-up.ts (importar o módulo não sobe nada).
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DetectedAccount } from '../accounts/detect';
import { legacyEnvWarning } from '../legacy';
import {
  accountsPayload,
  CODEX_MOUNTED_FILES,
  CODEX_MOUNTED_SUBDIRS,
  codexAccountsPayload,
  codexDisabled,
  copyVolumeArgs,
  type DockerState,
  envFileKeys,
  envFileValue,
  hostTimeZone,
  parseArgs,
  planCodexMounts,
  planMounts,
  planUp,
  renderOverride,
  sanitizeCachedUsage,
  yamlString,
} from '../../scripts/docker-up';
import { tempDir } from './fixtures';

const ROOT = join(import.meta.dirname, '..', '..');

const acc = (id: string, extra: Partial<DetectedAccount> = {}): DetectedAccount => ({
  id,
  configDir: `/Users/fulano/${id}`,
  short: id === '.claude' ? 'C' : 'D',
  name: id === '.claude' ? 'Conta C' : 'Conta D',
  color: '#000000',
  ...extra,
});

/** Os caminhos do host aqui são escritos com `/`; no Windows, o join do planMounts os devolve com `\`. */
const slash = (p: string) => p.replaceAll('\\', '/');

describe('docker-up', () => {
  it('argumentos', () => {
    expect(parseArgs([])).toEqual({ down: false, build: true, help: false });
    expect(parseArgs(['--no-build'])).toEqual({ down: false, build: false, help: false });
    expect(parseArgs(['--down'])).toMatchObject({ down: true });
    expect(() => parseArgs(['--xyz'])).toThrow(/opção desconhecida/);
  });

  it('monta só projects/ e sessions/ que existem', () => {
    const dirs = ['/Users/fulano/.claude', '/Users/fulano/.claude-conta2'];
    const exists = new Set(['/Users/fulano/.claude/projects', '/Users/fulano/.claude/sessions', '/Users/fulano/.claude-conta2/sessions']);
    const mounts = planMounts(dirs, [acc('.claude'), acc('.claude-conta2')], (p) => (exists.has(slash(p)) ? `/real${slash(p)}` : undefined));
    expect(mounts.map((m) => m.binds)).toEqual([
      [
        { source: '/real/Users/fulano/.claude/projects', target: '/claude/.claude/projects' },
        { source: '/real/Users/fulano/.claude/sessions', target: '/claude/.claude/sessions' },
      ],
      [{ source: '/real/Users/fulano/.claude-conta2/sessions', target: '/claude/.claude-conta2/sessions' }],
    ]);
  });

  it('cache de uso: só data e percentuais/reinícios das janelas exibidas', () => {
    expect(sanitizeCachedUsage(null)).toBeUndefined();
    expect(
      sanitizeCachedUsage({
        fetchedAtMs: 5,
        accountUuid: 'nao',
        utilization: { five_hour: { utilization: 10, resets_at: null }, seven_day: { utilization: 20, resets_at: 'x' }, extra_usage: { monthly_limit: 99 } },
      }),
    ).toEqual({ fetchedAtMs: 5, utilization: { five_hour: { utilization: 10 }, seven_day: { utilization: 20, resets_at: 'x' } } });
  });

  it('override: somente leitura, sem criar pastas no host, `$` escapado e a pasta do statusline em /usage', () => {
    const mounts = planMounts(['/Users/fu$lano/.claude'], [acc('.claude', { email: 'a@b.c', cachedUsage: { fetchedAtMs: 1, utilization: {} } })], slash);
    const yml = renderOverride(mounts, new Date('2026-10-06T00:00:00Z'), '/Users/fulano/.habblaud/usage');
    expect(yml).toContain('source: "/Users/fu$$lano/.claude/projects"');
    expect(yml).toContain('HABBLAUD_USAGE_DIR: "/usage"');
    expect(yml).toContain('source: "/Users/fulano/.habblaud/usage"\n        target: "/usage"\n        read_only: true');
    const binds = yml.split('- type: bind').length - 1;
    expect(binds).toBe(3);
    expect(yml.match(/read_only: true/g)).toHaveLength(3);
    expect(yml.match(/create_host_path: false/g)).toHaveLength(3);
    // Payload das contas: sem cache vazio, sem campos que não existem.
    expect(accountsPayload(mounts)).toEqual([{ id: '.claude', configDir: '/Users/fulano/.claude', mountDir: '/claude/.claude', short: 'C', name: 'Conta C', color: '#000000', email: 'a@b.c' }]);
    // Sem a pasta do statusline: nada de /usage.
    expect(renderOverride(mounts)).not.toContain('/usage');
    expect(yamlString('a"b$c')).toBe('"a\\"b$$c"');
  });

  it('Codex: monta SÓ sessions/, archived_sessions/ e thread-writer-locks/ (somente leitura) e passa as contas com a pasta do host', () => {
    expect([...CODEX_MOUNTED_SUBDIRS]).toEqual(['sessions', 'archived_sessions', 'thread-writer-locks']);
    const host = '/Users/fulano/.codex';
    // Existem no host também auth.json, config.toml, history.jsonl, shell_snapshots/, logs e SQLite: nada disso entra.
    const exists = new Set([`${host}/sessions`, `${host}/thread-writer-locks`, `${host}/auth.json`, `${host}/config.toml`, `${host}/shell_snapshots`, `${host}/history.jsonl`]);
    const codexAcc: DetectedAccount = { id: '.codex', provider: 'codex', configDir: host, short: 'CX', name: 'Codex', color: '#5cc97b', plan: 'Plus' };
    const codex = planCodexMounts([host, '/Users/fulano/.codex-vazia'], [codexAcc, { ...codexAcc, id: '.codex-vazia' }], (p) => (exists.has(slash(p)) ? `/real${slash(p)}` : undefined));
    expect(codex.map((m) => m.binds)).toEqual([
      [
        { source: `/real${host}/sessions`, target: '/codex/.codex/sessions' },
        { source: `/real${host}/thread-writer-locks`, target: '/codex/.codex/thread-writer-locks' },
      ],
    ]);
    expect(codexAccountsPayload(codex)).toEqual([
      { id: '.codex', provider: 'codex', configDir: host, mountDir: '/codex/.codex', short: 'CX', name: 'Codex', color: '#5cc97b', plan: 'Plus' },
    ]);
    const claude = planMounts(['/Users/fulano/.claude'], [acc('.claude')], slash);
    const yml = renderOverride(claude, new Date(0), undefined, undefined, codex);
    expect(yml).toContain('HABBLAUD_CODEX_DIRS: "/codex/.codex"');
    expect(yml).toContain(`source: "/real${host}/thread-writer-locks"\n        target: "/codex/.codex/thread-writer-locks"\n        read_only: true`);
    expect(yml.match(/read_only: true/g)).toHaveLength(4);
    for (const secret of ['auth.json', 'config.toml', 'history.jsonl', 'shell_snapshots', 'sqlite', 'logs_']) expect(yml).not.toContain(secret);
    const accounts = JSON.parse(JSON.parse(/HABBLAUD_ACCOUNTS: (".*")/.exec(yml)![1]) as string) as Array<Record<string, unknown>>;
    expect(accounts.map((a) => [a.id, a.provider, a.configDir])).toEqual([
      ['.claude', undefined, '/Users/fulano/.claude'],
      ['.codex', 'codex', host],
    ]);
    // Sem Codex: nada de HABBLAUD_CODEX_DIRS.
    expect(renderOverride(claude)).not.toContain('HABBLAUD_CODEX_DIRS');
    expect(codexDisabled({ HABBLAUD_CODEX: '0' })).toBe(true);
    expect(codexDisabled({ HABBLAUD_CODEX: 'off' })).toBe(true);
    expect(codexDisabled({ HABBLAUD_CODEX: '1' })).toBe(false);
    expect(codexDisabled({})).toBe(false);
  });

  it('fuso do host vai para o container como TZ', () => {
    const mounts = planMounts(['/Users/fulano/.claude'], [acc('.claude')], slash);
    expect(renderOverride(mounts, new Date(0), undefined, 'America/Sao_Paulo')).toContain('TZ: "America/Sao_Paulo"');
    expect(renderOverride(mounts)).not.toContain('TZ:');
    expect(hostTimeZone({ TZ: 'America/Sao_Paulo' })).toBe('America/Sao_Paulo');
    expect(hostTimeZone({ TZ: ':Europe/Lisbon' })).toBe('Europe/Lisbon');
    expect(hostTimeZone({ TZ: 'x"; rm -rf' })).toBeUndefined();
    expect(hostTimeZone({})).toMatch(/^[A-Za-z]/);
  });
});

describe('docker-up: migração do nome antigo (CodeTown)', () => {
  const none: DockerState = { legacyContainer: false, legacyNetwork: false, legacyVolume: false, legacyImage: false, dataVolume: false };
  const upBuild = { kind: 'compose', args: ['up', '-d', '--build'] };

  it('sem nada do CodeTown: só o compose up de sempre', () => {
    expect(planUp(none, true)).toEqual({ steps: [upBuild], cleanup: [] });
    expect(planUp(none, false)).toEqual({ steps: [{ kind: 'compose', args: ['up', '-d'] }], cleanup: [] });
  });

  it('primeira subida depois do rename: tira container e rede, o Compose cria o volume e os dados são copiados', () => {
    const plan = planUp({ legacyContainer: true, legacyNetwork: true, legacyVolume: true, legacyImage: true, dataVolume: false }, true);
    expect(plan.steps).toEqual([
      { kind: 'remove-container', name: 'codetown' },
      { kind: 'remove-network', name: 'codetown_default' },
      { kind: 'compose', args: ['up', '--no-start', '--build'] },
      { kind: 'copy-volume', from: 'codetown_codetown-data', to: 'habblaud_habblaud-data' },
      { kind: 'compose', args: ['up', '-d'] },
    ]);
    // O volume antigo nunca é apagado: só vira dica no fim, junto com a imagem.
    expect(plan.cleanup).toEqual(['docker volume rm codetown_codetown-data', 'docker image rm codetown:local']);
  });

  it('--no-build e container antigo já derrubado: cria parado sem reconstruir, copia e sobe', () => {
    expect(planUp({ ...none, legacyVolume: true }, false)).toEqual({
      steps: [
        { kind: 'compose', args: ['up', '--no-start'] },
        { kind: 'copy-volume', from: 'codetown_codetown-data', to: 'habblaud_habblaud-data' },
        { kind: 'compose', args: ['up', '-d'] },
      ],
      cleanup: ['docker volume rm codetown_codetown-data'],
    });
  });

  it('volume novo já existe: não copia por cima', () => {
    // Já migrado antes: o volume antigo ficou, mas não há o que fazer nem lembrar.
    expect(planUp({ ...none, legacyVolume: true, legacyImage: true, dataVolume: true }, true)).toEqual({ steps: [upBuild], cleanup: [] });
    // Container antigo de pé com os dois volumes: sai o container, sem cópia.
    expect(planUp({ ...none, legacyContainer: true, legacyVolume: true, dataVolume: true }, true)).toEqual({
      steps: [{ kind: 'remove-container', name: 'codetown' }, upBuild],
      cleanup: ['docker volume rm codetown_codetown-data'],
    });
  });

  it('sobra só a rede ou a imagem: tira a rede, sem dica', () => {
    expect(planUp({ ...none, legacyNetwork: true, legacyImage: true }, true)).toEqual({
      steps: [{ kind: 'remove-network', name: 'codetown_default' }, upBuild],
      cleanup: [],
    });
  });

  it('cópia: imagem do Habblaud como root, sem rede, volume antigo só leitura', () => {
    const args = copyVolumeArgs('velho', 'novo');
    expect(args[0]).toBe('run');
    expect(args).toContain('--rm');
    expect(args.join(' ')).toContain('--user 0:0 --entrypoint sh');
    expect(args.join(' ')).toContain('--network none');
    expect(args.join(' ')).toContain('-v velho:/from:ro -v novo:/to habblaud:local -c ');
    const script = args.at(-1)!;
    expect(script).toMatch(/^set -e; cp -a \/from\/\. \/to\/;/);
    expect(script).toContain('chown "$(stat -c %u:%g /from)" /to');
  });

  it('.env: só os nomes das variáveis, nunca os valores', () => {
    const text = [
      '# CODETOWN_COMENTADA=1',
      'CODETOWN_BIND=0.0.0.0',
      '  export CODETOWN_PORT = 4848',
      'HABBLAUD_DEMO=1',
      '',
      'SEM_IGUAL',
      '1INVALIDA=x',
      'SEGREDO=CODETOWN_X=y\r',
    ].join('\n');
    const keys = envFileKeys(text);
    expect(keys).toEqual(['CODETOWN_BIND', 'CODETOWN_PORT', 'HABBLAUD_DEMO', 'SEGREDO']);
    const msg = legacyEnvWarning(keys, 'no .env');
    expect(msg).toBe('variáveis do nome antigo ignoradas no .env: CODETOWN_BIND → HABBLAUD_BIND, CODETOWN_PORT → HABBLAUD_PORT. Renomeie para valer de novo.');
    expect(msg).not.toContain('0.0.0.0');
    expect(envFileKeys('')).toEqual([]);
  });
});

describe('docker-up: Codex — índice das sessões, conta sem sessions/ e HABBLAUD_CODEX no .env', () => {
  const codex = (id: string): DetectedAccount => ({ id, provider: 'codex', configDir: `/Users/fulano/${id}`, short: 'CX', name: 'Codex', color: '#5cc97b' });

  it('monta também o session_index.jsonl (pedido como arquivo), depois das pastas e somente leitura', () => {
    expect([...CODEX_MOUNTED_FILES]).toEqual(['session_index.jsonl']);
    const host = '/Users/fulano/.codex';
    const exists = new Set(['sessions', 'archived_sessions', 'thread-writer-locks', 'session_index.jsonl', 'config.toml', 'history.jsonl'].map((n) => `${host}/${n}`));
    const asked: string[] = [];
    const resolve = (p: string, kind: 'dir' | 'file') => {
      asked.push(`${posix.basename(slash(p))}:${kind}`);
      return exists.has(slash(p)) ? `/real${slash(p)}` : undefined;
    };
    const mounts = planCodexMounts([host], [codex('.codex')], resolve);
    expect(asked).toEqual(['sessions:dir', 'archived_sessions:dir', 'thread-writer-locks:dir', 'session_index.jsonl:file']);
    expect(mounts.map((m) => m.binds)).toEqual([
      [
        { source: `/real${host}/sessions`, target: '/codex/.codex/sessions' },
        { source: `/real${host}/archived_sessions`, target: '/codex/.codex/archived_sessions' },
        { source: `/real${host}/thread-writer-locks`, target: '/codex/.codex/thread-writer-locks' },
        { source: `/real${host}/session_index.jsonl`, target: '/codex/.codex/session_index.jsonl' },
      ],
    ]);
    const yml = renderOverride([], new Date(0), undefined, undefined, mounts);
    expect(yml).toContain(`source: "/real${host}/session_index.jsonl"\n        target: "/codex/.codex/session_index.jsonl"\n        read_only: true`);
    expect(yml.match(/read_only: true/g)).toHaveLength(4);
    expect(yml.match(/create_host_path: false/g)).toHaveLength(4);
    // Nunca a pasta inteira da conta nem o que mais existe nela.
    expect(yml).not.toContain('target: "/codex/.codex"\n');
    for (const other of ['config.toml', 'history.jsonl']) expect(yml).not.toContain(other);
  });

  it('pasta do Codex sem sessions/ fica de fora, mesmo com locks, arquivados e índice', () => {
    const a = '/Users/fulano/.codex';
    const b = '/Users/fulano/.codex-sem-sessions';
    const exists = new Set([`${a}/sessions`, `${b}/thread-writer-locks`, `${b}/archived_sessions`, `${b}/session_index.jsonl`]);
    const mounts = planCodexMounts([a, b], [codex('.codex'), codex('.codex-sem-sessions')], (p) => (exists.has(slash(p)) ? slash(p) : undefined));
    expect(mounts.map((m) => m.account.id)).toEqual(['.codex']);
    expect(codexAccountsPayload(mounts).map((p) => p.id)).toEqual(['.codex']);
    const yml = renderOverride([], new Date(0), undefined, undefined, mounts);
    expect(yml).toContain('HABBLAUD_CODEX_DIRS: "/codex/.codex"\n');
    expect(yml).not.toContain('.codex-sem-sessions');
  });

  it('no disco: o índice entra só se for arquivo comum, e as pastas só se forem pastas', () => {
    const tmp = tempDir();
    try {
      const h = join(tmp.dir, '.codex');
      mkdirSync(join(h, 'sessions', '2026', '01', '15'), { recursive: true });
      mkdirSync(join(h, 'thread-writer-locks'));
      writeFileSync(join(h, 'session_index.jsonl'), '');
      writeFileSync(join(h, 'config.toml'), '');
      // archived_sessions como arquivo (não pasta): não entra.
      writeFileSync(join(h, 'archived_sessions'), '');
      const [m] = planCodexMounts([h], [codex('.codex')]);
      expect(m.binds).toEqual([
        { source: realpathSync(join(h, 'sessions')), target: '/codex/.codex/sessions' },
        { source: realpathSync(join(h, 'thread-writer-locks')), target: '/codex/.codex/thread-writer-locks' },
        { source: realpathSync(join(h, 'session_index.jsonl')), target: '/codex/.codex/session_index.jsonl' },
      ]);
      // session_index.jsonl que é pasta também não entra.
      const h2 = join(tmp.dir, '.codex-2');
      mkdirSync(join(h2, 'sessions'), { recursive: true });
      mkdirSync(join(h2, 'session_index.jsonl'));
      expect(planCodexMounts([h2], [codex('.codex-2')]).map((x) => x.binds.map((b) => b.target))).toEqual([['/codex/.codex-2/sessions']]);
      // Sem sessions/ no disco: a conta fica de fora.
      const h3 = join(tmp.dir, '.codex-3');
      mkdirSync(join(h3, 'thread-writer-locks'), { recursive: true });
      writeFileSync(join(h3, 'session_index.jsonl'), '');
      expect(planCodexMounts([h3], [codex('.codex-3')])).toEqual([]);
    } finally {
      tmp.cleanup();
    }
  });

  it('.env: o valor de uma variável como o Compose lê (export, aspas, comentário, CRLF, BOM; a última vale)', () => {
    expect(envFileValue('HABBLAUD_CODEX=0', 'HABBLAUD_CODEX')).toBe('0');
    expect(envFileValue('\uFEFFHABBLAUD_CODEX=0\r\nHABBLAUD_DEMO=1\r\n', 'HABBLAUD_CODEX')).toBe('0');
    expect(envFileValue('  export HABBLAUD_CODEX = off  ', 'HABBLAUD_CODEX')).toBe('off');
    expect(envFileValue('HABBLAUD_CODEX="0"', 'HABBLAUD_CODEX')).toBe('0');
    expect(envFileValue("HABBLAUD_CODEX='0' # sem Codex", 'HABBLAUD_CODEX')).toBe('0');
    expect(envFileValue('HABBLAUD_CODEX="a # b"', 'HABBLAUD_CODEX')).toBe('a # b');
    expect(envFileValue('HABBLAUD_CODEX=0 # sem Codex', 'HABBLAUD_CODEX')).toBe('0');
    // Sem um espaço logo antes do #, não é comentário (regra do Compose; tabulação não conta).
    expect(envFileValue('HABBLAUD_CODEX=0#x', 'HABBLAUD_CODEX')).toBe('0#x');
    expect(envFileValue('HABBLAUD_CODEX=1 \t# x', 'HABBLAUD_CODEX')).toBe('1 \t# x');
    // O Compose também aceita `NOME: valor`.
    expect(envFileValue('HABBLAUD_CODEX: 0', 'HABBLAUD_CODEX')).toBe('0');
    expect(envFileValue('HABBLAUD_CODEX:off', 'HABBLAUD_CODEX')).toBe('off');
    expect(envFileValue('HABBLAUD_CODEX=', 'HABBLAUD_CODEX')).toBe('');
    expect(envFileValue('HABBLAUD_CODEX=0\nHABBLAUD_CODEX=1', 'HABBLAUD_CODEX')).toBe('1');
    expect(envFileValue('# HABBLAUD_CODEX=0', 'HABBLAUD_CODEX')).toBeUndefined();
    expect(envFileValue('HABBLAUD_CODEX_DIRS=/x\nX_HABBLAUD_CODEX=0', 'HABBLAUD_CODEX')).toBeUndefined();
    expect(envFileValue('', 'HABBLAUD_CODEX')).toBeUndefined();
  });

  it('HABBLAUD_CODEX=0 só no .env também desliga o Codex; o ambiente vence o .env, como no Compose', () => {
    expect(codexDisabled({}, 'HABBLAUD_CODEX=0\n')).toBe(true);
    expect(codexDisabled({}, '\uFEFFHABBLAUD_DEMO=1\r\nHABBLAUD_CODEX=off # sem Codex\r\n')).toBe(true);
    expect(codexDisabled({}, 'HABBLAUD_CODEX: 0')).toBe(true);
    expect(codexDisabled({}, 'HABBLAUD_CODEX=1 \t# x')).toBe(true);
    expect(codexDisabled({}, 'HABBLAUD_CODEX=1')).toBe(false);
    expect(codexDisabled({}, 'HABBLAUD_CODEX=')).toBe(false);
    expect(codexDisabled({}, '# HABBLAUD_CODEX=0')).toBe(false);
    expect(codexDisabled({}, '')).toBe(false);
    expect(codexDisabled({}, undefined)).toBe(false);
    // O docker-up repassa o process.env ao Compose, e o Compose dá preferência ao ambiente sobre o .env.
    expect(codexDisabled({ HABBLAUD_CODEX: '1' }, 'HABBLAUD_CODEX=0')).toBe(false);
    expect(codexDisabled({ HABBLAUD_CODEX: '0' }, 'HABBLAUD_CODEX=1')).toBe(true);
    // Definida e vazia no ambiente também vence o .env (no Compose, o container recebe "").
    expect(codexDisabled({ HABBLAUD_CODEX: '' }, 'HABBLAUD_CODEX=0')).toBe(false);
  });

  it('docker-compose.yml repassa HABBLAUD_CODEX (do ambiente ou do .env) ao servidor no container', () => {
    const yml = readFileSync(join(ROOT, 'docker-compose.yml'), 'utf8');
    expect(yml).toMatch(/^ {6}HABBLAUD_CODEX: \$\{HABBLAUD_CODEX:-\}\r?$/m);
  });
});

describe('docker-up: chave local do hook do Codex', () => {
  const codex = planCodexMounts(['/Users/fulano/.codex'], [{ id: '.codex', provider: 'codex', configDir: '/Users/fulano/.codex', short: 'CX', name: 'Codex', color: '#5cc97b' }], (p, kind) =>
    kind === 'dir' && slash(p).endsWith('/sessions') ? slash(p) : undefined,
  );

  it('monta SÓ o arquivo da chave, somente leitura e sem criar nada no host, em /keys/codex-hook.key, e passa o caminho em HABBLAUD_CODEX_HOOK_KEY', () => {
    const yml = renderOverride([], new Date(0), undefined, undefined, codex, '/Users/fu$lano/.habblaud/codex-hook.key');
    expect(yml).toContain('HABBLAUD_CODEX_HOOK_KEY: "/keys/codex-hook.key"');
    expect(yml).toContain(
      '      - type: bind\n        source: "/Users/fu$$lano/.habblaud/codex-hook.key"\n        target: "/keys/codex-hook.key"\n        read_only: true\n        bind:\n          create_host_path: false',
    );
    expect(yml.match(/read_only: true/g)).toHaveLength(2);
    expect(yml.match(/create_host_path: false/g)).toHaveLength(2);
    // Nunca a pasta ~/.habblaud inteira (lá ficam nomes, uso e linha do tempo).
    expect(yml).not.toContain('source: "/Users/fu$$lano/.habblaud"');
  });

  it('sem a chave (Codex desligado, sem contas do Codex ou falha ao criar): nada de chave no override', () => {
    for (const yml of [renderOverride([], new Date(0), undefined, undefined, codex), renderOverride([], new Date(0))]) {
      expect(yml).not.toContain('HABBLAUD_CODEX_HOOK_KEY');
      expect(yml).not.toContain('codex-hook.key');
    }
  });
});
