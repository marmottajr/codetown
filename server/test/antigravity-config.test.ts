import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config';

// AG-09: HABBLAUD_ANTIGRAVITY liga/desliga o aceite dos eventos do Antigravity.
const base = { HOME: '/home/fulano' } as NodeJS.ProcessEnv;

describe('config do Antigravity', () => {
  it('liga por padrão', () => {
    expect(loadConfig(base, []).antigravity).toBe(true);
    expect(loadConfig({ ...base, HABBLAUD_ANTIGRAVITY: '' }, []).antigravity).toBe(true);
  });

  it('HABBLAUD_ANTIGRAVITY=0 desliga', () => {
    expect(loadConfig({ ...base, HABBLAUD_ANTIGRAVITY: '0' }, []).antigravity).toBe(false);
  });

  it('HABBLAUD_ANTIGRAVITY=1 liga', () => {
    expect(loadConfig({ ...base, HABBLAUD_ANTIGRAVITY: '1' }, []).antigravity).toBe(true);
  });
});
