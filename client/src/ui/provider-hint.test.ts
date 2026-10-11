import { describe, expect, it } from 'vitest';
import { showsPermissionsPluginHint } from './provider';

// OQ-09: a dica do plugin habblaud-permissoes não aparece no cartão "Precisa de você" de um agente do OpenCode.
describe('dica do plugin habblaud-permissoes no cartão', () => {
  it('Claude Code (provider explícito ou ausente) ainda mostra a dica', () => {
    expect(showsPermissionsPluginHint({ provider: 'claude' })).toBe(true);
    expect(showsPermissionsPluginHint({})).toBe(true);
    expect(showsPermissionsPluginHint(undefined)).toBe(true);
  });

  it('OpenCode e Codex não mostram', () => {
    expect(showsPermissionsPluginHint({ provider: 'opencode' })).toBe(false);
    expect(showsPermissionsPluginHint({ provider: 'codex' })).toBe(false);
  });
});
