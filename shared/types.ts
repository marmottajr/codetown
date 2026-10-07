// Protocolo compartilhado entre o servidor (Node) e o cliente (navegador).
// Código puro: sem APIs de Node nem de DOM.
//
// Regra de evolução: mudanças aqui devem ser ADITIVAS (campos opcionais novos).
// Renomear/remover campos quebra servidor, mundo e UI ao mesmo tempo.

export type AgentKind = 'main' | 'sub';

/**
 * Estado de alto nível de um agente — é o que dirige o comportamento do personagem.
 * - working: processando um turno (ocupado). Fica na mesa digitando.
 * - waiting: precisa do usuário (permissão, pergunta, diálogo). Fica na mesa com a mão levantada.
 * - idle: terminou o turno e espera a próxima instrução. Circula pelo escritório (café, bebedouro...).
 * - shell: terminou o turno, mas há shell(s) rodando em segundo plano (ver `shells`); está esperando
 *   o shell terminar. Fica na mesa, de olho no terminal. (O registro do Claude Code grava "shell"
 *   quando a sessão está ociosa com shells em segundo plano.)
 * - done: subagente concluiu. Entrega o resultado ao agente principal e vai embora.
 * - offline: sessão encerrada. Vai embora (se for o último da sala, apaga a luz).
 */
export type AgentStatus = 'working' | 'waiting' | 'idle' | 'shell' | 'done' | 'offline';

/** Um comando de shell que o agente está esperando terminar. */
export interface ShellJob {
  /** Id da tarefa em segundo plano (ex.: "bo0ov3q3l") ou, em primeiro plano, o id do tool_use. */
  id: string;
  /** Texto curto em PT-BR: a descrição do Bash ou um resumo do comando (segredos mascarados). */
  label: string;
  /** Comando completo (mascarado, até ~300 caracteres), quando houver. */
  command?: string;
  /** Epoch ms em que o comando começou. */
  startedAt: number;
  /** true = run_in_background (o agente encerrou o turno e espera a notificação); false = comando em primeiro plano ainda sem resultado. */
  background: boolean;
  /** 'monitor' = ferramenta Monitor (acompanha um processo); 'shell' = Bash. */
  kind: 'shell' | 'monitor';
}

export type ActivityKind =
  | 'prompt' // recebeu nova instrução do usuário
  | 'think' // pensando (bloco de thinking)
  | 'respond' // escrevendo resposta em texto
  | 'read'
  | 'search'
  | 'edit'
  | 'write'
  | 'run' // comando no terminal
  | 'test'
  | 'git'
  | 'web'
  | 'browser'
  | 'plan' // tarefas / planejamento
  | 'delegate' // disparou subagente(s)
  | 'communicate' // mensagem para outro agente / aviso
  | 'ask' // pergunta ao usuário
  | 'mcp'
  | 'skill'
  | 'wait'
  | 'error'
  | 'compact' // compactação de contexto
  | 'done' // terminou o turno
  | 'other';

export interface Activity {
  /** Único por atividade (ex.: uuid da entrada + índice do bloco). */
  id: string;
  kind: ActivityKind;
  /** Emoji que representa a atividade. */
  icon: string;
  /** Texto curto em PT-BR (até ~46 caracteres). Ex.: "Editando App.tsx". */
  text: string;
  /** Detalhe opcional (comando completo, caminho, consulta...), até ~300 caracteres. */
  detail?: string;
  /** Nome bruto da ferramenta, quando houver. */
  tool?: string;
  /** Epoch ms. */
  at: number;
  durationMs?: number;
  error?: boolean;
}

export type TaskStatus = 'pending' | 'in_progress' | 'completed';

export interface TaskItem {
  id: string;
  title: string;
  status: TaskStatus;
  /** Forma no gerúndio ("Escrevendo testes"), quando disponível. */
  activeForm?: string;
}

export interface AgentStats {
  toolCalls: number;
  /** input + cache read + cache creation. */
  tokensIn: number;
  tokensOut: number;
  costUSD?: number;
  linesAdded?: number;
  linesRemoved?: number;
  /** Total de subagentes disparados por este agente. */
  subagents: number;
}

export interface AgentInfo {
  /** Estável enquanto o agente existir. Principal: "<conta>:<pid>". Sub: "<sessionId>:<agentId>". */
  id: string;
  kind: AgentKind;
  /** Para subagentes: id do agente que o disparou. */
  parentId?: string;
  roomId: string;
  /** Nome humano único no escritório. Ex.: "Marina". */
  name: string;
  /** Dica de apresentação do nome (usada pela arte para variar o visual). */
  look: 'f' | 'm';
  /** Papel. Principal: "Agente principal". Sub: tipo do subagente ("Explore", "Plan", "fork"...). */
  role: string;
  /** Título da sessão (principal) ou descrição da tarefa (sub). */
  title?: string;
  sessionId: string;
  /** Conta de origem = AccountInfo.id (basename do config dir, ex.: ".claude", ".claude-conta2"). */
  account: string;
  status: AgentStatus;
  /** Motivo em PT-BR quando status === 'waiting'. Ex.: "aprovar uma permissão". */
  waitingFor?: string;
  /** Atividade atual (ou a mais recente). */
  activity?: Activity;
  /** Últimas atividades, da mais antiga para a mais recente (máx. ~30). */
  recent: Activity[];
  tasks: TaskItem[];
  /** Shells rodando que o agente espera: em segundo plano e o comando em primeiro plano ainda sem resultado. */
  shells?: ShellJob[];
  model?: string;
  gitBranch?: string;
  permissionMode?: string;
  startedAt: number;
  lastEventAt: number;
  /** Quando o status mudou pela última vez (epoch ms). */
  statusSince: number;
  stats: AgentStats;
  /** Semente 32-bit para a aparência determinística do personagem. */
  seed: number;
  /** Subagente rodando em segundo plano. */
  background?: boolean;
}

export interface RoomInfo {
  /** Chave estável: cwd normalizado do projeto. */
  id: string;
  /** Nome exibido (basename do cwd, desambiguado se repetido). */
  name: string;
  /** Caminho completo do projeto. */
  path: string;
  /**
   * Posição da sala no prédio, atribuída pelo servidor e estável enquanto a sala existir.
   * Mapeamento no cliente: coluna = floor(slot / 2); slot par = lado norte do corredor, ímpar = lado sul.
   * Um slot liberado só é reutilizado após um período de espera (para dar tempo à animação de saída).
   */
  slot: number;
  /** Semente para cores/decoração determinísticas. */
  seed: number;
  createdAt: number;
}

export interface SourceInfo {
  /** Rótulo da conta (basename do config dir). */
  label: string;
  path: string;
  /** Sessões abertas detectadas nesta fonte. */
  sessions: number;
  ok: boolean;
  error?: string;
}

/** Uma janela de limite de uso do plano (ex.: sessão de 5h, semana). */
export interface UsageWindow {
  /** Percentual usado, 0–100. */
  utilization: number;
  /** Quando a janela reinicia (epoch ms). */
  resetsAt?: number;
}

export interface AccountUsage {
  /** Sessão de 5 horas. */
  fiveHour?: UsageWindow;
  /** Limite semanal (todos os modelos). */
  sevenDay?: UsageWindow;
  sevenDayOpus?: UsageWindow;
  sevenDaySonnet?: UsageWindow;
  /**
   * Origem dos números (as duas são arquivos locais gravados a partir do próprio Claude Code):
   * - 'statusline': capturado ao vivo do JSON que o Claude Code envia ao statusline (campo rate_limits),
   *   gravado em ~/.codetown/usage/<conta>.json pelo scripts/statusline-tap.mjs (recomendado);
   * - 'cache': `cachedUsageUtilization` gravado pelo próprio Claude Code (atualiza quando alguém roda /usage).
   */
  source: 'cache' | 'statusline';
  /** Quando os números foram obtidos na origem (epoch ms). */
  fetchedAt: number;
}

/** Uma conta do Claude (um config dir: ~/.claude, ~/.claude-conta2, ...). */
export interface AccountInfo {
  /** = AgentInfo.account (basename do config dir, ex.: ".claude"). */
  id: string;
  /** Rótulo curtíssimo (1–3 caracteres), ex.: "C" e "D" — atalhos detectados no shell — ou derivado. */
  short: string;
  /** Nome amigável. Ex.: "Conta C". */
  name: string;
  email?: string;
  organization?: string;
  /** Plano, quando conhecido (ex.: "Max", "Pro"). */
  plan?: string;
  /** Cor de identificação da conta (hex). */
  color: string;
  configDir: string;
  /** Sessões abertas agora nesta conta. */
  sessions: number;
  usage?: AccountUsage;
  /**
   * - ok: números recentes;
   * - stale: números antigos (ex.: cache do /usage de horas atrás);
   * - disabled: sem números (tap de statusline não instalado e nenhum cache do /usage).
   */
  usageStatus: 'ok' | 'stale' | 'disabled';
}

export interface OfficeSnapshot {
  /** Incrementa a cada mudança. */
  rev: number;
  serverTime: number;
  rooms: RoomInfo[];
  agents: AgentInfo[];
  /** Contas do Claude detectadas (com uso de 5h/semanal quando disponível). */
  accounts: AccountInfo[];
  meta: {
    demo: boolean;
    sources: SourceInfo[];
    startedAt: number;
    version: string;
  };
}

export interface FeedItem {
  id: string;
  agentId: string;
  roomId: string;
  agentName: string;
  roomName: string;
  /** Conta do agente (= AccountInfo.id). */
  account?: string;
  activity: Activity;
}

export type NoticeLevel = 'info' | 'success' | 'warn' | 'alert';

export interface Notice {
  id: string;
  level: NoticeLevel;
  text: string;
  agentId?: string;
  roomId?: string;
  at: number;
}

/**
 * Mensagens do servidor via SSE em GET /api/stream.
 * Cada mensagem chega como um evento SSE nomeado (`event: snapshot|feed|notice`) cujo `data` é o JSON de `data`.
 * Ao conectar, o servidor envia um `snapshot` completo e um `feed` com os itens recentes.
 */
export type ServerMessage =
  | { type: 'snapshot'; data: OfficeSnapshot }
  | { type: 'feed'; data: FeedItem[] }
  | { type: 'notice'; data: Notice };

/** Resposta de GET /api/agents/:id */
export interface AgentDetail {
  agent: AgentInfo;
  /** Histórico mais longo (máx. ~200), do mais antigo para o mais recente. */
  history: Activity[];
}
