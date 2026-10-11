import { describe, expect, it } from 'vitest';
import {
  accountChipLabel,
  accountProvider,
  emptyOfficeHint,
  fallbackShort,
  isOpencode,
  looksLikeOpencodeId,
  PROVIDER_NAME,
  providerOf,
  showsProviderTag,
} from './provider';

// OC-11: "OpenCode" onde o nome da ferramenta aparece.
describe('ferramenta OpenCode no cliente', () => {
  it('nome da ferramenta e reconhecimento do provider', () => {
    expect(PROVIDER_NAME.opencode).toBe('OpenCode');
    expect(providerOf({ provider: 'opencode' })).toBe('opencode');
    expect(isOpencode({ provider: 'opencode' })).toBe(true);
    expect(isOpencode({ provider: 'codex' })).toBe(false);
    expect(isOpencode(undefined)).toBe(false);
  });

  it('o id da conta tem cara do OpenCode (só quando a conta não está no snapshot)', () => {
    for (const id of ['opencode', 'opencode~2', 'demo:opencode']) expect(looksLikeOpencodeId(id), id).toBe(true);
    for (const id of ['.claude', '.codex', 'meuopencode', 'opencodex', '']) expect(looksLikeOpencodeId(id), id).toBe(false);
    expect(accountProvider({ provider: 'opencode' }, '.claude')).toBe('opencode');
    expect(accountProvider(undefined, 'opencode')).toBe('opencode');
    expect(accountProvider(undefined, '.claude', 'opencode')).toBe('opencode');
  });

  it('letra do chip da conta que não está no snapshot', () => {
    expect(fallbackShort('opencode')).toBe('O');
    expect(fallbackShort('opencode~2')).toBe('O');
    expect(fallbackShort('x', 'opencode')).toBe('X');
  });

  it('selo "OpenCode": só no OpenCode, sem repetir o nome da conta', () => {
    expect(showsProviderTag('opencode', 'Conta O')).toBe(true);
    expect(showsProviderTag('opencode', 'OpenCode')).toBe(false);
    expect(showsProviderTag('opencode', 'Demo OpenCode')).toBe(false);
    expect(showsProviderTag('claude', 'Conta C')).toBe(false);
  });

  it('rótulo do chip da conta', () => {
    expect(accountChipLabel({ name: 'OpenCode', provider: 'opencode' }, 'opencode', 'opencode')).toBe('OpenCode');
    expect(accountChipLabel({ name: 'Minha conta', provider: 'opencode' }, 'opencode', 'opencode')).toBe('Minha conta · OpenCode');
    expect(accountChipLabel(undefined, 'opencode', 'opencode')).toBe('opencode · OpenCode');
  });

  it('escritório vazio: a letra da conta do OpenCode não vira atalho', () => {
    const c = { short: 'C' };
    const o = { short: 'O', provider: 'opencode' as const };
    expect(emptyOfficeHint([c, o])).toBe(emptyOfficeHint([c]));
    expect(emptyOfficeHint([o])).toBe(emptyOfficeHint([]));
  });
});
