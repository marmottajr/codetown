// Cartão de permissão do OpenCode (peças puras de client/src/ui/permission.ts): só aprovar ou recusar, recusar com
// motivo obrigatório, prazo em segundos, aviso próprio e sem cartão de pergunta (OC-19). Claude Code e Codex seguem
// como em permission.test.ts.
import { describe, expect, it } from 'vitest';
import type { AgentInfo, AskQuestion } from '../../../shared/types';
import { isQuestionRequest, OPENCODE_PERMISSION_NOTE, permissionOptions } from './permission';
import { hasCodexPermission } from './provider';

const suggestions = [{ index: 0, rules: ['Bash(npm test:*)'], destination: 'localSettings' }];
const question: AskQuestion = { index: 0, question: 'Qual?', header: 'Q', multiSelect: false, options: [{ index: 0, label: 'A' }] };

describe('cartão de permissão do OpenCode', () => {
  it('só aprovar e recusar: sem "sempre permitir" (mesmo com sugestões) nem "interromper"; recusa exige motivo; prazo em segundos; aviso próprio', () => {
    expect(permissionOptions({ provider: 'opencode', suggestions }, { kind: 'main' })).toEqual({
      always: false,
      interrupt: false,
      reasonRequired: true,
      seconds: true,
      note: OPENCODE_PERMISSION_NOTE,
    });
    expect(permissionOptions({ provider: 'opencode' }, { kind: 'sub', background: true }).note).toBe(OPENCODE_PERMISSION_NOTE);
    expect(OPENCODE_PERMISSION_NOTE).toMatch(/^No OpenCode, o pedido já está na tela dele/);
  });

  it('recusar uma PERGUNTA do OpenCode não exige motivo; recusar uma permissão do OpenCode continua exigindo; Claude e Codex iguais', () => {
    const q = permissionOptions({ provider: 'opencode', tool: 'AskUserQuestion' }, { kind: 'main' });
    expect(q.reasonRequired).toBe(false);
    expect(q).toMatchObject({ always: false, interrupt: false, seconds: true, note: OPENCODE_PERMISSION_NOTE });
    expect(permissionOptions({ provider: 'opencode', tool: 'bash' }, { kind: 'main' }).reasonRequired).toBe(true);
    expect(permissionOptions({ provider: 'opencode' }, { kind: 'main' }).reasonRequired).toBe(true);
    expect(permissionOptions({ tool: 'AskUserQuestion' }, { kind: 'main' }).reasonRequired).toBe(false);
    expect(permissionOptions({ provider: 'codex', tool: 'AskUserQuestion' }, { kind: 'main' }).reasonRequired).toBe(true);
  });

  it('a pergunta do OpenCode vira cartão de pergunta (como a do Claude Code); sem perguntas ou outra ferramenta, não', () => {
    expect(isQuestionRequest({ tool: 'AskUserQuestion', questions: [question], provider: 'opencode' })).toBe(true);
    expect(isQuestionRequest({ tool: 'AskUserQuestion', questions: [], provider: 'opencode' })).toBe(false);
    expect(isQuestionRequest({ tool: 'bash', questions: [question], provider: 'opencode' })).toBe(false);
    expect(isQuestionRequest({ tool: 'AskUserQuestion', questions: [question] })).toBe(true);
  });

  it('o relógio de 1 s (contagem de segundos) também vale para um pedido do OpenCode esperando', () => {
    const agent = (provider: 'opencode' | undefined, status: AgentInfo['status'] = 'waiting') =>
      ({ status, permission: { id: 'p', tool: 'bash', title: 't', text: 't', icon: 'i', createdAt: 0, expiresAt: 1, ...(provider ? { provider } : {}) } }) as unknown as AgentInfo;
    expect(hasCodexPermission({ agents: [agent('opencode')] })).toBe(true);
    expect(hasCodexPermission({ agents: [agent('opencode', 'offline')] })).toBe(false);
    expect(hasCodexPermission({ agents: [agent(undefined)] })).toBe(false);
  });
});
