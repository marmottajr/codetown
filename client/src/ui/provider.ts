// De qual ferramenta é cada coisa (Claude Code ou Codex) e os textos que mudam com ela. Puro (sem DOM): testado em
// ui/provider.test.ts. No protocolo, `provider` ausente quer dizer Claude Code (shared/types.ts); aqui tudo cai nisso.
//
// Identidade visual do Codex (sem logotipo de ninguém): o chip da conta fica "vazado" (fundo escuro, borda e letra na
// cor da conta, cantos em degrau) e, onde há espaço, um selo de texto "Codex" ao lado do nome.
import type { AccountInfo, OfficeSnapshot, Provider } from '../../../shared/types';
import { shortcutHint } from './model';

/** Nome de cada ferramenta como aparece nos textos. */
export const PROVIDER_NAME: Record<Provider, string> = { claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode' };

/** Ferramenta de um agente, conta, sessão ou pedido (ausente = Claude Code). */
export function providerOf(x: { provider?: Provider } | null | undefined): Provider {
  return x?.provider ?? 'claude';
}

export function isCodex(x: { provider?: Provider } | null | undefined): boolean {
  return x?.provider === 'codex';
}

export function isOpencode(x: { provider?: Provider } | null | undefined): boolean {
  return x?.provider === 'opencode';
}

/** O id de conta é o do OpenCode ("opencode", "opencode~2", "demo:opencode")? Mesma ideia de looksLikeCodexId. */
export function looksLikeOpencodeId(id: string): boolean {
  return /(?:^|[:/\\])\.?opencode(?:[-_.~]|$)/i.test(id);
}

/**
 * O id de conta tem cara de pasta do Codex (".codex", ".codex-trabalho", ".codex~2", "demo:.codex")? Só para quando a
 * conta já não está no snapshot (ex.: histórico, "Meu dia"): com a conta à mão, vale o `provider` dela.
 */
export function looksLikeCodexId(id: string): boolean {
  return /(?:^|[:/\\])\.?codex(?:[-_.~]|$)/i.test(id);
}

/** Ferramenta da conta: a do snapshot; sem ela, a dica de quem chamou ou o jeito do id. */
export function accountProvider(account: Pick<AccountInfo, 'provider'> | undefined, fallbackId = '', hint?: Provider): Provider {
  if (account) return providerOf(account);
  return hint ?? (looksLikeCodexId(fallbackId) ? 'codex' : looksLikeOpencodeId(fallbackId) ? 'opencode' : 'claude');
}

/**
 * Letra do chip de uma conta que não está no snapshot: a primeira letra depois do prefixo da pasta
 * (".claude-conta2" -> "C", ".codex-trabalho" -> "T"). A pasta padrão do Codex (".codex") vira "X"; a do Claude Code,
 * "?" (como antes). Nunca devolve "." nem vazio.
 */
export function fallbackShort(id: string, provider: Provider = accountProvider(undefined, id)): string {
  const rest = id
    .replace(/^.*:/, '')
    .replace(/~\d+$/, '')
    .replace(/^\.?(?:claude|codex|opencode)(?=[-_.]|$)[-_.]?/i, '');
  const letter = /[\p{L}\p{N}]/u.exec(rest)?.[0];
  if (letter) return letter.toUpperCase();
  if (provider === 'opencode') return 'O';
  return provider === 'codex' ? 'X' : '?';
}

/** O selo "Codex"/"OpenCode" ao lado do nome da conta (não repete quando o nome já diz o nome da ferramenta). */
export function showsProviderTag(provider: Provider, accountName = ''): boolean {
  if (provider === 'opencode') return !/opencode/i.test(accountName);
  return provider === 'codex' && !/codex/i.test(accountName);
}

/** Rótulo do chip da conta (dica e leitores de tela): "Conta C (dev@x.com)", "Codex · plano Team". */
export function accountChipLabel(account: Pick<AccountInfo, 'name' | 'email' | 'plan' | 'provider'> | undefined, fallbackId: string, provider: Provider): string {
  if (!account) return fallbackId ? `${fallbackId}${provider === 'codex' ? ' · Codex' : provider === 'opencode' ? ' · OpenCode' : ''}` : 'Conta desconhecida';
  if (provider === 'opencode') return `${account.name}${showsProviderTag(provider, account.name) ? ` · ${PROVIDER_NAME.opencode}` : ''}`;
  if (provider !== 'codex') return `${account.name}${account.email ? ` (${account.email})` : ''}`;
  const tag = showsProviderTag(provider, account.name) ? ' · Codex' : '';
  return `${account.name}${tag}${account.plan ? ` · plano ${account.plan}` : ''}`;
}

/**
 * Texto do escritório vazio. Os atalhos ("atalhos c ou d") são só das contas do Claude Code, que vêm de aliases do
 * shell (a letra de uma conta do Codex ou do OpenCode não é um atalho); o Codex só entra quando há uma conta dele.
 */
export function emptyOfficeHint(accounts: readonly Pick<AccountInfo, 'short' | 'provider'>[]): string {
  const keys = shortcutHint(accounts.filter((a) => !isCodex(a) && !isOpencode(a)));
  if (!accounts.some(isCodex)) return `Abra o Claude Code em qualquer projeto${keys ? ` (${keys})` : ''} e veja seu agente chegar.`;
  return `Abra o Claude Code${keys ? ` (${keys})` : ''} ou o Codex em qualquer projeto e veja seu agente chegar.`;
}

/**
 * Algum pedido de permissão do Codex (ou do OpenCode, que também tem prazo curto) esperando: o cartão conta os segundos
 * (relógio de 1 s).
 */
export function hasCodexPermission(snap: Pick<OfficeSnapshot, 'agents'> | null): boolean {
  return !!snap?.agents.some((a) => a.permission && (isCodex(a.permission) || isOpencode(a.permission)) && a.status !== 'offline' && a.status !== 'done');
}

/** Como ver o Codex ao vivo e aprovar pelo escritório (gaveta de um agente do Codex e ajuda). */
export const CODEX_LIVE_HINT = 'Para ver o Codex ao vivo e aprovar pelo escritório: `npm run codex:install` e aprove os hooks em `/hooks` no Codex.';

/** Políticas de aprovação do Codex (`approval_policy`), quando o servidor as manda no lugar do modo de permissão. */
const CODEX_APPROVALS: Record<string, string> = {
  untrusted: 'Pergunta antes de quase tudo',
  'on-request': 'Pergunta quando precisa',
  'on-failure': 'Pergunta quando um comando falha',
  never: 'Nunca pergunta',
};

/** Aprovação de um agente do Codex em português (valor desconhecido passa como veio). */
export function codexApprovalLabel(policy: string | undefined): string {
  if (!policy) return '—';
  return CODEX_APPROVALS[policy] ?? policy;
}
