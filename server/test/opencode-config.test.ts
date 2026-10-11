import { describe, expect, it } from 'vitest';
import { loadConfig } from '../config';

// OC-10: HABBLAUD_OPENCODE liga/desliga; a pasta de dados vem do ambiente, do XDG ou da casa do usuário.
const base = { HOME: '/home/fulano' } as NodeJS.ProcessEnv;

describe('config do OpenCode', () => {
  it('liga por padrão', () => {
    expect(loadConfig(base, []).opencode).toBe(true);
    expect(loadConfig({ ...base, HABBLAUD_OPENCODE: '' }, []).opencode).toBe(true);
  });

  it('HABBLAUD_OPENCODE=0 desliga', () => {
    expect(loadConfig({ ...base, HABBLAUD_OPENCODE: '0' }, []).opencode).toBe(false);
  });

  it('HABBLAUD_OPENCODE=1 liga', () => {
    expect(loadConfig({ ...base, HABBLAUD_OPENCODE: '1' }, []).opencode).toBe(true);
  });

  it('HABBLAUD_OPENCODE_DIR vence o XDG e a casa', () => {
    const cfg = loadConfig({ ...base, HABBLAUD_OPENCODE_DIR: '/dados/oc', XDG_DATA_HOME: '/xdg' }, []);
    expect(cfg.opencodeDir).toBe('/dados/oc');
  });

  it('sem a variável, usa $XDG_DATA_HOME/opencode', () => {
    expect(loadConfig({ ...base, XDG_DATA_HOME: '/xdg' }, []).opencodeDir).toBe('/xdg/opencode');
  });

  it('sem nada, usa ~/.local/share/opencode', () => {
    expect(loadConfig(base, []).opencodeDir).toBe('/home/fulano/.local/share/opencode');
  });
});
