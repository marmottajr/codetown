// Pasta de assets do usuário (itens, salas e arquitetura; formato em shared/assets.ts). Lê tudo, valida, guarda o
// pacote limpo para o cliente (GET /api/assets) e escreve o STATUS.md com os problemas e a prévia em texto de cada
// sala: é por ele que o Arquiteto (a sessão do Claude Code aberta nesta pasta) confere o que fez. Observa a pasta e
// recarrega sozinho a cada mudança; o snapshot leva a versão (meta.assets) e o cliente baixa o pacote novo.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, watch, writeFileSync, type FSWatcher } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { buildPack, EMPTY_PACK, validId, type AssetPack, type AssetProblem, type AssetsMeta, type PackBuild, type RawAssets, type RawImage } from '../../shared/assets';
import { errMsg, log } from '../log';
import { GUIDE_MARKER, guideText } from './guide';

export const STATUS_FILE = 'STATUS.md';
export const GUIDE_FILE = 'CLAUDE.md';
export const EXPORTS_DIR = 'exports';

/** Largura e altura de um PNG (cabeçalho IHDR), ou null se não for PNG. */
export function pngSize(buf: Buffer): { w: number; h: number } | null {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47 || buf.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

function readJsonFile(file: string): { json?: unknown; error?: string } {
  try {
    return { json: JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, '')) };
  } catch (err) {
    return { error: err instanceof SyntaxError ? `JSON inválido: ${err.message}` : `não consegui ler: ${errMsg(err)}` };
  }
}

function listDir(dir: string): string[] {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}

export interface AssetStoreOptions {
  dir: string;
  /** Porta do Habblaud (o CLAUDE.md ensina o agente a exportar/importar pela API). */
  port: number;
  onChange: () => void;
}

export class AssetStore {
  readonly dir: string;
  private built: PackBuild = { pack: EMPTY_PACK, maps: {} };
  private signature = '';
  /** Começa no relógio: um servidor reiniciado nunca repete a versão que a página já tem. */
  private version = Date.now();
  private watcher: FSWatcher | null = null;
  private poller: ReturnType<typeof setInterval> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly opts: AssetStoreOptions) {
    this.dir = resolve(opts.dir);
  }

  get pack(): AssetPack {
    return this.built.pack;
  }

  meta(): AssetsMeta {
    const p = this.built.pack;
    return {
      version: p.version,
      dir: this.dir,
      items: p.items.length,
      rooms: p.rooms.length,
      errors: p.problems.filter((x) => x.level === 'error').length,
      warnings: p.problems.filter((x) => x.level === 'warn').length,
    };
  }

  start(): void {
    try {
      this.ensure();
    } catch (err) {
      log.warn(`Não consegui preparar a pasta de assets (${this.dir}): ${errMsg(err)}`);
      return;
    }
    this.reload();
    try {
      this.watcher = watch(this.dir, { recursive: true }, (_ev, name) => {
        const file = String(name ?? '').replace(/\\/g, '/');
        if (file === STATUS_FILE || file.startsWith(`${EXPORTS_DIR}/`)) return;
        this.schedule();
      });
      this.watcher.on('error', () => this.fallbackPoll());
    } catch {
      this.fallbackPoll();
    }
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = null;
    if (this.poller) clearInterval(this.poller);
    if (this.timer) clearTimeout(this.timer);
    this.poller = null;
    this.timer = null;
  }

  /** Cria a pasta (itens, salas, exportações) e mantém o CLAUDE.md do Arquiteto atualizado. */
  ensure(): void {
    for (const d of ['', 'items', 'rooms', EXPORTS_DIR]) mkdirSync(join(this.dir, d), { recursive: true });
    const guide = join(this.dir, GUIDE_FILE);
    const text = guideText({ dir: this.dir, port: this.opts.port });
    let current: string | null = null;
    try {
      current = readFileSync(guide, 'utf8');
    } catch {
      current = null;
    }
    // Só reescreve o guia que o próprio Habblaud gerou (com o marcador); um CLAUDE.md do usuário fica intocado.
    if (current === null || (current.includes(GUIDE_MARKER) && current !== text)) writeFileSync(guide, text);
  }

  /** Relê a pasta; se algo mudou, valida, publica a versão nova e reescreve o STATUS.md. */
  reload(): boolean {
    const { raw, problems, stamp } = this.read();
    const signature = JSON.stringify([raw, problems, stamp]);
    if (signature === this.signature) return false;
    this.signature = signature;
    this.built = buildPack(raw, ++this.version, problems);
    this.writeStatus();
    const m = this.meta();
    log.info(`Assets recarregados: ${m.items} item(ns), ${m.rooms} sala(s)${m.errors ? `, ${m.errors} erro(s)` : ''}${m.warnings ? `, ${m.warnings} aviso(s)` : ''}.`);
    this.opts.onChange();
    return true;
  }

  /** Caminho absoluto de um PNG servido em /api/assets/file/<rel> (só dentro de items/), ou null. */
  filePath(rel: string): string | null {
    if (!/^items\/[a-z0-9_-]+\/[a-z0-9_-]+\.png$/i.test(rel)) return null;
    const abs = resolve(this.dir, rel);
    const inside = relative(this.dir, abs);
    if (!inside || inside.startsWith('..') || inside.split(sep).includes('..')) return null;
    return existsSync(abs) ? abs : null;
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      try {
        this.reload();
      } catch (err) {
        log.warn(`Falha ao recarregar os assets: ${errMsg(err)}`);
      }
    }, 250);
    this.timer.unref?.();
  }

  /** Sem fs.watch recursivo (alguns sistemas de arquivos): confere a pasta a cada 2 s. */
  private fallbackPoll(): void {
    this.watcher?.close();
    this.watcher = null;
    if (this.poller) return;
    this.poller = setInterval(() => this.schedule(), 2000);
    this.poller.unref?.();
  }

  private read(): { raw: RawAssets; problems: AssetProblem[]; stamp: string[] } {
    const raw: RawAssets = { items: [], rooms: [] };
    const problems: AssetProblem[] = [];
    const stamp: string[] = [];
    const itemsDir = join(this.dir, 'items');
    for (const id of listDir(itemsDir)) {
      const folder = join(itemsDir, id);
      try {
        if (!statSync(folder).isDirectory()) continue;
      } catch {
        continue;
      }
      const file = `items/${id}/item.json`;
      const r = readJsonFile(join(folder, 'item.json'));
      if (r.error) {
        problems.push({ file, level: 'error', message: existsSync(join(folder, 'item.json')) ? r.error : 'falta o item.json' });
        continue;
      }
      const images: Record<string, RawImage | undefined> = {};
      for (const name of listDir(folder)) {
        if (!/\.png$/i.test(name)) continue;
        const abs = join(folder, name);
        try {
          const buf = readFileSync(abs);
          const size = pngSize(buf);
          if (!size) {
            problems.push({ file: `items/${id}/${name}`, level: 'warn', message: 'não é um PNG válido' });
            continue;
          }
          const mtime = Math.round(statSync(abs).mtimeMs);
          stamp.push(`${id}/${name}:${mtime}:${buf.length}`);
          images[name] = { ...size, url: `/api/assets/file/items/${encodeURIComponent(id)}/${encodeURIComponent(name)}?v=${mtime}` };
        } catch {
          // arquivo sumiu no meio da leitura: a próxima recarga resolve
        }
      }
      raw.items.push({ id, file, json: r.json, images });
    }
    const roomsDir = join(this.dir, 'rooms');
    for (const name of listDir(roomsDir)) {
      if (!name.endsWith('.json')) continue;
      const id = name.slice(0, -'.json'.length);
      const file = `rooms/${name}`;
      if (!validId(id)) {
        problems.push({ file, level: 'error', message: 'nome de arquivo inválido: use letras minúsculas, números, "-" e "_"' });
        continue;
      }
      const r = readJsonFile(join(roomsDir, name));
      if (r.error) problems.push({ file, level: 'error', message: r.error });
      else raw.rooms.push({ id, file, json: r.json });
    }
    const officeFile = join(this.dir, 'office.json');
    if (existsSync(officeFile)) {
      const r = readJsonFile(officeFile);
      if (r.error) problems.push({ file: 'office.json', level: 'error', message: r.error });
      else raw.office = { file: 'office.json', json: r.json };
    }
    return { raw, problems, stamp };
  }

  private writeStatus(): void {
    const { pack, maps } = this.built;
    const m = this.meta();
    const lines: string[] = [
      '# Status dos assets',
      '',
      `Gerado pelo Habblaud em ${new Date().toLocaleString('pt-BR')} (versão ${pack.version}). Este arquivo é reescrito a cada mudança na pasta: não edite.`,
      '',
      `- Itens válidos: ${m.items}`,
      `- Salas válidas: ${m.rooms}`,
      `- Erros: ${m.errors} · Avisos: ${m.warnings}`,
      '',
      '## Problemas',
      '',
    ];
    if (!pack.problems.length) lines.push('Nenhum. Tudo certo.');
    for (const p of pack.problems) lines.push(`- ${p.level === 'error' ? '**ERRO**' : 'aviso'} \`${p.file}\`: ${p.message}`);
    lines.push('', '## Itens', '');
    if (!pack.items.length) lines.push('(nenhum)');
    for (const i of pack.items) lines.push(`- \`${i.kind}\` ${i.name}: ${i.mount === 'wall' ? `parede, ${i.w} tile(s)` : `chão ${i.w}x${i.h}${i.seat ? ', assento' : i.blocks ? '' : ', não bloqueia'}`}`);
    lines.push('', '## Uso', '');
    lines.push(`- Sala padrão: ${pack.office.defaultRoom ?? '(nenhuma: salas procedurais)'}`);
    const projects = Object.entries(pack.office.projects);
    for (const [k, v] of projects) lines.push(`- Projeto "${k}" → sala \`${v}\``);
    const areas = Object.keys(pack.office.areas);
    if (areas.length) lines.push(`- Áreas comuns ajustadas: ${areas.join(', ')}`);
    lines.push('', '## Salas', '');
    const ids = Object.keys(maps).sort();
    if (!ids.length) lines.push('(nenhuma)');
    for (const id of ids) {
      const ok = pack.rooms.some((r) => r.id === id);
      lines.push(`### ${id}${ok ? '' : ' (com erro: não será usada)'}`, '', `Parede norte: ${maps[id].walls}`, '', '```', '   0123456789012345', maps[id].map, '```', '');
    }
    try {
      writeFileSync(join(this.dir, STATUS_FILE), lines.join('\n'));
    } catch (err) {
      log.warnOnce(`assets-status:${errMsg(err)}`, `Não consegui escrever o ${STATUS_FILE}: ${errMsg(err)}`);
    }
  }
}
