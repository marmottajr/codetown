// Ajuda ("?"): legenda de status e ícones, controles, o que o escritório mostra, contas e uso.
import type { AgentStatus } from '../../../shared/types';
import type { HelpSection } from './context';
import { h, iconButton, prefersReducedMotion } from './dom';
import { ICONS } from './icons';
import { SHELL_STAGES, STATUS_LABEL } from './model';
import { createUsageSetup } from './usage';

const STATUS_HELP: [AgentStatus, string][] = [
  ['working', 'Na mesa, digitando: está processando um pedido.'],
  ['waiting', 'Mão levantada: espera uma resposta sua no terminal (permissão, pergunta ou escolha).'],
  ['shell', 'Ampulheta sobre a cabeça: terminou o turno e fica na mesa esperando um shell terminar.'],
  ['idle', 'Terminou o turno e circula pelo escritório até a próxima instrução.'],
  ['done', 'Subagente que concluiu: entrega o resultado e vai embora.'],
  ['offline', 'A sessão foi fechada: o personagem vai até o elevador e sai.'],
];

const ICON_HELP: [string, string][] = [
  ['📨', 'Recebeu um pedido'],
  ['💭', 'Pensando'],
  ['📖', 'Lendo arquivo'],
  ['🔎', 'Buscando no código'],
  ['✏️', 'Editando'],
  ['📝', 'Escrevendo arquivo'],
  ['💻', 'Comando no terminal'],
  ['⏳', 'Esperando um shell'],
  ['🧪', 'Rodando testes'],
  ['🌐', 'Pesquisando na web'],
  ['🗒️', 'Organizando tarefas'],
  ['👥', 'Chamando subagentes'],
  ['✋', 'Precisa de você'],
  ['✅', 'Concluiu'],
  ['❌', 'Shell falhou'],
  ['🛑', 'Shell interrompido'],
  ['⚠️', 'Algo deu errado'],
];

/** O fim da espera (o servidor marca com uma atividade ✅ ou ❌). */
const SHELL_END_HELP: [string, string][] = [
  ['🎉', 'Terminou bem: levanta, comemora com confete e uma estrela.'],
  ['🌧️', 'Falhou ou foi interrompido: nuvenzinha de chuva sobre a cabeça e ombros caídos.'],
];

const INTRO =
  'Cada projeto aberto no Claude Code vira uma sala, e cada sessão aberta é um personagem com nome próprio. ' +
  'Subagentes chegam como colegas novos, trabalham na mesma sala e vão embora quando terminam. ' +
  'Quando a última sessão de uma sala é fechada, quem sai apaga a luz e a sala é desmontada.';

const SHORTCUTS: [string[], string][] = [
  [['/'], 'Buscar agente, projeto ou conta'],
  [['F'], 'Seguir o agente selecionado'],
  [['O', '0'], 'Visão geral do prédio'],
  [['Esc'], 'Fechar a gaveta e limpar a seleção'],
  [['['], 'Mostrar ou ocultar o painel lateral'],
  [[']'], 'Mostrar ou ocultar o feed de atividade'],
  [['?'], 'Abrir esta ajuda'],
  [['←', '↑', '→', '↓'], 'Mover a câmera (também W A S D)'],
  [['+', '−'], 'Aproximar e afastar'],
];

function keys(list: string[]): HTMLElement {
  return h('span', { class: 'ui-keys' }, ...list.map((k) => h('kbd', { class: 'ui-kbd', text: k })));
}

export class HelpDialog {
  readonly el: HTMLDialogElement;
  private sections = new Map<HelpSection, HTMLElement>();

  constructor() {
    const close = iconButton(ICONS.close, 'Fechar ajuda', () => this.el.close(), 'ui-icon-btn--sm');
    const statusList = h(
      'ul',
      { class: 'ui-legend' },
      ...STATUS_HELP.map(([s, text]) =>
        h('li', {}, h('span', { class: `ui-status-dot is-${s}`, attrs: { 'aria-hidden': 'true' } }), h('strong', { text: STATUS_LABEL[s] }), h('span', { text })),
      ),
    );
    const iconList = h(
      'ul',
      { class: 'ui-icon-legend' },
      ...ICON_HELP.map(([icon, text]) => h('li', {}, h('span', { class: 'ui-icon-legend__icon', text: icon, attrs: { 'aria-hidden': 'true' } }), h('span', { text }))),
    );
    const shortcuts = h('dl', { class: 'ui-shortcuts' }, ...SHORTCUTS.flatMap(([k, text]) => [h('dt', {}, keys(k)), h('dd', { text })]));

    this.el = h(
      'dialog',
      { class: 'ui-dialog ui-help', attrs: { 'aria-labelledby': 'ui-help-title' } },
      h('div', { class: 'ui-dialog__head' }, h('h2', { text: 'Como ler o escritório', attrs: { id: 'ui-help-title' } }), close),
      h(
        'div',
        { class: 'ui-dialog__body' },
        h('section', { class: 'ui-help__intro' }, h('p', { text: INTRO })),
        h('section', {}, h('h3', { text: 'Status' }), statusList),
        h('section', {}, h('h3', { text: 'Atividades' }), iconList),
        this.shellSection(),
        h(
          'section',
          {},
          h('h3', { text: 'Controles' }),
          h(
            'ul',
            { class: 'ui-help__list' },
            h('li', { text: 'Arraste o escritório para mover a câmera e use a rolagem do mouse (ou pinça) para dar zoom.' }),
            h('li', { text: 'Clique em um personagem ou sala para ver os detalhes; duplo clique aproxima a câmera.' }),
            h('li', { text: 'Passe o mouse sobre um personagem para ver o que ele está fazendo.' }),
          ),
          shortcuts,
        ),
        this.usageSection(),
      ),
    );
    // Clique no fundo (fora do conteúdo) fecha.
    this.el.addEventListener('click', (e) => {
      if (e.target === this.el) this.el.close();
    });
  }

  open(section?: HelpSection): void {
    if (!this.el.open) this.el.showModal();
    const target = section ? this.sections.get(section) : undefined;
    if (!target) return;
    // Rola até a seção pedida e a destaca por um instante.
    requestAnimationFrame(() => {
      target.scrollIntoView({ block: 'start', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
      target.classList.remove('is-highlight');
      void target.offsetWidth;
      target.classList.add('is-highlight');
      const heading = target.querySelector<HTMLElement>('h3');
      heading?.focus({ preventScroll: true });
    });
  }

  /** Legenda da espera por shell: a "escalada cômica" do personagem conforme o shell demora. */
  private shellSection(): HTMLElement {
    const item = (emoji: string, text: string) =>
      h('li', {}, h('span', { class: 'ui-icon-legend__icon', text: emoji, attrs: { 'aria-hidden': 'true' } }), h('span', { text }));
    return h(
      'section',
      { class: 'ui-help__shell' },
      h('h3', { text: 'Esperando o shell' }),
      h('p', {
        class: 'ui-help__lead',
        text:
          'Quando o agente termina o turno com um comando rodando em segundo plano (ou fica mais de 10 s parado num comando), ele não sai para passear: ' +
          'fica na mesa com a ampulheta virando, o monitor mostra o progresso e um balão diz qual shell ele espera e há quanto tempo. Quanto mais demora…',
      }),
      h('ul', { class: 'ui-shell-legend' }, ...SHELL_STAGES.map((s) => item(s.emoji, s.help)), ...SHELL_END_HELP.map(([e, t]) => item(e, t))),
    );
  }

  private usageSection(): HTMLElement {
    const el = h(
      'section',
      { class: 'ui-help__usage', attrs: { 'aria-labelledby': 'ui-help-usage' } },
      h('h3', { text: 'Contas e uso', tabIndex: -1, attrs: { id: 'ui-help-usage' } }),
      h(
        'ul',
        { class: 'ui-help__list' },
        h('li', { text: 'O chip colorido com a letra (C, D…) mostra de qual conta do Claude é cada agente: cada atalho de terminal usa uma pasta de configuração diferente.' }),
        h('li', {
          text: 'No topo, cada conta mostra o uso da sessão de 5 horas e da semana. O ↻ indica quando cada limite reinicia (contagem regressiva se faltar menos de um dia). Verde abaixo de 50%, âmbar até 80% e vermelho a partir daí.',
        }),
        h('li', { text: 'Números antigos ficam acinzentados com a idade ao lado (ex.: “há 3 h”); uma janela que já reiniciou desde a leitura mostra “—” e “renovada”.' }),
      ),
      h('p', { class: 'ui-help__lead', text: 'Para ver o uso de uma conta (“sem dados de uso”), em ordem de preferência:' }),
      createUsageSetup(),
    );
    this.sections.set('usage', el);
    return el;
  }

  get isOpen(): boolean {
    return this.el.open;
  }
}
