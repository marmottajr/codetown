// Arquiteto: janela dos assets do usuário (salas desenhadas, itens novos e ajustes na arquitetura; formato em
// shared/assets.ts). Abre o "Arquiteto" — uma sessão do Claude Code na pasta de assets, que cria tudo a pedido —
// no terminal interativo, mostra o que existe e o que deu errado, e exporta/importa pacotes .habblaud.json.
import type { AssetPack, ItemDesign, RoomDesign } from '../../../shared/assets';
import type { PtyInfo } from '../../../shared/types';
import { pixelCanvas } from '../art/custom';
import type { UiComponent, UiContext } from './context';
import { h, iconButton, setHidden, setText } from './dom';
import { ICONS } from './icons';
import { postPty } from './ptyapi';
import './studio.css';

/** Lápis em pixels (o mesmo traço dos outros ícones da barra). */
const STUDIO_ICON =
  '<svg class="ui-px-icon" width="20" height="20" viewBox="0 0 10 10" shape-rendering="crispEdges" aria-hidden="true" focusable="false">' +
  '<path fill="currentColor" d="M7 0h1v1h1v1h1v1H9v1H8v1H7v1H6v1H5v1H4v1H3v1H0V7h1V6h1V5h1V4h1V3h1V2h1V1h1zM1 8v1h1V8z"/></svg>';

type PackView = AssetPack & { dir: string; agent: boolean };

export class StudioPanel implements UiComponent {
  readonly button: HTMLButtonElement;
  readonly el: HTMLDialogElement;
  private pack: PackView | null = null;
  private loadedVersion = -1;
  private loading = false;
  private busy = false;
  /** Arquiteto recém-aberto: abre o terminal assim que ele aparecer no snapshot. */
  private pending: PtyInfo | null = null;

  private openBtn: HTMLButtonElement;
  private openHint: HTMLElement;
  private dirEl: HTMLElement;
  private summary: HTMLElement;
  private problems: HTMLElement;
  private rooms: HTMLElement;
  private items: HTMLElement;
  private msg: HTMLElement;
  private file: HTMLInputElement;

  constructor(private ctx: UiContext) {
    this.button = iconButton(STUDIO_ICON, 'Arquiteto: crie salas e itens para o escritório', () => this.toggle());
    this.button.setAttribute('aria-haspopup', 'dialog');

    this.openBtn = h('button', { class: 'ui-btn ui-btn--accent', type: 'button', text: 'Abrir o Arquiteto', on: { click: () => this.openAgent() } });
    this.openHint = h('p', { class: 'ui-studio__hint' });
    this.dirEl = h('code', { class: 'ui-studio__dir' });
    const copy = h('button', { class: 'ui-link-btn', type: 'button', text: 'copiar', on: { click: () => this.copyDir() } });
    this.summary = h('p', { class: 'ui-studio__summary' });
    this.problems = h('ul', { class: 'ui-studio__problems', hidden: true });
    this.rooms = h('ul', { class: 'ui-studio__list' });
    this.items = h('ul', { class: 'ui-studio__list ui-studio__list--items' });
    this.msg = h('p', { class: 'ui-studio__msg', role: 'status', hidden: true });
    this.file = h('input', { type: 'file', attrs: { accept: '.json,application/json', hidden: true }, on: { change: () => void this.importFile() } });
    const exportAll = h('a', { class: 'ui-btn', text: 'Exportar tudo', attrs: { href: '/api/assets/export?all=1', download: '' } });
    const importBtn = h('button', { class: 'ui-btn', type: 'button', text: 'Importar pacote…', on: { click: () => this.file.click() } });
    const close = iconButton(ICONS.close, 'Fechar (Esc)', () => this.close(), 'ui-icon-btn--sm');

    this.el = h(
      'dialog',
      { class: 'ui-dialog ui-studio', attrs: { 'aria-labelledby': 'ui-studio-title' } },
      h('div', { class: 'ui-dialog__head' }, h('h2', { text: 'Arquiteto', attrs: { id: 'ui-studio-title' } }), close),
      h(
        'div',
        { class: 'ui-dialog__body ui-studio__body' },
        h(
          'p',
          { class: 'ui-studio__intro' },
          'Peça salas novas, móveis e mudanças no prédio em português: o Arquiteto é um Claude Code que trabalha na sua pasta de assets e o escritório se redesenha a cada arquivo salvo. Ex.: “uma sala de jogos com fliperamas para o projeto dash”, “um puff em forma de gato”, “a copa com piso de madeira”.',
        ),
        h('div', { class: 'ui-studio__agent' }, this.openBtn, this.openHint),
        h('p', { class: 'ui-studio__where' }, 'Pasta: ', this.dirEl, ' ', copy),
        this.summary,
        this.problems,
        h('h3', { text: 'Salas' }),
        this.rooms,
        h('h3', { text: 'Itens' }),
        this.items,
        h('div', { class: 'ui-studio__foot' }, exportAll, importBtn, this.file),
        this.msg,
      ),
    );
    this.el.addEventListener('click', (e) => {
      if (e.target === this.el) this.close();
    });
    this.el.addEventListener('close', () => this.button.classList.remove('is-active'));
  }

  toggle(): void {
    if (this.el.open) this.close();
    else this.open();
  }

  open(): void {
    if (!this.el.isConnected) return;
    this.el.showModal();
    this.button.classList.add('is-active');
    void this.load(true);
    this.render();
  }

  close(): void {
    if (this.el.open) this.el.close();
  }

  render(): void {
    // Arquiteto recém-aberto: quando o pty aparece no snapshot, abre o terminal dele.
    const p = this.pending;
    if (p && this.ctx.store.snapshot?.ptys?.some((x) => x.id === p.id)) {
      this.pending = null;
      this.close();
      this.ctx.terminals?.open(p.agentId);
    }
    if (!this.el.open) return;
    const meta = this.ctx.store.snapshot?.meta;
    if (meta?.assets && meta.assets.version !== this.loadedVersion) void this.load();
    const enabled = !!meta?.pty?.enabled && !this.ctx.store.replaying;
    const running = this.runningAgent();
    this.openBtn.disabled = this.busy || (!enabled && !running);
    setText(this.openBtn, running ? 'Voltar ao Arquiteto' : 'Abrir o Arquiteto');
    setText(
      this.openHint,
      enabled || running
        ? 'Abre um Claude Code na pasta de assets, na sua conta padrão, no terminal interativo.'
        : `Precisa do terminal interativo: ${meta?.pty?.reason ?? 'desligado'}. Dá para abrir o Claude Code nessa pasta por conta própria.`,
    );
  }

  /** Arquiteto já rodando (pty aberto na pasta de assets). */
  private runningAgent(): PtyInfo | undefined {
    const dir = this.pack?.dir ?? this.ctx.store.snapshot?.meta.assets?.dir;
    if (!dir) return undefined;
    const norm = (s: string) => s.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
    return this.ctx.store.snapshot?.ptys?.find((x) => x.exitedAt === undefined && norm(x.cwd) === norm(dir));
  }

  private async load(force = false): Promise<void> {
    if (this.loading && !force) return;
    this.loading = true;
    try {
      const res = await fetch('/api/assets', { cache: 'no-store' });
      if (!res.ok) throw new Error(`erro ${res.status}`);
      this.pack = (await res.json()) as PackView;
      this.loadedVersion = this.pack.version;
      this.fill();
    } catch (err) {
      this.showMsg(`Não consegui ler os assets: ${(err as Error).message}`, true);
    } finally {
      this.loading = false;
      this.ctx.invalidate();
    }
  }

  private fill(): void {
    const p = this.pack;
    if (!p) return;
    setText(this.dirEl, p.dir);
    const errors = p.problems.filter((x) => x.level === 'error').length;
    const warns = p.problems.length - errors;
    setText(
      this.summary,
      `${p.rooms.length} sala(s) e ${p.items.length} item(ns)` + (errors || warns ? ` · ${errors} erro(s), ${warns} aviso(s) (detalhes no STATUS.md da pasta)` : ' · tudo certo'),
    );
    this.problems.replaceChildren(
      ...p.problems.slice(0, 12).map((x) => h('li', { class: x.level === 'error' ? 'is-error' : '' }, h('code', { text: x.file }), ` ${x.message}`)),
    );
    setHidden(this.problems, !p.problems.length);

    const usedBy = (r: RoomDesign) => {
      const who = Object.entries(p.office.projects)
        .filter(([, id]) => id === r.id)
        .map(([k]) => k);
      if (p.office.defaultRoom === r.id) who.unshift('todos os projetos (padrão)');
      return who.length ? `usada por: ${who.join(', ')}` : 'ainda sem projeto (peça ao Arquiteto para usar)';
    };
    this.rooms.replaceChildren(
      ...(p.rooms.length
        ? p.rooms.map((r) =>
            h(
              'li',
              { class: 'ui-studio__row' },
              h('div', { class: 'ui-studio__name' }, h('strong', { text: r.name }), h('span', { text: `${r.id} · ${r.desks.length} mesa(s) · ${usedBy(r)}` })),
              exportLink(`room=${encodeURIComponent(r.id)}`),
            ),
          )
        : [h('li', { class: 'ui-studio__empty', text: 'Nenhuma sala ainda.' })]),
    );
    this.items.replaceChildren(
      ...(p.items.length
        ? p.items.map((i) =>
            h(
              'li',
              { class: 'ui-studio__row' },
              itemPreview(i),
              h('div', { class: 'ui-studio__name' }, h('strong', { text: i.name }), h('span', { text: `${i.kind} · ${i.mount === 'wall' ? 'parede' : `${i.w}x${i.h}`}${i.seat ? ' · assento' : ''}` })),
              exportLink(`item=${encodeURIComponent(i.id)}`),
            ),
          )
        : [h('li', { class: 'ui-studio__empty', text: 'Nenhum item ainda.' })]),
    );
  }

  private openAgent(): void {
    const running = this.runningAgent();
    if (running) {
      this.close();
      this.ctx.terminals?.open(running.agentId);
      return;
    }
    this.busy = true;
    this.showMsg('Abrindo o Arquiteto…');
    this.ctx.invalidate();
    postPty<PtyInfo>('/api/assets/agent', { cols: 120, rows: 32 })
      .then((p) => {
        this.showMsg('');
        if (p) this.pending = p;
      })
      .catch((err: Error) => this.showMsg(`Não deu: ${err.message}`, true))
      .finally(() => {
        this.busy = false;
        this.ctx.invalidate();
      });
  }

  private async importFile(): Promise<void> {
    const f = this.file.files?.[0];
    this.file.value = '';
    if (!f) return;
    try {
      const bundle = JSON.parse(await f.text()) as unknown;
      const r = await postPty<{ rooms: string[]; items: string[]; office?: string; renamed: Record<string, string> }>('/api/assets/import', bundle);
      const renamed = Object.entries(r?.renamed ?? {}).map(([a, b]) => `${a} → ${b}`);
      this.showMsg(
        `Importado: ${r?.rooms.length ?? 0} sala(s), ${r?.items.length ?? 0} item(ns)` +
          (r?.office ? `, arquitetura em ${r.office}` : '') +
          (renamed.length ? ` (renomeados: ${renamed.join(', ')})` : '') +
          '.',
      );
      void this.load(true);
    } catch (err) {
      this.showMsg(`Não deu para importar: ${err instanceof SyntaxError ? 'o arquivo não é JSON' : (err as Error).message}`, true);
    }
  }

  private copyDir(): void {
    const dir = this.pack?.dir;
    if (!dir) return;
    navigator.clipboard?.writeText(dir).then(
      () => this.showMsg('Caminho copiado.'),
      () => this.showMsg(dir),
    );
  }

  private showMsg(text: string, error = false): void {
    setText(this.msg, text);
    setHidden(this.msg, !text);
    this.msg.classList.toggle('is-error', error);
  }
}

function exportLink(query: string): HTMLAnchorElement {
  return h('a', { class: 'ui-btn ui-btn--sm', text: 'Exportar', title: 'Baixar um pacote .habblaud.json para levar a outro Habblaud', attrs: { href: `/api/assets/export?${query}`, download: '' } });
}

function itemPreview(i: ItemDesign): HTMLElement {
  const box = h('span', { class: 'ui-studio__thumb' });
  const fit = (el: HTMLCanvasElement | HTMLImageElement, w: number, h: number) => {
    // pixel art ampliada por um fator inteiro (sem borrar), até caber na miniatura
    const k = Math.max(1, Math.floor(36 / Math.max(w, h, 1)));
    el.style.width = `${w * k}px`;
    el.style.height = `${h * k}px`;
  };
  if (i.pixels) {
    const c = pixelCanvas(i.pixels);
    fit(c, c.width, c.height);
    box.append(c);
  } else if (i.sprite) {
    const img = h('img', { attrs: { src: i.sprite, alt: '' } });
    img.addEventListener('load', () => fit(img, img.naturalWidth, img.naturalHeight));
    box.append(img);
  }
  return box;
}
