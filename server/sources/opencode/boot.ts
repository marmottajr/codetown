// Quando a fonte do OpenCode entra no servidor (server/index.ts): HABBLAUD_OPENCODE ligado (OC-10). Sem opencode.db
// a fonte fica dormente e confere o arquivo de tempos em tempos (OC-08: nada é registrado nem logado até ele existir). A checagem de `node:sqlite` fica na
// própria fonte (OC-07: uma linha no log, o resto segue).
import { OpencodeSource, type OpencodeSourceOptions } from './source';

export function createOpencodeSource(
  config: { opencode: boolean; opencodeDir: string; inDocker?: boolean },
  deps: Pick<OpencodeSourceOptions, 'accounts' | 'office'> & Partial<Pick<OpencodeSourceOptions, 'now' | 'pollMs' | 'watch' | 'importer' | 'waitMs'>>,
): OpencodeSource | undefined {
  if (!config.opencode) return undefined;
  return new OpencodeSource({ ...deps, dir: config.opencodeDir });
}
