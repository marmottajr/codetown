// Barra superior: marca, conexão, contadores, uso por conta e botões de controle.
import type { UiComponent, UiContext } from './context';
import { h, iconButton, setAttr, setHidden, setText, setTitle, setVariant } from './dom';
import { formatDuration, formatInt } from './format';
import { FALLBACK_MARK, ICONS } from './icons';
import { computeCounters, shellLine, shellWaitIn, shellWaitingAgents, waitingAgents, type Counters } from './model';
import { UsageCards } from './usage';
import { wordmark } from './widgets';

interface CounterRefs {
  el: HTMLElement;
  value: HTMLElement;
  label: HTMLElement;
}

/** Contadores fixos (o de shells é à parte: só aparece quando há shells rodando). */
const COUNTERS: { key: Exclude<keyof Counters, 'shells'>; singular: string; plural: string; hint: string }[] = [
  { key: 'rooms', singular: 'sala', plural: 'salas', hint: 'Salas abertas (uma por projeto)' },
  { key: 'agents', singular: 'agente', plural: 'agentes', hint: 'Agentes no escritório (principais e subagentes)' },
  { key: 'working', singular: 'trabalhando', plural: 'trabalhando', hint: 'Agentes processando um pedido agora' },
  { key: 'subagents', singular: 'subagente', plural: 'subagentes', hint: 'Subagentes em atividade' },
  { key: 'waiting', singular: 'precisa de você', plural: 'precisam de você', hint: 'Agentes esperando sua resposta no terminal' },
];

export class TopBar implements UiComponent {
  readonly el: HTMLElement;
  private pill: HTMLElement;
  private pillText: HTMLElement;
  private demoBadge: HTMLElement;
  private counters = new Map<keyof Counters, CounterRefs>();
  private shellsBtn: HTMLButtonElement;
  /** Próximo agente do botão de shells (cliques seguidos passam por todos, do que espera há mais tempo). */
  private shellCursor = 0;
  private usage: UsageCards;
  private hadOpen = false;
  private sidebarBtn: HTMLButtonElement;
  private feedBtn: HTMLButtonElement;
  readonly settingsBtn: HTMLButtonElement;

  constructor(private ctx: UiContext) {
    // Marca: usa o logo do projeto se existir; senão, o prédio em pixels.
    const mark = h('span', { class: 'ui-brand__mark' });
    const logo = h('img', { attrs: { src: '/assets/brand/logo-mark.png', srcset: '/assets/brand/logo-mark@4x.png 4x', alt: '', width: 32, height: 32, draggable: 'false' } });
    logo.addEventListener('error', () => {
      mark.innerHTML = FALLBACK_MARK;
    });
    mark.append(logo);

    this.pillText = h('span', { class: 'ui-pill__text' });
    this.pill = h('span', { class: 'ui-pill', role: 'status', attrs: { 'aria-live': 'polite' } }, h('span', { class: 'ui-pill__dot' }), this.pillText);
    this.demoBadge = h('span', { class: 'ui-demo-badge', text: 'Demonstração', title: 'Agentes de demonstração ligados (desligue em Configurações)', hidden: true });

    const counterWrap = h('div', { class: 'ui-counters', role: 'group', attrs: { 'aria-label': 'Resumo do escritório' } });
    for (const c of COUNTERS) {
      const value = h('span', { class: 'ui-counter__value', text: '0' });
      const label = h('span', { class: 'ui-counter__label', text: c.plural });
      let el: HTMLElement;
      if (c.key === 'waiting') {
        // Em telas pequenas o rótulo some e fica a mão levantada.
        const icon = h('span', { class: 'ui-counter__icon', attrs: { 'aria-hidden': 'true' } });
        icon.innerHTML = ICONS.hand;
        el = h('button', { class: 'ui-counter ui-counter--waiting', type: 'button', title: `${c.hint}. Clique para ir até o primeiro.`, on: { click: () => this.focusFirstWaiting() } }, icon, value, label);
      } else {
        el = h('div', { class: `ui-counter ui-counter--${c.key}`, title: c.hint }, value, label);
      }
      this.counters.set(c.key, { el, value, label });
      counterWrap.append(el);
    }

    // "⏳ N shells": entre os subagentes e o "precisa de você"; some quando não há shells rodando.
    {
      const icon = h('span', { class: 'ui-counter__icon ui-hourglass', attrs: { 'aria-hidden': 'true' } });
      icon.innerHTML = ICONS.hourglass;
      const value = h('span', { class: 'ui-counter__value', text: '0' });
      const label = h('span', { class: 'ui-counter__label', text: 'shells' });
      this.shellsBtn = h(
        'button',
        { class: 'ui-counter ui-counter--shells', type: 'button', hidden: true, on: { click: () => this.focusNextShell() } },
        icon,
        h('span', { class: 'ui-counter__stack' }, value, label),
      );
      this.counters.set('shells', { el: this.shellsBtn, value, label });
      counterWrap.insertBefore(this.shellsBtn, this.counters.get('waiting')!.el);
    }

    this.usage = new UsageCards(ctx);

    this.sidebarBtn = iconButton(ICONS.sidebar, 'Painel lateral ( [ )', () => ctx.togglePanel('sidebar'), 'ui-btn-sidebar');
    this.feedBtn = iconButton(ICONS.feed, 'Feed de atividade ( ] )', () => ctx.togglePanel('feed'));
    this.settingsBtn = iconButton(ICONS.settings, 'Configurações', () => ctx.toggleSettings());
    this.settingsBtn.setAttribute('aria-haspopup', 'dialog');
    const viewGroup = h(
      'div',
      { class: 'ui-btn-group', role: 'group', attrs: { 'aria-label': 'Câmera' } },
      iconButton(ICONS.overview, 'Visão geral (O)', () => ctx.camera('overview')),
      iconButton(ICONS.zoomOut, 'Afastar (−)', () => ctx.camera('zoomOut')),
      iconButton(ICONS.zoomIn, 'Aproximar (+)', () => ctx.camera('zoomIn')),
    );
    const panelGroup = h(
      'div',
      { class: 'ui-btn-group', role: 'group', attrs: { 'aria-label': 'Painéis' } },
      this.feedBtn,
      this.settingsBtn,
      iconButton(ICONS.help, 'Ajuda (?)', () => ctx.openHelp()),
    );

    this.el = h(
      'header',
      { class: 'ui-topbar', role: 'banner' },
      h(
        'div',
        { class: 'ui-topbar__left' },
        this.sidebarBtn,
        h(
          'div',
          { class: 'ui-brand' },
          mark,
          h('div', { class: 'ui-brand__text' }, wordmark(), h('div', { class: 'ui-topbar__status' }, this.pill, this.demoBadge)),
        ),
      ),
      counterWrap,
      this.usage.el,
      h('div', { class: 'ui-topbar__right' }, viewGroup, panelGroup),
    );
  }

  render(): void {
    const { store } = this.ctx;
    const snap = store.snapshot;

    // Conexão.
    const conn = store.connection;
    if (conn === 'open') this.hadOpen = true;
    const label =
      conn === 'open' ? 'Conectado' : conn === 'mock' ? 'Simulação' : conn === 'closed' ? 'Desconectado' : this.hadOpen ? 'Reconectando…' : 'Conectando…';
    setText(this.pillText, label);
    setVariant(this.pill, 'is-', conn);
    setTitle(
      this.pill,
      conn === 'mock'
        ? 'Dados simulados no navegador (?mock=1)'
        : conn === 'open'
          ? 'Recebendo eventos do servidor em tempo real'
          : 'Sem conexão com o servidor do CodeTown',
    );
    setHidden(this.demoBadge, !(conn === 'open' && snap?.meta.demo));

    // Contadores.
    const now = this.ctx.now();
    const c = computeCounters(snap, now);
    for (const def of COUNTERS) {
      const refs = this.counters.get(def.key)!;
      const n = c[def.key];
      setText(refs.value, formatInt(n));
      setText(refs.label, n === 1 ? def.singular : def.plural);
      setAttr(refs.el, 'aria-label', `${formatInt(n)} ${n === 1 ? def.singular : def.plural}`);
    }
    const waiting = this.counters.get('waiting')!.el as HTMLButtonElement;
    waiting.classList.toggle('is-active', c.waiting > 0);
    waiting.disabled = c.waiting === 0;
    this.renderShells(c.shells, now);

    this.usage.render();

    this.sidebarBtn.setAttribute('aria-pressed', String(this.ctx.isPanelOpen('sidebar')));
    this.feedBtn.setAttribute('aria-pressed', String(this.ctx.isPanelOpen('feed')));
  }

  private renderShells(n: number, now: number): void {
    const refs = this.counters.get('shells')!;
    setHidden(this.shellsBtn, n === 0);
    if (n === 0) {
      this.shellCursor = 0;
      return;
    }
    const all = this.ctx.store.snapshot?.agents ?? [];
    const agents = shellWaitingAgents(all, now);
    setText(refs.value, formatInt(n));
    setText(refs.label, n === 1 ? 'shell' : 'shells');
    const who = agents.length === 1 ? agents[0].name : `${formatInt(agents.length)} agentes`;
    setAttr(refs.el, 'aria-label', `${formatInt(n)} ${n === 1 ? 'shell rodando' : 'shells rodando'}; ${who} esperando. Ir até o próximo.`);
    // Dica: quem espera o quê, do que espera há mais tempo.
    const lines = agents.slice(0, 6).map((a) => {
      const w = shellWaitIn(a, all, now)!;
      return `${a.name}: ${shellLine(w, now).label} (${formatDuration(now - w.since)})`;
    });
    if (agents.length > 6) lines.push(`… e mais ${agents.length - 6}`);
    setTitle(refs.el, `Shells rodando: ${agents.length === 1 ? 'o agente espera' : 'os agentes esperam'} terminar.\n${lines.join('\n')}\nClique para ir até ${agents.length > 1 ? 'cada um' : 'ele'}.`);
  }

  private focusNextShell(): void {
    const agents = shellWaitingAgents(this.ctx.store.snapshot?.agents ?? [], this.ctx.now());
    if (!agents.length) return;
    // Se o atual já está selecionado, passa para o próximo da fila.
    const sel = this.ctx.selection();
    let i = this.shellCursor % agents.length;
    if (sel?.type === 'agent' && agents[i].id === sel.id) i = (i + 1) % agents.length;
    this.shellCursor = i + 1;
    this.ctx.select({ type: 'agent', id: agents[i].id }, { focus: true });
  }

  private focusFirstWaiting(): void {
    const first = waitingAgents(this.ctx.store.snapshot?.agents ?? [])[0];
    if (first) this.ctx.select({ type: 'agent', id: first.id }, { focus: true });
  }
}
