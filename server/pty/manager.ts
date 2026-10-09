// Terminal interativo: o Habblaud abre o Claude Code num pseudo-terminal (node-pty) e o navegador mostra e
// controla esse terminal (xterm.js). Saída via SSE em GET /api/pty/:id/stream; entrada, redimensionamento e
// encerramento via POST (rotas em http/pty.ts).
//
// Três usos: sessão nova numa pasta; "assumir" uma sessão aberta noutro terminal (o processo de lá é
// encerrado e a mesma conversa continua aqui com `claude --resume`); e encerrar um agente, esteja ele aqui
// ou noutro terminal (só processos que o registro de sessões do Claude Code confirma como sessão).
//
// Segurança: quem controla um terminal destes executa comandos na máquina. As rotas só aceitam conexões do
// próprio computador (ver http/pty.ts), o recurso fica desligado no Docker e com HABBLAUD_PTY=0.
import { readFileSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isAbsolute, join, resolve } from 'node:path';
import type { PtyInfo, PtyStatus } from '../../shared/types';
import { frame } from '../http/sse';
import { errMsg, log } from '../log';
import { pidAlive } from '../sources/registry';
import { killWithConsoleReset } from './winkill';

/** O que o gerenciador usa do node-pty (permite trocar nos testes). */
export interface PtyProcess {
  readonly pid: number;
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: { exitCode: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

export type SpawnPty = (file: string, args: string[], opts: { cwd: string; cols: number; rows: number; env: NodeJS.ProcessEnv }) => PtyProcess;

export interface PtyAccount {
  id: string;
  /** Pasta de configuração da conta (vira CLAUDE_CONFIG_DIR, exceto a padrão). */
  dir: string;
  isDefault: boolean;
}

/** O que o gerenciador precisa saber de um agente principal para encerrá-lo ou assumi-lo. */
export interface PtyAgentRef {
  id: string;
  kind: 'main' | 'sub';
  account: string;
  sessionId: string;
  cwd?: string;
}

export interface PtyManagerOptions {
  spawn: SpawnPty | null;
  /** Por que o recurso está desligado (quando `spawn` é null). */
  disabledReason?: string;
  claudeBin: string;
  accounts: () => PtyAccount[];
  agent: (id: string) => PtyAgentRef | undefined;
  onChange: () => void;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  /**
   * Encerra um processo de fora (testes). Padrão: no Windows, encerra e limpa os modos do terminal dele
   * (pty/winkill.ts); nos outros, SIGTERM (o Claude Code sai normalmente e limpa sozinho).
   */
  killPid?: (pid: number) => void | Promise<void>;
  isAlive?: (pid: number) => boolean;
  sleep?: (ms: number) => Promise<void>;
}

/** Saída guardada por terminal, para quem conecta depois (ou reconecta) ver a tela atual. */
const MAX_SCROLLBACK = 512 * 1024;
/** Terminais encerrados continuam na lista por um tempo, para a tela final ainda poder ser vista. */
const EXITED_KEEP_MS = 10 * 60_000;
const MAX_PTYS = 12;
/** Quanto esperar o processo de fora sair antes de retomar a sessão aqui. */
const TAKEOVER_WAIT_MS = 5_000;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Id de agente principal: "<conta>:<pid>". */
const MAIN_ID = /^(.+):(\d+)$/;

/**
 * Variáveis que o Claude Code põe no ambiente das próprias ferramentas. Se o Habblaud foi iniciado de dentro
 * de uma sessão, o Claude aberto aqui se acharia uma sessão-filha (e desligaria o transcript).
 */
const INHERITED_SESSION_VARS = [
  'CLAUDECODE',
  'AI_AGENT',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_SSE_PORT',
];

interface Pty {
  info: PtyInfo;
  proc: PtyProcess;
  buffer: string;
  clients: Set<ServerResponse>;
}

export class PtyError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export class PtyManager {
  private ptys = new Map<string, Pty>();
  private seq = 0;
  private readonly now: () => number;
  private readonly killPid: (pid: number) => void | Promise<void>;
  private readonly isAlive: (pid: number) => boolean;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly opts: PtyManagerOptions) {
    this.now = opts.now ?? Date.now;
    this.killPid = opts.killPid ?? (process.platform === 'win32' ? (pid) => killWithConsoleReset(pid) : (pid) => void process.kill(pid, 'SIGTERM'));
    this.isAlive = opts.isAlive ?? pidAlive;
    this.sleep = opts.sleep ?? ((ms) => new Promise((ok) => setTimeout(ok, ms)));
  }

  status(): PtyStatus {
    return this.opts.spawn ? { enabled: true } : { enabled: false, reason: this.opts.disabledReason ?? 'indisponível' };
  }

  list(): PtyInfo[] {
    const now = this.now();
    for (const [id, t] of this.ptys) {
      if (t.info.exitedAt !== undefined && now - t.info.exitedAt > EXITED_KEEP_MS) this.drop(id);
    }
    return [...this.ptys.values()].map((t) => ({ ...t.info }));
  }

  /** Abre uma sessão nova do Claude Code na pasta (`cwd` absoluto), na conta pedida (ou na padrão). */
  create(p: { cwd: unknown; account?: unknown; cols?: unknown; rows?: unknown }): PtyInfo {
    return this.spawn({ cwd: p.cwd, account: p.account, cols: p.cols, rows: p.rows });
  }

  /**
   * Encerra um agente principal. Aberto aqui: fecha o pty. Aberto noutro terminal: encerra o processo, mas só
   * se o registro de sessões da conta confirmar que aquele PID é aquela sessão do Claude Code.
   */
  async stop(agentId: string): Promise<void> {
    const own = this.byAgent(agentId);
    if (own) {
      this.kill(own);
      return;
    }
    const pid = this.externalPid(agentId);
    try {
      await this.killPid(pid);
    } catch (err) {
      throw new PtyError(500, `não consegui encerrar a sessão: ${errMsg(err)}`);
    }
    log.info(`Agente ${agentId} encerrado pelo escritório.`);
  }

  /**
   * Assume uma sessão aberta noutro terminal: encerra o processo de lá, espera ele sair e continua a mesma
   * conversa aqui (`claude --resume <sessão>`, na pasta e na conta originais).
   */
  async takeover(agentId: string, size: { cols?: unknown; rows?: unknown } = {}): Promise<PtyInfo> {
    if (!this.opts.spawn) throw new PtyError(503, `terminal desligado: ${this.opts.disabledReason ?? 'indisponível'}`);
    const own = this.byAgent(agentId);
    if (own) return { ...own.info };
    const agent = this.mainAgent(agentId);
    if (!SESSION_ID.test(agent.sessionId)) throw new PtyError(409, 'sessão sem id válido para retomar');
    if (!agent.cwd) throw new PtyError(409, 'não sei a pasta desta sessão');
    const pid = this.externalPid(agentId);
    try {
      await this.killPid(pid);
    } catch (err) {
      throw new PtyError(500, `não consegui encerrar a sessão no outro terminal: ${errMsg(err)}`);
    }
    for (let waited = 0; this.isAlive(pid) && waited < TAKEOVER_WAIT_MS; waited += 100) await this.sleep(100);
    if (this.isAlive(pid)) throw new PtyError(409, 'a sessão no outro terminal não encerrou a tempo');
    log.info(`Agente ${agentId} assumido pelo escritório (sessão ${agent.sessionId}).`);
    return this.spawn({ cwd: agent.cwd, account: agent.account, cols: size.cols, rows: size.rows, resume: agent.sessionId, from: agentId });
  }

  /** Conecta um cliente SSE: a tela guardada primeiro, depois a saída ao vivo. */
  attach(id: string, req: IncomingMessage, res: ServerResponse): void {
    const pty = this.get(id);
    req.socket.setTimeout(0);
    req.socket.setNoDelay(true);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 2000\n\n');
    res.write(frame('reset', pty.buffer));
    if (pty.info.exitedAt !== undefined) res.write(frame('exit', { code: pty.info.exitCode ?? 0 }));
    pty.clients.add(res);
    const drop = () => pty.clients.delete(res);
    req.on('close', drop);
    res.on('close', drop);
    res.on('error', drop);
  }

  input(id: string, data: unknown): void {
    if (typeof data !== 'string' || data.length > 64 * 1024) throw new PtyError(400, 'entrada inválida');
    this.running(id).proc.write(data);
  }

  resize(id: string, cols: unknown, rows: unknown): void {
    this.running(id).proc.resize(clampInt(cols, 20, 400, 100), clampInt(rows, 5, 200, 30));
  }

  /** Encerra o processo (ainda rodando) ou tira da lista (já encerrado). */
  close(id: string): void {
    const pty = this.get(id);
    if (pty.info.exitedAt === undefined) this.kill(pty);
    else {
      this.drop(id);
      this.opts.onChange();
    }
  }

  stopAll(): void {
    for (const t of this.ptys.values()) {
      for (const c of t.clients) c.end();
      if (t.info.exitedAt === undefined) {
        try {
          t.proc.kill();
        } catch {
          // encerrando o servidor: nada a fazer
        }
      }
    }
    this.ptys.clear();
  }

  private spawn(p: { cwd: unknown; account?: unknown; cols?: unknown; rows?: unknown; resume?: string; from?: string }): PtyInfo {
    const spawn = this.opts.spawn;
    if (!spawn) throw new PtyError(503, `terminal desligado: ${this.opts.disabledReason ?? 'indisponível'}`);
    if (typeof p.cwd !== 'string' || !isAbsolute(p.cwd)) throw new PtyError(400, 'informe a pasta do projeto (caminho absoluto)');
    const cwd = resolve(p.cwd);
    let isDir = false;
    try {
      isDir = statSync(cwd).isDirectory();
    } catch {
      // tratado abaixo
    }
    if (!isDir) throw new PtyError(400, `pasta não encontrada: ${cwd}`);
    const accounts = this.opts.accounts();
    const account = typeof p.account === 'string' ? accounts.find((a) => a.id === p.account) : (accounts.find((a) => a.isDefault) ?? accounts[0]);
    if (!account) throw new PtyError(400, 'conta desconhecida');
    const running = [...this.ptys.values()].filter((t) => t.info.exitedAt === undefined).length;
    if (running >= MAX_PTYS) throw new PtyError(429, `limite de ${MAX_PTYS} terminais abertos`);

    const env: NodeJS.ProcessEnv = { ...(this.opts.env ?? process.env), TERM: 'xterm-256color', COLORTERM: 'truecolor' };
    for (const k of INHERITED_SESSION_VARS) delete env[k];
    if (account.isDefault) delete env.CLAUDE_CONFIG_DIR;
    else env.CLAUDE_CONFIG_DIR = account.dir;

    let proc: PtyProcess;
    try {
      const args = p.resume ? ['--resume', p.resume] : [];
      proc = spawn(this.opts.claudeBin, args, { cwd, cols: clampInt(p.cols, 20, 400, 100), rows: clampInt(p.rows, 5, 200, 30), env });
    } catch (err) {
      throw new PtyError(500, `não consegui abrir o Claude Code: ${errMsg(err)}`);
    }
    const id = `p${++this.seq}-${proc.pid}`;
    const info: PtyInfo = { id, pid: proc.pid, cwd, account: account.id, agentId: `${account.id}:${proc.pid}`, startedAt: this.now() };
    if (p.resume) info.resumed = p.resume;
    if (p.from) info.fromAgent = p.from;
    const pty: Pty = { info, proc, buffer: '', clients: new Set() };
    this.ptys.set(id, pty);
    proc.onData((data) => {
      pty.buffer += data;
      if (pty.buffer.length > MAX_SCROLLBACK) pty.buffer = pty.buffer.slice(-MAX_SCROLLBACK);
      this.broadcast(pty, 'data', data);
    });
    proc.onExit(({ exitCode }) => {
      pty.info.exitedAt = this.now();
      pty.info.exitCode = exitCode;
      this.broadcast(pty, 'exit', { code: exitCode });
      this.opts.onChange();
    });
    log.info(`Terminal ${id} aberto em ${cwd} (conta ${account.id}${p.resume ? `, retomando ${p.resume}` : ''}).`);
    this.opts.onChange();
    return { ...info };
  }

  private byAgent(agentId: string): Pty | undefined {
    for (const t of this.ptys.values()) if (t.info.agentId === agentId && t.info.exitedAt === undefined) return t;
    return undefined;
  }

  private mainAgent(agentId: string): PtyAgentRef {
    const agent = this.opts.agent(agentId);
    if (!agent) throw new PtyError(404, 'agente não encontrado');
    if (agent.kind !== 'main') throw new PtyError(400, 'só dá para encerrar ou assumir o agente principal de uma sessão');
    return agent;
  }

  /** PID de um agente principal aberto fora do Habblaud, confirmado pelo registro de sessões da conta. */
  private externalPid(agentId: string): number {
    const agent = this.mainAgent(agentId);
    const m = MAIN_ID.exec(agent.id);
    const pid = m ? Number(m[2]) : NaN;
    if (!m || m[1] !== agent.account || !Number.isSafeInteger(pid) || pid <= 0) throw new PtyError(400, 'agente sem processo conhecido');
    const account = this.opts.accounts().find((a) => a.id === agent.account);
    if (!account) throw new PtyError(400, 'conta desconhecida');
    let registered: unknown;
    try {
      registered = JSON.parse(readFileSync(join(account.dir, 'sessions', `${pid}.json`), 'utf8'));
    } catch {
      throw new PtyError(409, 'a sessão não está mais aberta');
    }
    const sid = (registered as { sessionId?: unknown } | null)?.sessionId;
    if (sid !== agent.sessionId) throw new PtyError(409, 'o processo não é mais desta sessão');
    if (!this.isAlive(pid)) throw new PtyError(409, 'a sessão não está mais aberta');
    return pid;
  }

  private kill(pty: Pty): void {
    try {
      pty.proc.kill();
    } catch (err) {
      log.warn(`Falha ao encerrar o terminal ${pty.info.id}: ${errMsg(err)}`);
    }
  }

  private get(id: string): Pty {
    const pty = this.ptys.get(id);
    if (!pty) throw new PtyError(404, 'terminal não encontrado');
    return pty;
  }

  private running(id: string): Pty {
    const pty = this.get(id);
    if (pty.info.exitedAt !== undefined) throw new PtyError(409, 'o terminal já foi encerrado');
    return pty;
  }

  private drop(id: string): void {
    const t = this.ptys.get(id);
    if (!t) return;
    for (const c of t.clients) c.end();
    this.ptys.delete(id);
  }

  private broadcast(pty: Pty, event: string, data: unknown): void {
    const f = frame(event, data);
    for (const c of pty.clients) c.write(f);
  }
}

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : fallback;
  return Math.min(max, Math.max(min, n));
}

/** Carrega o node-pty (dependência opcional). Devolve null + motivo se não der. */
export async function loadPty(): Promise<{ spawn: SpawnPty | null; reason?: string }> {
  try {
    const mod = (await import('node-pty')) as unknown as {
      spawn?: (file: string, args: string[], o: Record<string, unknown>) => PtyProcess;
      default?: { spawn: (file: string, args: string[], o: Record<string, unknown>) => PtyProcess };
    };
    const ptySpawn = mod.spawn ?? mod.default?.spawn;
    if (!ptySpawn) return { spawn: null, reason: 'node-pty sem spawn()' };
    return {
      spawn: (file, args, o) => ptySpawn(file, args, { name: 'xterm-256color', cwd: o.cwd, cols: o.cols, rows: o.rows, env: o.env }),
    };
  } catch (err) {
    return { spawn: null, reason: `node-pty não instalado (${errMsg(err)})` };
  }
}

/** Procura um executável no PATH (no Windows, também com as extensões de PATHEXT). */
export function findExecutable(name: string, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string | undefined {
  const sep = platform === 'win32' ? ';' : ':';
  const exts = platform === 'win32' ? ['.exe', ...(env.PATHEXT ?? '.COM;.CMD;.BAT').split(';').filter(Boolean).map((e) => e.toLowerCase())] : [''];
  const dirs = (env.PATH ?? env.Path ?? '').split(sep).filter(Boolean);
  for (const dir of dirs) {
    for (const ext of exts) {
      const file = resolve(dir, name + ext);
      try {
        if (statSync(file).isFile()) return file;
      } catch {
        // próximo
      }
    }
  }
  return undefined;
}
