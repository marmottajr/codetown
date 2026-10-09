import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exportBundle, importBundle } from './bundle';
import { AssetStore, GUIDE_FILE, pngSize, STATUS_FILE } from './store';

/** PNG RGBA mínimo (sem CRC conferido: o Habblaud só lê o cabeçalho). */
function png(w: number, h: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    return Buffer.concat([len, Buffer.from(type, 'ascii'), data, Buffer.alloc(4)]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

let dir: string;
let changes = 0;
let store: AssetStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'habblaud-assets-'));
  changes = 0;
  store = new AssetStore({ dir, port: 4747, onChange: () => changes++ });
  store.ensure();
});

afterEach(() => {
  store.stop();
  rmSync(dir, { recursive: true, force: true });
});

const write = (rel: string, data: unknown) => {
  mkdirSync(join(dir, rel, '..'), { recursive: true });
  writeFileSync(join(dir, rel), Buffer.isBuffer(data) ? data : JSON.stringify(data));
};

describe('AssetStore', () => {
  it('cria a pasta com o guia e não reescreve um CLAUDE.md do usuário', () => {
    expect(readFileSync(join(dir, GUIDE_FILE), 'utf8')).toContain('Arquiteto do Habblaud');
    writeFileSync(join(dir, GUIDE_FILE), 'meu guia');
    store.ensure();
    expect(readFileSync(join(dir, GUIDE_FILE), 'utf8')).toBe('meu guia');
  });

  it('lê itens (PNG) e salas, escreve o STATUS.md e só avisa quando muda', () => {
    write('items/lampada/item.json', { name: 'Lâmpada' });
    write('items/lampada/sprite.png', png(10, 20));
    write('rooms/zen.json', { desks: [{ x: 2, y: 6, facing: 'up' }], furniture: [{ kind: 'item:lampada', x: 12, y: 3 }] });
    write('rooms/quebrada.json', '{ nada');
    expect(store.reload()).toBe(true);
    expect(store.reload()).toBe(false);
    expect(changes).toBe(1);
    const p = store.pack;
    expect(p.items[0]).toMatchObject({ kind: 'item:lampada', sprite: expect.stringMatching(/^\/api\/assets\/file\/items\/lampada\/sprite\.png\?v=/) });
    expect(p.rooms.map((r) => r.id)).toEqual(['zen']);
    expect(store.meta()).toMatchObject({ items: 1, rooms: 1, errors: 1 });
    const status = readFileSync(join(dir, STATUS_FILE), 'utf8');
    expect(status).toContain('rooms/quebrada.json');
    expect(status).toContain('### zen');
    expect(store.filePath('items/lampada/sprite.png')).toBeTruthy();
    expect(store.filePath('items/../../x.png')).toBeNull();
    expect(store.filePath('rooms/zen.json')).toBeNull();
  });

  it('pngSize', () => {
    expect(pngSize(png(3, 4))).toEqual({ w: 3, h: 4 });
    expect(pngSize(Buffer.from('nada'))).toBeNull();
  });
});

describe('exportar/importar', () => {
  it('a sala leva os itens que usa; importar não sobrescreve e renomeia as referências', () => {
    write('items/lampada/item.json', { name: 'Lâmpada' });
    write('items/lampada/sprite.png', png(10, 20));
    write('items/outro/item.json', { pixels: { palette: { a: '#000000' }, rows: ['a'] } });
    write('rooms/zen.json', { desks: [{ x: 2, y: 6 }], furniture: [{ kind: 'item:lampada', x: 12, y: 3 }] });
    const bundle = exportBundle(dir, { room: 'zen' });
    expect(Object.keys(bundle.items)).toEqual(['lampada']);
    expect(Object.keys(bundle.rooms)).toEqual(['zen']);

    const r = importBundle(dir, JSON.parse(JSON.stringify(bundle)));
    expect(r.items).toEqual(['lampada-2']);
    expect(r.rooms).toEqual(['zen-2']);
    const room = JSON.parse(readFileSync(join(dir, 'rooms', 'zen-2.json'), 'utf8'));
    expect(room.furniture[0].kind).toBe('item:lampada-2');
    expect(pngSize(readFileSync(join(dir, 'items', 'lampada-2', 'sprite.png')))).toEqual({ w: 10, h: 20 });
  });

  it('recusa imagem que não é PNG e pacote estranho', () => {
    expect(() => importBundle(dir, { format: 'x' })).toThrow(/não é um pacote/);
    expect(() => importBundle(dir, { format: 'habblaud-assets', version: 1, rooms: {}, items: { a: { json: {}, files: { 'a.png': 'bmFkYQ==' } } } })).toThrow(/PNG/);
  });
});
