// Plano de montagens e override do Compose do `npm run docker:up`: o que do host entra no container e onde, os
// metadados das contas que vão em HABBLAUD_ACCOUNTS e o texto do docker-compose.override.yml. São funções puras (a
// resolução dos caminhos reais é injetável), sem efeitos na carga; quem fala com o Docker e com o disco é o
// scripts/docker-up.ts, que reexporta tudo daqui.
import { realpathSync, statSync } from 'node:fs';
import { join, posix } from 'node:path';
import type { DetectedAccount } from '../server/accounts/detect';
import { HOOK_KEY_FILE } from '../server/codex/key';

/** Onde essa pasta aparece no container. */
export const CONTAINER_USAGE_DIR = '/usage';
const SERVICE = 'habblaud';
/** Raiz das montagens dentro do container: /claude/<conta>/{projects,sessions}. */
const CONTAINER_ROOT = '/claude';
/** Somente estas subpastas de cada conta entram no container. */
const MOUNTED_SUBDIRS = ['projects', 'sessions'] as const;
/** Raiz das montagens do Codex dentro do container: /codex/<conta>/{sessions,archived_sessions,thread-writer-locks,session_index.jsonl}. */
const CODEX_CONTAINER_ROOT = '/codex';
/**
 * Somente estas subpastas de cada pasta do Codex entram no container (as conversas e os locks das sessões abertas).
 * auth.json, config.toml, shell_snapshots/, history.jsonl, logs e os SQLite ficam no host.
 */
export const CODEX_MOUNTED_SUBDIRS = ['sessions', 'archived_sessions', 'thread-writer-locks'] as const;
/**
 * E estes arquivos, só se forem arquivos comuns: o índice com os títulos das threads. A montagem de arquivo único fica
 * presa ao inode: se o Codex reescrever o índice inteiro (ao apagar uma thread), o container segue com o antigo até o
 * próximo docker:up (o servidor tolera título ausente ou desatualizado).
 */
export const CODEX_MOUNTED_FILES = ['session_index.jsonl'] as const;
/**
 * Onde a chave local do hook do Codex (server/codex/key.ts) aparece no container. O nome do arquivo tem de ser o
 * HOOK_KEY_FILE: o servidor lê a pasta de HABBLAUD_CODEX_HOOK_KEY com loadHookKey.
 */
export const CONTAINER_HOOK_KEY = posix.join('/keys', HOOK_KEY_FILE);

export interface BindMount {
  /** Caminho real no host (symlinks resolvidos: o Docker Desktop não os segue). */
  source: string;
  /** Caminho dentro do container. */
  target: string;
}

export interface AccountMount {
  account: DetectedAccount;
  /** Config dir da conta no host. */
  hostDir: string;
  /** Onde a conta aparece no container: /claude/<id>. */
  mountDir: string;
  binds: BindMount[];
}

/** Janelas de uso que o servidor exibe (as demais chaves do cache são ignoradas). */
const USAGE_WINDOWS = ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet'] as const;

type CachedWindow = { utilization: unknown; resets_at?: unknown };
type CachedUsage = { fetchedAtMs: unknown; utilization: Partial<Record<(typeof USAGE_WINDOWS)[number], CachedWindow>> };

export interface AccountPayload {
  id: string;
  /** Só nas contas do Codex (ausente = Claude Code). */
  provider?: 'codex';
  configDir: string;
  mountDir: string;
  short: string;
  name: string;
  email?: string;
  organization?: string;
  plan?: string;
  color: string;
  cachedUsage?: CachedUsage;
}

/** Caminho real de uma pasta existente, ou undefined. */
export function realDir(p: string): string | undefined {
  try {
    const real = realpathSync(p);
    return statSync(real).isDirectory() ? real : undefined;
  } catch {
    return undefined;
  }
}

/** Caminho real de um arquivo comum existente, ou undefined. */
export function realFile(p: string): string | undefined {
  try {
    const real = realpathSync(p);
    return statSync(real).isFile() ? real : undefined;
  } catch {
    return undefined;
  }
}

/** Caminho real de uma pasta (`dir`) ou de um arquivo comum (`file`) existente, ou undefined. */
function realPath(p: string, kind: 'dir' | 'file'): string | undefined {
  return kind === 'dir' ? realDir(p) : realFile(p);
}

/**
 * Monta só projects/ e sessions/ de cada conta (as que existirem). `accounts` vem de
 * detectAccounts(dirs) e está na mesma ordem de `dirs`; o id (basename desambiguado) vira o
 * nome da pasta no container, então o servidor lá dentro deriva exatamente o mesmo id.
 */
export function planMounts(dirs: string[], accounts: DetectedAccount[], resolveDir: (p: string) => string | undefined = realDir): AccountMount[] {
  const out: AccountMount[] = [];
  dirs.forEach((hostDir, i) => {
    const account = accounts[i];
    const mountDir = posix.join(CONTAINER_ROOT, account.id);
    const binds: BindMount[] = [];
    for (const sub of MOUNTED_SUBDIRS) {
      const source = resolveDir(join(hostDir, sub));
      if (source) binds.push({ source, target: posix.join(mountDir, sub) });
    }
    if (binds.length) out.push({ account, hostDir, mountDir, binds });
  });
  return out;
}

/**
 * Monta só sessions/, archived_sessions/ e thread-writer-locks/ (pastas) e session_index.jsonl (arquivo comum) de cada
 * pasta do Codex, os que existirem, em /codex/<id>; a pasta sem sessions/ fica de fora (sem conversas, nada a mostrar).
 * `accounts` vem de detectCodexAccounts(dirs), na mesma ordem de `dirs`; o id vira o nome da pasta no container, então
 * o servidor lá dentro deriva o mesmo id.
 */
export function planCodexMounts(
  dirs: string[],
  accounts: DetectedAccount[],
  resolvePath: (p: string, kind: 'dir' | 'file') => string | undefined = realPath,
): AccountMount[] {
  const out: AccountMount[] = [];
  dirs.forEach((hostDir, i) => {
    const account = accounts[i];
    const mountDir = posix.join(CODEX_CONTAINER_ROOT, account.id);
    const binds: BindMount[] = [];
    const add = (name: string, kind: 'dir' | 'file') => {
      const source = resolvePath(join(hostDir, name), kind);
      if (source) binds.push({ source, target: posix.join(mountDir, name) });
    };
    for (const sub of CODEX_MOUNTED_SUBDIRS) add(sub, 'dir');
    for (const file of CODEX_MOUNTED_FILES) add(file, 'file');
    if (binds.some((b) => b.target === posix.join(mountDir, 'sessions'))) out.push({ account, hostDir, mountDir, binds });
  });
  return out;
}

/** Metadados das contas do Codex para HABBLAUD_ACCOUNTS: `provider: 'codex'` e a pasta do HOST em `configDir`. */
export function codexAccountsPayload(mounts: AccountMount[]): AccountPayload[] {
  return mounts.map(({ account: a, hostDir, mountDir }) => {
    const p: AccountPayload = { id: a.id, provider: 'codex', configDir: hostDir, mountDir, short: a.short, name: a.name, color: a.color };
    if (a.plan) p.plan = a.plan;
    return p;
  });
}

/**
 * Do cache de uso do Claude Code (`cachedUsageUtilization`) só seguem a data da coleta e, de
 * cada janela exibida, o percentual e o horário de reinício. Identificadores da conta, gastos e
 * demais campos ficam de fora (o ambiente do container é visível em `docker inspect`).
 */
export function sanitizeCachedUsage(raw: unknown): CachedUsage | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const c = raw as Record<string, unknown>;
  const fetchedAtMs = c.fetchedAtMs ?? c.fetchedAt;
  if (fetchedAtMs === undefined || !c.utilization || typeof c.utilization !== 'object') return undefined;
  const util = c.utilization as Record<string, unknown>;
  const out: CachedUsage = { fetchedAtMs, utilization: {} };
  for (const key of USAGE_WINDOWS) {
    const w = util[key];
    if (!w || typeof w !== 'object') continue;
    const { utilization, resets_at } = w as Record<string, unknown>;
    if (utilization === undefined || utilization === null) continue;
    out.utilization[key] = resets_at === undefined || resets_at === null ? { utilization } : { utilization, resets_at };
  }
  return Object.keys(out.utilization).length ? out : undefined;
}

/** Metadados das contas para HABBLAUD_ACCOUNTS (o container não enxerga o .claude.json do host). */
export function accountsPayload(mounts: AccountMount[]): AccountPayload[] {
  return mounts.map(({ account: a, mountDir }) => {
    const p: AccountPayload = { id: a.id, configDir: a.configDir, mountDir, short: a.short, name: a.name, color: a.color };
    if (a.email) p.email = a.email;
    if (a.organization) p.organization = a.organization;
    if (a.plan) p.plan = a.plan;
    const cached = sanitizeCachedUsage(a.cachedUsage);
    if (cached) p.cachedUsage = cached;
    return p;
  });
}

/**
 * Escalar YAML seguro: string JSON (válida como string YAML entre aspas duplas) com `$`
 * duplicado, para o Compose não tentar interpolar variáveis dentro dos valores.
 */
export function yamlString(value: string): string {
  return JSON.stringify(value.replaceAll('$', '$$$$'));
}

/**
 * Fuso horário do host (TZ ou o do sistema), para o container: sem ele o Node do container usa UTC e
 * o "dia" do timelapse e do painel do dia viraria às 21h no horário de Brasília. Undefined se inválido.
 */
export function hostTimeZone(env: NodeJS.ProcessEnv = process.env): string | undefined {
  let tz = env.TZ?.trim().replace(/^:/, '');
  if (!tz) {
    try {
      tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch {
      return undefined;
    }
  }
  return tz && /^[A-Za-z0-9_+\-]+(?:\/[A-Za-z0-9_+\-]+)*$/.test(tz) ? tz : undefined;
}

/**
 * `usageDir`: pasta do host com o uso capturado pelo tap de statusline (já existente; caminho real),
 * montada somente leitura em /usage. `timeZone`: fuso do host, repassado como TZ. `codex`: montagens das contas do
 * Codex (planCodexMounts). `hookKey`: caminho real, no host, da chave local do hook do Codex (só o arquivo), montada
 * somente leitura em /keys/codex-hook.key, com esse caminho em HABBLAUD_CODEX_HOOK_KEY.
 */
export function renderOverride(
  mounts: AccountMount[],
  generatedAt: Date = new Date(),
  usageDir?: string,
  timeZone?: string,
  codex: AccountMount[] = [],
  hookKey?: string,
): string {
  const env: Array<[string, string]> = [
    ['HABBLAUD_CLAUDE_DIRS', mounts.map((m) => m.mountDir).join(',')],
    ['HABBLAUD_ACCOUNTS', JSON.stringify([...accountsPayload(mounts), ...codexAccountsPayload(codex)])],
  ];
  if (codex.length) env.push(['HABBLAUD_CODEX_DIRS', codex.map((m) => m.mountDir).join(',')]);
  if (hookKey) env.push(['HABBLAUD_CODEX_HOOK_KEY', CONTAINER_HOOK_KEY]);
  if (usageDir) env.push(['HABBLAUD_USAGE_DIR', CONTAINER_USAGE_DIR]);
  if (timeZone) env.push(['TZ', timeZone]);
  const lines = [
    `# Gerado por scripts/docker-up.ts em ${generatedAt.toISOString()} — não edite: é recriado a cada \`npm run docker:up\`.`,
    '# Contém caminhos do host e e-mails das contas: fica fora do git e com permissão 600.',
    '# Montagens: SOMENTE <conta>/projects, <conta>/sessions e a pasta do uso do statusline, todas somente leitura.',
    ...(codex.length
      ? ['# Codex: SOMENTE <pasta>/sessions, <pasta>/archived_sessions, <pasta>/thread-writer-locks e <pasta>/session_index.jsonl, somente leitura.']
      : []),
    ...(hookKey ? ['# Chave do hook do Codex: SOMENTE o arquivo ~/.habblaud/codex-hook.key, somente leitura.'] : []),
    'services:',
    `  ${SERVICE}:`,
    '    environment:',
    ...env.map(([k, v]) => `      ${k}: ${yamlString(v)}`),
  ];
  const binds = [...mounts, ...codex].flatMap((m) => m.binds);
  if (hookKey) binds.push({ source: hookKey, target: CONTAINER_HOOK_KEY });
  if (usageDir) binds.push({ source: usageDir, target: CONTAINER_USAGE_DIR });
  if (binds.length) {
    lines.push('    volumes:');
    for (const b of binds) {
      lines.push(
        '      - type: bind',
        `        source: ${yamlString(b.source)}`,
        `        target: ${yamlString(b.target)}`,
        '        read_only: true',
        '        bind:',
        '          create_host_path: false',
      );
    }
  }
  return `${lines.join('\n')}\n`;
}
