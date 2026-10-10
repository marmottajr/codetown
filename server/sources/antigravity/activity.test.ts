import { describe, expect, it } from 'vitest';
import { describeTool } from '../../../shared/activity';
import { describeAntigravityTool, GENERIC_WORKING } from './activity';

// AG-03: mesmos rótulos do Claude Code para ferramentas equivalentes; desconhecida = genérico.
describe('atividade do Antigravity', () => {
  it('run_command, view_file e write_to_file usam os rótulos de Bash, Read e Write', () => {
    expect(describeAntigravityTool('run_command', 'npm test')).toEqual({ desc: describeTool('Bash', { command: 'npm test' }), tool: 'Bash' });
    expect(describeAntigravityTool('view_file', '/a/b.ts')).toEqual({ desc: describeTool('Read', { file_path: '/a/b.ts' }), tool: 'Read' });
    expect(describeAntigravityTool('write_to_file', '/a/c.ts')).toEqual({ desc: describeTool('Write', { file_path: '/a/c.ts' }), tool: 'Write' });
  });

  it('as outras ferramentas conhecidas mapeiam para as equivalentes', () => {
    const tools: Record<string, string> = {
      replace_file_content: 'Edit',
      multi_replace_file_content: 'MultiEdit',
      sed_file: 'Edit',
      grep_search: 'Grep',
      find_by_name: 'Glob',
      list_dir: 'LS',
      read_url_content: 'WebFetch',
      search_web: 'WebSearch',
      invoke_subagent: 'Agent',
      browser_subagent: 'Agent',
    };
    for (const [agy, claude] of Object.entries(tools)) expect(describeAntigravityTool(agy, 'x').tool).toBe(claude);
  });

  it('o nome vale em qualquer caixa e sem texto curto ainda dá uma atividade', () => {
    expect(describeAntigravityTool('RUN_COMMAND').tool).toBe('Bash');
    expect(describeAntigravityTool('run_command').desc).toEqual(describeTool('Bash', {}));
  });

  it('ferramenta desconhecida vira atividade com o próprio nome (limpo), sem derrubar', () => {
    const r = describeAntigravityTool('browser_click_element', 'x');
    expect(r.tool).toBe('browser_click_element');
    expect(r.desc).toEqual(describeTool('browser_click_element', {}));
    expect(describeAntigravityTool('<b>$$', '').tool).toBe('b');
    expect(describeAntigravityTool('!!!').tool).toBe('ferramenta');
  });

  it('o genérico é "Trabalhando"', () => {
    expect(GENERIC_WORKING.text).toBe('Trabalhando');
  });
});
