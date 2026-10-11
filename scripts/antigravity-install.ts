// Instala (ou remove) o hook do Habblaud no Antigravity CLI (`agy`). Roda no HOST, com tsx:
//
//   npm run antigravity:install     # registra o hook "habblaud" no hooks.json do agy e copia o script
//   npm run antigravity:uninstall   # remove só o que a instalação acrescentou
//   npm run antigravity:status      # mostra se o hook está registrado e atualizado, e se o Habblaud responde
//   (opções: --dry-run, --port <n>)
//
// O hook (mod/habblaud-antigravity/hook.mjs) manda ao escritório, na hora, o que as sessões do agy fazem. Ele só observa:
// não imprime nada e sai com 0 (o agy bloqueia o agente enquanto o hook roda, ver o cabeçalho do hook). É uma CÓPIA do
// arquivo, para continuar funcionando se o repositório mudar de lugar: depois de atualizar o Habblaud, rode
// npm run antigravity:install de novo (o status avisa quando a cópia ficou para trás).
//
// Arquivos: o hooks.json que o agy carrega (~/.gemini/config/hooks.json, confirmado no agy 1.3.3 pelo log dele), a cópia
// ~/.habblaud/antigravity-hook.mjs e ~/.habblaud/antigravity-hook.json ({port}). No hooks.json entra uma chave só,
// "habblaud", com os cinco eventos; os outros hooks ficam como estão. Antes de mudar o hooks.json, uma cópia vai para
// <arquivo>.habblaud-backup-<data>. Um hooks.json que não é um objeto JSON é recusado sem gravar nada. O agy parte o
// comando nos espaços e não tira aspas: por isso o caminho da cópia não pode ter espaço nem aspas (a instalação para).
// Nunca toca em settings.json, no token de login nem nas conversas do agy.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tildify } from './statusline-install';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const HOOK_SOURCE = join(ROOT, 'mod', 'habblaud-antigravity', 'hook.mjs');
export const DEFAULT_PORT = 4747;
export const CONFIG_NAME = 'antigravity-hook.json';
export const HOOK_NAME = 'habblaud';
/** Versão do agy em que o contrato dos hooks foi conferido. */
export const TESTED_AGY = '1.3.3';
const EVENTS_GROUPED = ['PreToolUse', 'PostToolUse'] as const;
const EVENTS_FLAT = ['PreInvocation', 'PostInvocation', 'Stop'] as const;

const USAGE = `Uso: npm run antigravity:<install|uninstall|status> [-- opções]

  install     registra o hook "habblaud" em ~/.gemini/config/hooks.json e copia o script para ~/.habblaud/
              (faz backup do hooks.json antes de mudar; os outros hooks ficam como estão)
  uninstall   remove o hook "habblaud" do hooks.json e os dois arquivos de ~/.habblaud/
  status      mostra se o hook está registrado e atualizado, e se o Habblaud está respondendo

Opções:
  --dry-run        mostra o que mudaria, sem gravar nada
  --port <n>       porta do Habblaud (padrão: HABBLAUD_PORT ou ${DEFAULT_PORT})
  -h, --help       mostra esta ajuda

Depois de instalar, abra uma nova sessão do agy (use /hooks nele para ver o hook carregado).`;

class FatalError extends Error {}

export interface RunOptions {
  command: 'install' | 'uninstall' | 'status';
  dryRun: boolean;
  port: number;
}

export interface Health {
  antigravityEvents?: boolean;
  antigravitySource?: boolean;
}

export interface RunContext {
  /** HOME (injetado: os testes usam uma pasta temporária e nunca tocam no ~/.gemini de verdade). */
  home: string;
  now: Date;
  /** O hook do repositório (a origem da cópia). */
  hookPath: string;
  out: (line: string) => void;
  /** Consulta o /api/health do Habblaud (testes injetam um falso). */
  health?: (port: number) => Promise<Health | undefined>;
}

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): RunOptions | 'help' {
  let command: RunOptions['command'] | undefined;
  let dryRun = false;
  const envPort = Number.parseInt(env.HABBLAUD_PORT ?? '', 10);
  let port = Number.isInteger(envPort) && envPort > 0 && envPort < 65_536 ? envPort : DEFAULT_PORT;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') return 'help';
    if (a === '--dry-run') dryRun = true;
    else if (a === '--port') {
      port = Number(argv[++i]);
      if (!Number.isInteger(port) || port <= 0 || port >= 65_536) throw new FatalError('--port precisa de um número entre 1 e 65535.');
    } else if ((a === 'install' || a === 'uninstall' || a === 'status') && !command) command = a;
    else throw new FatalError(`opção desconhecida: ${a}\n\n${USAGE}`);
  }
  if (!command) throw new FatalError(`diga o que fazer: install, uninstall ou status.\n\n${USAGE}`);
  return { command, dryRun, port };
}

export const hooksFile = (home: string): string => join(home, '.gemini', 'config', 'hooks.json');
export const hookCopy = (home: string): string => join(home, '.habblaud', 'antigravity-hook.mjs');
export const configPath = (home: string): string => join(home, '.habblaud', CONFIG_NAME);

type Json = Record<string, unknown>;

/** A entrada "habblaud" do hooks.json: os cinco eventos, no formato do agy (docs/hooks.md do agy 1.3.3). */
export function hookEntry(copyPath: string): Json {
  const handler = (event: string) => ({ type: 'command', command: `node ${copyPath} ${event}`, timeout: 10 });
  const entry: Json = {};
  for (const e of EVENTS_GROUPED) entry[e] = [{ matcher: '*', hooks: [handler(e)] }];
  for (const e of EVENTS_FLAT) entry[e] = [handler(e)];
  return entry;
}

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

/** O hooks.json: `{}` se não existe; objeto JSON; ou undefined se existe mas não é um objeto JSON (não se mexe). */
function readHooks(text: string | undefined): Json | undefined {
  if (text === undefined) return {};
  try {
    const j = JSON.parse(text) as unknown;
    return j && typeof j === 'object' && !Array.isArray(j) ? (j as Json) : undefined;
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

const hooksText = (h: Json): string => `${JSON.stringify(h, null, 2)}\n`;
const configText = (port: number): string => `${JSON.stringify({ port }, null, 2)}\n`;

function readConfigPort(home: string): number | undefined {
  try {
    const j = JSON.parse(readFileSync(configPath(home), 'utf8')) as { port?: unknown };
    return typeof j.port === 'number' ? j.port : undefined;
  } catch {
    return undefined;
  }
}

/** Executa o comando. Devolve o código de saída. */
export async function run(opts: RunOptions, ctx: RunContext): Promise<number> {
  const { home, out } = ctx;
  const hooks = hooksFile(home);
  const copy = hookCopy(home);
  const cfgFile = configPath(home);
  const hooksLabel = tildify(hooks, home);
  const copyLabel = tildify(copy, home);
  const cfgLabel = tildify(cfgFile, home);
  const source = readText(ctx.hookPath);
  const curHooksText = readText(hooks);
  const curHooks = readHooks(curHooksText);
  let failures = 0;

  if (opts.command === 'install') {
    if (source === undefined) {
      out(`✗ não achei o hook do repositório (${ctx.hookPath}).`);
      return 1;
    }
    if (/[\s"'$`\\]/.test(copy)) {
      out(`✗ o caminho ${copy} tem espaço ou aspas, e o agy parte o comando nos espaços sem tirar aspas: o hook não rodaria. Nada foi gravado.`);
      return 1;
    }
    if (curHooks === undefined) {
      out(`✗ ${hooksLabel} existe, mas não é um objeto JSON válido. Corrija ou mova o arquivo e rode de novo. Nada foi gravado.`);
      return 1;
    }
    const entry = hookEntry(copy);
    const nextHooks: Json = { ...curHooks, [HOOK_NAME]: entry };
    const steps: Array<{ label: string; file: string; text: string; same: boolean; existing: string | undefined; backup: boolean }> = [
      { label: copyLabel, file: copy, text: source, same: readText(copy) === source, existing: readText(copy), backup: true },
      { label: cfgLabel, file: cfgFile, text: configText(opts.port), same: readConfigPort(home) === opts.port, existing: readText(cfgFile), backup: true },
      { label: hooksLabel, file: hooks, text: hooksText(nextHooks), same: JSON.stringify(curHooks[HOOK_NAME]) === JSON.stringify(entry), existing: curHooksText, backup: true },
    ];
    let changed = 0;
    for (const s of steps) {
      if (s.same) {
        out(`= ${s.label}: já instalado`);
        continue;
      }
      if (opts.dryRun) {
        out(`~ ${s.label}: ${s.existing === undefined ? 'seria criado' : 'seria atualizado (com backup)'} (simulação: nada gravado)`);
        continue;
      }
      try {
        const backup = writeWithBackup(s.file, s.text, s.existing, ctx.now);
        out(`✓ ${s.label}: ${s.existing === undefined ? 'criado' : 'atualizado'}${backup ? ` · backup em ${tildify(backup, home)}` : ''}`);
        changed++;
      } catch (err) {
        out(`✗ ${s.label}: não consegui gravar (${(err as Error).message})`);
        failures++;
      }
    }
    if (changed && !opts.dryRun && !failures) {
      out('');
      out('Pronto. Abra uma nova sessão do agy (no agy, /hooks mostra o hook "habblaud" carregado). Com o Habblaud aberto,');
      out('o agente aparece no escritório quando você mandar o primeiro pedido. O hook só observa e nunca bloqueia o agy.');
      out('Para desfazer: npm run antigravity:uninstall');
    }
    return failures ? 1 : 0;
  }

  if (opts.command === 'uninstall') {
    let removed = 0;
    if (curHooks === undefined) {
      out(`✗ ${hooksLabel}: não é um objeto JSON válido; não mexi.`);
      failures++;
    } else if (!(HOOK_NAME in curHooks)) out(`= ${hooksLabel}: o hook "${HOOK_NAME}" não estava registrado`);
    else if (opts.dryRun) out(`~ ${hooksLabel}: o hook "${HOOK_NAME}" seria removido (simulação: nada removido)`);
    else {
      const { [HOOK_NAME]: _gone, ...rest } = curHooks;
      try {
        const backup = writeWithBackup(hooks, hooksText(rest), curHooksText, ctx.now);
        out(`✓ ${hooksLabel}: hook "${HOOK_NAME}" removido${backup ? ` · backup em ${tildify(backup, home)}` : ''}`);
        removed++;
      } catch (err) {
        out(`✗ ${hooksLabel}: não consegui gravar (${(err as Error).message})`);
        failures++;
      }
    }
    // Com o hooks.json sem mexer (inválido ou sem poder gravar), o hook pode seguir registrado: a cópia fica, para o comando não apontar para um arquivo que sumiu.
    for (const [file, label] of failures ? [] : ([[copy, copyLabel], [cfgFile, cfgLabel]] as const)) {
      if (!existsSync(file)) out(`= ${label}: não existia`);
      else if (opts.dryRun) out(`~ ${label}: seria removido (simulação: nada removido)`);
      else {
        rmSync(file);
        out(`✓ ${label}: removido`);
        removed++;
      }
    }
    if (failures) out('Arquivos de ~/.habblaud mantidos: corrija o hooks.json e rode o uninstall de novo.');
    if (removed) out('Os backups (*.habblaud-backup-*) ficam onde estão. Abra uma nova sessão do agy.');
    return failures ? 1 : 0;
  }

  // status
  const entry = hookEntry(copy);
  if (curHooks === undefined) out(`! ${hooksLabel}: existe, mas não é um objeto JSON válido`);
  else if (!(HOOK_NAME in curHooks)) out(`• ${hooksLabel}: hook "${HOOK_NAME}" não registrado (o agy não aparece no escritório sem ele)`);
  else if (JSON.stringify(curHooks[HOOK_NAME]) !== JSON.stringify(entry)) out(`! ${hooksLabel}: hook "${HOOK_NAME}" registrado, mas diferente do esperado; rode npm run antigravity:install para atualizar`);
  else out(`• ${hooksLabel}: hook "${HOOK_NAME}" registrado`);
  const cur = readText(copy);
  if (cur === undefined) out(`• ${copyLabel}: não instalado`);
  else if (source !== undefined && cur !== source) out(`! ${copyLabel}: diferente do hook deste repositório; rode npm run antigravity:install para atualizar`);
  else out(`• ${copyLabel}: instalado${source === undefined ? '' : ' e atualizado'}`);
  out(`Contrato dos hooks conferido no agy ${TESTED_AGY}; outra versão pode mudar o formato.`);
  const port = readConfigPort(home) ?? opts.port;
  const health = await (ctx.health ?? fetchHealth)(port);
  if (!health) out(`Habblaud em http://127.0.0.1:${port}: fora do ar (com ele parado, o hook não faz nada e o agy segue normal).`);
  else out(`Habblaud em http://127.0.0.1:${port}: ${health.antigravityEvents ? 'recebendo os eventos do Antigravity' : 'no ar, mas com o Antigravity desligado (HABBLAUD_ANTIGRAVITY=0)'}.`);
  return 0;
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed === 'help') {
    console.log(USAGE);
    return;
  }
  process.exitCode = await run(parsed, { home: process.env.HOME || homedir(), now: new Date(), hookPath: HOOK_SOURCE, out: (l) => console.log(l) });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((err: unknown) => {
    console.error(err instanceof FatalError ? `[antigravity] Erro: ${err.message}` : `[antigravity] Erro inesperado: ${String(err)}`);
    process.exitCode = 1;
  });
}
