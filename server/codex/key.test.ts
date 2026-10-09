// Chave local do hook do Codex (codex/key.ts): arquivo de 32 bytes em <dir>/codex-hook.key (criado com modo 0600 só com
// create), prova HMAC por papel e o conferente de nonce (idade, reuso, prova em tempo constante). Chaves sintéticas.
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { tempDir } from '../test/fixtures';
import { createProofChecker, HOOK_KEY_FILE, keyProof, loadHookKey, NONCE_HEADER, NONCE_MAX_AGE_MS, PROOF_HEADER } from './key';

const KEY = Buffer.alloc(32, 1);
const OTHER = Buffer.alloc(32, 2);
const HEX = '0123456789abcdef0123456789abcdef';
const T0 = 1_700_000_000_000;
const nonceAt = (at: number, hex = HEX) => `${at}.${hex}`;

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
});

function dir(): string {
  const tmp = tempDir();
  cleanup = tmp.cleanup;
  return join(tmp.dir, '.habblaud');
}

describe('loadHookKey', () => {
  it('sem create: ausente = undefined e nada é criado; com create: cria a pasta e 32 bytes aleatórios, e relê os mesmos', () => {
    const d = dir();
    expect(loadHookKey(d)).toBeUndefined();
    expect(() => statSync(d)).toThrow();
    const key = loadHookKey(d, { create: true });
    expect(key).toBeInstanceOf(Buffer);
    expect(key).toHaveLength(32);
    expect(readFileSync(join(d, HOOK_KEY_FILE)).equals(key!)).toBe(true);
    expect(loadHookKey(d)!.equals(key!)).toBe(true);
    expect(loadHookKey(d, { create: true })!.equals(key!)).toBe(true);
    const other = dir();
    expect(loadHookKey(other, { create: true })!.equals(key!)).toBe(false);
  });

  it.skipIf(process.platform === 'win32')('cria o arquivo com modo 0600', () => {
    const d = dir();
    loadHookKey(d, { create: true });
    expect(statSync(join(d, HOOK_KEY_FILE)).mode & 0o777).toBe(0o600);
  });

  it('arquivo com tamanho errado (vazio, texto, 33 bytes) ou pasta no lugar: undefined e nunca sobrescreve, nem com create', () => {
    const d = dir();
    mkdirSync(d, { recursive: true });
    const file = join(d, HOOK_KEY_FILE);
    for (const bad of [Buffer.alloc(0), Buffer.from('a'.repeat(64)), Buffer.alloc(33, 3)]) {
      writeFileSync(file, bad);
      expect(loadHookKey(d)).toBeUndefined();
      expect(loadHookKey(d, { create: true })).toBeUndefined();
      expect(readFileSync(file).equals(bad)).toBe(true);
    }
    const d2 = dir();
    mkdirSync(join(d2, HOOK_KEY_FILE), { recursive: true });
    expect(loadHookKey(d2, { create: true })).toBeUndefined();
  });

  it('lê a chave de 32 bytes que outro processo (o docker:up) gravou', () => {
    const d = dir();
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, HOOK_KEY_FILE), KEY);
    expect(loadHookKey(d)!.equals(KEY)).toBe(true);
  });
});

describe('keyProof e cabeçalhos', () => {
  it('HMAC-SHA256(chave, "<papel>:<nonce>") em hex; papéis e chaves diferentes dão provas diferentes', () => {
    const n = nonceAt(T0, '0'.repeat(32));
    expect(keyProof(KEY, 'hook', n)).toBe('a1c8a95d89542ee151ef9c96f726801afec7174eee93c2d090cb50290115caff');
    expect(keyProof(KEY, 'server', n)).toBe('3c6e17653b284617eb15138e0c66fa903b5653a71d0242b6801907158dd9843d');
    expect(keyProof(OTHER, 'hook', n)).not.toBe(keyProof(KEY, 'hook', n));
    expect([HOOK_KEY_FILE, PROOF_HEADER, NONCE_HEADER, NONCE_MAX_AGE_MS]).toEqual(['codex-hook.key', 'x-habblaud-proof', 'x-habblaud-nonce', 60_000]);
  });
});

describe('createProofChecker', () => {
  function checker(start = T0) {
    const clock = { now: start };
    return { clock, check: createProofChecker(KEY, () => clock.now) };
  }

  it('aceita a prova do hook uma vez só; papel "server", outra chave, sem chave ou faltando algo: recusa', () => {
    const { check } = checker();
    const n = nonceAt(T0);
    expect(check(n, keyProof(KEY, 'server', n))).toBe(false);
    expect(check(n, keyProof(OTHER, 'hook', n))).toBe(false);
    expect(check(n, undefined)).toBe(false);
    expect(check(undefined, keyProof(KEY, 'hook', n))).toBe(false);
    // As recusas acima não queimam o nonce: a prova certa ainda passa, mas só uma vez.
    expect(check(n, keyProof(KEY, 'hook', n))).toBe(true);
    expect(check(n, keyProof(KEY, 'hook', n))).toBe(false);
    expect(createProofChecker(undefined, () => T0)(n, keyProof(KEY, 'hook', n))).toBe(false);
  });

  it('nonce ou prova fora do formato: recusa (maiúsculas, hex curto, sem ponto, prova com lixo no fim)', () => {
    const { check } = checker();
    const ok = nonceAt(T0);
    for (const n of [`${T0}.${HEX.toUpperCase()}`, `${T0}.${HEX.slice(2)}`, `${T0}${HEX}`, `x${T0}.${HEX}`, `${T0}.${HEX}\n`, '']) {
      expect(check(n, keyProof(KEY, 'hook', n)), JSON.stringify(n)).toBe(false);
    }
    const proof = keyProof(KEY, 'hook', ok);
    for (const p of [proof.toUpperCase(), `${proof}00`, proof.slice(0, 62), `${proof.slice(0, 62)}zz`, '']) {
      expect(check(ok, p), p).toBe(false);
    }
    expect(check(ok, proof)).toBe(true);
  });

  it('idade: vale até NONCE_MAX_AGE_MS para trás ou para a frente (relógio do Docker), nunca além', () => {
    const { check } = checker();
    for (const [at, ok] of [
      [T0 - NONCE_MAX_AGE_MS, true],
      [T0 - NONCE_MAX_AGE_MS - 1, false],
      [T0 + NONCE_MAX_AGE_MS, true],
      [T0 + NONCE_MAX_AGE_MS + 1, false],
    ] as const) {
      const n = nonceAt(at);
      expect(check(n, keyProof(KEY, 'hook', n)), String(at - T0)).toBe(ok);
    }
  });

  it('reuso: o nonce aceito fica guardado até a idade dele passar do limite (pela marca do nonce, não pela chegada)', () => {
    const { clock, check } = checker();
    const now = nonceAt(T0);
    const future = nonceAt(T0 + 30_000, 'f'.repeat(32));
    expect(check(now, keyProof(KEY, 'hook', now))).toBe(true);
    expect(check(future, keyProof(KEY, 'hook', future))).toBe(true);
    // Na borda da janela o nonce de T0 ainda tem idade válida: continua guardado e o replay é recusado.
    clock.now = T0 + NONCE_MAX_AGE_MS;
    expect(check(now, keyProof(KEY, 'hook', now))).toBe(false);
    // 80 s depois de chegar, o nonce "do futuro" tem só 50 s de idade: ainda guardado.
    clock.now = T0 + 80_000;
    expect(check(future, keyProof(KEY, 'hook', future))).toBe(false);
    clock.now = T0 + 30_000 + NONCE_MAX_AGE_MS + 1;
    expect(check(future, keyProof(KEY, 'hook', future))).toBe(false);
    // Nonce novo continua passando depois da poda.
    const fresh = nonceAt(clock.now, 'a'.repeat(32));
    expect(check(fresh, keyProof(KEY, 'hook', fresh))).toBe(true);
  });
});
