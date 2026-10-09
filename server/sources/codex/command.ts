// O comando de verdade dentro do invólucro do shell. O Codex grava a lista que mandou ao sistema:
// `["/bin/zsh","-lc","npm test"]` no macOS/Linux; `["pwsh.exe","-Command","git status"]`,
// `["powershell.exe","-NoProfile","-Command",…]` ou `["cmd.exe","/d","/s","/c","dir"]` no Windows (o code mode do
// Desktop roda tudo assim). Hooks e o próprio modelo também mandam o texto inteiro (`pwsh -NoProfile -Command "…"`).
// Puro e total: entrada estranha dá texto vazio, nunca exceção. Serve ao parser (rollout.ts) e ao terminal.

/** Shell que embrulhava o comando (null = não havia invólucro). */
export type WrapperShell = 'sh' | 'pwsh' | 'cmd';
export interface ShellCommand {
  /** O comando de verdade, sem o invólucro (`npm test`, `git push origin main`). */
  text: string;
  shell: WrapperShell | null;
}

/** Invólucro dentro de invólucro (`pwsh -Command "cmd /c dir"`): desembrulha até este nível. */
const MAX_DEPTH = 4;
/** Palavras lidas do começo de um texto atrás do shell e das opções (o comando em si não precisa ser dividido). */
const MAX_HEAD_WORDS = 24;
const POSIX_SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish']);
/** Opções do pwsh/powershell que levam um valor; as outras `-X` antes do -Command são chaves sem valor. */
const PWSH_VALUED = ['executionpolicy', 'windowstyle', 'workingdirectory', 'inputformat', 'outputformat', 'configurationname', 'settingsfile'];
const PWSH_VALUED_ALIASES = new Set(['ep', 'ex', 'w', 'wd', 'if', 'of', 'o']);

/** Nome do programa: sem a pasta (`/` ou `\`), em minúsculas e sem `.exe`. */
function programOf(word: string): string {
  const base = word.slice(Math.max(word.lastIndexOf('/'), word.lastIndexOf('\\')) + 1).toLowerCase();
  return base.endsWith('.exe') ? base.slice(0, -4) : base;
}

function shellOf(word: string): WrapperShell | undefined {
  const prog = programOf(word);
  if (POSIX_SHELLS.has(prog)) return 'sh';
  if (prog === 'pwsh' || prog === 'powershell') return 'pwsh';
  if (prog === 'cmd') return 'cmd';
  return undefined;
}

/**
 * Índice da 1ª palavra do comando (logo depois de `-c`/`-lc`, `-Command`/`-c` ou `/c`/`/k`), ou -1 se não for
 * invólucro (`bash build.sh`, `pwsh -File x.ps1`, `pwsh -EncodedCommand …`).
 */
function commandStart(shell: WrapperShell, words: string[]): number {
  for (let i = 1; i < words.length; i++) {
    const w = words[i];
    const lower = w.toLowerCase();
    if (shell === 'sh') {
      if (/^-[a-z]*c[a-z]*$/i.test(w) || lower === '--command') return i + 1;
      if (w === '-o' || w === '+o') i++;
      else if (!/^[-+]/.test(w)) return -1;
      continue;
    }
    if (shell === 'pwsh') {
      if (!/^(?:--?|\/)/.test(w)) return -1;
      const name = lower.replace(/^(?:--?|\/)/, '');
      if (name === 'c' || (name.length >= 3 && 'command'.startsWith(name))) return i + 1;
      if (PWSH_VALUED_ALIASES.has(name) || (name.length >= 3 && PWSH_VALUED.some((o) => o.startsWith(name)))) i++;
      continue;
    }
    // cmd: /d /s /q /e:on /v:off... até o /c (ou /k).
    if (lower === '/c' || lower === '/k') return i + 1;
    if (!w.startsWith('/')) return -1;
  }
  return -1;
}

/** Aspas externas da linha do cmd: com /s, a 1ª e a última saem sempre; sem, só um par que envolva tudo sem outra aspa dentro. */
function dequoteCmd(text: string, slashS: boolean): string {
  if (text.length < 2 || !text.startsWith('"') || !text.endsWith('"')) return text;
  const inner = text.slice(1, -1);
  return slashS || !inner.includes('"') ? inner.trim() : text;
}

/** Palavras juntadas com espaço (as que têm espaço ou símbolo vão entre aspas simples), como o terminal mostra. */
function joinWords(words: string[]): string {
  return words
    .map((w) => (/^[\w@%+=:,./-]+$/.test(w) ? w : `'${w.replace(/'/g, `'\\''`)}'`))
    .join(' ')
    .trim();
}

function fromWords(words: string[]): ShellCommand {
  const shell = words.length ? shellOf(words[0]) : undefined;
  const at = shell ? commandStart(shell, words) : -1;
  if (shell && at > 0 && at < words.length) {
    // sh -c: só a string depois da flag (o que vem depois são $0, $1...); pwsh e cmd juntam o resto com espaços.
    const joined = (shell === 'sh' ? words[at] : words.slice(at).join(' ')).trim();
    // Na lista, as aspas externas da linha do cmd quem põe é o Rust: só sai um par que já envolva tudo.
    const text = shell === 'cmd' ? dequoteCmd(joined, false) : joined;
    if (text) return { text, shell };
  }
  return { text: joinWords(words), shell: null };
}

/** Uma palavra de um texto: o valor (sem as aspas) e onde ela começa e termina. */
interface Word {
  value: string;
  start: number;
  end: number;
  quoted: boolean;
}

/**
 * Lê a palavra que começa em `i` (pulando espaços). Aspas "…" (com \") e '…' juntam espaços; fora das aspas a barra
 * invertida é literal (`C:\x\pwsh.exe` fica inteiro). Aspa sem fechar vai até o fim.
 */
function readWord(s: string, i: number): Word | undefined {
  while (i < s.length && /\s/.test(s[i])) i++;
  if (i >= s.length) return undefined;
  const start = i;
  let value = '';
  let quoted = false;
  while (i < s.length && !/\s/.test(s[i])) {
    const q = s[i];
    if (q !== '"' && q !== "'") {
      value += s[i++];
      continue;
    }
    quoted = true;
    i++;
    while (i < s.length && s[i] !== q) {
      if (q === '"' && s[i] === '\\' && s[i + 1] === '"') i++;
      value += s[i++];
    }
    i++; // a aspa de fechar
  }
  return { value, start, end: Math.min(i, s.length), quoted };
}

function fromText(raw: string): ShellCommand {
  const text = raw.trim();
  const words: Word[] = [];
  for (let w = readWord(text, 0); w && words.length < MAX_HEAD_WORDS; w = readWord(text, w.end)) words.push(w);
  const shell = words.length ? shellOf(words[0].value) : undefined;
  const at = shell ? commandStart(shell, words.map((w) => w.value)) : -1;
  if (!shell || at <= 0 || at >= words.length) return { text, shell: null };
  // O resto cru (as aspas internas ficam); uma palavra entre aspas que vai até o fim perde as aspas externas.
  const rest = text.slice(words[at].start).trim();
  let cmd = words[at].quoted && words[at].end >= text.length ? words[at].value : rest;
  if (shell === 'cmd') cmd = dequoteCmd(rest, words.slice(1, at).some((w) => w.value.toLowerCase() === '/s'));
  cmd = cmd.trim();
  return cmd ? { text: cmd, shell } : { text, shell: null };
}

function unwrapOnce(cmd: unknown): ShellCommand {
  if (typeof cmd === 'string') return fromText(cmd);
  if (!Array.isArray(cmd)) return { text: '', shell: null };
  return fromWords(cmd.filter((w): w is string => typeof w === 'string'));
}

/**
 * Aceita a lista do CommandExecution/exec (`["/bin/zsh","-lc","npm test"]`, `["pwsh.exe","-NoProfile","-Command","git status"]`,
 * `["cmd.exe","/d","/s","/c","dir"]`) ou um texto (que pode ser `pwsh -Command "..."`). Nunca lança.
 */
export function unwrapCommand(cmd: unknown): ShellCommand {
  try {
    let out = unwrapOnce(cmd);
    for (let depth = 1; depth < MAX_DEPTH && out.shell; depth++) {
      const inner = fromText(out.text);
      if (!inner.shell) break;
      out = inner;
    }
    return out;
  } catch {
    return { text: '', shell: null };
  }
}
