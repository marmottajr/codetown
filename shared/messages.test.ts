import { describe, expect, it } from 'vitest';
import { describeMessage } from './messages';

describe('describeMessage', () => {
  it('mascara antes de cortar o detalhe, mesmo com brancos de sobra antes do segredo', () => {
    const d = describeMessage(`${'\n'.repeat(1190)}ghp_${'A'.repeat(36)}`);
    expect(d.detail).toBe('gh*_***');
  });
});
