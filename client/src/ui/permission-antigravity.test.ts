// Cartão de permissão do Antigravity (peças puras de client/src/ui/permission.ts): só aprovar ou recusar, sem "sempre
// permitir" nem "interromper", motivo da recusa opcional, prazo em segundos e aviso próprio (AG-20). Claude Code, Codex e
// OpenCode seguem como nos outros testes.
import { describe, expect, it } from 'vitest';
import { ANTIGRAVITY_PERMISSION_NOTE, permissionOptions } from './permission';

const suggestions = [{ index: 0, rules: ['Bash(npm test:*)'], destination: 'localSettings' }];

describe('cartão de permissão do Antigravity', () => {
  it('só aprovar e recusar: sem "sempre permitir" (mesmo com sugestões) nem "interromper"; motivo opcional; prazo em segundos; aviso próprio', () => {
    expect(permissionOptions({ provider: 'antigravity', suggestions, tool: 'run_command' }, { kind: 'main' })).toEqual({
      always: false,
      interrupt: false,
      reasonRequired: false,
      seconds: true,
      note: ANTIGRAVITY_PERMISSION_NOTE,
    });
    expect(permissionOptions({ provider: 'antigravity' }, { kind: 'sub', background: true }).note).toBe(ANTIGRAVITY_PERMISSION_NOTE);
    expect(ANTIGRAVITY_PERMISSION_NOTE).toMatch(/^No Antigravity, o comando espera aqui/);
  });

  it('os outros provedores não mudam', () => {
    expect(permissionOptions({ provider: 'codex' }, { kind: 'main' }).reasonRequired).toBe(true);
    expect(permissionOptions({ provider: 'opencode', tool: 'bash' }, { kind: 'main' }).reasonRequired).toBe(true);
    expect(permissionOptions({ suggestions }, { kind: 'main' })).toMatchObject({ always: true, interrupt: true, reasonRequired: false });
  });
});
