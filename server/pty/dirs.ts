// Navegador de pastas do "Abrir projeto" (GET /api/pty/dirs): lista só as subpastas de uma pasta do computador,
// para escolher onde abrir uma sessão nova do Claude Code. Nada de arquivos nem de conteúdo. Mesma trava do
// terminal interativo (só o próprio computador; ver http/pty.ts), que já executa comandos nessa máquina.
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, resolve } from 'node:path';

export interface DirListing {
  path: string;
  /** Pasta de cima (ausente na raiz). */
  parent?: string;
  dirs: string[];
  /** Pastas grandes demais são cortadas. */
  truncated?: boolean;
  home: string;
  /** Raízes: discos no Windows, "/" nos outros. */
  roots: string[];
}

const MAX_DIRS = 1000;
/** Pastas que quase nunca são projeto e só poluem a lista. */
const SKIP = new Set(['node_modules', '$recycle.bin', 'system volume information']);

export class DirError extends Error {}

export function listDirs(raw: unknown, platform: NodeJS.Platform = process.platform): DirListing {
  const home = homedir();
  const path = typeof raw === 'string' && raw.trim() ? resolve(raw.trim()) : home;
  if (!isAbsolute(path)) throw new DirError('informe um caminho absoluto');
  let names: string[];
  try {
    if (!statSync(path).isDirectory()) throw new DirError(`não é uma pasta: ${path}`);
    names = readdirSync(path, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.') && !SKIP.has(d.name.toLowerCase()))
      .map((d) => d.name);
  } catch (err) {
    if (err instanceof DirError) throw err;
    throw new DirError(`não consegui abrir a pasta: ${path}`);
  }
  names.sort((a, b) => a.localeCompare(b, 'pt-BR', { sensitivity: 'base' }));
  const parent = dirname(path);
  const out: DirListing = { path, dirs: names.slice(0, MAX_DIRS), home, roots: roots(platform) };
  if (parent !== path) out.parent = parent;
  if (names.length > MAX_DIRS) out.truncated = true;
  return out;
}

function roots(platform: NodeJS.Platform): string[] {
  if (platform !== 'win32') return ['/'];
  const out: string[] = [];
  for (let c = 67; c <= 90; c++) {
    const drive = `${String.fromCharCode(c)}:\\`;
    if (existsSync(drive)) out.push(drive);
  }
  return out;
}

