import { describe, expect, it } from 'vitest';
import { buildPack, bundleProblem, referencedItems, renameItemRefs, roomDesignFor, slugId, type RawAssets } from './assets';

const PIXELS = { palette: { a: '#112233' }, rows: ['aa', 'aa'] };

function raw(rooms: Record<string, unknown>, extra: Partial<RawAssets> = {}): RawAssets {
  return { items: [], rooms: Object.entries(rooms).map(([id, json]) => ({ id, file: `rooms/${id}.json`, json })), ...extra };
}

const desk = (x: number, y: number, facing: 'up' | 'down' = 'up') => ({ x, y, facing });

describe('itens', () => {
  it('aceita pixel art em texto e vira item:<id>', () => {
    const { pack } = buildPack({ items: [{ id: 'puff', file: 'items/puff/item.json', json: { name: 'Puff', seat: true, pixels: PIXELS }, images: {} }], rooms: [] }, 1);
    expect(pack.items).toHaveLength(1);
    expect(pack.items[0]).toMatchObject({ kind: 'item:puff', seat: true, blocks: false, mount: 'floor', w: 1, h: 1 });
    expect(pack.problems).toEqual([]);
  });

  it('sem desenho é erro; PNG grande demais também', () => {
    const { pack } = buildPack(
      {
        items: [
          { id: 'nada', file: 'a', json: { name: 'x' }, images: {} },
          { id: 'enorme', file: 'b', json: {}, images: { 'sprite.png': { w: 200, h: 10, url: '/x' } } },
        ],
        rooms: [],
      },
      1,
    );
    expect(pack.items).toEqual([]);
    expect(pack.problems.filter((p) => p.level === 'error')).toHaveLength(2);
  });
});

describe('salas', () => {
  it('sala mínima válida e mapa em texto', () => {
    const b = buildPack(raw({ zen: { desks: [desk(2, 6)] } }), 1);
    expect(b.pack.rooms.map((r) => r.id)).toEqual(['zen']);
    expect(b.maps.zen.map).toContain('DD');
  });

  it('sem mesa é erro', () => {
    const b = buildPack(raw({ vazia: { furniture: [{ kind: 'plant_tall', x: 2, y: 2 }] } }), 1);
    expect(b.pack.rooms).toEqual([]);
    expect(b.pack.problems.some((p) => p.level === 'error' && p.message.includes('mesa'))).toBe(true);
  });

  it('descarta sobreposição, passagem da porta, fora do piso e kinds desconhecidos', () => {
    const { pack } = buildPack(
      raw({
        s: {
          desks: [desk(2, 6), desk(3, 6)],
          furniture: [
            { kind: 'plant_tall', x: 7, y: 10 },
            { kind: 'plant_tall', x: 0, y: 5 },
            { kind: 'disco_voador', x: 4, y: 4 },
            { kind: 'whiteboard', x: 4, y: 4 },
          ],
          wallItems: [{ kind: 'clock', x: 8 }, { kind: 'clock', x: 2 }, { kind: 'clock', x: 2 }],
        },
      }),
      1,
    );
    const room = pack.rooms[0];
    expect(room.desks).toHaveLength(1);
    expect(room.furniture).toEqual([]);
    expect(room.wallItems).toEqual([{ kind: 'clock', x: 2, variant: undefined }]);
    expect(pack.problems.filter((p) => p.level === 'warn').length).toBeGreaterThanOrEqual(7);
  });

  it('parede de móveis entre as entradas é erro; cadeira sem acesso descarta a mesa', () => {
    const wall = Array.from({ length: 14 }, (_, i) => ({ kind: 'filing_cabinet', x: i + 1, y: 6 }));
    const blocked = buildPack(raw({ s: { desks: [desk(2, 8)], furniture: wall } }), 1);
    expect(blocked.pack.rooms).toEqual([]);
    expect(blocked.pack.problems.some((p) => p.message.includes('caminho'))).toBe(true);

    // cadeira (2,3) cercada: mesa em cima, armários dos lados e embaixo
    const boxed = buildPack(
      raw({
        s: {
          desks: [desk(2, 2, 'up'), desk(10, 6)],
          furniture: [
            { kind: 'filing_cabinet', x: 1, y: 3 },
            { kind: 'filing_cabinet', x: 3, y: 3 },
            { kind: 'filing_cabinet', x: 2, y: 4 },
          ],
        },
      }),
      1,
    );
    expect(boxed.pack.rooms[0].desks).toEqual([expect.objectContaining({ x: 10, y: 6 })]);
  });

  it('assentos usam itens do usuário com "seat"', () => {
    const { pack } = buildPack(
      raw(
        { s: { desks: [desk(2, 6)], seats: [{ kind: 'item:puff', x: 11, y: 8, dir: 'up' }] } },
        { items: [{ id: 'puff', file: 'i', json: { seat: true, pixels: PIXELS }, images: {} }] },
      ),
      1,
    );
    expect(pack.rooms[0].seats).toEqual([{ kind: 'item:puff', x: 11, y: 8, dir: 'up', variant: undefined }]);
  });
});

describe('office.json', () => {
  const rooms = { jogos: { desks: [desk(2, 6)] }, zen: { desks: [desk(4, 6)] } };

  it('sala por projeto (caminho, nome, pasta) e padrão', () => {
    const { pack } = buildPack(
      raw(rooms, { office: { file: 'office.json', json: { defaultRoom: 'zen', projects: { dash: 'jogos', 'C:\\repos\\api': 'jogos', x: 'nao-existe' } } } }),
      1,
    );
    expect(roomDesignFor(pack, { name: 'dash', path: '/home/u/dash' })?.id).toBe('jogos');
    expect(roomDesignFor(pack, { name: 'outro', path: 'c:/repos/api/' })?.id).toBe('jogos');
    expect(roomDesignFor(pack, { name: 'qualquer', path: '/x/qualquer' })?.id).toBe('zen');
    expect(pack.problems.some((p) => p.message.includes('nao-existe'))).toBe(true);
  });

  it('áreas comuns: só chaves conhecidas', () => {
    const { pack } = buildPack(raw({}, { office: { file: 'office.json', json: { areas: { cafe: { floor: 'wood' }, sotao: {} } } } }), 1);
    expect(pack.office.areas.cafe?.floor).toBe('wood');
    expect(Object.keys(pack.office.areas)).toEqual(['cafe']);
  });
});

describe('pacotes', () => {
  it('acha e renomeia referências a itens', () => {
    const room = { furniture: [{ kind: 'item:a', x: 1, y: 2 }, { kind: 'desk', x: 1, y: 1 }], seats: [{ kind: 'item:b' }] };
    expect(referencedItems(room).sort()).toEqual(['a', 'b']);
    expect(referencedItems(renameItemRefs(room, new Map([['a', 'a-2']]))).sort()).toEqual(['a-2', 'b']);
  });

  it('confere o formato', () => {
    expect(bundleProblem({})).toMatch(/não é um pacote/);
    expect(bundleProblem({ format: 'habblaud-assets', version: 1, items: { x: { json: {}, files: { '../a.png': '' } } }, rooms: {} })).toMatch(/inválido/);
    expect(bundleProblem({ format: 'habblaud-assets', version: 1, items: {}, rooms: {} })).toBeNull();
  });

  it('slugId', () => {
    expect(slugId('Sala de Jogos Ção!')).toBe('sala-de-jogos-cao');
  });
});
