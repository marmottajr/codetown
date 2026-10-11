// Instala (ou remove) o plugin do Habblaud no OpenCode. Roda no HOST, com tsx:
//
//   npm run opencode:install     # copia o plugin para ~/.config/opencode/plugins/habblaud.js e grava a configuração
//   npm run opencode:uninstall   # remove só esses dois arquivos
//   npm run opencode:status      # mostra se o plugin está lá, atualizado, e se o Habblaud está respondendo
//   (opções: --dry-run, --port <n>, --espera <s>)
//
// O plugin (mod/habblaud-opencode/plugin.js) manda ao escritório, na hora, o que as sessões do OpenCode fazem e deixa
// aprovar ou recusar pelo escritório os pedidos de permissão. É uma CÓPIA do arquivo (um único ESM, só com imports
// `node:*`), para continuar funcionando se o repositório mudar de lugar: depois de atualizar o Habblaud, rode
// npm run opencode:install de novo (o status avisa quando a cópia ficou para trás). O OpenCode carrega sozinho os
// plugins dessa pasta. Sem instalar nada o OpenCode já aparece no escritório (leitura do banco, sem o plugin).
//
// Arquivos: ~/.config/opencode/plugins/habblaud.js e ~/.habblaud/opencode-hook.json ({port, permissionTimeoutS}, que o
// plugin lê). Antes de trocar um arquivo que já existe com outro conteúdo, uma cópia vai para
// <arquivo>.habblaud-backup-<data>. A desinstalação remove só esses dois arquivos (e só o plugin se ele for mesmo
// o do Habblaud). Nunca toca em opencode.json, auth.json nem no banco do OpenCode.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tildify } from './statusline-install';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const PLUGIN_SOURCE = join(ROOT, 'mod', 'habblaud-opencode', 'plugin.js');
export const DEFAULT_PORT = 4747;
export const DEFAULT_WAIT_S = 25;
export const MIN_WAIT_S = 5;
export const MAX_WAIT_S = 120;
/** Configuração lida pelo plugin (porta e espera), em ~/.habblaud. */
export const CONFIG_NAME = 'opencode-hook.json';
/** O arquivo do plugin só é removido se tiver isto (nome do export do plugin do Habblaud). */
const PLUGIN_MARK = 'HabblaudPlugin';

const USAGE = `Uso: npm run opencode:<install|uninstall|status> [-- opções]

  install     copia o plugin para ~/.config/opencode/plugins/habblaud.js e grava ~/.habblaud/opencode-hook.json
              (faz backup antes de trocar um arquivo que já existe com outro conteúdo)
  uninstall   remove esses dois arquivos
  status      mostra se o plugin está instalado e atualizado, e se o Habblaud está respondendo

Opções:
  --dry-run        mostra o que mudaria, sem gravar nada
  --port <n>       porta do Habblaud (padrão: HABBLAUD_PORT ou ${DEFAULT_PORT})
  --espera <s>     quanto o plugin espera sua resposta no Habblaud antes de deixar o pedido para o OpenCode
                   (padrão: ${DEFAULT_WAIT_S} s; entre ${MIN_WAIT_S} e ${MAX_WAIT_S})
  -h, --help       mostra esta ajuda

Depois de instalar, reinicie o OpenCode (ele carrega os plugins ao abrir).`;

class FatalError extends Error {}

export interface HookConfig {
  port: number;
  permissionTimeoutS: number;
}

export interface RunOptions {
  command: 'install' | 'uninstall' | 'status';
  dryRun: boolean;
  port: number;
  waitS: number;
}

export interface Health {
  permissions?: boolean;
  messages?: boolean;
  opencodeEvents?: boolean;
  opencodeSource?: boolean;
}

export interface RunContext {
  /** HOME (injetado: os testes usam uma pasta temporária e nunca tocam no ~/.config/opencode de verdade). */
  home: string;
  now: Date;
  /** O plugin do repositório (a origem da cópia). */
  pluginPath: string;
  out: (line: string) => void;
  /** Consulta o /api/health do Habblaud (testes injetam um falso). */
  health?: (port: number) => Promise<Health | undefined>;
}

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): RunOptions | 'help' {
  let command: RunOptions['command'] | undefined;
  let dryRun = false;
  const envPort = Number.parseInt(env.HABBLAUD_PORT ?? '', 10);
  let port = Number.isInteger(envPort) && envPort > 0 && envPort < 65_536 ? envPort : DEFAULT_PORT;
  let waitS = DEFAULT_WAIT_S;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') return 'help';
    if (a === '--dry-run') dryRun = true;
    else if (a === '--port') {
      port = Number(argv[++i]);
      if (!Number.isInteger(port) || port <= 0 || port >= 65_536) throw new FatalError('--port precisa de um número entre 1 e 65535.');
    } else if (a === '--espera') {
      waitS = Number(argv[++i]);
      if (!Number.isInteger(waitS) || waitS < MIN_WAIT_S || waitS > MAX_WAIT_S) throw new FatalError(`--espera precisa de um número de segundos entre ${MIN_WAIT_S} e ${MAX_WAIT_S}.`);
    } else if ((a === 'install' || a === 'uninstall' || a === 'status') && !command) command = a;
    else throw new FatalError(`opção desconhecida: ${a}\n\n${USAGE}`);
  }
  if (!command) throw new FatalError(`diga o que fazer: install, uninstall ou status.\n\n${USAGE}`);
  return { command, dryRun, port, waitS };
}

export const pluginDir = (home: string): string => join(home, '.config', 'opencode', 'plugins');
export const pluginPath = (home: string): string => join(pluginDir(home), 'habblaud.js');
export const configPath = (home: string): string => join(home, '.habblaud', CONFIG_NAME);

function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function readText(file: string): string | undefined {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

/** Configuração gravada para o plugin (undefined = não existe ou ilegível). */
export function readHookConfig(home: string): Partial<HookConfig> | undefined {
  try {
    const j = JSON.parse(readFileSync(configPath(home), 'utf8')) as unknown;
    if (!j || typeof j !== 'object' || Array.isArray(j)) return undefined;
    const r = j as Record<string, unknown>;
    const out: Partial<HookConfig> = {};
    if (typeof r.port === 'number') out.port = r.port;
    if (typeof r.permissionTimeoutS === 'number') out.permissionTimeoutS = r.permissionTimeoutS;
    return out;
  } catch {
    return undefined;
  }
}

/** Grava `text` em `file` (cria a pasta); se já havia um arquivo com outro conteúdo, faz o backup antes. Devolve o backup. */
function writeWithBackup(file: string, text: string, existing: string | undefined, now: Date): string | undefined {
  mkdirSync(dirname(file), { recursive: true });
  let backup: string | undefined;
  if (existing !== undefined) {
    backup = `${file}.habblaud-backup-${stamp(now)}`;
    for (let i = 2; existsSync(backup); i++) backup = `${file}.habblaud-backup-${stamp(now)}-${i}`;
    writeFileSync(backup, existing, { mode: 0o600 });
  }
  const tmp = `${file}.habblaud-tmp-${process.pid}`;
  writeFileSync(tmp, text, { mode: 0o644 });
  renameSync(tmp, file);
  return backup;
}

async function fetchHealth(port: number): Promise<Health | undefined> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1_500) });
    if (!res.ok) return undefined;
    return (await res.json()) as Health;
  } catch {
    return undefined;
  }
}

const configText = (cfg: HookConfig): string => `${JSON.stringify(cfg, null, 2)}\n`;

/** Executa o comando. Devolve o código de saída. */
export async function run(opts: RunOptions, ctx: RunContext): Promise<number> {
  const { home, out } = ctx;
  const plugin = pluginPath(ctx.home);
  const cfgFile = configPath(home);
  const pluginLabel = tildify(plugin, home);
  const cfgLabel = tildify(cfgFile, home);
  const source = readText(ctx.pluginPath);
  let failures = 0;

  if (opts.command === 'install') {
    if (source === undefined) {
      out(`✗ não achei o plugin do repositório (${ctx.pluginPath}).`);
      return 1;
    }
    const cfg: HookConfig = { port: opts.port, permissionTimeoutS: opts.waitS };
    const steps: Array<{ label: string; file: string; text: string; mode: 'plugin' | 'config' }> = [
      { label: pluginLabel, file: plugin, text: source, mode: 'plugin' },
      { label: cfgLabel, file: cfgFile, text: configText(cfg), mode: 'config' },
    ];
    let changed = 0;
    for (const s of steps) {
      const cur = readText(s.file);
      const same = cur !== undefined && (s.mode === 'plugin' ? cur === s.text : JSON.stringify(JSON.parse(safeJson(cur))) === JSON.stringify(cfg));
      if (same) {
        out(`= ${s.label}: já instalado${s.mode === 'config' ? ` (porta ${cfg.port}, espera ${cfg.permissionTimeoutS} s)` : ''}`);
        continue;
      }
      if (opts.dryRun) {
        out(`~ ${s.label}: ${cur === undefined ? 'seria criado' : 'seria atualizado (com backup)'} (simulação: nada gravado)`);
        continue;
      }
      try {
        const backup = writeWithBackup(s.file, s.text, cur, ctx.now);
        out(`✓ ${s.label}: ${cur === undefined ? 'criado' : 'atualizado'}${backup ? ` · backup em ${tildify(backup, home)}` : ''}`);
        changed++;
      } catch (err) {
        out(`✗ ${s.label}: não consegui gravar (${(err as Error).message})`);
        failures++;
      }
    }
    if (changed && !opts.dryRun && !failures) {
      out('');
      out('Pronto. Reinicie o OpenCode (ele carrega os plugins ao abrir). Com o Habblaud aberto no navegador, as sessões');
      out(`aparecem no escritório na hora e os pedidos de permissão esperam sua resposta lá por até ${opts.waitS} s.`);
      out('Para desfazer: npm run opencode:uninstall');
    }
    return failures ? 1 : 0;
  }

  if (opts.command === 'uninstall') {
    let removed = 0;
    const cur = readText(plugin);
    if (cur === undefined) out(`= ${pluginLabel}: não estava instalado`);
    else if (!cur.includes(PLUGIN_MARK)) {
      out(`✗ ${pluginLabel}: não é o plugin do Habblaud; não removi.`);
      failures++;
    } else if (opts.dryRun) out(`~ ${pluginLabel}: seria removido (simulação: nada removido)`);
    else {
      rmSync(plugin);
      out(`✓ ${pluginLabel}: removido`);
      removed++;
    }
    if (!existsSync(cfgFile)) out(`= ${cfgLabel}: não existia`);
    else if (opts.dryRun) out(`~ ${cfgLabel}: seria removido (simulação: nada removido)`);
    else {
      rmSync(cfgFile);
      out(`✓ ${cfgLabel}: removido`);
      removed++;
    }
    if (removed) out('Os backups (*.habblaud-backup-*) ficam onde estão. Reinicie o OpenCode.');
    return failures ? 1 : 0;
  }

  // status
  const cur = readText(plugin);
  if (cur === undefined) out(`• ${pluginLabel}: não instalado (o OpenCode ainda aparece no escritório pela leitura do banco; o plugin traz eventos na hora e aprovações)`);
  else if (!cur.includes(PLUGIN_MARK)) out(`! ${pluginLabel}: existe, mas não é o plugin do Habblaud`);
  else if (source !== undefined && cur !== source) out(`! ${pluginLabel}: instalado, mas diferente do plugin deste repositório; rode npm run opencode:install para atualizar`);
  else out(`• ${pluginLabel}: instalado${source === undefined ? '' : ' e atualizado'}`);
  const cfg = readHookConfig(home);
  out(
    cfg
      ? `Configuração do plugin (${cfgLabel}): porta ${cfg.port ?? DEFAULT_PORT}, espera ${cfg.permissionTimeoutS ?? DEFAULT_WAIT_S} s.`
      : `Configuração do plugin (${cfgLabel}): não existe (o plugin usa HABBLAUD_PORT ou a porta ${DEFAULT_PORT}).`,
  );
  const port = cfg?.port ?? opts.port;
  const health = await (ctx.health ?? fetchHealth)(port);
  if (!health) out(`Habblaud em http://127.0.0.1:${port}: fora do ar (com ele parado, o plugin não faz nada e o OpenCode segue normal).`);
  else {
    const events = health.opencodeEvents ? (health.opencodeSource ? 'recebendo os eventos do OpenCode' : 'recebendo os eventos (sem a leitura do banco: precisa do Node 22.13+ e do opencode.db)') : 'no ar, mas com o OpenCode desligado (HABBLAUD_OPENCODE=0) ou sem a rota de eventos';
    const perms = health.permissions ? 'aprovar pelo escritório ligado (com alguma página aberta)' : 'aprovar pelo escritório desligado (porta exposta na rede ou HABBLAUD_TERMINAL=0)';
    out(`Habblaud em http://127.0.0.1:${port}: ${events}; ${perms}.`);
  }
  return 0;
}

/** JSON ilegível vira `null` (e diferente do esperado). */
function safeJson(text: string): string {
  try {
    JSON.parse(text);
    return text;
  } catch {
    return 'null';
  }
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed === 'help') {
    console.log(USAGE);
    return;
  }
  process.exitCode = await run(parsed, { home: process.env.HOME || homedir(), now: new Date(), pluginPath: PLUGIN_SOURCE, out: (l) => console.log(l) });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((err: unknown) => {
    console.error(err instanceof FatalError ? `[opencode] Erro: ${err.message}` : `[opencode] Erro inesperado: ${String(err)}`);
    process.exitCode = 1;
  });
}
