// Pedidos de permissão (e perguntas) fictícios do modo demonstração (responder pelo escritório sem sessões reais),
// do Claude Code e do Codex (só aprovação, sem "sempre permitir"; pelo hook, com prazo, ou pelo canal paralelo).
// Puro: usado pelo simulador no servidor (HABBLAUD_DEMO=1) e no navegador (?mock=1).
import type { CodexDecision, PermissionRequestInfo } from '../types';
import { describeTool } from '../activity';

export interface DemoPermissionSource {
  /** Arquivos do projeto fictício (relativos à raiz). */
  files: readonly string[];
  /** Comandos de terminal do projeto fictício. */
  commands: readonly string[];
}

/** Quanto tempo o "hook" fictício espera antes de devolver o pedido ao terminal. */
export const DEMO_PERMISSION_MS = 5 * 60_000;

/** Linhas de um diff fictício, no formato do terminal ("- antiga" / "+ nova"). */
const DEMO_DIFFS: readonly string[][] = [
  ['- const total = items.reduce((s, i) => s + i.price, 0);', '+ const total = items.reduce((s, i) => s + i.price * i.qty, 0);', '+ if (total < 0) throw new Error("total inválido");'],
  ['- export const TIMEOUT = 5_000;', '+ export const TIMEOUT = 15_000;'],
  ['- <button onClick={save}>Salvar</button>', '+ <button onClick={save} disabled={saving}>', '+   {saving ? "Salvando…" : "Salvar"}', '+ </button>'],
];

interface DemoQuestion {
  header: string;
  question: string;
  multiSelect?: boolean;
  options: Array<{ label: string; description?: string }>;
}

/** Perguntas fictícias do AskUserQuestion: uma de escolha única e uma em que dá para marcar várias. */
const DEMO_QUESTIONS: readonly DemoQuestion[][] = [
  [
    {
      header: 'Cache',
      question: 'Onde guardo o cache das sessões de login?',
      options: [
        { label: 'Redis', description: 'Rápido, e já roda no docker-compose do projeto' },
        { label: 'PostgreSQL', description: 'Uma tabela a mais no banco que já existe' },
        { label: 'Memória', description: 'Mais simples, mas some quando o servidor reinicia' },
      ],
    },
    {
      header: 'Testes',
      question: 'Quais testes eu rodo antes do commit?',
      multiSelect: true,
      options: [
        { label: 'Unidade', description: 'npm test, cerca de 40 s' },
        { label: 'Integração', description: 'Sobe um banco de teste no Docker' },
        { label: 'E2E', description: 'Playwright no navegador, uns 5 min' },
      ],
    },
  ],
  [
    {
      header: 'Erro de rede',
      question: 'Como trato a falha de rede no checkout?',
      options: [
        { label: 'Tentar de novo', description: 'Até 3 tentativas, com espera crescente' },
        { label: 'Avisar o cliente', description: 'Mensagem com um botão para tentar de novo' },
        { label: 'Guardar e enviar depois', description: 'Fila local até a conexão voltar' },
      ],
    },
    {
      header: 'Telas',
      question: 'Em quais telas aplico a mudança?',
      multiSelect: true,
      options: [{ label: 'Carrinho' }, { label: 'Pagamento' }, { label: 'Confirmação do pedido' }],
    },
  ],
];

/** As perguntas em texto, como o terminal mostra os argumentos do AskUserQuestion. */
function questionsText(qs: readonly DemoQuestion[]): string {
  return qs.map((q) => [q.question, ...q.options.map((o) => `  - ${o.label}${o.description ? `: ${o.description}` : ''}`)].join('\n')).join('\n\n');
}

/** Tipo de pedido fictício: permissão (comando, edição, página) ou pergunta do AskUserQuestion. */
export type DemoPermissionKind = 'permission' | 'question';

/**
 * Um pedido fictício (comando no terminal, edição de arquivo, leitura de página ou pergunta do AskUserQuestion),
 * com a sugestão de "sempre permitir" que o Claude Code costuma oferecer para comandos. `kind` força o tipo
 * (testes e capturas de tela); sem ele, é sorteado.
 */
export function demoPermission(id: string, src: DemoPermissionSource, rng: () => number, now: number, kind?: DemoPermissionKind): PermissionRequestInfo {
  const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rng() * arr.length)];
  const roll = kind === 'question' ? 1 : kind === 'permission' ? rng() * 0.9 : rng();
  const base = { id, createdAt: now, expiresAt: now + DEMO_PERMISSION_MS };
  if (roll >= 0.9) {
    const qs = pick(DEMO_QUESTIONS);
    const d = describeTool('AskUserQuestion', { questions: qs });
    return { ...base, tool: 'AskUserQuestion', title: `AskUserQuestion(${qs[0].question})`, text: d.text, icon: d.icon, input: questionsText(qs), inputKind: 'text', questions: d.questions };
  }
  if (roll < 0.55 && src.commands.length) {
    const command = pick(src.commands);
    const d = describeTool('Bash', { command });
    const prefix = command.split(/\s+/).slice(0, 2).join(' ');
    return {
      ...base,
      tool: 'Bash',
      title: `Bash(${command})`,
      text: d.text,
      icon: d.icon,
      input: command,
      inputKind: 'command',
      suggestions: [{ index: 0, rules: [`Bash(${prefix}:*)`], destination: 'localSettings' }],
    };
  }
  if (roll < 0.8 && src.files.length) {
    const file = pick(src.files);
    const d = describeTool('Edit', { file_path: file });
    return { ...base, tool: 'Edit', title: `Edit(${file})`, text: d.text, icon: d.icon, input: pick(DEMO_DIFFS).join('\n'), inputKind: 'diff' };
  }
  const url = 'https://developer.mozilla.org/pt-BR/docs/Web/API/Fetch_API';
  const d = describeTool('WebFetch', { url });
  return {
    ...base,
    tool: 'WebFetch',
    title: `WebFetch(${url})`,
    text: d.text,
    icon: d.icon,
    input: 'Resuma como tratar erros de rede com fetch',
    inputKind: 'text',
    suggestions: [{ index: 0, rules: ['WebFetch(domain:developer.mozilla.org)'], destination: 'localSettings' }],
  };
}

/**
 * Quanto o "hook" do Codex espera pela decisão do escritório (HABBLAUD_CODEX_PERMISSION_TIMEOUT, padrão 25 s). Depois
 * disso o Codex segue o fluxo normal e a aprovação aparece no terminal.
 */
export const DEMO_CODEX_PERMISSION_MS = 25_000;

/** Destinos de rede fictícios (o Codex pede acesso à rede como um Bash com a descrição "network-access <alvo>"). */
const DEMO_NETWORK: ReadonlyArray<[host: string, command: string]> = [
  ['registry.npmjs.org', 'npm install'],
  ['pypi.org', 'pip install -r requirements.txt'],
  ['api.github.com', 'gh pr view --json title'],
];

/** O diff de um apply_patch no formato do Codex (Begin/End Patch, linhas "-antiga" e "+nova"). */
export function demoPatchText(file: string, lines: readonly string[], add = false): string {
  const body = lines.map((l) => (l.startsWith('- ') ? `-${l.slice(2)}` : l.startsWith('+ ') ? `+${l.slice(2)}` : add ? `+${l}` : ` ${l}`));
  return ['*** Begin Patch', `*** ${add ? 'Add' : 'Update'} File: ${file}`, ...(add ? [] : ['@@']), ...body, '*** End Patch'].join('\n');
}

/** Canal paralelo: as decisões que o app-server oferece num apply_patch (fileChange). */
const DEMO_PATCH_DECISIONS: readonly CodexDecision[] = ['accept', 'acceptForSession', 'decline', 'cancel'];
/**
 * Canal paralelo: num comando, o Codex oferece a emenda de execpolicy no lugar do "nesta sessão", e o Habblaud só
 * conhece as quatro decisões (a emenda fica de fora).
 */
const DEMO_COMMAND_DECISIONS: readonly CodexDecision[] = ['accept', 'decline', 'cancel'];

/**
 * Um pedido de aprovação fictício do Codex: comando no terminal, apply_patch ou acesso à rede. Sem sugestões de
 * "sempre permitir" e nunca uma pergunta. `mode` = por onde o pedido chega: 'blocking' (padrão) = hook
 * PermissionRequest, com prazo curto; 'parallel' = canal paralelo do app-server (TUI ligado ao daemon), sem prazo, com
 * as decisões do canal e o comando como `exec_command` (o acesso à rede chega como o próprio comando). Os sorteios
 * são os mesmos nos dois modos.
 */
export function demoCodexPermission(id: string, src: DemoPermissionSource, rng: () => number, now: number, mode: 'blocking' | 'parallel' = 'blocking'): PermissionRequestInfo {
  const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rng() * arr.length)];
  const roll = rng();
  const parallel = mode === 'parallel';
  // 'parallel': sem prazo, como o registro (nem o relógio nem a página leem o expiresAt desses pedidos).
  const base = parallel
    ? { id, provider: 'codex' as const, mode: 'parallel' as const, createdAt: now, expiresAt: Number.MAX_SAFE_INTEGER }
    : { id, provider: 'codex' as const, createdAt: now, expiresAt: now + DEMO_CODEX_PERMISSION_MS };
  const command = (cmd: string): PermissionRequestInfo => {
    const d = describeTool('Bash', { command: cmd });
    const req: PermissionRequestInfo = { ...base, tool: parallel ? 'exec_command' : 'Bash', title: `Bash(${cmd})`, text: d.text, icon: d.icon, input: cmd, inputKind: 'command' };
    return parallel ? { ...req, decisions: [...DEMO_COMMAND_DECISIONS] } : req;
  };
  if (roll < 0.3 && src.files.length) {
    const file = pick(src.files);
    const d = describeTool('Edit', { file_path: file });
    const req: PermissionRequestInfo = { ...base, tool: 'apply_patch', title: `apply_patch(${file})`, text: d.text, icon: d.icon, input: demoPatchText(file, pick(DEMO_DIFFS)), inputKind: 'diff' };
    return parallel ? { ...req, decisions: [...DEMO_PATCH_DECISIONS] } : req;
  }
  if (roll < 0.45) {
    const [host, cmd] = pick(DEMO_NETWORK);
    if (parallel) return command(cmd);
    return { ...base, tool: 'Bash', title: `Bash(${cmd})`, text: `Acesso à rede: ${host}`, icon: '🌐', input: cmd, inputKind: 'command' };
  }
  return command(src.commands.length ? pick(src.commands) : 'npm test');
}
