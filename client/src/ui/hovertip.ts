// Dica flutuante do personagem sob o cursor: acompanha o personagem quadro a quadro.
import type { UiComponent, UiContext } from './context';
import { h, setHidden, setText, setVariant } from './dom';
import { shellStage, shellWaitIn, statusLabel } from './model';
import {
  createAccountChip,
  createActivityLine,
  createStatusDot,
  updateAccountChip,
  updateActivityLine,
  updateShellActivityLine,
  updateStatusDot,
} from './widgets';

export class HoverTip implements UiComponent {
  readonly el: HTMLElement;
  private id: string | null = null;
  private raf = 0;
  private name: HTMLElement;
  private chip: HTMLElement;
  private dot: HTMLElement;
  private status: HTMLElement;
  private activity: HTMLElement;
  private mood: HTMLElement;

  constructor(private ctx: UiContext) {
    this.name = h('strong', { class: 'ui-tip__name' });
    this.chip = createAccountChip('sm');
    this.dot = createStatusDot();
    this.status = h('span', { class: 'ui-tip__status' });
    this.activity = createActivityLine();
    this.mood = h('div', { class: 'ui-tip__mood', hidden: true });
    this.el = h(
      'div',
      { class: 'ui-tip', attrs: { 'aria-hidden': 'true' } },
      h('div', { class: 'ui-tip__top' }, this.name, this.chip),
      h('div', { class: 'ui-tip__line' }, this.dot, this.status),
      this.activity,
      this.mood,
    );
    ctx.world.onHover((id) => this.setTarget(id));
  }

  private setTarget(id: string | null): void {
    if (id === this.id) return;
    this.id = id;
    this.el.classList.toggle('is-visible', !!id);
    cancelAnimationFrame(this.raf);
    if (id) {
      this.render();
      this.follow();
    }
  }

  /** Reposiciona a cada quadro enquanto houver alguém sob o cursor. */
  private follow = (): void => {
    if (!this.id) return;
    const p = this.ctx.world.screenPositionOf(this.id);
    if (!p) {
      this.el.classList.remove('is-visible');
    } else {
      this.el.classList.add('is-visible');
      const w = this.el.offsetWidth;
      const hgt = this.el.offsetHeight;
      const x = Math.round(Math.min(innerWidth - w - 8, Math.max(8, p.x - w / 2)));
      const below = p.y - hgt - 10 < 72;
      const y = Math.round(below ? p.y + 46 : p.y - hgt - 10);
      this.el.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    }
    this.raf = requestAnimationFrame(this.follow);
  };

  render(): void {
    if (!this.id) return;
    const a = this.ctx.agent(this.id);
    if (!a) {
      this.setTarget(null);
      return;
    }
    setText(this.name, a.name);
    updateAccountChip(this.chip, this.ctx.account(a.account), a.account);
    // Esperando um shell: o que ele espera (com o tempo correndo) e o que anda fazendo enquanto isso.
    const now = this.ctx.now();
    const wait = shellWaitIn(a, this.ctx.store.snapshot?.agents ?? [], now);
    const status = wait ? 'shell' : a.status;
    updateStatusDot(this.dot, status);
    setText(this.status, a.status === 'waiting' && a.waitingFor ? `${statusLabel(a.status)}: ${a.waitingFor}` : `${statusLabel(status)}${a.kind === 'sub' ? ` · ${a.role}` : ''}`);
    setVariant(this.el, 'is-', status);
    if (wait) updateShellActivityLine(this.activity, wait, now);
    else updateActivityLine(this.activity, a.activity);
    setHidden(this.mood, !wait);
    if (wait) {
      const stage = shellStage(now - wait.since);
      setText(this.mood, `${stage.emoji} ${stage.text}`);
    }
  }
}
