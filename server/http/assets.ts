// Rotas dos assets do usuário (server/assets/):
//   GET  /api/assets                     pacote validado (shared/assets.ts AssetPack) + pasta
//   GET  /api/assets/file/items/<id>/<f>  PNG de um item
//   GET  /api/assets/export?room=|item=|all=1   pacote .habblaud.json para baixar
//   POST /api/assets/import              {bundle}: grava os itens/salas do pacote (sem sobrescrever)
//   POST /api/assets/agent               {account?}: abre (ou reabre) o Arquiteto, um Claude Code na pasta
// Importar e abrir o Arquiteto mexem no computador: só do próprio computador, como o terminal interativo.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { BundleError, exportBundle, importBundle } from '../assets/bundle';
import type { AssetStore } from '../assets/store';
import { PtyError, type PtyManager } from '../pty/manager';
import { HttpError, readJson, sendJson } from './app';
import { ptyRequestProblem } from './pty';

/** Pacotes com imagens passam fácil do limite comum de 256 KB. */
const MAX_IMPORT = 16 * 1024 * 1024;

export function createAssetRoutes(store: AssetStore, ptys: PtyManager | undefined): (req: IncomingMessage, res: ServerResponse, url: URL) => void {
  const notAllowed = (res: ServerResponse, allow: string) => {
    res.setHeader('Allow', allow);
    sendJson(res, 405, { error: 'método não permitido' });
  };
  const fail = (res: ServerResponse, err: unknown) => {
    if (res.headersSent) return void res.destroy();
    if (err instanceof HttpError || err instanceof PtyError) sendJson(res, err.status, { error: err.message });
    else if (err instanceof BundleError) sendJson(res, 400, { error: err.message });
    else sendJson(res, 500, { error: 'erro interno' });
  };
  const localOnly = (req: IncomingMessage) => {
    if (ptyRequestProblem(req)) throw new HttpError(403, 'importar e abrir o Arquiteto só funcionam pelo próprio computador (http://localhost)');
  };

  const handle = async (req: IncomingMessage, res: ServerResponse, url: URL) => {
    const path = url.pathname;
    const method = req.method ?? 'GET';
    const isRead = method === 'GET' || method === 'HEAD';

    if (path === '/api/assets') {
      if (!isRead) return notAllowed(res, 'GET');
      return sendJson(res, 200, { ...store.pack, dir: store.dir, agent: !!ptys });
    }
    if (path.startsWith('/api/assets/file/')) {
      if (!isRead) return notAllowed(res, 'GET');
      let rel: string;
      try {
        rel = decodeURIComponent(path.slice('/api/assets/file/'.length));
      } catch {
        throw new HttpError(400, 'caminho inválido');
      }
      const file = store.filePath(rel);
      if (!file) throw new HttpError(404, 'arquivo não encontrado');
      const data = readFileSync(file);
      res.writeHead(200, {
        'Content-Type': 'image/png',
        'Content-Length': data.length,
        'Cache-Control': url.searchParams.has('v') ? 'public, max-age=31536000, immutable' : 'no-cache',
        'X-Content-Type-Options': 'nosniff',
        'Cross-Origin-Resource-Policy': 'same-origin',
      });
      return void res.end(method === 'HEAD' ? undefined : data);
    }
    if (path === '/api/assets/export') {
      if (!isRead) return notAllowed(res, 'GET');
      const q = url.searchParams;
      const bundle = exportBundle(store.dir, { room: q.get('room') ?? undefined, item: q.get('item') ?? undefined, all: q.get('all') === '1' });
      const data = `${JSON.stringify(bundle, null, 2)}\n`;
      const file = `${bundle.name.replace(/[^a-z0-9_-]/gi, '') || 'assets'}.habblaud.json`;
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(data),
        'Content-Disposition': `attachment; filename="${file}"`,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Cross-Origin-Resource-Policy': 'same-origin',
      });
      return void res.end(data);
    }
    if (path === '/api/assets/import') {
      if (method !== 'POST') return notAllowed(res, 'POST');
      localOnly(req);
      const body = await readJson(req, MAX_IMPORT);
      const result = importBundle(store.dir, body);
      store.reload();
      return sendJson(res, 201, result);
    }
    if (path === '/api/assets/agent') {
      if (method !== 'POST') return notAllowed(res, 'POST');
      localOnly(req);
      if (!ptys) throw new HttpError(403, 'terminal interativo desligado: o Arquiteto precisa dele (veja o log do servidor)');
      const body = (await readJson(req)) as Record<string, unknown>;
      store.ensure();
      // Já tem um Arquiteto rodando: reabre o mesmo em vez de abrir outro.
      const open = ptys.list().find((p) => p.exitedAt === undefined && resolve(p.cwd).toLowerCase() === store.dir.toLowerCase());
      if (open) return sendJson(res, 200, open);
      return sendJson(res, 201, ptys.create({ cwd: store.dir, account: body?.account, cols: body?.cols, rows: body?.rows }));
    }
    throw new HttpError(404, 'rota desconhecida');
  };

  return (req, res, url) => {
    handle(req, res, url).catch((err) => fail(res, err));
  };
}
