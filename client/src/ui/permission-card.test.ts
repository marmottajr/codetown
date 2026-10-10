// O cartão de permissão de verdade (PermissionCard) montado num DOM mínimo (o repo roda vitest em node, sem jsdom):
// uma pergunta do OpenCode tem de mostrar o formulário de resposta, e o que ele manda tem de ser o corpo que o
// servidor aceita. Pegaria o bug em que o cliente tratava a pergunta do OpenCode como um pedido de aprovação.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AgentInfo, AskQuestion, PermissionDecision, PermissionRequestInfo } from '../../../shared/types';
import { buildAnswers, PermissionCard, type AskChoice } from './permission';

// ---------------------------------------------------------------- DOM mínimo
class FakeText {
  parentNode: FakeEl | null = null;
  constructor(public textContent: string) {}
}
type FakeNode = FakeEl | FakeText;
class FakeEl {
  parentNode: FakeEl | null = null;
  children: FakeNode[] = [];
  attrs = new Map<string, string>();
  dataset: Record<string, string> = {};
  listeners = new Map<string, ((e: unknown) => void)[]>();
  className = '';
  hidden = false;
  disabled = false;
  checked = false;
  private v: string | undefined;
  get value(): string {
    return this.v ?? this.attrs.get('value') ?? '';
  }
  set value(x: string) {
    this.v = x;
  }
  title = '';
  tabIndex = 0;
  innerHTML = '';
  classList = {
    toggle: (c: string, on?: boolean) => {
      const set = new Set(this.className.split(/\s+/).filter(Boolean));
      if (on ?? !set.has(c)) set.add(c);
      else set.delete(c);
      this.className = [...set].join(' ');
    },
    add: (c: string) => this.classList.toggle(c, true),
    remove: (c: string) => this.classList.toggle(c, false),
  };
  constructor(public tagName: string) {}
  get firstChild(): FakeNode | null {
    return this.children[0] ?? null;
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
  prepend(...cs: (FakeNode | string)[]): void {
    this.children.unshift(...cs.map((c) => this.adopt(c)));
  }
  replaceChildren(...cs: (FakeNode | string)[]): void {
    this.children = [];
    this.append(...cs.filter((c) => c !== ''));
  }
  remove(): void {
    if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((c) => c !== this);
  }
  addEventListener(t: string, fn: (e: unknown) => void): void {
    this.listeners.set(t, [...(this.listeners.get(t) ?? []), fn]);
  }
  dispatch(t: string, extra: object = {}): void {
    const e = { type: t, key: '', preventDefault() {}, ...extra };
    for (const fn of this.listeners.get(t) ?? []) fn(e);
    // "change" e "input" sobem até o formulário (como no navegador).
    if ((t === 'change' || t === 'input') && this.parentNode) this.parentNode.dispatch(t, extra);
  }
  focus(): void {}
  blur(): void {}
  scrollIntoView(): void {}
  querySelectorAll<T = FakeEl>(sel: string): T[] {
    const tags = sel.split(',').map((s) => s.trim().toUpperCase());
    const out: FakeEl[] = [];
    const walk = (n: FakeEl) => {
      for (const c of n.children) {
        if (c instanceof FakeEl) {
          if (tags.includes(c.tagName.toUpperCase())) out.push(c);
          walk(c);
        }
      }
    };
    walk(this);
    return out as T[];
  }
  /** Clique de verdade: botão desligado não dispara. */
  click(): void {
    if (this.disabled) return;
    this.dispatch('click');
  }
}

const KEYS = ['document', 'location', 'requestAnimationFrame'] as const;
const saved: Record<string, unknown> = {};
beforeAll(() => {
  for (const k of KEYS) saved[k] = (globalThis as Record<string, unknown>)[k];
  Object.assign(globalThis, {
    document: { createElement: (t: string) => new FakeEl(t), createTextNode: (s: string) => new FakeText(s) },
    location: { hostname: 'localhost' },
    requestAnimationFrame: () => 0,
  });
});
afterAll(() => {
  for (const k of KEYS) (globalThis as Record<string, unknown>)[k] = saved[k];
});

// ---------------------------------------------------------------- montagem
const single: AskQuestion = { index: 0, question: 'Qual ambiente?', header: 'Ambiente', multiSelect: false, options: [{ index: 0, label: 'Dev' }, { index: 1, label: 'Prod', description: 'cuidado' }] };
const multi: AskQuestion = { index: 1, question: 'Quais testes?', header: 'Testes', multiSelect: true, options: [{ index: 0, label: 'Unidade' }, { index: 1, label: 'E2E' }] };

function agentWith(permission: Partial<PermissionRequestInfo>): AgentInfo {
  return {
    id: 'a1',
    kind: 'main',
    roomId: 'r',
    name: 'a1',
    look: 'f',
    role: 'Agente principal',
    sessionId: 's1',
    account: 'acc',
    status: 'waiting',
    recent: [],
    tasks: [],
    startedAt: 0,
    lastEventAt: 0,
    statusSince: 0,
    stats: { toolCalls: 0, tokensIn: 0, tokensOut: 0, subagents: 0 },
    seed: 1,
    permission: { id: 'p1', tool: 'Bash', title: 'Bash(ls)', text: 'Listando', icon: '💻', createdAt: 0, expiresAt: 100_000, ...permission },
  } as AgentInfo;
}

function mount(permission: Partial<PermissionRequestInfo>) {
  const sent: PermissionDecision[] = [];
  const ctx = {
    root: new FakeEl('div'),
    store: {
      mock: true,
      decidePermission: async (_id: string, d: PermissionDecision) => {
        sent.push(d);
        return undefined;
      },
      permissionDetail: async () => null,
    },
    now: () => 0,
    invalidate: vi.fn(),
    announce: vi.fn(),
    agent: () => undefined,
  };
  const card = new PermissionCard(ctx as never);
  card.render(agentWith(permission));
  const el = card.el as unknown as FakeEl;
  const inputs = (): FakeEl[] => el.querySelectorAll('input').filter((i) => !i.className.includes('ui-perm__check'));
  const buttons = (): FakeEl[] => el.querySelectorAll('button').filter((b) => !b.hidden && !isHiddenByParent(b, el));
  const button = (label: RegExp) => el.querySelectorAll('button').find((b) => label.test(b.textContent));
  return { card, el, sent, inputs, buttons, button, render: (p: Partial<PermissionRequestInfo>) => card.render(agentWith(p)) };
}

function isHiddenByParent(n: FakeEl, root: FakeEl): boolean {
  for (let p = n.parentNode; p && p !== root; p = p.parentNode) if (p.hidden) return true;
  return false;
}

/** Visível = o próprio elemento e os pais (até o cartão) não estão escondidos. */
const visible = (n: FakeEl | undefined, root: FakeEl) => !!n && !n.hidden && !isHiddenByParent(n, root);

const OC_ASK = { tool: 'AskUserQuestion', provider: 'opencode', title: 'AskUserQuestion', text: 'Pergunta', icon: '❓', questions: [single, multi] } as Partial<PermissionRequestInfo>;

describe('PermissionCard: pergunta do OpenCode mostra o formulário de resposta', () => {
  it('renderiza rádios (escolha única), caixas (várias) e o "Outro", sem o botão Aprovar', () => {
    const { el, inputs, button } = mount(OC_ASK);
    expect(el.dataset.kind).toBe('ask');
    expect(el.attrs.get('aria-label')).toBe('Pergunta do agente');
    const types = inputs().map((i) => i.attrs.get('type'));
    expect(types.filter((t) => t === 'radio')).toHaveLength(3); // Dev, Prod, Outro
    expect(types.filter((t) => t === 'checkbox')).toHaveLength(3); // Unidade, E2E, Outro
    expect(inputs().filter((i) => i.attrs.get('type') === 'text')).toHaveLength(2);
    expect(visible(button(/Aprovar/), el)).toBe(false);
    expect(visible(button(/Responder$/), el)).toBe(true);
    expect(visible(button(/Recusar/), el)).toBe(true);
    expect(el.textContent).toContain('Perguntas para você');
    expect(el.textContent).not.toMatch(/só aprovar ou recusar/i);
  });

  it('escolhendo as opções e clicando Responder manda {behavior:"answer", answers} como o buildAnswers monta', async () => {
    const { el, sent, inputs, button } = mount(OC_ASK);
    const answerBtn = button(/Responder$/)!;
    expect(answerBtn.disabled).toBe(true); // falta responder
    const radio = inputs().find((i) => i.attrs.get('type') === 'radio' && i.value === '1')!;
    radio.checked = true;
    radio.dispatch('change');
    expect(answerBtn.disabled).toBe(true); // falta a segunda pergunta
    for (const v of ['1', '0']) {
      const box = inputs().find((i) => i.attrs.get('type') === 'checkbox' && i.value === v)!;
      box.checked = true;
      box.dispatch('change');
    }
    expect(answerBtn.disabled).toBe(false);
    answerBtn.click();
    await Promise.resolve();
    const choices = new Map<number, AskChoice>([
      [0, { options: [1], otherOn: false, otherText: '' }],
      [1, { options: [0, 1], otherOn: false, otherText: '' }],
    ]);
    const expected = buildAnswers([single, multi], choices);
    expect(expected).toEqual([{ question: 0, options: [1] }, { question: 1, options: [0, 1] }]);
    expect(sent).toEqual([{ behavior: 'answer', answers: expected }]);
    expect(el.textContent).toContain('Respondido.');
  });

  it('"Outro" com texto livre vira {question, other} (e o texto marca o "Outro" sozinho)', async () => {
    const { sent, inputs, button } = mount({ ...OC_ASK, questions: [single] });
    const text = inputs().find((i) => i.attrs.get('type') === 'text')!;
    text.value = '  staging  ';
    text.dispatch('input');
    button(/Responder$/)!.click();
    await Promise.resolve();
    expect(sent).toEqual([{ behavior: 'answer', answers: [{ question: 0, other: 'staging' }] }]);
  });

  it('"Não responder" manda {behavior:"deny"} sem motivo obrigatório (só o texto, se houver, vai junto)', async () => {
    const { el, sent, button } = mount(OC_ASK);
    button(/Recusar/)!.click(); // abre o formulário de recusa
    const submit = el.querySelectorAll('button').find((b) => b.attrs.get('type') === 'submit' && /^Recusar$/.test(b.textContent))!;
    expect(submit.disabled).toBe(false); // sem motivo escrito, mesmo assim liga
    const denyForm = el.children.find((c) => c instanceof FakeEl && c.className === 'ui-perm__deny') as FakeEl;
    denyForm.dispatch('submit');
    await Promise.resolve();
    expect(sent).toEqual([{ behavior: 'deny' }]);
  });

  it('aviso e prazo seguem o do OpenCode (segundos), sem sempre permitir nem interromper', () => {
    const { el } = mount({ ...OC_ASK, expiresAt: 30_000 });
    expect(el.textContent).toContain('No OpenCode, o pedido já está na tela dele');
    expect(el.textContent).toContain('volta ao terminal em 30 s');
    expect(el.classList).toBeDefined();
    expect(el.className).toContain('is-opencode');
  });
});

describe('contrato com o servidor (server/permissions/opencode.test.ts)', () => {
  it('buildAnswers das perguntas do servidor dá o mesmo corpo que o registro aceita lá', () => {
    const qs: AskQuestion[] = [
      { index: 0, question: 'a', header: 'a', multiSelect: false, options: [{ index: 0, label: 'x' }, { index: 1, label: 'y' }] },
      { index: 1, question: 'b', header: 'b', multiSelect: true, options: [{ index: 0, label: 'Unidade' }, { index: 1, label: 'E2E' }] },
    ];
    const choices = new Map<number, AskChoice>([
      [0, { options: [1], otherOn: false, otherText: '' }],
      [1, { options: [0], otherOn: true, otherText: ' lint ' }],
    ]);
    expect(buildAnswers(qs, choices)).toEqual([{ question: 0, options: [1] }, { question: 1, options: [0], other: 'lint' }]);
  });
});

describe('PermissionCard: o que não é pergunta do OpenCode segue igual', () => {
  it('permissão comum do OpenCode: Aprovar/Recusar, sem formulário, recusar exige motivo', async () => {
    const { el, sent, inputs, button } = mount({ provider: 'opencode', tool: 'bash' });
    expect(el.dataset.kind).toBe('perm');
    expect(inputs().filter((i) => i.attrs.get('type') === 'radio')).toHaveLength(0);
    expect(visible(button(/Aprovar/), el)).toBe(true);
    expect(visible(button(/Responder$/), el)).toBe(false);
    const submit = el.querySelectorAll('button').find((b) => b.attrs.get('type') === 'submit')!;
    expect(submit.disabled).toBe(true); // motivo obrigatório
    button(/Aprovar/)!.click();
    await Promise.resolve();
    expect(sent).toEqual([{ behavior: 'allow' }]);
  });

  it('Claude: pergunta com formulário e "Responder no terminal"; permissão com Aprovar', () => {
    const q = mount({ tool: 'AskUserQuestion', title: 'AskUserQuestion', questions: [single] });
    expect(q.el.dataset.kind).toBe('ask');
    expect(visible(q.button(/Responder$/), q.el)).toBe(true);
    expect(visible(q.button(/Responder no terminal/), q.el)).toBe(true);
    expect(visible(q.button(/Aprovar/), q.el)).toBe(false);
    const p = mount({});
    expect(p.el.dataset.kind).toBe('perm');
    expect(visible(p.button(/Aprovar/), p.el)).toBe(true);
  });

  it('Codex: nunca vira cartão de pergunta, nem com a ferramenta de pergunta', () => {
    const c = mount({ provider: 'codex', tool: 'AskUserQuestion', questions: [single] });
    expect(c.el.dataset.kind).toBe('perm');
    expect(visible(c.button(/Aprovar/), c.el)).toBe(true);
  });
});
