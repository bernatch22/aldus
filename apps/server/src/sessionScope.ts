/**
 * sessionScope.ts — el middleware que resuelve el store de CADA request
 * (audit-hosts §2: en v1 eran 25 líneas de parseo de cookie a mano dentro de
 * index.ts). Dos modos:
 *
 *  - standalone (default): el binding {@link IDocStore} del container — un
 *    único store compartido (el editor local de siempre).
 *  - demo público (ALDUS_SESSION_SCOPED → se pasa un {@link SessionStores}):
 *    cada visitante (cookie `aldus_sid`) recibe SU FileDocStore aislado;
 *    uploads y ediciones nunca se cruzan.
 */
import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';
import type { DocStore, SessionStores } from './store.js';

const SID_RE = /^[0-9a-f-]{36}$/;

export function sessionScope(base: DocStore, sessions: SessionStores | null): RequestHandler {
  return (req, res, next) => {
    if (!sessions) {
      (req as unknown as { store: DocStore }).store = base;
      return next();
    }
    const raw = (req.headers.cookie || '')
      .split(';')
      .map(c => c.trim())
      .find(c => c.startsWith('aldus_sid='));
    let sid = raw ? decodeURIComponent(raw.slice('aldus_sid='.length)) : '';
    if (!SID_RE.test(sid)) {
      sid = randomUUID();
      res.setHeader('Set-Cookie', `aldus_sid=${sid}; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax`);
    }
    (req as unknown as { store: DocStore }).store = sessions.for(sid);
    next();
  };
}
