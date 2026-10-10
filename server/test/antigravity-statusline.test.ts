// Statusline do Antigravity (mod/habblaud-antigravity/statusline.mjs) rodado como processo de verdade com o JSON no
// formato capturado num agy 1.3.3: grava SÓ as cotas e o plano (AG-26), não imprime nada e sai com 0 em qualquer caso,
// e não regrava o mesmo número a cada renderização. HOME e pasta de uso temporários.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tempDir } from './fixtures';

const SCRIPT = resolve(__dirname, '../../mod/habblaud-antigravity/statusline.mjs');
interface Mod {
  quotaBody(input: unknown, now?: number): Record<string, unknown> | undefined;
  save(body: Record<string, unknown>, dir: string, now?: number): boolean;
  usageDir(env: NodeJS.ProcessEnv): string;
  QUOTA_FILE: string;
}
const mod = (await import(pathToFileURL(SCRIPT).href)) as Mod;

// Campos reais do statusline do agy 1.3.3, com os pessoais trocados por valores de mentira.
const PAYLOAD = {
  cwd: '/home/ana/loja',
  session_id: '534af04f-d60f-4d5f-86b5-36520b599c89',
  conversation_id: '534af04f-d60f-4d5f-86b5-36520b599c89',
  transcript_path: '/home/ana/.gemini/antigravity-cli/brain/534af04f/.system_generated/logs/transcript.jsonl',
  model: { id: 'Gemini 3.6 Flash (Low)', display_name: 'Gemini 3.6 Flash (Low)' },
  workspace: { current_dir: '/home/ana/loja', project_dir: '/home/ana/loja' },
  version: '1.3.3',
  context_window: { total_input_tokens: 18857, used_percentage: 1.79 },
  product: 'antigravity',
  quota: {
    '3p-weekly': { remaining_fraction: 1, reset_time: '2026-10-17T16:37:57Z', reset_in_seconds: 604770 },
    'gemini-weekly': { remaining_fraction: 0.8337216, reset_time: '2026-10-17T14:54:02Z', reset_in_seconds: 598535 },
  },
  agent_state: 'idle',
  plan_tier: 'Antigravity Starter Quota',
  email: 'ana@exemplo.com',
};

let tmp: ReturnType<typeof tempDir>;
let home: string;
let usage: string;

beforeEach(() => {
  tmp = tempDir('habblaud-agysl-');
  home = tmp.dir;
  usage = join(home, 'usage');
});
afterEach(() => tmp.cleanup());

function runScript(stdin: string, env: Record<string, string> = {}): Promise<{ code: number | null; stdout: string; stderr: string; ms: number }> {
  return new Promise((ok) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, [SCRIPT], { env: { ...process.env, HOME: home, HABBLAUD_USAGE_DIR: usage, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('close', (code) => ok({ code, stdout, stderr, ms: Date.now() - t0 }));
    child.stdin.end(stdin);
  });
}

const file = () => join(usage, 'antigravity-quota.json');

describe('statusline do Antigravity: o que grava (AG-26)', () => {
  it('grava só fetchedAt, planTier e as cotas (remaining_fraction e reset_time); não imprime nada e sai com 0', async () => {
    const r = await runScript(JSON.stringify(PAYLOAD));
    expect(r).toMatchObject({ code: 0, stdout: '', stderr: '' });
    const j = JSON.parse(readFileSync(file(), 'utf8')) as Record<string, unknown>;
    expect(Object.keys(j).sort()).toEqual(['fetchedAt', 'planTier', 'quota']);
    expect(j.planTier).toBe('Antigravity Starter Quota');
    expect(j.fetchedAt).toBeGreaterThan(Date.now() - 10_000);
    expect(j.quota).toEqual({
      '3p-weekly': { remaining_fraction: 1, reset_time: '2026-10-17T16:37:57Z' },
      'gemini-weekly': { remaining_fraction: 0.8337216, reset_time: '2026-10-17T14:54:02Z' },
    });
  });

  it('o e-mail, as pastas, o transcript, o modelo e os tokens nunca vão para o arquivo', async () => {
    await runScript(JSON.stringify(PAYLOAD));
    const text = readFileSync(file(), 'utf8');
    for (const forbidden of ['ana@', 'loja', 'transcript', 'brain', 'gemini-antigravity', 'Flash', '534af04f', 'context_window', 'reset_in_seconds']) expect(text, forbidden).not.toContain(forbidden);
  });

  it('a pasta vem de HABBLAUD_USAGE_DIR, senão ~/.habblaud/usage', () => {
    expect(mod.usageDir({ HOME: '/home/ana', HABBLAUD_USAGE_DIR: '/dados/uso' })).toBe('/dados/uso');
    expect(mod.usageDir({ HOME: '/home/ana' })).toBe('/home/ana/.habblaud/usage');
    expect(mod.usageDir({ HOME: '/home/ana', HABBLAUD_USAGE_DIR: '  ' })).toBe('/home/ana/.habblaud/usage');
  });

  it('quotaBody: só cotas com número; reset_time longo ou de outro tipo fica de fora; chave e plano cortados; no máximo 12', () => {
    const b = mod.quotaBody({ plan_tier: 'P'.repeat(200), quota: { ok: { remaining_fraction: 0.5, reset_time: 'x'.repeat(100) }, ruim: { remaining_fraction: 'a' }, outra: 'x' } }, 7)!;
    expect(b).toEqual({ fetchedAt: 7, planTier: 'P'.repeat(60), quota: { ok: { remaining_fraction: 0.5 } } });
    const many = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${i}`, { remaining_fraction: 0.1 }]));
    expect(Object.keys((mod.quotaBody({ quota: many }) as { quota: object }).quota)).toHaveLength(12);
    expect(Object.keys((mod.quotaBody({ quota: { ['k'.repeat(90)]: { remaining_fraction: 1 } } }) as { quota: object }).quota)[0]).toHaveLength(40);
  });

  it('sem cota com número (JSON sem quota, quota vazia, lista): nada é gravado', async () => {
    for (const body of [{ model: 'x' }, { quota: {} }, { quota: [] }, { quota: { a: {} } }]) {
      expect((await runScript(JSON.stringify(body))).code).toBe(0);
    }
    expect(existsSync(file())).toBe(false);
  });
});

describe('statusline do Antigravity: nunca atrapalha o agy', () => {
  it('stdin vazio, quebrado ou grande demais: sai com 0, sem imprimir e sem gravar', async () => {
    for (const stdin of ['', '{ quebrado', '[1,2]', 'x'.repeat(600 * 1024)]) {
      const r = await runScript(stdin);
      expect(r, stdin.slice(0, 10)).toMatchObject({ code: 0, stdout: '' });
    }
    expect(existsSync(file())).toBe(false);
  });

  it('pasta de uso impossível de criar (um arquivo no lugar): sai com 0 e sem imprimir', async () => {
    writeFileSync(usage, 'sou um arquivo');
    const r = await runScript(JSON.stringify(PAYLOAD));
    expect(r).toMatchObject({ code: 0, stdout: '' });
    expect(r.ms).toBeLessThan(3_000);
  });

  it('só usa módulos node: (nenhuma dependência)', () => {
    const imports = [...readFileSync(SCRIPT, 'utf8').matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1]);
    expect(imports.length).toBeGreaterThan(0);
    for (const i of imports) expect(i.startsWith('node:'), i).toBe(true);
  });
});

describe('statusline do Antigravity: regravação', () => {
  const body = () => mod.quotaBody(PAYLOAD, 1_000)!;

  it('o mesmo número dentro de 10 s não é regravado; depois de 10 s, é (o fetchedAt se renova)', () => {
    mkdirSync(usage, { recursive: true });
    expect(mod.save(body(), usage, 1_000)).toBe(true);
    const f = file();
    const mtime = statSync(f).mtimeMs;
    expect(mod.save(mod.quotaBody(PAYLOAD, 2_000)!, usage, mtime + 3_000)).toBe(false);
    expect(mod.save(mod.quotaBody(PAYLOAD, 3_000)!, usage, mtime + 11_000)).toBe(true);
    expect(readdirSync(usage)).toEqual(['antigravity-quota.json']);
  });

  it('número diferente é gravado na hora', () => {
    mkdirSync(usage, { recursive: true });
    const first = body();
    mod.save(first, usage, Date.now());
    const changed = { ...first, quota: { ...(first.quota as object), 'gemini-weekly': { remaining_fraction: 0.5 } } };
    expect(mod.save(changed, usage, Date.now())).toBe(true);
    expect((JSON.parse(readFileSync(file(), 'utf8')) as { quota: Record<string, { remaining_fraction: number }> }).quota['gemini-weekly'].remaining_fraction).toBe(0.5);
  });

  it('o plano diferente também regrava', () => {
    mkdirSync(usage, { recursive: true });
    mod.save(body(), usage, Date.now());
    expect(mod.save({ ...body(), planTier: 'Outro' }, usage, Date.now())).toBe(true);
    utimesSync(file(), new Date(), new Date());
  });
});
