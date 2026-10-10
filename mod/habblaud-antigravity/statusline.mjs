#!/usr/bin/env node
// Statusline do Habblaud para o Antigravity CLI (`agy`): guarda as cotas de uso (as mesmas do /usage do agy) para o
// cartão de uso do escritório. `npm run antigravity:install -- --uso` copia este arquivo para
// ~/.habblaud/antigravity-statusline.mjs e acrescenta no ~/.gemini/antigravity-cli/settings.json (com backup):
//
//   "statusLine": {"type": "command", "command": "node /home/ana/.habblaud/antigravity-statusline.mjs", "stack_with_default": true}
//
// O agy manda a este comando, pelo stdin e a cada renderização do TUI, um JSON com `quota`
// ({"<cota>": {remaining_fraction, reset_time, reset_in_seconds}}), `plan_tier`, o e-mail, a pasta e o caminho do
// transcript (docs: antigravity.google/docs/cli/statusline.md; formato conferido no agy 1.3.3). Este script grava em
// <HABBLAUD_USAGE_DIR ou ~/.habblaud/usage>/antigravity-quota.json SÓ {fetchedAt, planTier, quota: {<cota>:
// {remaining_fraction, reset_time}}}: o e-mail, a pasta, o transcript e todo o resto são descartados, e nenhum token de
// login é lido. Não imprime nada (com `stack_with_default` o agy mantém a linha padrão dele) e sai SEMPRE com 0: uma
// falha aqui nunca pode quebrar nem atrasar a tela do agy.
import { mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const QUOTA_FILE = 'antigravity-quota.json';
/** Os mesmos números gravados há menos que isto não são regravados (o agy renderiza o statusline várias vezes por segundo). */
const MIN_REWRITE_MS = 10_000;
const STDIN_TIMEOUT_MS = 1_000;
const MAX_STDIN = 512 * 1024;
const MAX_BUCKETS = 12;

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** Pasta do uso: HABBLAUD_USAGE_DIR ou ~/.habblaud/usage (a mesma do Claude Code e do servidor). */
export function usageDir(env = process.env) {
  const own = typeof env.HABBLAUD_USAGE_DIR === 'string' ? env.HABBLAUD_USAGE_DIR.trim() : '';
  return own || join(env.HOME || homedir(), '.habblaud', 'usage');
}

/** O corpo a gravar: só as cotas e o plano; undefined se o JSON não traz nenhuma cota com número. */
export function quotaBody(input, now = Date.now()) {
  if (!isObject(input) || !isObject(input.quota)) return undefined;
  const quota = {};
  for (const [key, v] of Object.entries(input.quota).slice(0, MAX_BUCKETS)) {
    if (!isObject(v) || typeof v.remaining_fraction !== 'number' || !Number.isFinite(v.remaining_fraction)) continue;
    const bucket = { remaining_fraction: v.remaining_fraction };
    if (typeof v.reset_time === 'string' && v.reset_time.length <= 40) bucket.reset_time = v.reset_time;
    quota[key.slice(0, 40)] = bucket;
  }
  if (!Object.keys(quota).length) return undefined;
  const body = { fetchedAt: now, quota };
  if (typeof input.plan_tier === 'string' && input.plan_tier.trim()) body.planTier = input.plan_tier.trim().slice(0, 60);
  return body;
}

/** Grava (com troca atômica), a menos que seja o mesmo número e o arquivo seja recente. Devolve true se gravou. */
export function save(body, dir, now = Date.now()) {
  const file = join(dir, QUOTA_FILE);
  try {
    const prev = JSON.parse(readFileSync(file, 'utf8'));
    const age = now - statSync(file).mtimeMs;
    if (age >= 0 && age < MIN_REWRITE_MS && JSON.stringify(prev?.quota) === JSON.stringify(body.quota) && prev?.planTier === body.planTier) return false;
  } catch {
    // não existe ou ilegível: grava
  }
  mkdirSync(dir, { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(body)}\n`, { mode: 0o644 });
  renameSync(tmp, file);
  return true;
}

function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    const done = (text) => {
      clearTimeout(timer);
      resolve(text);
    };
    const timer = setTimeout(() => done(''), STDIN_TIMEOUT_MS);
    process.stdin.on('data', (c) => {
      size += c.length;
      if (size > MAX_STDIN) return done('');
      chunks.push(c);
    });
    process.stdin.on('end', () => done(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', () => done(''));
  });
}

/** Lê o JSON do agy e grava as cotas. Nunca lança. */
export async function run(raw, env = process.env, now = Date.now()) {
  try {
    const body = quotaBody(JSON.parse(raw), now);
    if (body) save(body, usageDir(env), now);
  } catch {
    // JSON ruim ou pasta sem permissão: o statusline do agy segue como se nada tivesse acontecido
  }
}

export async function main() {
  setTimeout(() => process.exit(0), STDIN_TIMEOUT_MS + 1_000).unref();
  await run(await readStdin());
  setTimeout(() => process.exit(0), 500).unref();
}

function isMain() {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) main().catch(() => process.exit(0));
