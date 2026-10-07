// Simulador de escritório para demonstração e desenvolvimento.
// Puro (sem Node/DOM): roda no servidor (CODETOWN_DEMO=1) e no navegador (?mock=1).
//
// Gera sessões fictícias com ciclos realistas: prompt -> trabalho -> (permissão) -> (subagentes)
// -> (comando longo em primeiro plano) -> fim de turno -> (esperando shell em segundo plano) ->
// pausa -> ... e encerra sessões de tempos em tempos para exercitar as animações de chegada,
// saída, "apagar a luz" e sumiço de salas.
import type { AccountInfo, Activity, AgentInfo, FeedItem, Notice, OfficeSnapshot, RoomInfo, ShellJob, TaskItem } from '../types';
import { describePrompt, describeShellJob, describeTool, SHELL_DONE_TOOL, SHELL_WAIT_TOOL, SPECIAL, type ActivityDescription, type ShellOutcome } from '../activity';
import { hash32, mulberry32 } from '../hash';
import { pickName } from '../names';

interface DemoProject {
  name: string;
  files: string[];
  prompts: string[];
  tasks: string[];
  queries: string[];
  commands: string[];
  greps: string[];
}

const ROOT = '/Users/dev/projetos';

const PROJECTS: DemoProject[] = [
  {
    name: 'loja-virtual',
    files: ['src/pages/Checkout.tsx', 'src/components/Cart.tsx', 'src/api/orders.ts', 'src/hooks/useCart.ts', 'src/styles/theme.css', 'tests/cart.test.ts', 'package.json'],
    prompts: ['Cria a página de checkout com resumo do pedido', 'O total do carrinho não atualiza ao remover item', 'Adiciona cupom de desconto no checkout', 'Melhora o layout mobile da vitrine'],
    tasks: ['Criar página de checkout', 'Validar formulário de endereço', 'Integrar cálculo de frete', 'Escrever testes do carrinho', 'Ajustar layout mobile'],
    queries: ['react checkout form validation', 'cálculo de frete correios api'],
    commands: ['npm test', 'npm run build', 'git status', 'git diff', 'npm run lint', 'git commit -m "feat: checkout"'],
    greps: ['useCart', 'calculateTotal', 'TODO'],
  },
  {
    name: 'api-pagamentos',
    files: ['src/routes/payments.ts', 'src/services/pix.ts', 'src/db/migrations/004_refunds.sql', 'src/middleware/auth.ts', 'tests/pix.test.ts', 'docker-compose.yml'],
    prompts: ['Implementa estorno de pagamentos via Pix', 'Os webhooks estão duplicando cobranças, investiga', 'Adiciona rate limit nas rotas públicas'],
    tasks: ['Mapear fluxo de estorno', 'Criar migration de refunds', 'Implementar rota POST /refunds', 'Idempotência nos webhooks', 'Cobrir com testes'],
    queries: ['pix devolução api bacen', 'idempotency key webhook best practices'],
    commands: ['npm test', 'docker compose up -d db', 'psql -c "select count(*) from payments"', 'git status', 'curl -s http://localhost:3000/health'],
    greps: ['webhook', 'idempotencyKey', 'refund'],
  },
  {
    name: 'app-mobile',
    files: ['app/screens/Home.tsx', 'app/screens/Profile.tsx', 'app/navigation/index.tsx', 'app/services/api.ts', 'app.json'],
    prompts: ['Cria a tela de perfil com foto e edição', 'A navegação trava ao voltar da tela de detalhes', 'Adiciona modo escuro no app'],
    tasks: ['Criar tela de perfil', 'Upload de foto', 'Corrigir navegação', 'Tema escuro'],
    queries: ['react native navigation goBack freeze', 'expo image picker permissions'],
    commands: ['npx expo start', 'npm test', 'git status', 'npm install react-native-reanimated'],
    greps: ['navigation.goBack', 'useTheme'],
  },
  {
    name: 'data-pipeline',
    files: ['pipelines/ingest.py', 'pipelines/transform.py', 'dags/daily_report.py', 'requirements.txt', 'tests/test_transform.py'],
    prompts: ['O relatório diário está vindo com datas erradas', 'Adiciona deduplicação na ingestão', 'Otimiza a transformação que está lenta'],
    tasks: ['Investigar fuso horário', 'Corrigir parse de datas', 'Deduplicar eventos', 'Testes de regressão'],
    queries: ['pandas tz_convert daylight saving', 'airflow dag catchup false'],
    commands: ['pytest -q', 'python pipelines/ingest.py --dry-run', 'pip install -r requirements.txt', 'git status'],
    greps: ['tz_localize', 'drop_duplicates'],
  },
  {
    name: 'site-institucional',
    files: ['src/pages/index.astro', 'src/components/Hero.astro', 'src/content/blog/lancamento.md', 'astro.config.mjs', 'public/robots.txt'],
    prompts: ['Cria a seção de depoimentos na home', 'Melhora o SEO das páginas do blog', 'Adiciona formulário de contato'],
    tasks: ['Seção de depoimentos', 'Meta tags do blog', 'Sitemap', 'Formulário de contato'],
    queries: ['astro sitemap integration', 'schema.org organization json-ld'],
    commands: ['npm run build', 'npm run dev', 'git status', 'npx lighthouse http://localhost:4321'],
    greps: ['<meta', 'description'],
  },
  {
    name: 'chatbot-suporte',
    files: ['bot/handlers/faq.ts', 'bot/llm/prompt.ts', 'bot/integrations/zendesk.ts', 'bot/index.ts', 'tests/faq.test.ts'],
    prompts: ['O bot não está encaminhando para humano', 'Adiciona integração com o Zendesk', 'Melhora o prompt para respostas mais curtas'],
    tasks: ['Regra de escalonamento', 'Cliente Zendesk', 'Ajustar prompt', 'Testes de conversa'],
    queries: ['zendesk tickets api create', 'llm handoff to human patterns'],
    commands: ['npm test', 'npm run dev', 'git status', 'git push'],
    greps: ['handoff', 'escalate'],
  },
];

const SUB_TYPES = ['Explore', 'general-purpose', 'Plan', 'code-reviewer', 'test-runner'];
const SUB_TASKS = [
  'Mapear arquivos envolvidos',
  'Revisar código existente',
  'Pesquisar documentação',
  'Rodar suíte de testes',
  'Investigar causa do bug',
  'Propor plano de implementação',
  'Verificar cobertura de testes',
  'Analisar logs de erro',
];
const MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-1'];

/** Comandos que os agentes deixam rodando em segundo plano (e encerram o turno esperando). */
const BACKGROUND_JOBS: Array<{ description: string; command: string }> = [
  { description: 'Rodar a suíte de testes', command: 'npm test -- --runInBand' },
  { description: 'Build de produção', command: 'npm run build -- --mode production' },
  { description: 'Migração do banco', command: 'npm run db:migrate && npm run db:seed' },
  { description: 'Rodar os testes de integração', command: 'pytest -q tests/integration' },
  { description: 'Gerar o relatório completo', command: 'python pipelines/report.py --full' },
  { description: 'Subir os containers', command: 'docker compose up --build --wait' },
  { description: 'Testes de ponta a ponta', command: 'npx playwright test' },
  { description: 'Auditoria de desempenho', command: 'npx lighthouse http://localhost:4321 --quiet' },
];
/** Comandos demorados em primeiro plano (o agente fica parado esperando o resultado). */
const FOREGROUND_JOBS: Array<{ description: string; command: string }> = [
  { description: 'Instalar as dependências', command: 'npm ci' },
  { description: 'Rodar os testes do módulo', command: 'npm test -- src/api' },
  { description: 'Compilar o projeto', command: 'npm run build' },
  { description: 'Baixar a imagem do banco', command: 'docker pull postgres:17' },
];
/** Chance de, ao fim de um turno, deixar um shell em segundo plano rodando. */
const SHELL_CHANCE = 0.35;
/** Chance, a cada ação, de rodar um comando longo em primeiro plano (no máximo um por turno). */
const FOREGROUND_CHANCE = 0.07;
/** Chance de um shell em segundo plano falhar. */
const SHELL_FAIL_CHANCE = 0.15;

type DemoAccount = Omit<AccountInfo, 'sessions' | 'usage' | 'usageStatus'>;

// No ?mock=1 as contas imitam o cenário real (C e D). Misturado aos dados reais no servidor
// (idPrefix), o demo usa contas próprias, inconfundíveis com as de verdade.
const DEMO_ACCOUNTS: DemoAccount[] = [
  { id: '.claude', short: 'C', name: 'Conta C', email: 'dev@empresa.example', organization: 'Empresa', plan: 'Max', color: '#f08a3c', configDir: '~/.claude' },
  { id: '.claude-conta2', short: 'D', name: 'Conta D', email: 'dev@pessoal.example', plan: 'Max', color: '#4aa8e8', configDir: '~/.claude-conta2' },
];
const MERGED_ACCOUNTS: Array<Pick<DemoAccount, 'short' | 'name' | 'color'>> = [
  { short: 'X', name: 'Demo X', color: '#5cc97b' },
  { short: 'Y', name: 'Demo Y', color: '#a77bf3' },
];
const HOUR = 3_600_000;

type Phase = 'working' | 'waiting' | 'idle' | 'delegating' | 'shell' | 'leaving';

interface SimAgent {
  info: AgentInfo;
  project: DemoProject;
  rng: () => number;
  phase: Phase;
  phaseUntil: number;
  nextActionAt: number;
  actionsLeft: number;
  children: string[];
  closeAt: number;
  removeAt?: number;
  taskCursor: number;
  /** Fim (e desfecho) de cada shell em segundo plano rodando, por id do job. */
  shellEnds: Map<string, { at: number; outcome: ShellOutcome }>;
  /** Comando em primeiro plano rodando até este instante. */
  foregroundUntil?: number;
  /** Já disparou shell (segundo plano) ou comando longo (primeiro plano) neste turno. */
  shelledThisTurn: boolean;
  foregroundThisTurn: boolean;
}

export interface DemoTickResult {
  changed: boolean;
  feed: FeedItem[];
  notices: Notice[];
}

export interface DemoOptions {
  seed?: number;
  /** Multiplicador de velocidade (2 = tudo acontece 2x mais rápido). */
  speed?: number;
  /** Quantas sessões principais manter abertas (aprox.). */
  sessions?: number;
  /** Prefixo de ids (o servidor usa "demo:" para não colidir com dados reais). */
  idPrefix?: string;
}

const SLOT_COOLDOWN_MS = 30_000;
const OFFLINE_GRACE_MS = 20_000;
const DONE_GRACE_MS = 25_000;

export class DemoSimulator {
  private rng: () => number;
  private speed: number;
  private target: number;
  private prefix: string;
  /** Marca desta instância: ids de agentes/atividades/avisos não se repetem ao religar o demo. */
  private tag: string;
  private accounts: DemoAccount[];
  private agents = new Map<string, SimAgent>();
  private rooms = new Map<string, RoomInfo>();
  private slotFreedAt = new Map<number, number>();
  private rev = 0;
  private dirty = true;
  private seq = 0;
  private nextSpawnAt = 0;
  private startedAt: number;
  private pendingFeed: FeedItem[] = [];
  private pendingNotices: Notice[] = [];
  private usage = new Map<string, { five: number; week: number; fiveReset: number; weekReset: number }>();

  constructor(opts: DemoOptions = {}, now = Date.now()) {
    this.rng = mulberry32(opts.seed ?? hash32(String(now)));
    this.speed = opts.speed ?? 1;
    this.target = opts.sessions ?? 4;
    this.prefix = opts.idPrefix ?? '';
    this.tag = now.toString(36);
    this.accounts = this.prefix
      ? DEMO_ACCOUNTS.map((acc, i) => ({ ...acc, ...MERGED_ACCOUNTS[i], id: `${this.prefix}${acc.id}`, configDir: '(demonstração)' }))
      : DEMO_ACCOUNTS;
    this.startedAt = now;
    this.accounts.forEach((acc, i) =>
      this.usage.set(acc.id, {
        five: 12 + this.rng() * 30,
        week: 20 + this.rng() * 35,
        fiveReset: now + (1.5 + i * 1.7) * HOUR,
        weekReset: now + (2 + i * 2.5) * 24 * HOUR,
      }),
    );
    // Começa com o escritório já movimentado — e com alguém esperando um shell (a espera leva minutos;
    // sem isso, a primeira só apareceria depois do primeiro turno completo).
    for (let i = 0; i < this.target - 1; i++) this.spawnSession(now, true);
    const first = [...this.agents.values()].find((a) => a.info.kind === 'main');
    if (first) this.startBackgroundShells(first, now, true);
    this.nextSpawnAt = now + this.ms(20_000, 40_000);
    // Descarta o feed/avisos de abertura.
    this.pendingFeed = [];
    this.pendingNotices = [];
  }

  /** Avança a simulação até `now`. */
  tick(now: number): DemoTickResult {
    if (now >= this.nextSpawnAt) {
      const open = [...this.agents.values()].filter((a) => a.info.kind === 'main' && a.phase !== 'leaving').length;
      if (open < this.target) this.spawnSession(now, false);
      this.nextSpawnAt = now + this.ms(25_000, 70_000);
    }
    for (const a of [...this.agents.values()]) this.step(a, now);
    this.gc(now);
    const changed = this.dirty;
    if (changed) this.rev++;
    this.dirty = false;
    const feed = this.pendingFeed;
    const notices = this.pendingNotices;
    this.pendingFeed = [];
    this.pendingNotices = [];
    return { changed, feed, notices };
  }

  snapshot(now = Date.now()): OfficeSnapshot {
    return {
      rev: this.rev,
      serverTime: now,
      rooms: [...this.rooms.values()].map((r) => ({ ...r })),
      agents: [...this.agents.values()].map((a) => structuredCloneAgent(a.info)),
      accounts: this.accounts.map((acc) => {
        const u = this.usage.get(acc.id)!;
        return {
          ...acc,
          sessions: [...this.agents.values()].filter((a) => a.info.kind === 'main' && a.info.account === acc.id && a.info.status !== 'offline').length,
          usage: {
            fiveHour: { utilization: Math.round(u.five), resetsAt: u.fiveReset },
            sevenDay: { utilization: Math.round(u.week), resetsAt: u.weekReset },
            source: 'statusline' as const,
            fetchedAt: now,
          },
          usageStatus: 'ok' as const,
        };
      }),
      meta: { demo: true, sources: [], startedAt: this.startedAt, version: 'demo' },
    };
  }

  // ---------------------------------------------------------------- internos

  private ms(min: number, max: number): number {
    return (min + this.rng() * (max - min)) / this.speed;
  }

  private pick<T>(arr: readonly T[], rng = this.rng): T {
    return arr[Math.floor(rng() * arr.length)];
  }

  private usedNames(): Set<string> {
    return new Set([...this.agents.values()].map((a) => a.info.name));
  }

  private ensureRoom(project: DemoProject, now: number): RoomInfo {
    const id = `${this.prefix}${ROOT}/${project.name}`;
    const existing = this.rooms.get(id);
    if (existing) return existing;
    const used = new Set([...this.rooms.values()].map((r) => r.slot));
    let slot = 0;
    while (used.has(slot) || now - (this.slotFreedAt.get(slot) ?? -Infinity) < SLOT_COOLDOWN_MS) slot++;
    const room: RoomInfo = { id, name: project.name, path: `${ROOT}/${project.name}`, slot, seed: hash32(id), createdAt: now };
    this.rooms.set(id, room);
    this.notice(now, 'info', `🏗️ Nova sala: ${project.name}`, undefined, id);
    this.dirty = true;
    return room;
  }

  private spawnSession(now: number, warm: boolean): void {
    const activeRooms = new Set([...this.rooms.values()].map((r) => r.name));
    // 35% de chance de reaproveitar uma sala existente (2 sessões no mesmo projeto).
    const reuse = activeRooms.size > 0 && this.rng() < 0.35;
    const candidates = PROJECTS.filter((p) => (reuse ? activeRooms.has(p.name) : !activeRooms.has(p.name)));
    const project = this.pick(candidates.length ? candidates : PROJECTS);
    const room = this.ensureRoom(project, now);
    const n = ++this.seq;
    const sessionId = `${this.prefix}sess-${this.tag}-${n}-${Math.floor(this.rng() * 1e9).toString(36)}`;
    const id = `${this.prefix || 'demo:'}${this.tag}-${n}`;
    const person = pickName(sessionId, this.usedNames());
    const rng = mulberry32(hash32(sessionId));
    const tasks: TaskItem[] = project.tasks
      .slice(0, 3 + Math.floor(rng() * 2))
      .map((title, i) => ({ id: String(i + 1), title, status: 'pending' }));
    const info: AgentInfo = {
      id,
      kind: 'main',
      roomId: room.id,
      name: person.name,
      look: person.look,
      role: 'Agente principal',
      title: this.pick(project.prompts, rng),
      sessionId,
      account: this.rng() < 0.6 ? this.accounts[0].id : this.accounts[1].id,
      status: 'idle',
      recent: [],
      tasks,
      model: this.pick(MODELS, rng),
      gitBranch: this.pick(['main', 'develop', 'feat/checkout', 'fix/webhooks'], rng),
      permissionMode: 'default',
      startedAt: now,
      lastEventAt: now,
      statusSince: now,
      stats: { toolCalls: 0, tokensIn: 0, tokensOut: 0, costUSD: 0, linesAdded: 0, linesRemoved: 0, subagents: 0 },
      seed: hash32(id),
    };
    const a: SimAgent = {
      info,
      project,
      rng,
      phase: 'idle',
      phaseUntil: now + (warm ? this.ms(0, 8_000) : this.ms(2_000, 5_000)),
      nextActionAt: now,
      actionsLeft: 0,
      children: [],
      closeAt: now + this.ms(150_000, 420_000),
      taskCursor: 0,
      shellEnds: new Map(),
      shelledThisTurn: false,
      foregroundThisTurn: false,
    };
    this.agents.set(id, a);
    const acc = this.accounts.find((x) => x.id === info.account);
    if (!warm) this.notice(now, 'info', `👋 ${info.name} chegou em ${project.name}${acc ? ` (${acc.name})` : ''}`, id, room.id);
    this.dirty = true;
  }

  private spawnSub(parent: SimAgent, now: number): void {
    const n = ++this.seq;
    const agentId = `a${Math.floor(this.rng() * 1e12).toString(16)}`;
    const id = `${parent.info.sessionId}:${agentId}`;
    const person = pickName(id, this.usedNames());
    const rng = mulberry32(hash32(id));
    const desc = this.pick(SUB_TASKS, rng);
    const info: AgentInfo = {
      id,
      kind: 'sub',
      parentId: parent.info.id,
      roomId: parent.info.roomId,
      name: person.name,
      look: person.look,
      role: this.pick(SUB_TYPES, rng),
      title: desc,
      sessionId: parent.info.sessionId,
      account: parent.info.account,
      status: 'working',
      recent: [],
      tasks: [],
      model: parent.info.model,
      gitBranch: parent.info.gitBranch,
      startedAt: now,
      lastEventAt: now,
      statusSince: now,
      stats: { toolCalls: 0, tokensIn: 0, tokensOut: 0, subagents: 0 },
      seed: hash32(id),
      background: rng() < 0.3,
    };
    const sub: SimAgent = {
      info,
      project: parent.project,
      rng,
      phase: 'working',
      phaseUntil: now + this.ms(18_000, 55_000),
      nextActionAt: now + this.ms(1_500, 3_000),
      actionsLeft: 99,
      children: [],
      closeAt: Infinity,
      taskCursor: n,
      shellEnds: new Map(),
      shelledThisTurn: true,
      foregroundThisTurn: true,
    };
    this.agents.set(id, sub);
    parent.children.push(id);
    parent.info.stats.subagents++;
    this.activity(sub, now, { kind: 'prompt', icon: '📨', text: `Nova tarefa: “${desc}”`, detail: desc });
    this.dirty = true;
  }

  private step(a: SimAgent, now: number): void {
    if (a.removeAt !== undefined) return;
    if (a.info.kind === 'sub') return this.stepSub(a, now);

    // Encerramento da sessão (só quando ocioso, como um usuário fechando o terminal).
    if (now >= a.closeAt && a.phase === 'idle') {
      a.phase = 'leaving';
      this.setStatus(a, 'offline', now);
      a.removeAt = now + OFFLINE_GRACE_MS;
      this.notice(now, 'info', `🚪 ${a.info.name} encerrou a sessão`, a.info.id, a.info.roomId);
      return;
    }

    switch (a.phase) {
      case 'idle':
        if (now >= a.phaseUntil) {
          const prompt = this.pick(a.project.prompts, a.rng);
          a.info.title = prompt;
          a.phase = 'working';
          a.shelledThisTurn = false;
          a.foregroundThisTurn = false;
          a.actionsLeft = 5 + Math.floor(a.rng() * 9);
          a.nextActionAt = now + this.ms(1_200, 2_500);
          this.setStatus(a, 'working', now);
          this.activity(a, now, describePrompt(prompt));
          this.advanceTask(a, 'in_progress');
        }
        break;
      case 'waiting':
        if (now >= a.phaseUntil) {
          a.phase = 'working';
          a.info.waitingFor = undefined;
          this.setStatus(a, 'working', now);
          a.nextActionAt = now + this.ms(800, 1_500);
        }
        break;
      case 'delegating': {
        const pending = a.children.filter((c) => this.agents.get(c)?.info.status === 'working');
        if (pending.length === 0) {
          a.phase = 'working';
          a.children = [];
          this.activity(a, now, { kind: 'think', icon: '📥', text: 'Juntando os resultados da equipe' });
          a.nextActionAt = now + this.ms(2_000, 4_000);
        }
        break;
      }
      case 'shell': {
        // Shell(s) terminando: a notificação acorda o agente, que lê o resultado e trabalha mais um pouco.
        const due = [...a.shellEnds].filter(([, e]) => e.at <= now).map(([id]) => id);
        if (!due.length) break;
        for (const id of due) this.finishShell(a, id, now);
        a.phase = 'working';
        a.actionsLeft = 1 + Math.floor(a.rng() * 3);
        a.nextActionAt = now + this.ms(2_000, 3_500);
        this.setStatus(a, 'working', now);
        break;
      }
      case 'working':
        if (now < a.nextActionAt) break;
        if (a.foregroundUntil !== undefined) this.endForeground(a);
        // Shell em segundo plano terminando no meio do turno: a notificação chega e o agente segue trabalhando.
        for (const [id, end] of [...a.shellEnds]) {
          if (end.at > now) continue;
          this.finishShell(a, id, now);
          a.actionsLeft = Math.max(a.actionsLeft, 1);
          a.nextActionAt = now + this.ms(2_000, 3_500);
        }
        if (now < a.nextActionAt) break;
        if (a.actionsLeft <= 0) {
          // Ainda há shell em segundo plano rodando (já pedido antes): volta a esperar por ele.
          if (a.shellEnds.size) {
            this.waitForShells(a, now, false);
            break;
          }
          if (!a.shelledThisTurn && a.rng() < SHELL_CHANCE) {
            this.startBackgroundShells(a, now, false);
            break;
          }
          a.phase = 'idle';
          a.phaseUntil = now + this.ms(20_000, 75_000);
          this.advanceTask(a, 'completed');
          this.activity(a, now, SPECIAL.turnDone(this.ms(40_000, 240_000) * this.speed));
          this.setStatus(a, 'idle', now);
          this.notice(now, 'success', `✅ ${a.info.name} concluiu em ${a.project.name}`, a.info.id, a.info.roomId);
          break;
        }
        a.actionsLeft--;
        {
          const roll = a.rng();
          if (roll < 0.1) {
            a.phase = 'waiting';
            a.phaseUntil = now + this.ms(7_000, 16_000);
            a.info.waitingFor = 'aprovar uma permissão';
            this.setStatus(a, 'waiting', now);
            this.activity(a, now, SPECIAL.waiting('aprovar uma permissão'));
            this.notice(now, 'alert', `✋ ${a.info.name} precisa de você em ${a.project.name}: aprovar uma permissão`, a.info.id, a.info.roomId);
          } else if (roll < 0.2 && a.children.length === 0) {
            const count = 2 + Math.floor(a.rng() * 3);
            this.activity(a, now, describeTool('Agent', { description: `${count} frentes em paralelo`, subagent_type: 'general-purpose' }));
            for (let i = 0; i < count; i++) this.spawnSub(a, now);
            a.phase = 'delegating';
          } else if (roll < 0.2 + FOREGROUND_CHANCE && !a.foregroundThisTurn && a.actionsLeft > 0) {
            this.startForeground(a, now);
          } else {
            this.activity(a, now, this.randomTool(a));
            a.nextActionAt = now + this.ms(1_800, 5_500);
          }
        }
        break;
      case 'leaving':
        break;
    }
  }

  private stepSub(a: SimAgent, now: number): void {
    if (a.info.status !== 'working') return;
    if (now >= a.phaseUntil) {
      this.activity(a, now, SPECIAL.turnDone(now - a.info.startedAt));
      this.setStatus(a, 'done', now);
      a.removeAt = now + DONE_GRACE_MS;
      const parent = a.info.parentId ? this.agents.get(a.info.parentId) : undefined;
      this.notice(now, 'success', `📦 ${a.info.name} entregou “${a.info.title}” para ${parent?.info.name ?? 'o agente'}`, a.info.id, a.info.roomId);
      return;
    }
    if (now >= a.nextActionAt) {
      this.activity(a, now, this.randomTool(a));
      a.nextActionAt = now + this.ms(1_500, 4_500);
    }
  }

  // ---------------------------------------------------------------- shells

  /**
   * Deixa 1 (ou 2) comandos rodando em segundo plano e encerra o turno esperando por eles (status 'shell').
   * `warm` = abertura do escritório: o shell já roda há um tempo e não há aviso.
   */
  private startBackgroundShells(a: SimAgent, now: number, warm: boolean): void {
    const count = a.rng() < 0.25 ? 2 : 1;
    const specs = BACKGROUND_JOBS.slice();
    const jobs: ShellJob[] = [];
    if (warm) {
      a.info.title = this.pick(a.project.prompts, a.rng);
      this.activity(a, now, describePrompt(a.info.title));
    }
    const base = warm ? now - this.ms(20_000, 150_000) : now;
    for (let i = 0; i < count; i++) {
      const spec = specs.splice(Math.floor(a.rng() * specs.length), 1)[0];
      const d = describeShellJob('Bash', spec);
      const id = `b${Math.floor(this.rng() * 2 ** 40).toString(36)}`;
      // Um tool_use depois do outro: o primeiro é o mais antigo (é ele que dá o tempo da espera).
      const job: ShellJob = { id, label: d.label, startedAt: base - (count - 1 - i) * 1_200, background: true, kind: 'shell' };
      if (d.command) job.command = d.command;
      jobs.push(job);
      a.shellEnds.set(id, { at: now + this.ms(40_000, 150_000), outcome: a.rng() < SHELL_FAIL_CHANCE ? 'failed' : 'ok' });
      this.activity(a, now, describeTool('Bash', { ...spec, run_in_background: true }));
    }
    a.info.shells = [...(a.info.shells ?? []), ...jobs].sort(byStart);
    a.shelledThisTurn = true;
    if (!warm) this.advanceTask(a, 'completed');
    this.waitForShells(a, now, !warm);
  }

  /** Fim de turno com shell(s) em segundo plano rodando: fica na mesa esperando. */
  private waitForShells(a: SimAgent, now: number, notify: boolean): void {
    const jobs = (a.info.shells ?? []).filter((j) => j.background);
    const main = jobs[0];
    a.phase = 'shell';
    this.setStatus(a, 'shell', now);
    this.activity(a, now, SPECIAL.waitingShell(main?.label, jobs.length, main?.command));
    if (notify && main) this.notice(now, 'info', `⏳ ${a.info.name} está esperando o shell em ${a.project.name}: ${main.label}`, a.info.id, a.info.roomId);
  }

  /** Um shell em segundo plano terminou: atividade 'ShellDone' (o mundo comemora ou lamenta) e aviso. */
  private finishShell(a: SimAgent, id: string, now: number): void {
    const end = a.shellEnds.get(id);
    a.shellEnds.delete(id);
    const job = a.info.shells?.find((j) => j.id === id);
    this.setShells(a, (a.info.shells ?? []).filter((j) => j.id !== id));
    if (!job || !end) return;
    this.activity(a, now, SPECIAL.shellDone(job.label, end.outcome, now - job.startedAt, job.command));
    if (end.outcome === 'ok') this.notice(now, 'success', `✅ ${a.info.name}: shell terminou em ${a.project.name} — ${job.label}`, a.info.id, a.info.roomId);
    else this.notice(now, 'warn', `❌ ${a.info.name}: shell falhou em ${a.project.name} — ${job.label}`, a.info.id, a.info.roomId);
  }

  /** Comando demorado em primeiro plano: o agente fica parado esperando o resultado (status continua 'working'). */
  private startForeground(a: SimAgent, now: number): void {
    const spec = this.pick(FOREGROUND_JOBS, a.rng);
    const d = describeShellJob('Bash', spec);
    const job: ShellJob = { id: `toolu_demo_${this.tag}_${++this.seq}`, label: d.label, startedAt: now, background: false, kind: 'shell' };
    if (d.command) job.command = d.command;
    this.setShells(a, [...(a.info.shells ?? []), job]);
    a.foregroundThisTurn = true;
    a.foregroundUntil = now + this.ms(15_000, 40_000);
    a.nextActionAt = a.foregroundUntil;
    this.activity(a, now, describeTool('Bash', spec));
  }

  /** O comando em primeiro plano devolveu o resultado. */
  private endForeground(a: SimAgent): void {
    a.foregroundUntil = undefined;
    this.setShells(a, (a.info.shells ?? []).filter((j) => j.background));
  }

  private setShells(a: SimAgent, jobs: ShellJob[]): void {
    if (jobs.length) a.info.shells = jobs.sort(byStart);
    else delete a.info.shells;
    this.dirty = true;
  }

  private randomTool(a: SimAgent): ActivityDescription {
    const p = a.project;
    const r = a.rng();
    const file = this.pick(p.files, a.rng);
    if (r < 0.26) return describeTool('Read', { file_path: `${ROOT}/${p.name}/${file}` });
    if (r < 0.44) return describeTool('Edit', { file_path: `${ROOT}/${p.name}/${file}` });
    if (r < 0.5) return describeTool('Write', { file_path: `${ROOT}/${p.name}/${file}` });
    if (r < 0.62) return describeTool('Grep', { pattern: this.pick(p.greps, a.rng) });
    if (r < 0.66) return describeTool('Glob', { pattern: '**/*.ts' });
    if (r < 0.82) return describeTool('Bash', { command: this.pick(p.commands, a.rng) });
    if (r < 0.88) return describeTool('WebSearch', { query: this.pick(p.queries, a.rng) });
    if (r < 0.91) return describeTool('WebFetch', { url: 'https://developer.mozilla.org/pt-BR/docs/Web' });
    if (r < 0.95) return SPECIAL.think();
    return describeTool('TodoWrite', { todos: a.info.tasks.map((t) => ({ status: t.status })) });
  }

  private advanceTask(a: SimAgent, status: 'in_progress' | 'completed'): void {
    const tasks = a.info.tasks;
    if (!tasks.length) return;
    if (status === 'in_progress') {
      const next = tasks.find((t) => t.status === 'pending');
      if (next && !tasks.some((t) => t.status === 'in_progress')) next.status = 'in_progress';
    } else {
      const cur = tasks.find((t) => t.status === 'in_progress');
      if (cur) cur.status = 'completed';
    }
    this.dirty = true;
  }

  private setStatus(a: SimAgent, status: AgentInfo['status'], now: number): void {
    if (a.info.status !== status) {
      a.info.status = status;
      a.info.statusSince = now;
      this.dirty = true;
    }
  }

  private activity(a: SimAgent, now: number, d: ActivityDescription & { tool?: string; error?: boolean }): void {
    const act: Activity = { id: `${this.prefix}${this.tag}-a${++this.seq}`, at: now, ...d };
    a.info.activity = act;
    a.info.recent = [...a.info.recent, act].slice(-30);
    a.info.lastEventAt = now;
    const synthetic = d.tool === SHELL_DONE_TOOL || d.tool === SHELL_WAIT_TOOL;
    if (!synthetic && d.kind !== 'prompt' && d.kind !== 'done' && d.kind !== 'wait' && d.kind !== 'think') {
      a.info.stats.toolCalls++;
    }
    const u = this.usage.get(a.info.account);
    if (u) {
      if (now > u.fiveReset) Object.assign(u, { five: 0, fiveReset: now + 5 * HOUR });
      u.five = Math.min(100, u.five + 0.01 + a.rng() * 0.02);
      u.week = Math.min(100, u.week + 0.001 + a.rng() * 0.002);
    }
    a.info.stats.tokensIn += Math.floor(2_000 + a.rng() * 12_000);
    a.info.stats.tokensOut += Math.floor(80 + a.rng() * 900);
    if (a.info.stats.costUSD !== undefined) a.info.stats.costUSD = +(a.info.stats.costUSD + a.rng() * 0.04).toFixed(4);
    if (d.kind === 'edit' || d.kind === 'write') {
      a.info.stats.linesAdded = (a.info.stats.linesAdded ?? 0) + Math.floor(a.rng() * 40);
      a.info.stats.linesRemoved = (a.info.stats.linesRemoved ?? 0) + Math.floor(a.rng() * 15);
    }
    const room = this.rooms.get(a.info.roomId);
    this.pendingFeed.push({
      id: act.id,
      agentId: a.info.id,
      roomId: a.info.roomId,
      agentName: a.info.name,
      roomName: room?.name ?? '',
      account: a.info.account,
      activity: act,
    });
    this.dirty = true;
  }

  private notice(now: number, level: Notice['level'], text: string, agentId?: string, roomId?: string): void {
    const n: Notice = { id: `${this.prefix}${this.tag}-n${++this.seq}`, level, text, at: now };
    if (agentId) n.agentId = agentId;
    if (roomId) n.roomId = roomId;
    this.pendingNotices.push(n);
  }

  private gc(now: number): void {
    for (const [id, a] of this.agents) {
      if (a.removeAt !== undefined && now >= a.removeAt) {
        this.agents.delete(id);
        this.dirty = true;
      }
    }
    const occupied = new Set([...this.agents.values()].map((a) => a.info.roomId));
    for (const [id, room] of this.rooms) {
      if (!occupied.has(id)) {
        this.rooms.delete(id);
        this.slotFreedAt.set(room.slot, now);
        this.dirty = true;
      }
    }
  }
}

const byStart = (x: ShellJob, y: ShellJob) => x.startedAt - y.startedAt || x.id.localeCompare(y.id);

function structuredCloneAgent(a: AgentInfo): AgentInfo {
  const c: AgentInfo = {
    ...a,
    recent: a.recent.slice(),
    tasks: a.tasks.map((t) => ({ ...t })),
    stats: { ...a.stats },
    activity: a.activity ? { ...a.activity } : undefined,
  };
  if (a.shells) c.shells = a.shells.map((j) => ({ ...j }));
  return c;
}
