// Caixa de mensagem para agentes do OpenCode (OC-23): só principais, só com o plugin conectado (canMessage), com a
// dica de instalação no tom das do Codex; textos de situação, dica e prazo próprios do OpenCode.
import { describe, expect, it } from 'vitest';
import type { AgentInfo } from '../../../shared/types';
import {
  composerMode,
  composerTip,
  DELIVERED_SHOW_MS,
  OPENCODE_PLUGIN_HINT,
  OPENCODE_TIMEOUT_ERROR,
  sendStatusText,
  timeoutError,
  type ComposerEnv,
} from './composer-model';

const oc = (over: Partial<AgentInfo> = {}): AgentInfo => ({
  id: 'opencode:ses_aaaaaaaaaaaaaaaaaaaaaaaaaa',
  provider: 'opencode',
  kind: 'main',
  roomId: 'r',
  name: 'Marina',
  look: 'f',
  role: 'Agente principal',
  sessionId: 'ses_aaaaaaaaaaaaaaaaaaaaaaaaaa',
  account: 'opencode',
  status: 'idle',
  recent: [],
  tasks: [],
  startedAt: 0,
  lastEventAt: 0,
  statusSince: 0,
  stats: { toolCalls: 0, tokensIn: 0, tokensOut: 0, subagents: 0 },
  seed: 1,
  canMessage: true,
  ...over,
});

const ON: ComposerEnv = { enabled: true, local: true, replaying: false };

describe('caixa de mensagem: OpenCode', () => {
  it('principal com o plugin conectado: pronta', () => {
    expect(composerMode(oc(), ON)).toEqual({ kind: 'ready' });
  });

  it('sem o plugin conectado (canMessage ausente): só a dica de instalação, nunca pronta', () => {
    expect(composerMode(oc({ canMessage: undefined }), ON)).toEqual({ kind: 'hint', text: OPENCODE_PLUGIN_HINT });
    expect(composerMode(oc({ canMessage: false }), ON).kind).toBe('hint');
    expect(OPENCODE_PLUGIN_HINT).toMatch(/npm run opencode:install/);
    expect(OPENCODE_PLUGIN_HINT).toMatch(/OpenCode/);
  });

  it('subagente, sessão encerrada, recurso desligado, página remota e timelapse: sem caixa', () => {
    expect(composerMode(oc({ kind: 'sub', parentId: 'x' }), ON).kind).toBe('off');
    expect(composerMode(oc({ status: 'offline' }), ON)).toEqual({ kind: 'off', text: 'Sessão encerrada' });
    expect(composerMode(oc(), { ...ON, enabled: false })).toEqual({ kind: 'off', text: 'Para responder, use o OpenCode' });
    expect(composerMode(oc(), { ...ON, local: false }).kind).toBe('off');
    expect(composerMode(oc(), { ...ON, replaying: true }).kind).toBe('off');
  });

  it('textos da situação, dica e prazo falam do OpenCode', () => {
    expect(sendStatusText({ phase: 'queued', at: 0 }, 0, 'opencode')).toBe('Na fila: esperando o plugin do OpenCode buscar a mensagem…');
    expect(sendStatusText({ phase: 'delivered', at: 0 }, 1_000, 'opencode')).toBe('Entregue ✓ ao OpenCode');
    expect(sendStatusText({ phase: 'delivered', at: 0 }, DELIVERED_SHOW_MS, 'opencode')).toBe('');
    expect(sendStatusText({ phase: 'failed', at: 0, error: 'x' }, 0, 'opencode')).toBe('Não foi entregue: x');
    expect(composerTip('opencode')).toMatch(/OpenCode/);
    expect(timeoutError('opencode')).toBe(OPENCODE_TIMEOUT_ERROR);
    expect(OPENCODE_TIMEOUT_ERROR).toBe('sem notícia da entrega: confira no OpenCode');
  });
});
