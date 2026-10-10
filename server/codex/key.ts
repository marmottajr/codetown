// Chave local do hook do Codex: um segredo de 32 bytes em ~/.habblaud/codex-hook.key, a pasta do codex-hook.json que o
// hook já lê (fora do CODEX_HOME). Fora do Docker o servidor cria a chave se faltar; no Docker, o docker:up a cria no host
// e a monta somente leitura no container (HABBLAUD_CODEX_HOOK_KEY). Cada chamada do hook leva um nonce
// (`<epoch ms>.<16 bytes hex>`) e a prova HMAC dele; o servidor confere idade, reuso e prova (em tempo constante) e
// responde com a própria prova do mesmo nonce, para o hook saber que fala com o Habblaud desta máquina, e não com quem
// ocupou a porta. Nada aqui lança.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const HOOK_KEY_FILE = 'codex-hook.key';
export const PROOF_HEADER = 'x-habblaud-proof';
export const NONCE_HEADER = 'x-habblaud-nonce';
/** Nonce = `<epoch ms>.<16 bytes hex>`; vale por NONCE_MAX_AGE_MS e uma vez só. */
export const NONCE_MAX_AGE_MS = 60_000;

const KEY_BYTES = 32;
const NONCE_RE = /^(\d{1,16})\.[0-9a-f]{32}$/;
const PROOF_RE = /^[0-9a-f]{64}$/;

/** A chave em `file`, só se tiver exatamente 32 bytes. */
function readKey(file: string): Buffer | undefined {
  try {
    const key = readFileSync(file);
    return key.length === KEY_BYTES ? key : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Lê `<dir>/codex-hook.key` (32 bytes). create=true cria (aleatório, modo 0600) se faltar. undefined = ausente/ilegível.
 * dir = `~/.habblaud` no host (a mesma pasta do `codex-hook.json` do upstream); no Docker, o arquivo montado
 * (env `HABBLAUD_CODEX_HOOK_KEY` com o caminho).
 * Um arquivo com outro tamanho nunca é sobrescrito (nem com create): fica ilegível até alguém apagá-lo.
 */
export function loadHookKey(dir: string, opts: { create?: boolean } = {}): Buffer | undefined {
  const file = join(dir, HOOK_KEY_FILE);
  const key = readKey(file);
  if (key || !opts.create) return key;
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const fresh = randomBytes(KEY_BYTES);
    // 'wx': só cria; se outro processo (o servidor ou o docker:up) criou no meio do caminho, vale a dele.
    writeFileSync(file, fresh, { mode: 0o600, flag: 'wx' });
    return fresh;
  } catch {
    return readKey(file);
  }
}

/** HMAC-SHA256(key, `${role}:${nonce}`) em hex. role 'hook' = quem chama prova que é o hook; 'server' = o servidor prova que é o Habblaud. */
export function keyProof(key: Buffer, role: 'hook' | 'server', nonce: string): string {
  return createHmac('sha256', key).update(`${role}:${nonce}`).digest('hex');
}

/**
 * Confere nonce (idade, reuso: guarda os vistos nos últimos NONCE_MAX_AGE_MS) e prova do hook, em tempo constante.
 * A idade vale para trás e para a frente (o relógio da VM do Docker pode derivar). Só nonce com prova válida é guardado
 * (quem não tem a chave não queima nonces nem enche a memória), e cada um sai pela marca de tempo dele, quando a idade
 * passa do limite: antes disso um replay daria certo.
 */
export function createProofChecker(key: Buffer | undefined, now: () => number = Date.now): (nonce: string | undefined, proof: string | undefined) => boolean {
  /** Nonces aceitos → a marca de tempo deles. */
  const seen = new Map<string, number>();
  return (nonce, proof) => {
    if (!key || typeof nonce !== 'string' || typeof proof !== 'string') return false;
    const m = NONCE_RE.exec(nonce);
    if (!m || !PROOF_RE.test(proof)) return false;
    const t = now();
    const at = Number(m[1]);
    if (Math.abs(t - at) > NONCE_MAX_AGE_MS) return false;
    for (const [n, ts] of seen) if (t - ts > NONCE_MAX_AGE_MS) seen.delete(n);
    if (seen.has(nonce)) return false;
    if (!timingSafeEqual(Buffer.from(keyProof(key, 'hook', nonce), 'hex'), Buffer.from(proof, 'hex'))) return false;
    seen.set(nonce, at);
    return true;
  };
}
