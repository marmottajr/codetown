// Desenhos animados chamados a cada quadro: telas, quadro kanban, vista da janela e relógio.
// Regras: só fillRect com coordenadas inteiras (barato), sem getImageData e sem criar canvases.
import type { Rect, ScreenMode } from './api';
import { mix } from './core/color';

type Ctx = CanvasRenderingContext2D;

/** Retângulo de recorte ativo: todo fill é limitado a ele (as telas nunca vazam da moldura). */
let clipX0 = -Infinity;
let clipY0 = -Infinity;
let clipX1 = Infinity;
let clipY1 = Infinity;

function clipTo(x: number, y: number, w: number, h: number): void {
  clipX0 = x;
  clipY0 = y;
  clipX1 = x + w;
  clipY1 = y + h;
}

function fill(ctx: Ctx, x: number, y: number, w: number, h: number, c: string): void {
  const x0 = Math.max(x, clipX0);
  const y0 = Math.max(y, clipY0);
  const x1 = Math.min(x + w, clipX1);
  const y1 = Math.min(y + h, clipY1);
  if (x1 <= x0 || y1 <= y0) return;
  ctx.fillStyle = c;
  ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
}

/** Hash inteiro rápido e determinístico (sem alocação). */
function h32(a: number, b = 0): number {
  let x = (Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1)) >>> 0;
  x ^= x >>> 15;
  x = Math.imul(x, 0x85ebca6b) >>> 0;
  x ^= x >>> 13;
  return x >>> 0;
}

function frac(n: number): number {
  return n - Math.floor(n);
}

const SYNTAX = ['#ff79c6', '#8be9fd', '#f1fa8c', '#50fa7b', '#bd93f9', '#ffb86c', '#f8f8f2'] as const;

// ------------------------------------------------------------------ telas

export function drawScreen(ctx: Ctx, r: Rect, mode: ScreenMode, t: number, seed: number): void {
  const x = Math.round(r.x);
  const y = Math.round(r.y);
  const w = Math.round(r.w);
  const h = Math.round(r.h);
  if (w <= 0 || h <= 0) return;
  clipTo(x, y, w, h);
  const s = seed >>> 0;
  switch (mode) {
    case 'off': {
      // Desligado: vidro azul-marinho fosco com reflexo diagonal largo + um fino (lê como tela
      // apagada, não como buraco preto). O fill já recorta ao retângulo.
      fill(ctx, x, y, w, h, '#22324f');
      fill(ctx, x, y, w, 1, '#2a3d5f');
      fill(ctx, x, y + h - 1, w, 1, '#1d2b45');
      const k0 = w - 3 - Math.floor(h / 3);
      for (let i = 0; i < h; i++) {
        const sx = x + k0 - i;
        fill(ctx, sx, y + i, 2, 1, '#2f4569');
        fill(ctx, sx + 2, y + i, 1, 1, '#293c5e');
        fill(ctx, sx + 5, y + i, 1, 1, '#283b5b');
      }
      break;
    }
    case 'standby': {
      // Ligado sem uso: fundo azul em faixas + logo (losango) que "respira" devagar.
      const bands = ['#2d63ad', '#285a9f', '#235192', '#1f4884'];
      for (let i = 0; i < h; i++) fill(ctx, x, y + i, w, 1, bands[Math.min(bands.length - 1, Math.floor((i * bands.length) / h))]);
      fill(ctx, x, y, w, 1, '#3a74c0');
      const cx = x + Math.floor((w - 1) / 2);
      const cy = y + Math.floor((h - 1) / 2) - (h >= 9 ? 1 : 0);
      const pulse = (Math.floor(t / 700) + (s % 3)) % 4;
      const logo = ['#9fcaf5', '#b7d8f8', '#d3e8fb', '#b7d8f8'][pulse];
      fill(ctx, cx, cy - 1, 1, 1, logo);
      fill(ctx, cx - 1, cy, 1, 1, logo);
      fill(ctx, cx + 1, cy, 1, 1, logo);
      fill(ctx, cx, cy + 1, 1, 1, logo);
      fill(ctx, cx, cy, 1, 1, '#6aa6e6');
      // Barrinha sob o logo (campo de "toque para entrar").
      if (h >= 7) fill(ctx, cx - 2, cy + 3, 5, 1, '#4f86c9');
      break;
    }
    case 'idle': {
      // Descanso de tela: degradê suave + bolinha colorida quicando.
      for (let i = 0; i < h; i++) fill(ctx, x, y + i, w, 1, mix('#1b2a4a', '#2c1f4a', i / h));
      const px = bounce(t / 140 + (s % 17), Math.max(1, w - 2));
      const py = bounce(t / 190 + (s % 11), Math.max(1, h - 2));
      const hue = Math.floor(t / 900 + s) % 4;
      fill(ctx, x + px, y + py, 2, 2, ['#7fd0ff', '#ff9ad5', '#9be59b', '#ffd36b'][hue]);
      break;
    }
    case 'code': {
      fill(ctx, x, y, w, h, '#1d2130');
      fill(ctx, x, y, Math.min(2, w), h, '#252a3c');
      const rows = Math.floor(h / 2);
      const scroll = Math.floor(t / 420 + (s % 50));
      for (let i = 0; i < rows; i++) {
        const line = scroll + i;
        const hh = h32(s, line);
        const yy = y + i * 2 + 1;
        if (yy >= y + h) break;
        fill(ctx, x, yy, 1, 1, '#4a5170');
        let cx = x + 3 + (hh % 4);
        const tokens = 1 + ((hh >>> 3) % 3);
        if ((hh >>> 7) % 7 === 0) continue; // linha em branco
        for (let k = 0; k < tokens && cx < x + w - 1; k++) {
          const tw = 1 + ((hh >>> (9 + k * 4)) % 4);
          fill(ctx, cx, yy, Math.min(tw, x + w - 1 - cx), 1, SYNTAX[(hh >>> (5 + k * 3)) % SYNTAX.length]);
          cx += tw + 1;
        }
        if (i === rows - 1 && Math.floor(t / 500) % 2 === 0 && cx < x + w) fill(ctx, cx, yy, 1, 1, '#f8f8f2');
      }
      break;
    }
    case 'terminal': {
      fill(ctx, x, y, w, h, '#0c120f');
      const rows = Math.floor((h - 1) / 2);
      const step = Math.floor(t / 260) + (s % 40);
      const lineLen = (n: number) => 2 + (h32(s, n) % Math.max(2, w - 4));
      // A linha atual "digita" aos poucos; as anteriores ficam mais apagadas. Cada linha ocupa uma
      // janela FIXA de passos (a mais longa possível + pausa), então a linha atual sai direto de
      // `step` em O(1): o custo por quadro depende só do tamanho da tela, nunca do valor de `t`
      // (o mundo passa Date.now(), ~1,8e12 ms). Linhas curtas ficam com o cursor piscando no fim.
      const slot = Math.max(2, w - 4) + 3;
      const line = Math.floor(step / slot);
      const typed = Math.min(lineLen(line), step - line * slot);
      for (let i = 0; i < rows; i++) {
        const n = line - (rows - 1) + i;
        if (n < 0) continue;
        const yy = y + 1 + i * 2;
        const len = n === line ? typed : lineLen(n);
        fill(ctx, x + 1, yy, 1, 1, '#5cff7a');
        fill(ctx, x + 3, yy, Math.min(len, w - 4), 1, n === line ? '#8ef0a0' : '#3fae5c');
        if (n === line && Math.floor(t / 450) % 2 === 0) fill(ctx, x + 3 + Math.min(len, w - 5), yy, 1, 1, '#d6ffe0');
      }
      break;
    }
    case 'browser': {
      fill(ctx, x, y, w, h, '#f3f5f8');
      fill(ctx, x, y, w, 2, '#d5dbe4');
      fill(ctx, x + 1, y, 1, 1, '#ff6b6b');
      if (w > 6) fill(ctx, x + 3, y, 1, 1, '#f7c948');
      if (w > 8) fill(ctx, x + 5, y + 1, w - 6, 1, '#ffffff');
      const off = Math.floor(t / 900 + (s % 9)) % 4;
      const accent = ['#5b8fe0', '#4cae6a', '#e2604f', '#8d66cf'][s % 4];
      const top = y + 3;
      for (let i = 0; i < h - 3; i++) {
        const row = i + off;
        const yy = top + i;
        if (row % 6 < 3) {
          if (row % 12 < 3) fill(ctx, x + 1, yy, Math.max(1, Math.floor(w * 0.45)), 1, accent);
          else fill(ctx, x + 1, yy, Math.max(1, w - 2 - (row % 5)), 1, row % 6 === 0 ? '#9aa5b5' : '#c8cfd9');
        } else if (row % 6 === 3) {
          fill(ctx, x + 1, yy, Math.floor(w / 2) - 1, 2, mix(accent, '#ffffff', 0.55));
          fill(ctx, x + Math.floor(w / 2) + 1, yy, Math.ceil(w / 2) - 2, 1, '#c8cfd9');
        }
      }
      break;
    }
    case 'search': {
      fill(ctx, x, y, w, h, '#ffffff');
      fill(ctx, x + 1, y + 1, w - 2, 2, '#e3e8ef');
      fill(ctx, x + 2, y + 1, Math.max(1, w - 6), 1, '#ffffff');
      fill(ctx, x + w - 3, y + 1, 1, 1, '#3f7fd8');
      fill(ctx, x + w - 2, y + 2, 1, 1, '#3f7fd8');
      const sel = Math.floor(t / 700 + (s % 5)) % 3;
      for (let i = 0; i < 3; i++) {
        const yy = y + 4 + i * 3;
        if (yy + 1 >= y + h) break;
        if (i === sel) fill(ctx, x, yy - 1, w, 3, '#eef4ff');
        fill(ctx, x + 1, yy, Math.max(1, w - 4 - ((s + i) % 4)), 1, '#3f7fd8');
        fill(ctx, x + 1, yy + 1, Math.max(1, w - 6 + ((s + i) % 3)), 1, '#b6bfcc');
      }
      break;
    }
    case 'chat': {
      fill(ctx, x, y, w, h, '#eef1f6');
      const step = Math.floor(t / 1100 + (s % 13));
      const bubbles = Math.floor(h / 3);
      for (let i = 0; i < bubbles; i++) {
        const n = step + i;
        const mine = (h32(s, n) & 1) === 1;
        const bw = Math.max(3, Math.min(w - 3, 4 + (h32(s, n) >>> 2) % Math.max(1, w - 5)));
        const yy = y + h - 3 - (bubbles - 1 - i) * 3;
        if (yy < y) continue;
        fill(ctx, mine ? x + w - 1 - bw : x + 1, yy, bw, 2, mine ? '#5b8fe0' : '#d6dce6');
      }
      // Indicador "digitando".
      const dot = Math.floor(t / 250) % 3;
      for (let k = 0; k < 3; k++) fill(ctx, x + 2 + k * 2, y + 1, 1, 1, k === dot ? '#5b6b85' : '#b8c2d2');
      break;
    }
    case 'docs': {
      fill(ctx, x, y, w, h, '#e9edf2');
      fill(ctx, x + 1, y, w - 2, h, '#ffffff');
      const off = Math.floor(t / 1500 + (s % 7)) % 3;
      fill(ctx, x + 2, y + 1, Math.max(1, Math.floor(w * 0.5)), 1, '#2b2f3b');
      for (let i = 0; i < h - 3; i++) {
        const row = i + off;
        const yy = y + 3 + i;
        if (row % 4 === 3) continue;
        fill(ctx, x + 2, yy, Math.max(1, w - 4 - (h32(s, row) % 4)), 1, row % 4 === 0 ? '#7d8796' : '#b9c1cd');
      }
      break;
    }
    case 'tasks': {
      fill(ctx, x, y, w, h, '#fffaf0');
      const rows = Math.floor((h - 1) / 2);
      const done = Math.floor(t / 900 + (s % 6)) % (rows + 2);
      for (let i = 0; i < rows; i++) {
        const yy = y + 1 + i * 2;
        const ok = i < done;
        fill(ctx, x + 1, yy, 1, 1, ok ? '#3fae5c' : '#b9c1cd');
        fill(ctx, x + 3, yy, Math.max(1, w - 5 - ((s + i) % 3)), 1, ok ? '#a8d8b3' : '#8b95a5');
      }
      break;
    }
    case 'progress': {
      // Esperando um comando: terminal escuro com o comando no topo, barra de progresso que enche e
      // recomeça (com um brilho correndo na ponta), spinner girando e cursor piscando. Tudo O(1)
      // por quadro (só depende do tamanho da tela), como os demais modos.
      fill(ctx, x, y, w, h, '#0b1210');
      fill(ctx, x, y + h - 1, w, 1, '#0f1916');
      const tiny = h < 9;
      // Linha do comando: prompt + texto apagado (comprimento varia por semente).
      fill(ctx, x + 1, y + 1, 1, 1, '#5cff7a');
      fill(ctx, x + 3, y + 1, Math.max(1, Math.min(w - 5, 4 + (h32(s, 1) % Math.max(1, w - 7)))), 1, '#3c8f57');
      // Saída anterior (só em telas maiores, ex.: TV).
      if (h >= 13) {
        fill(ctx, x + 3, y + 3, Math.max(1, Math.min(w - 5, 3 + (h32(s, 2) % Math.max(1, w - 6)))), 1, '#2a5c3c');
        fill(ctx, x + 3, y + 5, Math.max(1, Math.min(w - 5, 2 + (h32(s, 3) % Math.max(1, w - 6)))), 1, '#2a5c3c');
      }
      // Barra: colchetes nas pontas, trilho escuro, enchimento verde com topo claro e ponta brilhante.
      const by = tiny ? y + 3 : h >= 13 ? y + h - 7 : y + 3;
      const bh = tiny ? 1 : 2;
      const inner = Math.max(1, w - 4);
      fill(ctx, x + 1, by, 1, bh, '#7d8ea0');
      fill(ctx, x + w - 2, by, 1, bh, '#7d8ea0');
      fill(ctx, x + 2, by, inner, bh, '#163322');
      const period = 3400 + (s % 5) * 300; // ciclo de cada monitor um pouco diferente
      const cycle = (t + (s % 997) * 37) / period;
      const p = frac(cycle);
      // Enche em 85% do ciclo e segura cheia no resto (pisca antes de recomeçar).
      const filled = p < 0.85 ? Math.floor((p / 0.85) * (inner + 1)) : inner;
      const done = p >= 0.85;
      if (filled > 0) {
        const blink = done && Math.floor(t / 160) % 2 === 0;
        fill(ctx, x + 2, by, filled, bh, blink ? '#b9ffca' : '#3ccf63');
        if (bh > 1) fill(ctx, x + 2, by, filled, 1, blink ? '#e4ffe9' : '#7cf09a');
        if (!done) fill(ctx, x + 1 + filled, by, 1, bh, '#d8ffe2');
      }
      // Spinner (anel 3x3 com cabeça brilhante e rastro) + cursor piscando ao lado.
      const sy = tiny ? y + h - 3 : h >= 13 ? y + h - 4 : y + h - 4;
      if (sy + 2 < y + h) {
        const RING = [[1, 0], [2, 0], [2, 1], [2, 2], [1, 2], [0, 2], [0, 1], [0, 0]] as const;
        const head = Math.floor(t / 110 + (s % 8)) % 8;
        for (let k = 0; k < 8; k++) {
          const age = (head - k + 8) % 8;
          const c = age === 0 ? '#9ff3ff' : age === 1 ? '#4fb8d6' : age === 2 ? '#2b6f86' : '#173a45';
          fill(ctx, x + 1 + RING[k][0], sy + RING[k][1], 1, 1, c);
        }
        // Pontinhos "..." que vão aparecendo e o cursor de bloco.
        const dots = Math.floor(t / 420 + (s % 3)) % 4;
        for (let k = 0; k < dots && 5 + k * 2 < w - 2; k++) fill(ctx, x + 5 + k * 2, sy + 2, 1, 1, '#3c8f57');
        if (Math.floor(t / 500) % 2 === 0 && x + 11 < x + w) fill(ctx, x + 11, sy + 1, 1, 2, '#d6ffe0');
      }
      break;
    }
    case 'alert': {
      const on = Math.floor(t / 380) % 2 === 0;
      fill(ctx, x, y, w, h, on ? '#f2b33d' : '#8a5a12');
      const cx = x + Math.floor(w / 2);
      const cy = y + Math.floor(h / 2);
      const ink = on ? '#3a2a08' : '#f7d27a';
      fill(ctx, cx, cy - 2, 1, 3, ink);
      fill(ctx, cx, cy + 2, 1, 1, ink);
      if (h >= 9) {
        fill(ctx, cx - 1, cy - 3, 3, 1, ink);
        fill(ctx, cx, cy - 4, 1, 1, ink);
      }
      break;
    }
  }
}

function bounce(v: number, span: number): number {
  const p = frac(v / (span * 2)) * span * 2;
  return Math.floor(p < span ? p : span * 2 - p);
}

// ------------------------------------------------------------------ quadro kanban

const NOTE = {
  pending: ['#ffe27a', '#ffd0a8'],
  in_progress: ['#8fd0ff', '#a9e0ff'],
  completed: ['#9be59b', '#b8efb0'],
} as const;

export function drawBoard(ctx: Ctx, r: Rect, items: readonly { status: 'pending' | 'in_progress' | 'completed' }[], t: number): void {
  const x = Math.round(r.x);
  const y = Math.round(r.y);
  const w = Math.round(r.w);
  const h = Math.round(r.h);
  clipTo(x, y, w, h);
  const colW = Math.floor(w / 3);
  const header = ['#f2b33d', '#3f7fd8', '#3fae5c'];
  for (let c = 0; c < 3; c++) {
    fill(ctx, x + c * colW + 1, y, colW - 2, 1, header[c]);
    if (c > 0) fill(ctx, x + c * colW - 1, y + 2, 1, h - 3, '#e1e6ec');
  }
  const order = ['pending', 'in_progress', 'completed'] as const;
  const per = colW >= 11 ? 2 : 1;
  const counts = [0, 0, 0];
  for (const it of items) {
    const c = order.indexOf(it.status);
    if (c < 0) continue;
    const k = counts[c]++;
    const nx = x + c * colW + 1 + (k % per) * 5;
    const ny = y + 2 + Math.floor(k / per) * 4;
    if (ny + 3 > y + h) {
      // Excesso: pontinhos no rodapé da coluna.
      if (k % per === 0) fill(ctx, x + c * colW + Math.floor(colW / 2) - 1, y + h - 1, 3, 1, '#9aa4b2');
      continue;
    }
    const pal = NOTE[it.status];
    const col = pal[k % 2];
    fill(ctx, nx, ny, 4, 3, col);
    fill(ctx, nx, ny + 2, 4, 1, mix(col, '#7a6a4a', 0.25));
    fill(ctx, nx + 1, ny + 1, 2, 1, mix(col, '#2b2f3b', 0.35));
    if (it.status === 'completed') fill(ctx, nx + 3, ny, 1, 1, '#2e8a46');
    if (it.status === 'in_progress' && Math.floor(t / 600 + k) % 2 === 0) fill(ctx, nx, ny, 4, 1, '#e8f6ff');
  }
}

// ------------------------------------------------------------------ janela

/** Chaves de cor do céu ao longo do dia: [hora, topo, horizonte]. */
const SKY: readonly (readonly [number, string, string])[] = [
  [0, '#0b1230', '#1f2b57'],
  [4.6, '#0e1838', '#28335f'],
  [5.6, '#38397a', '#e48a6c'],
  [6.6, '#6ea6df', '#f5c99c'],
  [8, '#79b8eb', '#d2ebfa'],
  [16, '#70b0e8', '#d8edf8'],
  [17.4, '#5f86c8', '#f5b37c'],
  [18.4, '#4a4f96', '#ef8a68'],
  [19.4, '#26295f', '#7a4e86'],
  [20.4, '#111b42', '#2b3565'],
  [24, '#0b1230', '#1f2b57'],
];

function skyAt(hour: number): { top: string; bottom: string; night: number; day: number } {
  const hr = ((hour % 24) + 24) % 24;
  let i = 0;
  while (i < SKY.length - 2 && SKY[i + 1][0] <= hr) i++;
  const [h0, t0, b0] = SKY[i];
  const [h1, t1, b1] = SKY[i + 1];
  const u = (hr - h0) / Math.max(0.001, h1 - h0);
  const night = hr < 5 || hr > 20 ? 1 : hr < 6.2 ? Math.max(0, (6.2 - hr) / 1.2) : hr > 19 ? Math.min(1, (hr - 19) / 1.2) : 0;
  const day = hr > 7 && hr < 17 ? 1 : hr >= 6 && hr <= 7 ? hr - 6 : hr >= 17 && hr <= 18.5 ? (18.5 - hr) / 1.5 : 0;
  return { top: mix(t0, t1, u), bottom: mix(b0, b1, u), night, day };
}

export function drawWindowView(ctx: Ctx, r: Rect, hour: number, t: number, seed: number): void {
  const x = Math.round(r.x);
  const y = Math.round(r.y);
  const w = Math.round(r.w);
  const h = Math.round(r.h);
  if (w <= 0 || h <= 0) return;
  clipTo(x, y, w, h);
  const s = seed >>> 0;
  const sky = skyAt(hour);
  for (let i = 0; i < h; i++) fill(ctx, x, y + i, w, 1, mix(sky.top, sky.bottom, i / Math.max(1, h - 1)));
  // Estrelas e lua.
  if (sky.night > 0.3) {
    for (let k = 0; k < 7; k++) {
      const hh = h32(s, k + 101);
      const sx = x + (hh % w);
      const sy = y + ((hh >>> 8) % Math.max(1, Math.floor(h * 0.55)));
      const tw = Math.floor(t / 600 + k) % 5 === 0;
      fill(ctx, sx, sy, 1, 1, tw ? '#8090c0' : '#f2f4ff');
    }
    const mx = x + Math.floor(w * 0.72);
    fill(ctx, mx, y + 2, 3, 3, '#f4efd2');
    fill(ctx, mx + 2, y + 2, 1, 1, sky.top);
    fill(ctx, mx, y + 4, 1, 1, '#d9d2ad');
  }
  // Sol (arco ao longo do dia).
  const hr = ((hour % 24) + 24) % 24;
  if (hr > 5.6 && hr < 19) {
    const p = (hr - 5.6) / 13.4;
    const sx = x + Math.floor(p * (w - 3));
    const sy = y + Math.floor((1 - Math.sin(p * Math.PI)) * (h * 0.55)) + 1;
    const warm = sky.day < 0.7;
    fill(ctx, sx - 1, sy, 5, 3, warm ? 'rgba(255,190,120,0.35)' : 'rgba(255,250,210,0.35)');
    fill(ctx, sx, sy, 3, 3, warm ? '#ffcf86' : '#fff6c8');
  }
  // Nuvens deslizando.
  if (sky.night < 0.8) {
    const cloud = sky.day > 0.5 ? 'rgba(255,255,255,0.9)' : 'rgba(255,214,190,0.75)';
    for (let k = 0; k < 2; k++) {
      const hh = h32(s, k + 7);
      const span = w + 12;
      const cx = x - 6 + Math.floor(frac((t / 1000) * (0.35 + k * 0.2) / span + (hh % 100) / 100) * span);
      const cy = y + 2 + k * 3 + ((hh >>> 4) % 2);
      const cw = 5 + (hh % 3);
      for (let i = 0; i < cw; i++) {
        const xx = cx + i;
        if (xx < x || xx >= x + w) continue;
        fill(ctx, xx, cy + 1, 1, 1, cloud);
        if (i > 0 && i < cw - 1) fill(ctx, xx, cy, 1, 1, cloud);
      }
    }
  }
  // Silhueta da cidade (janelas acesas à noite).
  const city = mix('#8ea8c6', '#1a2138', Math.max(sky.night, 1 - sky.day) * 0.9);
  const cityFar = mix('#b3c6dc', '#262f4d', Math.max(sky.night, 1 - sky.day) * 0.9);
  let bx = x;
  let k = 0;
  while (bx < x + w) {
    const hh = h32(s, k + 300);
    const bw = 3 + (hh % 4);
    const bh = 3 + ((hh >>> 4) % Math.max(2, Math.floor(h * 0.42)));
    const far = (hh >>> 9) % 3 === 0;
    const ww = Math.min(bw, x + w - bx);
    fill(ctx, bx, y + h - bh - (far ? 2 : 0), ww, bh + (far ? 2 : 0), far ? cityFar : city);
    if (sky.night > 0.2) {
      for (let wy = y + h - bh + 1; wy < y + h - 1; wy += 2) {
        for (let wx = bx + 1; wx < bx + ww - 1; wx += 2) {
          const on = h32(s + wx * 31, wy) % 3 === 0;
          if (on) fill(ctx, wx, wy, 1, 1, Math.floor(t / 3000 + wx + wy) % 17 === 0 ? '#c99a40' : '#f7d77a');
        }
      }
    } else if (!far && bw > 3) {
      for (let wy = y + h - bh + 1; wy < y + h - 1; wy += 2) fill(ctx, bx + 1, wy, ww - 2, 1, mix(city, '#e6f0fa', 0.35));
    }
    bx += bw;
    k++;
  }
}

// ------------------------------------------------------------------ relógio

export function drawClock(ctx: Ctx, r: Rect, date: Date): void {
  clipTo(Math.round(r.x), Math.round(r.y), Math.round(r.w), Math.round(r.h));
  const cx = r.x + r.w / 2;
  const cy = r.y + r.h / 2;
  const sec = date.getSeconds();
  const min = date.getMinutes() + sec / 60;
  const hr = (date.getHours() % 12) + min / 60;
  const hand = (angle: number, len: number, color: string) => {
    const a = angle - Math.PI / 2;
    const steps = Math.ceil(len * 2);
    let lx = -999;
    let ly = -999;
    for (let i = 1; i <= steps; i++) {
      const d = (len * i) / steps;
      const px = Math.floor(cx + Math.cos(a) * d);
      const py = Math.floor(cy + Math.sin(a) * d);
      if (px === lx && py === ly) continue;
      fill(ctx, px, py, 1, 1, color);
      lx = px;
      ly = py;
    }
  };
  const size = Math.min(r.w, r.h);
  hand((hr / 12) * Math.PI * 2, size * 0.26, '#2b2f3b');
  hand((min / 60) * Math.PI * 2, size * 0.4, '#3a3f4b');
  hand((sec / 60) * Math.PI * 2, size * 0.38, 'rgba(224,90,90,0.85)');
  fill(ctx, Math.floor(cx), Math.floor(cy), 1, 1, '#e05a5a');
}
