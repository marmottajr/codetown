// Interpretação dos rollouts do Codex (<CODEX_HOME>/sessions/AAAA/MM/DD/rollout-<hora>-<thread>.jsonl): cada linha
// atualiza um CodexState (modelo, título, números, turno aberto...) e pode gerar atividades (o que o personagem está
// fazendo) e sinais (turno começou/terminou, uso do plano, evento do GitHub).
//
// Formatos (o `history_mode` do session_meta; ausente = legacy):
// - paginated (padrão desde a 0.158): a conversa sai de `event_msg` `item_completed` (UserMessage, AgentMessage,
//   Reasoning, CommandExecution, FileChange, McpToolCall...). Os `response_item` são o contexto mandado ao modelo
//   (há mensagens injetadas): só as chamadas de ferramenta ainda sem resultado entram, como atividade em andamento;
// - legacy (threads antigos): `event_msg` user_message/agent_message/agent_reasoning e os pares `response_item`
//   function_call/function_call_output (o exec_command_end só existiu em versões antigas). Só o básico.
// Os ids das atividades usam o call_id (= id do item concluído = tool_use_id dos hooks): a chamada vista em
// andamento, o hook PreToolUse e o item concluído caem na mesma atividade.
// Tokens: o `total_token_usage` do token_count é cumulativo e o cache JÁ está dentro de input (não soma de novo).
// Herança: só o 1º session_meta vale; num subagente com fork, as linhas com ordinal < subagent_history_start_ordinal
// (e o session_meta do pai, copiado logo depois do cabeçalho) são do pai e ficam de fora.
// Tratamento próprio: request_user_input sem output (sinal 'asking'; o output ou o fim do turno dão 'answered'),
// tools.update_plan no JS do code mode, filhos do multiagente v2 (SubAgentActivity started conta e dá o sinal 'spawn';
// a tarefa que chega por agent_message é o título do filho) e extensões (web.search, clock.sleep, image_gen, web::run).
// Tipos de linha desconhecidos são ignorados; uma linha inválida nunca derruba a leitura.
import { describePrompt, describeTool, maskSecrets, SPECIAL, truncate, type ActivityDescription } from '../../../shared/activity';
import type { GitHubEvent } from '../../../shared/github';
import type { AccountUsage, Activity, AgentStats, TaskItem, TaskStatus, UsageWindowInfo } from '../../../shared/types';
import { detectGitHubResult, githubCallOf } from '../github';
import type { ParsedActivity } from '../transcript';
import { unwrapCommand } from './command';
import { num, rec, str, toMs, type Rec } from './rollout-util';

/**
 * Teto (em caracteres) do texto que passa pela máscara antes de qualquer corte visível. É alto e fixo de propósito: o
 * que aparece na tela vem de muito além do tamanho visível (a máscara encolhe um token de 300 caracteres para 6 e os
 * brancos colapsam), então um recorte "proporcional" ao tamanho visível deixaria um pedaço de token sem máscara.
 */
const MASK_CEILING = 16 * 1024;
const BLANK = /\s/;
/** Tamanho visível do texto de uma atividade (o mesmo corte do shared/activity.ts), para um texto montado aqui. */
const ACTIVITY_TEXT_MAX = 46;

/**
 * O único caminho do texto livre do rollout até a tela: mascara os segredos ANTES de qualquer corte (um token cortado
 * ao meio não casa com a máscara e o começo dele vazaria) e só então trunca para o tamanho visível `max`; sem `max`,
 * devolve o texto mascarado inteiro, para quem corta adiante. O recorte prévio só evita rodar as expressões sobre
 * blocos enormes: acima do teto vai no último espaço em branco antes dele (não deixa um token pela metade no fim);
 * sem nenhum espaço, corta no próprio teto.
 */
export function maskedCut(text: string, max?: number): string {
  let head = text;
  if (text.length > MASK_CEILING) {
    let end = MASK_CEILING;
    while (end > 0 && !BLANK.test(text[end])) end--;
    head = text.slice(0, end > 0 ? end : MASK_CEILING);
  }
  const masked = maskSecrets(head);
  return max === undefined ? masked : truncate(masked, max);
}

/**
 * Entradas das descrições compartilhadas (`describeTool`, `SPECIAL`): o shared/activity.ts corta o texto que recebe
 * (`truncate(q, 28)`, `slice(0, 368)`, `slice(0, 1200)`...) ANTES de mascarar, então o texto livre do modelo tem de
 * chegar já mascarado. Só texto livre: caminhos e URLs passam como vieram.
 */
function maskedText(v: unknown): string | undefined {
  return typeof v === 'string' ? maskedCut(v) : undefined;
}

const maskedValue = (v: unknown): unknown => (typeof v === 'string' ? maskedCut(v) : v);

/** Texto cifrado pelo Codex (0.160.1: a mensagem do multiagente vem como token Fernet, `gAAAAA` + base64 url-safe). */
const ENCRYPTED = /^gAAAAA[A-Za-z0-9_-]{20,}={0,2}$/;

/** O texto é cifrado (ilegível): nunca vai à tela, nem como título, atividade ou entrada do terminal. */
export function isEncryptedText(text: string): boolean {
  return ENCRYPTED.test(text.trim());
}

/** O texto, se for legível: nem vazio, nem cifrado. */
function plainText(v: unknown): string | undefined {
  const s = str(v);
  return s && !isEncryptedText(s) ? s : undefined;
}

/** `questions` de um AskUserQuestion com pergunta, cabeçalho e opções (rótulo e descrição) mascarados; as posições ficam. */
function maskedQuestions(raw: unknown): unknown {
  if (!Array.isArray(raw)) return raw;
  return raw.map((q) => {
    const question = rec(q);
    if (!question) return q;
    const options = Array.isArray(question.options)
      ? question.options.map((o) => {
          const option = rec(o);
          return option ? { ...option, label: maskedValue(option.label), description: maskedValue(option.description) } : o;
        })
      : question.options;
    return { ...question, question: maskedValue(question.question), header: maskedValue(question.header), options };
  });
}

/** Chaves cujo valor é caminho ou URL (não é texto livre). */
const PATH_KEYS = new Set(['file_path', 'notebook_path', 'path', 'url']);

/** Entrada de uma ferramenta que cai no `describeTool` pelo nome: cada texto livre (1º nível) e as perguntas, mascarados. */
function maskedInput(input: Rec): Rec {
  const out: Rec = {};
  for (const [key, value] of Object.entries(input)) out[key] = key === 'questions' ? maskedQuestions(value) : PATH_KEYS.has(key) ? value : maskedValue(value);
  return out;
}

/** Id de thread do Codex (UUID). */
const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isThreadId(v: unknown): v is string {
  return typeof v === 'string' && THREAD_ID.test(v);
}

// ------------------------------------------------------------------ session_meta

export type HistoryMode = 'paginated' | 'legacy';

/** O que o session_meta (1ª linha do rollout) diz sobre o thread. */
export interface RolloutMeta {
  threadId?: string;
  /** Thread raiz da sessão (num subagente, o do agente principal). */
  sessionId?: string;
  cwd?: string;
  cliVersion?: string;
  historyMode: HistoryMode;
  gitBranch?: string;
  startedAt?: number;
  /** Thread interno do Codex (guardian, review, compactação, memória...): fica fora do escritório. */
  internal: boolean;
  /** Subagente (spawn_agent): o thread pai e o que se sabe dele. */
  parentThreadId?: string;
  agentNickname?: string;
  agentRole?: string;
  /** Caminho do subagente no multiagente v2 ("/root/tarefa_filho/tarefa_neto"), quando o thread_spawn o traz. */
  agentPath?: string;
  /** subagent_history_start_ordinal: as linhas com ordinal menor são a história herdada do pai (fork). */
  historyStart?: number;
}

/** Chaves de um objeto em minúsculas e sem `_` (o Codex já gravou `subagent`, `subAgent`, `thread_spawn`...). */
function looseGet(o: Rec, name: string): unknown {
  const want = name.toLowerCase().replace(/_/g, '');
  for (const [k, v] of Object.entries(o)) if (k.toLowerCase().replace(/_/g, '') === want) return v;
  return undefined;
}

/**
 * `source` do session_meta: "cli", "vscode", "exec", "mcp", {"custom": ...}, {"internal": "guardian"},
 * {"subagent": "review" | "compact" | "memory_consolidation" | {"other": ...} | {"thread_spawn": {...}}}.
 */
function sourceInfo(src: unknown): { internal: boolean; spawn?: Rec } {
  const o = rec(src);
  if (!o) return { internal: false };
  if (looseGet(o, 'internal') !== undefined) return { internal: true };
  const sub = looseGet(o, 'subagent');
  if (sub === undefined) return { internal: false };
  const so = rec(sub);
  const spawn = so ? rec(looseGet(so, 'thread_spawn')) : undefined;
  // review, compact, memory_consolidation e {"other": "guardian"}: internos, sem pai conhecido.
  return spawn ? { internal: false, spawn } : { internal: true };
}

const INTERNAL_THREAD_SOURCES = new Set(['guardian_review', 'memory_consolidation']);

/** Caminho absoluto de agente do multiagente v2: "/root" e nomes em minúsculas, dígitos e `_`. */
const AGENT_PATH = /^\/root(?:\/[a-z0-9_]+)*$/;

/** Caminho do próprio agente: o principal é o "/root"; o subagente, o do thread_spawn (se veio). */
export function codexAgentPath(meta: RolloutMeta | undefined): string | undefined {
  if (!meta || meta.internal) return undefined;
  return meta.parentThreadId ? meta.agentPath : '/root';
}

export function parseSessionMeta(payload: Rec, at?: number): RolloutMeta {
  const src = sourceInfo(payload.source);
  const meta: RolloutMeta = {
    historyMode: payload.history_mode === 'paginated' ? 'paginated' : 'legacy',
    internal: src.internal || INTERNAL_THREAD_SOURCES.has(String(payload.thread_source ?? '')),
  };
  const id = str(payload.id);
  const sessionId = str(payload.session_id);
  if (id) meta.threadId = id;
  if (sessionId) meta.sessionId = sessionId;
  const cwd = str(payload.cwd);
  if (cwd) meta.cwd = cwd;
  const version = str(payload.cli_version);
  if (version) meta.cliVersion = version;
  const branch = str(rec(payload.git)?.branch);
  if (branch && branch !== 'HEAD') meta.gitBranch = branch;
  const started = toMs(payload.timestamp) ?? at;
  if (started !== undefined) meta.startedAt = started;
  const parent =
    str(src.spawn ? looseGet(src.spawn, 'parent_thread_id') : undefined) ??
    str(payload.parent_thread_id) ??
    (sessionId && id && sessionId !== id && !meta.internal ? sessionId : undefined);
  if (parent && isThreadId(parent) && parent !== id) meta.parentThreadId = parent;
  const nickname = str(src.spawn ? looseGet(src.spawn, 'agent_nickname') : undefined) ?? str(payload.agent_nickname);
  const role = str(src.spawn ? (looseGet(src.spawn, 'agent_role') ?? looseGet(src.spawn, 'agent_type')) : undefined) ?? str(payload.agent_role);
  if (nickname) meta.agentNickname = truncate(nickname, 40);
  if (role) meta.agentRole = truncate(role, 40);
  const agentPath = str(src.spawn ? looseGet(src.spawn, 'agent_path') : undefined);
  if (agentPath && AGENT_PATH.test(agentPath)) meta.agentPath = agentPath;
  const historyStart = num(payload.subagent_history_start_ordinal);
  if (historyStart !== undefined && historyStart >= 0) meta.historyStart = historyStart;
  return meta;
}

// ------------------------------------------------------------------ uso do plano

/** Janelas do Codex pela duração (não pela posição): 300 min = sessão de 5 h, 10080 min = semana. */
const WINDOW_BY_MINUTES: Record<number, 'fiveHour' | 'sevenDay'> = { 300: 'fiveHour', 10080: 'sevenDay' };

/**
 * Uma janela do `rate_limits` ({used_percent, window_minutes, ...}), de qualquer duração. Reinício: `resets_at` (epoch
 * em segundos, Codex ≥ 0.50) ou `resets_in_seconds` (0.45/0.46, contado do horário da linha). Sem duração ou sem
 * percentual = undefined.
 */
function usageWindow(raw: unknown, at: number): UsageWindowInfo | undefined {
  const w = rec(raw);
  const minutes = num(w?.window_minutes);
  const used = num(w?.used_percent);
  if (!w || minutes === undefined || minutes <= 0 || used === undefined) return undefined;
  const info: UsageWindowInfo = { windowMinutes: minutes, usedPercent: Math.min(100, Math.max(0, used)) };
  const resets = num(w.resets_at);
  const resetsIn = num(w.resets_in_seconds);
  if (resets !== undefined) info.resetsAt = resets < 1e12 ? Math.round(resets * 1000) : Math.round(resets);
  else if (resetsIn !== undefined) info.resetsAt = at + Math.round(resetsIn * 1000);
  return info;
}

/**
 * `token_count.rate_limits` → uso da conta (source 'codex', `fetchedAt` = horário da linha). `windows` = os medidores
 * que o plano tem, na ordem primary, secondary (uma janela por duração: a primeira vence); `fiveHour`/`sevenDay`
 * continuam preenchidos pela duração (300/10080), para quem lê os campos fixos. Aceita também o formato plano do
 * 0.40 (`primary_used_percent`, `primary_window_minutes`, ...). `primary` nulo com `rate_limit_reached_type` = sem
 * cota nem créditos (`noQuota`), não 0%. Sem nenhuma janela e com cota = undefined.
 */
export function usageFromRateLimits(raw: unknown, at: number): AccountUsage | undefined {
  const rl = rec(raw);
  if (!rl) return undefined;
  // Só a cota padrão ("codex"); modelos com cota própria (outro limit_id) fariam o número pular entre as duas.
  const limit = str(rl.limit_id);
  if (limit && limit !== 'codex') return undefined;
  const usage: AccountUsage = { source: 'codex', fetchedAt: at };
  const windows: UsageWindowInfo[] = [];
  for (const slot of ['primary', 'secondary'] as const) {
    const w = usageWindow(rl[slot], at) ?? usageWindow({ used_percent: rl[`${slot}_used_percent`], window_minutes: rl[`${slot}_window_minutes`] }, at);
    if (!w || windows.some((x) => x.windowMinutes === w.windowMinutes)) continue;
    windows.push(w);
    const key = WINDOW_BY_MINUTES[w.windowMinutes];
    if (key) usage[key] = w.resetsAt === undefined ? { utilization: w.usedPercent } : { utilization: w.usedPercent, resetsAt: w.resetsAt };
  }
  if (windows.length) usage.windows = windows;
  if ((rl.primary === null || rl.primary === undefined) && str(rl.rate_limit_reached_type)) usage.noQuota = true;
  return windows.length || usage.noQuota ? usage : undefined;
}

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
function parsedCmdActivity(parsed: unknown): ActivityDescription | undefined {
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
function planFromScript(js: string): Rec | undefined {
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

function sleepDesc(): ActivityDescription {
  return { kind: 'wait', icon: '⏳', text: 'Esperando um pouco' };
}

/** Busca na web (Extension web.search): página aberta vira leitura (WebFetch); senão a busca (WebSearch). */
function webDesc(action: unknown, query?: string): { desc: ActivityDescription; tool: string } {
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

// ------------------------------------------------------------------ estado

export interface CodexState {
  /** session_meta (lido do começo do arquivo, à parte da janela do fim). */
  meta?: RolloutMeta;
  /** Formato: o do session_meta; sem ele, deduzido (o primeiro item paginated ou evento legacy decide). */
  mode?: HistoryMode;
  model?: string;
  gitBranch?: string;
  /** Primeira instrução (título da sessão), já mascarada e cortada. */
  title?: string;
  tasks: TaskItem[];
  stats: AgentStats;
  /** Turno aberto (task_started sem task_complete/turn_aborted); undefined = nenhum evento de turno visto. */
  turnOpen?: boolean;
  firstAt?: number;
  lastAt?: number;
  /** Chamadas de ferramenta ainda sem resultado (call_id → nome). */
  pending: Map<string, string>;
  /** request_user_input abertos (sem output): call_id → resumo das perguntas (mascarado e cortado). */
  asking: Map<string, string>;
  /** Filhos do multiagente: id do spawn (call_id) → título do filho e se já contou (cada filho conta uma vez). */
  spawns: Map<string, { title: string; counted: boolean }>;
  /** Uso do plano mais recente (rate_limits) e o plano. */
  usage?: AccountUsage;
  planType?: string;
  current?: { id: string; kind: Activity['kind']; at: number; callId?: string };
}

export function createCodexState(meta?: RolloutMeta): CodexState {
  const s: CodexState = { tasks: [], stats: { toolCalls: 0, tokensIn: 0, tokensOut: 0, subagents: 0 }, pending: new Map(), asking: new Map(), spawns: new Map() };
  if (meta) applyMeta(s, meta);
  return s;
}

/** Aplica o session_meta ao estado (formato, branch). */
export function applyMeta(s: CodexState, meta: RolloutMeta): void {
  s.meta = meta;
  s.mode = meta.historyMode;
  if (meta.gitBranch) s.gitBranch ??= meta.gitBranch;
}

/** Sinais de uma linha para quem acompanha o thread. */
export type CodexSignal =
  | { type: 'turnStart' }
  | { type: 'turnEnd'; aborted: boolean }
  /** Algo concluiu dentro do turno (tira a espera por aprovação). */
  | { type: 'progress' }
  | { type: 'usage'; usage: AccountUsage; plan?: string }
  | { type: 'github'; event: GitHubEvent; key: string }
  | { type: 'meta'; meta: RolloutMeta }
  /** request_user_input aberto (sem output): o agente espera você responder. */
  | { type: 'asking'; questions: string }
  /** O output do request_user_input chegou (ou o turno acabou). */
  | { type: 'answered' }
  /** spawn_agent: título do filho (o 1º texto da mensagem), pelo id do filho quando conhecido. */
  | { type: 'spawn'; childThreadId?: string; title: string };

export interface CodexLineResult {
  activities: ParsedActivity[];
  signals: CodexSignal[];
  /** Título, números, modelo ou tarefas mudaram. */
  changed: boolean;
  /** Epoch ms da linha (o `timestamp` dela ou o `now` do contexto). */
  at: number;
}

export interface CodexParseContext {
  /** Prefixo dos ids de atividade (o id do agente). */
  idPrefix: string;
  now: number;
  /** false = só atualiza o estado (sem montar atividades). */
  activities?: boolean;
}

const TITLE_MAX = 90;
const MAX_PENDING = 128;
const ASK_SUMMARY_MAX = 120;

/** Resumo das perguntas de um request_user_input ("Qual banco? · Posso apagar dist?"), mascarado ANTES do corte. */
function askSummary(raw: unknown): string {
  const questions = Array.isArray(raw) ? raw.map((q) => str(rec(q)?.question)).filter((q): q is string => q !== undefined) : [];
  return maskedCut(questions.join(' · '), ASK_SUMMARY_MAX);
}

/** Título (da sessão ou de um subagente) a partir de um texto livre: mascarado ANTES do corte. */
function titleText(text: string): string {
  return maskedCut(text, TITLE_MAX);
}

/** 1º texto de um conteúdo: o próprio texto ou o 1º bloco {text} da lista (o agent_message traz um bloco cifrado junto). */
function firstText(content: unknown): string | undefined {
  if (typeof content === 'string') return str(content);
  if (!Array.isArray(content)) return undefined;
  for (const b of content) {
    const text = str(rec(b)?.text);
    if (text) return text;
  }
  return undefined;
}

/** Nome da tarefa pelo caminho do agente ("/root/revisar_testes" → "revisar_testes"). */
function agentTask(path: string | undefined): string | undefined {
  const last = path?.split('/').filter(Boolean).pop();
  return last && last !== 'root' ? last : undefined;
}

/**
 * Título do filho pelo spawn_agent: o 1º texto da mensagem (`message`; `prompt`/`task` em formatos antigos), senão o
 * task_name. A mensagem cifrada (0.160.1) não conta.
 */
function spawnTitle(input: Rec): string {
  const text = plainText(firstText(input.message)) ?? plainText(input.prompt) ?? plainText(input.task) ?? plainText(input.task_name);
  return text ? titleText(text) : '';
}

/** Envelope do multiagente no 0.160.1: "Message Type: NEW_TASK\nTask name: /root/…\nSender: …\nPayload:\n<conteúdo>". */
const ENVELOPE = /^Message Type:[^\n]*\n/;

/**
 * A tarefa numa mensagem endereçada a um filho. No envelope, o conteúdo depois de "Payload:" (se vier legível; no
 * 0.160.1 ele vem num bloco cifrado à parte), senão o nome da tarefa do "Task name"; o cabeçalho nunca. Fora do
 * envelope, o próprio texto, se legível.
 */
function messageTask(text: string): string | undefined {
  if (!ENVELOPE.test(text)) return plainText(text);
  const at = text.search(/^Payload:/m);
  const payload = at >= 0 ? plainText(text.slice(at + 'Payload:'.length).trim()) : undefined;
  return payload ?? agentTask(/^Task name:[ \t]*(\S+)/m.exec(text)?.[1]);
}
/** Texto injetado pelo Codex que não é instrução sua. */
const INJECTED = /^<(environment_context|user_instructions|turn_aborted|subagent_notification|user_shell_command_output|collaboration_mode)\b/;

/** Texto de UserMessage.content ([{type: 'text', text}, {type: 'image'...}]) ou de uma lista de blocos {text}. */
export function contentText(content: unknown): { text: string; images: number } {
  if (typeof content === 'string') return { text: content, images: 0 };
  if (!Array.isArray(content)) return { text: '', images: 0 };
  const texts: string[] = [];
  let images = 0;
  for (const raw of content) {
    const b = rec(raw);
    if (!b) continue;
    const type = String(b.type ?? '').toLowerCase();
    if (typeof b.text === 'string') texts.push(b.text);
    else if (type === 'image' || type === 'local_image' || type === 'input_image') images++;
  }
  return { text: texts.join(''), images };
}

/** Instrução de verdade (não contexto injetado), limpa; '' = nada a mostrar. */
export function promptText(raw: string): string {
  const text = raw.trim();
  if (!text || INJECTED.test(text)) return '';
  return text;
}

/** Saída de uma ferramenta (function_call_output): texto, JSON {output, metadata: {exit_code}} ou blocos. */
function outputOf(raw: unknown): { text: string; exitCode?: number } {
  if (typeof raw === 'string') {
    try {
      const j = rec(JSON.parse(raw));
      if (j && typeof j.output === 'string') return { text: j.output, exitCode: num(rec(j.metadata)?.exit_code) };
    } catch {
      // texto puro
    }
    const exit = /^Exit code:\s*(-?\d+)/m.exec(raw.slice(0, 500))?.[1];
    return { text: raw, exitCode: exit !== undefined ? Number(exit) : undefined };
  }
  const o = rec(raw);
  if (o) return outputOf(o.content ?? o.output ?? o.body ?? '');
  if (Array.isArray(raw)) return { text: contentText(raw).text };
  return { text: '' };
}

/**
 * 1ª linha não vazia (detalhe de erro), mascarada ANTES do corte (ver `maskedCut`).
 */
function firstLine(s: string, max = 140): string | undefined {
  const line = s.split('\n').find((l) => l.trim());
  return line ? maskedCut(line, max) : undefined;
}

class RolloutLineParser {
  readonly out: CodexLineResult;
  private readonly withActivities: boolean;

  constructor(
    private readonly s: CodexState,
    private readonly ctx: CodexParseContext,
    private readonly j: Rec,
    private readonly at: number,
  ) {
    this.withActivities = ctx.activities !== false;
    this.out = { activities: [], signals: [], changed: false, at };
  }

  /**
   * Chave estável de uma atividade sem id próprio: o `ordinal` da linha (quando o Codex grava) ou o horário dela,
   * mais a posição dentro da linha. Uma releitura do arquivo gera as mesmas chaves (o Office não duplica).
   */
  private autoKey(): string {
    const ordinal = num(this.j.ordinal);
    const base = ordinal !== undefined ? `o${ordinal}` : `t${this.at.toString(36)}`;
    const n = this.autoKeys++;
    return n ? `${base}:${n}` : base;
  }

  private autoKeys = 0;

  private push(desc: ActivityDescription, opts: { key?: string; tool?: string; current?: boolean; durationMs?: number; callId?: string; replace?: boolean } = {}): void {
    if (!this.withActivities) return;
    const key = opts.key ?? this.autoKey();
    const activity: Activity = { id: `${this.ctx.idPrefix}#${key}`, at: this.at, ...desc };
    if (opts.tool) activity.tool = opts.tool;
    if (opts.durationMs !== undefined) activity.durationMs = opts.durationMs;
    if (desc.kind === 'error') activity.error = true;
    const current = opts.current ?? true;
    const parsed: ParsedActivity = opts.callId ? { activity, current, toolUseId: opts.callId } : { activity, current };
    if (opts.replace) parsed.replace = true;
    this.out.activities.push(parsed);
    if (current) this.s.current = { id: activity.id, kind: desc.kind, at: this.at, callId: opts.callId };
  }

  private changed(): void {
    this.out.changed = true;
  }

  /** Quem chama, para o describeCodexTool (o destino do send_message). */
  private from(): { agentPath?: string } {
    return { agentPath: codexAgentPath(this.s.meta) };
  }

  private paginated(): boolean {
    return this.s.mode === 'paginated';
  }

  /** Um item paginated visto: o formato é esse (a janela do fim pode não ter o session_meta). */
  private sawPaginated(): void {
    this.s.mode ??= 'paginated';
  }

  run(): void {
    const p = rec(this.j.payload);
    if (!p) return;
    switch (this.j.type) {
      case 'session_meta': {
        const meta = parseSessionMeta(p, this.at);
        applyMeta(this.s, meta);
        this.out.signals.push({ type: 'meta', meta });
        this.changed();
        return;
      }
      case 'turn_context':
        return this.model(p.model);
      case 'event_msg':
        return this.event(p);
      case 'response_item':
        return this.responseItem(p);
      case 'compacted':
        if (!this.paginated()) this.push(SPECIAL.compact());
        return;
      default:
        return;
    }
  }

  private model(v: unknown): void {
    const m = str(v);
    if (!m || m === this.s.model) return;
    this.s.model = m;
    this.changed();
  }

  // ---------------------------------------------------------------- event_msg

  private event(p: Rec): void {
    switch (p.type) {
      case 'item_completed':
        return this.item(rec(p.item));
      case 'task_started':
      case 'turn_started':
        this.closeAsks();
        this.s.turnOpen = true;
        this.out.signals.push({ type: 'turnStart' });
        return;
      case 'task_complete':
      case 'turn_complete': {
        this.endTurn(false);
        const ms = num(p.duration_ms);
        const err = rec(p.error);
        const turn = str(p.turn_id) ?? this.autoKey();
        // Com erro (ex.: limite de uso), a conclusão leva o erro: um item à parte antes dela apagaria a troca do "Concluiu"
        // sintetizado no Office (dois "Concluiu"), e depois dela, como atual, faria o completeSub sintetizar outro.
        const desc = err ? SPECIAL.turnFailed(ms, firstLine(str(err.message) ?? '')) : SPECIAL.turnDone(ms);
        this.push(desc, { key: `${turn}:done`, durationMs: ms });
        return;
      }
      case 'turn_aborted':
        this.endTurn(true);
        // No subagente (e no neto), o "interrupted" é o Codex abortando o filho quando o pai encerra, não você.
        if (p.reason === 'interrupted' || p.reason === undefined) this.push(SPECIAL.interrupted(!this.s.meta?.parentThreadId), { key: `${str(p.turn_id) ?? this.autoKey()}:int` });
        return;
      case 'token_count':
        return this.tokens(p);
      case 'thread_settings_applied':
        return this.model(rec(p.thread_settings)?.model);
      // ---- legacy (threads antigos): só o básico
      case 'user_message':
        if (this.paginated()) return;
        this.s.mode ??= 'legacy';
        return this.prompt(str(p.message) ?? '', Array.isArray(p.images) ? p.images.length : 0);
      case 'agent_message': {
        if (this.paginated()) return;
        this.s.mode ??= 'legacy';
        const text = str(p.message);
        if (text) this.push(SPECIAL.respond(maskedCut(text)));
        this.progress();
        return;
      }
      case 'agent_reasoning':
        if (this.paginated()) return;
        return this.think();
      case 'exec_command_end':
        if (this.paginated()) return;
        return this.command({ id: str(p.call_id), command: p.command, parsed: p.parsed_cmd, exitCode: num(p.exit_code), output: str(p.aggregated_output) ?? str(p.formatted_output) ?? str(p.stdout) ?? '', status: str(p.status) });
      case 'patch_apply_end':
        if (this.paginated()) return;
        return this.fileChange(str(p.call_id), p.changes, p.success === false ? 'failed' : str(p.status));
      case 'mcp_tool_call_end': {
        if (this.paginated()) return;
        const inv = rec(p.invocation) ?? {};
        return this.mcp(str(p.call_id), inv.server, inv.tool, inv.arguments, rec(p.result), undefined);
      }
      case 'context_compacted':
        if (this.paginated()) return;
        this.push(SPECIAL.compact());
        return;
      default:
        return;
    }
  }

  private endTurn(aborted: boolean): void {
    this.s.turnOpen = false;
    this.s.pending.clear();
    this.closeAsks();
    this.out.signals.push({ type: 'turnEnd', aborted });
  }

  /** request_user_input chamado e ainda sem output: a pergunta fica aberta e o agente espera você. */
  private ask(callId: string, questions: unknown): void {
    const summary = askSummary(questions);
    this.s.asking.set(callId, summary);
    if (this.s.asking.size > MAX_PENDING) this.s.asking.delete(this.s.asking.keys().next().value as string);
    this.out.signals.push({ type: 'asking', questions: summary });
  }

  /** O output de um request_user_input aberto: respondida. false = não era uma pergunta aberta. */
  private answer(callId: string): boolean {
    const summary = this.s.asking.get(callId);
    if (summary === undefined) return false;
    this.s.asking.delete(callId);
    this.out.signals.push({ type: 'answered' });
    this.push(SPECIAL.answered(summary || undefined), { key: `${callId}:ans` });
    return true;
  }

  /**
   * Fim do turno (ou um turno novo) com pergunta aberta: ninguém mais espera a resposta. O 'answered' sai ANTES do
   * turnEnd/turnStart, para quem aplica os sinais em ordem terminar no status do turno.
   */
  private closeAsks(): void {
    if (!this.s.asking.size) return;
    this.s.asking.clear();
    this.out.signals.push({ type: 'answered' });
  }

  private progress(): void {
    this.out.signals.push({ type: 'progress' });
  }

  private tokens(p: Rec): void {
    const total = rec(rec(p.info)?.total_token_usage);
    if (total) {
      // Cumulativo: atribui (o input já inclui o cache; o output já inclui o raciocínio).
      const tin = num(total.input_tokens) ?? 0;
      const tout = num(total.output_tokens) ?? 0;
      if (tin !== this.s.stats.tokensIn || tout !== this.s.stats.tokensOut) {
        this.s.stats.tokensIn = tin;
        this.s.stats.tokensOut = tout;
        this.changed();
      }
    }
    const rl = rec(p.rate_limits);
    if (!rl) return;
    const plan = str(rl.plan_type);
    if (plan) this.s.planType = plan;
    const usage = usageFromRateLimits(rl, this.at);
    if (!usage) return;
    if (!this.s.usage || usage.fetchedAt >= this.s.usage.fetchedAt) this.s.usage = usage;
    this.out.signals.push(plan ? { type: 'usage', usage, plan } : { type: 'usage', usage });
  }

  private think(key?: string): void {
    const cur = this.s.current;
    // Um único "Pensando…" seguido (o raciocínio vem em vários pedaços).
    if (cur?.kind === 'think' && this.at - cur.at < 30_000) return;
    this.push(SPECIAL.think(), { key });
  }

  private prompt(raw: string, images: number, key?: string): void {
    const text = promptText(raw) || (images ? '[imagem]' : '');
    if (!text) return;
    if (this.s.title === undefined) {
      this.s.title = titleText(text);
      this.changed();
    }
    this.push(describeCodexPrompt(text), { key });
  }

  // ---------------------------------------------------------------- item_completed (paginated)

  private item(item: Rec | undefined): void {
    if (!item) return;
    const id = str(item.id);
    switch (item.type) {
      case 'UserMessage': {
        this.sawPaginated();
        const { text, images } = contentText(item.content);
        return this.prompt(text, images, id);
      }
      case 'AgentMessage': {
        this.sawPaginated();
        const text = contentText(item.content).text.trim();
        if (text) this.push(SPECIAL.respond(maskedCut(text)), { key: id });
        this.progress();
        return;
      }
      case 'Reasoning':
        this.sawPaginated();
        this.progress();
        return this.think(id);
      case 'CommandExecution':
        this.sawPaginated();
        this.s.stats.toolCalls++;
        this.changed();
        return this.command({ id, command: item.command, parsed: item.parsed_cmd, exitCode: num(item.exit_code), output: str(item.aggregated_output) ?? '', status: str(item.status) });
      case 'FileChange':
        this.sawPaginated();
        this.s.stats.toolCalls++;
        this.changed();
        return this.fileChange(id, item.changes, str(item.status));
      case 'McpToolCall':
        this.sawPaginated();
        this.s.stats.toolCalls++;
        this.changed();
        return this.mcp(id, item.server, item.tool, item.arguments, rec(item.result), str(rec(item.error)?.message), str(item.status));
      case 'WebSearch':
        this.sawPaginated();
        this.s.stats.toolCalls++;
        this.changed();
        this.done(id);
        this.push(describeTool('WebSearch', { query: maskedText(item.query) }), { key: id, tool: 'WebSearch', callId: id });
        return;
      case 'ImageView': {
        this.sawPaginated();
        const path = pathFromUri(item.path);
        this.done(id);
        this.push(describeTool('Read', { file_path: path ?? 'imagem.png' }), { key: id, tool: 'Read', callId: id });
        return;
      }
      case 'ContextCompaction':
        this.sawPaginated();
        this.push(SPECIAL.compact(), { key: id });
        return;
      case 'CollabAgentToolCall': {
        this.sawPaginated();
        const tool = str(item.tool) ?? 'spawn_agent';
        if (tool === 'spawn_agent') {
          const prompt = plainText(item.prompt);
          this.spawned(id, Array.isArray(item.receiver_thread_ids) ? item.receiver_thread_ids[0] : undefined, prompt ? titleText(prompt) : '');
        }
        this.done(id);
        const { desc, tool: name } = describeCodexTool(tool, { prompt: item.prompt }, undefined, this.from());
        this.push(desc, { key: id, tool: name, callId: id });
        this.progress();
        return;
      }
      case 'SubAgentActivity':
        return this.subAgentActivity(id, item);
      case 'Extension':
        return this.extension(id, item);
      case 'Plan':
        this.sawPaginated();
        this.push(describeTool('ExitPlanMode', {}), { key: id, tool: 'Plan' });
        return;
      case 'DynamicToolCall': {
        this.sawPaginated();
        this.done(id);
        const { desc, tool } = describeCodexTool(str(item.tool) ?? 'ferramenta', rec(item.arguments) ?? {}, str(item.namespace), this.from());
        this.push(desc, { key: id, tool, callId: id });
        return;
      }
      default:
        return;
    }
  }

  /** spawn_agent chamado: guarda o título do filho até o SubAgentActivity started (o mesmo call_id). */
  private rememberSpawn(callId: string, title: string): void {
    if (this.s.spawns.has(callId)) return;
    this.s.spawns.set(callId, { title, counted: false });
    if (this.s.spawns.size > MAX_PENDING) this.s.spawns.delete(this.s.spawns.keys().next().value as string);
  }

  /**
   * Um filho nasceu (SubAgentActivity started ou CollabAgentToolCall spawn_agent): conta uma vez por id e emite o
   * spawn com o título guardado do spawn_agent (senão `fallback`). Devolve o título ('' = sem título), ou undefined se
   * esse id já tinha contado.
   */
  private spawned(id: string | undefined, child: unknown, fallback: string): string | undefined {
    const known = id !== undefined ? this.s.spawns.get(id) : undefined;
    if (known?.counted) return undefined;
    const title = known?.title || fallback;
    if (id !== undefined) {
      this.s.spawns.set(id, { title, counted: true });
      if (this.s.spawns.size > MAX_PENDING) this.s.spawns.delete(this.s.spawns.keys().next().value as string);
    }
    this.s.stats.subagents++;
    this.changed();
    if (title) this.out.signals.push(isThreadId(child) ? { type: 'spawn', childThreadId: child, title } : { type: 'spawn', title });
    return title;
  }

  /**
   * Multiagente v2: só o `started` interessa (conta o filho e emite o spawn; sem o spawn_agent visto, vira a atividade
   * de delegar). interacted/completed/interrupted ficam de fora: sem atividade, contagem nem progress (o completed do
   * filho chega no rollout do pai e não pode tirar a espera por aprovação dele).
   */
  private subAgentActivity(id: string | undefined, item: Rec): void {
    if (item.kind !== 'started') return;
    const seen = id !== undefined && this.s.spawns.has(id);
    const task = agentTask(str(item.agent_path));
    const title = this.spawned(id, item.agent_thread_id, task ? titleText(task) : '');
    if (title === undefined) return;
    this.done(id);
    if (seen) return; // a atividade de delegar já saiu com o spawn_agent (mesmo id)
    const { desc, tool } = describeCodexTool('spawn_agent', { message: title || undefined });
    this.push(desc, { key: id, tool, callId: id });
  }

  /**
   * Item de extensão (camelCase): web.search (busca no code mode), clock.sleep (id = call_id do function_call: cai na
   * mesma atividade) e image_gen.*. Outro tipo não gera nada. No legacy o function_call já contou a ferramenta (o
   * Extension do clock.sleep também é gravado lá); não chama sawPaginated pelo mesmo motivo.
   */
  private extension(id: string | undefined, item: Rec): void {
    const kind = str(item.kind) ?? '';
    let d: { desc: ActivityDescription; tool: string };
    if (kind === 'web.search') d = webDesc(item.action, str(item.query));
    else if (kind === 'clock.sleep') d = { desc: sleepDesc(), tool: 'clock.sleep' };
    else if (kind.startsWith('image_gen')) {
      const prompt = str(item.revisedPrompt);
      const desc: ActivityDescription = { kind: 'other', icon: '🎨', text: 'Gerando imagem' };
      if (prompt) desc.detail = maskedCut(prompt, 300);
      d = { desc, tool: 'image_gen' };
    } else return;
    if (this.s.mode !== 'legacy') {
      this.s.stats.toolCalls++;
      this.changed();
    }
    this.done(id);
    this.push(d.desc, { key: id, tool: d.tool, callId: id, durationMs: kind === 'clock.sleep' ? num(item.durationMs) : undefined });
  }

  /** Chamada concluída: sai da lista das em andamento e tira a espera por aprovação. */
  private done(callId: string | undefined): void {
    if (callId) this.s.pending.delete(callId);
    this.progress();
  }

  private command(c: { id?: string; command: unknown; parsed?: unknown; exitCode?: number; output: string; status?: string }): void {
    // Encerrado pelo próprio Codex no fim do turno (0.160.1: o processo do code mode grava o CommandExecution com
    // código -1 depois do task_complete, com ou sem saída): não é erro nem o que o agente faz agora; fica de fora.
    if (this.s.turnOpen === false && c.exitCode === -1) {
      if (c.id) this.s.pending.delete(c.id);
      return;
    }
    const command = commandText(c.command);
    this.done(c.id);
    const key = c.id ?? this.autoKey();
    // O function_call (ou o hook PreToolUse) de mesmo id já pôs no escritório a heurística do Bash: o tipo vindo do
    // parsed_cmd pede para substituí-la (sem isso o escritório fica com a primeira).
    const parsed = parsedCmdActivity(c.parsed);
    this.push(parsed ?? describeTool('Bash', { command: maskedCut(command) }), { key, tool: 'Bash', callId: c.id, replace: parsed !== undefined });
    if (c.status === 'declined') {
      this.push(SPECIAL.rejected('Bash'), { key: `${key}:r` });
      return;
    }
    const failed = c.status === 'failed' || (c.exitCode !== undefined && c.exitCode !== 0);
    if (failed) this.push(SPECIAL.error('Bash', firstLine(c.output) ?? (c.exitCode !== undefined ? `Código de saída ${c.exitCode}` : undefined)), { key: `${key}:e`, tool: 'Bash' });
    // GitHub: a mesma detecção do Claude Code, com o comando, a saída e o código de saída.
    const gh = command ? githubCallOf('Bash', { command }) : undefined;
    if (gh && c.status !== 'declined') {
      const content = failed ? `Exit code ${c.exitCode ?? 1}\n${c.output}` : c.output;
      const event = detectGitHubResult(gh, { content, tur: {}, isError: failed, branch: this.s.gitBranch });
      if (event) this.out.signals.push({ type: 'github', event, key });
    }
  }

  private fileChange(id: string | undefined, changes: unknown, status: string | undefined): void {
    this.done(id);
    const key = id ?? this.autoKey();
    const list = fileChanges(changes).slice(0, 8);
    if (!list.length) this.push(describeTool('Edit', {}), { key, tool: 'Edit', callId: id });
    list.forEach((f, i) => {
      const tool = f.kind === 'add' ? 'Write' : 'Edit';
      this.push(describeTool(tool, { file_path: f.movePath ?? f.path }), { key: i ? `${key}:${i}` : key, tool, callId: i ? undefined : id });
    });
    if (status === 'declined') this.push(SPECIAL.rejected('Edit'), { key: `${key}:r` });
    else if (status === 'failed') this.push(SPECIAL.error('Edit'), { key: `${key}:e`, tool: 'Edit' });
  }

  private mcp(id: string | undefined, server: unknown, tool: unknown, args: unknown, result: Rec | undefined, error: string | undefined, status?: string): void {
    this.done(id);
    const name = mcpName(server, tool);
    const input = rec(args) ?? parseArguments(args);
    const key = id ?? this.autoKey();
    // Code mode: a mensagem para você é a resposta (a mesma chave da entrega gravada como response_item).
    const said = userMessagingText(server, tool, input);
    if (said) {
      this.push(SPECIAL.respond(maskedCut(said)), { key });
      return;
    }
    this.push(describeTool(name, input), { key, tool: name, callId: id });
    const failed = !!error || status === 'failed' || result?.isError === true || result?.is_error === true;
    if (failed) this.push(SPECIAL.error(name, firstLine(error ?? contentText(result?.content).text)), { key: `${key}:e`, tool: name });
    const gh = githubCallOf(name, input);
    if (gh) {
      const event = detectGitHubResult(gh, { content: contentText(result?.content).text, tur: {}, isError: failed, branch: this.s.gitBranch });
      if (event) this.out.signals.push({ type: 'github', event, key });
    }
  }

  // ---------------------------------------------------------------- response_item

  private responseItem(p: Rec): void {
    switch (p.type) {
      case 'message': {
        // Só a resposta entregue no code mode (as outras mensagens são o contexto mandado ao modelo).
        const delivered = deliveredMessage(this.j);
        if (delivered) {
          this.push(SPECIAL.respond(maskedCut(delivered.text)), { key: delivered.id });
          this.progress();
        }
        return;
      }
      case 'function_call':
      case 'custom_tool_call': {
        const callId = str(p.call_id) ?? str(p.id);
        const name = str(p.name) ?? 'ferramenta';
        const input = p.type === 'custom_tool_call' ? { input: p.input, command: p.input } : parseArguments(p.arguments);
        if (callId) {
          this.s.pending.set(callId, name);
          if (this.s.pending.size > MAX_PENDING) this.s.pending.delete(this.s.pending.keys().next().value as string);
        }
        if (this.s.mode === 'legacy') {
          this.s.stats.toolCalls++;
          this.changed();
        }
        // update_plan direto ou tools.update_plan({...}) no JS do code mode (só o literal é lido; nada é executado).
        const planArgs = name === 'update_plan' ? input : name === 'exec' && typeof p.input === 'string' ? planFromScript(p.input) : undefined;
        const tasks = planArgs && planTasks(planArgs);
        if (tasks) {
          this.s.tasks = tasks;
          this.changed();
        }
        // Atividade em andamento: o item concluído (paginated) chega depois com o mesmo id e não duplica.
        const { desc, tool } = describeCodexTool(name, input, str(p.namespace), this.from());
        this.push(desc, { key: callId, tool, callId });
        if (name === 'request_user_input') this.ask(callId ?? this.autoKey(), input.questions);
        if (name === 'spawn_agent' && callId) this.rememberSpawn(callId, spawnTitle(input));
        return;
      }
      case 'local_shell_call': {
        const callId = str(p.call_id) ?? str(p.id);
        if (callId) this.s.pending.set(callId, 'local_shell');
        if (this.s.mode === 'legacy') {
          this.s.stats.toolCalls++;
          this.changed();
        }
        this.push(describeTool('Bash', { command: maskedCut(commandText(rec(p.action)?.command)) }), { key: callId, tool: 'Bash', callId });
        return;
      }
      case 'function_call_output':
      case 'custom_tool_call_output': {
        const callId = str(p.call_id);
        const name = callId ? this.s.pending.get(callId) : undefined;
        if (callId) this.s.pending.delete(callId);
        // A resposta do request_user_input (nos dois formatos; o item concluído não existe para ele).
        if (callId && this.answer(callId)) return;
        if (this.paginated()) return;
        // Legacy: o resultado de um comando (o item concluído não existe nesse formato).
        if (!name || !/^(shell|shell_command|local_shell|exec_command|container\.exec)$/.test(name)) return;
        const out = outputOf(p.output);
        if (out.exitCode !== undefined && out.exitCode !== 0) {
          this.push(SPECIAL.error('Bash', firstLine(out.text)), { key: `${callId}:e`, tool: 'Bash', current: this.s.current?.callId === callId });
        }
        this.progress();
        return;
      }
      case 'web_search_call':
        if (this.paginated()) return;
        this.push(describeTool('WebSearch', { query: maskedText(rec(p.action)?.query) }), { tool: 'WebSearch' });
        return;
      case 'agent_message': {
        // Multiagente v2: a 1ª mensagem endereçada a um subagente (recipient /root/<tarefa>; fica no rollout dele) é a
        // tarefa que o pai mandou e vira o título (não é prompt). Na raiz (recipient /root) são os resultados dos filhos.
        const recipient = str(p.recipient);
        const text = firstText(p.content);
        if (this.s.title !== undefined || !text || !recipient || !/^\/root\/./.test(recipient)) return;
        const task = messageTask(text);
        if (!task) return;
        this.s.title = titleText(task);
        this.changed();
        return;
      }
      default:
        return;
    }
  }
}

/**
 * Linha que não é deste thread: um session_meta depois do primeiro (o fork de um subagente copia o do pai logo depois
 * do cabeçalho; um resume repete o do próprio thread) ou a história herdada do pai (ordinal abaixo do
 * subagent_history_start_ordinal). Não gera atividade, sinal, título, número nem horário.
 */
function notOwnLine(state: CodexState, r: Rec): boolean {
  if (!state.meta) return false;
  if (r.type === 'session_meta') return true;
  const start = state.meta.historyStart;
  const ordinal = num(r.ordinal);
  return start !== undefined && ordinal !== undefined && ordinal < start;
}

/** Interpreta uma linha do rollout. Linhas inválidas, desconhecidas ou herdadas (notOwnLine) não geram nada. */
export function parseRolloutLine(state: CodexState, raw: string, ctx: CodexParseContext): CodexLineResult {
  let j: unknown;
  try {
    j = JSON.parse(raw);
  } catch {
    return { activities: [], signals: [], changed: false, at: ctx.now };
  }
  const r = rec(j);
  if (!r) return { activities: [], signals: [], changed: false, at: ctx.now };
  const at = toMs(r.timestamp);
  if (notOwnLine(state, r)) return { activities: [], signals: [], changed: false, at: at ?? ctx.now };
  if (at !== undefined) {
    if (state.firstAt === undefined || at < state.firstAt) state.firstAt = at;
    if (state.lastAt === undefined || at > state.lastAt) state.lastAt = at;
  }
  const p = new RolloutLineParser(state, ctx, r, at ?? ctx.now);
  try {
    p.run();
  } catch {
    // linha estranha demais: fica o que já tiver saído dela
  }
  return p.out;
}

/** O session_meta de uma linha (a primeira do rollout), ou undefined. */
export function metaFromLine(raw: string): RolloutMeta | undefined {
  try {
    const j = rec(JSON.parse(raw));
    const p = rec(j?.payload);
    return j?.type === 'session_meta' && p ? parseSessionMeta(p, toMs(j.timestamp)) : undefined;
  } catch {
    return undefined;
  }
}
