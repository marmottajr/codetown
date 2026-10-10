// Uso do plano das contas do Codex (source.ts): o mais novo entre as sessões vai ao AccountsService, com o plano; a
// conta sem sessão aberta o relê dos rollouts recentes ao subir e a cada USAGE_RESCAN_MS. As contas e os detectados são
// da fonte e lidos na hora da chamada (registrar as contas de novo troca a lista); nada aqui lê `auth.json`.
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { AccountUsage } from '../../../shared/types';
import type { DetectedAccount } from '../../accounts/detect';
import { FileTail } from '../tail';
import { codexPlanLabel } from './accounts';
import { parseRolloutName, rolloutDirs } from './files';
import { createCodexState, parseRolloutLine } from './rollout';
import type { CodexAccount, CodexSourceOptions, ThreadTracker } from './source-types';

/** Conta sem sessão aberta (ao subir e na releitura): quantos rollouts recentes tentar até achar um com o uso do plano. */
const SEED_USAGE_FILES = 8;
/**
 * Conta sem sessão aberta: o uso do plano é relido dos rollouts a cada tanto (uma sessão curta, como um `codex exec`,
 * pode ter rodado e sido arquivada entre dois ciclos sem nunca entrar no escritório).
 */
export const USAGE_RESCAN_MS = 60_000;

/** O que o uso do plano lê e muda na fonte do Codex. */
export interface UsageHost {
  readonly opts: Pick<CodexSourceOptions, 'accounts'>;
  readonly threads: Map<string, ThreadTracker>;
  now(): number;
  accs(): CodexAccount[];
  detected(): DetectedAccount[];
  register(): void;
}

export class CodexUsage {
  constructor(private readonly src: UsageHost) {}

  // ---------------------------------------------------------------- uso do plano

  /**
   * Contas sem sessão aberta: relê o uso a cada USAGE_RESCAN_MS com a busca do boot (todas as pastas de data e as
   * arquivadas). O mtime só escolhe os arquivos a abrir; o uso mais novo vence pelo horário da linha (pushUsage).
   */
  rescanUsage(now: number): void {
    for (const acc of this.src.accs()) {
      if (now - acc.usageScanAt < USAGE_RESCAN_MS) continue;
      acc.usageScanAt = now;
      if (!this.hasOpenSession(acc)) this.seedUsage(acc);
    }
  }

  /** A conta tem um agente principal no escritório (o uso dela chega pelas linhas novas da sessão). */
  hasOpenSession(acc: CodexAccount): boolean {
    for (const t of this.src.threads.values()) if (t.acc === acc && t.kind === 'main' && t.inOffice) return true;
    return false;
  }

  /** Uso da conta (e o plano junto): vale o mais recente entre as sessões dela. */
  pushUsage(acc: CodexAccount, usage: AccountUsage, plan: string | undefined): void {
    if (acc.usage && usage.fetchedAt < acc.usage.fetchedAt) return;
    acc.usage = usage;
    this.src.opts.accounts.setUsage(acc.id, usage);
    this.pushPlan(acc, plan);
  }

  /** O plano (rate_limits.plan_type) entra na conta. */
  pushPlan(acc: CodexAccount, plan: string | undefined): void {
    const label = codexPlanLabel(plan);
    if (label && label !== acc.plan) {
      acc.plan = label;
      const i = this.src.accs().indexOf(acc);
      if (i >= 0 && this.src.detected()[i]) {
        this.src.detected()[i] = { ...this.src.detected()[i], plan: label };
        this.src.register();
      }
    }
  }

  /**
   * Conta sem sessão aberta (ao subir e a cada USAGE_RESCAN_MS): o uso mais novo pelo horário da linha entre os
   * rollouts lidos (e só se for mais novo que o atual; fica "desatualizado" com a idade: os números do Codex só se
   * renovam com alguma sessão rodando). O mtime só escolhe os SEED_USAGE_FILES arquivos a abrir, em TODAS as pastas de
   * data (uma sessão retomada continua no arquivo da pasta antiga) e nas arquivadas; todos eles são lidos, porque o
   * último pode não ter `token_count` nenhum (sessão sem resposta, ou arquivada logo) e um arquivo mexido agora pode ter
   * números mais velhos que os de outro.
   */
  seedUsage(acc: CodexAccount): void {
    const files: Array<{ path: string; mtimeMs: number }> = [];
    for (const dir of rolloutDirs(acc.dir)) {
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch {
        continue;
      }
      for (const name of names) {
        const r = parseRolloutName(name);
        if (!r || r.compressed) continue;
        try {
          files.push({ path: join(dir, name), mtimeMs: statSync(join(dir, name)).mtimeMs });
        } catch {
          // sumiu
        }
      }
    }
    files.sort((a, b) => b.mtimeMs - a.mtimeMs);
    let plan: string | undefined;
    // Todos os candidatos são lidos: um arquivo de mtime mais novo pode ter uma linha de uso mais velha que a de outro.
    let best: { usage: AccountUsage; plan?: string } | undefined;
    for (const f of files.slice(0, SEED_USAGE_FILES)) {
      try {
        const tail = new FileTail(f.path);
        tail.seekTail(256 * 1024);
        const state = createCodexState();
        for (let i = 0; i < 4; i++) {
          const r = tail.read();
          for (const line of r.lines) parseRolloutLine(state, line, { idPrefix: '', now: this.src.now(), activities: false });
          if (!r.more) break;
        }
        plan ??= state.planType;
        if (state.usage && (!best || state.usage.fetchedAt > best.usage.fetchedAt)) best = { usage: state.usage, plan: state.planType };
      } catch {
        // ilegível agora: tenta o seguinte
      }
    }
    if (best) return this.pushUsage(acc, best.usage, best.plan ?? plan);
    if (!acc.plan) this.pushPlan(acc, plan);
  }
}
