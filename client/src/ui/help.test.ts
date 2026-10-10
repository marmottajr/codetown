import { describe, expect, it } from 'vitest';
import { CODEX_HELP, OPENCODE_HELP } from './help';

describe('ajuda: OpenCode', () => {
  it('tem uma seção própria, separada da do Codex', () => {
    expect(OPENCODE_HELP.length).toBeGreaterThan(0);
    expect(OPENCODE_HELP).not.toEqual(CODEX_HELP);
  });

  it('cita o comando de instalação do plugin e o reinício do OpenCode', () => {
    const all = OPENCODE_HELP.join('\n');
    expect(all).toContain('`npm run opencode:install`');
    expect(all).toMatch(/reinicie o OpenCode/);
  });

  it('explica aprovar, perguntas, mensagens e a privacidade', () => {
    const all = OPENCODE_HELP.join('\n');
    expect(all).toMatch(/Aprovar pelo escritório/);
    expect(all).toMatch(/Perguntas/);
    expect(all).toMatch(/Mandar mensagem/);
    expect(all).toMatch(/Privacidade/);
  });

  it('não mexe na ajuda do Codex', () => {
    expect(CODEX_HELP.join('\n')).toContain('`npm run codex:install`');
    expect(CODEX_HELP.join('\n')).not.toMatch(/opencode/i);
  });
});
