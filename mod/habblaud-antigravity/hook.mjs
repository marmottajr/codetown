#!/usr/bin/env node
// Hook do Habblaud para o Antigravity CLI (`agy`): mostra no escritório o que as sessões do agy fazem. `npm run
// antigravity:install` copia este arquivo para ~/.habblaud/antigravity-hook.mjs e registra, no hooks.json do agy, um
// hook chamado "habblaud" para os cinco eventos, com comandos assim (o evento vai como argumento, porque o JSON do
// stdin não traz o nome dele; o caminho não tem espaço nem aspas, porque o agy parte o comando nos espaços):
//
//   node /home/ana/.habblaud/antigravity-hook.mjs PreToolUse
//
// Contrato do agy: docs/hooks.md embutido no binário (agy 1.3.3). Os hooks rodam em série e BLOQUEIAM o loop do agente;
// por isso, por padrão, este é só observador: manda o evento ao Habblaud em até 1,5 s e SAI COM 0 SEM IMPRIMIR NADA, em
// qualquer caso (Habblaud fora do ar, stdin ruim, evento desconhecido). Saída vazia + código 0 deixa o agy seguir o fluxo
// normal dele (a ferramenta roda ou ele pergunta, como sem o hook).
//
// Aprovar pelo escritório (opt-in, `npm run antigravity:install -- --aprovar`, que grava `approvals: true` na
// configuração): só no PreToolUse de `run_command`, o hook registra o pedido em /api/permissions e SEGURA o agente até a
// sua resposta no escritório (ou `permissionTimeoutS`). Spike S1 (agy 1.3.3, headless e TUI): `{}` faz o agy rodar o
// comando sem o prompt dele, `{"decision":"deny","reason":...}` bloqueia, e `{"decision":"allow"}`, `"ask"` e
// `permissionOverrides` NÃO aprovam. `{}` não é documentado pelo agy: por isso é opt-in e só para esta ferramenta. Sem
// resposta (ninguém olhando, tempo esgotado, Habblaud fora do ar) não se imprime nada e o agy mostra o prompt dele.
// Só se fala com 127.0.0.1.
//
// Privacidade: do stdin só saem o evento, `conversationId`, `workspacePaths`, `stepIdx`, `fullyIdle` e, no PreToolUse,
// o nome da ferramenta e UM texto curto (comando, caminho, padrão ou o resumo dela). O texto do pedido, a saída das
// ferramentas e o transcript nunca são lidos nem mandados.
// Configuração: ~/.habblaud/antigravity-hook.json ({port, approvals?, permissionTimeoutS?}, gravado pelo instalador);
// HABBLAUD_PORT como reserva da porta.
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
/** Ferramentas cujo pedido o escritório decide (só as que o spike S1 provou). */
export const APPROVAL_TOOLS = ['run_command'];
export const DEFAULT_WAIT_S = 25;
export const MIN_WAIT_S = 5;
export const MAX_WAIT_S = 120;
/** Registrar o pedido: se o Habblaud não responder nisso, ele está fora do ar (ou travado). */
const REGISTER_TIMEOUT_MS = 2_000;
/** Espera máxima de cada long-poll (o servidor responde "pending" e o hook pergunta de novo). */
const POLL_S = 25;
/** O comando completo vai ao cartão (é o que se aprova), cortado. */
const COMMAND_MAX = 8_000;
/** Campos dos args que dizem "o que a ferramenta está fazendo", do mais específico ao resumo que o próprio agy escreve. */
const HEAD_KEYS = ['CommandLine', 'AbsolutePath', 'TargetFile', 'DirectoryPath', 'SearchPath', 'Query', 'Pattern', 'Url', 'toolSummary'];

const debug = process.env.HABBLAUD_HOOK_DEBUG === '1' ? (msg) => process.stderr.write(`[habblaud-antigravity] ${msg}\n`) : () => {};

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const validPort = (p) => Number.isInteger(p) && p > 0 && p < 65_536;

/**
 * Configuração: ~/.habblaud/antigravity-hook.json ({port, approvals, permissionTimeoutS}); sem porta no arquivo,
 * HABBLAUD_PORT; senão os padrões. Aprovar só vale com `approvals: true`. Arquivo ausente ou ilegível = padrões.
 */
export function readConfig(env = process.env) {
  const home = env.HOME || homedir();
  let file;
  try {
    file = JSON.parse(readFileSync(join(home, '.habblaud', CONFIG_FILE), 'utf8'));
  } catch {
    file = undefined;
  }
  const f = isObject(file) ? file : {};
  const filePort = Number(f.port);
  const envPort = Number.parseInt(env.HABBLAUD_PORT ?? '', 10);
  const wait = Number(f.permissionTimeoutS);
  return {
    port: validPort(filePort) ? filePort : validPort(envPort) ? envPort : DEFAULT_PORT,
    approvals: f.approvals === true,
    waitMs: (Number.isFinite(wait) && wait > 0 ? Math.min(MAX_WAIT_S, Math.max(MIN_WAIT_S, wait)) : DEFAULT_WAIT_S) * 1_000,
  };
}

/** Só a porta (compatível com os testes anteriores). */
export function readPort(env = process.env) {
  return readConfig(env).port;
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

/** Corpo de POST /api/permissions: só o comando completo e a pasta (nada do transcript nem dos outros args). */
export function permissionBody(input, timeoutMs) {
  const command = isObject(input.toolCall?.args) && typeof input.toolCall.args.CommandLine === 'string' ? input.toolCall.args.CommandLine.slice(0, COMMAND_MAX) : '';
  const body = { provider: 'antigravity', session_id: input.conversationId, tool_name: input.toolCall.name, tool_input: { command }, timeout_ms: timeoutMs };
  const cwd = Array.isArray(input.workspacePaths) ? input.workspacePaths.find((p) => typeof p === 'string' && p) : undefined;
  if (cwd) body.cwd = cwd;
  return body;
}

/**
 * Saída do hook para uma decisão do Habblaud (undefined = não imprimir nada). Aprovar = `{}` (spike S1); recusar =
 * decision deny + reason. Qualquer outra coisa ("responder no terminal", liberado) = o agy decide.
 */
export function decisionOutput(result) {
  if (!result || result.status !== 'decided') return undefined;
  if (result.behavior === 'allow') return {};
  if (result.behavior === 'deny') {
    const reason = typeof result.message === 'string' && result.message.trim() ? result.message.trim().slice(0, 1_000) : '';
    return { decision: 'deny', reason: reason ? `Recusado pelo usuário no Habblaud: ${reason}` : 'Recusado pelo usuário no Habblaud.' };
  }
  return undefined;
}

/** Requisição ao Habblaud local; null = fora do ar, tempo esgotado ou resposta ilegível. */
async function call(base, method, path, body, timeoutMs) {
  try {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    return { status: res.status, json };
  } catch (err) {
    debug(`${method} ${path}: ${err?.name ?? 'erro'} ${err?.message ?? ''}`);
    return null;
  }
}

/** Registra o pedido e espera a decisão do escritório. Devolve a saída a imprimir, ou undefined. */
async function approve(base, input, startedAt, waitMs) {
  const deadline = startedAt + waitMs;
  const reg = await call(base, 'POST', '/api/permissions', permissionBody(input, Math.max(0, deadline - Date.now())), REGISTER_TIMEOUT_MS);
  if (!reg || reg.status !== 201 || typeof reg.json?.id !== 'string') {
    debug(`sem desvio (${reg ? `${reg.status} ${JSON.stringify(reg.json ?? null)}` : 'Habblaud fora do ar'})`);
    return undefined;
  }
  const id = encodeURIComponent(reg.json.id);
  for (;;) {
    const left = deadline - Date.now();
    if (left <= 0) {
      debug('tempo esgotado: vale o prompt do agy');
      return undefined;
    }
    const waitS = Math.max(0.05, Math.min(POLL_S, left / 1_000));
    const r = await call(base, 'GET', `/api/permissions/${id}/wait?timeout=${waitS}`, undefined, waitS * 1_000 + 5_000);
    if (!r || r.status !== 200) return undefined;
    if (r.json?.status === 'pending') continue;
    debug(`resposta: ${JSON.stringify(r.json)}`);
    return decisionOutput(r.json);
  }
}

/** Manda o evento e, com aprovações ligadas, decide o `run_command` (ou não). Devolve a saída a imprimir, ou undefined. Nunca lança. */
export async function run(event, raw, env = process.env) {
  const startedAt = Date.now();
  try {
    let input;
    try {
      input = JSON.parse(raw);
    } catch {
      debug('stdin não é JSON');
      return undefined;
    }
    const body = eventBody(event, input);
    if (!body) {
      debug(`evento ou stdin ignorado (${event})`);
      return undefined;
    }
    const cfg = readConfig(env);
    const base = `http://127.0.0.1:${cfg.port}`;
    const sent = await call(base, 'POST', '/api/antigravity/events', body, EVENT_TIMEOUT_MS);
    debug(`${event}: ${sent ? `HTTP ${sent.status}` : 'Habblaud fora do ar'}`);
    if (!cfg.approvals || event !== 'PreToolUse' || !sent || !APPROVAL_TOOLS.includes(body.tool?.name)) return undefined;
    return await approve(base, input, startedAt, cfg.waitMs);
  } catch (err) {
    debug(`erro: ${err?.message ?? err}`);
    return undefined;
  }
}

export async function main() {
  const { approvals, waitMs } = readConfig();
  // Rede de segurança: nada mantém o processo vivo além do prazo (o do envio; com aprovações, mais a espera).
  setTimeout(() => process.exit(0), EVENT_TIMEOUT_MS + STDIN_TIMEOUT_MS + 500 + (approvals ? waitMs + 10_000 : 0)).unref();
  const out = await run(process.argv[2], await readStdin());
  // Sem process.exit() logo depois do fetch (nodejs/node#56645, Windows): o processo sai quando o loop esvazia, o que
  // também espera a escrita da decisão no pipe; se algo ainda segurar o loop, o process.exit vem 1 s depois.
  const finish = () => setTimeout(() => process.exit(0), 1_000).unref();
  if (out) process.stdout.write(JSON.stringify(out), finish);
  else finish();
}

function isMain() {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) main().catch(() => process.exit(0));
