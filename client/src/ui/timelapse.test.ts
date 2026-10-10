import { afterEach, describe, expect, it } from 'vitest';
import type { UiContext } from './context';
import { dayLabel, hourTicks, TimelapsePlayer } from './timelapse';

describe('timelapse: rótulos', () => {
  it('dia: Hoje, Ontem ou a data curta', () => {
    expect(dayLabel('2026-10-08', '2026-10-08')).toBe('Hoje');
    expect(dayLabel('2026-10-07', '2026-10-08')).toBe('Ontem');
    expect(dayLabel('2026-10-01', '2026-10-01')).toBe('Hoje');
    expect(dayLabel('2026-09-30', '2026-10-01')).toBe('Ontem');
    expect(dayLabel('2026-10-05', '2026-10-08')).toMatch(/5 de out/);
  });

  it('régua: horas cheias, no máximo ~6 marcas', () => {
    const at = (h: number, m = 0) => new Date(2026, 9, 7, h, m).getTime();
    expect(hourTicks(at(9, 10), at(12, 30)).map((t) => new Date(t).getHours())).toEqual([10, 11, 12]);
    expect(hourTicks(at(9), at(19)).map((t) => new Date(t).getHours())).toEqual([10, 12, 14, 16, 18]);
    expect(hourTicks(at(0, 5), at(23, 50)).map((t) => new Date(t).getHours())).toEqual([4, 8, 12, 16, 20]);
    expect(hourTicks(at(9, 10), at(9, 50))).toEqual([]);
  });
});

/** DOM mínimo para montar o player e disparar o keydown dos rádios (a suíte roda em node). */
class FakeEl {
  readonly tagName: string;
  className = '';
  textContent: string | null = null;
  title = '';
  hidden = false;
  tabIndex = 0;
  innerHTML = '';
  disabled = false;
  style = { getPropertyValue: () => '', setProperty() {} };
  classList = { toggle() {}, add() {}, remove() {} };
  readonly attrs = new Map<string, string>();
  readonly listeners = new Map<string, Array<(ev: Event) => void>>();
  readonly children: Array<FakeEl | string> = [];
  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
  }
  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }
  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }
  hasAttribute(name: string): boolean {
    return this.attrs.has(name);
  }
  removeAttribute(name: string): void {
    this.attrs.delete(name);
  }
  addEventListener(type: string, fn: (ev: Event) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }
  removeEventListener(): void {}
  append(...nodes: Array<FakeEl | string>): void {
    this.children.push(...nodes);
  }
  focus(): void {
    focused = this;
  }
}

let focused: FakeEl | null = null;

function installDom(): () => void {
  const prev = globalThis.document;
  focused = null;
  globalThis.document = {
    createElement: (tag: string) => new FakeEl(tag),
    documentElement: new FakeEl('html'),
    querySelector: () => null,
    activeElement: null,
  } as unknown as Document;
  return () => {
    globalThis.document = prev;
    focused = null;
  };
}

function radiosOf(root: FakeEl): FakeEl[] {
  const out: FakeEl[] = [];
  const walk = (el: FakeEl) => {
    if (el.getAttribute('role') === 'radio') out.push(el);
    for (const child of el.children) if (child instanceof FakeEl) walk(child);
  };
  walk(root);
  return out;
}

function press(el: FakeEl, key: string): { defaultPrevented: boolean; stopped: boolean } {
  const ev = {
    key,
    defaultPrevented: false,
    stopped: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    stopPropagation() {
      this.stopped = true;
    },
    target: el,
  };
  for (const fn of el.listeners.get('keydown') ?? []) fn(ev as unknown as Event);
  return ev;
}

describe('timelapse: velocidade', () => {
  let restore: (() => void) | null = null;

  afterEach(() => {
    restore?.();
    restore = null;
  });

  it('ArrowRight no rádio focado escolhe a próxima velocidade', () => {
    restore = installDom();
    const player = new TimelapsePlayer({ invalidate() {} } as UiContext);
    const radios = radiosOf(player.el as unknown as FakeEl);
    const current = radios.find((b) => b.textContent === '180×');
    expect(current).toBeTruthy();
    const ev = press(current!, 'ArrowRight');
    // O bug: a seta não mudava a seleção (180× seguia marcada) e a câmera recebia o pan.
    expect((player as unknown as { speed: number }).speed).toBe(600);
    expect(focused?.textContent).toBe('600×');
    expect(radios.find((b) => b.textContent === '600×')?.getAttribute('aria-checked')).toBe('true');
    expect(ev.defaultPrevented).toBe(true);
    expect(ev.stopped).toBe(true);
  });
});
