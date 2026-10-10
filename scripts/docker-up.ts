// Sobe (ou derruba) o Habblaud no Docker local. Roda no HOST, com tsx:
//
//   npm run docker:up                 # detecta as contas, gera o override, constrói e sobe
//   npm run docker:up -- --no-build   # sobe sem reconstruir a imagem
//   npm run docker:down               # derruba o container
//
// O que ele faz ao subir:
// 1. Descobre os config dirs do Claude Code no host (mesma regra do servidor: ~/.claude*,
//    CLAUDE_CONFIG_DIR ou HABBLAUD_CLAUDE_DIRS) e lê os metadados das contas com detectAccounts.
// 2. Gera o docker-compose.override.yml montando SOMENTE <conta>/projects e <conta>/sessions,
//    somente leitura, em /claude/<conta>/... — nunca a pasta inteira da conta, onde ficam
//    credenciais e configurações — e a pasta do uso capturado pelo statusline
//    (~/.habblaud/usage, criada se faltar) em /usage, também somente leitura. Passa
//    HABBLAUD_CLAUDE_DIRS, HABBLAUD_ACCOUNTS, HABBLAUD_USAGE_DIR e o fuso do host (TZ) ao container.
//    Contas do Codex (~/.codex*, CODEX_HOME ou HABBLAUD_CODEX_DIRS; HABBLAUD_CODEX=0 no ambiente ou só no .env
//    desliga): SOMENTE sessions/, archived_sessions/, thread-writer-locks/ e o arquivo session_index.jsonl de cada
//    uma (os que existirem; a pasta sem sessions/ fica de fora), somente leitura, em /codex/<conta>/... — nunca
//    auth.json, config.toml, shell_snapshots/, history.jsonl, logs nem os SQLite. Vão em HABBLAUD_CODEX_DIRS
//    e, com `provider: 'codex'` e a pasta do HOST (onde o `codex queue` roda), em HABBLAUD_ACCOUNTS. Com alguma conta
//    do Codex montada, também a chave local do hook do Codex (~/.habblaud/codex-hook.key, criada se faltar; só o
//    arquivo, somente leitura) em /keys/codex-hook.key, com o caminho em HABBLAUD_CODEX_HOOK_KEY: no container, os
//    eventos do hook chegam pelo gateway e só valem com a prova dessa chave.
// 3. Migra o que sobrou do nome antigo (CodeTown, até a 0.3.2): ~/.codetown vira ~/.habblaud, o container
//    `codetown` e a rede codetown_default saem e, se o volume novo ainda não existe, os dados de
//    codetown_codetown-data são copiados para ele (o antigo fica, para apagar à mão). Avisa de CODETOWN_*
//    no ambiente e no .env, que não valem mais.
// 4. Roda `docker compose up -d --build`, espera o /api/health e mostra a URL.
// 5. Atualiza o mod do Habblaud nas contas onde ele JÁ está instalado com outra versão (depois de
//    atualizar o Habblaud): relê o marketplace desta pasta e roda `claude plugin update` com o
//    CLAUDE_CONFIG_DIR de cada conta. Nunca instala sozinho; se o `claude` faltar ou falhar, é só um aviso. Numa
//    conta com o mod e sem o plugin de mensagens (que veio depois), só dá a dica de rodar o npm run mod:install.
//
// Uso de 5h/semanal ao vivo: o mod do Habblaud (npm run mod:install; Claude Code 2.1.287+) ou, em
// versões anteriores, o tap de statusline (npm run usage:install). Os dois gravam os números na pasta
// montada em /usage. Sem eles, vale o cache do /usage lido das contas ao subir.
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { AccountInfo, SourceInfo } from '../shared/types';
import { codexDirsRefused, detectAccounts, discoverClaudeDirs, type DetectedAccount } from '../server/accounts/detect';
import { HOOK_KEY_FILE, loadHookKey } from '../server/codex/key';
import { detectCodexAccounts, discoverCodexDirs } from '../server/sources/codex/accounts';
import { describeStateMigration, LEGACY_NAME, legacyEnvWarning, migrateLegacyStateDir } from '../server/legacy';
import { CONTAINER_HOOK_KEY, CONTAINER_USAGE_DIR, hostTimeZone, planCodexMounts, planMounts, realDir, realFile, renderOverride } from './docker-up-mounts';
import { makeClaudeRunner, MIN_CLAUDE_VERSION, readPackageVersion, updateInstalledMods, type ModUpdateResult } from './mod-install';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HOME = process.env.HOME || homedir();
const STATE_DIR = join(HOME, '.habblaud');
const OVERRIDE_FILE = join(ROOT, 'docker-compose.override.yml');
/** O .env desta pasta, que o Compose lê sozinho. */
const ENV_FILE = join(ROOT, '.env');
/** Uso capturado no host pelo mod do Habblaud ou pelo tap de statusline (scripts/statusline-tap.mjs). */
const USAGE_DIR = process.env.HABBLAUD_USAGE_DIR?.trim() ? resolve(process.env.HABBLAUD_USAGE_DIR.trim()) : join(STATE_DIR, 'usage');
const DEFAULT_PORT = 4747;
const HEALTH_TIMEOUT_MS = 120_000;
/** Imagem e volume de dados como o Compose os nomeia (`name: habblaud` no docker-compose.yml). */
const IMAGE = 'habblaud:local';
const DATA_VOLUME = 'habblaud_habblaud-data';
/** O mesmo no CodeTown (até a 0.3.2), só para a migração: container_name fixo, rede padrão, volume e imagem. */
const LEGACY_DOCKER = {
  container: LEGACY_NAME,
  network: `${LEGACY_NAME}_default`,
  volume: `${LEGACY_NAME}_${LEGACY_NAME}-data`,
  image: `${LEGACY_NAME}:local`,
} as const;

const USAGE = `Uso: npm run docker:up [-- opções]

Opções:
  --no-build   sobe sem reconstruir a imagem
  --down       derruba o container (o mesmo que npm run docker:down)
  -h, --help   mostra esta ajuda

Variáveis: HABBLAUD_PORT (porta no host, padrão ${DEFAULT_PORT}), HABBLAUD_CLAUDE_DIRS
(config dirs separados por vírgula, se as contas não estiverem em ~/.claude*), HABBLAUD_CODEX_DIRS
(pastas do Codex, se não estiverem em ~/.codex* nem em CODEX_HOME) e HABBLAUD_CODEX=0 (sem o Codex; vale também
só no .env).`;

// ---------------------------------------------------------------------------------------------
// Saída no terminal
// ---------------------------------------------------------------------------------------------

const say = (msg: string) => console.log(`[docker-up] ${msg}`);
const warn = (msg: string) => console.warn(`[docker-up] Atenção: ${msg}`);

class FatalError extends Error {}

function fail(msg: string): never {
  throw new FatalError(msg);
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

const USAGE_STATUS: Record<AccountInfo['usageStatus'], string> = {
  ok: 'uso atualizado',
  stale: 'uso desatualizado',
  disabled: 'sem dados de uso',
};

// ---------------------------------------------------------------------------------------------
// Argumentos
// ---------------------------------------------------------------------------------------------

export interface Options {
  down: boolean;
  build: boolean;
  help: boolean;
}

export function parseArgs(argv: string[]): Options {
  const opts: Options = { down: false, build: true, help: false };
  for (const arg of argv) {
    if (arg === '--down') opts.down = true;
    else if (arg === '--no-build') opts.build = false;
    else if (arg === '-h' || arg === '--help') opts.help = true;
    else fail(`opção desconhecida: ${arg}\n\n${USAGE}`);
  }
  return opts;
}

export function hostPort(env: NodeJS.ProcessEnv): number {
  const raw = env.HABBLAUD_PORT?.trim();
  if (!raw) return DEFAULT_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port <= 0 || port >= 65536) fail(`HABBLAUD_PORT inválida: "${raw}" (use um número de 1 a 65535).`);
  return port;
}

// ---------------------------------------------------------------------------------------------
// Plano de montagens e override do Compose (funções puras, sem efeitos colaterais)
// ---------------------------------------------------------------------------------------------

// Moram em docker-up-mounts.ts; reexportados aqui para quem importa do script (os testes).
export { accountsPayload, CODEX_MOUNTED_FILES, CODEX_MOUNTED_SUBDIRS, codexAccountsPayload, hostTimeZone, planCodexMounts, planMounts, renderOverride, sanitizeCachedUsage, yamlString } from './docker-up-mounts';
export type { AccountMount, AccountPayload, BindMount } from './docker-up-mounts';

/**
 * HABBLAUD_CODEX desligado (0, false, off, no): o do ambiente de quem roda o docker:up ou, se ali não estiver definido,
 * o do .env desta pasta (`envFile`, o texto dele). É a precedência do Compose, que repassa esse mesmo valor ao servidor
 * no container: um HABBLAUD_CODEX=0 só no .env desliga o servidor lá dentro e também as montagens do Codex.
 */
export function codexDisabled(env: NodeJS.ProcessEnv, envFile?: string): boolean {
  const v = (env.HABBLAUD_CODEX ?? envFileValue(envFile ?? '', 'HABBLAUD_CODEX'))?.trim();
  return !!v && !/^(1|true|yes|sim|on)$/i.test(v);
}

/**
 * Dica do fim do docker:up sobre o mod: só aparece quando nenhuma conta tem o mod instalado (quem já instalou
 * recebe a atualização automática, ou um aviso). Sem o CLI do Claude Code, não dá para saber: fica quieto.
 */
export function modHint(mod: Pick<ModUpdateResult, 'installed' | 'unavailable'>): string[] {
  if (mod.installed || mod.unavailable) return [];
  return [
    `  Uso de 5h/semanal ao vivo, responder e mandar mensagens pelo escritório: npm run mod:install (uma vez; Claude Code ${MIN_CLAUDE_VERSION}+).`,
    '  Em versões anteriores do Claude Code: npm run usage:install e npm run hooks:install. Sem eles, vale o cache do /usage.',
  ];
}

// ---------------------------------------------------------------------------------------------
// Nome antigo (CodeTown, até a 0.3.2): plano da subida no Docker e nomes do .env (funções puras)
// ---------------------------------------------------------------------------------------------

/** O que já existe no Docker antes de subir. */
export interface DockerState {
  /** Container `codetown` do CodeTown (container_name fixo: prende o nome e a porta). */
  legacyContainer: boolean;
  /** Rede codetown_default. */
  legacyNetwork: boolean;
  /** Volume codetown_codetown-data (nomes dos personagens, linha do tempo, estatísticas). */
  legacyVolume: boolean;
  /** Imagem codetown:local. */
  legacyImage: boolean;
  /** Volume de dados do Habblaud (habblaud_habblaud-data). */
  dataVolume: boolean;
}

export type UpStep =
  | { kind: 'remove-container'; name: string }
  | { kind: 'remove-network'; name: string }
  | { kind: 'compose'; args: string[] }
  | { kind: 'copy-volume'; from: string; to: string };

export interface UpPlan {
  steps: UpStep[];
  /** Comandos para apagar o que sobrou do CodeTown, mostrados no fim quando esta subida migrou algo. */
  cleanup: string[];
}

/**
 * Passos para subir o Habblaud. Antes, tira do caminho o container do CodeTown e a rede dele. Se o volume antigo
 * existe e o novo ainda não, os dados são copiados: o Compose cria o volume (com os labels dele; um volume criado
 * à mão gera aviso e pedido para recriar) e o container, ainda parado; a cópia entra e só então ele sobe. O volume
 * antigo nunca é apagado aqui.
 */
export function planUp(state: DockerState, build: boolean): UpPlan {
  const steps: UpStep[] = [];
  if (state.legacyContainer) steps.push({ kind: 'remove-container', name: LEGACY_DOCKER.container });
  if (state.legacyNetwork) steps.push({ kind: 'remove-network', name: LEGACY_DOCKER.network });
  const copy = state.legacyVolume && !state.dataVolume;
  if (copy) {
    steps.push(
      { kind: 'compose', args: build ? ['up', '--no-start', '--build'] : ['up', '--no-start'] },
      { kind: 'copy-volume', from: LEGACY_DOCKER.volume, to: DATA_VOLUME },
      { kind: 'compose', args: ['up', '-d'] },
    );
  } else steps.push({ kind: 'compose', args: build ? ['up', '-d', '--build'] : ['up', '-d'] });

  const cleanup: string[] = [];
  if (state.legacyContainer || copy) {
    if (state.legacyVolume) cleanup.push(`docker volume rm ${LEGACY_DOCKER.volume}`);
    if (state.legacyImage) cleanup.push(`docker image rm ${LEGACY_DOCKER.image}`);
  }
  return { steps, cleanup };
}

/**
 * `docker run` descartável que copia o volume `from` (somente leitura) para `to` com a própria imagem do
 * Habblaud, como root (ela roda como `node`) e sem rede; a raiz de `to` fica com o dono e as permissões da de
 * `from`. O --rm leva junto o volume anônimo do VOLUME /data da imagem.
 */
export function copyVolumeArgs(from: string, to: string, image: string = IMAGE): string[] {
  const script = 'set -e; cp -a /from/. /to/; chown "$(stat -c %u:%g /from)" /to; chmod "$(stat -c %a /from)" /to';
  const flags = ['--rm', '--pull', 'never', '--network', 'none', '--no-healthcheck', '--user', '0:0', '--entrypoint', 'sh'];
  return ['run', ...flags, '-v', `${from}:/from:ro`, '-v', `${to}:/to`, image, '-c', script];
}

/** Nomes das variáveis de um .env (linhas `NOME=valor`, com ou sem `export`). Os valores ficam de fora. */
export function envFileKeys(text: string): string[] {
  const keys: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (m) keys.push(m[1]);
  }
  return keys;
}

/**
 * Valor de `key` num .env, lido como o Compose lê: `NOME=valor` ou `NOME: valor`, com ou sem `export`; aspas simples ou
 * duplas em volta saem e, num valor sem aspas, um espaço seguido de `#` começa um comentário. A última linha da
 * variável vale; undefined se ela não está lá.
 */
export function envFileValue(text: string, key: string): string | undefined {
  let value: string | undefined;
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*[=:]\s*(.*?)\s*$/.exec(line);
    if (!m || m[1] !== key) continue;
    const quoted = /^(["'])(.*?)\1/.exec(m[2]);
    value = quoted ? quoted[2] : m[2].split(' #')[0].trimEnd();
  }
  return value;
}

// ---------------------------------------------------------------------------------------------
// Estado no host (~/.habblaud)
// ---------------------------------------------------------------------------------------------

/** Texto do .env desta pasta, ou undefined (sem .env, o normal, ou ilegível). */
function readEnvFile(): string | undefined {
  try {
    return readFileSync(ENV_FILE, 'utf8');
  } catch {
    return undefined;
  }
}

/** Avisa das variáveis CODETOWN_* (nome antigo, ignoradas) no ambiente e no .env desta pasta. */
function warnLegacyEnv(): void {
  const fileKeys = envFileKeys(readEnvFile() ?? '');
  for (const msg of [legacyEnvWarning(Object.keys(process.env)), legacyEnvWarning(fileKeys, 'no .env')]) {
    if (msg) warn(msg);
  }
}

/** Leva ~/.codetown (nome antigo) para ~/.habblaud; roda antes de criar a pasta do uso, para ser um rename. */
function migrateStateDir(): void {
  const result = migrateLegacyStateDir(HOME);
  const msg = describeStateMigration(result);
  if (msg) (result.error ? warn : say)(msg);
}

/** Cria a pasta do uso do statusline se faltar e devolve o caminho real (ou undefined, se falhar). */
function ensureUsageDir(): string | undefined {
  try {
    mkdirSync(USAGE_DIR, { recursive: true, mode: 0o700 });
    return realDir(USAGE_DIR);
  } catch (err) {
    warn(`não consegui criar ${tildify(USAGE_DIR)} (${(err as Error).message}); o uso do statusline não vai aparecer no container.`);
    return undefined;
  }
}

/**
 * Chave local do hook do Codex no host (server/codex/key.ts: 32 bytes, criada com modo 0600 se faltar), que o hook lê em
 * ~/.habblaud. Roda depois da migração do ~/.codetown (criar ~/.habblaud antes impediria o rename). Devolve o caminho
 * real do arquivo, ou undefined com um aviso.
 */
function ensureHookKey(): string | undefined {
  const file = join(STATE_DIR, HOOK_KEY_FILE);
  const real = loadHookKey(STATE_DIR, { create: true }) ? realFile(file) : undefined;
  if (!real) warn(`não consegui ler nem criar ${tildify(file)} (precisa ter 32 bytes; apague para recriar); no container, os eventos do hook do Codex vão ser recusados.`);
  return real;
}

function tildify(p: string): string {
  return p === HOME || p.startsWith(`${HOME}/`) ? `~${p.slice(HOME.length)}` : p;
}

// ---------------------------------------------------------------------------------------------
// Docker
// ---------------------------------------------------------------------------------------------

function checkDocker(): void {
  const info = spawnSync('docker', ['info', '--format', '{{.ServerVersion}}'], { encoding: 'utf8' });
  if (info.error) fail('o comando "docker" não foi encontrado. Instale o Docker Desktop: https://www.docker.com/products/docker-desktop/');
  if (info.status !== 0) fail('o Docker não está respondendo. Abra o Docker Desktop, espere ele terminar de iniciar e tente de novo.');
  const compose = spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' });
  if (compose.status !== 0) fail('o Docker Compose v2 ("docker compose") não está disponível. Atualize o Docker Desktop.');
}

function compose(args: string[], port: number): void {
  // HABBLAUD_PORT explícito: vale sobre um eventual .env na pasta do projeto.
  const res = spawnSync('docker', ['compose', ...args], { cwd: ROOT, stdio: 'inherit', env: { ...process.env, HABBLAUD_PORT: String(port) } });
  if (res.error) fail(`não consegui rodar "docker compose ${args.join(' ')}": ${res.error.message}`);
  if (res.status !== 0) fail(`"docker compose ${args.join(' ')}" falhou (código ${res.status ?? res.signal}).`);
}

/** `docker <args>` sem mostrar nada no terminal: se deu certo, a saída e a última linha do erro. */
function dockerQuiet(args: string[]): { ok: boolean; out: string; error: string } {
  const res = spawnSync('docker', args, { encoding: 'utf8' });
  // A última linha do docker costuma ser só "Run 'docker run --help' for more information".
  const lines = (res.stderr ?? '').split('\n').filter((l) => l.trim() && !/^Run '.*--help'/.test(l));
  const error = res.error?.message || lines.pop()?.trim() || `código ${res.status ?? res.signal}`;
  return { ok: res.status === 0, out: res.stdout ?? '', error };
}

/** O que já existe no Docker do CodeTown e do Habblaud (entrada de planUp). */
function inspectDocker(): DockerState {
  const exists = (kind: 'network' | 'volume' | 'image', name: string) => dockerQuiet([kind, 'inspect', name]).ok;
  // Só sai o container `codetown` que é mesmo do CodeTown: da imagem antiga ou do projeto antigo do Compose.
  const { container, image } = LEGACY_DOCKER;
  const c = dockerQuiet(['container', 'inspect', '--format', '{{.Config.Image}} {{index .Config.Labels "com.docker.compose.project"}}', container]);
  const [cImage = '', cProject = ''] = c.out.trim().split(' ');
  const legacyContainer = c.ok && (cImage === image || cProject === LEGACY_NAME);
  if (c.ok && !legacyContainer) warn(`existe um container ${container} que não é do CodeTown (imagem ${cImage || '?'}); ele fica como está.`);
  return {
    legacyContainer,
    legacyNetwork: exists('network', LEGACY_DOCKER.network),
    legacyVolume: exists('volume', LEGACY_DOCKER.volume),
    legacyImage: exists('image', image),
    dataVolume: exists('volume', DATA_VOLUME),
  };
}

/** Copia os dados do volume do CodeTown para o do Habblaud. Falha é só um aviso: o escritório sobe sem eles. */
function copyVolume(from: string, to: string): boolean {
  // O volume novo tem de vir do Compose: o `docker run -v` criaria um sem os labels dele.
  if (!dockerQuiet(['volume', 'inspect', to]).ok) {
    warn(`o Compose não criou o volume ${to}; os dados do CodeTown não foram copiados e continuam em ${from}.`);
    return false;
  }
  say(`Copiando os dados do CodeTown (nomes dos personagens, linha do tempo e estatísticas) de ${from} para ${to}…`);
  const res = dockerQuiet(copyVolumeArgs(from, to));
  if (!res.ok) {
    warn(
      `não consegui copiar os dados do CodeTown (${res.error}). O escritório sobe sem eles; os dados continuam em ${from}.\n` +
        `  Para tentar de novo: npm run docker:down && docker volume rm ${to} && npm run docker:up`,
    );
    return false;
  }
  say(`Dados copiados; o volume ${from} ficou intacto.`);
  return true;
}

/** Executa os passos de planUp. Derrubam o docker:up só o Compose e o container antigo que não sai. */
function runPlan(plan: UpPlan, port: number, build: boolean): { copyFailed: boolean } {
  let copyFailed = false;
  let created = false;
  for (const step of plan.steps) {
    switch (step.kind) {
      case 'remove-container': {
        say(`Removendo o container ${step.name} (CodeTown, o nome antigo)…`);
        const res = dockerQuiet(['rm', '-f', step.name]);
        if (!res.ok) fail(`não consegui remover o container antigo ${step.name} (${res.error}). Remova com docker rm -f ${step.name} e rode de novo.`);
        break;
      }
      case 'remove-network': {
        const res = dockerQuiet(['network', 'rm', step.name]);
        if (!res.ok) warn(`não consegui remover a rede antiga ${step.name} (${res.error}); apague depois com docker network rm ${step.name}.`);
        break;
      }
      case 'copy-volume':
        copyFailed = !copyVolume(step.from, step.to);
        break;
      case 'compose':
        if (step.args.includes('--no-start')) {
          say(`${build ? 'Construindo a imagem e criando' : 'Criando'} o container, ainda parado, para receber os dados do CodeTown…`);
          created = true;
        } else if (created) say('Subindo o container…');
        else say(build ? 'Construindo a imagem e subindo o container…' : 'Subindo o container (sem reconstruir a imagem)…');
        compose(step.args, port);
        break;
    }
  }
  return { copyFailed };
}

interface Health {
  ok: boolean;
  version?: string;
  demo?: boolean;
  docker?: boolean;
  sources?: SourceInfo[];
  accounts?: Array<{ id: string; usageStatus: AccountInfo['usageStatus'] }>;
}

async function fetchHealth(baseUrl: string, timeoutMs: number): Promise<Health | undefined> {
  try {
    const res = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return undefined;
    const body = (await res.json()) as Health;
    return body?.ok ? body : undefined;
  } catch {
    return undefined;
  }
}

const sleep = (ms: number) => new Promise<void>((ok) => setTimeout(ok, ms));

async function waitHealthy(baseUrl: string): Promise<Health | undefined> {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const health = await fetchHealth(baseUrl, 3_000);
    if (health) return health;
    await sleep(1_000);
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Comandos
// ---------------------------------------------------------------------------------------------

function down(port: number): void {
  checkDocker();
  say('Derrubando o container…');
  compose(['down'], port);
  say('Pronto. Os nomes dos personagens continuam guardados no volume habblaud-data.');
}

async function up(opts: Options, port: number): Promise<void> {
  checkDocker();
  warnLegacyEnv();
  const baseUrl = `http://127.0.0.1:${port}`;
  const publicUrl = `http://localhost:${port}`;

  // Porta ocupada por um Habblaud fora do Docker (npm run dev / npm start)?
  const existing = await fetchHealth(baseUrl, 1_500);
  if (existing && !existing.docker) {
    fail(
      `já existe um Habblaud rodando fora do Docker em ${publicUrl} (npm run dev ou npm start?).\n` +
        `Pare-o antes, ou use outra porta: HABBLAUD_PORT=4848 npm run docker:up`,
    );
  }

  const dirs = discoverClaudeDirs(process.env, HOME);
  const accounts = detectAccounts(dirs, { home: HOME, env: process.env });
  const mounts = planMounts(dirs, accounts);
  if (!mounts.length) {
    warn(
      'nenhuma pasta do Claude Code (com projects/ ou sessions/) foi encontrada em ~/.claude*.\n' +
        '  O escritório vai abrir vazio (dá para ligar o modo demonstração na interface).\n' +
        '  Se as contas estiverem em outro lugar: HABBLAUD_CLAUDE_DIRS=/caminho/conta1,/caminho/conta2 npm run docker:up',
    );
  }
  for (const m of mounts) {
    const subdirs = m.binds.map((b) => posix.basename(b.target)).join(' e ');
    say(`Conta ${m.account.short} (${m.account.id}): monta ${subdirs} de ${tildify(m.hostDir)}, somente leitura.`);
  }
  for (const dir of dirs) {
    if (!mounts.some((m) => m.hostDir === dir)) warn(`${tildify(dir)} não tem projects/ nem sessions/; conta ignorada.`);
  }
  // Pasta do Codex (CODEX_HOME) listada ou achada como se fosse do Claude Code: não é montada como conta do Claude.
  // Ela entra (só as conversas e os locks) como conta do Codex, logo abaixo.
  const claudeRefused = codexDirsRefused(process.env, HOME);
  // HABBLAUD_CODEX=0 no ambiente ou só no .env: nada do Codex é montado (o Compose repassa o mesmo valor ao servidor).
  const codexDirs = codexDisabled(process.env, readEnvFile()) ? [] : discoverCodexDirs(process.env, HOME);
  for (const dir of claudeRefused) if (!codexDirs.includes(dir)) warn(`${tildify(dir)} é uma pasta do Codex, não do Claude Code; conta ignorada.`);
  const codexAccounts = detectCodexAccounts(codexDirs, {
    home: HOME,
    env: process.env,
    taken: { shorts: accounts.map((a) => a.short), colors: accounts.map((a) => a.color) },
  });
  const codexMounts = planCodexMounts(codexDirs, codexAccounts);
  for (const m of codexMounts) {
    const subdirs = m.binds.map((b) => posix.basename(b.target)).join(', ');
    say(`Codex ${m.account.short} (${m.account.id}): monta ${subdirs} de ${tildify(m.hostDir)}, somente leitura.`);
    if (!m.binds.some((b) => b.target.endsWith('/thread-writer-locks'))) {
      warn(`${tildify(m.hostDir)} ainda não tem thread-writer-locks/: no container, sessão aberta = conversa modificada nos últimos 30 min (rode o docker:up de novo depois de usar o Codex).`);
    }
  }
  for (const dir of codexDirs) {
    if (!codexMounts.some((m) => m.hostDir === dir)) warn(`${tildify(dir)} não tem sessions/; conta do Codex ignorada.`);
  }

  migrateStateDir();
  const usageDir = ensureUsageDir();
  if (usageDir) say(`Uso ao vivo (mod ou tap de statusline): monta ${tildify(USAGE_DIR)} em ${CONTAINER_USAGE_DIR}, somente leitura.`);
  // Só com alguma conta do Codex montada (HABBLAUD_CODEX=0 não monta nada do Codex).
  const hookKey = codexMounts.length ? ensureHookKey() : undefined;
  if (hookKey) say(`Chave do hook do Codex: monta ${tildify(join(STATE_DIR, HOOK_KEY_FILE))} em ${CONTAINER_HOOK_KEY}, somente leitura.`);
  const tmp = `${OVERRIDE_FILE}.tmp`;
  writeFileSync(tmp, renderOverride(mounts, new Date(), usageDir, hostTimeZone(), codexMounts, hookKey), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, OVERRIDE_FILE);
  say('docker-compose.override.yml gerado.');

  const plan = planUp(inspectDocker(), opts.build);
  const { copyFailed } = runPlan(plan, port, opts.build);

  say(`Aguardando o Habblaud responder em ${publicUrl}…`);
  const health = await waitHealthy(baseUrl);
  if (!health) fail(`o Habblaud não respondeu em ${HEALTH_TIMEOUT_MS / 1000} s. Veja o que aconteceu com: npm run docker:logs`);

  console.log('');
  say(`Habblaud${health.version ? ` ${health.version}` : ''} no ar: ${publicUrl}`);
  for (const acc of accounts) {
    const src = health.sources?.find((s) => s.label === acc.id);
    if (!src) continue;
    const usage = health.accounts?.find((a) => a.id === acc.id)?.usageStatus;
    const state = src.ok ? plural(src.sessions, 'sessão aberta', 'sessões abertas') : `erro ao ler (${src.error ?? 'desconhecido'})`;
    say(`  Conta ${acc.short} (${acc.id}): ${state}${usage ? ` · ${USAGE_STATUS[usage]}` : ''}`);
  }
  for (const m of codexMounts) {
    const src = health.sources?.find((s) => s.label === m.account.id && s.provider === 'codex');
    if (!src) continue;
    const usage = health.accounts?.find((a) => a.id === m.account.id)?.usageStatus;
    const state = src.ok ? plural(src.sessions, 'sessão aberta', 'sessões abertas') : `erro ao ler (${src.error ?? 'desconhecido'})`;
    say(`  Codex ${m.account.short} (${m.account.id}): ${state}${usage ? ` · ${USAGE_STATUS[usage]}` : ''}`);
  }
  for (const line of modHint(updateMods(dirs, accounts))) say(line);
  // Com a cópia falha, os dados só existem no volume antigo: nada de sugerir apagá-lo.
  if (plan.cleanup.length && !copyFailed) say(`  Sobrou do CodeTown; depois de conferir o escritório, apague com: ${plan.cleanup.join(' · ')}`);
  say('  Logs: npm run docker:logs · Parar: npm run docker:down');
}

/** Atualiza o mod de quem já instalou (ver mod-install.ts). Nada aqui derruba o docker:up. */
function updateMods(dirs: string[], accounts: DetectedAccount[]): Pick<ModUpdateResult, 'installed' | 'unavailable'> {
  try {
    const labels = dirs.map((dir, i) => ({ dir, label: `Conta ${accounts[i]?.short ?? tildify(dir)}` }));
    const mod = updateInstalledMods(labels, { env: process.env, home: HOME, root: ROOT, version: readPackageVersion(ROOT), claude: makeClaudeRunner() });
    for (const l of mod.lines) {
      if (l.level === 'warn') warn(l.text);
      else say(`  ${l.text}`);
    }
    return mod;
  } catch (err) {
    warn(`não consegui conferir o mod do Habblaud (${(err as Error).message}).`);
    return { installed: false, unavailable: true };
  }
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(USAGE);
    return;
  }
  const port = hostPort(process.env);
  if (opts.down) down(port);
  else await up(opts, port);
}

// Executa só quando chamado direto (importar o módulo, ex. em testes, não sobe nada).
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((err: unknown) => {
    if (err instanceof FatalError) console.error(`[docker-up] Erro: ${err.message}`);
    else console.error('[docker-up] Erro inesperado:', err);
    process.exitCode = 1;
  });
}
