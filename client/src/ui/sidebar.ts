// Barra lateral: busca, filtro por conta e a lista de salas -> agentes -> subagentes.
import type { AccountInfo, AgentInfo } from '../../../shared/types';
import { roomTheme } from '../art';
import type { UiComponent, UiContext } from './context';
import { h, iconButton, KeyedList, setAttr, setHidden, setStyleVar, setText, setTitle } from './dom';
import { plural, shortPath } from './format';
import { ICONS } from './icons';
import { groupRooms, type AgentNode, type RoomGroup } from './model';
import { officeIsEmpty } from './overlays';
import { createAgentRow, updateAgentRow } from './rows';
import { createAccountChip, createProgress, updateAccountChip, updateProgress } from './widgets';

interface RoomRefs {
  head: HTMLButtonElement;
  name: HTMLElement;
  count: HTMLElement;
  path: HTMLElement;
  accs: KeyedList<AccountInfo | string>;
  tasks: HTMLElement;
  tasksBar: HTMLElement;
  tasksText: HTMLElement;
  nodes: KeyedList<AgentNode>;
}

interface NodeRefs {
  row: HTMLButtonElement;
  subsWrap: HTMLElement;
  subsCaption: HTMLElement;
  subs: KeyedList<AgentInfo>;
}

export class Sidebar implements UiComponent {
  readonly el: HTMLElement;
  private input: HTMLInputElement;
  private query = '';
  private filters: HTMLElement;
  private filterList: KeyedList<AccountInfo, HTMLButtonElement>;
  private scroller: HTMLElement;
  private rooms: KeyedList<RoomGroup>;
  private roomRefs = new WeakMap<HTMLElement, RoomRefs>();
  private nodeRefs = new WeakMap<HTMLElement, NodeRefs>();
  private empty: HTMLElement;
  private emptyText: HTMLElement;
  private clearBtn: HTMLButtonElement;
  private lastSelKey = '';

  constructor(private ctx: UiContext) {
    this.input = h('input', {
      class: 'ui-search__input',
      type: 'search',
      attrs: { placeholder: 'Buscar agente, projeto ou conta', 'aria-label': 'Buscar agente, projeto ou conta', autocomplete: 'off', spellcheck: 'false' },
    });
    this.input.addEventListener('input', () => {
      this.query = this.input.value;
      this.ctx.invalidate();
    });
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        if (this.input.value) {
          this.input.value = '';
          this.query = '';
          this.ctx.invalidate();
        } else {
          this.input.blur();
        }
      }
    });
    const searchIcon = h('span', { class: 'ui-search__icon', attrs: { 'aria-hidden': 'true' } });
    searchIcon.innerHTML = ICONS.search;
    const search = h('label', { class: 'ui-search' }, searchIcon, this.input, h('kbd', { class: 'ui-kbd', text: '/', title: 'Atalho: /' }));

    this.filters = h('div', { class: 'ui-acc-filters', role: 'group', attrs: { 'aria-label': 'Filtrar por conta' } });
    this.filterList = new KeyedList<AccountInfo, HTMLButtonElement>(this.filters, {
      animate: false,
      key: (a) => a.id,
      create: (a) => {
        const chip = createAccountChip('sm');
        const b = h('button', { class: 'ui-acc-filter', type: 'button' }, chip, h('span', { class: 'ui-acc-filter__name' }));
        b.addEventListener('click', () => this.toggleAccount(a.id));
        return b;
      },
      update: (b, a) => {
        const hidden = this.ctx.prefs.hiddenAccounts.includes(a.id);
        updateAccountChip(b.firstElementChild as HTMLElement, a);
        setText(b.lastElementChild!, a.name);
        setAttr(b, 'aria-pressed', String(!hidden));
        setTitle(b, hidden ? `Mostrar a ${a.name} na lista, no feed e nos avisos` : `Ocultar a ${a.name} na lista, no feed e nos avisos (o escritório continua mostrando todos)`);
        b.classList.toggle('is-off', hidden);
      },
    });

    this.scroller = h('div', { class: 'ui-side__scroll' });
    const list = h('div', { class: 'ui-rooms', role: 'list', attrs: { 'aria-label': 'Salas' } });
    this.scroller.append(list);
    this.rooms = new KeyedList<RoomGroup>(list, {
      key: (g) => g.room.id,
      create: (g) => this.createRoom(g),
      update: (el, g) => this.updateRoom(el, g),
    });

    this.emptyText = h('p');
    this.clearBtn = h('button', {
      class: 'ui-link-btn',
      type: 'button',
      text: 'Limpar filtros',
      on: {
        click: () => {
          this.input.value = '';
          this.query = '';
          this.ctx.updatePrefs({ hiddenAccounts: [] });
        },
      },
    });
    this.empty = h('div', { class: 'ui-side__empty', hidden: true }, this.emptyText, this.clearBtn);
    this.scroller.append(this.empty);

    const close = iconButton(ICONS.close, 'Fechar painel lateral', () => ctx.togglePanel('sidebar', false), 'ui-side__close');
    this.el = h(
      'aside',
      { class: 'ui-panel ui-sidebar', attrs: { 'aria-label': 'Salas e agentes', id: 'ui-sidebar' } },
      h('div', { class: 'ui-side__head' }, h('div', { class: 'ui-side__title' }, h('h2', { text: 'Escritório' }), close), search, this.filters),
      this.scroller,
    );
  }

  focusSearch(): void {
    this.input.focus();
    this.input.select();
  }

  render(): void {
    const snap = this.ctx.store.snapshot;
    const accounts = snap?.accounts ?? [];
    const hidden = new Set(this.ctx.prefs.hiddenAccounts);
    this.filterList.sync(accounts.length > 1 ? accounts : []);
    setHidden(this.filters, accounts.length <= 1);

    const groups = groupRooms(snap, { query: this.query, hiddenAccounts: hidden });
    this.rooms.sync(groups);

    const filtering = this.query.trim().length > 0 || hidden.size > 0;
    const total = snap?.agents.length ?? 0;
    // Escritório vazio sem filtro: o cartão central já explica; a lista não repete o aviso.
    const showEmpty = groups.length === 0 && (filtering || !officeIsEmpty(this.ctx));
    setHidden(this.empty, !showEmpty);
    if (showEmpty) {
      setText(
        this.emptyText,
        filtering && total > 0
          ? this.query.trim()
            ? `Nenhum agente encontrado para “${this.query.trim()}”.`
            : 'Nenhum agente nas contas selecionadas.'
          : 'Nenhuma sessão aberta no momento.',
      );
      setHidden(this.clearBtn, !(filtering && total > 0));
    }

    // Ao mudar a seleção (ex.: clique no canvas), traz o item para a área visível.
    const sel = this.ctx.selection();
    const selKey = sel ? `${sel.type}:${sel.id}` : '';
    if (selKey !== this.lastSelKey) {
      this.lastSelKey = selKey;
      if (sel) {
        const target =
          sel.type === 'agent'
            ? this.el.querySelector<HTMLElement>(`.ui-agent[data-id="${CSS.escape(sel.id)}"]`)
            : this.el.querySelector<HTMLElement>(`.ui-room[data-key="${CSS.escape(sel.id)}"] .ui-room__head`);
        target?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    }
  }

  private toggleAccount(id: string): void {
    const set = new Set(this.ctx.prefs.hiddenAccounts);
    if (set.has(id)) set.delete(id);
    else set.add(id);
    this.ctx.updatePrefs({ hiddenAccounts: [...set] });
  }

  // ---------------------------------------------------------------- salas

  private createRoom(g: RoomGroup): HTMLElement {
    const name = h('span', { class: 'ui-room__name' });
    const count = h('span', { class: 'ui-room__count' });
    const accsEl = h('span', { class: 'ui-room__accs' });
    const path = h('span', { class: 'ui-room__path' });
    const tasksBar = createProgress('Progresso das tarefas da sala');
    const tasksText = h('span', { class: 'ui-room__tasks-text' });
    const tasks = h('span', { class: 'ui-room__tasks' }, tasksBar, tasksText);
    const swatch = h('span', { class: 'ui-room__swatch', attrs: { 'aria-hidden': 'true' } });
    const head = h(
      'button',
      { class: 'ui-room__head', type: 'button' },
      swatch,
      h('span', { class: 'ui-room__line' }, name, count, accsEl),
      path,
      tasks,
    );
    head.addEventListener('click', () => this.ctx.select({ type: 'room', id: g.room.id }, { focus: true }));
    try {
      setStyleVar(head, '--room', roomTheme(g.room.seed).accent);
    } catch {
      // Sem tema: mantém a cor padrão do CSS.
    }
    const agentsEl = h('ul', { class: 'ui-nodes' });
    const section = h('section', { class: 'ui-room', role: 'listitem' }, head, agentsEl);
    const accs = new KeyedList<AccountInfo | string>(accsEl, {
      animate: false,
      key: (a) => (typeof a === 'string' ? a : a.id),
      create: () => createAccountChip('sm'),
      update: (chip, a) => (typeof a === 'string' ? updateAccountChip(chip, undefined, a) : updateAccountChip(chip, a)),
    });
    const nodes = new KeyedList<AgentNode>(agentsEl, {
      key: (n) => n.agent.id,
      create: (n) => this.createNode(n),
      update: (el, n) => this.updateNode(el, n),
    });
    this.roomRefs.set(section, { head, name, count, path, accs, tasks, tasksBar, tasksText, nodes });
    return section;
  }

  private updateRoom(section: HTMLElement, g: RoomGroup): void {
    const r = this.roomRefs.get(section)!;
    const sel = this.ctx.selection();
    setText(r.name, g.room.name);
    const present = g.agents.filter((a) => a.status !== 'offline').length;
    setText(r.count, String(present));
    setTitle(r.count, plural(present, 'agente', 'agentes'));
    setText(r.path, shortPath(g.room.path));
    setTitle(r.head, `${g.room.path}\nClique para ver a sala`);
    setAttr(r.head, 'aria-label', `Sala ${g.room.name}, ${plural(present, 'agente', 'agentes')}`);
    r.accs.sync(g.accounts.map((id) => this.ctx.account(id) ?? id));
    const selected = sel?.type === 'room' && sel.id === g.room.id;
    r.head.classList.toggle('is-selected', selected);
    setAttr(r.head, 'aria-current', selected ? 'true' : null);
    section.classList.toggle('is-empty', present === 0);

    const t = g.tasks;
    setHidden(r.tasks, t.total === 0);
    if (t.total > 0) {
      updateProgress(r.tasksBar, t.completed, t.total, t.inProgress);
      setText(r.tasksText, `${t.completed}/${t.total} tarefas`);
    }
    r.nodes.sync(g.nodes);
  }

  // ---------------------------------------------------------------- agentes

  private createNode(n: AgentNode): HTMLElement {
    const row = createAgentRow(n.agent, (id) => this.pick(id));
    const subsCaption = h('span', { class: 'ui-subs__caption' });
    const subsList = h('ul', { class: 'ui-subs__list' });
    const subsWrap = h('div', { class: 'ui-subs', hidden: true }, subsCaption, subsList);
    const li = h('li', { class: 'ui-node' }, row, subsWrap);
    const subs = new KeyedList<AgentInfo>(subsList, {
      key: (a) => a.id,
      create: (a) => h('li', { class: 'ui-subs__item' }, createAgentRow(a, (id) => this.pick(id), 'sm')),
      update: (li2, a) => this.updateRow(li2.firstElementChild as HTMLElement, a),
    });
    this.nodeRefs.set(li, { row, subsWrap, subsCaption, subs });
    return li;
  }

  private updateNode(li: HTMLElement, n: AgentNode): void {
    const r = this.nodeRefs.get(li)!;
    this.updateRow(r.row, n.agent);
    const has = n.subTotal > 0;
    setHidden(r.subsWrap, !has);
    if (has) {
      const shown = n.subs.length;
      setText(r.subsCaption, shown === n.subTotal ? plural(n.subTotal, 'subagente', 'subagentes') : `${shown} de ${plural(n.subTotal, 'subagente', 'subagentes')}`);
    }
    r.subs.sync(n.subs);
  }

  private updateRow(row: HTMLElement, a: AgentInfo): void {
    const sel = this.ctx.selection();
    updateAgentRow(row, a, this.ctx.account(a.account), sel?.type === 'agent' && sel.id === a.id, this.ctx.now(), this.ctx.store.snapshot?.agents);
  }

  private pick(id: string): void {
    this.ctx.select({ type: 'agent', id }, { focus: true });
    if (this.ctx.isNarrow()) this.ctx.togglePanel('sidebar', false);
  }
}
