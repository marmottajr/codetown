// "Abrir projeto": janela para escolher uma pasta do computador e abrir nela uma sessão nova do Claude Code, no
// terminal interativo. Quem lista as pastas é o servidor (GET /api/pty/dirs; o navegador não informa o caminho
// real de uma pasta escolhida no seletor do sistema). Atalhos: pasta pessoal, discos e os projetos do escritório.
import type { UiContext } from './context';
import { h, iconButton, setHidden, setText } from './dom';
import { ICONS } from './icons';

interface DirListing {
  path: string;
  parent?: string;
  dirs: string[];
  truncated?: boolean;
  home: string;
  roots: string[];
}

export class ProjectPicker {
  readonly el: HTMLElement;
  private input: HTMLInputElement;
  private list: HTMLElement;
  private shortcuts: HTMLElement;
  private msg: HTMLElement;
  private upBtn: HTMLButtonElement;
  private openBtn: HTMLButtonElement;
  private current: DirListing | null = null;
  private req = 0;
  private opener: HTMLElement | null = null;

  constructor(private ctx: UiContext) {
    this.input = h('input', {
      class: 'ui-pick__path',
      type: 'text',
      attrs: { 'aria-label': 'Caminho da pasta', spellcheck: 'false', autocomplete: 'off', placeholder: 'C:\\Users\\voce\\projeto' },
    });
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        void this.load(this.input.value);
      }
    });
    this.upBtn = h('button', { class: 'ui-btn ui-btn--sm', type: 'button', text: '↑ Pasta de cima', on: { click: () => this.current?.parent && void this.load(this.current.parent) } });
    this.shortcuts = h('div', { class: 'ui-pick__shortcuts' });
    this.list = h('ul', { class: 'ui-pick__list', attrs: { 'aria-label': 'Pastas' } });
    this.msg = h('p', { class: 'ui-pick__msg', role: 'status', hidden: true });
    this.openBtn = h('button', { class: 'ui-btn ui-btn--accent', type: 'button', text: 'Abrir Claude Code aqui', on: { click: () => this.open() } });
    const close = iconButton(ICONS.close, 'Fechar (Esc)', () => this.close(), 'ui-icon-btn--sm');
    this.el = h(
      'div',
      { class: 'ui-pick', hidden: true, role: 'dialog', attrs: { 'aria-modal': 'true', 'aria-label': 'Abrir projeto' } },
      h(
        'div',
        { class: 'ui-pick__box' },
        h('div', { class: 'ui-pick__head' }, h('h2', { text: 'Abrir projeto' }), close),
        h('p', { class: 'ui-muted ui-small', text: 'Escolha a pasta do projeto: o Claude Code abre nela, num terminal interativo.' }),
        h('div', { class: 'ui-pick__nav' }, this.upBtn, this.input),
        this.shortcuts,
        this.list,
        this.msg,
        h('div', { class: 'ui-pick__foot' }, h('button', { class: 'ui-btn', type: 'button', text: 'Cancelar', on: { click: () => this.close() } }), this.openBtn),
      ),
    );
    // Clique fora da caixa fecha; as teclas daqui não viram atalhos do escritório.
    this.el.addEventListener('click', (e) => e.target === this.el && this.close());
    this.el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        this.close();
      }
      e.stopPropagation();
    });
  }

  get isOpen(): boolean {
    return !this.el.hidden;
  }

  show(opener: HTMLElement | null = null): void {
    this.opener = opener;
    this.el.hidden = false;
    this.renderShortcuts();
    void this.load(this.current?.path ?? '');
    requestAnimationFrame(() => this.input.focus());
  }

  close(): void {
    if (this.el.hidden) return;
    this.el.hidden = true;
    if (this.opener?.isConnected) this.opener.focus({ preventScroll: true });
  }

  private async load(path: string): Promise<void> {
    const req = ++this.req;
    this.showMsg('');
    let res: Response;
    try {
      res = await fetch(`/api/pty/dirs?path=${encodeURIComponent(path.trim())}`);
    } catch {
      return this.showMsg('O Habblaud não respondeu.', true);
    }
    const j = (await res.json().catch(() => ({}))) as DirListing & { error?: string };
    if (req !== this.req) return;
    if (!res.ok) return this.showMsg(j.error ?? `erro ${res.status}`, true);
    this.current = j;
    this.input.value = j.path;
    this.upBtn.disabled = !j.parent;
    this.list.replaceChildren(
      ...j.dirs.map((name) => {
        const icon = h('span', { class: 'ui-pick__icon', attrs: { 'aria-hidden': 'true' } });
        icon.innerHTML = ICONS.folder;
        return h('li', {}, h('button', { class: 'ui-pick__dir', type: 'button', on: { click: () => void this.load(join(j.path, name)) } }, icon, h('span', { text: name })));
      }),
    );
    if (!j.dirs.length) this.list.append(h('li', { class: 'ui-muted ui-small ui-pick__empty', text: 'Nenhuma subpasta.' }));
    if (j.truncated) this.showMsg('Pasta grande: mostrando só as primeiras 1000 subpastas.');
    this.list.scrollTop = 0;
    this.renderShortcuts();
  }

  /** Pasta pessoal, discos e as pastas dos projetos abertos no escritório. */
  private renderShortcuts(): void {
    const items: [string, string][] = [];
    if (this.current) items.push(['Pasta pessoal', this.current.home]);
    for (const r of this.current?.roots ?? []) items.push([r.replace(/\\$/, ''), r]);
    const seen = new Set(items.map(([, p]) => p.toLowerCase()));
    for (const room of this.ctx.store.snapshot?.rooms ?? []) {
      if (seen.has(room.path.toLowerCase())) continue;
      seen.add(room.path.toLowerCase());
      items.push([room.name, room.path]);
    }
    this.shortcuts.replaceChildren(
      ...items.map(([label, path]) => h('button', { class: 'ui-chip-btn', type: 'button', text: label, title: path, on: { click: () => void this.load(path) } })),
    );
  }

  private open(): void {
    const path = this.current?.path;
    const router = this.ctx.terminals;
    if (!path || !router) return;
    this.openBtn.disabled = true;
    router
      .newSession(path)
      .then(() => this.close())
      .catch((err: Error) => this.showMsg(`Não deu: ${err.message}`, true))
      .finally(() => (this.openBtn.disabled = false));
  }

  private showMsg(text: string, error = false): void {
    setText(this.msg, text);
    setHidden(this.msg, !text);
    this.msg.classList.toggle('is-error', error);
  }
}

/** Junta pasta e nome com o separador da própria pasta (\\ no Windows, / nos outros). */
function join(dir: string, name: string): string {
  const sep = dir.includes('\\') ? '\\' : '/';
  return dir.endsWith(sep) ? dir + name : dir + sep + name;
}
