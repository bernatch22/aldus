/**
 * errors.ts — EL catch site del server (audit-hosts §3.3). Las rutas NO tienen
 * try/catch: parse → guard → hacer → responder; cualquier throw viaja (vía el
 * wrapper {@link h} para async) al {@link errorMiddleware}, que es el ÚNICO
 * lugar que traduce errores a HTTP:
 *
 *  - {@link ProtocolError} (StructuredError de core) → status mapeado por code
 *    + `{ code, error: format }`. Los STRINGS son los de v1 byte-idéntico
 *    (la UI los muestra tal cual — regla dura del PLAN); el `code` es el campo
 *    NUEVO estable para asertar en tests/consumidores.
 *  - cualquier otro throw → 500 GENÉRICO. El mensaje interno (pdf-lib,
 *    tokenizer…) va SOLO al logger — nunca más se filtra al usuario
 *    (anti-Commandment 7 de v1).
 */
import type { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from 'express';
import { createLogger, createUserError, ProtocolError } from '@aldus/core';

/** Códigos estables del server (rango 94xx = del host, no del bake). */
export const ServerCodes = {
  BadRequest: 9400,
  NotFound: 9404,
  Conflict: 9409,
  UnknownOp: 9410,
  LinkNotFound: 9411,
  ForensicOff: 9412,
} as const;

const STATUS_BY_CODE: Record<number, number> = {
  [ServerCodes.BadRequest]: 400,
  [ServerCodes.NotFound]: 404,
  [ServerCodes.Conflict]: 409,
  [ServerCodes.UnknownOp]: 400,
  [ServerCodes.LinkNotFound]: 404,
  [ServerCodes.ForensicOff]: 404,
};

// ── factories nombradas (strings v1 byte-idéntico) ──────────────────────────
export const documentNotFound = (): ProtocolError =>
  new ProtocolError(createUserError('No existe.', ServerCodes.NotFound));

export const badRequest = (format: string): ProtocolError =>
  new ProtocolError(createUserError(format, ServerCodes.BadRequest));

export const unknownOp = (action: unknown): ProtocolError =>
  new ProtocolError(createUserError(`Acción desconocida: ${action}`, ServerCodes.UnknownOp));

export const linkNotFound = (): ProtocolError =>
  new ProtocolError(createUserError('Link no encontrado.', ServerCodes.LinkNotFound));

export const nothingToRevert = (): ProtocolError =>
  new ProtocolError(createUserError('No hay revisión para deshacer.', ServerCodes.Conflict));

export const forensicOff = (): ProtocolError =>
  new ProtocolError(createUserError('Modo forense apagado (ALDUS_DEBUG=1 para activarlo).', ServerCodes.ForensicOff));

/** Mensaje del 500 genérico — lo ÚNICO que un throw no estructurado muestra. */
export const GENERIC_ERROR = 'No se pudo procesar la solicitud.';

/** Envuelve un handler async: el rechazo va a next(e) → el catch site. Los
 *  throws SINCRÓNICOS ya los captura Express 4 solo — h() cubre el gap async. */
export const h = (
  fn: (req: Request, res: Response, next: NextFunction) => unknown,
): RequestHandler => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

const log = createLogger('aldus:server:errors');

/** EL catch site. Va montado ÚLTIMO en app.ts. */
export function errorMiddleware(): ErrorRequestHandler {
  return (err, _req, res, _next) => {
    if (res.headersSent) {
      // Respuesta streaming ya en curso (agent NDJSON): la ruta maneja su
      // propio canal de error (evento {type:'error'}); acá solo cortamos.
      res.end();
      return;
    }
    if (err instanceof ProtocolError) {
      const status = STATUS_BY_CODE[err.error.code] ?? 400;
      res.status(status).json({ code: err.error.code, error: err.error.format });
      return;
    }
    log('500 interno:', err instanceof Error ? err.stack ?? err.message : err);
    res.status(500).json({ error: GENERIC_ERROR });
  };
}
