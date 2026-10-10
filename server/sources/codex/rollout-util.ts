// Leitura tolerante dos valores soltos do JSON do rollout (objeto, texto, número, data). É a folha do rollout.ts: os
// módulos rollout-*.ts importam daqui e nenhum deles importa do rollout.ts.
export type Rec = Record<string, unknown>;

export function rec(v: unknown): Rec | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : undefined;
}

export function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v : undefined;
}

export function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

export function toMs(v: unknown): number | undefined {
  if (typeof v !== 'string') return undefined;
  const t = Date.parse(v);
  return Number.isNaN(t) ? undefined : t;
}
