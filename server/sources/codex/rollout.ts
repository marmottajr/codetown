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
import { describeTool, SPECIAL, type ActivityDescription } from '../../../shared/activity';
import type { Activity } from '../../../shared/types';
import { detectGitHubResult, githubCallOf } from '../github';
import type { ParsedActivity } from '../transcript';
import { maskedCut, maskedText, plainText } from './rollout-mask';
import { codexAgentPath, isThreadId, parseSessionMeta, usageFromRateLimits, type RolloutMeta } from './rollout-meta';
import {
  agentTask,
  applyMeta,
  askSummary,
  contentText,
  firstLine,
  firstText,
  MAX_PENDING,
  messageTask,
  outputOf,
  promptText,
  spawnTitle,
  titleText,
  type CodexLineResult,
  type CodexParseContext,
  type CodexState,
} from './rollout-state';
import {
  commandText,
  deliveredMessage,
  describeCodexPrompt,
  describeCodexTool,
  fileChanges,
  mcpName,
  parsedCmdActivity,
  parseArguments,
  pathFromUri,
  planFromScript,
  planTasks,
  sleepDesc,
  userMessagingText,
  webDesc,
} from './rollout-tools';
import { num, rec, str, toMs, type Rec } from './rollout-util';

export { isEncryptedText, maskedCut } from './rollout-mask';
export { codexAgentPath, isThreadId, parseSessionMeta, usageFromRateLimits } from './rollout-meta';
export type { HistoryMode, RolloutMeta } from './rollout-meta';
export { applyMeta, contentText, createCodexState, promptText } from './rollout-state';
export type { CodexLineResult, CodexParseContext, CodexSignal, CodexState } from './rollout-state';
export {
  commandText,
  deliveredMessage,
  describeCodexPrompt,
  describeCodexTool,
  fileChanges,
  mcpName,
  parseArguments,
  patchFiles,
  pathFromUri,
  planTasks,
  userMessagingText,
} from './rollout-tools';
export type { FileChangeEntry } from './rollout-tools';

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
