// Descrição das ferramentas do Codex: o que o personagem está fazendo em cada chamada (comando, patch, MCP, busca na web,
// plano, multiagente...), pelo nome que ela tem no rollout, no hook ou no app. O texto livre do modelo passa pela
// máscara (rollout-mask.ts) antes de qualquer corte.
import { describePrompt, describeTool, truncate, type ActivityDescription } from '../../../shared/activity';
import type { TaskItem, TaskStatus } from '../../../shared/types';
import { unwrapCommand } from './command';
import { ACTIVITY_TEXT_MAX, maskedCut, maskedInput, maskedQuestions, maskedText, plainText } from './rollout-mask';
import { contentText } from './rollout-state';
import { rec, str, type Rec } from './rollout-util';

// ------------------------------------------------------------------ comandos

/**
 * O comando legível de um CommandExecution/exec: `command` é uma lista (`["/bin/zsh", "-lc", "npm test"]`,
 * `["pwsh.exe", "-Command", "git status"]`, `["cmd.exe", "/c", "dir"]`) ou um texto. O invólucro do shell sai
 * (`command.ts`); sem invólucro, as palavras são juntadas com espaços (as que têm espaço vão entre aspas).
 */
export function commandText(cmd: unknown): string {
  return unwrapCommand(cmd).text;
}

const EXPLORE_CMD = new Set(['read', 'list_files', 'search']);

/**
 * Tipo de um comando concluído pelo `parsed_cmd` do CommandExecution (uma entrada por segmento do comando): só
 * quando todas as entradas são leitura, listagem ou busca (`ls && npm test` continua um comando); vale a primeira.
 * undefined = fica a heurística do Bash sobre o comando desembrulhado.
 */
export function parsedCmdActivity(parsed: unknown): ActivityDescription | undefined {
  const list = Array.isArray(parsed) ? parsed.map(rec) : [];
  const first = list[0];
  if (!first || !list.every((p) => p && EXPLORE_CMD.has(String(p.type)))) return undefined;
  const path = str(first.path) ?? str(first.name);
  if (first.type === 'read' && path) return describeTool('Read', { file_path: path });
  if (first.type === 'list_files') return describeTool('LS', { path: path ?? '' });
  // Mascara antes: o Grep corta a busca em 26 antes da máscara e o começo de um token vazaria no texto.
  if (first.type === 'search') return describeTool('Grep', { pattern: maskedCut(str(first.query) ?? '') });
  return undefined;
}

/** Arquivos tocados por um patch do apply_patch ("*** Add File: x", "*** Update File: y", "*** Delete File: z"). */
export function patchFiles(patch: string): Array<{ path: string; kind: 'add' | 'update' | 'delete' }> {
  const out: Array<{ path: string; kind: 'add' | 'update' | 'delete' }> = [];
  for (const m of patch.slice(0, 200_000).matchAll(/^\*\*\* (Add|Update|Delete) File: (.+)$/gm)) {
    out.push({ path: m[2].trim(), kind: m[1].toLowerCase() as 'add' | 'update' | 'delete' });
  }
  return out;
}

/** Uma mudança de arquivo de um FileChange: o mapa {caminho: {type, content | unified_diff}} ou a lista {path, kind, diff}. */
export interface FileChangeEntry {
  path: string;
  kind: 'add' | 'update' | 'delete';
  /** Diff unificado (update) ou o conteúdo (add/delete). */
  text: string;
  movePath?: string;
}

function changeKind(v: unknown): FileChangeEntry['kind'] {
  const k = typeof v === 'string' ? v : str(rec(v)?.type);
  return k === 'add' || k === 'delete' ? k : 'update';
}

export function fileChanges(raw: unknown): FileChangeEntry[] {
  const out: FileChangeEntry[] = [];
  const push = (path: unknown, c: Rec) => {
    const p = str(path);
    if (!p) return;
    const kind = changeKind(c.type ?? c.kind);
    const text = str(c.unified_diff) ?? str(c.diff) ?? str(c.content) ?? '';
    const e: FileChangeEntry = { path: p, kind, text };
    const move = str(c.move_path) ?? str(rec(c.kind)?.move_path);
    if (move) e.movePath = move;
    out.push(e);
  };
  if (Array.isArray(raw)) for (const c of raw) push(rec(c)?.path, rec(c) ?? {});
  else if (rec(raw)) for (const [path, c] of Object.entries(rec(raw)!)) push(path, rec(c) ?? {});
  return out;
}

/**
 * Caminho de um `file://` (cwd e caminhos do Codex vêm como URL). No Windows a URL é `file:///C:/x/y` e o caminho é
 * `C:/x/y` (sem a barra antes da letra do drive), em qualquer plataforma: o Docker também lê rollouts do Windows.
 */
export function pathFromUri(v: unknown): string | undefined {
  const s = str(v);
  if (!s) return undefined;
  if (!s.startsWith('file://')) return s;
  let path: string;
  try {
    path = decodeURIComponent(new URL(s).pathname);
  } catch {
    path = s.slice('file://'.length);
  }
  return /^\/[A-Za-z]:(?:[/\\]|$)/.test(path) ? path.slice(1) : path;
}

/** Argumentos de uma chamada de função: string JSON (o normal) ou objeto. */
export function parseArguments(raw: unknown): Rec {
  if (rec(raw)) return rec(raw)!;
  if (typeof raw !== 'string' || !raw.trim()) return {};
  try {
    return rec(JSON.parse(raw)) ?? {};
  } catch {
    return {};
  }
}

/** Nome MCP no formato do Claude Code: `mcp__<servidor>__<ferramenta>`. */
export function mcpName(server: unknown, tool: unknown): string {
  return `mcp__${String(server ?? '?')}__${String(tool ?? '?')}`;
}

/**
 * Mensagem do agente para você no code mode do app: a ferramenta `user_messaging.send_message` (MCP do próprio app,
 * `{text}`) faz o papel da resposta. Devolve o texto, ou undefined se não for essa ferramenta.
 */
export function userMessagingText(server: unknown, tool: unknown, args: unknown): string | undefined {
  if (!/user_messag(?:e|ing)[_.]*send_message$/i.test(`${String(server ?? '')}__${String(tool ?? '')}`)) return undefined;
  const text = rec(args)?.text ?? parseArguments(args).text;
  return typeof text === 'string' && text.trim() ? text : undefined;
}

const DELIVERY_COMPLETE = 'codex:code-mode-delivery:v1:complete';
const DELIVERY_INCOMPLETE = 'codex:code-mode-delivery:v1:incomplete:';

/**
 * Resposta entregue no code mode, gravada como `response_item` message/assistant com
 * `metadata.delivered_assistant_message` (o marcador; no "incomplete", o texto cortado vem nele). Undefined = não é.
 */
export function deliveredMessage(line: Rec): { id?: string; text: string } | undefined {
  const marker = str(rec(line.metadata)?.delivered_assistant_message);
  const p = rec(line.payload);
  if (!marker || !p || p.type !== 'message' || p.role !== 'assistant') return undefined;
  let text = '';
  if (marker === DELIVERY_COMPLETE) text = contentText(p.content).text;
  else if (marker.startsWith(DELIVERY_INCOMPLETE)) text = marker.slice(DELIVERY_INCOMPLETE.length);
  if (!text.trim()) return undefined;
  const id = str(p.id);
  return id ? { id, text } : { text };
}

/** Atividade de uma instrução recebida pelo Codex: "Recebeu “…”" (kind 'prompt', a base do "Concluiu em X"). */
export function describeCodexPrompt(text: string): ActivityDescription {
  // O detalhe sai do describePrompt, que corta antes de mascarar: ele recebe o texto já mascarado.
  const masked = maskedCut(text);
  return { ...describePrompt(masked), text: truncate(`Recebeu “${truncate(masked, 34)}”`, 46) };
}

const PLAN_STATUS = new Set<string>(['pending', 'in_progress', 'completed']);

/** Passos do `update_plan` ({plan: [{step, status}]}) como tarefas. */
export function planTasks(args: Rec): TaskItem[] | undefined {
  if (!Array.isArray(args.plan)) return undefined;
  const out: TaskItem[] = [];
  args.plan.forEach((raw, i) => {
    const p = rec(raw);
    const title = str(p?.step);
    if (!p || !title) return;
    const status = typeof p.status === 'string' && PLAN_STATUS.has(p.status) ? (p.status as TaskStatus) : 'pending';
    out.push({ id: String(i + 1), title: maskedCut(title, 120), status });
  });
  return out;
}

const PLAN_CALL = 'tools.update_plan(';
/** Maior literal lido no argumento do tools.update_plan (o resto do script não importa). */
const PLAN_LITERAL_MAX = 20_000;
const JS_WORD = /[A-Za-z_$][\w$]*/y;
const JS_COLON = /\s*:/y;

/**
 * Argumento do último `tools.update_plan({...})` do JavaScript do code mode (`exec`): parse tolerante do literal
 * (aspas simples, crase, chaves sem aspas, vírgula final), SEM executar nada. undefined = sem chamada, argumento que
 * não é literal (variável, função) ou literal ilegível.
 */
export function planFromScript(js: string): Rec | undefined {
  const at = js.lastIndexOf(PLAN_CALL);
  if (at < 0) return undefined;
  const from = at + PLAN_CALL.length;
  const open = js.indexOf('{', from);
  if (open < 0 || js.slice(from, open).trim()) return undefined;
  const literal = balancedLiteral(js, open);
  if (!literal) return undefined;
  try {
    return rec(JSON.parse(looseJson(literal)));
  } catch {
    return undefined;
  }
}

/** Trecho `{…}` que começa em `start`, respeitando strings ('…', "…", `…`); undefined se não fechar dentro do limite. */
function balancedLiteral(text: string, start: number): string | undefined {
  let depth = 0;
  let quote = '';
  const end = Math.min(text.length, start + PLAN_LITERAL_MAX);
  for (let i = start; i < end; i++) {
    const c = text[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = '';
    } else if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
}

/** Literal de objeto JS → JSON: aspas simples e crase viram duplas, chaves sem aspas ganham aspas, vírgula final sai. */
function looseJson(literal: string): string {
  let out = '';
  for (let i = 0; i < literal.length; i++) {
    const c = literal[i];
    if (c === '"' || c === "'" || c === '`') {
      let s = '';
      for (i++; i < literal.length && literal[i] !== c; i++) {
        const ch = literal[i];
        if (ch === '\\' && i + 1 < literal.length) {
          const next = literal[++i];
          s += next === "'" || next === '`' ? next : `\\${next}`;
        } else if (ch === '"') s += '\\"';
        else if (ch === '\n') s += '\\n';
        else if (ch === '\r') s += '\\r';
        else if (ch === '\t') s += '\\t';
        else s += ch;
      }
      out += `"${s}"`;
      continue;
    }
    JS_WORD.lastIndex = i;
    const word = JS_WORD.exec(literal)?.[0];
    if (word) {
      JS_COLON.lastIndex = i + word.length;
      out += JS_COLON.test(literal) ? `"${word}"` : word;
      i += word.length - 1;
      continue;
    }
    out += c;
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

/** Namespaces cujas ferramentas ganham nome composto (`web::run` → `web.run`, `clock::sleep` → `clock.sleep`). */
const DOTTED_NAMESPACES = new Set(['web', 'clock']);

export function sleepDesc(): ActivityDescription {
  return { kind: 'wait', icon: '⏳', text: 'Esperando um pouco' };
}

/** Busca na web (Extension web.search): página aberta vira leitura (WebFetch); senão a busca (WebSearch). */
export function webDesc(action: unknown, query?: string): { desc: ActivityDescription; tool: string } {
  const a = rec(action) ?? {};
  const url = str(a.url);
  if ((a.type === 'open_page' || a.type === 'find_in_page') && url) return { desc: describeTool('WebFetch', { url }), tool: 'WebFetch' };
  const q = str(a.query) ?? (Array.isArray(a.queries) ? str(a.queries[0]) : undefined) ?? query;
  return { desc: describeTool('WebSearch', { query: maskedText(q) }), tool: 'WebSearch' };
}

/** web::run: a 1ª busca de `search_query[]` ({q} ou texto) ou a 1ª página de `open[]` ({ref_id}/{url} ou texto). */
function webRunDesc(input: Rec): { desc: ActivityDescription; tool: string } {
  const first = (v: unknown, keys: string[]): string | undefined => {
    const e: unknown = Array.isArray(v) ? v[0] : undefined;
    if (typeof e === 'string') return str(e);
    const o = rec(e);
    return o ? keys.map((k) => str(o[k])).find((x) => x !== undefined) : undefined;
  };
  const query = first(input.search_query, ['q', 'query']);
  if (query) return { desc: describeTool('WebSearch', { query: maskedText(query) }), tool: 'WebSearch' };
  const url = first(input.open, ['ref_id', 'url']);
  if (url) return { desc: describeTool('WebFetch', { url }), tool: 'WebFetch' };
  return { desc: describeTool('WebSearch', {}), tool: 'WebSearch' };
}

/**
 * Rótulo do send_message pelo destino (`target`: caminho absoluto "/root/…" ou relativo a quem manda) e pelo caminho de
 * quem manda, quando conhecido. O relativo é sempre abaixo de quem manda (o Codex não aceita ".." nem "root" nele); sem
 * dados que bastem, o rótulo é neutro.
 */
function messageLabel(target: unknown, self: string | undefined): string {
  const t = typeof target === 'string' ? target.trim() : '';
  if (t === '/root') return 'Mensagem para o agente principal';
  if (t && !t.startsWith('/')) return 'Mensagem para um subagente';
  if (self && (t ? t.startsWith(`${self}/`) : self === '/root')) return 'Mensagem para um subagente';
  if (self && t && t === self.slice(0, self.lastIndexOf('/'))) return 'Mensagem para o agente pai';
  return 'Mensagem entre agentes';
}

/**
 * Atividade de uma ferramenta do Codex pelo nome que ela tem no rollout, no hook ou no app (exec_command, shell,
 * Bash, apply_patch, mcp__…, spawn_agent, exec do code mode...). `name` volta normalizado (Bash, Edit, Write,
 * mcp__…) para o Activity.tool. `from.agentPath` = o caminho de quem chama (codexAgentPath), para o destino do send_message.
 */
export function describeCodexTool(rawName: string, input: Rec, namespace?: string, from: { agentPath?: string } = {}): { desc: ActivityDescription; tool: string } {
  const name =
    namespace && /^mcp__/.test(namespace) ? `${namespace.replace(/_+$/, '')}__${rawName}` : namespace && DOTTED_NAMESPACES.has(namespace) ? `${namespace}.${rawName}` : rawName;
  switch (name) {
    case 'Bash':
    case 'shell':
    case 'shell_command':
    case 'local_shell':
    case 'exec_command':
    case 'container.exec': {
      const command = commandText(input.cmd ?? input.command);
      return { desc: describeTool('Bash', { command: maskedCut(command), description: maskedText(input.description) }), tool: 'Bash' };
    }
    case 'write_stdin':
      return { desc: { kind: 'run', icon: '⌨️', text: 'Interagindo com um comando' }, tool: name };
    case 'apply_patch': {
      const patch = typeof input.command === 'string' ? input.command : typeof input.input === 'string' ? input.input : typeof input.patch === 'string' ? input.patch : '';
      const files = patchFiles(patch);
      const first = files[0];
      if (!first) return { desc: describeTool('Edit', {}), tool: 'Edit' };
      const tool = first.kind === 'add' ? 'Write' : 'Edit';
      const desc = describeTool(tool, { file_path: first.path });
      if (files.length > 1) desc.detail = truncate(files.map((f) => f.path).join(', '), 300);
      return { desc, tool };
    }
    case 'exec':
      // Code mode do app: o argumento é JavaScript; o comando legível só aparece no CommandExecution ao concluir.
      return { desc: { kind: 'run', icon: '⚙️', text: 'Executando código' }, tool: name };
    case 'update_plan':
      return { desc: { kind: 'plan', icon: '🗒️', text: 'Atualizando o plano' }, tool: name };
    case 'view_image': {
      const path = str(input.path);
      return { desc: describeTool('Read', { file_path: path ?? 'imagem.png' }), tool: 'Read' };
    }
    case 'web_search':
    case 'web_search_preview':
      return { desc: describeTool('WebSearch', { query: maskedText(input.query) }), tool: 'WebSearch' };
    case 'spawn_agent':
    case 'Agent': {
      const prompt = plainText(input.message) ?? plainText(input.prompt) ?? plainText(input.task);
      if (prompt) return { desc: describeTool('Agent', { description: maskedCut(prompt, 60), subagent_type: maskedText(input.agent_type) }), tool: 'Agent' };
      // Mensagem cifrada (0.160.1) ou ausente: rótulo neutro com o nome da tarefa, nunca o texto cifrado.
      const base = describeTool('Agent', { subagent_type: maskedText(input.agent_type) });
      const task = plainText(input.task_name);
      return { desc: task ? { ...base, text: maskedCut(`Delegando ao subagente ${task}`, ACTIVITY_TEXT_MAX) } : base, tool: 'Agent' };
    }
    case 'wait':
    case 'wait_agent':
      return { desc: { kind: 'delegate', icon: '⏳', text: 'Esperando os subagentes' }, tool: name };
    case 'send_message':
      return { desc: { kind: 'communicate', icon: '💬', text: messageLabel(input.target, from.agentPath) }, tool: name };
    case 'send_input':
    case 'followup_task':
      return { desc: { kind: 'communicate', icon: '💬', text: 'Mensagem para um subagente' }, tool: name };
    case 'close_agent':
      return { desc: { kind: 'delegate', icon: '👥', text: 'Encerrando um subagente' }, tool: name };
    case 'request_permissions':
      return { desc: { kind: 'wait', icon: '🔐', text: 'Pedindo permissões' }, tool: name };
    case 'request_user_input':
      // Pergunta síncrona: o turno para até você responder (kind 'ask': o escritório não sobrepõe o "Precisa de você").
      return { desc: { ...describeTool('AskUserQuestion', { questions: maskedQuestions(input.questions) }), text: 'Esperando você responder' }, tool: name };
    case 'web.run':
      return webRunDesc(input);
    case 'clock.sleep':
      return { desc: sleepDesc(), tool: name };
    default:
      return { desc: describeTool(name, maskedInput(input)), tool: name };
  }
}
