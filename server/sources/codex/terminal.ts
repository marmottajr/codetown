// Terminal do Codex: converte as linhas do rollout em TerminalEntry (prompts, respostas, raciocínio resumido,
// comandos com a saída, mudanças de arquivo, chamadas MCP), com segredos mascarados e textos truncados pelas mesmas
// regras do terminal do Claude Code (sources/terminal.ts).
//
// No formato paginated a conversa sai dos `item_completed`; dos `response_item` só entram as chamadas de ferramenta e
// as saídas (as mensagens e o raciocínio são o contexto mandado ao modelo, com mensagens injetadas, e têm gêmeo em
// item_completed). A chamada vira a entrada na hora (comando em andamento; shell_command de rollouts migrados, que não
// têm CommandExecution); a saída e o item_completed de mesmo id (call_id) completam a MESMA entrada: a ferramenta tem
// o id da chamada, o resultado `<id>:r`, e o primeiro que chega vence (o resto cai no `seen`). No legacy (threads
// antigos), o básico: user_message, agent_message, agent_reasoning e os pares function_call/function_call_output.
// Só o 1º session_meta vale, e a história herdada por um subagente com fork (ordinal < historyStart) fica de fora.
import type { TerminalEntry, TerminalInputKind } from '../../../shared/types';
import { formatDuration, maskSecrets } from '../../../shared/activity';
import { marked, oneLine, prepare, RESULT_MAX, RESULT_MAX_LINES, TEXT_MAX, THINKING_MAX, TITLE_ARG_MAX, toolView, INPUT_MAX, type TerminalParser } from '../terminal';
import { unwrapCommand } from './command';
import {
  contentText,
  deliveredMessage,
  fileChanges,
  isEncryptedText,
  mcpName,
  parseArguments,
  parseSessionMeta,
  patchFiles,
  pathFromUri,
  promptText,
  userMessagingText,
  type HistoryMode,
  type RolloutMeta,
} from './rollout';

type Rec = Record<string, unknown>;
type ToolEntry = Extract<TerminalEntry, { kind: 'tool' }>;
type ResultEntry = Extract<TerminalEntry, { kind: 'result' }>;
type SystemEntry = Extract<TerminalEntry, { kind: 'system' }>;
type View = ReturnType<typeof toolView>;

const SEEN_MAX = 20_000;
const SHELL_TOOLS = /^(shell|shell_command|local_shell|exec_command|container\.exec)$/;
/** Saída do exec_command que ainda não acabou: o resultado de verdade vem no CommandExecution de mesmo id. */
const RUNNING = /^Process running with session ID\b/m;
/** Código de saída no texto da saída (shell_command: "Exit code: N"; exec_command: "Process exited with code N"). */
const EXIT_CODE = /^(?:Exit code:|Process exited with code)\s*(-?\d+)/m;
/** Falha sem código de saída: o comando nem começou ou o patch não confere. */
const FAILED = /^(?:exec_command failed|apply_patch verification failed)/;
const PLAN_MARK: Record<string, string> = { completed: '☒', in_progress: '◐', pending: '☐' };

function rec(v: unknown): Rec | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function toMs(v: unknown): number | undefined {
  if (typeof v !== 'string') return undefined;
  const t = Date.parse(v);
  return Number.isNaN(t) ? undefined : t;
}

/** Texto de um resultado MCP ({content: [{type: 'text', text}...]}) ou de uma saída de função. */
function resultText(raw: unknown): string {
  if (typeof raw === 'string') {
    try {
      const j = rec(JSON.parse(raw));
      if (j && typeof j.output === 'string') return j.output;
    } catch {
      // texto puro
    }
    return raw;
  }
  const o = rec(raw);
  if (o) {
    if (Array.isArray(o.content)) return contentText(o.content).text || (o.structuredContent ? JSON.stringify(o.structuredContent) : '');
    if (typeof o.output === 'string') return o.output;
    if (typeof o.Ok === 'object' || typeof o.Err === 'string') return resultText(o.Ok ?? o.Err);
  }
  if (Array.isArray(raw)) return contentText(raw).text;
  return '';
}

/** "Nome(argumento)" com o argumento numa linha, mascarado e cortado (como o do terminal do Claude, que não o exporta). */
function titled(label: string, arg: string | undefined): string {
  const shown = arg ? oneLine(arg, TITLE_ARG_MAX, false) : '';
  return shown ? `${label}(${shown})` : label;
}

/** Mensagem do multiagente: a cifrada (0.160.1) vira um aviso; o texto cifrado nunca aparece. */
function readable<T>(v: T): T | string {
  return typeof v === 'string' && isEncryptedText(v) ? '(mensagem cifrada)' : v;
}

/** Texto livre como entrada da ferramenta, mascarado antes do corte. */
function textInput(raw: string | undefined): Pick<View, 'input' | 'inputKind'> {
  if (!raw?.trim()) return {};
  const input = marked(prepare(raw, INPUT_MAX, Infinity, false));
  return input ? { input, inputKind: 'text' } : {};
}

/** Nome da chamada no formato do item_completed: `mcp__<servidor>__<ferramenta>` pelo nome (também com `::`) ou pelo namespace. */
function callName(name: string, namespace: string | undefined): string {
  if (name.startsWith('mcp__')) return name.replace('::', '__');
  if (namespace?.startsWith('mcp__')) return `${namespace.replace(/_+$/, '')}__${name}`;
  return name;
}

/** Comando de shell sem o invólucro (`pwsh -Command`, `cmd /c`, `bash -lc`): Bash(git status). */
function bashView(cmd: unknown, cwd: string | undefined): View {
  return toolView('Bash', { command: unwrapCommand(cmd).text }, cwd);
}

/** update_plan ({explanation?, plan: [{step, status}]}): "update_plan(1/3 concluídas)" e a lista ☒/◐/☐. */
function planView(args: Rec): View {
  const steps = Array.isArray(args.plan) ? args.plan.map(rec).filter((s): s is Rec => !!s) : [];
  const list = steps.map((s) => `${PLAN_MARK[String(s.status)] ?? '☐'} ${str(s.step) ?? '(sem título)'}`).join('\n');
  const done = steps.filter((s) => s.status === 'completed').length;
  const body = [str(args.explanation), list].filter(Boolean).join('\n\n');
  return { title: steps.length ? `update_plan(${done}/${steps.length} concluídas)` : 'update_plan', ...textInput(body) };
}

function optionLine(o: unknown): string {
  if (typeof o === 'string') return o.trim() ? `  - ${o}` : '';
  const r = rec(o);
  const label = r ? str(r.label) : undefined;
  if (!r || !label) return '';
  const desc = str(r.description);
  return `  - ${label}${desc ? `: ${desc}` : ''}`;
}

/** request_user_input ({questions: [{question, options: [{label, description}]}]}) e o _async ({title, options: [texto]}). */
function questionsView(name: string, args: Rec): View {
  const qs = Array.isArray(args.questions) ? args.questions.map(rec).filter((q): q is Rec => !!q) : [];
  const question = (q: Rec) => str(q.question) ?? str(q.title) ?? str(q.header);
  const text = qs.map((q) => [question(q) ?? '', ...(Array.isArray(q.options) ? q.options.map(optionLine).filter(Boolean) : [])].join('\n')).join('\n\n');
  return { title: titled(name, qs.length ? question(qs[0]) : undefined), ...textInput(text) };
}

/** write_stdin: a sessão e quantos caracteres foram mandados, nunca o texto (pode ser uma senha digitada num prompt). */
function stdinView(args: Rec): View {
  const session = typeof args.session_id === 'number' || typeof args.session_id === 'string' ? String(args.session_id) : '';
  const n = typeof args.chars === 'string' ? args.chars.length : 0;
  const parts = [session && `sessão ${session}`, n ? `${n} caractere${n === 1 ? '' : 's'}` : ''].filter(Boolean);
  return { title: titled('write_stdin', parts.join(', ')) };
}

class CodexTerminalParser implements TerminalParser {
  private out: TerminalEntry[] = [];
  private readonly seen = new Set<string>();
  /** O 1º session_meta (ou o lido à parte): os seguintes são do pai (fork) ou repetidos (resume). */
  private meta?: RolloutMeta;
  private mode?: HistoryMode;
  private cwd?: string;
  private lastAt?: number;
  private seq = 0;
  /** Chamadas vistas (call_id → nome): só a saída de uma chamada conhecida vira resultado. */
  private readonly calls = new Map<string, string>();

  constructor(opts: { meta?: RolloutMeta }) {
    if (opts.meta) this.useMeta(opts.meta);
  }

  push(line: string): TerminalEntry[] {
    this.out = [];
    try {
      this.line(line);
    } catch {
      // Linha estranha demais: fica o que já tiver saído dela; a leitura segue.
    }
    return this.out;
  }

  private emit(e: TerminalEntry): void {
    if (this.seen.has(e.id)) return;
    this.seen.add(e.id);
    if (this.seen.size > SEEN_MAX) this.seen.delete(this.seen.values().next().value as string);
    this.out.push(e);
  }

  private useMeta(meta: RolloutMeta): void {
    this.meta = meta;
    this.mode = meta.historyMode;
    this.cwd = meta.cwd;
  }

  /** Linha que não é deste thread: session_meta depois do 1º ou história herdada do pai (ordinal < historyStart). */
  private notOwn(j: Rec): boolean {
    if (!this.meta) return false;
    if (j.type === 'session_meta') return true;
    const start = this.meta.historyStart;
    return start !== undefined && typeof j.ordinal === 'number' && j.ordinal < start;
  }

  private line(raw: string): void {
    if (raw.length < 2) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    const j = rec(parsed);
    const p = rec(j?.payload);
    if (!j || !p || this.notOwn(j)) return;
    const ts = toMs(j.timestamp);
    if (ts !== undefined) this.lastAt = ts;
    const at = ts ?? this.lastAt ?? Date.now();
    const key = typeof j.ordinal === 'number' ? `o${j.ordinal}` : `l${++this.seq}`;
    switch (j.type) {
      case 'session_meta':
        return this.useMeta(parseSessionMeta(p));
      case 'turn_context':
        this.cwd ??= str(p.cwd);
        return;
      case 'event_msg':
        return this.event(p, at, key);
      case 'response_item': {
        // Resposta entregue no code mode do app: vale em qualquer formato (o id é o da chamada que a mandou).
        const delivered = deliveredMessage(j);
        if (delivered) return this.assistant(delivered.id ?? key, at, delivered.text);
        return this.responseItem(p, at, key);
      }
      case 'compacted':
        if (this.mode === 'legacy') this.sys(key, at, 'Conversa compactada');
        return;
      default:
        return;
    }
  }

  // ---------------------------------------------------------------- entradas

  private user(id: string, at: number, raw: string, images = 0): void {
    const clean = promptText(raw);
    const pics = images ? Array.from({ length: Math.min(images, 10) }, () => '[imagem]').join(' ') : '';
    const text = marked(prepare([clean, pics].filter(Boolean).join('\n'), TEXT_MAX));
    if (text) this.emit({ kind: 'user', id: `${id}:u`, at, text });
  }

  private assistant(id: string, at: number, raw: string): void {
    const text = marked(prepare(raw, TEXT_MAX));
    if (text) this.emit({ kind: 'assistant', id, at, text });
  }

  private thinking(id: string, at: number, raw: string): void {
    const text = raw.trim() ? marked(prepare(raw, THINKING_MAX)) : '';
    this.emit(text ? { kind: 'thinking', id, at, text } : { kind: 'thinking', id, at });
  }

  private sys(id: string, at: number, text: string, o: { level?: SystemEntry['level']; detail?: string } = {}): void {
    const e: SystemEntry = { kind: 'system', id: `${id}:s`, at, text: maskSecrets(text), level: o.level ?? 'info' };
    if (o.detail?.trim()) {
      const detail = marked(prepare(o.detail, 4_000));
      if (detail) e.detail = detail;
    }
    this.emit(e);
  }

  private tool(id: string, at: number, tool: string, view: { title: string; input?: string; inputKind?: TerminalInputKind }): void {
    const e: ToolEntry = { kind: 'tool', id, at, tool, title: maskSecrets(view.title) };
    if (view.input) {
      e.input = view.input;
      e.inputKind = view.inputKind;
    }
    this.emit(e);
  }

  private result(toolId: string, at: number, raw: string, error: boolean): void {
    const p = prepare(raw, RESULT_MAX, RESULT_MAX_LINES);
    const e: ResultEntry = { kind: 'result', id: `${toolId}:r`, at, toolUseId: toolId, text: p.text || '(sem saída)' };
    if (error) e.error = true;
    if (p.truncated) e.truncated = true;
    this.emit(e);
  }

  // ---------------------------------------------------------------- event_msg

  private event(p: Rec, at: number, key: string): void {
    switch (p.type) {
      case 'item_completed':
        return this.item(rec(p.item), at, key);
      case 'task_complete':
      case 'turn_complete': {
        const ms = num(p.duration_ms);
        const err = rec(p.error);
        if (err) this.sys(`${str(p.turn_id) ?? key}:err`, at, `Erro: ${oneLine(str(err.message) ?? 'desconhecido', 160)}`, { level: 'error' });
        if (ms !== undefined && ms >= 0) this.sys(`${str(p.turn_id) ?? key}:done`, at, `Turno concluído em ${formatDuration(ms)}`);
        return;
      }
      case 'turn_aborted':
        if (p.reason === 'interrupted' || p.reason === undefined) this.sys(`${str(p.turn_id) ?? key}:int`, at, 'Interrompido pelo usuário', { level: 'warn' });
        return;
      // ---- legacy
      case 'user_message':
        if (this.mode === 'paginated') return;
        this.mode ??= 'legacy';
        return this.user(key, at, str(p.message) ?? '', Array.isArray(p.images) ? p.images.length : 0);
      case 'agent_message':
        if (this.mode === 'paginated') return;
        this.mode ??= 'legacy';
        return this.assistant(key, at, str(p.message) ?? '');
      case 'agent_reasoning':
        if (this.mode === 'paginated') return;
        return this.thinking(key, at, str(p.text) ?? '');
      case 'exec_command_end':
        if (this.mode === 'paginated') return;
        return this.command(str(p.call_id) ?? key, at, p.command, str(p.aggregated_output) ?? str(p.formatted_output) ?? str(p.stdout) ?? '', num(p.exit_code), str(p.status));
      case 'context_compacted':
        if (this.mode === 'paginated') return;
        return this.sys(key, at, 'Conversa compactada');
      default:
        return;
    }
  }

  /** item_completed. Com o id de uma chamada já vista, a ferramenta cai no `seen` e o item só completa o resultado. */
  private item(item: Rec | undefined, at: number, key: string): void {
    if (!item) return;
    const id = str(item.id) ?? key;
    switch (item.type) {
      case 'UserMessage': {
        this.mode ??= 'paginated';
        const { text, images } = contentText(item.content);
        return this.user(id, at, text, images);
      }
      case 'AgentMessage':
        this.mode ??= 'paginated';
        return this.assistant(id, at, contentText(item.content).text);
      case 'Reasoning': {
        this.mode ??= 'paginated';
        const summary = Array.isArray(item.summary_text) ? item.summary_text.filter((s): s is string => typeof s === 'string').join('\n\n') : '';
        return this.thinking(id, at, summary);
      }
      case 'CommandExecution':
        this.mode ??= 'paginated';
        return this.command(id, at, item.command, str(item.aggregated_output) ?? '', num(item.exit_code), str(item.status));
      case 'FileChange':
        this.mode ??= 'paginated';
        return this.fileChange(id, at, item.changes, str(item.status));
      case 'McpToolCall': {
        this.mode ??= 'paginated';
        // Code mode: a mensagem para você é a resposta (mesmo id da entrega gravada como response_item).
        const said = userMessagingText(item.server, item.tool, item.arguments);
        if (said) return this.assistant(id, at, said);
        const name = mcpName(item.server, item.tool);
        this.tool(id, at, name, toolView(name, rec(item.arguments) ?? parseArguments(item.arguments), this.cwd));
        const error = str(rec(item.error)?.message);
        if (error || item.result !== undefined) this.result(id, at, error ?? resultText(item.result), !!error || item.status === 'failed');
        return;
      }
      case 'WebSearch':
        return this.tool(id, at, 'WebSearch', toolView('WebSearch', { query: str(item.query) ?? '' }, this.cwd));
      case 'ImageView':
        return this.tool(id, at, 'view_image', toolView('Read', { file_path: pathFromUri(item.path) ?? '' }, this.cwd));
      case 'ContextCompaction':
        return this.sys(id, at, 'Conversa compactada');
      case 'CollabAgentToolCall': {
        const tool = str(item.tool) ?? 'spawn_agent';
        return this.tool(id, at, tool, toolView(tool, str(item.prompt) ? { prompt: readable(item.prompt) } : {}, this.cwd));
      }
      case 'Plan':
        return this.assistant(id, at, str(item.text) ?? '');
      default:
        return;
    }
  }

  private command(id: string, at: number, cmd: unknown, output: string, exitCode: number | undefined, status: string | undefined): void {
    this.tool(id, at, 'Bash', bashView(cmd, this.cwd));
    if (status === 'declined') return this.result(id, at, 'Recusado pelo usuário', true);
    const failed = status === 'failed' || (exitCode !== undefined && exitCode !== 0);
    const text = failed && exitCode !== undefined && exitCode !== 0 ? `Código de saída ${exitCode}\n${output}` : output;
    this.result(id, at, text, failed);
  }

  /** Caminho relativo ao cwd (como o Read do terminal do Claude o mostra). */
  private rel(p: string): string {
    return toolView('Read', { file_path: p }, this.cwd).title.replace(/^Read\(|\)$/g, '');
  }

  /** "Edit(a.ts)", "Edit(a.ts, b.ts)" ou "Edit(a.ts e mais 2)": a mesma regra no apply_patch e no FileChange (gêmeos pelo id). */
  private filesTitle(tool: string, paths: string[]): string {
    const names = paths.map((p) => this.rel(p));
    const arg = names.length > 2 ? `${names[0]} e mais ${names.length - 1}` : names.join(', ');
    return arg ? `${tool}(${arg})` : tool;
  }

  private fileChange(id: string, at: number, raw: unknown, status: string | undefined): void {
    const changes = fileChanges(raw);
    const tool = changes.length && changes.every((c) => c.kind === 'add') ? 'Write' : 'Edit';
    const diff = changes
      .slice(0, 12)
      .map((c) => {
        const head = `*** ${c.kind === 'add' ? 'Novo' : c.kind === 'delete' ? 'Apagado' : 'Alterado'}: ${this.rel(c.path)}${c.movePath ? ` → ${this.rel(c.movePath)}` : ''}`;
        const body = c.kind === 'update' ? c.text : c.text.replace(/\n$/, '').split('\n').map((l) => `${c.kind === 'add' ? '+' : '-'} ${l}`).join('\n');
        return `${head}\n${body}`;
      })
      .join('\n');
    const input = diff.trim() ? marked(prepare(diff, INPUT_MAX, Infinity, false)) : '';
    const title = this.filesTitle(tool, changes.map((c) => c.movePath ?? c.path));
    this.tool(id, at, tool, input ? { title, input, inputKind: 'diff' } : { title });
    if (status === 'declined') this.result(id, at, 'Recusado pelo usuário', true);
    else if (status === 'failed') this.result(id, at, 'A mudança não foi aplicada', true);
  }

  // ---------------------------------------------------------------- response_item (chamadas e saídas)

  private responseItem(p: Rec, at: number, key: string): void {
    switch (p.type) {
      case 'function_call':
      case 'custom_tool_call':
        return this.call(p, at, key);
      case 'local_shell_call': {
        const id = str(p.call_id) ?? key;
        this.remember(id, 'local_shell');
        return this.tool(id, at, 'Bash', bashView(rec(p.action)?.command, this.cwd));
      }
      case 'function_call_output':
      case 'custom_tool_call_output': {
        const id = str(p.call_id);
        const name = id ? this.calls.get(id) : undefined;
        if (!id || !name) return;
        const text = resultText(p.output);
        const head = text.slice(0, 500);
        if (name === 'exec_command' && this.mode !== 'legacy' && RUNNING.test(head)) return;
        const exit = EXIT_CODE.exec(head)?.[1];
        return this.result(id, at, text, exit !== undefined ? exit !== '0' : FAILED.test(head));
      }
      default:
        return;
    }
  }

  private remember(id: string, name: string): void {
    this.calls.set(id, name);
    if (this.calls.size > 512) this.calls.delete(this.calls.keys().next().value as string);
  }

  /** function_call / custom_tool_call: a entrada nasce na hora; a saída e o item_completed de mesmo id a completam. */
  private call(p: Rec, at: number, key: string): void {
    const id = str(p.call_id) ?? key;
    const name = callName(str(p.name) ?? 'ferramenta', str(p.namespace));
    const custom = p.type === 'custom_tool_call';
    // Code mode: o `exec` é um script em JavaScript; o que ele faz aparece nos itens de dentro (ids exec-…).
    if (custom && name === 'exec' && this.mode !== 'legacy') return;
    const args = custom ? { input: p.input } : parseArguments(p.arguments);
    // A mensagem para você (user_messaging) é a resposta, com o mesmo id da entrega: nunca uma ferramenta.
    const said = userMessagingText('', name, args);
    if (said) return this.assistant(id, at, said);
    this.remember(id, name);
    if (name === 'apply_patch') return this.patch(id, at, str(args.input) ?? str(args.patch) ?? '');
    const view = this.callView(name, args);
    this.tool(id, at, view.tool, view);
  }

  private patch(id: string, at: number, patch: string): void {
    const files = patchFiles(patch);
    const tool = files.length && files.every((f) => f.kind === 'add') ? 'Write' : 'Edit';
    const title = this.filesTitle(tool, files.map((f) => f.path));
    const input = patch.trim() ? marked(prepare(patch, INPUT_MAX, Infinity, false)) : '';
    this.tool(id, at, tool, input ? { title, input, inputKind: 'diff' } : { title });
  }

  /** Título e entrada pelo nome da chamada; `tool` = o nome que vai na entrada (Bash, Agent, mcp__…, o próprio). */
  private callView(name: string, args: Rec): View & { tool: string } {
    if (SHELL_TOOLS.test(name)) return { tool: 'Bash', ...bashView(args.cmd ?? args.command, this.cwd) };
    switch (name) {
      case 'update_plan':
        return { tool: name, ...planView(args) };
      case 'request_user_input':
      case 'request_user_input_async':
        return { tool: name, ...questionsView(name, args) };
      case 'spawn_agent':
        return { tool: 'Agent', ...toolView('Agent', { subagent_type: args.agent_type, description: args.task_name, prompt: readable(args.message ?? args.prompt) }, this.cwd) };
      case 'send_message':
      case 'send_input':
      case 'followup_task':
        return { tool: name, title: titled(name, str(args.target)), ...textInput(readable(str(args.message))) };
      case 'write_stdin':
        return { tool: name, ...stdinView(args) };
      case 'view_image':
        return { tool: name, ...toolView('Read', { file_path: pathFromUri(args.path) ?? '' }, this.cwd) };
      default:
        return { tool: name, ...toolView(name, args, this.cwd) };
    }
  }
}

/**
 * Parser com estado do terminal do Codex: uma instância por leitura de arquivo, alimentada na ordem do arquivo.
 * `meta` = o session_meta lido à parte, para quando a janela do fim não tem o cabeçalho (formato, cwd e onde começa a
 * história própria de um subagente com fork).
 */
export function createCodexTerminalParser(opts: { meta?: RolloutMeta } = {}): TerminalParser {
  return new CodexTerminalParser(opts);
}
