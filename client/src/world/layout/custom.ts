// Assets do usuário no prédio (formato e validação em shared/assets.ts): salas desenhadas à mão no lugar das
// procedurais e ajustes nas áreas comuns. O pacote fica aqui (módulo) porque o layout é chamado de vários lugares
// da simulação; quem troca o pacote (world/index.ts) reconstrói o mundo em seguida.
import { roomDesignFor, EMPTY_PACK, itemDef, type AreaDesign, type AssetPack, type CoreAreaKey, type RoomDesign } from '../../../../shared/assets';
import { setCustomFurniture } from '../../../../shared/furniture';
import { furnitureDef, type Dir, type FurnitureKind, type RoomTheme, type WallStyle } from '../../art/api';
import { DOOR_W, DOOR_X, TILE } from '../constants';
import { AreaBuilder, furnitureBlocks } from './builder';
import { CORRIDOR_ID } from './corridor';
import { CAFE_ID, LOUNGE_ID, RECEPTION_ID, RESTROOM_ID } from './core';
import { slotRect, slotSide } from './geometry';
import type { AreaLayout, SpotKind } from './types';

let pack: AssetPack = EMPTY_PACK;

/** Troca o pacote de assets (itens entram no catálogo de móveis na hora). */
export function setDesignPack(next: AssetPack): void {
  pack = next;
  setCustomFurniture(next.items.map((i) => [i.kind, itemDef(i)]));
}

export function designPack(): AssetPack {
  return pack;
}

/** Sala desenhada para o projeto (pelo nome ou caminho), ou undefined = procedural. */
export function projectDesign(project: { name: string; path: string }): RoomDesign | undefined {
  return pack.rooms.length ? roomDesignFor(pack, project) : undefined;
}

const AREA_IDS: Record<CoreAreaKey, string> = {
  reception: RECEPTION_ID,
  restroom: RESTROOM_ID,
  cafe: CAFE_ID,
  lounge: LOUNGE_ID,
  corridor: CORRIDOR_ID,
};

/** Assentos que viram "stool" na simulação; o resto vira "nook" (lugar extra com notebook). */
const STOOL_SEATS = new Set(['stool', 'cafe_chair']);

/** Sala de projeto a partir de um desenho do usuário (mesmas regras de porta e paredes da procedural). */
export function layoutCustomRoom(room: { id: string; slot: number; seed: number }, theme: RoomTheme, d: RoomDesign): AreaLayout {
  const rect = slotRect(room.slot);
  const side = slotSide(room.slot);
  const north = side === 'north';
  const b = new AreaBuilder(room.id, 'room', rect);
  const area = b.area;
  area.side = side;
  const wall: WallStyle = { ...theme.wall, ...d.wall };
  const carpet = d.carpet ?? theme.carpet;
  const door = { lx: DOOR_X, w: DOOR_W };

  b.floor(d.floor, 0, 0, 16, 12, room.seed, d.floor === 'carpet' ? carpet : undefined, d.floor === 'carpet' ? theme.carpet2 : undefined);
  if (d.floorTint !== null) area.floorTint = d.floorTint ?? (d.floor === 'carpet' ? undefined : carpet);
  d.rugs.forEach((r, i) => b.rug(r.x, r.y, r.w, r.h, r.color ?? carpet, room.seed + 10 + i));

  // ---- paredes e porta (como em room.ts)
  if (north) {
    b.face(0.5, 15, wall);
    b.south(0.5, 15, 11, wall, [door]);
  } else {
    b.face(0.5, 15, wall, [door]);
    b.south(0.5, 15, 11, { ...wall, exterior: true });
    b.wall('door_frame', DOOR_X + DOOR_W / 2, undefined, { order: 0.05 });
  }
  b.cap(0, 0, 0.5, 12, wall);
  b.cap(15.5, 0, 0.5, 12, wall);
  b.walk(1, 2, 14, 9);
  area.door = north ? { x: rect.x + DOOR_X, y: rect.y + 11, w: DOOR_W, h: 1 } : { x: rect.x + DOOR_X, y: rect.y, w: DOOR_W, h: 2 };
  b.walk(area.door.x - rect.x, area.door.y - rect.y, area.door.w, area.door.h);

  area.signId = b.wall('sign', north ? 8 : 10.5, undefined, { order: 0.95 });
  if (north) {
    b.wall('light_switch', DOOR_X - 0.5, 'on', { ly: 12, on: 'south', order: 0.8 });
    b.spot('switch', DOOR_X - 1, 10, 'down', { dy: -1 });
  } else {
    b.wall('light_switch', DOOR_X - 0.5, 'on', { order: 0.8 });
    b.spot('switch', DOOR_X - 1, 2, 'up', { dy: -3 });
  }

  // tiles ocupados (para os pontos automáticos na frente do quadro)
  const taken = new Set<string>();
  const take = (x: number, y: number, w = 1, h = 1) => {
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) taken.add(`${xx},${yy}`);
  };

  // ---- mesas (a ordem da lista é a preferência)
  const n = d.desks.length;
  d.desks.forEach((desk, i) => {
    const up = desk.facing === 'up';
    const sideKey = up ? 'S' : 'N';
    const deskId = b.furn(up ? 'desk' : 'desk_back', desk.x, desk.y, desk.variant ?? d.deskVariant ?? theme.deskVariant, { order: 0.35 + (i / n) * 0.1, seat: `${sideKey}${i}` });
    const cy = up ? desk.y + 1 : desk.y - 1;
    b.seat('desk', up ? 'office_chair' : 'office_chair_front', desk.x, cy, up ? 'up' : 'down', desk.chair ?? d.chairVariant ?? theme.chairVariant, {
      dx: TILE / 2,
      deskId,
      rank: i,
      side: sideKey,
      order: 0.55 + (i / n) * 0.1,
    });
    take(desk.x, desk.y, 2);
    take(desk.x, cy);
  });

  // ---- assentos extras
  d.seats.forEach((s, i) => {
    const o = 0.65 + i * 0.01;
    const spotKind: SpotKind = STOOL_SEATS.has(s.kind) ? 'stool' : 'nook';
    const def = furnitureDef(s.kind);
    take(s.x, s.y, def.footprint.w, def.footprint.h);
    const kind = s.kind as FurnitureKind;
    if (kind === 'sofa' || kind === 'bench') {
      const dir: Dir = kind === 'bench' ? 'down' : s.dir === 'up' ? 'up' : 'down';
      const id = b.furn(kind, s.x, s.y, kind === 'sofa' ? dir : undefined, { order: o });
      for (let k = 0; k < def.footprint.w; k++) b.seat(spotKind, kind, s.x + k, s.y, dir, undefined, { noFurniture: true, furnitureId: id });
      return;
    }
    const variant = kind === 'armchair' || kind === 'cafe_chair' ? s.dir : s.variant;
    const dir: Dir = kind === 'office_chair' ? 'up' : kind === 'office_chair_front' ? 'down' : s.dir;
    b.seat(spotKind, kind, s.x, s.y, dir, variant, { order: o });
  });

  // ---- decoração
  d.furniture.forEach((f, i) => {
    const def = furnitureDef(f.kind);
    take(f.x, f.y, def.footprint.w, def.footprint.h);
    b.furn(f.kind as FurnitureKind, f.x, f.y, f.variant, { order: 0.2 + (i % 20) * 0.01 });
  });
  d.stands.forEach((s) => {
    take(s.x, s.y);
    b.spot('stand', s.x, s.y, s.dir, s.dir === 'up' ? { dy: -2 } : {});
  });
  d.wallItems.forEach((w, i) => {
    b.wall(w.kind as FurnitureKind, w.x, w.variant, { order: 0.4 + (i % 10) * 0.02 });
    // quadro kanban: um ponto de leitura logo abaixo, se o tile estiver livre
    const tx = Math.floor(w.x - 0.5);
    if (w.kind === 'whiteboard' && !taken.has(`${tx},2`)) {
      take(tx, 2);
      b.spot('whiteboard', tx, 2, 'up', { x: b.px(w.x), y: b.py(2) + 13 });
    }
  });

  const p = { x: rect.x * TILE, y: rect.y * TILE, w: rect.w * TILE, h: rect.h * TILE };
  area.shade = north ? { x: p.x, y: p.y, w: p.w, h: p.h - TILE } : { x: p.x, y: p.y, w: p.w, h: p.h };
  return b.build();
}

/**
 * Ajustes do usuário numa área comum: piso e paredes (menos o vidro) e itens extras só onde há espaço livre (sem
 * cobrir móvel, ponto de interesse, porta nem a passagem do corredor). Devolve a própria área (modificada).
 */
export function applyAreaDesign(area: AreaLayout): AreaLayout {
  const key = (Object.keys(AREA_IDS) as CoreAreaKey[]).find((k) => AREA_IDS[k] === area.id);
  const d: AreaDesign | undefined = key ? pack.office.areas[key] : undefined;
  if (!d || !key) return area;
  if (d.floor) for (const f of area.floors) f.kind = d.floor;
  if (d.wall) {
    area.walls = area.walls.map((w) => (w.style.pattern === 'glass' ? w : { ...w, style: { ...w.style, ...d.wall, exterior: w.style.exterior } }));
  }
  const r = area.rect;
  const busy = new Set<string>();
  const mark = (x: number, y: number, w: number, h: number) => {
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) busy.add(`${xx},${yy}`);
  };
  for (const f of area.furniture) {
    const def = furnitureDef(f.kind);
    mark(f.tx, f.ty, def.footprint.w, def.footprint.h);
  }
  for (const s of area.spots) mark(s.tx, s.ty, 1, 1);
  for (const b of area.blocked ?? []) mark(b.x, b.y, b.w, b.h);
  if (area.door) mark(area.door.x, area.door.y, area.door.w, area.door.h);
  const walkable = (x: number, y: number) => area.walkable.some((w) => x >= w.x && y >= w.y && x < w.x + w.w && y < w.y + w.h);
  const b = new AreaBuilder(area.id, area.kind, r);
  d.furniture.forEach((f, i) => {
    const def = furnitureDef(f.kind);
    const x = r.x + f.x;
    const y = r.y + f.y;
    let ok = true;
    for (let yy = y; yy < y + def.footprint.h && ok; yy++) {
      for (let xx = x; xx < x + def.footprint.w && ok; xx++) {
        // corredor: só nas bordas (linhas 0 e 4), para nunca fechar a passagem
        if (busy.has(`${xx},${yy}`) || !walkable(xx, yy) || (key === 'corridor' && yy !== r.y && yy !== r.y + r.h - 1)) ok = false;
      }
    }
    if (!ok) {
      console.warn(`[assets] areas.${key}.furniture[${i}] (${f.kind}) não cabe em (${f.x},${f.y}); ignorado`);
      return;
    }
    mark(x, y, def.footprint.w, def.footprint.h);
    const id = `${area.id}#u${i}:${f.kind}`;
    area.furniture.push({ id, kind: f.kind as FurnitureKind, variant: f.variant, tx: x, ty: y, order: 0.6 });
    if (!furnitureBlocks(f.kind as FurnitureKind) && def.seat) {
      // assento extra: vira lugar de descanso (mesma lógica dos puffs do lounge)
      const s = b.seat('beanbag', f.kind as FurnitureKind, f.x, f.y, 'down', undefined, { noFurniture: true, furnitureId: id });
      area.spots.push({ ...s, id: `${area.id}#us${i}:beanbag` });
    }
  });
  // itens de parede: só sobre a face norte, longe das passagens e dos itens que já estão lá
  const faces = area.walls.filter((w): w is Extract<typeof w, { kind: 'face' }> => w.kind === 'face');
  const spans = area.wallItems.map((w) => {
    const half = (furnitureDef(w.kind).footprint.w * TILE) / 2;
    return [w.cx - half, w.cx + half] as const;
  });
  d.wallItems.forEach((w, i) => {
    const half = (furnitureDef(w.kind).footprint.w * TILE) / 2;
    const cx = Math.round((r.x + w.x) * TILE);
    const a = cx - half;
    const z = cx + half;
    const face = faces.find((f) => a >= f.x && z <= f.x + f.w && !(f.doorways ?? []).some((dw) => a < dw.x + dw.w && z > dw.x));
    if (!face || spans.some(([s0, s1]) => a < s1 && z > s0)) {
      console.warn(`[assets] areas.${key}.wallItems[${i}] (${w.kind}) não cabe na parede em x=${w.x}; ignorado`);
      return;
    }
    spans.push([a, z]);
    area.wallItems.push({ id: `${area.id}#uw${i}:${w.kind}`, kind: w.kind as FurnitureKind, variant: w.variant, cx, baseY: face.y + 2 * TILE, on: 'face', order: 0.6 });
  });
  return area;
}
