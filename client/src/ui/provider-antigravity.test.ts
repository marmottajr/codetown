import { describe, expect, it } from 'vitest';
import type { AgentInfo } from '../../../shared/types';
import { composerMode } from './composer-model';
import { accountChipLabel, accountProvider, emptyOfficeHint, fallbackShort, isAntigravity, PROVIDER_NAME, showsProviderTag } from './provider';

// AG-10: o cliente chama o agente de "Antigravity" onde PROVIDER_NAME é usado.
describe('Antigravity no cliente', () => {
  it('nome, detecção e conta', () => {
    expect(PROVIDER_NAME.antigravity).toBe('Antigravity');
    expect(isAntigravity({ provider: 'antigravity' })).toBe(true);
    expect(isAntigravity({ provider: 'codex' })).toBe(false);
    expect(accountProvider({ provider: 'antigravity' }, '.claude')).toBe('antigravity');
    expect(accountProvider(undefined, 'antigravity')).toBe('antigravity');
    expect(accountProvider(undefined, 'demo:antigravity~2')).toBe('antigravity');
    expect(accountProvider(undefined, '.claude')).toBe('claude');
  });

  it('letra do chip, selo e rótulo', () => {
    expect(fallbackShort('antigravity')).toBe('G');
    expect(fallbackShort('antigravity-trabalho')).toBe('T');
    expect(showsProviderTag('antigravity', 'Conta X')).toBe(true);
    expect(showsProviderTag('antigravity', 'Antigravity')).toBe(false);
    expect(accountChipLabel({ name: 'Conta X', provider: 'antigravity' }, 'antigravity', 'antigravity')).toBe('Conta X · Antigravity');
    expect(accountChipLabel({ name: 'Antigravity', provider: 'antigravity' }, 'antigravity', 'antigravity')).toBe('Antigravity');
    expect(accountChipLabel(undefined, 'antigravity', 'antigravity')).toBe('antigravity · Antigravity');
  });

  it('a letra da conta do Antigravity não vira atalho do Claude Code', () => {
    expect(emptyOfficeHint([{ short: 'G', provider: 'antigravity' }])).not.toContain('atalho');
  });

  it('o escritório não oferece mensagem para o Antigravity (não há caminho para uma sessão aberta)', () => {
    const agent = { kind: 'main', status: 'idle', provider: 'antigravity', canMessage: true } as AgentInfo;
    expect(composerMode(agent, { enabled: true, local: true, replaying: false })).toEqual({ kind: 'off', text: 'Para responder, use o terminal do Antigravity' });
  });
});
