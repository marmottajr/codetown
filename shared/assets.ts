// Assets do usuário: itens (móveis com sprite próprio), salas desenhadas à mão e ajustes na arquitetura do
// prédio, guardados numa pasta (por padrão ~/.habblaud/assets) que o "Arquiteto" (uma sessão do Claude Code
// aberta pelo escritório nessa pasta) edita. O servidor lê os arquivos, valida tudo aqui e manda o pacote já
// limpo para o cliente; o mundo desenha as salas a partir dele (client/src/world/layout/custom.ts).
//
//   <pasta>/items/<id>/item.json (+ sprite.png, front.png)   item:<id>
//   <pasta>/rooms/<id>.json                                    sala
//   <pasta>/office.json                                        sala padrão, sala por projeto e áreas comuns
//
// Coordenadas das salas: tiles LOCAIS da sala de 16x12 (iguais às do layout procedural, world/layout/room.ts).
// Piso útil: colunas 1–14, linhas 2–10. A porta fica nas colunas 7–8: embaixo (linha 11) nas salas ao norte do
// corredor e em cima (linhas 0–1) nas salas ao sul; o mesmo desenho serve para as duas, então as colunas 6–8
// das linhas 2 e 10 (porta e interruptor) ficam sempre livres e as duas entradas precisam se ligar por um caminho.
// Puro, sem DOM.
import { CUSTOM_PREFIX, FURNITURE, type Dir, type FloorKind, type FurnitureDef, type WallPattern, type WallStyle } from './furniture';

export const ROOM_COLS = 16;
export const ROOM_ROWS = 12;
/** Piso útil da sala (inclusive). */
export const INTERIOR = { x0: 1, x1: 14, y0: 2, y1: 10 } as const;
/** Colunas da porta e linhas de entrada (uma para cada lado do corredor). */
export const ENTRY_COLS = [7, 8] as const;
export const ENTRY_ROWS = [2, 10] as const;
/** Colunas sempre livres nas linhas de entrada: a porta e o interruptor de luz ao lado dela. */
export const CLEAR_COLS = [6, 7, 8] as const;
/** Trecho da parede norte reservado à placa, à porta (salas ao sul) e ao interruptor (em tiles locais). */
export const WALL_RESERVED = { x0: 6, x1: 12 } as const;
/** Limites dos itens. */
export const ITEM_MAX_TILES = { w: 4, h: 3 } as const;
export const SPRITE_MAX_PX = 96;
export const MAX_DESKS = 10;

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,47}$/;
const COLOR_RE = /^#[0-9a-f]{6}$/i;
const DIRS: readonly Dir[] = ['up', 'down', 'left', 'right'];
const FLOORS: readonly FloorKind[] = ['carpet', 'wood', 'tile_check', 'tile_white', 'concrete', 'marble'];
const PATTERNS: readonly WallPattern[] = ['plain', 'stripes', 'tiles', 'wood_panel', 'brick', 'glass', 'marble'];
/** Itens de parede que o próprio prédio posiciona (não entram nos desenhos). */
const WALL_FIXED = new Set(['elevator', 'door_frame', 'sign', 'light_switch']);
/** Assentos que viram lugar de trabalho extra (subagentes) quando listados em `seats`. */
const SEAT_KINDS = new Set(['stool', 'armchair', 'beanbag', 'cafe_chair', 'office_chair', 'office_chair_front', 'sofa', 'bench']);

export type CoreAreaKey = 'reception' | 'restroom' | 'cafe' | 'lounge' | 'corridor';
export const CORE_AREA_KEYS: readonly CoreAreaKey[] = ['reception', 'restroom', 'cafe', 'lounge', 'corridor'];

// ------------------------------------------------------------------ tipos do pacote (já validado)

/** Pixel art em texto: cada caractere de `rows` é uma cor da `palette` ('.' ou espaço = transparente). */
export interface PixelArt {
  palette: Record<string, string>;
  rows: string[];
}

export interface ItemDesign {
  id: string;
  /** `item:<id>`: o nome usado nas salas. */
  kind: string;
  name: string;
  description?: string;
  mount: 'floor' | 'wall';
  /** Footprint em tiles (parede: só a largura). */
  w: number;
  h: number;
  blocks: boolean;
  seat: boolean;
  /** URL do PNG (servidor: /api/assets/file/...) ou pixel art. */
  sprite?: string;
  front?: string;
  pixels?: PixelArt;
  frontPixels?: PixelArt;
  /** Ponto do sprite (px) que encosta no centro inferior do footprint (chão) ou no rodapé (parede). */
  anchor?: { x: number; y: number };
}

export interface Placement {
  kind: string;
  x: number;
  y: number;
  variant?: string;
}

export interface WallPlacement {
  kind: string;
  /** Centro do item na parede, em tiles locais (aceita .5). */
  x: number;
  variant?: string;
}

export interface DeskPlacement {
  x: number;
  y: number;
  /** 'up': quem senta fica ao sul, de costas para a câmera (tela visível); 'down': ao norte, de frente. */
  facing: 'up' | 'down';
  variant?: string;
  chair?: string;
}

export interface SeatPlacement {
  kind: string;
  x: number;
  y: number;
  dir: Dir;
  variant?: string;
}

export interface StandPlacement {
  x: number;
  y: number;
  dir: Dir;
}

export interface RugDesign {
  x: number;
  y: number;
  w: number;
  h: number;
  color?: string;
}

export interface RoomDesign {
  id: string;
  name: string;
  description?: string;
  floor: FloorKind;
  /** Tom sobre o piso (null = sem tom; ausente = cor do tema da sala). */
  floorTint?: string | null;
  wall?: Partial<WallStyle>;
  /** Cor principal (tapetes sem cor, pílula da sala). */
  carpet?: string;
  deskVariant?: string;
  chairVariant?: string;
  rugs: RugDesign[];
  desks: DeskPlacement[];
  seats: SeatPlacement[];
  furniture: Placement[];
  wallItems: WallPlacement[];
  stands: StandPlacement[];
}

export interface AreaDesign {
  wall?: Partial<WallStyle>;
  floor?: FloorKind;
  furniture: Placement[];
  wallItems: WallPlacement[];
}

export interface OfficeDesign {
  /** Sala usada por todos os projetos sem uma sala própria (ausente = salas procedurais). */
  defaultRoom?: string;
  /** Projeto (nome exibido, nome da pasta ou caminho completo) -> id da sala. */
  projects: Record<string, string>;
  /** Ajustes nas áreas comuns (piso/parede e itens extras onde houver espaço). */
  areas: Partial<Record<CoreAreaKey, AreaDesign>>;
}

export interface AssetProblem {
  file: string;
  level: 'error' | 'warn';
  message: string;
}

export interface AssetPack {
  /** Muda a cada recarga com conteúdo diferente. */
  version: number;
  items: ItemDesign[];
  rooms: RoomDesign[];
  office: OfficeDesign;
  problems: AssetProblem[];
}

export const EMPTY_PACK: AssetPack = { version: 0, items: [], rooms: [], office: { projects: {}, areas: {} }, problems: [] };

/** Resumo no snapshot (OfficeSnapshot.meta.assets): o cliente baixa o pacote quando a versão muda. */
export interface AssetsMeta {
  version: number;
  /** Pasta dos assets (o Arquiteto abre aqui). */
  dir: string;
  items: number;
  rooms: number;
  errors: number;
  warnings: number;
}

// ------------------------------------------------------------------ entrada crua (o servidor lê os arquivos)

export interface RawImage {
  w: number;
  h: number;
  url: string;
}

export interface RawAssets {
  items: { id: string; file: string; json: unknown; images: Record<string, RawImage | undefined> }[];
  rooms: { id: string; file: string; json: unknown }[];
  office?: { file: string; json: unknown };
}

// ------------------------------------------------------------------ utilidades

export function validId(id: string): boolean {
  return ID_RE.test(id);
}

/** Nome livre -> id de arquivo (minúsculas, sem acentos, hífens). */
export function slugId(name: string): string {
  const s = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return s || 'asset';
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const int = (v: unknown): number | undefined => {
  const n = num(v);
  return n === undefined ? undefined : Math.round(n);
};
const str = (v: unknown, max = 200): string | undefined => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);
const color = (v: unknown): string | undefined => (typeof v === 'string' && COLOR_RE.test(v.trim()) ? v.trim().toLowerCase() : undefined);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

class Report {
  readonly problems: AssetProblem[] = [];
  constructor(readonly file: string) {}
  error(message: string): void {
    this.problems.push({ file: this.file, level: 'error', message });
  }
  warn(message: string): void {
    this.problems.push({ file: this.file, level: 'warn', message });
  }
  get failed(): boolean {
    return this.problems.some((p) => p.level === 'error');
  }
}

/** Catálogo usado na validação: o embutido + os itens do usuário. */
export type Catalog = (kind: string) => FurnitureDef | undefined;

export function catalogWith(items: readonly ItemDesign[]): Catalog {
  const custom = new Map(items.map((i) => [i.kind, itemDef(i)]));
  return (kind) => (FURNITURE as Record<string, FurnitureDef>)[kind] ?? custom.get(kind);
}

export function itemDef(i: ItemDesign): FurnitureDef {
  return { mount: i.mount, footprint: { w: i.w, h: i.mount === 'wall' ? 0 : i.h }, blocks: i.mount === 'floor' && i.blocks && !i.seat, seat: i.seat || undefined };
}

// ------------------------------------------------------------------ itens

function pixelArt(v: unknown, r: Report, what: string): PixelArt | undefined {
  if (v === undefined) return undefined;
  if (!isObj(v) || !isObj(v.palette) || !Array.isArray(v.rows)) {
    r.error(`${what}: esperado { "palette": { "a": "#rrggbb" }, "rows": ["..a.."] }`);
    return undefined;
  }
  const palette: Record<string, string> = {};
  for (const [k, c] of Object.entries(v.palette)) {
    if ([...k].length !== 1 || k === '.' || k === ' ') {
      r.warn(`${what}: a chave "${k}" da paleta precisa ser 1 caractere (e não "." nem espaço)`);
      continue;
    }
    const col = typeof c === 'string' && /^#([0-9a-f]{6}|[0-9a-f]{8})$/i.test(c.trim()) ? c.trim().toLowerCase() : undefined;
    if (!col) r.warn(`${what}: cor inválida para "${k}" (use #rrggbb ou #rrggbbaa)`);
    else palette[k] = col;
  }
  const rows = v.rows.filter((x): x is string => typeof x === 'string');
  if (!rows.length) {
    r.error(`${what}: "rows" vazio`);
    return undefined;
  }
  const width = Math.max(...rows.map((x) => [...x].length));
  if (rows.length > SPRITE_MAX_PX || width > SPRITE_MAX_PX) {
    r.error(`${what}: no máximo ${SPRITE_MAX_PX}x${SPRITE_MAX_PX} pixels (tem ${width}x${rows.length})`);
    return undefined;
  }
  const unknown = new Set<string>();
  for (const row of rows) for (const ch of row) if (ch !== '.' && ch !== ' ' && !(ch in palette)) unknown.add(ch);
  if (unknown.size) r.warn(`${what}: caracteres sem cor na paleta ficam transparentes: ${[...unknown].join(' ')}`);
  return { palette, rows };
}

export function normalizeItem(id: string, json: unknown, images: Record<string, RawImage | undefined>, r: Report): ItemDesign | undefined {
  if (!validId(id)) {
    r.error(`id "${id}" inválido: use letras minúsculas, números, "-" e "_" (até 48)`);
    return undefined;
  }
  if (!isObj(json)) {
    r.error('item.json precisa ser um objeto JSON');
    return undefined;
  }
  const mount = json.mount === 'wall' ? 'wall' : 'floor';
  if (json.mount !== undefined && json.mount !== 'wall' && json.mount !== 'floor') r.warn('"mount" deve ser "floor" ou "wall" (usando "floor")');
  const clampDim = (v: unknown, max: number, label: string): number => {
    const n = int(v) ?? 1;
    if (n < 1 || n > max) r.warn(`"${label}" vai de 1 a ${max} (usando ${Math.min(max, Math.max(1, n))})`);
    return Math.min(max, Math.max(1, n));
  };
  const w = clampDim(json.w, ITEM_MAX_TILES.w, 'w');
  const h = mount === 'wall' ? 1 : clampDim(json.h, ITEM_MAX_TILES.h, 'h');
  const seat = mount === 'floor' && json.seat === true;
  const blocks = mount === 'floor' && !seat && json.blocks !== false;

  const image = (key: 'sprite' | 'front', fallback?: string): string | undefined => {
    const name = json[key] === undefined ? fallback : str(json[key], 120);
    if (!name) return undefined;
    const img = images[name];
    if (!img) {
      if (json[key] !== undefined) r.error(`"${key}": arquivo "${name}" não encontrado na pasta do item (só .png)`);
      return undefined;
    }
    if (img.w > SPRITE_MAX_PX || img.h > SPRITE_MAX_PX) {
      r.error(`"${key}": ${name} tem ${img.w}x${img.h}px; o máximo é ${SPRITE_MAX_PX}x${SPRITE_MAX_PX}`);
      return undefined;
    }
    return img.url;
  };
  const pixels = pixelArt(json.pixels, r, 'pixels');
  const frontPixels = pixelArt(json.frontPixels, r, 'frontPixels');
  const sprite = pixels ? undefined : image('sprite', 'sprite.png');
  const front = frontPixels ? undefined : image('front', images['front.png'] ? 'front.png' : undefined);
  if (!pixels && !sprite) {
    if (!r.failed) r.error('o item precisa de um desenho: "pixels" (pixel art em texto) ou um sprite.png na pasta');
    return undefined;
  }
  const a = json.anchor;
  const anchor = isObj(a) && num(a.x) !== undefined && num(a.y) !== undefined ? { x: Math.round(num(a.x)!), y: Math.round(num(a.y)!) } : undefined;
  return {
    id,
    kind: CUSTOM_PREFIX + id,
    name: str(json.name, 80) ?? id,
    description: str(json.description, 400),
    mount,
    w,
    h,
    blocks,
    seat,
    sprite,
    front,
    pixels,
    frontPixels,
    anchor,
  };
}

// ------------------------------------------------------------------ salas

/** Mapa de ocupação de uma sala (validação e prévia em texto). */
export class RoomGrid {
  readonly cells: string[][];
  /** Tiles que bloqueiam a passagem. */
  readonly solid: boolean[][];

  constructor() {
    this.cells = [];
    this.solid = [];
    for (let y = 0; y < ROOM_ROWS; y++) {
      this.cells.push([]);
      this.solid.push([]);
      for (let x = 0; x < ROOM_COLS; x++) {
        const inside = x >= INTERIOR.x0 && x <= INTERIOR.x1 && y >= INTERIOR.y0 && y <= INTERIOR.y1;
        this.cells[y].push(inside ? '.' : '#');
        this.solid[y].push(!inside);
      }
    }
    for (const x of CLEAR_COLS) for (const y of ENTRY_ROWS) this.cells[y][x] = ':';
  }

  /** Problema ao ocupar o retângulo, ou null. */
  problem(x: number, y: number, w: number, h: number): string | null {
    if (x < INTERIOR.x0 || y < INTERIOR.y0 || x + w - 1 > INTERIOR.x1 || y + h - 1 > INTERIOR.y1) return `fora do piso (colunas ${INTERIOR.x0}–${INTERIOR.x1}, linhas ${INTERIOR.y0}–${INTERIOR.y1})`;
    for (let yy = y; yy < y + h; yy++) {
      for (let xx = x; xx < x + w; xx++) {
        const c = this.cells[yy][xx];
        if (c === ':') return `em cima da passagem da porta (colunas 6–8 das linhas 2 e 10 ficam livres: porta e interruptor)`;
        if (c !== '.') return `em cima de outra coisa no tile (${xx},${yy})`;
      }
    }
    return null;
  }

  mark(x: number, y: number, w: number, h: number, ch: string, solid: boolean): void {
    for (let yy = y; yy < y + h; yy++) {
      for (let xx = x; xx < x + w; xx++) {
        this.cells[yy][xx] = ch;
        this.solid[yy][xx] = solid;
      }
    }
  }

  /** Tiles alcançáveis andando a partir das entradas de baixo (linha 10). */
  reachable(): boolean[][] {
    const seen = this.cells.map((row) => row.map(() => false));
    const queue: [number, number][] = [];
    for (const x of ENTRY_COLS) {
      seen[ENTRY_ROWS[1]][x] = true;
      queue.push([x, ENTRY_ROWS[1]]);
    }
    while (queue.length) {
      const [x, y] = queue.shift()!;
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ]) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= ROOM_COLS || ny >= ROOM_ROWS || seen[ny][nx] || this.solid[ny][nx]) continue;
        // assentos são caminháveis, mas ninguém atravessa um: só servem de destino
        if (!'.:px'.includes(this.cells[ny][nx])) continue;
        seen[ny][nx] = true;
        queue.push([nx, ny]);
      }
    }
    return seen;
  }

  /** Um tile (destino) é alcançável: ele mesmo ou um vizinho caminhável já alcançado. */
  static touches(seen: boolean[][], x: number, y: number): boolean {
    if (seen[y]?.[x]) return true;
    return [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ].some(([dx, dy]) => seen[y + dy]?.[x + dx]);
  }

  toText(): string {
    return this.cells.map((row, y) => `${String(y).padStart(2)} ${row.join('')}`).join('\n');
  }
}

const ASCII_LEGEND = '# parede/fora  . livre  : passagem da porta  D mesa  c cadeira de trabalho  s assento extra  p ponto em pé  o móvel  x não bloqueia';

function variantOf(def: FurnitureDef, v: unknown, r: Report, label: string): string | undefined {
  const s = str(v, 40);
  if (s === undefined) return undefined;
  if (!def.variants) {
    r.warn(`${label}: não tem variantes (ignorando "${s}")`);
    return undefined;
  }
  if (!def.variants.includes(s)) {
    r.warn(`${label}: variante "${s}" desconhecida (opções: ${def.variants.join(', ')})`);
    return undefined;
  }
  return s;
}

function wallStyle(v: unknown, r: Report, label: string): Partial<WallStyle> | undefined {
  if (v === undefined) return undefined;
  if (!isObj(v)) {
    r.warn(`${label}: esperado { "base": "#rrggbb", "trim": "#rrggbb", "pattern": "..." }`);
    return undefined;
  }
  const out: Partial<WallStyle> = {};
  if (v.base !== undefined) {
    const c = color(v.base);
    if (c) out.base = c;
    else r.warn(`${label}.base: cor inválida (use #rrggbb)`);
  }
  if (v.trim !== undefined) {
    const c = color(v.trim);
    if (c) out.trim = c;
    else r.warn(`${label}.trim: cor inválida (use #rrggbb)`);
  }
  if (v.pattern !== undefined) {
    if (PATTERNS.includes(v.pattern as WallPattern)) out.pattern = v.pattern as WallPattern;
    else r.warn(`${label}.pattern: use ${PATTERNS.join(', ')}`);
  }
  return Object.keys(out).length ? out : undefined;
}

function floorKind(v: unknown, r: Report, label: string): FloorKind | undefined {
  if (v === undefined) return undefined;
  if (FLOORS.includes(v as FloorKind)) return v as FloorKind;
  r.warn(`${label}: piso "${String(v)}" desconhecido (use ${FLOORS.join(', ')})`);
  return undefined;
}

function dirOf(v: unknown, fallback: Dir): Dir {
  return DIRS.includes(v as Dir) ? (v as Dir) : fallback;
}

/** Itens de parede de uma lista (sala ou área): checa tipo, sobreposição e o trecho reservado. */
function wallItemsOf(v: unknown, catalog: Catalog, r: Report, reserved: { x0: number; x1: number } | null, label = 'wallItems'): WallPlacement[] {
  const out: WallPlacement[] = [];
  const spans: [number, number][] = [];
  list(v).forEach((raw, i) => {
    const where = `${label}[${i}]`;
    if (!isObj(raw)) return r.warn(`${where}: esperado { "kind", "x" }`);
    const kind = str(raw.kind, 60);
    const def = kind ? catalog(kind) : undefined;
    if (!kind || !def) return r.warn(`${where}: "${kind ?? '?'}" não existe (veja a lista de kinds no CLAUDE.md)`);
    if (def.mount !== 'wall') return r.warn(`${where}: "${kind}" não é item de parede (vai em "furniture")`);
    if (WALL_FIXED.has(kind)) return r.warn(`${where}: "${kind}" é posicionado pelo próprio prédio`);
    const x = num(raw.x);
    if (x === undefined) return r.warn(`${where}: falta "x" (centro do item, em tiles)`);
    const cx = Math.round(x * 2) / 2;
    const half = def.footprint.w / 2;
    const span: [number, number] = [cx - half, cx + half];
    if (span[0] < 0.5 || span[1] > 15.5) return r.warn(`${where}: "${kind}" sai da parede (o centro precisa deixar o item entre 0.5 e 15.5)`);
    if (reserved && span[0] < reserved.x1 && span[1] > reserved.x0) return r.warn(`${where}: "${kind}" invade o trecho ${reserved.x0}–${reserved.x1} da parede (placa, porta e interruptor)`);
    if (spans.some(([a, b]) => span[0] < b && span[1] > a)) return r.warn(`${where}: "${kind}" fica em cima de outro item de parede`);
    spans.push(span);
    out.push({ kind, x: cx, variant: variantOf(def, raw.variant, r, where) });
  });
  return out;
}

export interface RoomCheck {
  room?: RoomDesign;
  /** Mapa em texto (para o STATUS.md e o agente conferir o resultado). */
  map?: string;
  walls?: string;
}

/** Valida e limpa uma sala. Sem `room` = a sala não pode ser usada (erro). */
export function normalizeRoom(id: string, json: unknown, catalog: Catalog, r: Report): RoomCheck {
  if (!validId(id)) {
    r.error(`id "${id}" inválido: use letras minúsculas, números, "-" e "_" (até 48)`);
    return {};
  }
  if (!isObj(json)) {
    r.error('a sala precisa ser um objeto JSON');
    return {};
  }
  const grid = new RoomGrid();
  const room: RoomDesign = {
    id,
    name: str(json.name, 80) ?? id,
    description: str(json.description, 400),
    floor: floorKind(json.floor, r, 'floor') ?? 'marble',
    floorTint: json.floorTint === null ? null : json.floorTint === undefined ? undefined : (color(json.floorTint) ?? (r.warn('floorTint: cor inválida (use #rrggbb ou null)'), undefined)),
    wall: wallStyle(json.wall, r, 'wall'),
    carpet: json.carpet === undefined ? undefined : (color(json.carpet) ?? (r.warn('carpet: cor inválida (use #rrggbb)'), undefined)),
    deskVariant: json.deskVariant === undefined ? undefined : variantOf(FURNITURE.desk, json.deskVariant, r, 'deskVariant'),
    chairVariant: json.chairVariant === undefined ? undefined : variantOf(FURNITURE.office_chair, json.chairVariant, r, 'chairVariant'),
    rugs: [],
    desks: [],
    seats: [],
    furniture: [],
    wallItems: [],
    stands: [],
  };

  list(json.rugs).forEach((raw, i) => {
    const where = `rugs[${i}]`;
    if (!isObj(raw)) return r.warn(`${where}: esperado { "x", "y", "w", "h", "color" }`);
    const [x, y, w, h] = [num(raw.x), num(raw.y), num(raw.w), num(raw.h)];
    if (x === undefined || y === undefined || !w || !h || w <= 0 || h <= 0) return r.warn(`${where}: "x", "y", "w" e "h" são obrigatórios`);
    if (x < INTERIOR.x0 - 0.5 || y < INTERIOR.y0 - 0.5 || x + w > INTERIOR.x1 + 1.5 || y + h > INTERIOR.y1 + 1.5) return r.warn(`${where}: fora do piso`);
    room.rugs.push({ x, y, w, h, color: raw.color === undefined ? undefined : color(raw.color) });
  });

  // mesas: a mesa (2x1) + a cadeira na frente (sul quando 'up', norte quando 'down')
  list(json.desks).forEach((raw, i) => {
    const where = `desks[${i}]`;
    if (!isObj(raw)) return r.warn(`${where}: esperado { "x", "y", "facing" }`);
    if (room.desks.length >= MAX_DESKS) return r.warn(`${where}: no máximo ${MAX_DESKS} mesas`);
    const x = int(raw.x);
    const y = int(raw.y);
    if (x === undefined || y === undefined) return r.warn(`${where}: "x" e "y" são obrigatórios`);
    const facing = raw.facing === 'down' ? 'down' : 'up';
    const cy = facing === 'up' ? y + 1 : y - 1;
    const p = grid.problem(x, y, 2, 1) ?? grid.problem(x, cy, 1, 1);
    if (p) return r.warn(`${where}: mesa em (${x},${y}) ${p}`);
    grid.mark(x, y, 2, 1, 'D', true);
    grid.mark(x, cy, 1, 1, 'c', false);
    room.desks.push({
      x,
      y,
      facing,
      variant: variantOf(FURNITURE.desk, raw.variant, r, where),
      chair: variantOf(FURNITURE.office_chair, raw.chair, r, `${where}.chair`),
    });
  });

  list(json.seats).forEach((raw, i) => {
    const where = `seats[${i}]`;
    if (!isObj(raw)) return r.warn(`${where}: esperado { "kind", "x", "y", "dir" }`);
    const kind = str(raw.kind, 60) ?? 'stool';
    const def = catalog(kind);
    if (!def || def.mount !== 'floor' || !def.seat) return r.warn(`${where}: "${kind}" não é um assento (${[...SEAT_KINDS].join(', ')} ou item com "seat": true)`);
    if (!SEAT_KINDS.has(kind) && !kind.startsWith(CUSTOM_PREFIX)) return r.warn(`${where}: "${kind}" não serve de assento extra`);
    const x = int(raw.x);
    const y = int(raw.y);
    if (x === undefined || y === undefined) return r.warn(`${where}: "x" e "y" são obrigatórios`);
    const { w, h } = def.footprint;
    const p = grid.problem(x, y, w, h);
    if (p) return r.warn(`${where}: "${kind}" em (${x},${y}) ${p}`);
    grid.mark(x, y, w, h, 's', false);
    room.seats.push({ kind, x, y, dir: dirOf(raw.dir, 'down'), variant: variantOf(def, raw.variant, r, where) });
  });

  list(json.furniture).forEach((raw, i) => {
    const where = `furniture[${i}]`;
    if (!isObj(raw)) return r.warn(`${where}: esperado { "kind", "x", "y" }`);
    const kind = str(raw.kind, 60);
    const def = kind ? catalog(kind) : undefined;
    if (!kind || !def) return r.warn(`${where}: "${kind ?? '?'}" não existe (veja a lista de kinds no CLAUDE.md)`);
    if (def.mount !== 'floor') return r.warn(`${where}: "${kind}" é item de parede (vai em "wallItems")`);
    const x = int(raw.x);
    const y = int(raw.y);
    if (x === undefined || y === undefined) return r.warn(`${where}: "x" e "y" são obrigatórios`);
    const { w, h } = def.footprint;
    const p = grid.problem(x, y, w, h);
    if (p) return r.warn(`${where}: "${kind}" em (${x},${y}) ${p}`);
    grid.mark(x, y, w, h, def.blocks ? 'o' : 'x', def.blocks);
    room.furniture.push({ kind, x, y, variant: variantOf(def, raw.variant, r, where) });
  });

  list(json.stands).forEach((raw, i) => {
    const where = `stands[${i}]`;
    if (!isObj(raw)) return r.warn(`${where}: esperado { "x", "y", "dir" }`);
    const x = int(raw.x);
    const y = int(raw.y);
    if (x === undefined || y === undefined) return r.warn(`${where}: "x" e "y" são obrigatórios`);
    const p = grid.problem(x, y, 1, 1);
    if (p) return r.warn(`${where}: ponto em pé em (${x},${y}) ${p}`);
    grid.mark(x, y, 1, 1, 'p', false);
    room.stands.push({ x, y, dir: dirOf(raw.dir, 'up') });
  });

  room.wallItems = wallItemsOf(json.wallItems, catalog, r, WALL_RESERVED);

  // caminhos: as duas entradas se ligam e todo lugar é alcançável
  const seen = grid.reachable();
  if (!ENTRY_COLS.some((x) => seen[ENTRY_ROWS[0]][x])) {
    r.error('não há caminho entre a entrada de baixo (linha 10) e a de cima (linha 2): libere uma passagem');
  }
  const deskSeat = (d: DeskPlacement) => [d.x, d.facing === 'up' ? d.y + 1 : d.y - 1] as const;
  room.desks = room.desks.filter((d, i) => {
    const [x, y] = deskSeat(d);
    if (RoomGrid.touches(seen, x, y)) return true;
    r.warn(`desks[${i}]: ninguém chega à cadeira em (${x},${y}); a mesa foi ignorada`);
    grid.mark(d.x, d.y, 2, 1, '.', false);
    grid.mark(x, y, 1, 1, '.', false);
    return false;
  });
  room.seats = room.seats.filter((s, i) => {
    if (RoomGrid.touches(seen, s.x, s.y)) return true;
    r.warn(`seats[${i}]: ninguém chega ao assento em (${s.x},${s.y}); foi ignorado`);
    return false;
  });
  room.stands = room.stands.filter((s, i) => {
    if (seen[s.y][s.x]) return true;
    r.warn(`stands[${i}]: ninguém chega ao ponto em (${s.x},${s.y}); foi ignorado`);
    return false;
  });
  if (!room.desks.length) r.error('a sala precisa de pelo menos uma mesa alcançável em "desks" (é onde o agente principal trabalha)');

  const walls = room.wallItems.map((w) => `${w.kind}${w.variant ? `(${w.variant})` : ''} @ x=${w.x}`).join(', ') || '(nenhum)';
  return { room: r.failed ? undefined : room, map: `${grid.toText()}\n   ${ASCII_LEGEND}`, walls };
}

// ------------------------------------------------------------------ arquitetura (office.json)

function areaDesign(v: unknown, catalog: Catalog, r: Report, key: string): AreaDesign | undefined {
  if (!isObj(v)) {
    r.warn(`areas.${key}: esperado um objeto`);
    return undefined;
  }
  const furniture: Placement[] = [];
  list(v.furniture).forEach((raw, i) => {
    const where = `areas.${key}.furniture[${i}]`;
    if (!isObj(raw)) return r.warn(`${where}: esperado { "kind", "x", "y" }`);
    const kind = str(raw.kind, 60);
    const def = kind ? catalog(kind) : undefined;
    if (!kind || !def || def.mount !== 'floor') return r.warn(`${where}: "${kind ?? '?'}" não é um móvel de chão conhecido`);
    const x = int(raw.x);
    const y = int(raw.y);
    if (x === undefined || y === undefined) return r.warn(`${where}: "x" e "y" são obrigatórios`);
    furniture.push({ kind, x, y, variant: variantOf(def, raw.variant, r, where) });
  });
  return {
    wall: wallStyle(v.wall, r, `areas.${key}.wall`),
    floor: floorKind(v.floor, r, `areas.${key}.floor`),
    furniture,
    wallItems: wallItemsOf(v.wallItems, catalog, r, null, `areas.${key}.wallItems`),
  };
}

export function normalizeOffice(json: unknown, catalog: Catalog, rooms: ReadonlySet<string>, r: Report): OfficeDesign {
  const office: OfficeDesign = { projects: {}, areas: {} };
  if (!isObj(json)) {
    r.error('office.json precisa ser um objeto JSON');
    return office;
  }
  if (json.defaultRoom !== undefined && json.defaultRoom !== null) {
    const id = str(json.defaultRoom, 60);
    if (id && rooms.has(id)) office.defaultRoom = id;
    else r.warn(`defaultRoom: a sala "${String(json.defaultRoom)}" não existe ou tem erros`);
  }
  if (isObj(json.projects)) {
    for (const [project, raw] of Object.entries(json.projects)) {
      const id = str(raw, 60);
      if (id && rooms.has(id)) office.projects[project] = id;
      else r.warn(`projects["${project}"]: a sala "${String(raw)}" não existe ou tem erros`);
    }
  } else if (json.projects !== undefined) r.warn('projects: esperado { "nome-do-projeto": "id-da-sala" }');
  if (isObj(json.areas)) {
    for (const [key, raw] of Object.entries(json.areas)) {
      if (!CORE_AREA_KEYS.includes(key as CoreAreaKey)) {
        r.warn(`areas.${key}: área desconhecida (use ${CORE_AREA_KEYS.join(', ')})`);
        continue;
      }
      const a = areaDesign(raw, catalog, r, key);
      if (a) office.areas[key as CoreAreaKey] = a;
    }
  } else if (json.areas !== undefined) r.warn('areas: esperado um objeto');
  return office;
}

// ------------------------------------------------------------------ pacote

export interface PackBuild {
  pack: AssetPack;
  /** Prévia em texto de cada sala (STATUS.md). */
  maps: Record<string, { map: string; walls: string }>;
}

export function buildPack(raw: RawAssets, version: number, extraProblems: AssetProblem[] = []): PackBuild {
  const problems: AssetProblem[] = [...extraProblems];
  const items: ItemDesign[] = [];
  for (const it of raw.items) {
    const r = new Report(it.file);
    const item = normalizeItem(it.id, it.json, it.images, r);
    problems.push(...r.problems);
    if (item) items.push(item);
  }
  const catalog = catalogWith(items);
  const rooms: RoomDesign[] = [];
  const maps: PackBuild['maps'] = {};
  for (const rm of raw.rooms) {
    const r = new Report(rm.file);
    const c = normalizeRoom(rm.id, rm.json, catalog, r);
    problems.push(...r.problems);
    if (c.room) rooms.push(c.room);
    if (c.map) maps[rm.id] = { map: c.map, walls: c.walls ?? '' };
  }
  let office: OfficeDesign = { projects: {}, areas: {} };
  if (raw.office) {
    const r = new Report(raw.office.file);
    office = normalizeOffice(raw.office.json, catalog, new Set(rooms.map((x) => x.id)), r);
    problems.push(...r.problems);
  }
  return { pack: { version, items, rooms, office, problems }, maps };
}

/** Caminho comparável (barras normais, sem barra final, sem diferença de maiúsculas). */
function pathKey(p: string): string {
  return p.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/** Sala desenhada para um projeto: pelo caminho, pelo nome exibido ou pelo nome da pasta; senão a padrão. */
export function roomDesignFor(pack: AssetPack, project: { name: string; path: string }): RoomDesign | undefined {
  const byId = (id: string | undefined) => (id ? pack.rooms.find((r) => r.id === id) : undefined);
  const path = pathKey(project.path);
  const base = path.split('/').pop() ?? '';
  const name = project.name.trim().toLowerCase();
  const entries = Object.entries(pack.office.projects);
  const hit =
    entries.find(([k]) => pathKey(k) === path) ??
    entries.find(([k]) => k.trim().toLowerCase() === name) ??
    entries.find(([k]) => k.trim().toLowerCase() === base);
  return byId(hit?.[1]) ?? byId(pack.office.defaultRoom);
}

// ------------------------------------------------------------------ exportar/importar

/** Pacote para compartilhar (um arquivo .habblaud.json): JSON dos arquivos + imagens em base64. */
export interface AssetBundle {
  format: 'habblaud-assets';
  version: 1;
  name: string;
  exportedAt: string;
  items: Record<string, { json: unknown; files: Record<string, string> }>;
  rooms: Record<string, unknown>;
  office?: unknown;
}

export const BUNDLE_FORMAT = 'habblaud-assets';

/** Itens do usuário usados por uma sala (ou área) crua: ids sem o prefixo. */
export function referencedItems(json: unknown): string[] {
  const out = new Set<string>();
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (isObj(v)) {
      for (const [k, x] of Object.entries(v)) {
        if (k === 'kind' && typeof x === 'string' && x.startsWith(CUSTOM_PREFIX)) out.add(x.slice(CUSTOM_PREFIX.length));
        else walk(x);
      }
    }
  };
  walk(json);
  return [...out];
}

/** Troca referências `item:<de>` por `item:<para>` (importação com ids renomeados). */
export function renameItemRefs(json: unknown, map: ReadonlyMap<string, string>): unknown {
  if (!map.size) return json;
  if (Array.isArray(json)) return json.map((v) => renameItemRefs(v, map));
  if (!isObj(json)) return json;
  const out: Obj = {};
  for (const [k, v] of Object.entries(json)) {
    if (k === 'kind' && typeof v === 'string' && v.startsWith(CUSTOM_PREFIX)) {
      const to = map.get(v.slice(CUSTOM_PREFIX.length));
      out[k] = to ? CUSTOM_PREFIX + to : v;
    } else out[k] = renameItemRefs(v, map);
  }
  return out;
}

/** Confere a forma do pacote. Devolve a mensagem de erro, ou null. */
export function bundleProblem(v: unknown): string | null {
  if (!isObj(v) || v.format !== BUNDLE_FORMAT) return 'não é um pacote do Habblaud (format: "habblaud-assets")';
  if (v.version !== 1) return `versão de pacote não suportada: ${String(v.version)}`;
  if (!isObj(v.items) || !isObj(v.rooms)) return 'pacote sem "items"/"rooms"';
  for (const [id, it] of Object.entries(v.items)) {
    if (!isObj(it) || !isObj(it.files)) return `item "${id}" malformado`;
    for (const [name, data] of Object.entries(it.files)) {
      if (!/^[a-z0-9_-]+\.png$/i.test(name) || typeof data !== 'string') return `arquivo "${name}" do item "${id}" inválido (só .png)`;
    }
  }
  return null;
}
