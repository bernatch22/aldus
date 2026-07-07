/**
 * Request validation shared by every route: UUID ids and the
 * "document must exist" guard, in ONE place.
 */
import type { RequestHandler } from 'express';
import type { DocStore } from './store.js';

export const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const isValidId = (id: string): boolean => ID_RE.test(id);

/** 404 unless `:id` is a well-formed id AND the document exists. */
export const requireDoc = (store: DocStore): RequestHandler => (req, res, next) => {
  const { id } = req.params;
  if (!id || !ID_RE.test(id) || !store.exists(id)) {
    res.status(404).json({ error: 'No existe.' });
    return;
  }
  next();
};
