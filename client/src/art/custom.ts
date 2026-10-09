// Sprites dos itens criados pelo usuário (pasta de assets, shared/assets.ts): pixel art em texto ou PNG servido
// pelo Habblaud. Carregados de uma vez quando o pacote chega (loadCustomSprites) e servidos de forma síncrona pelo
// furnitureSprites do módulo de arte. Item desconhecido ou que falhou vira uma caixinha, nunca um erro.
import type { ItemDesign, PixelArt } from '../../../shared/assets';
import type { FurnitureSprites, Sprite } from './api';

/** Base de um item de parede: um pouco acima do rodapé (a face da parede tem 2 tiles). */
const WALL_LIFT = 4;

let sprites = new Map<string, FurnitureSprites>();
let placeholder: FurnitureSprites | null = null;

function canvasOf(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = Math.max(1, w);
  c.height = Math.max(1, h);
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  return [c, ctx];
}

export function pixelCanvas(art: PixelArt): HTMLCanvasElement {
  const w = Math.max(...art.rows.map((r) => [...r].length));
  const [c, ctx] = canvasOf(w, art.rows.length);
  art.rows.forEach((row, y) => {
    [...row].forEach((ch, x) => {
      const col = art.palette[ch];
      if (!col) return;
      ctx.fillStyle = col;
      ctx.fillRect(x, y, 1, 1);
    });
  });
  return c;
}

function imageCanvas(url: string): Promise<HTMLCanvasElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => {
      if (!img.naturalWidth) return resolve(null);
      const [c, ctx] = canvasOf(img.naturalWidth, img.naturalHeight);
      ctx.drawImage(img, 0, 0);
      resolve(c);
    };
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

function toSprite(item: ItemDesign, canvas: HTMLCanvasElement): Sprite {
  const ax = item.anchor?.x ?? Math.floor(canvas.width / 2);
  const ay = item.anchor?.y ?? (item.mount === 'wall' ? canvas.height + WALL_LIFT : canvas.height);
  return { canvas, ax, ay };
}

async function spritesOf(item: ItemDesign): Promise<FurnitureSprites | null> {
  const base = item.pixels ? pixelCanvas(item.pixels) : item.sprite ? await imageCanvas(item.sprite) : null;
  if (!base) return null;
  const front = item.frontPixels ? pixelCanvas(item.frontPixels) : item.front ? await imageCanvas(item.front) : null;
  return { base: toSprite(item, base), front: front ? toSprite(item, front) : undefined };
}

/** Prepara os sprites de todos os itens do pacote e passa a usá-los. */
export async function loadCustomSprites(items: readonly ItemDesign[]): Promise<void> {
  const next = new Map<string, FurnitureSprites>();
  const built = await Promise.all(items.map((i) => spritesOf(i).catch(() => null)));
  items.forEach((item, i) => {
    const s = built[i];
    if (s) next.set(item.kind, s);
  });
  sprites = next;
}

/** Caixinha de papelão para item sem desenho (pasta apagada, PNG que não carregou). */
function box(): FurnitureSprites {
  if (placeholder) return placeholder;
  const [c, ctx] = canvasOf(14, 13);
  ctx.fillStyle = '#7a5a3a';
  ctx.fillRect(0, 2, 14, 11);
  ctx.fillStyle = '#c99a62';
  ctx.fillRect(1, 3, 12, 9);
  ctx.fillStyle = '#e3b97f';
  ctx.fillRect(1, 0, 12, 3);
  ctx.fillStyle = '#7a5a3a';
  ctx.fillRect(6, 0, 2, 12);
  placeholder = { base: { canvas: c, ax: 7, ay: 13 } };
  return placeholder;
}

export function customFurnitureSprites(kind: string): FurnitureSprites {
  return sprites.get(kind) ?? box();
}
