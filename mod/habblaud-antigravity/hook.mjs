#!/usr/bin/env node
// Hook do Habblaud para o Antigravity CLI (`agy`): mostra no escritório o que as sessões do agy fazem. `npm run
// antigravity:install` copia este arquivo para ~/.habblaud/antigravity-hook.mjs e registra, no hooks.json do agy, um
// hook chamado "habblaud" para os cinco eventos, com comandos assim (o evento vai como argumento, porque o JSON do
// stdin não traz o nome dele; o caminho não tem espaço nem aspas, porque o agy parte o comando nos espaços):
//
//   node /home/ana/.habblaud/antigravity-hook.mjs PreToolUse
//
// Contrato do agy: docs/hooks.md embutido no binário (agy 1.3.3). Os hooks rodam em série e BLOQUEIAM o loop do agente;
// por isso este é só observador: manda o evento ao Habblaud em até 1,5 s e SAI COM 0 SEM IMPRIMIR NADA, em qualquer
// caso (Habblaud fora do ar, stdin ruim, evento desconhecido). Saída vazia + código 0 deixa a ferramenta rodar
// (medido no agy 1.3.3); `{"decision": "allow"}` não aprova nada e `{}` já foi relatado como recusa no Windows, então
// nunca se imprime decisão. Só se fala com 127.0.0.1.
//
// Privacidade: do stdin só saem o evento, `conversationId`, `workspacePaths`, `stepIdx`, `fullyIdle` e, no PreToolUse,
// o nome da ferramenta e UM texto curto (comando, caminho, padrão ou o resumo dela). O texto do pedido, a saída das
// ferramentas e o transcript nunca são lidos nem mandados.
// Porta: ~/.habblaud/antigravity-hook.json ({port}, gravado pelo instalador); HABBLAUD_PORT como reserva.
// HABBLAUD_HOOK_DEBUG=1 escreve o que acontece no stderr.
import { readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_PORT = 4747;
export const CONFIG_FILE = 'antigravity-hook.json';
export const EVENTS = ['PreInvocation', 'PostInvocation', 'PreToolUse', 'PostToolUse', 'Stop'];
/** Prazo do envio: o hook bloqueia o agente, então não pode esperar um Habblaud travado. */
const EVENT_TIMEOUT_MS = 1_500;
const STDIN_TIMEOUT_MS = 1_000;
const MAX_STDIN = 2 * 1024 * 1024;
const HEAD_MAX = 200;
/** Campos dos args que dizem "o que a ferramenta está fazendo", do mais específico ao resumo que o próprio agy escreve. */
const HEAD_KEYS = ['CommandLine', 'AbsolutePath', 'TargetFile', 'DirectoryPath', 'SearchPath', 'Query', 'Pattern', 'Url', 'toolSummary'];

const debug = process.env.HABBLAUD_HOOK_DEBUG === '1' ? (msg) => process.stderr.write(`[habblaud-antigravity] ${msg}\n`) : () => {};

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const validPort = (p) => Number.isInteger(p) && p > 0 && p < 65_536;

/** Porta: ~/.habblaud/antigravity-hook.json; sem ela, HABBLAUD_PORT; senão a padrão. */
export function readPort(env = process.env) {
  const home = env.HOME || homedir();
  let file;
  try {
    file = JSON.parse(readFileSync(join(home, '.habblaud', CONFIG_FILE), 'utf8'));
  } catch {
    file = undefined;
  }
  const filePort = isObject(file) ? Number(file.port) : NaN;
  const envPort = Number.parseInt(env.HABBLAUD_PORT ?? '', 10);
  return validPort(filePort) ? filePort : validPort(envPort) ? envPort : DEFAULT_PORT;
}

/** O único texto curto dos args: o primeiro campo conhecido que for texto não vazio, cortado e em uma linha. */
export function headOf(args) {
  if (!isObject(args)) return undefined;
  for (const k of HEAD_KEYS) {
    const v = args[k];
    if (typeof v === 'string' && v.trim()) return v.trim().split(/\r?\n/)[0].slice(0, HEAD_MAX);
  }
  return undefined;
}

/** Corpo mandado ao Habblaud; undefined se o evento ou o stdin não servem (então nada é mandado). */
export function eventBody(event, input) {
  if (!EVENTS.includes(event) || !isObject(input)) return undefined;
  if (typeof input.conversationId !== 'string' || !input.conversationId) return undefined;
  const body = {
    event,
    conversationId: input.conversationId,
    workspacePaths: Array.isArray(input.workspacePaths) ? input.workspacePaths.filter((p) => typeof p === 'string').slice(0, 8) : [],
  };
  if (Number.isInteger(input.stepIdx)) body.stepIdx = input.stepIdx;
  if (typeof input.fullyIdle === 'boolean') body.fullyIdle = input.fullyIdle;
  if (event === 'PreToolUse' && isObject(input.toolCall) && typeof input.toolCall.name === 'string') {
    const head = headOf(input.toolCall.args);
    body.tool = { name: input.toolCall.name.slice(0, 80), ...(head ? { head } : {}) };
  }
  return body;
}

/** Lê o stdin inteiro (com prazo e teto); vazio se não vier nada. */
function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    const done = () => resolve(Buffer.concat(chunks).toString('utf8'));
    const timer = setTimeout(() => {
      process.stdin.destroy();
      done();
    }, STDIN_TIMEOUT_MS);
    timer.unref();
    process.stdin.on('data', (c) => {
      size += c.length;
      if (size > MAX_STDIN) {
        process.stdin.destroy();
        clearTimeout(timer);
        resolve('');
      } else chunks.push(c);
    });
    process.stdin.on('end', () => {
      clearTimeout(timer);
      done();
    });
    process.stdin.on('error', () => {
      clearTimeout(timer);
      resolve('');
    });
  });
}

export async function run(event, raw, env = process.env) {
  try {
    let input;
    try {
      input = JSON.parse(raw);
    } catch {
      debug('stdin não é JSON');
      return;
    }
    const body = eventBody(event, input);
    if (!body) {
      debug(`evento ou stdin ignorado (${event})`);
      return;
    }
    const res = await fetch(`http://127.0.0.1:${readPort(env)}/api/antigravity/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(EVENT_TIMEOUT_MS),
    });
    debug(`${event}: HTTP ${res.status}`);
  } catch (err) {
    debug(`erro: ${err?.message ?? err}`);
  }
}

export async function main() {
  // Rede de segurança: nada mantém o processo vivo além do prazo do envio.
  setTimeout(() => process.exit(0), EVENT_TIMEOUT_MS + STDIN_TIMEOUT_MS + 500).unref();
  await run(process.argv[2], await readStdin());
  // Sem process.exit() logo depois do fetch (nodejs/node#56645, Windows): o processo sai quando o loop esvazia.
  setTimeout(() => process.exit(0), 1_000).unref();
}

function isMain() {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) main().catch(() => process.exit(0));
