import { describe, expect, it } from 'vitest';
import { describeTool } from '../../../shared/activity';
import { describeOpencodePart, describeOpencodeTool, GENERIC_WORKING } from './activity';

// OC-04: as mesmas legendas do Claude/Codex para ferramentas equivalentes.
describe('describeOpencodeTool', () => {
  it.each([
    ['bash', 'npm test', 'Bash', { command: 'npm test' }],
    ['read', 'src/app.ts', 'Read', { file_path: 'src/app.ts' }],
    ['edit', 'src/app.ts', 'Edit', { file_path: 'src/app.ts' }],
    ['write', 'novo.ts', 'Write', { file_path: 'novo.ts' }],
    ['grep', 'TODO', 'Grep', { pattern: 'TODO' }],
    ['glob', '**/*.ts', 'Glob', { pattern: '**/*.ts' }],
    ['webfetch', 'https://www.exemplo.com/a', 'WebFetch', { url: 'https://www.exemplo.com/a' }],
    ['task', 'Revisar o código', 'Agent', { description: 'Revisar o código' }],
  ])('%s equivale a %s do Claude Code', (oc, title, claude, input) => {
    const r = describeOpencodeTool(oc, title);
    expect(r.desc).toEqual(describeTool(claude, input));
    expect(r.tool).toBe(claude);
  });

  it('o nome não diferencia maiúsculas', () => {
    expect(describeOpencodeTool('Read', 'a.ts').desc).toEqual(describeTool('Read', { file_path: 'a.ts' }));
  });

  it('ferramenta conhecida sem título dá o rótulo sem alvo', () => {
    expect(describeOpencodeTool('read').desc).toEqual(describeTool('Read', {}));
  });

  it('ferramenta desconhecida vira "Usando <nome>" (outro)', () => {
    const r = describeOpencodeTool('minha_ferramenta', 'x');
    expect(r.desc.kind).toBe('other');
    expect(r.desc.text).toContain('minha_ferramenta');
    expect(r.tool).toBe('minha_ferramenta');
  });

  it('nome estranho do banco é limpo e cortado', () => {
    const r = describeOpencodeTool('a b<script>'.repeat(10), '');
    expect(r.tool).not.toMatch(/[<> ]/);
    expect(r.tool.length).toBeLessThanOrEqual(40);
  });
});

describe('describeOpencodePart', () => {
  it('parte tool sem state dá a atividade genérica de trabalho', () => {
    expect(describeOpencodePart({ type: 'tool', tool: 'read', hasState: false }).desc).toEqual(GENERIC_WORKING);
  });

  it('sem parte, ou tipo desconhecido, dá o genérico', () => {
    expect(describeOpencodePart(undefined).desc).toEqual(GENERIC_WORKING);
    expect(describeOpencodePart({ type: 'step-start', hasState: false }).desc).toEqual(GENERIC_WORKING);
  });

  it('parte tool com state usa nome e title', () => {
    const r = describeOpencodePart({ type: 'tool', tool: 'bash', title: 'ls', hasState: true });
    expect(r.desc).toEqual(describeTool('Bash', { command: 'ls' }));
    expect(r.tool).toBe('Bash');
  });

  it('reasoning é "Pensando" e text é "Escrevendo a resposta"', () => {
    expect(describeOpencodePart({ type: 'reasoning', hasState: false }).desc.kind).toBe('think');
    expect(describeOpencodePart({ type: 'text', hasState: false }).desc.kind).toBe('respond');
  });
});
