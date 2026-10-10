// Funções puras do registro de pedidos de permissão (registry.ts): a validação do JSON do hook (parseHookInput) e da
// decisão da página (parseDecision, parseAnswers), as sugestões "sempre permitir" (pickSuggestions), a conferência das
// respostas de um AskUserQuestion contra o formato original (askFormat, fitsFormat), as regras de decisão por tipo de
// pedido (Claude Code, Codex e canal paralelo) e o applyPermission, que o Office usa no snapshot. Nada aqui guarda
// estado nem importa do registry.ts, que reexporta o que os outros módulos já importavam dele.
import { codexApprovalReason, maskSecrets, truncate } from '../../shared/activity';
import { ANSWER_OTHER_MAX, ASK_TOOL } from '../../shared/answers';
import type { AgentInfo, CodexDecision, PermissionAnswer, PermissionDecision, PermissionRequestInfo, PermissionSuggestionInfo } from '../../shared/types';

/** Tempo que o hook espera por padrão (ele manda o próprio em `timeout_ms`). */
export const DEFAULT_TIMEOUT_MS = 300_000;
export const MIN_TIMEOUT_MS = 5_000;
export const MAX_TIMEOUT_MS = 30 * 60_000;

const DESTINATIONS = new Set(['session', 'localSettings', 'projectSettings', 'userSettings']);
const MAX_SUGGESTIONS = 4;
const MAX_MESSAGE = 1_000;
const RULE_MAX = 160;
/** Respostas numa decisão `answer` (o AskUserQuestion faz até 4 perguntas). */
const MAX_ANSWERS = 4;

/** Erro de validação do corpo vindo do hook (vira 400). */
export class InvalidRequest extends Error {}

/** Formato ORIGINAL de uma pergunta do AskUserQuestion: para conferir as respostas, que voltam por posição. */
export interface AskFormat {
  multiSelect: boolean;
  /** Quantas opções o original tem (inclusive as que o Habblaud não mostra). */
  options: number;
}

export type Rec = Record<string, unknown>;

export function rec(v: unknown): Rec | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : undefined;
}

function shortStr(v: unknown, max: number): string | undefined {
  return typeof v === 'string' && v.trim() && v.length <= max ? v.trim() : undefined;
}

function isIndex(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

/** Pedido que se responde com `answer` (as perguntas do AskUserQuestion; o Codex não as manda pelo hook). */
export function isQuestion(info: { tool: string; provider?: string }): boolean {
  return info.tool === ASK_TOOL && info.provider !== 'codex';
}

/** O Codex não aceita interromper nem "sempre permitir" (o hook dele só aprova ou recusa com motivo; "nesta sessão" só no canal paralelo). */
export function unsupportedByCodex(info: PermissionRequestInfo, d: PermissionDecision): boolean {
  return info.provider === 'codex' && (d.interrupt === true || d.suggestion !== undefined || (d.forSession === true && info.mode !== 'parallel'));
}

/**
 * Num pedido 'parallel': a decisão para o app-server (allow → accept ou, com forSession, acceptForSession; deny →
 * decline), 'terminal' (só fecha o cartão no escritório) ou por que a decisão da página não serve.
 */
export function parallelChoice(info: PermissionRequestInfo, d: PermissionDecision): CodexDecision | 'terminal' | 'unsupported' | 'invalid-answer' {
  if (d.behavior === 'terminal') return 'terminal';
  if (d.behavior === 'answer') return 'invalid-answer';
  if (d.interrupt === true || d.suggestion !== undefined) return 'unsupported';
  const decision: CodexDecision = d.behavior === 'deny' ? 'decline' : d.forSession ? 'acceptForSession' : 'accept';
  return info.decisions?.includes(decision) ? decision : 'unsupported';
}

/**
 * A decisão não serve para o tipo de pedido: `answer` só vale para perguntas, e pergunta não se aprova sem as
 * respostas (recusar e "responder no terminal" valem para os dois).
 */
export function wrongKind(info: PermissionRequestInfo, d: PermissionDecision): boolean {
  return d.behavior === 'answer' ? !isQuestion(info) || !info.questions?.length : d.behavior === 'allow' && isQuestion(info);
}

/** Formato original das perguntas do AskUserQuestion, por posição. */
export function askFormat(raw: unknown): Array<AskFormat | undefined> {
  if (!Array.isArray(raw)) return [];
  return raw.map((q) => {
    const r = rec(q);
    return r ? { multiSelect: r.multiSelect === true, options: Array.isArray(r.options) ? r.options.length : 0 } : undefined;
  });
}

/** Perguntas de verdade (com texto) no original: todas precisam aparecer no escritório para dar para responder por lá. */
export function askCount(raw: unknown): number {
  if (!Array.isArray(raw)) return 0;
  return raw.filter((q) => {
    const text = rec(q)?.question;
    return typeof text === 'string' && !!text.trim();
  }).length;
}

/** A resposta cabe no formato original da pergunta (posições das opções e quantas escolhas). */
export function fitsFormat(f: AskFormat | undefined, a: PermissionAnswer): boolean {
  if (!f) return false;
  const options = a.options ?? [];
  if (options.some((i) => i >= f.options)) return false;
  return f.multiSelect || options.length + (a.other ? 1 : 0) === 1;
}

/** Agente que ainda pode receber um pedido (não saiu nem concluiu). */
export function present(a: AgentInfo | undefined): a is AgentInfo {
  return !!a && a.status !== 'offline' && a.status !== 'done';
}

/** "Bash(npm test:*)" a partir de {toolName, ruleContent}. */
function ruleText(raw: unknown): string | undefined {
  const r = rec(raw);
  const tool = shortStr(r?.toolName, 200);
  if (!tool) return undefined;
  const content = typeof r?.ruleContent === 'string' && r.ruleContent.trim() ? r.ruleContent : undefined;
  return truncate(maskSecrets(content ? `${tool}(${content})` : tool), RULE_MAX);
}

/**
 * Sugestões "sempre permitir" que o Habblaud oferece: só `addRules` com `behavior: "allow"` num destino
 * conhecido. A página escolhe pela posição e o hook aplica a sugestão ORIGINAL que recebeu do Claude Code
 * (o servidor nunca inventa regras).
 */
export function pickSuggestions(raw: unknown): PermissionSuggestionInfo[] {
  if (!Array.isArray(raw)) return [];
  const out: PermissionSuggestionInfo[] = [];
  raw.forEach((s, index) => {
    const r = rec(s);
    if (!r || r.type !== 'addRules' || r.behavior !== 'allow' || typeof r.destination !== 'string' || !DESTINATIONS.has(r.destination)) return;
    const rules = Array.isArray(r.rules) ? r.rules.map(ruleText).filter((x): x is string => !!x) : [];
    if (!rules.length || out.length >= MAX_SUGGESTIONS) return;
    out.push({ index, rules: rules.slice(0, 4), destination: r.destination });
  });
  return out;
}

/**
 * Põe o pedido pendente no agente do snapshot (cópia já clonada pelo Office). Enquanto há pedido, o agente
 * aparece como 'waiting' — inclusive o subagente em segundo plano, cujo diálogo só aparece no terminal
 * depois que o hook responde (o registro de sessões do Claude Code não diz que ele espera).
 */
export function applyPermission(a: AgentInfo, p: PermissionRequestInfo | undefined): AgentInfo {
  if (!p || !present(a)) return a;
  a.permission = p;
  if (a.status !== 'waiting') {
    a.status = 'waiting';
    a.statusSince = p.createdAt;
  }
  // Codex: o pedido (hook ou canal paralelo) é sempre uma aprovação e vale por cima da espera que a fonte tenha posto
  // (a pergunta do request_user_input nunca passa por cima de uma aprovação pendente). Claude Code: vale o da fonte.
  if (p.provider === 'codex') a.waitingFor = codexApprovalReason(p.tool, p.title.startsWith('Rede('));
  else a.waitingFor ??= isQuestion(p) ? 'responder uma pergunta' : 'aprovar uma permissão';
  return a;
}

/**
 * Valida o JSON do hook (o mesmo que o Claude Code entrega no stdin, com `timeout_ms` do hook). O hook do Codex manda
 * também `provider: "codex"`, a conta (`account`, o basename do CODEX_HOME) e o caminho dela (`codexHome`); nele,
 * `agent_id` é o thread do subagente (e `session_id`, o thread raiz).
 */
export function parseHookInput(raw: unknown): {
  provider?: 'codex';
  account?: string;
  codexHome?: string;
  sessionId: string;
  agentId?: string;
  agentType?: string;
  cwd?: string;
  tool: string;
  input: Rec;
  suggestions: unknown;
  timeoutMs: number;
} {
  const r = rec(raw);
  const sessionId = shortStr(r?.session_id, 200);
  const tool = shortStr(r?.tool_name, 200);
  if (!r || !sessionId || !tool) throw new InvalidRequest('esperado o JSON do hook PermissionRequest (session_id e tool_name)');
  const t = typeof r.timeout_ms === 'number' && Number.isFinite(r.timeout_ms) ? r.timeout_ms : DEFAULT_TIMEOUT_MS;
  const codex = r.provider === 'codex';
  return {
    ...(codex ? { provider: 'codex' as const, account: shortStr(r.account, 200), codexHome: shortStr(r.codexHome, 4_096) } : {}),
    sessionId,
    agentId: shortStr(r.agent_id, 200),
    agentType: shortStr(r.agent_type, 120),
    cwd: shortStr(r.cwd, 4_096),
    tool,
    input: rec(r.tool_input) ?? {},
    suggestions: codex ? undefined : r.permission_suggestions,
    timeoutMs: Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, t)),
  };
}

/**
 * Respostas de uma decisão `answer`: até MAX_ANSWERS, cada uma com a posição da pergunta, as posições das opções
 * (distintas; ficam em ordem crescente) e/ou o texto livre (aparado, até ANSWER_OTHER_MAX). Se batem com as
 * perguntas do pedido, quem confere é o registro (decide).
 */
function parseAnswers(raw: unknown): PermissionAnswer[] | undefined {
  if (!Array.isArray(raw) || !raw.length || raw.length > MAX_ANSWERS) return undefined;
  const out: PermissionAnswer[] = [];
  for (const item of raw) {
    const r = rec(item);
    if (!r || !isIndex(r.question)) return undefined;
    const a: PermissionAnswer = { question: r.question };
    if (r.options !== undefined) {
      if (!Array.isArray(r.options) || !r.options.every(isIndex) || new Set(r.options).size !== r.options.length) return undefined;
      if (r.options.length) a.options = (r.options as number[]).slice().sort((x, y) => x - y);
    }
    if (r.other !== undefined) {
      if (typeof r.other !== 'string') return undefined;
      const other = r.other.trim();
      if (other.length > ANSWER_OTHER_MAX) return undefined;
      if (other) a.other = other;
    }
    out.push(a);
  }
  return out;
}

/** Corpo de uma decisão vinda da página. */
export function parseDecision(raw: unknown): PermissionDecision | undefined {
  const r = rec(raw);
  if (r?.behavior === 'answer') {
    const answers = parseAnswers(r.answers);
    return answers ? { behavior: 'answer', answers } : undefined;
  }
  if (!r || (r.behavior !== 'allow' && r.behavior !== 'deny' && r.behavior !== 'terminal')) return undefined;
  const d: PermissionDecision = { behavior: r.behavior };
  if (r.behavior === 'deny') {
    if (typeof r.message === 'string' && r.message.trim()) d.message = r.message.trim().slice(0, MAX_MESSAGE);
    if (r.interrupt === true) d.interrupt = true;
  }
  if (r.behavior === 'allow' && r.suggestion !== undefined) {
    if (typeof r.suggestion !== 'number' || !Number.isInteger(r.suggestion) || r.suggestion < 0) return undefined;
    d.suggestion = r.suggestion;
  }
  if (r.behavior === 'allow' && r.forSession === true) d.forSession = true;
  return d;
}
