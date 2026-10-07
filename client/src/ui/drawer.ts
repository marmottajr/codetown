// Gaveta de detalhes (direita): agente ou sala selecionados.
import type { Activity, AgentInfo, FeedItem, RoomInfo, ShellJob, TaskItem } from '../../../shared/types';
import { roomTheme } from '../art';
import { createAvatarPlaceholder, updateAvatar } from './avatar';
import type { UiComponent, UiContext } from './context';
import { copyText, h, iconButton, KeyedList, setAttr, setHidden, setStyleVar, setText, setTitle, setVariant } from './dom';
import {
  formatClock,
  formatDateTime,
  formatDuration,
  formatElapsed,
  formatInt,
  formatTokens,
  formatUSD,
  permissionLabel,
  plural,
  prettyModel,
  relativeTime,
  shortPath,
} from './format';
import { ICONS } from './icons';
import {
  accountsOf,
  activityFallback,
  aggregateTasks,
  mergeHistory,
  roleLabel,
  shellBoxText,
  shellDoneKind,
  shellKindLabel,
  shellStage,
  shellWaitIn,
  sortByUrgency,
  statusLabel,
  taskProgress,
  visibleShells,
} from './model';
import { createAgentRow, updateAgentRow } from './rows';
import { createAccountChip, createProgress, createStatusDot, updateAccountChip, updateProgress, updateStatusDot } from './widgets';

const TIMELINE_LIMIT = 80;
const ROOM_FEED_LIMIT = 15;

// ---------------------------------------------------------------- peças

function section(title: string, ...children: (Node | null)[]): { el: HTMLElement; title: HTMLElement; extra: HTMLElement } {
  const t = h('h3', { class: 'ui-sec__title', text: title });
  const extra = h('span', { class: 'ui-sec__extra' });
  const el = h('section', { class: 'ui-sec' }, h('div', { class: 'ui-sec__head' }, t, extra), ...children.filter((c): c is Node => !!c));
  return { el, title: t, extra };
}

function copyButton(getText: () => string, label: string): HTMLButtonElement {
  const b = iconButton(ICONS.copy, label, async () => {
    const ok = await copyText(getText());
    b.classList.toggle('is-done', ok);
    b.innerHTML = ok ? ICONS.check : ICONS.copy;
    setTitle(b, ok ? 'Copiado!' : 'Não foi possível copiar');
    setTimeout(() => {
      b.classList.remove('is-done');
      b.innerHTML = ICONS.copy;
      setTitle(b, label);
    }, 1400);
  }, 'ui-icon-btn--sm');
  return b;
}

const TASK_MARK: Record<TaskItem['status'], string> = { completed: '✓', in_progress: '◐', pending: '○' };
const TASK_STATE: Record<TaskItem['status'], string> = { completed: 'concluída', in_progress: 'em andamento', pending: 'pendente' };

function createTaskItem(): HTMLElement {
  return h('li', { class: 'ui-task' }, h('span', { class: 'ui-task__mark', attrs: { 'aria-hidden': 'true' } }), h('span', { class: 'ui-task__text' }), h('span', { class: 'ui-task__owner' }));
}

function updateTaskItem(li: HTMLElement, t: TaskItem, owner?: string): void {
  const [mark, text, ownerEl] = li.children as unknown as HTMLElement[];
  setText(mark, TASK_MARK[t.status]);
  setText(text, t.status === 'in_progress' && t.activeForm ? t.activeForm : t.title);
  setText(ownerEl, owner ?? '');
  setHidden(ownerEl, !owner);
  setVariant(li, 'is-', t.status);
  setAttr(li, 'aria-label', `${t.title}: ${TASK_STATE[t.status]}`);
}

function createTimelineItem(): HTMLElement {
  return h(
    'li',
    { class: 'ui-tl' },
    h('span', { class: 'ui-tl__icon', attrs: { 'aria-hidden': 'true' } }),
    h('span', { class: 'ui-tl__text' }),
    h('time', { class: 'ui-tl__time' }),
  );
}

function updateTimelineItem(li: HTMLElement, a: Activity, now: number, who?: string): void {
  const [icon, text, time] = li.children as unknown as HTMLElement[];
  setText(icon, a.icon);
  setText(text, who ? `${who}: ${a.text}` : a.text);
  setText(time, relativeTime(a.at, now));
  setAttr(time, 'datetime', new Date(a.at).toISOString());
  setTitle(li, `${formatClock(a.at)} · ${a.text}${a.detail ? `\n${a.detail}` : ''}`);
  li.classList.toggle('is-error', !!a.error);
  const done = shellDoneKind(a);
  li.classList.toggle('is-shell-ok', done === 'ok');
  li.classList.toggle('is-shell-fail', done === 'fail');
}

// ---------------------------------------------------------------- shells rodando

interface ShellRefs {
  icon: HTMLElement;
  label: HTMLElement;
  time: HTMLElement;
  badge: HTMLElement;
  since: HTMLElement;
  details: HTMLDetailsElement;
  command: HTMLElement;
}

const shellRefs = new WeakMap<HTMLElement, ShellRefs>();

const SHELL_KIND_VARIANT = (j: ShellJob): string => (j.kind === 'monitor' ? 'monitor' : j.background ? 'bg' : 'fg');

function createShellItem(): HTMLElement {
  const icon = h('span', { class: 'ui-shell__icon', attrs: { 'aria-hidden': 'true' } });
  const label = h('span', { class: 'ui-shell__label' });
  const time = h('time', { class: 'ui-shell__time' });
  const badge = h('span', { class: 'ui-shell__badge' });
  const since = h('span', { class: 'ui-shell__since' });
  const command = h('pre', { class: 'ui-mono' });
  const details = h(
    'details',
    { class: 'ui-shell__cmd' },
    h('summary', { text: 'Comando' }),
    h('div', { class: 'ui-shell__cmd-body' }, command, copyButton(() => command.textContent ?? '', 'Copiar comando')),
  );
  const li = h('li', { class: 'ui-shell' }, h('div', { class: 'ui-shell__head' }, icon, label, time), h('div', { class: 'ui-shell__meta' }, badge, since), details);
  shellRefs.set(li, { icon, label, time, badge, since, details, command });
  return li;
}

function updateShellItem(li: HTMLElement, j: ShellJob, now: number): void {
  const r = shellRefs.get(li)!;
  setText(r.icon, j.kind === 'monitor' ? '📡' : '💻');
  setText(r.label, j.label);
  setTitle(r.label, j.label);
  const elapsed = Math.max(0, now - j.startedAt);
  setText(r.time, formatElapsed(elapsed));
  setAttr(r.time, 'datetime', new Date(j.startedAt).toISOString());
  setTitle(r.time, `Rodando há ${formatDuration(elapsed)} (desde ${formatClock(j.startedAt)})`);
  setText(r.badge, shellKindLabel(j));
  setVariant(r.badge, 'ui-shell__badge--', SHELL_KIND_VARIANT(j));
  setText(r.since, `desde ${formatClock(j.startedAt, false)}`);
  setTitle(r.since, `Iniciado em ${formatDateTime(j.startedAt)} · id ${j.id}`);
  setHidden(r.details, !j.command);
  setText(r.command, j.command ?? '');
  setAttr(li, 'aria-label', `${j.label}, ${shellKindLabel(j)}, rodando há ${formatDuration(elapsed)}`);
}


// ---------------------------------------------------------------- visão do agente

class AgentView {
  readonly el: HTMLElement;
  private id = '';
  private last: AgentInfo | null = null;
  private history: Activity[] = [];
  private historyReq = 0;

  private avatar: HTMLElement;
  private name: HTMLElement;
  private role: HTMLElement;
  private title: HTMLElement;
  private accChip: HTMLElement;
  private accName: HTMLElement;
  private accEmail: HTMLElement;
  private roomBtn: HTMLButtonElement;
  private roomName: HTMLElement;
  private gone: HTMLElement;
  private dot: HTMLElement;
  private statusText: HTMLElement;
  private statusSince: HTMLElement;
  private followBtn: HTMLButtonElement;
  private alert: HTMLElement;
  private alertText: HTMLElement;
  private shellBox: HTMLElement;
  private shellText: HTMLElement;
  private shellMood: HTMLElement;
  private shellNext: HTMLElement;
  private shellsSec: ReturnType<typeof section>;
  private shells: KeyedList<ShellJob>;
  private actIcon: HTMLElement;
  private actText: HTMLElement;
  private actTime: HTMLElement;
  private actDetails: HTMLDetailsElement;
  private actDetail: HTMLElement;
  private tasksSec: ReturnType<typeof section>;
  private tasksBar: HTMLElement;
  private tasks: KeyedList<TaskItem>;
  private teamSec: ReturnType<typeof section>;
  private team: KeyedList<AgentInfo>;
  private teamEmpty: HTMLElement;
  private timeline: KeyedList<Activity>;
  private timelineSec: ReturnType<typeof section>;
  private stats: KvList<StatKey>;
  private sessionValue: HTMLElement;
  private linesPlus: HTMLElement;
  private linesMinus: HTMLElement;

  constructor(private ctx: UiContext) {
    this.avatar = createAvatarPlaceholder('lg');
    this.name = h('h2', { class: 'ui-hero__name' });
    this.role = h('span', { class: 'ui-role' });
    this.title = h('p', { class: 'ui-hero__title' });
    this.accChip = createAccountChip('md');
    this.accName = h('span', { class: 'ui-hero__acc-name' });
    this.accEmail = h('span', { class: 'ui-hero__acc-email' });
    this.roomName = h('span');
    this.roomBtn = h('button', { class: 'ui-room-link', type: 'button', on: { click: () => this.last && ctx.select({ type: 'room', id: this.last.roomId }, { focus: true }) } }, this.roomName);
    const heroText = h(
      'div',
      { class: 'ui-hero__text' },
      h('div', { class: 'ui-hero__line' }, this.name, this.role),
      h('div', { class: 'ui-hero__acc' }, this.accChip, this.accName, this.accEmail),
      h('div', { class: 'ui-hero__where' }, h('span', { class: 'ui-muted', text: 'Sala' }), this.roomBtn),
    );
    this.gone = h('p', { class: 'ui-gone', text: 'Este agente já saiu do escritório.', hidden: true });

    this.dot = createStatusDot();
    this.statusText = h('span', { class: 'ui-status__text' });
    this.statusSince = h('span', { class: 'ui-status__since' });
    this.followBtn = h('button', { class: 'ui-btn', type: 'button', attrs: { 'aria-pressed': 'false' }, title: 'Câmera acompanha o agente (F)', on: { click: () => this.toggleFollow() } });
    this.followBtn.innerHTML = ICONS.follow;
    this.followBtn.append(h('span', { text: 'Seguir' }));
    const centerBtn = h('button', { class: 'ui-btn', type: 'button', title: 'Levar a câmera até o agente', on: { click: () => ctx.focusSelection() } });
    centerBtn.innerHTML = ICONS.center;
    centerBtn.append(h('span', { text: 'Centralizar' }));
    const statusRow = h(
      'div',
      { class: 'ui-status' },
      h('span', { class: 'ui-status__label' }, this.dot, this.statusText, this.statusSince),
      h('span', { class: 'ui-status__actions' }, this.followBtn, centerBtn),
    );

    this.alertText = h('p', { class: 'ui-alert__text' });
    const alertIcon = h('span', { class: 'ui-alert__icon', attrs: { 'aria-hidden': 'true' } });
    alertIcon.innerHTML = ICONS.hand;
    this.alert = h(
      'div',
      { class: 'ui-alert', role: 'alert', hidden: true },
      alertIcon,
      h('div', {}, h('strong', { class: 'ui-alert__title', text: 'Precisa de você' }), this.alertText),
    );

    // Esperando o shell: caixa de status (com a fase da espera no escritório) e a lista de comandos rodando.
    this.shellText = h('p', { class: 'ui-alert__text' });
    this.shellMood = h('span', { class: 'ui-shell-mood__text' });
    this.shellNext = h('span', { class: 'ui-shell-mood__next' });
    const shellIcon = h('span', { class: 'ui-alert__icon ui-hourglass', attrs: { 'aria-hidden': 'true' } });
    shellIcon.innerHTML = ICONS.hourglass;
    this.shellBox = h(
      'div',
      { class: 'ui-alert ui-alert--shell', hidden: true },
      shellIcon,
      h('div', {}, h('strong', { class: 'ui-alert__title', text: 'Esperando o shell' }), this.shellText, h('p', { class: 'ui-shell-mood' }, this.shellMood, this.shellNext)),
    );
    const shellList = h('ul', { class: 'ui-shells' });
    this.shellsSec = section('Shells rodando', shellList);
    this.shells = new KeyedList<ShellJob>(shellList, { key: (j) => j.id, create: createShellItem, update: (li, j) => updateShellItem(li, j, ctx.now()) });

    this.actIcon = h('span', { class: 'ui-now__icon', attrs: { 'aria-hidden': 'true' } });
    this.actText = h('span', { class: 'ui-now__text' });
    this.actTime = h('span', { class: 'ui-now__time' });
    this.actDetail = h('pre', { class: 'ui-mono' });
    this.actDetails = h('details', { class: 'ui-now__details' }, h('summary', { text: 'Detalhes' }), this.actDetail);
    const nowSec = section('Agora', h('div', { class: 'ui-now' }, this.actIcon, h('div', { class: 'ui-now__body' }, this.actText, this.actTime)), this.actDetails);

    this.tasksBar = createProgress('Progresso das tarefas');
    const tasksList = h('ul', { class: 'ui-tasks' });
    this.tasksSec = section('Tarefas', this.tasksBar, tasksList);
    this.tasks = new KeyedList<TaskItem>(tasksList, { key: (t) => t.id, create: createTaskItem, update: (li, t) => updateTaskItem(li, t) });

    const teamList = h('div', { class: 'ui-team' });
    this.teamEmpty = h('p', { class: 'ui-muted ui-small', text: 'Nenhum subagente no momento.' });
    this.teamSec = section('Subagentes', teamList, this.teamEmpty);
    this.team = new KeyedList<AgentInfo>(teamList, {
      key: (a) => a.id,
      create: (a) => createAgentRow(a, (id) => ctx.select({ type: 'agent', id }, { focus: true }), 'sm'),
      update: (row, a) => updateAgentRow(row, a, ctx.account(a.account), false, ctx.now(), ctx.store.snapshot?.agents),
    });

    const tl = h('ol', { class: 'ui-timeline' });
    this.timelineSec = section('Linha do tempo', tl);
    this.timeline = new KeyedList<Activity>(tl, { key: (a) => a.id, create: createTimelineItem, update: (li, a) => updateTimelineItem(li, a, ctx.now()) });

    this.sessionValue = h('span', { class: 'ui-mono-inline' });
    this.linesPlus = h('span', { class: 'ui-plus' });
    this.linesMinus = h('span', { class: 'ui-minus' });
    this.stats = new KvList<StatKey>([
      ['tools', 'Chamadas de ferramenta'],
      ['tokensIn', 'Tokens de entrada'],
      ['tokensOut', 'Tokens de saída'],
      ['cost', 'Custo estimado'],
      ['lines', 'Linhas', h('span', { class: 'ui-lines' }, this.linesPlus, this.linesMinus)],
      ['subs', 'Subagentes disparados'],
      ['model', 'Modelo'],
      ['branch', 'Branch'],
      ['perm', 'Permissões'],
      ['session', 'Sessão', h('span', { class: 'ui-copy-row' }, this.sessionValue, copyButton(() => this.last?.sessionId ?? '', 'Copiar id da sessão'))],
      ['start', 'Início'],
      ['duration', 'Duração'],
      ['bg', 'Execução'],
    ]);
    const statsSec = section('Estatísticas', this.stats.el);

    this.el = h(
      'div',
      { class: 'ui-drawer__view ui-agent-view' },
      h('div', { class: 'ui-hero' }, this.avatar, heroText),
      this.title,
      this.gone,
      statusRow,
      this.alert,
      this.shellBox,
      this.shellsSec.el,
      nowSec.el,
      this.tasksSec.el,
      this.teamSec.el,
      this.timelineSec.el,
      statsSec.el,
    );
  }

  get agentId(): string {
    return this.id;
  }

  open(id: string): void {
    if (this.id === id) return;
    this.id = id;
    this.last = null;
    this.history = [];
    this.timeline.clear();
    this.tasks.clear();
    this.team.clear();
    this.shells.clear();
    this.actDetails.open = false;
    const req = ++this.historyReq;
    this.ctx.store
      .agentHistory(id)
      .then((hist) => {
        if (req !== this.historyReq) return;
        this.history = mergeHistory(hist, this.history);
        this.ctx.invalidate();
      })
      .catch(() => {
        // Sem histórico longo: a linha do tempo usa as atividades recentes do snapshot.
      });
  }

  toggleFollow(): void {
    const follow = !this.ctx.world.getOptions().followSelected;
    this.ctx.world.setOptions({ followSelected: follow });
    // Foca de novo com a opção nova: ligar começa a seguir; desligar mantém o agente no centro, parado.
    if (this.id) this.ctx.focusSelection();
    this.ctx.invalidate();
  }

  render(): void {
    const live = this.ctx.agent(this.id);
    if (live) this.last = live;
    const a = this.last;
    if (!a) return;
    const now = this.ctx.now();
    const account = this.ctx.account(a.account);
    const room = this.ctx.store.room(a.roomId);

    updateAvatar(this.avatar, a, 'lg');
    setStyleVar(this.avatar, '--acc', account?.color ?? '#8b98b3');
    setText(this.name, a.name);
    setText(this.role, roleLabel(a));
    setVariant(this.role, 'ui-role--', a.kind);
    setText(this.title, a.title ?? '');
    setHidden(this.title, !a.title);
    setTitle(this.title, a.title ?? '');
    updateAccountChip(this.accChip, account, a.account);
    setText(this.accName, account?.name ?? a.account);
    setText(this.accEmail, account?.email ?? '');
    setHidden(this.accEmail, !account?.email);
    setText(this.roomName, room?.name ?? a.roomId);
    setTitle(this.roomBtn, room ? `${room.path}\nClique para ver a sala` : '');
    setHidden(this.gone, !!live);
    this.el.classList.toggle('is-gone', !live);

    // Status (quem está parado num comando longo aparece como "Esperando o shell", como no escritório).
    const wait = live ? shellWaitIn(a, this.ctx.store.snapshot?.agents ?? [], now) : null;
    const status = wait ? 'shell' : a.status;
    updateStatusDot(this.dot, status);
    setText(this.statusText, statusLabel(status));
    // Parado num comando longo: o "desde" é o início do comando (o status do servidor continua 'working').
    const since = wait?.foreground ? wait.since : a.statusSince;
    setText(this.statusSince, relativeTime(since, now));
    setTitle(this.statusSince, `Desde ${formatClock(since)}`);
    const following = this.ctx.world.getOptions().followSelected;
    setAttr(this.followBtn, 'aria-pressed', String(following));
    this.followBtn.classList.toggle('is-on', following);

    // Alerta.
    const waiting = a.status === 'waiting' && !!live;
    setHidden(this.alert, !waiting);
    if (waiting) {
      setText(
        this.alertText,
        `Vá ao terminal da ${account?.name ?? a.account} em ${room?.name ?? 'seu projeto'} para responder${a.waitingFor ? `: ${a.waitingFor}` : '.'}`,
      );
    }

    // Esperando o shell.
    setHidden(this.shellBox, !wait);
    if (wait) {
      setText(this.shellText, shellBoxText(wait));
      const stage = shellStage(now - wait.since);
      setText(this.shellMood, `${stage.emoji} ${stage.text}`);
      setText(this.shellNext, stage.nextIn !== null ? `Próxima fase em ${formatDuration(Math.max(1_000, stage.nextIn))}` : '');
      setHidden(this.shellNext, stage.nextIn === null);
      setTitle(this.shellNext, 'Quanto falta para o personagem mudar o que faz enquanto espera (veja a Ajuda)');
    }
    // Sem shells próprios, mostra os que ele espera de um subagente.
    const own = live ? visibleShells(a, now) : [];
    const jobs = own.length || !wait ? own : wait.jobs;
    setHidden(this.shellsSec.el, jobs.length === 0);
    setText(this.shellsSec.extra, jobs.length > 1 ? String(jobs.length) : '');
    this.shells.sync(jobs);

    // Atividade atual.
    const act = a.activity;
    setText(this.actIcon, act?.icon ?? '·');
    setText(this.actText, act?.text ?? activityFallback(a));
    // A duração só entra quando o texto ainda não a traz ("Concluiu em 33s" já diz quanto levou).
    const showDuration = !!act?.durationMs && act.kind !== 'done' && !/\d\s?(?:ms|s|min|h)\b/.test(act.text);
    setText(this.actTime, act ? `${relativeTime(act.at, now)}${showDuration ? ` · levou ${formatDuration(act.durationMs!)}` : ''}` : '');
    this.actText.classList.toggle('is-error', !!act?.error);
    const detail = act?.detail ?? '';
    setHidden(this.actDetails, !detail);
    setText(this.actDetail, detail);

    // Tarefas.
    const tp = taskProgress(a.tasks);
    setHidden(this.tasksSec.el, a.tasks.length === 0);
    updateProgress(this.tasksBar, tp.completed, tp.total, tp.inProgress);
    setText(this.tasksSec.extra, `${tp.completed}/${tp.total}`);
    this.tasks.sync(a.tasks);

    // Equipe: subagentes (principal) ou responsável (sub).
    if (a.kind === 'main') {
      const subs = sortByUrgency((this.ctx.store.snapshot?.agents ?? []).filter((s) => s.parentId === a.id));
      setText(this.teamSec.title, 'Subagentes');
      setText(this.teamSec.extra, subs.length ? String(subs.length) : '');
      setText(this.teamEmpty, a.stats.subagents ? `Nenhum ativo agora (${plural(a.stats.subagents, 'disparado', 'disparados')} nesta sessão).` : 'Nenhum subagente disparado ainda.');
      setHidden(this.teamEmpty, subs.length > 0);
      this.team.sync(subs);
    } else {
      const parent = a.parentId ? this.ctx.agent(a.parentId) : undefined;
      setText(this.teamSec.title, 'Responsável');
      setText(this.teamSec.extra, '');
      setText(this.teamEmpty, 'O agente principal já não está no escritório.');
      setHidden(this.teamEmpty, !!parent);
      this.team.sync(parent ? [parent] : []);
    }

    // Linha do tempo (mais recente primeiro).
    this.history = mergeHistory(this.history, a.recent);
    const items = this.history.slice(-TIMELINE_LIMIT).reverse();
    this.timeline.sync(items);
    setText(this.timelineSec.extra, this.history.length ? String(this.history.length) : '');

    this.renderStats(a, now);
  }

  private renderStats(a: AgentInfo, now: number): void {
    const s = a.stats;
    const st = this.stats;
    st.set('tools', formatInt(s.toolCalls));
    st.set('tokensIn', formatTokens(s.tokensIn));
    st.set('tokensOut', formatTokens(s.tokensOut));
    st.set('cost', s.costUSD !== undefined ? formatUSD(s.costUSD) : null);
    const hasLines = s.linesAdded !== undefined || s.linesRemoved !== undefined;
    st.show('lines', hasLines);
    setText(this.linesPlus, `+${formatInt(s.linesAdded ?? 0)}`);
    setText(this.linesMinus, `−${formatInt(s.linesRemoved ?? 0)}`);
    st.set('subs', a.kind === 'main' ? formatInt(s.subagents) : null);
    st.set('model', prettyModel(a.model));
    st.set('branch', a.gitBranch ?? null);
    st.set('perm', a.kind === 'main' ? permissionLabel(a.permissionMode) : null);
    setText(this.sessionValue, a.sessionId);
    setTitle(this.sessionValue, a.sessionId);
    st.set('start', formatDateTime(a.startedAt));
    st.set('duration', formatDuration(now - a.startedAt));
    st.set('bg', a.background ? 'Em segundo plano' : null);
  }
}

type StatKey = 'tools' | 'tokensIn' | 'tokensOut' | 'cost' | 'lines' | 'subs' | 'model' | 'branch' | 'perm' | 'session' | 'start' | 'duration' | 'bg';

/** Lista chave/valor de linhas fixas: cada linha é criada uma vez e só tem o texto/visibilidade atualizados. */
class KvList<K extends string> {
  readonly el: HTMLElement;
  private rows = new Map<K, { dt: HTMLElement; dd: HTMLElement }>();

  constructor(defs: readonly [K, string, Node?][]) {
    this.el = h('dl', { class: 'ui-kv ui-stats' });
    for (const [key, label, content] of defs) {
      const dt = h('dt', { text: label });
      const dd = h('dd');
      if (content) dd.append(content);
      this.rows.set(key, { dt, dd });
      this.el.append(dt, dd);
    }
  }

  /** Define o texto da linha; `null` oculta a linha. */
  set(key: K, value: string | null): void {
    const r = this.rows.get(key)!;
    this.show(key, value !== null);
    if (value !== null) setText(r.dd, value);
  }

  show(key: K, visible: boolean): void {
    const r = this.rows.get(key)!;
    setHidden(r.dt, !visible);
    setHidden(r.dd, !visible);
  }
}

// ---------------------------------------------------------------- visão da sala

class RoomView {
  readonly el: HTMLElement;
  private id = '';
  private last: RoomInfo | null = null;
  private swatch: HTMLElement;
  private name: HTMLElement;
  private path: HTMLElement;
  private gone: HTMLElement;
  private accs: KeyedList<string>;
  private agents: KeyedList<AgentInfo>;
  private agentsSec: ReturnType<typeof section>;
  private agentsEmpty: HTMLElement;
  private tasksSec: ReturnType<typeof section>;
  private tasksBar: HTMLElement;
  private tasks: KeyedList<{ task: TaskItem; owner: string; key: string }>;
  private feed: KeyedList<FeedItem>;
  private feedSec: ReturnType<typeof section>;

  constructor(private ctx: UiContext) {
    this.swatch = h('span', { class: 'ui-room-hero__swatch', attrs: { 'aria-hidden': 'true' } });
    this.name = h('h2', { class: 'ui-hero__name' });
    this.path = h('span', { class: 'ui-room-hero__path' });
    const centerBtn = h('button', { class: 'ui-btn', type: 'button', title: 'Levar a câmera até a sala', on: { click: () => ctx.focusSelection() } });
    centerBtn.innerHTML = ICONS.center;
    centerBtn.append(h('span', { text: 'Centralizar' }));
    this.gone = h('p', { class: 'ui-gone', text: 'Esta sala foi fechada: todos os agentes saíram.', hidden: true });

    const accsEl = h('div', { class: 'ui-acc-list' });
    this.accs = new KeyedList<string>(accsEl, {
      animate: false,
      key: (id) => id,
      create: () => h('span', { class: 'ui-acc-item' }, createAccountChip('sm'), h('span')),
      update: (el, id) => {
        const acc = ctx.account(id);
        updateAccountChip(el.firstElementChild as HTMLElement, acc, id);
        setText(el.lastElementChild!, acc ? `${acc.name}${acc.email ? ` · ${acc.email}` : ''}` : id);
      },
    });

    const agentsList = h('div', { class: 'ui-team' });
    this.agentsEmpty = h('p', { class: 'ui-muted ui-small', text: 'Ninguém na sala agora.' });
    this.agentsSec = section('Agentes', agentsList, this.agentsEmpty);
    this.agents = new KeyedList<AgentInfo>(agentsList, {
      key: (a) => a.id,
      create: (a) => createAgentRow(a, (id) => ctx.select({ type: 'agent', id }, { focus: true }), 'sm'),
      update: (row, a) => updateAgentRow(row, a, ctx.account(a.account), false, ctx.now(), ctx.store.snapshot?.agents),
    });

    this.tasksBar = createProgress('Progresso das tarefas da sala');
    const tasksList = h('ul', { class: 'ui-tasks' });
    this.tasksSec = section('Tarefas', this.tasksBar, tasksList);
    this.tasks = new KeyedList(tasksList, { key: (t) => t.key, create: createTaskItem, update: (li, t) => updateTaskItem(li, t.task, t.owner) });

    const feedList = h('ol', { class: 'ui-timeline' });
    this.feedSec = section('Atividade recente', feedList);
    this.feed = new KeyedList<FeedItem>(feedList, { key: (f) => f.id, create: createTimelineItem, update: (li, f) => updateTimelineItem(li, f.activity, ctx.now(), f.agentName) });

    this.el = h(
      'div',
      { class: 'ui-drawer__view ui-room-view' },
      h(
        'div',
        { class: 'ui-room-hero' },
        this.swatch,
        h('div', { class: 'ui-hero__text' }, this.name, h('span', { class: 'ui-copy-row' }, this.path, copyButton(() => this.last?.path ?? '', 'Copiar caminho'))),
      ),
      this.gone,
      h('div', { class: 'ui-status' }, accsEl, h('span', { class: 'ui-status__actions' }, centerBtn)),
      this.agentsSec.el,
      this.tasksSec.el,
      this.feedSec.el,
    );
  }

  get roomId(): string {
    return this.id;
  }

  open(id: string): void {
    if (this.id === id) return;
    this.id = id;
    this.last = null;
    this.agents.clear();
    this.tasks.clear();
    this.feed.clear();
  }

  render(): void {
    const live = this.ctx.store.room(this.id);
    if (live) this.last = live;
    const r = this.last;
    if (!r) return;
    setText(this.name, r.name);
    setText(this.path, shortPath(r.path));
    setTitle(this.path, r.path);
    try {
      setStyleVar(this.swatch, '--room', roomTheme(r.seed).accent);
    } catch {
      // Sem tema: cor padrão.
    }
    setHidden(this.gone, !!live);

    const snap = this.ctx.store.snapshot;
    const agents = (snap?.agents ?? []).filter((a) => a.roomId === r.id);
    this.accs.sync(accountsOf(agents, snap?.accounts ?? []));
    const ordered = sortByUrgency(agents);
    setText(this.agentsSec.extra, agents.length ? String(agents.length) : '');
    setHidden(this.agentsEmpty, agents.length > 0);
    this.agents.sync(ordered);

    const tp = aggregateTasks(agents);
    setHidden(this.tasksSec.el, tp.total === 0);
    updateProgress(this.tasksBar, tp.completed, tp.total, tp.inProgress);
    setText(this.tasksSec.extra, `${tp.completed}/${tp.total}`);
    this.tasks.sync(agents.flatMap((a) => a.tasks.map((task) => ({ task, owner: a.name, key: `${a.id}#${task.id}` }))));

    const feed = this.ctx.store.feed.filter((f) => f.roomId === r.id).slice(-ROOM_FEED_LIMIT).reverse();
    setHidden(this.feedSec.el, feed.length === 0);
    this.feed.sync(feed);
  }
}

// ---------------------------------------------------------------- gaveta

export class Drawer implements UiComponent {
  readonly el: HTMLElement;
  private body: HTMLElement;
  private agentView: AgentView;
  private roomView: RoomView;
  private mode: 'agent' | 'room' | null = null;
  private heading: HTMLElement;

  constructor(private ctx: UiContext) {
    this.agentView = new AgentView(ctx);
    this.roomView = new RoomView(ctx);
    this.heading = h('span', { class: 'ui-drawer__kind' });
    const close = iconButton(ICONS.close, 'Fechar detalhes (Esc)', () => ctx.select(null));
    this.body = h('div', { class: 'ui-drawer__body' });
    this.el = h(
      'aside',
      { class: 'ui-panel ui-drawer', attrs: { 'aria-label': 'Detalhes', id: 'ui-drawer', 'aria-hidden': 'true' } },
      h('div', { class: 'ui-drawer__bar' }, this.heading, close),
      this.body,
    );
    this.el.inert = true;
  }

  get isOpen(): boolean {
    return this.mode !== null;
  }

  toggleFollow(): void {
    if (this.mode === 'agent') this.agentView.toggleFollow();
  }

  render(): void {
    const sel = this.ctx.selection();
    const mode = sel?.type ?? null;
    if (mode !== this.mode) {
      this.mode = mode;
      this.body.replaceChildren(...(mode === 'agent' ? [this.agentView.el] : mode === 'room' ? [this.roomView.el] : []));
      this.body.scrollTop = 0;
      this.el.classList.toggle('is-open', mode !== null);
      setAttr(this.el, 'aria-hidden', mode ? 'false' : 'true');
      this.el.inert = mode === null;
    }
    if (sel?.type === 'agent') {
      if (this.agentView.agentId !== sel.id) this.body.scrollTop = 0;
      this.agentView.open(sel.id);
      setText(this.heading, this.ctx.agent(sel.id)?.kind === 'sub' ? 'Subagente' : 'Agente');
      this.agentView.render();
    } else if (sel?.type === 'room') {
      if (this.roomView.roomId !== sel.id) this.body.scrollTop = 0;
      this.roomView.open(sel.id);
      setText(this.heading, 'Sala');
      this.roomView.render();
    }
  }
}
