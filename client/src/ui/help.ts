// Ajuda ("?"): legenda de status e ícones, controles, o que o escritório mostra, contas e uso, e o Codex.
import type { AgentStatus } from '../../../shared/types';
import type { HelpSection } from './context';
import { h, iconButton, prefersReducedMotion } from './dom';
import { ICONS } from './icons';
import { SHELL_STAGES, STATUS_LABEL } from './model';
import { CODEX_LIVE_HINT } from './provider';
import { createUsageSetup, richText } from './usage';
import { createAccountChip, updateAccountChip } from './widgets';

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

/** Rodas da vida social (quem está à toa se junta com os colegas). */
const SOCIAL_HELP: [string, string][] = [
  ['📺', 'TV no lounge: futebol (comemoram o gol junto com a tela), novela ou desenho, com pipoca.'],
  ['🎮', 'Videogame no sofá (melhor de 3) ou duelo nos fliperamas, com torcida.'],
  ['🏓', 'Pingue-pongue até 5 pontos, com placar e torcida atrás da mesa.'],
  ['☕', 'Papo na copa: pegam café e sentam para fofocar, contar piada e falar de trabalho.'],
  ['✊', 'Jokenpô valendo moedinhas: jo-ken-pô, revelação, quem ganha leva o 🪙 (e quem perde pede revanche).'],
  ['💄', 'Espelho do banheiro: se arrumam (batom, pente) e aparecem refletidos no vidro.'],
  ['🪙', 'Carteira: entram com 🪙100 (subagentes 🪙30), ganham 🪙10 por tarefa concluída, 🪙5 por pedido atendido e 🪙15 por entrega de subagente.'],
];

/** Eventos do GitHub vistos ao vivo nas sessões (gh, git push, MCP do GitHub). */
const GITHUB_HELP: [string, string][] = [
  ['🎉', 'Festa: PR aberto ou mergeado, release publicada (ou CI verde depois de um alarme). Confete cai na sala, todos comemoram e uma faixa diz o motivo (~12 s).'],
  ['🚨', 'Alarme: o CI ficou vermelho. Giroflex nos cantos da sala, chão avermelhado e um balão “!” sobre quem viu a falha, até um CI verde na sala (ou 10 min).'],
  ['🚀', 'Push: só o aviso e o feed, sem mexer na sala.'],
];

/** O Codex no escritório: o que muda em relação ao Claude Code (trechos `assim` viram código). */
const CODEX_HELP: string[] = [
  'Cada projeto aberto no Codex (no terminal ou no app) vira uma sala: a mesma do Claude Code naquela pasta, e os dois dividem a sala.',
  'Os agentes do Codex têm o chip da conta vazado (só a borda na cor da conta) e o selo CODEX na etiqueta e nos detalhes.',
  `${CODEX_LIVE_HINT} Sem os hooks, o escritório lê os arquivos de sessão do Codex: cada passo aparece quando termina.`,
  'Aprovar pelo escritório no `codex` do terminal (ligado ao daemon): o pedido aparece aqui e no terminal ao mesmo tempo, sem prazo, e vale a primeira resposta, daqui ou de lá. Há “Aprovar nesta sessão”, e recusar não pede motivo.',
  'Aprovar pelo escritório nos demais Codex (app, VS Code, CLI fora do daemon): o pedido espera aqui por até 25 s (o padrão) e depois segue no terminal; recusar pede um motivo, e não há “não perguntar de novo”. Em nenhum dos dois há “interromper”.',
  'Mensagens: entram na fila da sessão e viram o próximo prompt quando o Codex terminar o que está fazendo (até ~10 s). Com o Habblaud no Docker, deixe `npm run codex:bridge` rodando; no modo Node funciona sozinho.',
  'Perguntas do Codex são respondidas no próprio Codex.',
  'Uso: vem dos arquivos de sessão do Codex, sem instalar nada, e só se renova enquanto alguma sessão roda (por isso o cartão mostra a idade, ex.: “há 12 min”). O cartão mostra só os medidores que o plano tem (num plano só semanal, só a semana). “sem cota” quer dizer sem cota nem créditos para usar agora.',
  'Meu dia: o Codex conta tokens, mas não grava custo.',
];

/** O fim da espera (o servidor marca com uma atividade ✅ ou ❌). */
const SHELL_END_HELP: [string, string][] = [
  ['🎉', 'Terminou bem: levanta, comemora com confete e uma estrela.'],
  ['🌧️', 'Falhou ou foi interrompido: nuvenzinha de chuva sobre a cabeça e ombros caídos.'],
];

const INTRO =
  'Cada projeto aberto no Claude Code ou no Codex vira uma sala (os dois no mesmo projeto dividem a sala), e cada sessão aberta é um personagem com nome próprio. ' +
  'Subagentes chegam como colegas novos, trabalham na mesma sala e vão embora quando terminam. ' +
  'Quando a última sessão de uma sala é fechada, quem sai apaga a luz e a sala é desmontada.';

const SHORTCUTS: [string[], string][] = [
  [['/'], 'Buscar agente, projeto ou conta'],
  [['F'], 'Seguir o agente selecionado'],
  [['T'], 'Abrir ou fechar o terminal do agente selecionado'],
  [['Ctrl+F'], 'Com o terminal em foco: buscar na conversa (⌘F no Mac); Enter e Shift+Enter navegam'],
  [['L'], 'Abrir ou fechar o timelapse do dia'],
  [['P'], 'Ir até o próximo pedido de permissão ou pergunta para responder pelo escritório'],
  [['M'], 'Meu dia: para onde foi o tempo (trabalhando, esperando você...)'],
  [['O', '0'], 'Visão geral do prédio'],
  [['Esc'], 'Fechar a busca do terminal, depois o terminal; depois, a gaveta e a seleção'],
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
        this.socialSection(),
        this.githubSection(),
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
            h('li', {
              text: 'Nos detalhes de um agente, “Abrir terminal” mostra a conversa da sessão como no Claude Code (ou no Codex), ao vivo (precisa do acesso local, bind 127.0.0.1).',
            }),
            h('li', {
              text: 'Com o plugin habblaud-mensagens (npm run mod:install), dá para mandar mensagens ao agente principal pelos detalhes dele ou pela caixa no rodapé do terminal: o texto entra na sessão como se você o tivesse digitado. Enter manda, Shift+Enter quebra a linha.',
            }),
            h('li', {
              text: 'No terminal: busca (lupa ou Ctrl/⌘+F), filtro “Tudo / Só prompts / Sem ferramentas” e um botão de copiar em cada entrada. O relógio da barra superior abre o histórico das sessões dos últimos 7 dias, inclusive as já encerradas.',
            }),
            h('li', {
              text: 'Com o mod do Habblaud instalado (npm run mod:install, que inclui o plugin de permissões), quem “pede permissão” mostra nos detalhes o comando ou a edição e os botões Aprovar, Recusar e Responder no terminal; quem faz uma pergunta mostra as opções (e um “Outro” para escrever) para responder por aqui. O diálogo continua no terminal: vale o que você responder primeiro.',
            }),
          ),
          shortcuts,
        ),
        this.usageSection(),
        this.codexSection(),
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

  /** Legenda da vida social: as rodas dos ociosos, as personalidades e as moedinhas. */
  private socialSection(): HTMLElement {
    const item = (emoji: string, text: string) =>
      h('li', {}, h('span', { class: 'ui-icon-legend__icon', text: emoji, attrs: { 'aria-hidden': 'true' } }), h('span', { text }));
    return h(
      'section',
      { class: 'ui-help__shell' },
      h('h3', { text: 'Vida social' }),
      h('p', {
        class: 'ui-help__lead',
        text:
          'Quando dois ou mais agentes estão à toa (ociosos, ou esperando um shell há mais de 40 s), eles se juntam. Cada um tem 2 ou 3 traços de personalidade ' +
          '(competição, fofoca, vaidade, sonecas…), amizades e rivalidades, e isso decide o que preferem fazer, com quem e o que falam. ' +
          'Os detalhes do agente mostram a personalidade, a carteira e o extrato; as partidas e apostas aparecem no feed.',
      }),
      h('ul', { class: 'ui-shell-legend' }, ...SOCIAL_HELP.map(([e, t]) => item(e, t))),
    );
  }

  /** Legenda do GitHub no escritório: festa e alarme nas salas. */
  private githubSection(): HTMLElement {
    const item = (emoji: string, text: string) =>
      h('li', {}, h('span', { class: 'ui-icon-legend__icon', text: emoji, attrs: { 'aria-hidden': 'true' } }), h('span', { text }));
    return h(
      'section',
      { class: 'ui-help__shell' },
      h('h3', { text: 'GitHub no escritório' }),
      h('p', {
        class: 'ui-help__lead',
        text:
          'O que os agentes fazem no GitHub (gh pr create/merge, git push, gh run watch, gh pr checks, gh release create e o MCP do GitHub) vira aviso, ' +
          'entra no feed e anima a sala do projeto. Só o que acontece ao vivo: o que já estava nos transcripts quando o Habblaud abriu fica só no histórico.',
      }),
      h('ul', { class: 'ui-shell-legend' }, ...GITHUB_HELP.map(([e, t]) => item(e, t))),
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
        h('li', { text: 'O chip colorido com a letra (C, D…) mostra de qual conta do Claude Code é cada agente: cada atalho de terminal usa uma pasta de configuração diferente.' }),
        h('li', {}, accountSample('C', '#f08a3c'), ' Conta do Claude Code · ', accountSample('X', '#a77bf3', true), ' Conta do Codex (chip vazado, com o selo CODEX onde há espaço).'),
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

  /** O Codex no escritório (o "Como funciona" do cartão de uso de uma conta do Codex abre aqui). */
  private codexSection(): HTMLElement {
    const el = h(
      'section',
      { class: 'ui-help__usage', attrs: { 'aria-labelledby': 'ui-help-codex' } },
      h('h3', { text: 'Codex', tabIndex: -1, attrs: { id: 'ui-help-codex' } }),
      h('ul', { class: 'ui-help__list' }, ...CODEX_HELP.map((text) => h('li', {}, ...richText(text)))),
    );
    this.sections.set('codex', el);
    return el;
  }

  get isOpen(): boolean {
    return this.el.open;
  }
}

/** Um chip de conta de exemplo (legenda). */
function accountSample(short: string, color: string, codex = false): HTMLElement {
  const chip = createAccountChip('sm');
  updateAccountChip(chip, { id: short, short, name: codex ? 'Codex' : `Conta ${short}`, color, configDir: '', sessions: 0, usageStatus: 'disabled', ...(codex ? { provider: 'codex' as const } : {}) });
  chip.setAttribute('aria-hidden', 'true');
  return chip;
}
