// Estado de um thread do Codex (CodexState), os tipos que o parser devolve (sinais, resultado, contexto) e os helpers de
// texto do parser, das descrições de ferramenta e do shells.ts: título, resumo de pergunta, tarefa do filho, instrução de
// verdade, saída de ferramenta e 1ª linha de erro. Só os que cortam (askSummary, titleText, firstLine) mascaram ANTES do
// corte (ver `maskedCut`); contentText, promptText e outputOf entregam o texto cru a quem mascara adiante.
import type { GitHubEvent } from '../../../shared/github';
import type { AccountUsage, Activity, AgentStats, TaskItem } from '../../../shared/types';
import type { ParsedActivity } from '../transcript';
import { maskedCut, plainText } from './rollout-mask';
import type { HistoryMode, RolloutMeta } from './rollout-meta';
import { num, rec, str, type Rec } from './rollout-util';

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
export const MAX_PENDING = 128;
const ASK_SUMMARY_MAX = 120;

/** Resumo das perguntas de um request_user_input ("Qual banco? · Posso apagar dist?"), mascarado ANTES do corte. */
export function askSummary(raw: unknown): string {
  const questions = Array.isArray(raw) ? raw.map((q) => str(rec(q)?.question)).filter((q): q is string => q !== undefined) : [];
  return maskedCut(questions.join(' · '), ASK_SUMMARY_MAX);
}

/** Título (da sessão ou de um subagente) a partir de um texto livre: mascarado ANTES do corte. */
export function titleText(text: string): string {
  return maskedCut(text, TITLE_MAX);
}

/** 1º texto de um conteúdo: o próprio texto ou o 1º bloco {text} da lista (o agent_message traz um bloco cifrado junto). */
export function firstText(content: unknown): string | undefined {
  if (typeof content === 'string') return str(content);
  if (!Array.isArray(content)) return undefined;
  for (const b of content) {
    const text = str(rec(b)?.text);
    if (text) return text;
  }
  return undefined;
}

/** Nome da tarefa pelo caminho do agente ("/root/revisar_testes" → "revisar_testes"). */
export function agentTask(path: string | undefined): string | undefined {
  const last = path?.split('/').filter(Boolean).pop();
  return last && last !== 'root' ? last : undefined;
}

/**
 * Título do filho pelo spawn_agent: o 1º texto da mensagem (`message`; `prompt`/`task` em formatos antigos), senão o
 * task_name. A mensagem cifrada (0.160.1) não conta.
 */
export function spawnTitle(input: Rec): string {
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
export function messageTask(text: string): string | undefined {
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
export function outputOf(raw: unknown): { text: string; exitCode?: number } {
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
export function firstLine(s: string, max = 140): string | undefined {
  const line = s.split('\n').find((l) => l.trim());
  return line ? maskedCut(line, max) : undefined;
}
