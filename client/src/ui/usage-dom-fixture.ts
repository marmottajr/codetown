// DOM mínimo para testar o cartão de uso de verdade (o repo roda vitest em node, sem jsdom/happy-dom e sem dependência
// nova): só o que dom.ts, widgets.ts e UsageCards usam. Só para testes.
import type { AccountInfo } from '../../../shared/types';
import type { UiContext } from './context';
import { UsageCards } from './usage';

export class FakeText {
  parentNode: FakeEl | null = null;
  constructor(public textContent: string) {}
}
type FakeNode = FakeEl | FakeText;

export class FakeEl {
  parentNode: FakeEl | null = null;
  children: FakeNode[] = [];
  attrs = new Map<string, string>();
  dataset: Record<string, string> = {};
  className = '';
  hidden = false;
  title = '';
  tabIndex = 0;
  innerHTML = '';
  private vars = new Map<string, string>();
  style = {
    setProperty: (k: string, v: string) => void this.vars.set(k, v),
    getPropertyValue: (k: string) => this.vars.get(k) ?? '',
  };
  classList = {
    toggle: (c: string, on?: boolean) => {
      const set = new Set(this.className.split(/\s+/).filter(Boolean));
      if (on ?? !set.has(c)) set.add(c);
      else set.delete(c);
      this.className = [...set].join(' ');
    },
    add: (c: string) => this.classList.toggle(c, true),
    remove: (c: string) => this.classList.toggle(c, false),
    contains: (c: string) => this.className.split(/\s+/).includes(c),
  };
  constructor(public tagName: string) {}
  get firstChild(): FakeNode | null {
    return this.children[0] ?? null;
  }
  get lastElementChild(): FakeEl | null {
    return [...this.children].reverse().find((c): c is FakeEl => c instanceof FakeEl) ?? null;
  }
  get nextSibling(): FakeNode | null {
    const sib = this.parentNode?.children ?? [];
    return sib[sib.indexOf(this) + 1] ?? null;
  }
  get textContent(): string {
    return this.children.map((c) => c.textContent).join('');
  }
  set textContent(v: string) {
    this.replaceChildren(v);
  }
  setAttribute(k: string, v: string): void {
    this.attrs.set(k, v);
  }
  getAttribute(k: string): string | null {
    return this.attrs.get(k) ?? null;
  }
  hasAttribute(k: string): boolean {
    return this.attrs.has(k);
  }
  removeAttribute(k: string): void {
    this.attrs.delete(k);
  }
  private adopt(c: FakeNode | string): FakeNode {
    const n = typeof c === 'string' ? new FakeText(c) : c;
    n.parentNode = this;
    return n;
  }
  append(...cs: (FakeNode | string)[]): void {
    for (const c of cs) this.children.push(this.adopt(c));
  }
  insertBefore(el: FakeNode, ref: FakeNode | null): void {
    el.parentNode?.children.splice(el.parentNode.children.indexOf(el), 1);
    const i = ref ? this.children.indexOf(ref) : -1;
    if (i < 0) this.children.push(this.adopt(el));
    else this.children.splice(i, 0, this.adopt(el));
  }
  replaceChildren(...cs: (FakeNode | string)[]): void {
    this.children = [];
    this.append(...cs.filter((c) => c !== ''));
  }
  remove(): void {
    if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((c) => c !== this);
  }
  addEventListener(): void {}
  /** Descendentes (em ordem) que têm a classe. */
  all(cls: string): FakeEl[] {
    const out: FakeEl[] = [];
    const walk = (n: FakeEl) => {
      for (const c of n.children) {
        if (!(c instanceof FakeEl)) continue;
        if (c.classList.contains(cls)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  one(cls: string): FakeEl {
    const [el] = this.all(cls);
    if (!el) throw new Error(`sem .${cls}`);
    return el;
  }
  /** Aparece na tela? (nenhum ancestral nem ele próprio com `hidden`) */
  get visible(): boolean {
    for (let n: FakeEl | null = this; n; n = n.parentNode) if (n.hidden) return false;
    return true;
  }
}

const KEYS = ['document', 'matchMedia'] as const;
const saved: Record<string, unknown> = {};
export function installFakeDom(): void {
  for (const k of KEYS) saved[k] = (globalThis as Record<string, unknown>)[k];
  Object.assign(globalThis, { document: { createElement: (t: string) => new FakeEl(t), createTextNode: (s: string) => new FakeText(s) } });
  delete (globalThis as Record<string, unknown>).matchMedia;
}
export function restoreFakeDom(): void {
  for (const k of KEYS) (globalThis as Record<string, unknown>)[k] = saved[k];
}

/** Monta o UsageCards com as contas e devolve os cartões (FakeEl), na ordem. */
export function renderCards(accounts: AccountInfo[], now: number): FakeEl[] {
  const ctx = { store: { snapshot: { accounts } }, now: () => now, openHelp: () => {} } as unknown as UiContext;
  const cards = new UsageCards(ctx);
  cards.render();
  return (cards.el as unknown as FakeEl).children.filter((c): c is FakeEl => c instanceof FakeEl);
}

/** As linhas (rótulo, valor) da dica do cartão. */
export function tipRows(card: FakeEl): [string, string][] {
  const dl = card.one('ui-kv');
  const rows: [string, string][] = [];
  for (let i = 0; i + 1 < dl.children.length; i += 2) rows.push([dl.children[i]!.textContent, dl.children[i + 1]!.textContent]);
  return rows;
}
