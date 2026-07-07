/**
 * Request validation shared by every route: UUID ids and the
 * "document must exist" guard, in ONE place.
 */
import type { Request, RequestHandler } from 'express';
import type { DocStore } from './store.js';

export const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const isValidId = (id: string): boolean => ID_RE.test(id);

/**
 * El store resuelto para ESTE request — lo fija un middleware en index.ts
 * (aislado por sesión en el demo, singleton compartido en standalone). Toda
 * ruta accede a los documentos por acá, nunca a un store capturado en closure:
 * así dos visitantes jamás comparten uploads ni ediciones.
 */
export const getStore = (req: Request): DocStore => (req as unknown as { store: DocStore }).store;

/** 404 unless `:id` is a well-formed id AND the document exists in this session. */
export const requireDoc = (): RequestHandler => (req, res, next) => {
  const { id } = req.params;
  if (!id || !ID_RE.test(id) || !getStore(req).exists(id)) {
    res.status(404).json({ error: 'No existe.' });
    return;
  }
  next();
};
