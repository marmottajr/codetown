// CONTRATO do módulo de arte (pixel art procedural).
//
// - Implementação: client/src/art/index.ts (+ arquivos internos de art/).
// - Consumidores: client/src/world/** (render do escritório) e client/src/ui/** (avatares).
// - Regra: mudanças aqui devem ser ADITIVAS. Não renomeie/remova tipos, kinds ou funções.
//
// Convenções gerais
// - Mundo em "pixels de mundo"; 1 tile = TILE px. Tudo é pixel art em 1x, ampliado pela câmera
//   com imageSmoothingEnabled = false.
// - Perspectiva: top-down 3/4, como em tilesets de escritório moderno em pixel art. Ver DIREÇÃO DE ARTE abaixo. Vemos o topo e a FRENTE (face sul)
//   dos objetos. Paredes norte mostram a face (2 tiles de altura); paredes laterais e sul aparecem
//   só como "tampa" fina para não esconder o interior das salas.
// - Luz vem de cima/esquerda: topos mais claros, faces frontais mais escuras, sombra suave embaixo.
// - Sprites são HTMLCanvasElement em cache (gere uma vez, reutilize sempre).

// DIREÇÃO DE ARTE (pixel art top-down 3/4 de escritório moderno, claro e detalhado)
// - Escritório claro e limpo: porcelanato claro com rejunte sutil, madeira quente no lounge, paredes claras,
//   divisórias de vidro azulado, estantes com pastas coloridas, plantas em vasos, quadros, placa com o nome.
// - Ilhas de mesas com 1–2 monitores de tela azulada brilhante, teclado, mouse, caneca, papéis; cadeiras grafite.
// - Copa com bancada clara e frontão de mármore, pia inox, cafeteira, geladeira; bebedouro com galão azul.
// - Lounge com sofá azul/cinza-azulado e almofadas laranja, tapete, mesa de centro, bonsai, impressora grande.
// - Paleta clara (neutros frios + madeira quente + acentos saturados nos objetos); contorno 1px cinza-azulado
//   escuro (não preto); 3–4 tons por material; brilhos especulares; sombras de contato; muitos detalhes pequenos.

export const TILE = 16;

export type { Dir, FurnitureDef, FurnitureKind, FloorKind, WallPattern, WallStyle } from '../../../shared/furniture';
export { CUSTOM_PREFIX, FURNITURE, furnitureDef, isCustomKind } from '../../../shared/furniture';
import type { Dir, FurnitureKind, FloorKind, WallStyle } from '../../../shared/furniture';

/**
 * Poses do personagem. Entre parênteses: nº de frames esperado.
 * Poses "sentadas" (sit/type/sleep) assumem que o personagem está sobre um assento: as pernas
 * ficam escondidas/dobradas e o corpo fica ~4px mais baixo que em pé.
 */
export type Pose =
  | 'stand' // em pé parado, respiração sutil (2)
  | 'walk' // andando (4)
  | 'run' // correndo, passos mais largos e corpo inclinado (4)
  | 'sit' // sentado parado (2)
  | 'type' // sentado digitando — normalmente dir 'up', de costas para a câmera, braços alternando (4)
  | 'sleep' // sentado cochilando: cabeça baixa (2)
  | 'drink' // em pé levando o copo à boca (2) — use com held 'coffee' ou 'water'
  | 'use' // em pé operando máquina: braço estendido para frente (2)
  | 'raise_hand' // braço levantado acenando — pedindo atenção (2); funciona em pé e sentado (opts.seated)
  | 'talk' // em pé conversando, gesticulando (2)
  | 'stretch' // em pé se espreguiçando, braços para cima (2)
  | 'read' // em pé ou sentado segurando livro/papéis à frente (2)
  | 'play' // ping-pong: raquete na mão, alternando braço (2)
  | 'wait' // sentado esperando algo terminar (ex.: um shell), recostado (2). Com held 'popcorn': mão do balde à boca, comendo pipoca; sem item: braços cruzados, dedos/pé batendo
  // --- vida social (aditivo)
  | 'cheer' // comemorando: os dois braços para o alto, punhos cerrados, boca aberta, pulinho no quadro 1 (2). Em pé ou sentado (opts.seated)
  | 'laugh' // gargalhando: olhos fechados em arco, boca aberta, uma mão na barriga, corpo sacudindo 1px (2). Em pé ou sentado
  | 'game' // jogando videogame: controle (held 'controller') nas duas mãos à frente do peito, polegares mexendo, corpo inclinado para a tela (2). Em pé ou sentado
  | 'rps' // pedra-papel-tesoura. held 'none': punho fechado subindo (quadro 0) e descendo (1) na contagem "jo-ken-pô"; held 'rock'|'paper'|'scissors': braço estendido à frente mostrando o gesto (2). Em pé (sentado também funciona)
  | 'groom' // diante do espelho (normalmente dir 'up', de costas): uma mão perto do rosto/cabelo indo e voltando — batom, pente, ajeitar o cabelo (2). held opcional 'lipstick'|'comb'. Em pé
  | 'sulk'; // chateado (perdeu a aposta/partida): ombros caídos, cabeça baixa, olhos semicerrados, braços pendurados (2). Em pé ou sentado

export type HeldItem = 'none' | 'coffee' | 'water' | 'papers' | 'laptop' | 'book' | 'box' | 'paddle' | 'popcorn'
  // --- vida social (aditivo)
  | 'controller' // controle de videogame (pose 'game'; em pé/andando, numa mão)
  | 'rock' // pose 'rps': mão fechada (pedra)
  | 'paper' // pose 'rps': mão aberta, palma para baixo (papel)
  | 'scissors' // pose 'rps': indicador e médio em V (tesoura)
  | 'phone' // celular (com 'read' ou 'sit': olhando a tela, polegar rolando; tela acesa azulada)
  | 'lipstick' // batom (pose 'groom')
  | 'comb'; // pente (pose 'groom')

export type HairStyle =
  | 'short' | 'buzz' | 'spiky' | 'side_part' | 'curly' | 'afro' | 'bob' | 'long' | 'ponytail' | 'bun' | 'pigtails'
  | 'mohawk' | 'bald' | 'wavy';

export type TopStyle = 'tshirt' | 'hoodie' | 'shirt_tie' | 'sweater' | 'jacket' | 'blouse' | 'polo';

export type Accessory = 'none' | 'glasses' | 'sunglasses' | 'headphones' | 'cap' | 'beanie' | 'earrings' | 'bow';

export interface Appearance {
  skin: string;
  hair: string;
  hairStyle: HairStyle;
  eyes: string;
  top: string;
  topAccent: string;
  topStyle: TopStyle;
  bottom: string;
  shoes: string;
  accessory: Accessory;
  accessoryColor: string;
  /** Crachá/cordão no pescoço (usado para distinguir subagentes). null = sem crachá. */
  lanyard: string | null;
  look: 'f' | 'm';
  /** (Opcional, aditivo) Barba/bigode — só sorteado para look 'm'. Ausente = sem pelos faciais. */
  facialHair?: 'none' | 'stubble' | 'beard' | 'mustache' | 'goatee';
  /** (Opcional, aditivo) Parte de baixo da roupa. Ausente = calça. */
  bottomStyle?: 'pants' | 'shorts' | 'skirt';
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Regiões dinâmicas dentro de um sprite (em px do sprite, relativas ao canto superior esquerdo). */
export type SpriteRectName = 'screen' | 'board' | 'glass' | 'face' | 'tv' | 'sign' | 'art' | 'glow'
  /**
   * (Aditivo) 2º monitor/notebook da `desk`, quando existe. O sprite já traz um conteúdo fixo
   * escurecido (planilha/editor/painel); o mundo PODE desenhar por cima (ex.: drawScreen 'off'
   * quando a sala apaga, ou outro modo quando o dono trabalha). Ignorar também funciona.
   */
  | 'screen2';

export interface Sprite {
  canvas: HTMLCanvasElement;
  /** Ponto de ancoragem dentro do sprite (px). Ver convenções em FurnitureDef / characterSprite. */
  ax: number;
  ay: number;
  rects?: Partial<Record<SpriteRectName, Rect>>;
}

/** `front` é desenhado POR CIMA de quem está sentado/dentro (ex.: encosto da cadeira, porta da cabine). */
export interface FurnitureSprites {
  base: Sprite;
  front?: Sprite;
}

export interface CharacterFrameRequest {
  appearance: Appearance;
  dir: Dir;
  pose: Pose;
  frame: number;
  held?: HeldItem;
  /** Para poses que podem ser em pé ou sentado (raise_hand, read, talk). */
  seated?: boolean;
}



export interface Doorway {
  /** Início da passagem em px de mundo (absoluto) e largura em px. */
  x: number;
  w: number;
}

export type ScreenMode =
  | 'off' // monitor desligado (azul-marinho fosco com reflexo diagonal; nunca quase preto)
  | 'standby' // (aditivo) ligado sem uso: fundo azul com logo pulsando devagar — p.ex. mesa vaga com a sala acesa
  | 'idle' // descanso de tela suave
  | 'code' // editor com linhas de código coloridas rolando
  | 'terminal' // terminal escuro com texto verde surgindo
  | 'browser' // página web (barra de endereço + blocos)
  | 'search' // resultados de busca / lupa
  | 'chat' // conversa (balões alternados)
  | 'docs' // documento de texto
  | 'tasks' // lista de checkboxes
  | 'alert' // tela piscando em âmbar (precisa de atenção)
  | 'progress' // terminal escuro com uma barra de progresso/spinner andando (esperando um comando terminar)
  // --- vida social (aditivo; pensados para a TV do lounge e o fliperama, mas valem para qualquer tela)
  | 'show' // programa de TV animado; mapeamento FIXO pelo `seed`: seed % 3 === 0 futebol (campo, jogadores, bola; de tempos em tempos a bola entra no gol e a tela pisca "GOL"), 1 novela (dois rostos em close, corações), 2 desenho animado (cores vivas)
  | 'game'; // videogame (dois jogadores); mapeamento FIXO pelo `seed`: seed % 2 === 0 corrida em tela dividida (dois carrinhos na pista), 1 luta (dois bonecos e barras de vida)

export interface RoomTheme {
  carpet: string;
  carpet2: string;
  wall: WallStyle;
  accent: string;
  deskVariant: string;
  chairVariant: string;
}

/** Ícones pixel art pequenos (~8–12px) para estados acima da cabeça. */
export type IconName = 'alert' | 'question' | 'zzz' | 'check' | 'heart' | 'coffee' | 'music' | 'idea' | 'sweat' | 'star' | 'lightning' | 'chat' | 'box' | 'wave'
  | 'hourglass' // ampulheta (esperando um shell)
  | 'hourglass_flip' // a mesma ampulheta virando (alterne com 'hourglass' para animar)
  | 'cobweb' // teia de aranha (~12px) para o canto da cadeira/personagem quando a espera fica longa
  | 'storm' // nuvenzinha de chuva com raio (algo falhou)
  // --- vida social (aditivo)
  | 'coin' // moeda dourada com brilho (~8px) — ganhou dinheiro
  | 'sparkle' // brilho de 4 pontas (~9px) — ficou arrumado(a) no espelho
  | 'trophy' // troféu dourado (~10px) — venceu a partida/aposta
  | 'hand_rock' // gesto de pedra (punho) (~10px) — revelação do jokenpô
  | 'hand_paper' // gesto de papel (mão aberta) (~10px)
  | 'hand_scissors'; // gesto de tesoura (V) (~10px)

/** Assinatura que art/index.ts deve exportar (o mundo e a UI dependem disto). */
export interface ArtModule {
  appearanceFromSeed(seed: number, opts?: { look?: 'f' | 'm'; sub?: boolean }): Appearance;
  /** Ancoragem: (ax, ay) = centro dos pés (ponto no chão). Personagem ocupa ~14–18px de largura e ~24–28px de altura. */
  characterSprite(req: CharacterFrameRequest): Sprite;
  poseFrameCount(pose: Pose): number;
  /** Duração de cada frame da pose em ms. */
  poseFrameDuration(pose: Pose): number;
  /**
   * `opts.seed` (opcional, aditivo) varia os detalhes de itens repetidos (objetos sobre a mesa, livros da
   * estante, pastas...). Sem seed, usa a variação 0. Sprites continuam em cache por (kind, variant, state, seed % N).
   */
  furnitureSprites(kind: FurnitureKind, variant?: string, state?: number, opts?: { seed?: number }): FurnitureSprites;
  /** Desenha uma área de piso (px de mundo, múltiplos de TILE). `seed` varia detalhes por tile. */
  drawFloor(ctx: CanvasRenderingContext2D, kind: FloorKind, x: number, y: number, w: number, h: number, opts: { seed: number; tint?: string; tint2?: string }): void;
  /** Tapete decorativo sobre o piso. */
  drawRug(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, color: string, seed: number): void;
  /** Face de parede norte: altura 2*TILE a partir de y, com "tampa" escura no topo e rodapé na base. */
  drawWallFace(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, style: WallStyle, opts?: { doorways?: Doorway[] }): void;
  /** Tampa de parede (laterais e trechos sem face), retângulo arbitrário. */
  drawWallTop(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, style: WallStyle): void;
  /** Parede sul: 1 tile de altura (tampa + mureta curta), com passagens opcionais. */
  drawSouthWall(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, style: WallStyle, opts?: { doorways?: Doorway[] }): void;
  /** Conteúdo animado de tela (monitor/TV). `r` em px de mundo. `t` em ms. */
  drawScreen(ctx: CanvasRenderingContext2D, r: Rect, mode: ScreenMode, t: number, seed: number): void;
  /** Post-its do quadro kanban (colunas: a fazer / fazendo / feito). */
  drawBoard(ctx: CanvasRenderingContext2D, r: Rect, items: readonly { status: 'pending' | 'in_progress' | 'completed' }[], t: number): void;
  /** Céu + horizonte visto pela janela conforme a hora local (0–24, fracionária). */
  drawWindowView(ctx: CanvasRenderingContext2D, r: Rect, hour: number, t: number, seed: number): void;
  drawClock(ctx: CanvasRenderingContext2D, r: Rect, date: Date): void;
  roomTheme(seed: number): RoomTheme;
  iconSprite(name: IconName): Sprite;
  /**
   * (Opcional, aditivo) Lance do futebol de drawScreen('show') com seed % 3 === 0, no instante `t`:
   * a partir de `progress >= goalAt` a tela pisca "GOL" (bola no gol da direita se `right`). O mundo
   * usa para a torcida comemorar junto com a TV.
   */
  footballLance?(t: number, seed: number): { lance: number; progress: number; right: boolean; period: number; goalAt: number };
  /** Avatar (cabeça + ombros) ampliado para a UI. */
  avatarCanvas(seed: number, opts?: { look?: 'f' | 'm'; sub?: boolean; scale?: number }): HTMLCanvasElement;
}
