// Catálogo dos móveis (footprint, montagem, assento, variantes) e tipos de piso/parede: compartilhado pelo
// cliente (art/api.ts reexporta tudo, é o contrato do módulo de arte) e pelo servidor (validação dos assets
// criados pelo usuário, ver shared/assets.ts). Puro, sem DOM.

export type Dir = 'down' | 'up' | 'left' | 'right';

export type FurnitureKind =
  // --- escritório (salas de projeto)
  | 'desk' // 2x1. Mesa com monitor virado para o SUL (tela visível para a câmera), teclado e caneca. rects.screen = área da tela.
  | 'desk_back' // 2x1. Mesa vista pelo outro lado: vemos a TRASEIRA do monitor; a pessoa senta ao NORTE dela, virada para baixo (rosto visível). Para ilhas de mesas face a face. Mesmas variants de desk.
  | 'office_chair_front' // 1x1 assento virado para BAIXO (encosto ao norte, desenhado ANTES do personagem; sem front). Par da desk_back.
  | 'office_chair' // 1x1 assento. Encosto ao sul (personagem senta virado para cima, de costas). front = encosto.
  | 'bookshelf' // 2x1 encostada na parede norte. Livros coloridos.
  | 'filing_cabinet' // 1x1 arquivo de gavetas.
  | 'printer' // 1x1 impressora sobre móvel baixo.
  | 'trash_bin' // 1x1 lixeira pequena (pode ser bem menor que o tile).
  | 'plant_small' // 1x1 vaso pequeno. variants: 'fern' | 'succulent' | 'flower'
  | 'plant_tall' // 1x1 planta alta (até ~2 tiles de altura). variants: 'palm' | 'ficus' | 'monstera' | 'bonsai'
  | 'glass_partition' // 1x1 segmento de divisória de vidro sobre base branca (meia-parede + vidro azulado com reflexo). variants: 'h' (corre leste-oeste) | 'v' (corre norte-sul) | 'end' (ponta/coluna)
  | 'binder_shelf' // 1x1 estante alta e estreita com pastas coloridas (azul/laranja/verde) e caixas.
  | 'meeting_table' // 3x2 mesa de reunião/bancada para subagentes.
  | 'stool' // 1x1 assento simples (banqueta). Personagem pode sentar em qualquer direção.
  | 'floor_lamp' // 1x1 luminária de chão. rects.glow = centro da luz.
  | 'water_cooler' // 1x1 bebedouro com galão azul. Uso: personagem fica ao SUL, virado para cima.
  // --- montados na parede norte (mount: 'wall')
  | 'whiteboard' // 3 tiles de largura. Quadro kanban. rects.board = área onde o render desenha post-its.
  | 'window' // 2 tiles. Janela; rects.glass = vidro (o render desenha o céu antes da moldura).
  | 'clock' // 1 tile. Relógio; rects.face = mostrador (ponteiros desenhados pelo render).
  | 'poster' // 1 tile. variants: 'code' | 'coffee' | 'rocket' | 'cat' | 'bug' | 'ship_it'
  | 'painting' // 2 tiles. Quadro com moldura; rects.art = área da pintura (pode receber imagem gerada por IA).
  | 'tv' // 2 tiles. TV de parede; rects.tv = tela.
  | 'light_switch' // 1 tile (o sprite é pequeno). variants: 'on' | 'off'
  | 'elevator' // 2 tiles. Porta de elevador; state 0..4 = porta fechada .. totalmente aberta. Inclui luz/seta acima.
  | 'door_frame' // 2 tiles. Batente desenhado sobre a passagem na face da parede norte.
  | 'sign' // 3 tiles. Placa com o nome da sala; rects.sign = área do texto (o render escreve o nome).
  | 'mirror' // 1 tile. Espelho (acima das pias do banheiro). (Aditivo) rects.glass = área refletora (o mundo pode desenhar o reflexo de quem está na frente).
  | 'shelf_wall' // 2 tiles. Prateleira de parede com objetos.
  // --- copa / café
  | 'counter' // 1x1 segmento de bancada (encostado na parede norte). variants: 'plain' | 'drawers'
  | 'counter_sink' // 1x1 bancada com pia.
  | 'coffee_machine' // 1x1 bancada com cafeteira em cima. Uso: personagem ao SUL, virado para cima. state 0 = parada, 1 = passando café.
  | 'microwave' // 1x1 bancada com micro-ondas.
  | 'fridge' // 1x1 geladeira alta.
  | 'vending_machine' // 1x1 máquina de snacks alta e iluminada.
  | 'cafe_table' // 1x1 mesinha redonda.
  | 'cafe_chair' // 1x1 assento. variant = direção para onde quem senta olha: 'up' | 'down' | 'left' | 'right'. front quando 'up'.
  // --- lounge
  | 'sofa' // 3x1 assento. variant 'down' (de frente p/ câmera) | 'up' (de costas, front = encosto).
  | 'armchair' // 1x1 assento. variants como cafe_chair.
  | 'coffee_table' // 2x1 mesa de centro.
  | 'pingpong_table' // 3x2 mesa de ping-pong (rede vertical no meio; jogadores nas pontas oeste/leste).
  | 'beanbag' // 1x1 puff (assento). variants de cor: 'red' | 'blue' | 'yellow' | 'green'
  | 'arcade' // 1x1 fliperama (uso como máquina: personagem ao sul virado para cima). (Aditivo) rects.screen = tela (o mundo pode desenhar drawScreen 'game' por cima durante uma partida).
  // --- banheiro
  | 'toilet_stall' // 2x2 cabine com vaso. Personagem entra pela porta (lado SUL) e some. front = divisória/porta. state 0 = livre (porta entreaberta), 1 = ocupada (porta fechada, indicador vermelho).
  | 'sink' // 1x1 pia com gabinete (encostada na parede norte; use 'mirror' na parede acima).
  // --- recepção
  | 'reception_desk' // 3x1 balcão de recepção.
  | 'bench'; // 2x1 banco de espera (assento, olhando para baixo).

export interface FurnitureDef {
  mount: 'floor' | 'wall';
  /**
   * Floor: tiles ocupados no chão (w x h).
   * Wall: largura em tiles na face da parede (h ignorado).
   */
  footprint: { w: number; h: number };
  /** Floor: se os tiles bloqueiam a passagem. Assentos não bloqueiam (o personagem "entra" neles). */
  blocks: boolean;
  /** É um assento (personagem pode sentar sobre ele). */
  seat?: boolean;
  variants?: readonly string[];
  /** Quantidade de estados visuais (ex.: elevator 5, toilet_stall 2). */
  states?: number;
}

/**
 * Catálogo de móveis. Ancoragem (ax, ay) dos sprites de móveis:
 * - mount 'floor': (ax, ay) corresponde ao ponto CENTRAL INFERIOR do footprint no mundo,
 *   ou seja, (x0 + w*TILE/2, y0 + h*TILE) onde (x0, y0) é o canto superior esquerdo do footprint.
 *   O sprite pode se estender para cima (altura) e um pouco para os lados.
 * - mount 'wall': (ax, ay) corresponde ao ponto CENTRAL INFERIOR do trecho de parede, isto é,
 *   na linha do rodapé (base da face da parede). O sprite "flutua" na altura certa por conta própria.
 * Ordenação de profundidade: por y da âncora no mundo (maior y = desenhado depois).
 */
export const FURNITURE: Readonly<Record<FurnitureKind, FurnitureDef>> = {
  desk: { mount: 'floor', footprint: { w: 2, h: 1 }, blocks: true, variants: ['wood', 'white', 'dark'] },
  desk_back: { mount: 'floor', footprint: { w: 2, h: 1 }, blocks: true, variants: ['wood', 'white', 'dark'] },
  office_chair_front: { mount: 'floor', footprint: { w: 1, h: 1 }, blocks: false, seat: true, variants: ['black', 'blue', 'red', 'green', 'gray'] },
  office_chair: { mount: 'floor', footprint: { w: 1, h: 1 }, blocks: false, seat: true, variants: ['black', 'blue', 'red', 'green', 'gray'] },
  bookshelf: { mount: 'floor', footprint: { w: 2, h: 1 }, blocks: true },
  filing_cabinet: { mount: 'floor', footprint: { w: 1, h: 1 }, blocks: true },
  printer: { mount: 'floor', footprint: { w: 1, h: 1 }, blocks: true },
  trash_bin: { mount: 'floor', footprint: { w: 1, h: 1 }, blocks: true },
  plant_small: { mount: 'floor', footprint: { w: 1, h: 1 }, blocks: true, variants: ['fern', 'succulent', 'flower'] },
  plant_tall: { mount: 'floor', footprint: { w: 1, h: 1 }, blocks: true, variants: ['palm', 'ficus', 'monstera', 'bonsai'] },
  glass_partition: { mount: 'floor', footprint: { w: 1, h: 1 }, blocks: true, variants: ['h', 'v', 'end'] },
  binder_shelf: { mount: 'floor', footprint: { w: 1, h: 1 }, blocks: true },
  meeting_table: { mount: 'floor', footprint: { w: 3, h: 2 }, blocks: true },
  stool: { mount: 'floor', footprint: { w: 1, h: 1 }, blocks: false, seat: true },
  floor_lamp: { mount: 'floor', footprint: { w: 1, h: 1 }, blocks: true },
  water_cooler: { mount: 'floor', footprint: { w: 1, h: 1 }, blocks: true },
  whiteboard: { mount: 'wall', footprint: { w: 3, h: 0 }, blocks: false },
  window: { mount: 'wall', footprint: { w: 2, h: 0 }, blocks: false },
  clock: { mount: 'wall', footprint: { w: 1, h: 0 }, blocks: false },
  poster: { mount: 'wall', footprint: { w: 1, h: 0 }, blocks: false, variants: ['code', 'coffee', 'rocket', 'cat', 'bug', 'ship_it'] },
  painting: { mount: 'wall', footprint: { w: 2, h: 0 }, blocks: false },
  tv: { mount: 'wall', footprint: { w: 2, h: 0 }, blocks: false },
  light_switch: { mount: 'wall', footprint: { w: 1, h: 0 }, blocks: false, variants: ['on', 'off'] },
  elevator: { mount: 'wall', footprint: { w: 2, h: 0 }, blocks: false, states: 5 },
  door_frame: { mount: 'wall', footprint: { w: 2, h: 0 }, blocks: false },
  sign: { mount: 'wall', footprint: { w: 3, h: 0 }, blocks: false },
  mirror: { mount: 'wall', footprint: { w: 1, h: 0 }, blocks: false },
  shelf_wall: { mount: 'wall', footprint: { w: 2, h: 0 }, blocks: false },
  counter: { mount: 'floor', footprint: { w: 1, h: 1 }, blocks: true, variants: ['plain', 'drawers'] },
  counter_sink: { mount: 'floor', footprint: { w: 1, h: 1 }, blocks: true },
  coffee_machine: { mount: 'floor', footprint: { w: 1, h: 1 }, blocks: true, states: 2 },
  microwave: { mount: 'floor', footprint: { w: 1, h: 1 }, blocks: true },
  fridge: { mount: 'floor', footprint: { w: 1, h: 1 }, blocks: true },
  vending_machine: { mount: 'floor', footprint: { w: 1, h: 1 }, blocks: true },
  cafe_table: { mount: 'floor', footprint: { w: 1, h: 1 }, blocks: true },
  cafe_chair: { mount: 'floor', footprint: { w: 1, h: 1 }, blocks: false, seat: true, variants: ['up', 'down', 'left', 'right'] },
  sofa: { mount: 'floor', footprint: { w: 3, h: 1 }, blocks: false, seat: true, variants: ['down', 'up'] },
  armchair: { mount: 'floor', footprint: { w: 1, h: 1 }, blocks: false, seat: true, variants: ['up', 'down', 'left', 'right'] },
  coffee_table: { mount: 'floor', footprint: { w: 2, h: 1 }, blocks: true },
  pingpong_table: { mount: 'floor', footprint: { w: 3, h: 2 }, blocks: true },
  beanbag: { mount: 'floor', footprint: { w: 1, h: 1 }, blocks: false, seat: true, variants: ['red', 'blue', 'yellow', 'green'] },
  arcade: { mount: 'floor', footprint: { w: 1, h: 1 }, blocks: true },
  toilet_stall: { mount: 'floor', footprint: { w: 2, h: 2 }, blocks: true, states: 2 },
  sink: { mount: 'floor', footprint: { w: 1, h: 1 }, blocks: true },
  reception_desk: { mount: 'floor', footprint: { w: 3, h: 1 }, blocks: true },
  bench: { mount: 'floor', footprint: { w: 2, h: 1 }, blocks: false, seat: true },
};

export type FloorKind =
  | 'carpet' // salas de projeto (usa tint/tint2 do tema da sala)
  | 'wood' // lounge
  | 'tile_check' // copa (xadrez)
  | 'tile_white' // banheiro
  | 'concrete' // corredor (cimento queimado/polido)
  | 'marble' // recepção
  | 'grass' // área externa
  | 'sidewalk' // calçada externa
  | 'street'; // rua externa (faixas desenhadas pelo render se quiser)

export type WallPattern = 'plain' | 'stripes' | 'tiles' | 'wood_panel' | 'brick' | 'glass' | 'marble';

export interface WallStyle {
  /** Cor base da face da parede. */
  base: string;
  /** Cor de detalhes (rodapé/faixa). */
  trim?: string;
  pattern?: WallPattern;
  /** Parede externa do prédio (tom mais sóbrio, pode ter textura de tijolo/concreto). */
  exterior?: boolean;
}

// ------------------------------------------------------------------ itens criados pelo usuário

/** Prefixo dos móveis criados pelo usuário na pasta de assets (`item:<id>`, ver shared/assets.ts). */
export const CUSTOM_PREFIX = 'item:';

export function isCustomKind(kind: string): boolean {
  return kind.startsWith(CUSTOM_PREFIX);
}

const custom = new Map<string, FurnitureDef>();

/** Troca o catálogo de itens do usuário (chave = `item:<id>`). */
export function setCustomFurniture(defs: Iterable<[string, FurnitureDef]>): void {
  custom.clear();
  for (const [k, d] of defs) custom.set(k, d);
}

/** Item que sumiu do catálogo (pasta apagada, item inválido): ocupa 1 tile e não atrapalha ninguém. */
const MISSING: FurnitureDef = { mount: 'floor', footprint: { w: 1, h: 1 }, blocks: true };

/** Definição de qualquer móvel: os do catálogo e os criados pelo usuário. */
export function furnitureDef(kind: string): FurnitureDef {
  return (FURNITURE as Record<string, FurnitureDef>)[kind] ?? custom.get(kind) ?? MISSING;
}

/** O móvel existe (no catálogo ou entre os itens do usuário). */
export function knownFurniture(kind: string): boolean {
  return kind in FURNITURE || custom.has(kind);
}
