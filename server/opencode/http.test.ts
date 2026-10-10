// Manipulador dos eventos do plugin do OpenCode (handleOpencodeEvent) atrás do guard de verdade: valida o corpo (OC-18),
// só aceita os tipos permitidos, repassa à fonte ao vivo (um falso) e é idempotente (OC-22). A rota no app e a trava
// de loopback (OC-17) são testadas em server/http/opencode-route.test.ts. Dados sintéticos.
import http, { type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { HttpError, sendJson } from '../http/app';
import { createRequestGuard } from '../http/guard';
import { setQuiet } from '../log';
import type { OpencodeEvent, OpencodeLive } from '../sources/opencode/live';
import { request } from '../test/permission-server';
import { OPENCODE_EVENT_TYPES, handleOpencodeEvent, parseOpencodeEvent } from './http';

setQuiet(true);

const SES = 'ses_' + 'a'.repeat(26);
const ev = (type: string, extra: Record<string, unknown> = {}) => ({ event: { type, properties: { sessionID: SES, ...extra } } });

const fail = (res: ServerResponse, err: unknown) => sendJson(res, err instanceof HttpError ? err.status : 500, { error: String(err) });

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

async function serve(live?: OpencodeLive, releaseQuestions?: (sessionId: string) => void): Promise<string> {
  const guard = createRequestGuard({ allowedHosts: new Set(['habblaud.lan']) });
  const server = http.createServer((req, res) => {
    if (guard(req, res)) return;
    handleOpencodeEvent(req, res, { live, releaseQuestions }).catch((err) => fail(res, err));
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  close = () =>
    new Promise((ok) => {
      server.closeAllConnections();
      server.close(() => ok());
    });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe('handleOpencodeEvent', () => {
  it('OC-18: sessionID fora de ^ses_[A-Za-z0-9]{26}$ (ou ausente): 400 e nenhuma mudança de estado', async () => {
    const calls: OpencodeEvent[] = [];
    const base = await serve({ applyHookEvent: (e) => (calls.push(e), true) });
    const bad = ['', 'ses_curto', 'ses_' + 'a'.repeat(27), 'msg_' + 'a'.repeat(26), 'ses_' + 'a'.repeat(25) + '/', '../etc/passwd', 'ses_' + 'a'.repeat(26) + '\n', 42, null];
    for (const sessionID of bad) {
      const r = await request(base, '/x', { method: 'POST', body: { event: { type: 'session.idle', properties: { sessionID } } } });
      expect(r.status, JSON.stringify(sessionID)).toBe(400);
    }
    expect((await request(base, '/x', { method: 'POST', body: { event: { type: 'session.idle', properties: {} } } })).status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('OC-18: corpo que não é um evento: 400 (e JSON inválido também)', async () => {
    const calls: OpencodeEvent[] = [];
    const base = await serve({ applyHookEvent: (e) => (calls.push(e), true) });
    for (const body of [{}, [], { event: 'x' }, { event: {} }, { event: { type: 'session.idle' } }, { event: { type: 'session.idle', properties: [] } }, { type: 'session.idle' }]) {
      expect((await request(base, '/x', { method: 'POST', body })).status, JSON.stringify(body)).toBe(400);
    }
    expect((await request(base, '/x', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{nao json' })).status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('só os 7 tipos originais passam, mais os 3 de pergunta (OQ-02); qualquer outro: 400', async () => {
    const calls: OpencodeEvent[] = [];
    const base = await serve({ applyHookEvent: (e) => (calls.push(e), true) });
    // SPEC_DEVIATION: a lista ganhou os 3 tipos de pergunta (OQ-02); o teste só soma esses 3 à lista de antes.
    const allowed = ['session.status', 'session.idle', 'todo.updated', 'permission.asked', 'permission.updated', 'tool.execute.before', 'tool.execute.after', 'question.asked', 'question.replied', 'question.rejected'];
    expect([...OPENCODE_EVENT_TYPES].sort()).toEqual([...allowed].sort());
    for (const type of allowed) expect(await request(base, '/x', { method: 'POST', body: ev(type) }), type).toMatchObject({ status: 200, json: { ok: true } });
    expect(calls.map((c) => c.type)).toEqual(allowed);
    for (const type of ['session.created', 'message.updated', 'file.edited', 'SESSION.IDLE', '']) {
      expect((await request(base, '/x', { method: 'POST', body: ev(type) })).status, type).toBe(400);
    }
    expect(calls).toHaveLength(allowed.length);
  });

  it('OQ-02: question.asked/replied/rejected devolvem {ok}, com requestID e sem id; sessionID inválido ou tipo parecido: 400', async () => {
    const calls: OpencodeEvent[] = [];
    const base = await serve({ applyHookEvent: (e) => (calls.push(e), true) });
    const asked = ev('question.asked', { id: 'que_1', questions: [{ question: 'Q?', header: 'H', options: [{ label: 'a', description: 'b' }] }] });
    expect(await request(base, '/x', { method: 'POST', body: asked })).toMatchObject({ status: 200, json: { ok: true } });
    expect(await request(base, '/x', { method: 'POST', body: ev('question.replied', { requestID: 'que_1', answers: [['a']] }) })).toMatchObject({ status: 200, json: { ok: true } });
    expect(await request(base, '/x', { method: 'POST', body: ev('question.rejected', { requestID: 'que_1' }) })).toMatchObject({ status: 200, json: { ok: true } });
    expect(calls.map((c) => c.type)).toEqual(['question.asked', 'question.replied', 'question.rejected']);
    expect(calls[1].properties).toMatchObject({ requestID: 'que_1', answers: [['a']] });
    expect((await request(base, '/x', { method: 'POST', body: { event: { type: 'question.replied', properties: { sessionID: 'ruim', requestID: 'x' } } } })).status).toBe(400);
    expect((await request(base, '/x', { method: 'POST', body: ev('question.answered') })).status).toBe(400);
    expect(calls).toHaveLength(3);
  });

  it('OC-22: o mesmo evento duas vezes chega igual duas vezes à fonte (que é idempotente) e a resposta é a mesma', async () => {
    const calls: OpencodeEvent[] = [];
    const base = await serve({ applyHookEvent: (e) => (calls.push(e), true) });
    const body = ev('session.status', { status: { type: 'busy' } });
    const a = await request(base, '/x', { method: 'POST', body });
    const b = await request(base, '/x', { method: 'POST', body });
    expect(a).toEqual(b);
    expect(calls).toEqual([body.event, body.event]);
  });

  it('sem a fonte, ou se ela falha: 200 {ok: false}; sem JSON: 415', async () => {
    let base = await serve();
    expect(await request(base, '/x', { method: 'POST', body: ev('session.idle') })).toMatchObject({ status: 200, json: { ok: false } });
    await close!();
    base = await serve({
      applyHookEvent: () => {
        throw new Error('quebrou');
      },
    });
    expect(await request(base, '/x', { method: 'POST', body: ev('session.idle') })).toMatchObject({ status: 200, json: { ok: false } });
    expect((await request(base, '/x', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' })).status).toBe(415);
  });

  it('peça pura parseOpencodeEvent', () => {
    expect(parseOpencodeEvent(ev('todo.updated', { todos: [] }))).toEqual({ type: 'todo.updated', properties: { sessionID: SES, todos: [] } });
    expect(() => parseOpencodeEvent({ event: { type: 'session.idle', properties: { sessionID: 'x' } } })).toThrow(HttpError);
  });
});
