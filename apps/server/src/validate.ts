/**
 * Request validation shared by every route: UUID ids and the
 * "document must exist" guard, in ONE place.
 *
 * v2 (audit-hosts §3.3): `requireDoc` ya no responde inline — TIRA
 * `documentNotFound()` y el error middleware (el único catch site) lo traduce
 * a 404 `{ code, error: 'No existe.' }`.
 */
import type { Request, RequestHandler } from 'express';
import { documentNotFound } from './errors.js';
import type { DocStore } from './store.js';

export const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const isValidId = (id: string): boolean => ID_RE.test(id);

/**
 * El store resuelto para ESTE request — lo fija el middleware de
 * `sessionScope.ts` (aislado por sesión en el demo, el binding IDocStore del
 * container en standalone). Toda ruta accede a los documentos por acá, nunca a
 * un store capturado en closure: así dos visitantes jamás comparten uploads ni
 * ediciones.
 */
export const getStore = (req: Request): DocStore => (req as unknown as { store: DocStore }).store;

/** 404 unless `:id` is a well-formed id AND the document exists in this session. */
export const requireDoc = (): RequestHandler => (req, _res, next) => {
  const { id } = req.params;
  if (!id || !ID_RE.test(id) || !getStore(req).exists(id)) throw documentNotFound();
  next();
};
