// Instala (ou remove) o hook do Habblaud no Antigravity CLI (`agy`). Roda no HOST, com tsx:
//
//   npm run antigravity:install     # registra o hook "habblaud" no hooks.json do agy e copia o script
//   npm run antigravity:uninstall   # remove só o que a instalação acrescentou
//   npm run antigravity:status      # mostra se o hook está registrado e atualizado, e se o Habblaud responde
//   (opções: --dry-run, --port <n>, --aprovar, --espera <s>, --uso)
//
// O hook (mod/habblaud-antigravity/hook.mjs) manda ao escritório, na hora, o que as sessões do agy fazem. Por padrão só
// observa: não imprime nada e sai com 0 (o agy bloqueia o agente enquanto o hook roda, ver o cabeçalho do hook). Com
// `--aprovar` ele também segura cada `run_command` até você aprovar ou recusar no escritório (`approvals: true` na
// configuração, e o timeout do hook do PreToolUse sobe para a espera + 8 s; o timeout do agy é em segundos). É uma CÓPIA do
// arquivo, para continuar funcionando se o repositório mudar de lugar: depois de atualizar o Habblaud, rode
// npm run antigravity:install de novo (o status avisa quando a cópia ficou para trás).
//
// Com `--uso` ele também mostra a cota (a do /usage do agy) no cartão de uso: copia mod/habblaud-antigravity/statusline.mjs
// para ~/.habblaud/antigravity-statusline.mjs e acrescenta um `statusLine` (com `stack_with_default`, a linha padrão do agy
// continua) em ~/.gemini/antigravity-cli/settings.json, com backup. Se o settings.json já tem um statusLine que não é do
// Habblaud, ele NÃO é trocado (o instalador avisa e sai com 1). Sem `--uso` o settings.json nunca é tocado.
//
// Arquivos: o hooks.json que o agy carrega (~/.gemini/config/hooks.json, confirmado no agy 1.3.3 pelo log dele), a cópia
// ~/.habblaud/antigravity-hook.mjs e ~/.habblaud/antigravity-hook.json ({port}). No hooks.json entra uma chave só,
// "habblaud", com os cinco eventos; os outros hooks ficam como estão. Antes de mudar o hooks.json, uma cópia vai para
// <arquivo>.habblaud-backup-<data>. Um hooks.json que não é um objeto JSON é recusado sem gravar nada. O agy parte o
// comando nos espaços e não tira aspas: por isso o caminho da cópia não pode ter espaço nem aspas (a instalação para).
// Nunca toca em settings.json, no token de login nem nas conversas do agy.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tildify } from './statusline-install';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const HOOK_SOURCE = join(ROOT, 'mod', 'habblaud-antigravity', 'hook.mjs');
export const STATUSLINE_SOURCE = join(ROOT, 'mod', 'habblaud-antigravity', 'statusline.mjs');
/** O statusLine só é considerado do Habblaud se o comando tiver isto. */
const STATUSLINE_MARK = 'antigravity-statusline.mjs';
export const DEFAULT_PORT = 4747;
export const CONFIG_NAME = 'antigravity-hook.json';
export const HOOK_NAME = 'habblaud';
/** Versão do agy em que o contrato dos hooks foi conferido. */
export const TESTED_AGY = '1.3.3';
export const DEFAULT_WAIT_S = 25;
export const MIN_WAIT_S = 5;
export const MAX_WAIT_S = 120;
/** Timeout (segundos) dos hooks que só observam. */
const OBSERVE_TIMEOUT_S = 10;
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
  --aprovar        também aprovar ou recusar os comandos (run_command) pelo escritório: o hook segura o comando até a
                   sua resposta. Sem a opção, o hook só observa (rodar de novo sem ela desliga). Usa o comportamento
                   \`{}\` do agy, que a documentação dele não descreve (conferido no agy ${TESTED_AGY}).
  --uso            também mostrar a cota (a do /usage do agy) no cartão de uso: acrescenta um statusLine no
                   ~/.gemini/antigravity-cli/settings.json (com backup; um statusLine que já exista e não seja do Habblaud
                   não é trocado)
  --espera <s>     quanto o hook espera a sua resposta antes de deixar o agy perguntar (padrão: ${DEFAULT_WAIT_S} s; de
                   ${MIN_WAIT_S} a ${MAX_WAIT_S}); só vale com --aprovar
  -h, --help       mostra esta ajuda

Depois de instalar, abra uma nova sessão do agy (use /hooks nele para ver o hook carregado).`;

class FatalError extends Error {}

export interface RunOptions {
  command: 'install' | 'uninstall' | 'status';
  dryRun: boolean;
  port: number;
  approvals: boolean;
  waitS: number;
  usage: boolean;
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
  /** O statusline do repositório (a origem da cópia, com --uso). */
  statuslinePath?: string;
  out: (line: string) => void;
  /** Variáveis de ambiente (HABBLAUD_USAGE_DIR muda a pasta do arquivo de cota); ausente = a pasta padrão. */
  env?: NodeJS.ProcessEnv;
  /** Consulta o /api/health do Habblaud (testes injetam um falso). */
  health?: (port: number) => Promise<Health | undefined>;
}

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): RunOptions | 'help' {
  let command: RunOptions['command'] | undefined;
  let dryRun = false;
  const envPort = Number.parseInt(env.HABBLAUD_PORT ?? '', 10);
  let port = Number.isInteger(envPort) && envPort > 0 && envPort < 65_536 ? envPort : DEFAULT_PORT;
  let approvals = false;
  let usage = false;
  let waitS = DEFAULT_WAIT_S;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') return 'help';
    if (a === '--dry-run') dryRun = true;
    else if (a === '--port') {
      port = Number(argv[++i]);
      if (!Number.isInteger(port) || port <= 0 || port >= 65_536) throw new FatalError('--port precisa de um número entre 1 e 65535.');
    } else if (a === '--aprovar') approvals = true;
    else if (a === '--uso') usage = true;
    else if (a === '--espera') {
      waitS = Number(argv[++i]);
      if (!Number.isInteger(waitS) || waitS < MIN_WAIT_S || waitS > MAX_WAIT_S) throw new FatalError(`--espera precisa de um número de segundos entre ${MIN_WAIT_S} e ${MAX_WAIT_S}.`);
    } else if ((a === 'install' || a === 'uninstall' || a === 'status') && !command) command = a;
    else throw new FatalError(`opção desconhecida: ${a}\n\n${USAGE}`);
  }
  if (!command) throw new FatalError(`diga o que fazer: install, uninstall ou status.\n\n${USAGE}`);
  return { command, dryRun, port, approvals, waitS, usage };
}

export const hooksFile = (home: string): string => join(home, '.gemini', 'config', 'hooks.json');
export const hookCopy = (home: string): string => join(home, '.habblaud', 'antigravity-hook.mjs');
export const configPath = (home: string): string => join(home, '.habblaud', CONFIG_NAME);
export const statuslineCopy = (home: string): string => join(home, '.habblaud', 'antigravity-statusline.mjs');
export const settingsFile = (home: string): string => join(home, '.gemini', 'antigravity-cli', 'settings.json');
export const quotaFile = (home: string, env: NodeJS.ProcessEnv = {}): string => join(usageDirOf(home, env), 'antigravity-quota.json');
/** Pasta do uso: HABBLAUD_USAGE_DIR (a mesma que o statusline e o servidor respeitam) ou ~/.habblaud/usage. */
const usageDirOf = (home: string, env: NodeJS.ProcessEnv): string => env.HABBLAUD_USAGE_DIR?.trim() || join(home, '.habblaud', 'usage');

/** O statusLine que o Habblaud põe no settings.json do agy. */
export const statusLineEntry = (copyPath: string): Json => ({ type: 'command', command: `node ${copyPath}`, stack_with_default: true });

/** É do Habblaud se o comando termina no nome da cópia (e não só o contém, ex.: `meu-antigravity-statusline.mjs.sh`). */
const OUR_COMMAND_RE = new RegExp(`(^|[\\s/\\\\'"])${STATUSLINE_MARK.replace(/\./g, '\\.')}['"]?\\s*$`);
const isOurStatusLine = (v: unknown): boolean => !!v && typeof v === 'object' && typeof (v as Json).command === 'string' && OUR_COMMAND_RE.test((v as Json).command as string);

type Json = Record<string, unknown>;

/** A entrada "habblaud" do hooks.json: os cinco eventos, no formato do agy (docs/hooks.md do agy 1.3.3). */
export function hookEntry(copyPath: string, preToolTimeoutS = OBSERVE_TIMEOUT_S): Json {
  const handler = (event: string, timeout: number) => ({ type: 'command', command: `node ${copyPath} ${event}`, timeout });
  const entry: Json = {};
  for (const e of EVENTS_GROUPED) entry[e] = [{ matcher: '*', hooks: [handler(e, e === 'PreToolUse' ? preToolTimeoutS : OBSERVE_TIMEOUT_S)] }];
  for (const e of EVENTS_FLAT) entry[e] = [handler(e, OBSERVE_TIMEOUT_S)];
  return entry;
}

/** O que a configuração do hook guarda e o timeout do PreToolUse que ela pede (a espera + 8 s com aprovações (margem para o envio, o registro e a última rodada da espera)). */
export interface HookConfig {
  port: number;
  approvals?: true;
  permissionTimeoutS?: number;
}
export const preToolTimeout = (cfg: Pick<HookConfig, 'approvals' | 'permissionTimeoutS'>): number => (cfg.approvals ? (cfg.permissionTimeoutS ?? DEFAULT_WAIT_S) + 8 : OBSERVE_TIMEOUT_S);

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
const configOf = (opts: Pick<RunOptions, 'port' | 'approvals' | 'waitS'>): HookConfig => (opts.approvals ? { port: opts.port, approvals: true, permissionTimeoutS: opts.waitS } : { port: opts.port });
const configText = (cfg: HookConfig): string => `${JSON.stringify(cfg, null, 2)}\n`;

/** A configuração gravada (undefined = não existe ou ilegível). */
export function readHookConfig(home: string): Partial<HookConfig> | undefined {
  try {
    const j = JSON.parse(readFileSync(configPath(home), 'utf8')) as unknown;
    if (!j || typeof j !== 'object' || Array.isArray(j)) return undefined;
    const r = j as Record<string, unknown>;
    const out: Partial<HookConfig> = {};
    if (typeof r.port === 'number') out.port = r.port;
    if (r.approvals === true) out.approvals = true;
    if (typeof r.permissionTimeoutS === 'number') out.permissionTimeoutS = r.permissionTimeoutS;
    return out;
  } catch {
    return undefined;
  }
}

function readConfigPort(home: string): number | undefined {
  return readHookConfig(home)?.port;
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
    const cfg = configOf(opts);
    const entry = hookEntry(copy, preToolTimeout(cfg));
    const nextHooks: Json = { ...curHooks, [HOOK_NAME]: entry };
    const steps: Array<{ label: string; file: string; text: string; same: boolean; existing: string | undefined; backup: boolean }> = [
      { label: copyLabel, file: copy, text: source, same: readText(copy) === source, existing: readText(copy), backup: true },
      { label: cfgLabel, file: cfgFile, text: configText(cfg), same: JSON.stringify(readHookConfig(home)) === JSON.stringify(cfg), existing: readText(cfgFile), backup: true },
      { label: hooksLabel, file: hooks, text: hooksText(nextHooks), same: JSON.stringify(curHooks[HOOK_NAME]) === JSON.stringify(entry), existing: curHooksText, backup: true },
    ];
    let failures0 = 0;
    if (opts.usage) {
      const slSource = readText(ctx.statuslinePath ?? STATUSLINE_SOURCE);
      const settings = settingsFile(home);
      const settingsText = readText(settings);
      const parsed = readHooks(settingsText);
      const settingsLabel = tildify(settings, home);
      const slCopy = statuslineCopy(home);
      if (slSource === undefined) {
        out(`✗ não achei o statusline do repositório; o uso não foi instalado.`);
        failures0++;
      } else if (/[\s"'$`\\]/.test(slCopy)) {
        out(`✗ o caminho ${slCopy} tem espaço ou aspas: o statusline não rodaria. O uso não foi instalado.`);
        failures0++;
      } else if (parsed === undefined) {
        out(`✗ ${settingsLabel} existe, mas não é um objeto JSON válido. O uso não foi instalado.`);
        failures0++;
      } else if (parsed.statusLine !== undefined && !isOurStatusLine(parsed.statusLine)) {
        out(`✗ ${settingsLabel} já tem um statusLine que não é do Habblaud; não troquei. O uso não foi instalado (encadeie o seu comando com o statusline do Habblaud ou remova o seu).`);
        failures0++;
      } else {
        const wanted = statusLineEntry(slCopy);
        steps.push(
          { label: tildify(slCopy, home), file: slCopy, text: slSource, same: readText(slCopy) === slSource, existing: readText(slCopy), backup: true },
          { label: settingsLabel, file: settings, text: hooksText({ ...parsed, statusLine: wanted }), same: JSON.stringify(parsed.statusLine) === JSON.stringify(wanted), existing: settingsText, backup: true },
        );
      }
    }
    let changed = 0;
    failures += failures0;
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
      if (opts.approvals) {
        out('o agente aparece no escritório quando você mandar o primeiro pedido. Com página do Habblaud aberta, cada comando (run_command)');
        out(`espera sua resposta lá por até ${opts.waitS} s; sem resposta, o agy mostra o prompt dele. Isso usa o comportamento \`{}\` do agy (não documentado; conferido no agy ${TESTED_AGY}).`);
      } else out('o agente aparece no escritório quando você mandar o primeiro pedido. O hook só observa e nunca bloqueia o agy.');
      if (opts.usage && failures === 0) out('Uso: a cota do agy aparece no cartão do Antigravity depois que o agy renderizar a primeira tela (abra o agy).');
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
    // O statusLine do uso (--uso): sai só se for do Habblaud; o de outra pessoa nunca é tocado.
    {
      const settings = settingsFile(home);
      const settingsText = readText(settings);
      const parsed = readHooks(settingsText);
      const label = tildify(settings, home);
      if (settingsText !== undefined && parsed === undefined) out(`= ${label}: não é um objeto JSON válido; não mexi.`);
      else if (parsed === undefined || !isOurStatusLine(parsed.statusLine)) out(`= ${label}: sem statusLine do Habblaud`);
      else if (opts.dryRun) out(`~ ${label}: o statusLine do Habblaud seria removido (simulação: nada removido)`);
      else {
        const { statusLine: _sl, ...rest } = parsed;
        try {
          const backup = writeWithBackup(settings, hooksText(rest), settingsText, ctx.now);
          out(`✓ ${label}: statusLine do Habblaud removido${backup ? ` · backup em ${tildify(backup, home)}` : ''}`);
          removed++;
        } catch (err) {
          out(`✗ ${label}: não consegui gravar (${(err as Error).message})`);
          failures++;
        }
      }
    }
    // Com o hooks.json sem mexer (inválido ou sem poder gravar), o hook pode seguir registrado: a cópia fica, para o comando não apontar para um arquivo que sumiu.
    // O arquivo de cota sai da pasta de HABBLAUD_USAGE_DIR (se houver) e da padrão, sem repetir.
    const quotas = [...new Set([quotaFile(home, ctx.env), quotaFile(home)])];
    const extra = [[statuslineCopy(home), tildify(statuslineCopy(home), home)], ...quotas.map((q) => [q, tildify(q, home)] as const)] as const;
    for (const [file, label] of failures ? [] : ([[copy, copyLabel], [cfgFile, cfgLabel], ...extra] as const)) {
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
  const stored = readHookConfig(home);
  const entry = hookEntry(copy, preToolTimeout(stored ?? {}));
  if (curHooks === undefined) out(`! ${hooksLabel}: existe, mas não é um objeto JSON válido`);
  else if (!(HOOK_NAME in curHooks)) out(`• ${hooksLabel}: hook "${HOOK_NAME}" não registrado (o agy não aparece no escritório sem ele)`);
  else if (JSON.stringify(curHooks[HOOK_NAME]) !== JSON.stringify(entry)) out(`! ${hooksLabel}: hook "${HOOK_NAME}" registrado, mas diferente do esperado; rode npm run antigravity:install para atualizar`);
  else out(`• ${hooksLabel}: hook "${HOOK_NAME}" registrado`);
  const cur = readText(copy);
  if (cur === undefined) out(`• ${copyLabel}: não instalado`);
  else if (source !== undefined && cur !== source) out(`! ${copyLabel}: diferente do hook deste repositório; rode npm run antigravity:install para atualizar`);
  else out(`• ${copyLabel}: instalado${source === undefined ? '' : ' e atualizado'}`);
  out(`Contrato dos hooks conferido no agy ${TESTED_AGY}; outra versão pode mudar o formato.`);
  out(
    stored?.approvals
      ? `Aprovar pelo escritório: ligado (espera ${stored.permissionTimeoutS ?? DEFAULT_WAIT_S} s; só run_command). Para desligar: npm run antigravity:install sem --aprovar.`
      : 'Aprovar pelo escritório: desligado (o hook só observa). Para ligar: npm run antigravity:install -- --aprovar.',
  );
  {
    const settings = settingsFile(home);
    const parsed = readHooks(readText(settings));
    const label = tildify(settings, home);
    const slCopyText = readText(statuslineCopy(home));
    const slSource = readText(ctx.statuslinePath ?? STATUSLINE_SOURCE);
    if (parsed === undefined) out(`• Uso (cota do /usage): ${label} ${existsSync(settings) ? 'não é um objeto JSON válido' : 'não existe'}; desligado. Para ligar: npm run antigravity:install -- --uso.`);
    else if (parsed.statusLine === undefined) out('• Uso (cota do /usage): desligado. Para ligar: npm run antigravity:install -- --uso.');
    else if (!isOurStatusLine(parsed.statusLine)) out(`• Uso (cota do /usage): ${label} tem um statusLine que não é do Habblaud; o uso não é lido.`);
    else if (JSON.stringify(parsed.statusLine) !== JSON.stringify(statusLineEntry(statuslineCopy(home))) || (slSource !== undefined && slCopyText !== slSource)) out('! Uso (cota do /usage): ligado, mas diferente do esperado ou desatualizado; rode npm run antigravity:install -- --uso para atualizar.');
    else {
      let age = 'ainda sem leitura (abra o agy)';
      try {
        const sec = Math.max(0, Math.round((Date.now() - statSync(quotaFile(home, ctx.env)).mtimeMs) / 1000));
        age = sec < 90 ? `última leitura há ${sec} s` : `última leitura há ${Math.round(sec / 60)} min`;
      } catch {
        // sem arquivo ainda
      }
      out(`• Uso (cota do /usage): ligado; ${age}.`);
    }
  }
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
  process.exitCode = await run(parsed, { home: process.env.HOME || homedir(), now: new Date(), hookPath: HOOK_SOURCE, out: (l) => console.log(l), env: process.env });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((err: unknown) => {
    console.error(err instanceof FatalError ? `[antigravity] Erro: ${err.message}` : `[antigravity] Erro inesperado: ${String(err)}`);
    process.exitCode = 1;
  });
}
